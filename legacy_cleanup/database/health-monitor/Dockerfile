FROM node:20-alpine@sha256:25c0b18f5185b0335612a58559ff6117aaf7918ec6e1fee5306ad47b7c306188 AS builder

WORKDIR /app

RUN apk add --no-cache postgresql-client

COPY package*.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm install --production --prefer-offline --no-audit

COPY . .

RUN mkdir -p /app/logs

FROM node:20-alpine@sha256:25c0b18f5185b0335612a58559ff6117aaf7918ec6e1fee5306ad47b7c306188

WORKDIR /app

COPY --from=builder /app /app

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => { process.exit(r.statusCode===200?0:1) })"

CMD ["node", "monitor.js"]
