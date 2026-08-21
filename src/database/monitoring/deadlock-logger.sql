CREATE OR REPLACE VIEW deadlock_monitor_view AS
SELECT 
    pg_stat_activity.pid,
    pg_stat_activity.usename,
    pg_stat_activity.application_name,
    pg_stat_activity.state,
    pg_stat_activity.query,
    pg_stat_activity.query_start,
    pg_stat_activity.wait_event_type,
    pg_stat_activity.wait_event,
    pg_locks.locktype,
    pg_locks.database,
    pg_locks.relation,
    pg_locks.page,
    pg_locks.tuple,
    pg_locks.virtualxid,
    pg_locks.transactionid,
    pg_locks.classid,
    pg_locks.objid,
    pg_locks.objsubid,
    pg_locks.virtualtransaction,
    pg_locks.pid AS lock_pid,
    pg_locks.mode,
    pg_locks.granted,
    pg_locks.fastpath
FROM pg_stat_activity
JOIN pg_locks ON pg_stat_activity.pid = pg_locks.pid
WHERE pg_stat_activity.state != 'idle'
  AND (pg_stat_activity.wait_event = 'transactionid' OR pg_stat_activity.wait_event_type = 'Lock');
