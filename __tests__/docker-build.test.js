/* eslint-env jest, node */
/* eslint-disable no-unused-vars */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const BACKEND_DIR = path.resolve(__dirname, '..', 'backend');
const PROJECT_ROOT = path.resolve(__dirname, '..');

describe('Dockerfile Optimization', () => {
  describe('backend/Dockerfile', () => {
    const dockerfile = path.join(BACKEND_DIR, 'Dockerfile');
    const dockerignore = path.join(BACKEND_DIR, '.dockerignore');

    it('should exist', () => {
      expect(fs.existsSync(dockerfile)).toBe(true);
    });

    it('should use multi-stage build pattern', () => {
      const content = fs.readFileSync(dockerfile, 'utf8');
      const stages = content.match(/^FROM /gm);
      expect(stages.length).toBeGreaterThanOrEqual(2);
      expect(content).toMatch(/^FROM .* AS builder$/m);
    });

    it('should pin base image digest', () => {
      const content = fs.readFileSync(dockerfile, 'utf8');
      const fromLines = content.match(/^FROM .+$/gm);
      fromLines.forEach(line => {
        if (!line.includes('scratch') && !line.includes('builder')) {
          expect(line).toMatch(/@sha256:/);
        }
      });
    });

    it('should upgrade to Node.js 20', () => {
      const content = fs.readFileSync(dockerfile, 'utf8');
      expect(content).toMatch(/node:20/);
      expect(content).not.toMatch(/node:18/);
    });

    it('should use BuildKit cache mount for npm', () => {
      const content = fs.readFileSync(dockerfile, 'utf8');
      expect(content).toMatch(/--mount=type=cache,target=\/root\/\.npm/);
    });

    it('should use --chown for COPY instructions', () => {
      const content = fs.readFileSync(dockerfile, 'utf8');
      const copyLines = content.match(/^COPY .+$/gm);
      copyLines.forEach(line => {
        if (!line.includes('--from=builder')) {
          expect(line).toMatch(/--chown=nodejs:nodejs/);
        }
      });
    });

    it('should combine user setup into single RUN layer', () => {
      const content = fs.readFileSync(dockerfile, 'utf8');
      const runLines = content.match(/^RUN .+$/gm);
      const userSetupRun = runLines.find(r =>
        r.includes('addgroup') && r.includes('adduser')
      );
      expect(userSetupRun).toBeTruthy();
      expect(userSetupRun.split('&&').length).toBeGreaterThanOrEqual(2);
    });

    it('should use npm ci --only=production --prefer-offline --no-audit', () => {
      const content = fs.readFileSync(dockerfile, 'utf8');
      expect(content).toMatch(/npm ci --only=production --prefer-offline --no-audit/);
    });

    it('should remove test artifacts in builder stage', () => {
      const content = fs.readFileSync(dockerfile, 'utf8');
      expect(content).toMatch(/rm -rf.*__tests__.*test.*coverage/);
    });

    it('should use direct node command not npm start', () => {
      const content = fs.readFileSync(dockerfile, 'utf8');
      expect(content).toMatch(/^CMD \["node"/m);
      expect(content).not.toMatch(/npm start/);
    });

    it('should only copy /app from builder (no duplicate layers)', () => {
      const content = fs.readFileSync(dockerfile, 'utf8');
      const fromBuilderLines = content.match(/^COPY --from=builder .+$/gm);
      expect(fromBuilderLines.length).toBe(1);
    });
  });

  describe('backend/.dockerignore', () => {
    it('should exclude test artifacts', () => {
      const content = fs.readFileSync(
        path.join(BACKEND_DIR, '.dockerignore'),
        'utf8'
      );
      const patterns = content.split(/\r?\n/).filter(Boolean);
      expect(patterns).toContain('__tests__');
      expect(patterns).toContain('test');
      expect(patterns).toContain('*.test.js');
      expect(patterns).toContain('coverage');
    });

    it('should exclude dev config files', () => {
      const content = fs.readFileSync(
        path.join(BACKEND_DIR, '.dockerignore'),
        'utf8'
      );
      const patterns = content.split(/\r?\n/).filter(Boolean);
      expect(patterns).toContain('jest.config.js');
      expect(patterns).toContain('playwright.config.js');
      expect(patterns).toContain('tsconfig.json');
    });
  });

  describe('health-monitor/Dockerfile', () => {
    const dockerfile = path.resolve(
      PROJECT_ROOT,
      'legacy_cleanup',
      'database',
      'health-monitor',
      'Dockerfile'
    );

    it('should exist', () => {
      expect(fs.existsSync(dockerfile)).toBe(true);
    });

    it('should use multi-stage build', () => {
      const content = fs.readFileSync(dockerfile, 'utf8');
      const stages = content.match(/^FROM /gm);
      expect(stages.length).toBeGreaterThanOrEqual(2);
      expect(content).toMatch(/^FROM .* AS builder$/m);
    });

    it('should upgrade to Node.js 20', () => {
      const content = fs.readFileSync(dockerfile, 'utf8');
      expect(content).toMatch(/node:20/);
      expect(content).not.toMatch(/node:18/);
    });

    it('should use BuildKit cache mount for npm', () => {
      const content = fs.readFileSync(dockerfile, 'utf8');
      expect(content).toMatch(/--mount=type=cache,target=\/root\/\.npm/);
    });
  });

  describe('docker-compose-scalable.yml', () => {
    it('should reference correct health-monitor path', () => {
      const compose = fs.readFileSync(
        path.join(PROJECT_ROOT, 'docker-compose-scalable.yml'),
        'utf8'
      );
      const match = compose.match(/context:\s*(.+health-monitor)/);
      expect(match).toBeTruthy();
      const contextPath = path.resolve(PROJECT_ROOT, match[1].trim());
      expect(fs.existsSync(contextPath)).toBe(true);
    });
  });

  describe('.env.example', () => {
    it('should include BuildKit environment variables', () => {
      const envExample = fs.readFileSync(
        path.join(PROJECT_ROOT, '.env.example'),
        'utf8'
      );
      expect(envExample).toMatch(/DOCKER_BUILDKIT=1/);
      expect(envExample).toMatch(/COMPOSE_DOCKER_CLI_BUILD=1/);
      expect(envExample).toMatch(/BUILDKIT_PROGRESS=plain/);
    });
  });

  describe('CI Workflow (ci.yml)', () => {
    it('should include docker-build and blue-green-deploy jobs', () => {
      const workflow = fs.readFileSync(
        path.join(PROJECT_ROOT, '.github', 'workflows', 'ci.yml'),
        'utf8'
      );
      expect(workflow).toMatch(/docker-build:/);
      expect(workflow).toMatch(/blue-green-deploy:/);
      expect(workflow).toMatch(/docker\/build-push-action@v5/);
      expect(workflow).toMatch(/docker\/setup-buildx-action@v3/);
      expect(workflow).toMatch(/cache-from: type=gha/);
      expect(workflow).toMatch(/cache-to: type=gha,mode=max/);
    });
  });

  describe('Monitoring files', () => {
    it('docker-build alerting rules exist', () => {
      expect(fs.existsSync(path.join(PROJECT_ROOT, 'monitoring', 'alerts', 'docker-build-alerts.yaml'))).toBe(true);
    });
    it('docker-build Prometheus rules exist', () => {
      expect(fs.existsSync(path.join(PROJECT_ROOT, 'monitoring', 'prometheus', 'docker-build-rules.yaml'))).toBe(true);
    });
    it('docker-build dashboard exists with panels', () => {
      const dash = JSON.parse(fs.readFileSync(
        path.join(PROJECT_ROOT, 'monitoring', 'dashboards', 'docker-build-performance.json'), 'utf8'
      ));
      expect(dash.panels.length).toBeGreaterThanOrEqual(3);
      expect(dash.title).toBe('Docker Build Performance');
    });
  });

  describe('Runbook', () => {
    it('docker-build runbook exists', () => {
      expect(fs.existsSync(path.join(PROJECT_ROOT, 'runbooks', 'docker-build.md'))).toBe(true);
    });
  });

  describe('Layer caching behavior (simulation)', () => {
    const simulateBuildLayers = (dockerfilePath) => {
      const content = fs.readFileSync(dockerfilePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
      const layers = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('FROM')) {
          layers.push({ type: 'from', value: trimmed });
        } else if (trimmed.startsWith('WORKDIR')) {
          layers.push({ type: 'workdir', value: trimmed });
        } else if (trimmed.startsWith('RUN')) {
          layers.push({ type: 'run', value: trimmed });
        } else if (trimmed.startsWith('COPY')) {
          layers.push({ type: 'copy', value: trimmed });
        } else if (trimmed.startsWith('USER')) {
          layers.push({ type: 'user', value: trimmed });
        } else if (trimmed.startsWith('EXPOSE')) {
          layers.push({ type: 'expose', value: trimmed });
        } else if (trimmed.startsWith('HEALTHCHECK')) {
          layers.push({ type: 'healthcheck', value: trimmed });
        } else if (trimmed.startsWith('CMD')) {
          layers.push({ type: 'cmd', value: trimmed });
        }
      }
      return layers;
    };

    it('backend should have fewer than 10 layers in production stage', () => {
      const layers = simulateBuildLayers(
        path.join(BACKEND_DIR, 'Dockerfile')
      );
      const productionStart = layers.findIndex(
        l => l.type === 'from' && !l.value.toLowerCase().includes('builder')
      );
      const prodLayers = layers.slice(productionStart);
      expect(prodLayers.length).toBeLessThan(10);
    });

    it('should order layers by change frequency (stable first)', () => {
      const layers = simulateBuildLayers(
        path.join(BACKEND_DIR, 'Dockerfile')
      );
      const prodLayers = layers.filter(l =>
        l.type === 'from' && !l.value.toLowerCase().includes('builder')
      );
      const layerIndex = layers.findIndex(l =>
        l.type === 'from' && !l.value.toLowerCase().includes('builder')
      );
      const afterProd = layers.slice(layerIndex + 1);

      const copyIndex = afterProd.findIndex(l => l.type === 'copy');
      const runIndexes = afterProd
        .map((l, i) => (l.type === 'run' ? i : -1))
        .filter(i => i >= 0);

      if (copyIndex >= 0) {
        const insertLayerIndex = runIndexes.find(i => i < copyIndex);
        expect(insertLayerIndex).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
