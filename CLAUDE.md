# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Usage Leaderboard — a gamified dashboard tracking Claude AI usage across teams.
Self-hosted as a single Node container on Kubernetes, backed by SQLite on a mounted PVC.

## Architecture

- **One container, no build step.** `src/server.js` (Express) serves the static frontend from
  `public/` *and* forwards every `/api/*` request into `src/worker.js` — the same fetch handler
  that runs on Cloudflare Workers. The Worker code is the single source of truth for the API;
  the Express layer only adds auth endpoints and the storage adapter.
- **Storage**: SQLite via `src/sqlite-kv.js`, a KV-shaped adapter over `kv_store(key, value)`.
  It implements the Cloudflare KV interface (`get`/`put`/`delete`), so the Worker code is
  storage-agnostic. Every method is **synchronous** — that is deliberate, see below.
- **Auth**: Pomerium SSO in front (identity arrives as `X-Pomerium-Claim-Email`), plus lifetime
  bearer tokens in `auth_tokens` for the extension, which posts from `claude.ai` with no SSO session.
- **Browser Extension**: Chrome MV3 in `extension/`, scrapes claude.ai/settings/usage and syncs
  on a `chrome.alarms` schedule.
- **Teams**: NY, NC, Xyne, HS, JP.

## Commands

```bash
npm start                                  # run directly (needs node)
APP_PORT=3100 docker compose up --build -d # full local stack
docker run --rm --network host -v "$PWD/test:/test:ro" \
  -e API_BASE=http://localhost:3100 node:20-slim node /test/e2e.test.mjs
```

## Things that will bite you

- **Storage calls must stay synchronous.** `logUsage` is a read-modify-write across three keys
  with `await`s in between. Because the SQLite adapter never yields to the event loop, two
  concurrent syncs cannot interleave. Making `get`/`put` genuinely async reintroduces the
  clobbering that `helpers.js:kvPut` has a hand-rolled merge guard against.
- **One writer only.** The PVC is ReadWriteOnce and SQLite tolerates a single writer, so the
  Deployment is pinned to `replicas: 1` with `strategy: Recreate`. A RollingUpdate would try to
  run two pods against one volume. Horizontal scaling is not available.
- **The app trusts `X-Pomerium-Claim-Email` unconditionally** (`src/server.js:60`). The Service
  is ClusterIP and Pomerium must be the only route in; anything that can reach the pod directly
  can impersonate any user.
- **`POST /api/usage` must bypass SSO** at the proxy. The extension authenticates it with a
  bearer token instead. Behind SSO it silently 302s to a login page and syncs vanish.
- **`BASE_PATH`** — the app is mounted at `/claude/usage` on a host shared with grid. `server.js`
  strips the prefix itself, so it works whether or not the ingress rewrites. Frontend asset refs
  must stay **relative**, and `API_BASE` is derived from `new URL('.', location.href)`.

## Data model

KV keys, all JSON values:

- `users` → `[{ id, name, team, numPlans }]`
- `usage:{id}` → current state; per-plan `plans[]` + `activePlan`, plus flat back-compat fields
- `history:{id}` → session samples, capped at 500 (`MAX_HISTORY`), bucketed into 5-hour slots
- `weekly:{id}` → weekly peak/avg aggregates, capped at 52 (`MAX_WEEKLY`)
- `userconfig:{id}`, `projects`, `strategies`, `_cache:leaderboard` (60s TTL)

Those two caps make the dataset bounded: ~76 KB per user, so 100 users is under 10 MB.

Plus one real SQL table, `auth_tokens(token, email, user_id, created_at)`.

User IDs are `u_<timestamp_base36>_<random>`.

## Deployment

Jenkins builds and pushes `gcr.io/xyne-dev-461113/ai-leaderboard:<sha>`; deploys are manual
(`kubectl -n litellm set image`). Manifests in `k8s/`, namespace `litellm` alongside grid.
There is one environment and it is production, despite the `sbx` in the hostname.
