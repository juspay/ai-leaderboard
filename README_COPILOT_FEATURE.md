# GitHub Copilot Analytics Feature

Detailed documentation of the Copilot billing analytics integration added to the Claude Usage Leaderboard.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Database Schema](#database-schema)
4. [API Endpoints](#api-endpoints)
5. [Authentication & RBAC](#authentication--rbac)
6. [Frontend Components](#frontend-components)
7. [Sync Process](#sync-process)
8. [Environment Variables](#environment-variables)
9. [Kubernetes Deployment](#kubernetes-deployment)
10. [User Guide](#user-guide)

---

## Overview

This feature adds GitHub Copilot billing analytics to the existing Claude Usage Leaderboard. It fetches usage data from GitHub's Copilot Billing API, stores it in PostgreSQL, and provides:

- **Per-user Copilot spend tracking**
- **Usage breakdowns by AI model** (Claude Opus, Sonnet, GPT, Gemini)
- **Usage breakdowns by product** (Chat, IDE, CLI)
- **Historical trending** with day-by-day spend charts
- **Team association** via user linking
- **Automated syncing** via Kubernetes CronJob
- **Admin-only sync controls** (RBAC protected)

---

## Architecture

### Data Flow

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  GitHub API     │────▶│  Node.js Server  │────▶│  PostgreSQL DB  │
│  (/billing)     │     │  (Express)       │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │                          │
                               ▼                          ▼
                        ┌──────────────────┐     ┌─────────────────┐
                        │  Copilot HTML    │◄────│  KV Store       │
                        │  (Dashboard)     │     │  (email maps)   │
                        └──────────────────┘     └─────────────────┘
```

### Components

| Component | Technology | Purpose |
|-----------|------------|---------|
| Frontend | Vanilla HTML/CSS/JS | Dashboard UI (copilot.html) |
| Backend API | Express.js | HTTP endpoints, auth, proxying |
| Worker Handler | Cloudflare Worker pattern | Legacy KV operations |
| Database | PostgreSQL | Usage snapshots, auth tokens, identities |
| Sync Script | Node.js (scripts/) | Standalone sync utility |
| Scheduling | K8s CronJob | Hourly automated sync |

---

## Database Schema

### Migration 003: Copilot Usage Tables

#### `copilot_usage_snapshots`
Stores granular usage data from GitHub API.

```sql
CREATE TABLE copilot_usage_snapshots (
  id SERIAL PRIMARY KEY,
  scope_type TEXT NOT NULL DEFAULT 'org',
  scope_name TEXT NOT NULL,
  period_year INT NOT NULL,
  period_month INT NOT NULL,
  period_day INT NOT NULL,
  github_username TEXT NOT NULL,
  product TEXT,
  sku TEXT,
  model TEXT,
  unit_type TEXT,
  price_per_unit DECIMAL(18,8),
  gross_quantity DECIMAL(18,4),
  gross_amount DECIMAL(18,4),
  discount_quantity DECIMAL(18,4),
  discount_amount DECIMAL(18,4),
  net_quantity DECIMAL(18,4),
  net_amount DECIMAL(18,4),
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  raw_payload JSONB
);
```

**Unique Index:** `(scope_type, scope_name, period_year, period_month, period_day, github_username, product, sku, model)`

**Purpose:** Prevents duplicate records when syncing same day multiple times.

#### `user_provider_identities`
Maps external identities (GitHub) to internal leaderboard users.

```sql
CREATE TABLE user_provider_identities (
  id SERIAL PRIMARY KEY,
  leaderboard_user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_username TEXT NOT NULL,
  external_org TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Unique Constraints:**
- `(leaderboard_user_id, provider)` — one external identity per provider per user
- `(provider, external_username)` — each GitHub username linked once

**Purpose:** Associates GitHub Copilot usage with leaderboard users for team rollup.

---

### Migration 004: Admin RBAC

#### `auth_tokens` (modified)
Added `is_admin` column for role-based access control.

```sql
ALTER TABLE auth_tokens ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE;
```

**Default:** All users are non-admins initially.

**Grant admin:**
```sql
UPDATE auth_tokens SET is_admin = true WHERE email = 'admin@company.com';
```

---

## API Endpoints

### Copilot Endpoints

#### `POST /api/copilot/sync`
Triggers usage data sync from GitHub API.

**Access:** Admin only, or valid `X-Copilot-Sync-Token` header

**Request Body:**
```json
{
  "scopeType": "org",
  "scopeName": "juspay",
  "year": 2026,
  "month": 4,
  "day": 17,
  "expandOrgUsers": true,
  "concurrency": 4
}
```

**Response:**
```json
{
  "ok": true,
  "sourceUrl": "https://api.github.com/...",
  "scopeType": "org",
  "scopeName": "juspay",
  "usersProcessed": 150,
  "usersFailed": 0,
  "fetched": 312,
  "upserted": 312
}
```

**Operation:**
1. Fetches organization members from GitHub
2. For each member, fetches Copilot usage for the date
3. Normalizes and upserts rows into `copilot_usage_snapshots`

**API Call Volume:** `ceil(N/100) + N` where N = member count
- 150 members → 152 API calls
- Well within GitHub's 5000/hr limit

---

#### `GET /api/copilot/summary`
Aggregated usage statistics with filtering.

**Query Parameters:**
- `scopeName` — organization name
- `year`, `month`, `day` — date filters
- `model` — filter by AI model (e.g., "Claude Opus 4.6")
- `product` — filter by product (e.g., "Copilot")
- `githubUsername` — specific user

**Response:**
```json
{
  "filters": { ... },
  "totals": {
    "net_amount": "183.08",
    "net_quantity": "4577.11",
    "rows": 238
  },
  "byPeriod": [
    {"period_year": 2026, "period_month": 4, "period_day": 16, "net_amount": "183.08", "net_quantity": "4577.11"}
  ],
  "byModel": [
    {"model": "Claude Opus 4.6", "net_amount": "124.05", "net_quantity": "1240.50"}
  ],
  "byProduct": [
    {"product": "Copilot", "net_amount": "183.08", "net_quantity": "4577.11"}
  ]
}
```

---

#### `GET /api/copilot/users`
List users with spend data and linkage status.

**Query Parameters:** Same as summary

**Response:**
```json
{
  "filters": { ... },
  "users": [
    {
      "github_username": "maverox",
      "net_amount": "19.56",
      "net_quantity": "489",
      "last_fetched_at": "2026-04-17T02:47:52Z",
      "leaderboard_user_id": "u_mo1ruzda_uxcgc",
      "leaderboard_user_name": "Alice Kumar",
      "leaderboard_user_team": "NY"
    }
  ]
}
```

---

#### `PUT /api/copilot/identity/:leaderboardUserId`
Manually link a GitHub username to a leaderboard user.

**Request Body:**
```json
{
  "githubUsername": "maverox",
  "externalOrg": "juspay"
}
```

**Access:** Authenticated users

---

#### `GET /api/copilot/email-map`
Retrieve the GitHub username → email mapping (for auto-link).

**Access:** Authenticated users

**Response:**
```json
{
  "map": {
    "the-third-eye-3": "pramod@juspay.in",
    "alice-gh": "alice@juspay.in"
  }
}
```

---

#### `PUT /api/copilot/email-map`
Update the email mapping.

**Access:** Admin only

**Request Body:**
```json
{
  "the-third-eye-3": "pramod@juspay.in",
  "alice-gh": "alice@juspay.in"
}
```

---

#### `POST /api/copilot/auto-link`
Automatically link unlinked GitHub users based on email map.

**Access:** Admin only

**Process:**
1. Loads `copilot:github_email_map` from KV
2. Finds unlinked GitHub usernames in `copilot_usage_snapshots`
3. Looks up email in map → finds `auth_tokens` record with that email → gets `user_id`
4. Inserts record into `user_provider_identities`

**Response:**
```json
{
  "linked": 12,
  "skipped": 5,
  "details": [
    {"github_username": "maverox", "email": "eswar@juspay.in", "leaderboardUserId": "u_xxx", "status": "linked"},
    {"github_username": "unknown", "status": "skipped", "reason": "not in email map"}
  ]
}
```

---

### Modified Auth Endpoints

#### `GET /api/me`
Returns current user info including admin status.

**Response:**
```json
{
  "email": "user@juspay.in",
  "source": "token",
  "isAdmin": false
}
```

#### `POST /api/auth/logout`
Client-side logout endpoint.

---

## Authentication & RBAC

### Token Types

| Token | Location | Purpose |
|-------|----------|---------|
| `GITHUB_TOKEN` | Env var / Secret | Access GitHub API for billing data |
| `COPILOT_SYNC_TOKEN` | Env var / Secret | Protect sync endpoint (cronjobs) |
| `leaderboard_token` | Cookie / Header | User authentication |

### Role-Based Access Control

| Endpoint | Admin | Regular User | Sync Token |
|----------|-------|--------------|------------|
| `POST /api/copilot/sync` | ✅ | ❌ | ✅ |
| `PUT /api/copilot/email-map` | ✅ | ❌ | ❌ |
| `POST /api/copilot/auto-link` | ✅ | ❌ | ❌ |
| `GET /api/copilot/email-map` | ✅ | ✅ | ❌ |
| `GET /api/copilot/summary` | ✅ | ✅ | ❌ |
| `GET /api/copilot/users` | ✅ | ✅ | ❌ |
| `PUT /api/copilot/identity/*` | ✅ | ✅ | ❌ |

### Making Someone Admin

```sql
-- Direct database update
UPDATE auth_tokens SET is_admin = true WHERE email = 'admin@juspay.in';
```

Or via API (if you add a bootstrap endpoint):
```bash
curl -X POST http://localhost:3000/api/auth/set-admin \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -d '{"email": "user@juspay.in", "isAdmin": true}'
```

---

## Frontend Components

### Sidebar Navigation (Both Pages)

Located on far left edge with glassmorphism effect:

```
┌─────────────────┐
│ Leaderboards    │
│ 🤖 Claude Code  │ ← Active on /
│ 🚀 Copilot      │ ← Active on /copilot.html
│                 │
├─────────────────┤
│ user@email.com  │
│ ADMIN           │ ← Only if isAdmin
│ [Logout]        │
└─────────────────┘
```

**Features:**
- Sticky positioning (follows scroll)
- Glass morphism: `backdrop-filter: blur(8px)`
- Responsive: collapses to horizontal on mobile
- Shows current user email and admin badge
- Logout clears `leaderboard_token` and redirects to `/setup.html`

---

### Copilot Dashboard (`/copilot.html`)

#### Header Stats Cards
- **Usage Rows**: Total records synced
- **Gross Amount**: Sum of `gross_amount` (before discounts)
- **Net Quantity**: Total requests/tokens consumed
- **Active Users**: Distinct GitHub usernames with usage

#### Sync Section (Admin Only)
Collapsible panel with:
- Organization scope input
- Date filters (year, month, day)
- Per-user filter
- Model/product filters
- **Run Sync** button (admin only)
- **Auto-link Users** button (admin only)
- Result display with JSON output

#### Breakdowns Grid
Shows top of page:
- **By Model**: Claude Opus 4.6, Sonnet 4.6, GPT-5.4, Gemini 3 Flash, etc.
- **By Product**: Copilot (Chat, IDE, CLI)

#### Recent Periods
Pill-style list of recent days with amounts.

#### Users Leaderboard
Scrollable list (max 420px height):
- Rank medal (🥇🥈🥉 or number)
- GitHub username + linked leaderboard name
- Team tag + tier badge (POWER 🔥, HEAVY 👑, ACTIVE ⚡, LIGHT)
- Synced time ago
- Share percentage
- Horizontal spend bar
- Gross amount

Clicking a row opens detail panel.

---

### User Detail Panel

Slide-in panel showing:

**Header:**
- GitHub username
- Team tag (if linked) or "Unlinked"

**Link Form (if unlinked):**
- Dropdown of unclaimed leaderboard users
- Link button
- Result message

**Stats Sections:**
- Current view stats (Today/Month/All Time)
- All-time summary (total, avg/day, active days, peak day, total qty)

**Charts:**
- Daily spend trend (line graph with dots)

**Breakdowns:**
- Spend by model
- Spend by product

**Period Log Table:**
- Date, amount, quantity per day

---

## Sync Process

### Manual Sync (UI)

1. Admin expands "Sync From GitHub" section
2. Sets filters (defaults to today, all users)
3. Clicks "Run Sync"
4. Server:
   - Validates admin or sync token
   - Calls GitHub Org Members API
   - For each member (with concurrency limit 4):
     - Calls Copilot Usage API
     - Normalizes response rows
     - Upserts to database
5. Displays result (users processed, rows upserted)

### Automated Sync (K8s CronJob)

```yaml
# Runs every hour at :15
schedule: "15 * * * *"
```

Command: `node scripts/sync-copilot-usage.mjs`

**Script behavior:**
1. Reads `COPILOT_SCOPE_NAME` from env
2. Calls `POST /api/copilot/sync` with sync token
3. Logs results to stdout
4. Exits (pod terminates, job completes)

**Benefits:**
- Runs without user intervention
- Uses `COPILOT_SYNC_TOKEN` (no user credentials needed)
- Keeps data fresh hourly
- Failed jobs retry with `backoffLimit: 2`

---

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://localhost:5432/ai_leaderboard` |
| `GITHUB_TOKEN` | GitHub PAT with `read:org` and billing access | `ghp_xxxxxxxxxxxx` |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `COPILOT_SCOPE_NAME` | `GITHUB_ORG` or `juspay` | Default organization for syncs |
| `COPILOT_SYNC_TOKEN` | (none) | Secret token for cronjob auth |
| `PORT` | `3000` | HTTP server port |
| `PLAN_COST` | `200` | Cost per plan (for legacy gauge) |
| `CF_ACCESS_AUD` | (none) | Cloudflare Access AUD |
| `CF_ACCESS_TEAM_DOMAIN` | (none) | Cloudflare team domain |

---

## Kubernetes Deployment

### Resources Created

| File | Resource | Purpose |
|------|----------|---------|
| `k8s/app.yml` | Deployment | Main leaderboard app |
| `k8s/configmap.yml` | ConfigMap | Non-sensitive env vars |
| `k8s/copilot-sync-cronjob.yml` | CronJob | Hourly sync automation |

### Copilot Sync CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: leaderboard-copilot-sync
spec:
  schedule: "15 * * * *"  # Every hour at :15
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: copilot-sync
            image: ghcr.io/piyushkumar-1/ai-leaderboard:latest
            command: ["node", "scripts/sync-copilot-usage.mjs"]
            env:
            - name: COPILOT_SYNC_TOKEN
              valueFrom:
                secretKeyRef:
                  name: leaderboard-secrets
                  key: COPILOT_SYNC_TOKEN
```

### Secrets Required

```bash
kubectl create secret generic leaderboard-secrets \
  --from-literal=GITHUB_TOKEN=ghp_xxx \
  --from-literal=COPILOT_SYNC_TOKEN=random-string-here
```

---

## User Guide

### For Regular Users

1. **View Copilot Analytics:**
   - Navigate to `/copilot.html`
   - See top users, models used, spending trends

2. **Link Your Account:**
   - Click your GitHub username in the list
   - If "Unlinked", select your leaderboard name from dropdown
   - Click "Link"

3. **View Personal Details:**
   - Click your row to see daily spend chart, model breakdown

### For Admins

1. **Configure Email Mapping:**
   ```bash
   curl -X PUT http://localhost:3000/api/copilot/email-map \
     -H "Authorization: Bearer TOKEN" \
     -d '{"github-user": "email@company.com"}'
   ```

2. **Run Auto-Link:**
   - Click "Auto-link Users" button
   - Review results (linked vs skipped)

3. **Manual Sync:**
   - Expand "Sync From GitHub"
   - Adjust filters if needed
   - Click "Run Sync"
   - Wait for completion

4. **Grant Admin Rights:**
   ```sql
   UPDATE auth_tokens SET is_admin = true WHERE email = 'user@company.com';
   ```

---

## Testing

### Unit Tests
Run with: `npm test`

### E2E Tests
Located in `test/e2e.test.mjs`

Test coverage includes:
- User CRUD operations
- Usage logging
- Auth token validation
- Import/export functionality

---

## Migration Notes

### Applying Migrations

```bash
# Automatic on server start
node src/server.js

# Or manual
psql $DATABASE_URL -f src/migrations/003_create_copilot_usage_tables.sql
psql $DATABASE_URL -f src/migrations/004_add_is_admin.sql
```

### Rollback

```sql
-- Reverse migration 004
ALTER TABLE auth_tokens DROP COLUMN is_admin;

-- Reverse migration 003
DROP TABLE user_provider_identities;
DROP TABLE copilot_usage_snapshots;
```

---

## Troubleshooting

### "githubToken is required"
Set `GITHUB_TOKEN` environment variable.

### "Authentication required"
Visit `/setup.html` to link your account and get a token.

### "Admin access required"
Your account doesn't have `is_admin=true`. Contact an admin.

### Sync returns 0 rows
- Check GitHub token has billing access
- Verify organization name is correct
- Ensure date filters are valid

### User shows "Unlinked"
- Add email mapping and run auto-link
- Or manually link in detail panel

---

## Future Enhancements

- [ ] Monthly spending alerts
- [ ] Budget limits per team
- [ ] Model usage recommendations
- [ ] Export to CSV/Excel
- [ ] Slack notifications for high spenders

---

*Generated from staged changes. Last updated: 2026-04-17*
