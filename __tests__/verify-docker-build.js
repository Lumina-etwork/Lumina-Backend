const path = require('path');
const fs = require('fs');
let failures = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS:', name); }
  catch (e) { console.error('  FAIL:', name, '-', e.message); failures++; }
}

const ROOT = path.resolve(__dirname, '..');

console.log('=== Dockerfile Optimization Tests ===\n');

// 1. backend/Dockerfile
const bf = path.join(ROOT, 'backend', 'Dockerfile');
const bfContent = fs.readFileSync(bf, 'utf8');
const diContent = fs.readFileSync(path.join(ROOT, 'backend', '.dockerignore'), 'utf8');

test('backend/Dockerfile exists', () => { fs.statSync(bf); });
test('multi-stage build (FROM ... AS builder)', () => {
  if (!bfContent.match(/^FROM .* AS builder$/m)) throw new Error('missing builder stage');
  const stages = bfContent.match(/^FROM /gm);
  if (stages.length < 2) throw new Error('need >=2 stages, got ' + stages.length);
});
test('base image pinned to sha256', () => {
  const fromLines = bfContent.match(/^FROM .+$/gm);
  fromLines.forEach((l, i) => {
    if (!l.includes('scratch') && !l.includes('builder')) {
      if (!l.includes('@sha256:')) throw new Error('line ' + (i+1) + ' not pinned: ' + l);
    }
  });
});
test('node:20 (not 18)', () => {
  if (!bfContent.includes('node:20')) throw new Error('not node:20');
  if (bfContent.includes('node:18')) throw new Error('still references node:18');
});
test('BuildKit cache mount for npm', () => {
  if (!bfContent.includes('--mount=type=cache,target=/root/.npm')) throw new Error('missing cache mount');
});
test('COPY --chown usage', () => {
  const copyLines = bfContent.match(/^COPY .+$/gm);
  copyLines.forEach((l, i) => {
    if (!l.includes('--from=builder')) {
      if (!l.includes('--chown=')) throw new Error('line ' + (i+1) + ' missing --chown: ' + l);
    }
  });
});
test('combined user setup (single RUN)', () => {
  const runLines = bfContent.match(/^RUN .+$/gm);
  const found = runLines.filter(r => r.includes('addgroup') && r.includes('adduser'));
  if (found.length === 0) throw new Error('no combined user RUN found');
  if (!found[0].includes('&&')) throw new Error('addgroup/adduser not combined with &&');
});
test('npm ci with --only=production --prefer-offline --no-audit', () => {
  if (!bfContent.includes('npm ci --only=production --prefer-offline --no-audit')) throw new Error('missing flags');
});
test('removes test artifacts in builder', () => {
  if (!bfContent.includes('rm -rf')) throw new Error('no cleanup RUN');
  if (!bfContent.includes('__tests__')) throw new Error('missing __tests__ in cleanup');
});
test('CMD uses node directly (not npm start)', () => {
  if (!bfContent.includes('"node"')) throw new Error('CMD not using node');
  if (bfContent.includes('npm start')) throw new Error('still uses npm start');
});
test('single COPY --from=builder in production stage', () => {
  const fromBuilder = bfContent.match(/^COPY --from=builder .+$/gm);
  if (fromBuilder.length !== 1) throw new Error('expected 1 COPY --from=builder, got ' + fromBuilder.length);
});

// 2. backend/.dockerignore
test('.dockerignore excludes test artifacts', () => {
  ['__tests__', 'test', '*.test.js', 'coverage'].forEach(p => {
    if (!diContent.includes(p)) throw new Error('missing pattern: ' + p);
  });
});
test('.dockerignore excludes dev config', () => {
  ['jest.config.js', 'playwright.config.js', 'tsconfig.json'].forEach(p => {
    if (!diContent.includes(p)) throw new Error('missing pattern: ' + p);
  });
});

// 3. health-monitor/Dockerfile
const hmf = path.join(ROOT, 'legacy_cleanup', 'database', 'health-monitor', 'Dockerfile');
const hmfContent = fs.readFileSync(hmf, 'utf8');

test('health-monitor/Dockerfile exists', () => { fs.statSync(hmf); });
test('health-monitor multi-stage build', () => {
  if (!hmfContent.match(/^FROM .* AS builder$/m)) throw new Error('missing builder stage');
  const stages = hmfContent.match(/^FROM /gm);
  if (stages.length < 2) throw new Error('need >=2 stages, got ' + stages.length);
});
test('health-monitor node:20 (not 18)', () => {
  if (!hmfContent.includes('node:20')) throw new Error('not node:20');
  if (hmfContent.includes('node:18')) throw new Error('still references node:18');
});
test('health-monitor BuildKit cache mount', () => {
  if (!hmfContent.includes('--mount=type=cache,target=/root/.npm')) throw new Error('missing cache mount');
});

// 4. docker-compose-scalable path fix
const dcs = fs.readFileSync(path.join(ROOT, 'docker-compose-scalable.yml'), 'utf8');
test('docker-compose-scalable.yml references correct health-monitor path', () => {
  const match = dcs.match(/context:\s*(.+health-monitor)/);
  if (!match) throw new Error('no health-monitor context found');
  const contextPath = path.resolve(ROOT, match[1].trim());
  if (!fs.existsSync(contextPath)) throw new Error('context path does not exist: ' + contextPath);
});

// 5. .env.example
const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
test('.env.example has BuildKit vars', () => {
  ['DOCKER_BUILDKIT=1', 'COMPOSE_DOCKER_CLI_BUILD=1', 'BUILDKIT_PROGRESS=plain'].forEach(v => {
    if (!env.includes(v)) throw new Error('missing: ' + v);
  });
});

// 6. CI workflow
const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
test('ci.yml has docker-build job', () => {
  if (!ci.includes('docker-build:')) throw new Error('missing docker-build job');
});
test('ci.yml has blue-green-deploy job', () => {
  if (!ci.includes('blue-green-deploy:')) throw new Error('missing blue-green-deploy');
});
test('ci.yml uses docker/build-push-action@v5', () => {
  if (!ci.includes('docker/build-push-action@v5')) throw new Error('not using v5');
});
test('ci.yml uses docker/setup-buildx-action@v3', () => {
  if (!ci.includes('docker/setup-buildx-action@v3')) throw new Error('not using buildx');
});
test('ci.yml uses type=gha cache', () => {
  if (!ci.includes('cache-from: type=gha')) throw new Error('missing cache-from');
  if (!ci.includes('cache-to: type=gha,mode=max')) throw new Error('missing cache-to');
});
test('ci.yml registers Docker env vars', () => {
  ['DOCKER_REGISTRY:', 'DOCKER_IMAGE_BACKEND:', 'DOCKER_IMAGE_HEALTH_MONITOR:'].forEach(v => {
    if (!ci.includes(v)) throw new Error('missing env: ' + v);
  });
});

// 7. Monitoring files
test('docker-build alerting rules exist', () => {
  fs.statSync(path.join(ROOT, 'monitoring', 'alerts', 'docker-build-alerts.yaml'));
});
test('docker-build Prometheus rules exist', () => {
  fs.statSync(path.join(ROOT, 'monitoring', 'prometheus', 'docker-build-rules.yaml'));
});
test('docker-build dashboard exists with panels', () => {
  const dash = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'monitoring', 'dashboards', 'docker-build-performance.json'), 'utf8'
  ));
  if (!dash.panels || dash.panels.length < 3) throw new Error('dashboard has <3 panels');
  if (dash.title !== 'Docker Build Performance') throw new Error('wrong title');
});

// 8. Runbook
test('docker-build runbook exists', () => {
  fs.statSync(path.join(ROOT, 'runbooks', 'docker-build.md'));
});

// Summary
console.log('\n=== Results ===');
console.log(failures + ' failure(s)');
process.exit(failures > 0 ? 1 : 0);
