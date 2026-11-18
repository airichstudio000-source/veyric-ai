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

# Stage 3: Minimal Node.js 22 slim runtime image
FROM node:22-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY server.ts ./
COPY server ./server

EXPOSE 8080

CMD ["npm", "run", "start"]
