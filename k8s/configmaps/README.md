# Config keys

This app does **not** own a ConfigMap. It reads from `app-config` in namespace
`litellm`, which is shared by every LITELLM product on `h200-shell-cluster` and
is managed through InfraSwitch — not `kubectl apply`. There is no manifest here
on purpose; applying one would fight the platform for ownership.

Add these under **InfraSwitch → LITELLM → h200-shell-cluster → Config Maps →
app-config**:

| Key | Value | Notes |
|---|---|---|
| `CLAUDE_BASE_PATH` | `/claude/usage` | Mount point on `grid-sbx.ai.juspay.net`. Required — no default. |
| `CLAUDE_PLAN_COST` | `200` | Monthly USD cost of one Claude Max plan; drives the budget maths. |
| `CLAUDE_BACKUP_BUCKET` | *(a GCS bucket name)* | Only used by `backup-cronjob.yaml`. Marked `optional`, so the Deployment starts without it. |

## Why the prefix

`app-config` already holds ~32 keys belonging to grid (`FLASK_ENV`,
`GOOGLE_CLIENT_ID`, `BACKEND_PORT`, …). Unprefixed names like `BASE_PATH`,
`DB_PATH` or `PLAN_COST` would be ambiguous at best, and would collide outright
as more products land in the same map.

The prefix is used consistently — in the ConfigMap, in the container's
environment, and in what `src/server.js` reads — so there is one name for each
value rather than a mapping to keep in sync:

```yaml
- name: CLAUDE_BASE_PATH
  valueFrom:
    configMapKeyRef:
      name: app-config
      key: CLAUDE_BASE_PATH
```

The one exception is `CLAUDE_PLAN_COST`. `src/worker.js` is shared with the
Cloudflare Workers deployment and reads a bare `env.PLAN_COST`, so `server.js`
maps the prefixed variable onto that bare name when building the worker's env.
Nothing in the shared Worker code needs to know about this cluster's naming.

## Keys deliberately not in the ConfigMap

- **`CLAUDE_DB_PATH`** — set as a literal in `deployment.yaml`. It only makes
  sense alongside the volumeMount it points into, so it belongs next to it
  rather than in shared, human-edited config. Also defaulted in the `Dockerfile`.
- **`PORT`** — the app defaults to 3000 (`src/server.js`), matching
  `containerPort`. Nothing to configure.
- **`CF_ACCESS_AUD` / `CF_ACCESS_TEAM_DOMAIN`** — Cloudflare Access is not used
  in this deployment. Unset means the worker's JWT check is skipped
  (`src/auth.js`), which is the intended behaviour here.

Named keys are used rather than `envFrom`, which would inject all ~32 of grid's
variables into this container.
