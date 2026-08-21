CREATE TABLE IF NOT EXISTS bandwidth_quotas (
    user_id UUID PRIMARY KEY,
    tier_id INT NOT NULL,
    used_bytes BIGINT NOT NULL DEFAULT 0,
    limit_bytes BIGINT NOT NULL
);
