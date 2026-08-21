import { regionTopology } from '../discovery/region-topology';

const localKeys: Map<string, any> = new Map();

// Gossip-based key distribution for Ed25519 public keys
// Replaces the centralized relay. Each region syncs keys via a peer-to-peer mesh.
export function syncKeysViaGossip(regionId: string, keys: any[]) {
    // Fan-out: 3
    const peers = regionTopology[regionId]?.peers?.slice(0, 3) || [];
    
    // Stub for distributing keys to peers
    for (const peer of peers) {
        // gossip(peer, keys)
    }
}

export async function getLocallyCachedKey(token: string): Promise<any> {
    // Return key for token if available locally
    return localKeys.get(token);
}
