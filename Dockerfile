# syntax=docker/dockerfile:1

FROM oven/bun:1.4.4-slim AS bun-bin

# Stage 1: Install full dependencies via bun.lock and build the Vite frontend into dist/
FROM node:22-slim AS builder

WORKDIR /app

COPY --from=bun-bin /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock ./

RUN bun install --frozen-lockfile

COPY . .

RUN npm run build

# Stage 2: Install strictly production dependencies via bun.lock
FROM node:22-slim AS prod-deps

WORKDIR /app

COPY --from=bun-bin /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock ./

RUN bun install --frozen-lockfile --production

# Stage 3: Minimal Node.js 22 slim runtime image (non-root)
FROM node:22-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

RUN mkdir -p /app /tmp/veyric-ai-uploads && \
  chown -R node:node /app /tmp/veyric-ai-uploads && \
  chmod 1777 /tmp

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node server.ts ./
COPY --chown=node:node server ./server

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health', { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server.ts"]
