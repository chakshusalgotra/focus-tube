# syntax=docker/dockerfile:1.7

FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS dependencies

WORKDIR /app

# Native build tools are only present in the dependency stage. better-sqlite3
# is compiled against the same musl runtime used by the final image.
RUN apk add --no-cache nodejs npm nodejs-dev python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && rm -rf node_modules/better-sqlite3/prebuilds \
    && cd node_modules/better-sqlite3 \
    && node-gyp rebuild --release --force_build=1 \
    && cd /app \
    && test -f node_modules/better-sqlite3/build/Release/better_sqlite3.node \
    && find node_modules/better-sqlite3/build -mindepth 1 -maxdepth 1 ! -name Release -exec rm -rf {} + \
    && find node_modules/better-sqlite3/build/Release -mindepth 1 ! -name better_sqlite3.node -exec rm -rf {} + \
    && rm -rf node_modules/better-sqlite3/deps node_modules/better-sqlite3/src \
    && npm cache clean --force

FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS runtime

ARG YT_DLP_VERSION=2026.7.4

LABEL org.opencontainers.image.title="FocusTube" \
    org.opencontainers.image.description="Distraction-free YouTube course player" \
    org.opencontainers.image.source="https://github.com/chakshusalgotra/focus-tube"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache

# yt-dlp is installed in an isolated Python environment and pinned for
# reproducible builds. ffmpeg enables format merging and audio extraction.
RUN apk add --no-cache ca-certificates ffmpeg libstdc++ nodejs python3 py3-pip \
    && addgroup -S -g 1000 node \
    && adduser -S -D -H -u 1000 -G node node \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp==${YT_DLP_VERSION}" \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node auth.js db.js downloads.js server.js ./
COPY --chown=node:node public ./public

RUN mkdir -p /app/data \
    && chown -R node:node /app/data

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "server.js"]