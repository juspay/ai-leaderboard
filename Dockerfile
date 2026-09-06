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
RUN mkdir -p /data && chown -R node:node /data /app

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
