# Runbook: Capacity Exhaustion Alert

## Triage

1. Open the **Capacity Planning and Usage Trending** dashboard.
2. Identify which metric is firing and the projected exhaustion date:
   - `CapacityDbPoolUsageHigh` / `CapacityDbPoolUsageCritical` — Database connection pool
   - `CapacityQueueBacklog` — BullMQ queue depth growing
   - `CapacityEventLoopHigh` — Event loop lag above threshold
   - `CapacityMemoryGrowth` — Memory growth rate above 10%/hour
   - `CapacityThroughputAnomaly` — Anomalous throughput pattern
   - `CapacityExhaustionProjected` — Projected to hit capacity limit in < 14 days
3. Query the capacity API for trend data:
   ```
   GET /api/capacity/trends/{metric_name}
   GET /api/capacity/projections/{metric_name}?days_ahead=30
   GET /api/capacity/exhaustion/{metric_name}?capacity_limit={limit}
   ```
4. If a blue-green deployment is active, compare the green environment's capacity signals against blue.

## Mitigation

### Database Connection Pool
- Increase `pool.max` in database configuration (helm values or ConfigMap)
- Add read replicas and direct read traffic to replica pool
- Optimize slow queries (check pg_stat_activity)
- Reduce connection TTL to recycle connections faster

### Queue Backlog
- Scale up BullMQ workers (increase `replicaCount` in helm)
- Increase worker concurrency (`concurrency` setting in queue configuration)
- Prioritize critical queue items over batch processing
- Consider temporary auto-scaling: `kubectl scale deployment vesting-vault-worker --replicas=10`

### Event Loop / CPU
- Check for blocking synchronous operations in recent deploys
- Verify async/await usage in hot paths
- Scale horizontally (HPA should handle this automatically)
- Check for unhandled promise rejections causing synchronous fallbacks

### Memory Growth
- Snapshot heap: `kubectl exec -it pod-name -- node -e "console.log(process.memoryUsage())"`
- Generate heap dump: `node --heapsnapshot-signal=SIGUSR2` (if configured)
- Check for growing caches or unbounded array accumulations
- Review recent code changes for memory leaks

### Projected Exhaustion
- Short-term: Scale up resources (increase limits, add replicas)
- Medium-term: Optimize resource usage (connection pooling, caching, query tuning)
- Long-term: Plan infrastructure expansion (additional nodes, database read replicas, Redis cluster)

## Rollback

If triggered during a deployment:
1. Shift traffic back to the previous version: `node blue-green-controller.js rollback`
2. Confirm capacity signals return to baseline on the stable version
3. Investigate the regression before re-deploying

## Resolution

- Clear alert conditions must persist for 2 consecutive fast windows (10 minutes)
- Projected exhaustion alerts clear when projection extends beyond 14 days
- Verify on the Capacity Trending dashboard that trend lines returned to expected ranges
- Document the root cause and mitigation steps in the post-incident review

## Prevention

- Set up capacity alerts at 80% (warning) and 95% (critical) of known limits
- Review trend projections weekly as part of regular capacity planning
- Update capacity limits in `helm/values.yaml` when infrastructure changes
- Run `node scripts/capacity-report.js` before planned deployments to assess headroom
