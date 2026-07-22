const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { buildReport, writeReport, writeLatestSymlink } = require('./reporter');
const thresholds = require('./thresholds.json');

const K6_BIN = process.env.K6_BIN || 'k6';
const SCENARIOS_DIR = path.join(__dirname, 'k6', 'scenarios');
const REPORTS_DIR = path.join(__dirname, 'reports');
const SCENARIO_ORDER = ['normal-load', 'peak-load', 'stress-test'];

function whichK6() {
  try {
    execSync(`${K6_BIN} version`, { stdio: 'pipe', encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

async function runK6Scenario(scenarioFile, envVars = {}) {
  return new Promise((resolve, reject) => {
    const filePath = path.join(SCENARIOS_DIR, scenarioFile);
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`Scenario file not found: ${filePath}`));
    }

    const env = {
      ...process.env,
      ...envVars,
      K6_OUTPUT: 'json', 
    };

    const args = [
      'run',
      '--quiet',
      '--summary-trend-stats', 'p(50),p(95),p(99),avg,min,max',
      filePath,
    ];

    console.log(`\n=== Running: ${scenarioFile} ===`);
    console.log(`Command: ${K6_BIN} ${args.join(' ')}`);

    const child = spawn(K6_BIN, args, {
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    child.on('close', (code) => {
      if (code === 0 || code === 99 || code === 100) {
        let summaryData = null;
        try {
          const lines = stdout.trim().split('\n');
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.scenario) {
                summaryData = parsed;
                break;
              }
            } catch {}
          }
        } catch {}

        if (!summaryData) {
          return reject(new Error(`No valid JSON summary in k6 output for ${scenarioFile}`));
        }

        console.log(`Completed: ${scenarioFile} (exit code: ${code})`);
        resolve(summaryData);
      } else {
        reject(new Error(`k6 exited with code ${code} for ${scenarioFile}:\n${stderr.slice(-500)}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn k6: ${err.message}`));
    });
  });
}

async function collectEnvironmentMetrics(targetUrl) {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.get(`${targetUrl}/api/v1/benchmark/metrics`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({});
        }
      });
    });
    req.on('error', () => resolve({}));
    req.setTimeout(5000, () => { req.destroy(); resolve({}); });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const targetUrl = process.env.TARGET_URL || 'http://localhost:3000';

  if (!whichK6()) {
    console.error('k6 is not installed or not in PATH. Install from https://k6.io/docs/get-started/installation/');
    process.exit(1);
  }

  let scenariosToRun = SCENARIO_ORDER;

  const scenarioFlagIndex = args.indexOf('--scenario');
  if (scenarioFlagIndex !== -1 && args[scenarioFlagIndex + 1]) {
    scenariosToRun = [args[scenarioFlagIndex + 1]];
  }

  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const envVars = {
    TARGET_URL: targetUrl,
    AUTH_TOKEN: process.env.AUTH_TOKEN || '',
    PAYLOAD_SIZE: process.env.PAYLOAD_SIZE || '256',
    VAULT_ADDRESSES: process.env.VAULT_ADDRESSES || '',
    BENCHMARK_API_KEY: process.env.BENCHMARK_API_KEY || '',
  };

  console.log(`Target URL: ${targetUrl}`);
  console.log(`Scenarios: ${scenariosToRun.join(', ')}`);

  const scenarioFileMap = {
    'normal-load': 'normal-load.js',
    'peak-load': 'peak-load.js',
    'stress-test': 'stress-test.js',
  };

  const results = {};

  for (const scenarioName of scenariosToRun) {
    const scenarioFile = scenarioFileMap[scenarioName];
    if (!scenarioFile) {
      console.error(`Unknown scenario: ${scenarioName}. Available: ${Object.keys(scenarioFileMap).join(', ')}`);
      continue;
    }

    try {
      const summary = await runK6Scenario(scenarioFile, envVars);
      results[scenarioName] = summary;
    } catch (err) {
      console.error(`Scenario ${scenarioName} failed:`, err.message);
      results[scenarioName] = {
        scenario: scenarioName,
        error: err.message,
        metrics: {},
        metadata: { failed: true },
      };
    }
  }

  const envMetrics = await collectEnvironmentMetrics(targetUrl);
  console.log('Environment benchmark metrics:', JSON.stringify(envMetrics, null, 2));

  const report = buildReport(results, thresholds);

  if (envMetrics && Object.keys(envMetrics).length > 0) {
    for (const [scenarioName, scenarioReport] of Object.entries(report.scenarios)) {
      scenarioReport.environment_metrics = envMetrics;
    }
  }

  const reportPath = writeReport(report, REPORTS_DIR);
  writeLatestSymlink(report, REPORTS_DIR);
  console.log(`\nFinal report: ${reportPath}`);
  console.log(`Overall status: ${report.overall_status}`);

  if (report.overall_status === 'fail') {
    for (const [scenario, sr] of Object.entries(report.scenarios)) {
      if (sr.status === 'fail') {
        console.log(`  ❌ ${scenario}: threshold check failed`);
        for (const [check, detail] of Object.entries(sr.thresholds || {})) {
          if (!detail.pass) {
            console.log(`      ${check}: expected <=${detail.threshold}, got ${detail.actual}`);
          }
        }
      }
    }
  }

  const exitCode = report.overall_status === 'fail' ? 1 : 0;
  process.exit(exitCode);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Runner failed:', err.message);
    process.exit(1);
  });
}

module.exports = { runK6Scenario, main };
