#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const DEFAULT_SUMMARY_PATH = path.join(process.cwd(), 'coverage', 'coverage-summary.json');
const DEFAULT_THRESHOLDS = Object.freeze({
  statements: 80,
  branches: 70,
  functions: 75,
  lines: 80
});

function loadCoverageSummary(summaryPath = DEFAULT_SUMMARY_PATH) {
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Coverage summary not found at ${summaryPath}. Run Jest with --coverage first.`);
  }

  const parsed = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  if (!parsed.total) {
    throw new Error(`Coverage summary at ${summaryPath} does not include a total section.`);
  }

  return parsed.total;
}

function evaluateCoverage(totalCoverage, thresholds = DEFAULT_THRESHOLDS) {
  return Object.entries(thresholds).map(([metric, minimum]) => {
    const actual = totalCoverage[metric]?.pct;
    return {
      metric,
      minimum,
      actual: typeof actual === 'number' ? actual : 0,
      passed: typeof actual === 'number' && actual >= minimum
    };
  });
}

function formatResults(results) {
  return results
    .map(({ metric, actual, minimum, passed }) => {
      const status = passed ? 'PASS' : 'FAIL';
      return `${status} ${metric}: ${actual}% >= ${minimum}%`;
    })
    .join('\n');
}

function enforceCoverage(summaryPath = DEFAULT_SUMMARY_PATH, thresholds = DEFAULT_THRESHOLDS) {
  const totalCoverage = loadCoverageSummary(summaryPath);
  const results = evaluateCoverage(totalCoverage, thresholds);
  const failures = results.filter((result) => !result.passed);

  return {
    passed: failures.length === 0,
    results,
    message: formatResults(results)
  };
}

if (require.main === module) {
  try {
    const summaryPath = process.argv[2] || DEFAULT_SUMMARY_PATH;
    const result = enforceCoverage(summaryPath);
    console.log(result.message);

    if (!result.passed) {
      console.error('Coverage thresholds were not met.');
      process.exit(1);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_THRESHOLDS,
  evaluateCoverage,
  enforceCoverage,
  formatResults,
  loadCoverageSummary
};
