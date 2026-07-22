const fs = require('fs');
const path = require('path');

const REPORT_DIR = path.join(__dirname, 'reports');
const OUTPUT_FILE = path.join(__dirname, 'regression-report.md');

function loadLatestReport() {
  const files = fs.readdirSync(REPORT_DIR)
    .filter(f => f.startsWith('benchmark-report-') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) {
    throw new Error('No benchmark reports found in ' + REPORT_DIR);
  }

  const latestFile = files[0];
  return JSON.parse(fs.readFileSync(path.join(REPORT_DIR, latestFile), 'utf8'));
}

function loadBaselines(branch, scenarios) {
  const baselineFile = path.join(REPORT_DIR, 'baselines.json');
  if (!fs.existsSync(baselineFile)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
}

function detectRegression(current, baseline, degradationPct = 5) {
  const METRICS_TO_TRACK = ['p50', 'p95', 'p99', 'avg', 'rate'];
  const HIGHER_IS_BETTER = new Set(['rate']);

  const results = [];

  for (const [scenario, currScenario] of Object.entries(current.scenarios || {})) {
    const baseScenario = (baseline[scenario] || {});
    const metrics = currScenario.metrics || {};
    const baseMetrics = baseScenario.metrics || baseScenario;

    for (const [metricKey, metricData] of Object.entries(metrics)) {
      if (typeof metricData !== 'object' || metricData === null) continue;
      const baseMetric = baseMetrics[metricKey] || {};

      for (const stat of METRICS_TO_TRACK) {
        const currVal = metricData[stat];
        const baseVal = baseMetric[stat];
        if (currVal === undefined || baseVal === undefined || baseVal === 0) continue;

        const changePct = ((currVal - baseVal) / baseVal) * 100;
        const isHigherBetter = HIGHER_IS_BETTER.has(metricKey);
        const isDegradation = isHigherBetter
          ? changePct < -degradationPct
          : changePct > degradationPct;

        results.push({
          scenario,
          metric: `${metricKey}_${stat}`,
          displayName: `${metricKey} ${stat}`,
          baseline: baseVal,
          current: currVal,
          changePct: Math.round(changePct * 10) / 10,
          degraded: isDegradation,
        });
      }
    }
  }

  return results;
}

function formatRegressionReport(currentReport, results, baselineSource) {
  const degradedResults = results.filter(r => r.degraded);
  const overallPassed = degradedResults.length === 0;

  let md = `## Benchmark Regression Report\n\n`;
  md += `**Commit:** \`${currentReport.commit_sha || 'unknown'}\`  \n`;
  md += `**Branch:** \`${currentReport.branch || 'unknown'}\`  \n`;
  md += `**Timestamp:** ${currentReport.timestamp || 'unknown'}  \n`;
  md += `**Baseline Source:** ${baselineSource}  \n`;
  md += `**Overall:** ${overallPassed ? '✅ PASS' : '❌ FAIL'}\n\n`;

  if (!overallPassed) {
    md += `### Degradation Detected (>${process.env.DEGRADATION_THRESHOLD || 5}%)\n\n`;
  }

  const scenarios = [...new Set(results.map(r => r.scenario))];

  for (const scenario of scenarios) {
    const scenarioResults = results.filter(r => r.scenario === scenario);
    md += `### ${scenario}\n\n`;
    md += `| Metric | Baseline | Current | Change | Status |\n`;
    md += `|--------|----------|---------|--------|--------|\n`;

    for (const r of scenarioResults) {
      const arrow = r.degraded ? '⬆️' : '✓';
      const status = r.degraded ? '❌ FAIL' : '✅ PASS';
      md += `| ${r.displayName} | ${r.baseline} | ${r.current} | ${r.changePct > 0 ? '+' : ''}${r.changePct}% ${arrow} | ${status} |\n`;
    }
    md += '\n';
  }

  return md;
}

async function main() {
  const currentReport = loadLatestReport();
  const degradationThreshold = parseFloat(process.env.DEGRADATION_THRESHOLD || '5');

  let baselines;
  let baselineSource;

  const s3BaselineFile = path.join(REPORT_DIR, 's3-baselines.json');
  const localBaselineFile = path.join(REPORT_DIR, 'baselines.json');

  if (fs.existsSync(s3BaselineFile)) {
    baselines = JSON.parse(fs.readFileSync(s3BaselineFile, 'utf8'));
    baselineSource = 'S3 baselines';
  } else if (fs.existsSync(localBaselineFile)) {
    baselines = JSON.parse(fs.readFileSync(localBaselineFile, 'utf8'));
    baselineSource = 'local baselines';
  } else {
    console.log('No baselines found for comparison. Skipping regression detection.');
    process.exit(0);
  }

  const results = detectRegression(currentReport, baselines, degradationThreshold);
  const degradedResults = results.filter(r => r.degraded);
  const overallPassed = degradedResults.length === 0;

  const md = formatRegressionReport(currentReport, results, baselineSource);
  fs.writeFileSync(OUTPUT_FILE, md);
  console.log(`Regression report written to ${OUTPUT_FILE}`);

  for (const r of degradedResults) {
    console.log(`[REGRESSION] ${r.scenario} ${r.displayName}: ${r.baseline} -> ${r.current} (${r.changePct > 0 ? '+' : ''}${r.changePct}%) [FAIL]`);
  }

  if (!overallPassed) {
    console.log(`\n❌ ${degradedResults.length} metric(s) exceeded ${degradationThreshold}% degradation threshold.`);
    if (process.env.CI) {
      const fs = require('fs');
      const annotation = degradedResults.map(r =>
        `::error title=Benchmark Regression::${r.scenario} ${r.displayName} degraded ${r.changePct > 0 ? '+' : ''}${r.changePct}% (baseline: ${r.baseline}, current: ${r.current})`
      ).join('\n');
      fs.writeFileSync(path.join(__dirname, 'regression-annotations.txt'), annotation);
    }
    process.exit(1);
  }

  console.log('✅ All metrics within degradation threshold.');
}

if (require.main === module) {
  main().catch(err => {
    console.error('Regression detection failed:', err.message);
    process.exit(1);
  });
}

module.exports = { detectRegression, formatRegressionReport, loadLatestReport };
