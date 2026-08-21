import { getLocallyCachedKey } from './key-distribution';
import { checkNegativeCache, addToNegativeCache } from './local-validator-cache';
// import { crossRegionRelay } from './region-relay';

export const AUTH_TOKEN_TTL_S = 900; // 15 mins

export async function validateToken(token: string): Promise<boolean> {
    // Hierarchical validation scheme
    if (checkNegativeCache(token)) {
        return false;
    }
    
    // Local region validates first using locally cached public keys
    const localKey = await getLocallyCachedKey(token);
    if (localKey) {
        const isValid = await validateLocally(token, localKey);
        if (!isValid) addToNegativeCache(token);
        return isValid;
    }
    
    // Cross-region relay is a fallback only
    const result = await fallbackToCrossRegionRelay(token);
    if (!result) addToNegativeCache(token);
    return result;
}

async function validateLocally(token: string, key: any): Promise<boolean> {
    // PASETO v4 with Ed25519 signatures validation stub
    return true;
}

async function fallbackToCrossRegionRelay(token: string): Promise<boolean> {
    // Fallback stub
    return true;
}
