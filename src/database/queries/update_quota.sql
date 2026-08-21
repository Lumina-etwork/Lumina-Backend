-- Replace the ad-hoc UPDATE with a pg_advisory_xact_lock-based ordered locking scheme
-- acquire lock on user_id hash before performing the row update, ensuring consistent lock ordering across all sessions
-- Add an advisory lock timeout of 2s to prevent sessions from holding locks during long-running concurrent transactions

CREATE OR REPLACE FUNCTION update_quota(p_user_id UUID, p_increment BIGINT)
RETURNS VOID AS $$
DECLARE
    lock_key BIGINT;
BEGIN
    -- Set lock timeout to 2s
    SET LOCAL lock_timeout = '2s';

    -- Generate a 64-bit integer hash from user_id for the advisory lock
    lock_key := ('x' || substr(md5(p_user_id::text), 1, 16))::bit(64)::bigint;

    -- Acquire transaction-level exclusive advisory lock based on user_id hash
    PERFORM pg_advisory_xact_lock(lock_key);

    -- Perform the row update now that we hold the advisory lock
    UPDATE bandwidth_quotas
    SET used_bytes = used_bytes + p_increment
    WHERE user_id = p_user_id;
END;
$$ LANGUAGE plpgsql;
