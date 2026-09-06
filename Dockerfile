# node:20-slim (glibc) rather than alpine (musl): better-sqlite3 publishes
# prebuilt binaries for glibc, so `npm ci` doesn't need a C++ toolchain.
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src/ src/
COPY public/ public/

# SQLite lives on a mounted volume; see k8s/app/pvc.yaml.
ENV CLAUDE_DB_PATH=/data/leaderboard.db
# uid 1001 rather than the image's built-in `node` (1000): InfraSwitch's
# deployment template runs containers as 1001 with fsGroup 1001, and the
# process must own /app to match.
RUN mkdir -p /data && chown -R 1001:1001 /data /app

USER 1001

EXPOSE 8420

CMD ["node", "src/server.js"]
