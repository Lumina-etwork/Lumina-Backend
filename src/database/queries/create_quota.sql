INSERT INTO bandwidth_quotas (user_id, tier_id, used_bytes, limit_bytes)
VALUES ($1, $2, 0, $3)
ON CONFLICT (user_id) DO NOTHING;
