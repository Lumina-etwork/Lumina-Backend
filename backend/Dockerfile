FROM node:20-alpine@sha256:25c0b18f5185b0335612a58559ff6117aaf7918ec6e1fee5306ad47b7c306188 AS builder

WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY --chown=nodejs:nodejs package*.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --only=production --prefer-offline --no-audit

COPY --chown=nodejs:nodejs . .

RUN rm -rf __tests__ test tests coverage .git

FROM node:20-alpine@sha256:25c0b18f5185b0335612a58559ff6117aaf7918ec6e1fee5306ad47b7c306188

WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY --from=builder --chown=nodejs:nodejs /app /app

USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode===200?0:1) })"

CMD ["node", "src/index.js"]
