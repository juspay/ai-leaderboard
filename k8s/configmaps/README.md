# Config keys

This app owns no ConfigMap. It reads from `app-config` in namespace `litellm`,
shared by every LITELLM product on `h200-shell-cluster` and managed through
InfraSwitch — not `kubectl apply`. No manifest here on purpose; applying one
would fight the platform for ownership.

Add these under **InfraSwitch → LITELLM → h200-shell-cluster → Config Maps →
app-config**:

| Key | Value | |
|---|---|---|
| `CLAUDE_BASE_PATH` | `/claude/usage` | **required** — must match the ingress path rule |
| `CLAUDE_DB_PATH` | `/data/leaderboard.db` | must sit inside the PVC mountPath |
| `CLAUDE_PLAN_COST` | `200` | monthly USD per Claude Max plan; drives the budget maths |

Everything is a ConfigMap key rather than a literal in the Deployment, because
InfraSwitch owns the Deployment: literals written into `k8s/app/deployment.yaml`
would not survive a platform-driven redeploy.

## Two keys are coupled to things outside the ConfigMap

Both fail loudly rather than silently, but they are not free-form:

- **`CLAUDE_BASE_PATH`** must equal the path in `k8s/ingress-patch.yaml`
  (`/claude/usage`). Change one without the other and every request 404s.
- **`CLAUDE_DB_PATH`** must point inside the volume mountPath (`/data`). Point
  it elsewhere and the app writes to the container filesystem instead of the
  PVC — it will work, then lose everything on the next restart. The `Dockerfile`
  defaults it to the correct value, so omitting the key is safer than setting it
  wrongly.

## Why the prefix

`app-config` already holds ~32 keys belonging to grid (`FLASK_ENV`,
`GOOGLE_CLIENT_ID`, `BACKEND_PORT`, …). Bare names like `BASE_PATH` or `DB_PATH`
would be ambiguous now and collide as more products land in the same map.

The prefix is used consistently — ConfigMap key, container env var, and what
`src/server.js` reads — so there is one name per value.

The exception is `CLAUDE_PLAN_COST`. `src/worker.js` is shared with the
Cloudflare Workers deployment and reads a bare `env.PLAN_COST`, so `server.js`
maps the prefixed variable onto that bare name when building the worker's env.
The shared Worker code stays unaware of this cluster's conventions.

## Not needed

- **`PORT`** — the app defaults to 8420 (`src/server.js`), matching
  `containerPort` and the Service port.
- **`CF_ACCESS_AUD` / `CF_ACCESS_TEAM_DOMAIN`** — Cloudflare Access is not used
  here. Unset means the worker's JWT check is skipped (`src/auth.js`), which is
  the intended behaviour. Setting them would enable a check that rejects every
  request, since nothing here issues those tokens.
- **`CLAUDE_BACKUP_BUCKET`** — was only read by the backup CronJob, which has
  been removed.

Named keys are used rather than `envFrom`, which would inject all ~32 of grid's
variables into this container.
