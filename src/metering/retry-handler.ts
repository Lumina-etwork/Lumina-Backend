export async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
    const maxRetries = 5;
    let baseDelay = 10; // ms

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error: any) {
            // Check for PostgreSQL deadlock error code (40A0P01 or 40P01)
            if (error.code === '40P01' || error.message?.includes('deadlock') || error.code === '40A0P01' || error.message?.includes('40A0P01')) {
                if (attempt === maxRetries) {
                    throw error;
                }
                const jitter = Math.random() * baseDelay * 0.2; // 20% jitter
                const delay = baseDelay + jitter;
                await new Promise(resolve => setTimeout(resolve, delay));
                baseDelay *= 2; // Exponential backoff
            } else {
                throw error;
            }
        }
    }
    throw new Error('Unreachable');
}
