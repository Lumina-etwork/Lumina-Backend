const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');

const BUCKET = process.env.BENCHMARK_BUCKET || 'lumina-benchmarks';
const S3_PREFIX = 'benchmarks';

let s3 = null;
function getS3() {
  if (!s3) {
    AWS.config.update({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION || 'us-east-1',
    });
    s3 = new AWS.S3();
  }
  return s3;
}

function getKeyPath(branch, scenario) {
  return `${S3_PREFIX}/${branch}/${scenario}.json`;
}

function getHistoryKeyPath(commitSha, scenario) {
  return `${S3_PREFIX}/history/${commitSha}/${scenario}.json`;
}

async function fetchBaseline(branch, scenario) {
  const key = getKeyPath(branch, scenario);
  try {
    const data = await getS3().getObject({ Bucket: BUCKET, Key: key }).promise();
    return JSON.parse(data.Body.toString('utf8'));
  } catch (err) {
    if (err.code === 'NoSuchKey') {
      console.log(`No baseline found for ${key}`);
      return null;
    }
    throw err;
  }
}

async function storeBaseline(branch, scenario, report) {
  const key = getKeyPath(branch, scenario);
  await getS3().putObject({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(report, null, 2),
    ContentType: 'application/json',
    Metadata: {
      'scenario': scenario,
      'branch': branch,
      'timestamp': new Date().toISOString(),
    },
  }).promise();
  console.log(`Baseline stored: ${key}`);
  return key;
}

async function storeHistoricalArtifact(commitSha, scenario, report) {
  const key = getHistoryKeyPath(commitSha, scenario);
  await getS3().putObject({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(report, null, 2),
    ContentType: 'application/json',
    Metadata: {
      'scenario': scenario,
      'commit_sha': commitSha,
      'timestamp': new Date().toISOString(),
    },
  }).promise();
  console.log(`Historical artifact stored: ${key}`);
  return key;
}

async function fetchAllBaselines(branch, scenarios) {
  const results = {};
  for (const scenario of scenarios) {
    results[scenario] = await fetchBaseline(branch, scenario);
  }
  return results;
}

async function fetchHistoryForScenario(branch, scenario, limit = 30) {
  const prefix = `${S3_PREFIX}/history/`;
  try {
    const data = await getS3().listObjectsV2({
      Bucket: BUCKET,
      Prefix: prefix,
      MaxKeys: 1000,
    }).promise();
    const historyItems = [];
    for (const item of data.Contents || []) {
      if (item.Key.endsWith(`/${scenario}.json`)) {
        const obj = await getS3().getObject({ Bucket: BUCKET, Key: item.Key }).promise();
        historyItems.push(JSON.parse(obj.Body.toString('utf8')));
      }
    }
    historyItems.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return historyItems.slice(0, limit);
  } catch (err) {
    console.error('Error fetching history:', err.message);
    return [];
  }
}

async function storeBaselinesForAllScenarios(branch, report) {
  if (!report || !report.scenarios) return [];
  const keys = [];
  for (const [scenario, scenarioReport] of Object.entries(report.scenarios)) {
    const k = await storeBaseline(branch, scenario, scenarioReport.metrics);
    keys.push(k);
    if (report.commit_sha && report.commit_sha !== 'unknown') {
      await storeHistoricalArtifact(report.commit_sha, scenario, scenarioReport.metrics);
    }
  }
  return keys;
}

module.exports = {
  fetchBaseline,
  storeBaseline,
  storeHistoricalArtifact,
  fetchAllBaselines,
  fetchHistoryForScenario,
  storeBaselinesForAllScenarios,
};
