# syntax=docker/dockerfile:1
# Multi-stage: compile TS + Vite, then a slim runtime image with prod deps only.

FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

COPY web/package.json web/package-lock.json ./web/
RUN npm ci --prefix web

COPY web ./web

RUN npm run build --prefix web \
  && npm run build

# ---

FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
COPY drizzle ./drizzle

EXPOSE 3737

USER node
CMD ["node", "dist/server.js"]
