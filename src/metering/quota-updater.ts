import { query } from '../utils/db'; // Replace with your actual database client import if different

export class QuotaUpdater {
    private batch: Map<string, number> = new Map();
    private timer: NodeJS.Timeout | null = null;
    private maxBatchSize = 100;

    public async queueUpdate(userId: string, incrementBytes: number): Promise<void> {
        const current = this.batch.get(userId) || 0;
        this.batch.set(userId, current + incrementBytes);

        if (this.batch.size >= this.maxBatchSize) {
            await this.flush();
        } else if (!this.timer) {
            this.timer = setTimeout(() => this.flush(), 5);
        }
    }

    private async flush(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        if (this.batch.size === 0) return;

        const currentBatch = this.batch;
        this.batch = new Map();

        const userIds: string[] = [];
        const cases: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;

        for (const [userId, increment] of currentBatch.entries()) {
            userIds.push(userId);
            cases.push(`WHEN $${paramIndex} THEN $${paramIndex + 1}::bigint`);
            params.push(userId, increment);
            paramIndex += 2;
        }

        // We use a single batch UPDATE with CASE statements
        const queryText = `
            UPDATE bandwidth_quotas
            SET used_bytes = used_bytes + CASE user_id
                ${cases.join(' ')}
                ELSE 0
            END
            WHERE user_id = ANY($${paramIndex}::uuid[])
        `;
        params.push(userIds);

        await query(queryText, params);
    }
}
