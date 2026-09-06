# InfraSwitch-owned resources

InfraSwitch owns the Deployment, Service, HPA and ConfigMap for this app on
`h200-shell-cluster`. Nothing in this directory is applied with `kubectl`.

- `service.json` — Service, in the same template shape as grid's.
- Config keys: see `../configmaps/README.md`.
- Deployment settings: see `../app/deployment.yaml`, kept as the spec to reproduce.

## Values to fill in

Values are hardcoded rather than templated. Grid's deployed Service shows the
platform does resolve `{{service_name}}` into `metadata.name`, `labels.app` and
`selector.app` — but with one service, one namespace and one environment, a
placeholder only adds a way to get a Service literally named `{{service_name}}`.
`tier` and `version` are dropped because grid's deployed Service carries neither.

The name matters beyond labelling: `../ingress-patch.yaml` routes
`/claude/usage` to `claude-leaderboard:8420`, so the two must agree or the
ingress backend will not resolve.

## Differences from the grid template

**Port 8420, not 5000.** Chosen to be distinctive: several apps in this
namespace already listen on 3000, so a unique port keeps logs, NEG names and
ingress backends unambiguous. Port equals targetPort, matching how grid and
every other backend on `litellm-ingress` is wired — the ingress references each
app's own port rather than 80.

**`tier: app`, not `tier: backend`.** Grid splits into separate frontend and
backend Services. This app serves its dashboard and its API from one container,
so there is nothing to distinguish.

**`{{version}}` closes properly.** The grid template has `"{{version}"` with a
missing brace — worth fixing there too, since it would substitute literally.

## Constraints on the Deployment

Two settings are correctness constraints, not preferences:

- **`replicas: 1`** and **no HPA above 1.** SQLite on a ReadWriteOnce disk
  tolerates exactly one writer. A second pod either wedges on a Multi-Attach
  error or corrupts the database.
- **`strategy: Recreate`.** A RollingUpdate starts the new pod before the old
  one releases the disk, so every rollout would hang.

Also required: the `leaderboard-data` PVC mounted at `/data`, and
`runAsUser`/`fsGroup` `1000` so the non-root process can write to it.
