#!/usr/bin/env node

const HistoricalUsageStore = require('../backend/src/services/historicalUsageStore');
const CapacityProjectionService = require('../backend/src/services/capacityProjectionService');

async function generateReport() {
  const store = new HistoricalUsageStore();
  const projectionService = new CapacityProjectionService({ store });

  console.log('=== Capacity Planning Report ===\n');
  console.log(`Generated: ${new Date().toISOString()}\n`);

  const metrics = await store.listMetrics();
  if (metrics.length === 0) {
    console.log('No metrics data available. Ensure the capacity collector is running.');
    process.exit(0);
  }

  for (const m of metrics) {
    console.log(`--- ${m.metric_name} ---`);
    console.log(`  Samples: ${m.sample_count}  |  First: ${m.first_seen}  |  Last: ${m.last_seen}`);

    const current = await store.getLatestValue(m.metric_name);
    if (current != null) console.log(`  Current value: ${current}`);

    const trends = await projectionService.getTrendSummary(m.metric_name);
    for (const t of trends) {
      console.log(`  [${t.window}] growth_rate=${t.growth_rate ?? 'N/A'}  slope=${t.slope ?? 'N/A'}  r2=${t.r2 ?? 'N/A'}  anomalies=${t.anomaly_count}  proj_7d=${t.projected_7d ?? 'N/A'}  proj_30d=${t.projected_30d ?? 'N/A'}`);
    }
    console.log();
  }

  const stats = await store.getRetentionStats();
  console.log('=== Retention Stats ===');
  console.log(`  Total records: ${stats.count}`);
  console.log(`  Oldest: ${stats.oldest}`);
  console.log(`  Newest: ${stats.newest}`);
}

generateReport().catch((err) => {
  console.error('Report generation failed:', err);
  process.exit(1);
});
