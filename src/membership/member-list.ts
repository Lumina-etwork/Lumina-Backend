export enum MemberStatus {
  Alive = 'Alive',
  Suspect = 'Suspect',
  Dead = 'Dead',
}

export interface Member {
  id: string;
  address: string;
  status: MemberStatus;
  incarnation: number;
  lastUpdated: number;
}

export class MemberList {
  private members: Map<string, Member> = new Map();

  addOrUpdateMember(member: Member): void {
    const existing = this.members.get(member.id);
    if (!existing) {
      this.members.set(member.id, member);
      return;
    }

    if (member.incarnation > existing.incarnation) {
      this.members.set(member.id, member);
    } else if (member.incarnation === existing.incarnation) {
      // Suspect overrides Alive, Dead overrides Suspect or Alive
      if (
        (existing.status === MemberStatus.Alive && member.status === MemberStatus.Suspect) ||
        (existing.status !== MemberStatus.Dead && member.status === MemberStatus.Dead)
      ) {
        this.members.set(member.id, member);
      }
    }
  }

  getMember(id: string): Member | undefined {
    return this.members.get(id);
  }

  getAllMembers(): Member[] {
    return Array.from(this.members.values());
  }

  getRandomPeers(count: number, excludeId?: string): Member[] {
    const pool = this.getAllMembers().filter(m => m.id !== excludeId && m.status !== MemberStatus.Dead);
    const shuffled = [...pool].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
  }

  entropyTracker(): number {
    const members = this.getAllMembers();
    if (members.length === 0) return 0;
    const prefixCounts = new Map<string, number>();
    for (const m of members) {
      const prefix = m.id.length >= 4 ? m.id.slice(0, 4) : m.id;
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }
    let entropy = 0;
    const total = members.length;
    for (const count of prefixCounts.values()) {
      const p = count / total;
      entropy -= p * Math.log2(p);
    }
    return entropy;
  }
}
