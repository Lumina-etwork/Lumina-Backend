const fs = require("fs");
const path = require("path");
const os = require("os");

const METRICS_DIR = process.env.HOOK_METRICS_DIR || path.join(os.tmpdir(), "lumina-hook-metrics");
const PUSHGATEWAY_URL = process.env.PROMETHEUS_PUSHGATEWAY;

if (!fs.existsSync(METRICS_DIR)) {
  fs.mkdirSync(METRICS_DIR, { recursive: true });
}

function formatTimestamp() {
  return new Date().toISOString();
}

function getHostname() {
  return os.hostname();
}

function pushToPushgateway(metrics) {
  if (!PUSHGATEWAY_URL) return;
  const http = PUSHGATEWAY_URL.startsWith("https") ? require("https") : require("http");
  const body = Object.entries(metrics)
    .map(([name, value]) => `# HELP ${name} ${name}\n# TYPE ${name} gauge\n${name}{hook="${metrics.hook}",result="${metrics.result}",host="${getHostname()}"} ${value}`)
    .join("\n");
  const req = http.request(`${PUSHGATEWAY_URL}/metrics/job/lumina-pre-commit-hooks`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
  });
  req.write(body);
  req.end();
}

function writeMetricsFile(metrics) {
  const filePath = path.join(METRICS_DIR, `hook-${metrics.hook}-${Date.now()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(metrics, null, 2) + "\n");
  const files = fs.readdirSync(METRICS_DIR).filter((f) => f.startsWith("hook-"));
  if (files.length > 100) {
    const oldest = files.sort()[0];
    fs.unlinkSync(path.join(METRICS_DIR, oldest));
  }
}

function track(hookName, fn) {
  const start = process.hrtime.bigint();
  let result = "pass";
  let error = null;
  try {
    fn();
  } catch (e) {
    result = "fail";
    error = e.message;
  }
  const durationNs = Number(process.hrtime.bigint() - start);
  const durationMs = durationNs / 1e6;

  const metrics = {
    hook: hookName,
    result,
    duration_ms: Math.round(durationMs * 100) / 100,
    timestamp: formatTimestamp(),
    host: getHostname(),
    error: error || "",
  };

  writeMetricsFile(metrics);
  pushToPushgateway(metrics);

  if (result === "fail") {
    throw new Error(error || `Hook ${hookName} failed`);
  }
}

if (require.main === module) {
  const [hookName, ...cmdParts] = process.argv.slice(2);
  if (!hookName || cmdParts.length === 0) {
    console.error("Usage: node track-hook-metrics.js <hook-name> <command...>");
    process.exit(1);
  }
  const cmd = cmdParts.join(" ");
  const start = process.hrtime.bigint();
  const { execSync } = require("child_process");
  let result = "pass";
  let error = "";
  let exitCode = 0;
  try {
    execSync(cmd, { stdio: "inherit", shell: true });
  } catch (e) {
    result = "fail";
    error = e.message;
    exitCode = e.status || 1;
  }
  const durationNs = Number(process.hrtime.bigint() - start);
  const durationMs = durationNs / 1e6;
  const metrics = {
    hook: hookName,
    result,
    duration_ms: Math.round(durationMs * 100) / 100,
    timestamp: formatTimestamp(),
    host: getHostname(),
    error,
  };
  writeMetricsFile(metrics);
  pushToPushgateway(metrics);
  process.exit(exitCode);
}

module.exports = { track, METRICS_DIR };
