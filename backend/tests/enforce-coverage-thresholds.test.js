const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_THRESHOLDS,
  evaluateCoverage,
  enforceCoverage,
  formatResults
} = require('../scripts/enforce-coverage-thresholds');

describe('coverage threshold enforcement', () => {
  test('passes when all metrics meet the default thresholds', () => {
    const results = evaluateCoverage({
      statements: { pct: 80 },
      branches: { pct: 70 },
      functions: { pct: 75 },
      lines: { pct: 80 }
    });

    expect(results.every((result) => result.passed)).toBe(true);
    expect(DEFAULT_THRESHOLDS).toEqual({
      statements: 80,
      branches: 70,
      functions: 75,
      lines: 80
    });
  });

  test('fails metrics below threshold and formats actionable output', () => {
    const results = evaluateCoverage({
      statements: { pct: 79.99 },
      branches: { pct: 70 },
      functions: { pct: 74.9 },
      lines: { pct: 81 }
    });

    expect(results.filter((result) => !result.passed).map((result) => result.metric)).toEqual([
      'statements',
      'functions'
    ]);
    expect(formatResults(results)).toContain('FAIL statements: 79.99% >= 80%');
  });

  test('reads coverage-summary.json and returns aggregate status', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-threshold-'));
    const summaryPath = path.join(tempDir, 'coverage-summary.json');

    fs.writeFileSync(summaryPath, JSON.stringify({
      total: {
        statements: { pct: 99 },
        branches: { pct: 98 },
        functions: { pct: 97 },
        lines: { pct: 96 }
      }
    }));

    const result = enforceCoverage(summaryPath);

    expect(result.passed).toBe(true);
    expect(result.message).toContain('PASS statements: 99% >= 80%');
  });
});
