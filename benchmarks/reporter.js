const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getGitInfo() {
  try {
    return {
      commit_sha: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
      branch: execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(),
    };
  } catch {
    return { commit_sha: 'unknown', branch: 'unknown' };
  }
}

function getEnvMetadata() {
  return {
    node_version: process.version,
    os: process.platform,
    cpu_cores: require('os').cpus().length,
    memory_mb: Math.round(require('os').totalmem() / 1024 / 1024),
    workflow_run_id: process.env.GITHUB_RUN_ID || null,
    workflow_run_number: process.env.GITHUB_RUN_NUMBER || null,
    ci: !!process.env.CI,
  };
}

function buildReport(scenarioResults, thresholds) {
  const gitInfo = getGitInfo();
  const envMeta = getEnvMetadata();
  const overallStatus = 'pass';

  const scenarios = {};
  for (const [scenarioName, result] of Object.entries(scenarioResults)) {
    const scenarioThresholds = thresholds[scenarioName] || {};
    const checks = {};
    let scenarioPass = true;

    for (const [metricKey, thresholds_] of Object.entries(scenarioThresholds)) {
      if (metricKey === 'display_name' || metricKey === 'error_rate_max') continue;
      if (result.metrics && result.metrics[metricKey]) {
        for (const [thresholdKey, thresholdVal] of Object.entries(thresholds_)) {
          const actual = result.metrics[metricKey][thresholdKey];
          const pass = thresholdKey.endsWith('_min')
            ? actual >= thresholdVal
            : actual <= thresholdVal;
          if (!pass) scenarioPass = false;
          checks[`${metricKey}_${thresholdKey}`] = {
            threshold: thresholdVal,
            actual,
            pass,
          };
        }
      }
    }

    scenarios[scenarioName] = {
      status: scenarioPass ? 'pass' : 'fail',
      metrics: result.metrics,
      metadata: result.metadata,
      thresholds: checks,
      baseline_comparison: null,
    };
  }

  return {
    commit_sha: gitInfo.commit_sha,
    branch: gitInfo.branch,
    timestamp: new Date().toISOString(),
    environment: envMeta,
    scenarios,
    overall_status: scenarioResults.length > 0 && Object.values(scenarios).every(s => s.status === 'pass') ? 'pass' : 'fail',
  };
}

function writeReport(report, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const filename = `benchmark-report-${report.commit_sha.slice(0, 12)}-${Date.now()}.json`;
  const filepath = path.join(outputDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(report, null, 2));
  console.log(`Report written to ${filepath}`);
  return filepath;
}

function writeLatestSymlink(report, outputDir, latestName = 'latest.json') {
  const filepath = path.join(outputDir, latestName);
  fs.writeFileSync(filepath, JSON.stringify(report, null, 2));
  return filepath;
}

module.exports = { buildReport, writeReport, writeLatestSymlink, getGitInfo, getEnvMetadata };
