import { MemberList, Member, MemberStatus } from './member-list';

export class BloomFilter256 {
  private bits: Uint8Array = new Uint8Array(32); // 256 bits

  static hash(str: string, seed: number): number {
    let h = seed;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(31, h) + str.charCodeAt(i) | 0;
    }
    return Math.abs(h) % 256;
  }

  add(id: string): void {
    const h1 = BloomFilter256.hash(id, 1);
    const h2 = BloomFilter256.hash(id, 2);
    const h3 = BloomFilter256.hash(id, 3);
    
    this.bits[Math.floor(h1 / 8)] |= (1 << (h1 % 8));
    this.bits[Math.floor(h2 / 8)] |= (1 << (h2 % 8));
    this.bits[Math.floor(h3 / 8)] |= (1 << (h3 % 8));
  }

  has(id: string): boolean {
    const h1 = BloomFilter256.hash(id, 1);
    const h2 = BloomFilter256.hash(id, 2);
    const h3 = BloomFilter256.hash(id, 3);

    const b1 = (this.bits[Math.floor(h1 / 8)] & (1 << (h1 % 8))) !== 0;
    const b2 = (this.bits[Math.floor(h2 / 8)] & (1 << (h2 % 8))) !== 0;
    const b3 = (this.bits[Math.floor(h3 / 8)] & (1 << (h3 % 8))) !== 0;

    return b1 && b2 && b3;
  }

  getBuffer(): Uint8Array {
    return this.bits;
  }

  static fromBuffer(buf: Uint8Array): BloomFilter256 {
    const filter = new BloomFilter256();
    filter.bits.set(buf);
    return filter;
  }
}

export class GossipProtocol {
  private memberList: MemberList;
  private nodeId: string;
  public sentMessages: { address: string; msg: any }[] = [];
  private roundOffset: number;

  constructor(nodeId: string, memberList: MemberList) {
    this.nodeId = nodeId;
    this.memberList = memberList;
    this.roundOffset = this.computeRoundOffset(nodeId);
  }

  private computeRoundOffset(nodeId: string): number {
    let hash = 0;
    for (let i = 0; i < nodeId.length; i++) {
      hash = ((hash << 5) - hash) + nodeId.charCodeAt(i);
      hash |= 0;
    }
    return (Math.abs(hash) % 5) * 20;
  }

  disseminateUpdate(member: Member): void {
    const peers = this.memberList.getRandomPeers(3, this.nodeId);
    for (const peer of peers) {
      this.sendToPeer(peer.address, {
        type: 'GossipUpdate',
        member,
      });
    }
  }

  /**
   * Propagates a local node-connection state change (connect/disconnect)
   * across the cluster. Ensures monotonic ordering via incarnation bumps:
   * a `connect` event always carries a higher incarnation than the
   * preceding `disconnect` so that out-of-order delivery cannot cause
   * split-brain.
   */
  propagateStateChange(
    status: MemberStatus.Alive | MemberStatus.Dead,
    nodeId: string,
    address: string,
    currentIncarnation: number,
  ): void {
    const nextIncarnation =
      status === MemberStatus.Alive ? currentIncarnation + 1 : currentIncarnation;

    const member: Member = {
      id: nodeId,
      address,
      status,
      incarnation: nextIncarnation,
      lastUpdated: Date.now(),
    };

    // Apply locally first so local state is always correct
    // regardless of how other nodes process the events.
    this.memberList.addOrUpdateMember(member);
    this.disseminateUpdate(member);
  }

  sendDigestSync(peerAddress: string): void {
    const filter = new BloomFilter256();
    for (const m of this.memberList.getAllMembers()) {
      filter.add(m.id);
    }
    this.sendToPeer(peerAddress, {
      type: 'DigestSync',
      senderAddress: this.nodeId,
      filter: Array.from(filter.getBuffer()),
    });
  }

  handleMessage(senderAddress: string, msg: any): void {
    switch (msg.type) {
      case 'GossipUpdate':
        this.memberList.addOrUpdateMember(msg.member);
        break;
      case 'DigestSync': {
        const filter = BloomFilter256.fromBuffer(new Uint8Array(msg.filter));
        const missingFromSender: Member[] = [];
        for (const m of this.memberList.getAllMembers()) {
          if (!filter.has(m.id)) {
            missingFromSender.push(m);
          }
        }
        if (missingFromSender.length > 0) {
          this.sendToPeer(senderAddress, {
            type: 'DiffResponse',
            members: missingFromSender,
          });
        }
        break;
      }
      case 'DiffResponse':
        for (const m of msg.members) {
          this.memberList.addOrUpdateMember(m);
        }
        break;
    }
  }

  private sendToPeer(address: string, msg: any): void {
    this.sentMessages.push({ address, msg });
  }
}
