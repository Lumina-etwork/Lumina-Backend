export const AUTH_CACHE_TTL_S = 60; // 60s
const MAX_ENTRIES = 100000;

class BloomFilter {
    private cache: Set<string> = new Set();
    
    add(token: string) {
        if (this.cache.size < MAX_ENTRIES) {
            this.cache.add(token);
        }
    }
    
    has(token: string): boolean {
        return this.cache.has(token);
    }
}

// Bloom-filter-based negative cache to short-circuit repeated invalid token checks
const negativeCache = new BloomFilter();

export function checkNegativeCache(token: string): boolean {
    return negativeCache.has(token);
}

export function addToNegativeCache(token: string): void {
    negativeCache.add(token);
}
