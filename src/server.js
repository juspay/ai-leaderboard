import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPgKV } from './pg-kv.js';
import { createAuthManager } from './auth-tokens.js';
import {
  autoLinkCopilotUsers,
  listCopilotUsers,
  queryCopilotSummary,
  syncCopilotUsage,
  syncCopilotUsageByOrgMembers,
  upsertUserProviderIdentity,
} from './copilot-sync.js';
import { runMigrations } from './migrations/run.js';
import worker from './worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/ai_leaderboard';

// Run migrations then create KV adapter
const kv = await createPgKV(DATABASE_URL);
console.log('Running migrations...');
await runMigrations(kv._pool);
console.log('Connected to PostgreSQL');

const auth = createAuthManager(kv._pool);
const COPILOT_DEFAULT_SCOPE_NAME = process.env.COPILOT_SCOPE_NAME || process.env.GITHUB_ORG || 'juspay';
const COPILOT_DEFAULT_GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const COPILOT_SYNC_TOKEN = process.env.COPILOT_SYNC_TOKEN || '';

const env = {
  LEADERBOARD_KV: kv,
  PLAN_COST: process.env.PLAN_COST || '200',
  CF_ACCESS_AUD: process.env.CF_ACCESS_AUD || '',
  CF_ACCESS_TEAM_DOMAIN: process.env.CF_ACCESS_TEAM_DOMAIN || '',
};

const app = express();
app.use(express.json({ limit: '5mb' }));

// Serve static files from public/
app.use(express.static(path.join(__dirname, '..', 'public')));

// ============================================================
// Auth helpers
// ============================================================

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  if (req.query?.token) return req.query.token;
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)leaderboard_token=([^\s;]+)/);
  return match ? match[1] : null;
}

function getPomeriumIdentity(req) {
  let email = req.headers['x-pomerium-claim-email'] || '';
  let groups = req.headers['x-pomerium-claim-groups'] || '';
  let user = req.headers['x-pomerium-claim-user'] || '';

  if (!email) {
    const jwt = req.headers['x-pomerium-jwt-assertion'] || '';
    if (jwt) {
      try {
        const parts = jwt.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
          email = payload.email || '';
          groups = Array.isArray(payload.groups) ? payload.groups : [];
          user = payload.user || payload.sub || '';
        }
      } catch (e) {
        void e;
      }
    }
  } else {
    groups = groups ? groups.split(',').map((g) => g.trim()) : [];
  }

  if (!email) return null;
  if (typeof groups === 'string') groups = groups ? groups.split(',').map((g) => g.trim()) : [];
  return { email, groups, user };
}

async function resolveAuth(req) {
  const token = extractToken(req);
  if (token) {
    const record = await auth.getByToken(token);
    if (record) return { email: record.email, record, source: 'token' };
    return null;
  }

  const identity = getPomeriumIdentity(req);
  if (identity) return { email: identity.email, source: 'pomerium' };

  return null;
}

function parseOptionalInt(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getUtcDateParts() {
  const now = new Date();
  return {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate(),
  };
}

function buildCopilotFilters(input = {}) {
  const today = getUtcDateParts();
  return {
    year: parseOptionalInt(input.year) ?? today.year,
    month: parseOptionalInt(input.month) ?? today.month,
    day: parseOptionalInt(input.day) ?? today.day,
    user: input.user || undefined,
    model: input.model || undefined,
    product: input.product || undefined,
  };
}

function parseOptionalBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function hasSyncToken(req) {
  if (!COPILOT_SYNC_TOKEN) return false;
  const header = req.headers['x-copilot-sync-token'];
  return typeof header === 'string' && header === COPILOT_SYNC_TOKEN;
}

async function requireAdmin(req, res) {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required.' });
    return false;
  }
  const isAdmin = await auth.isAdmin(token);
  if (!isAdmin) {
    res.status(403).json({ error: 'Admin access required.' });
    return false;
  }
  return true;
}

// ============================================================
// Auth endpoints
// ============================================================

app.get('/api/me', async (req, res) => {
  const identity = await resolveAuth(req);
  if (!identity) return res.status(401).json({ error: 'Not authenticated.' });
  const isAdmin = identity.record?.is_admin === true;
  res.json({ email: identity.email, source: identity.source, isAdmin });
});

app.post('/api/auth/setup', async (req, res) => {
  const identity = await resolveAuth(req);
  if (!identity) return res.status(401).json({ error: 'Authentication required.' });

  try {
    let record = identity.record || await auth.getOrCreateToken(identity.email);

    const { userId, newUserName, newUserTeam } = req.body || {};

    if (userId) {
      const result = await auth.claimUser(record.token, userId);
      if (result.error) return res.status(409).json(result);
      record.user_id = userId;
    } else if (newUserName) {
      const createRes = await worker.fetch(
        new Request('http://localhost/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newUserName, team: newUserTeam || 'NC' }),
        }),
        env
      );
      const created = await createRes.json();
      if (created.error) return res.status(createRes.status).json(created);

      const result = await auth.claimUser(record.token, created.id);
      if (result.error) return res.status(409).json(result);
      record.user_id = created.id;
    }

    let userName = null;
    if (record.user_id) {
      const users = await kv.get('users', 'json') || [];
      const u = users.find((user) => user.id === record.user_id);
      if (u) userName = u.name;
    }

    res.json({
      token: record.token,
      email: record.email,
      userId: record.user_id,
      userName,
    });
  } catch (err) {
    console.error('Auth setup error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/verify', async (req, res) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'No token provided.' });

  try {
    const record = await auth.getByToken(token);
    if (!record) return res.status(401).json({ error: 'Invalid token.' });
    res.json({ email: record.email, userId: record.user_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/unlink', async (req, res) => {
  const identity = await resolveAuth(req);
  if (!identity) return res.status(401).json({ error: 'Authentication required.' });

  try {
    const record = identity.record || await auth.getByEmail(identity.email);
    if (!record) return res.status(404).json({ error: 'No token found for this email.' });

    await kv._pool.query('UPDATE auth_tokens SET user_id = NULL WHERE token = $1', [record.token]);
    res.json({ ok: true, email: record.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/whoami', async (req, res) => {
  try {
    const identity = await resolveAuth(req);
    if (!identity) return res.json({ userId: null });

    const record = identity.record || await auth.getByEmail(identity.email);
    if (!record) return res.json({ userId: null, email: identity.email });

    if (record.user_id) {
      const users = await kv.get('users', 'json') || [];
      const u = users.find((user) => user.id === record.user_id);
      return res.json({ userId: record.user_id, userName: u ? u.name : null, email: record.email });
    }

    res.json({ userId: null, email: record.email });
  } catch (err) {
    void err;
    res.json({ userId: null });
  }
});

app.get('/api/auth/unclaimed-users', async (req, res) => {
  const identity = await resolveAuth(req);
  if (!identity) return res.status(401).json({ error: 'Authentication required.' });

  try {
    const users = await kv.get('users', 'json') || [];
    const claimed = await auth.getClaimedUserIds();
    const unclaimed = users.filter((u) => !claimed.has(u.id));
    res.json(unclaimed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', async (_req, res) => {
  // Client-side logout only - clear any session cookies if we add them later
  res.json({ ok: true });
});

// ============================================================
// Copilot billing usage endpoints (GitHub)
// ============================================================

app.post('/api/copilot/sync', async (req, res) => {
  // Allow sync token for cronjobs, otherwise require admin
  if (hasSyncToken(req)) {
    // proceed with sync
  } else if (!(await requireAdmin(req, res))) {
    return;
  }

  try {
    const body = req.body || {};
    const requestedScopeType = body.scopeType ? String(body.scopeType).toLowerCase() : 'org';
    if (requestedScopeType !== 'org') {
      return res.status(400).json({ error: 'Only organization scope is supported.' });
    }
    const scopeType = 'org';
    const scopeName = body.scopeName || COPILOT_DEFAULT_SCOPE_NAME;
    const githubToken = body.githubToken || COPILOT_DEFAULT_GITHUB_TOKEN;
    const filters = buildCopilotFilters(body);
    const expandOrgUsers = parseOptionalBool(body.expandOrgUsers, true);
    const concurrency = parseOptionalInt(body.concurrency) || 4;
    console.log(
      `[copilot-sync] API trigger: source=${identity ? identity.source : 'sync-token'} scopeType=${scopeType} scopeName=${scopeName} expandOrgUsers=${expandOrgUsers} concurrency=${concurrency} filters=${JSON.stringify(filters)}`
    );

    if (!scopeName) {
      return res.status(400).json({ error: 'scopeName is required (body or COPILOT_SCOPE_NAME).' });
    }
    if (!githubToken) {
      return res.status(400).json({ error: 'githubToken is required (body or GITHUB_TOKEN).' });
    }

    const runPerUserOrgSync = scopeType === 'org' && !filters.user && expandOrgUsers;
    const result = runPerUserOrgSync
      ? await syncCopilotUsageByOrgMembers({
        pool: kv._pool,
        githubToken,
        org: scopeName,
        filters,
        concurrency,
      })
      : await syncCopilotUsage({
        pool: kv._pool,
        githubToken,
        scopeType,
        scopeName,
        filters,
      });

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/copilot/summary', async (req, res) => {
  const identity = await resolveAuth(req);
  if (!identity) return res.status(401).json({ error: 'Authentication required.' });

  try {
    const filters = {
      scopeType: 'org',
      scopeName: req.query.scopeName || undefined,
      year: parseOptionalInt(req.query.year),
      month: parseOptionalInt(req.query.month),
      day: parseOptionalInt(req.query.day),
      model: req.query.model || undefined,
      product: req.query.product || undefined,
      githubUsername: req.query.githubUsername || undefined,
    };
    const summary = await queryCopilotSummary(kv._pool, filters);
    return res.json(summary);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/copilot/users', async (req, res) => {
  const identity = await resolveAuth(req);
  if (!identity) return res.status(401).json({ error: 'Authentication required.' });

  try {
    const filters = {
      scopeType: 'org',
      scopeName: req.query.scopeName || undefined,
      year: parseOptionalInt(req.query.year),
      month: parseOptionalInt(req.query.month),
      day: parseOptionalInt(req.query.day),
    };
    const rows = await listCopilotUsers(kv._pool, filters);

    const users = await kv.get('users', 'json') || [];
    const byId = new Map(users.map((user) => [user.id, user]));

    const enriched = rows.map((row) => {
      const linked = row.leaderboard_user_id ? byId.get(row.leaderboard_user_id) : null;
      return {
        ...row,
        leaderboard_user_name: linked?.name || null,
        leaderboard_user_team: linked?.team || null,
      };
    });

    return res.json({ filters, users: enriched });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/copilot/email-map', async (req, res) => {
  // Anyone authenticated can view the map
  const identity = await resolveAuth(req);
  if (!identity) return res.status(401).json({ error: 'Authentication required.' });

  try {
    const map = await kv.get('copilot:github_email_map', 'json');
    return res.json({ map: map || {} });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/copilot/email-map', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;

  try {
    const map = req.body;
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      return res.status(400).json({ error: 'Body must be an object with github_username -> email mappings.' });
    }
    await kv.put('copilot:github_email_map', map);
    return res.json({ ok: true, count: Object.keys(map).length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/copilot/auto-link', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;

  try {
    const org = (req.body && req.body.org) || COPILOT_DEFAULT_SCOPE_NAME || null;
    const result = await autoLinkCopilotUsers(kv._pool, kv, { org });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/copilot/identity/:leaderboardUserId', async (req, res) => {
  const identity = await resolveAuth(req);
  if (!identity) return res.status(401).json({ error: 'Authentication required.' });

  try {
    const leaderboardUserId = req.params.leaderboardUserId;
    const { githubUsername, externalOrg } = req.body || {};

    if (!githubUsername) {
      return res.status(400).json({ error: 'githubUsername is required.' });
    }

    const users = await kv.get('users', 'json') || [];
    const userExists = users.some((u) => u.id === leaderboardUserId);
    if (!userExists) {
      return res.status(404).json({ error: 'Leaderboard user not found.' });
    }

    const mapping = await upsertUserProviderIdentity(kv._pool, {
      leaderboardUserId,
      externalUsername: githubUsername,
      externalOrg,
    });

    return res.json({ ok: true, mapping });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// All other API routes -> worker fetch handler
// All write endpoints require token auth
// ============================================================

app.use('/api', async (req, res) => {
  try {
    const token = extractToken(req);
    const record = token ? await auth.getByToken(token) : null;

    if (req.path === '/usage' && req.method === 'POST') {
      if (!record) {
        return res.status(401).json({ error: 'Valid token required. Get yours at /setup.html' });
      }
    } else if (token && !record) {
      return res.status(401).json({ error: 'Invalid token.' });
    }

    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const headers = new Headers();
    for (const [key, val] of Object.entries(req.headers)) {
      if (val) headers.set(key, Array.isArray(val) ? val.join(', ') : val);
    }

    const init = { method: req.method, headers };
    if (!['GET', 'HEAD'].includes(req.method)) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body = Buffer.concat(chunks);
      if (body.length === 0 && req.body) {
        body = Buffer.from(JSON.stringify(req.body));
      }
      if (body.length > 0) init.body = body;
    }

    const webRequest = new Request(url, init);
    const webResponse = await worker.fetch(webRequest, env);

    res.status(webResponse.status);
    for (const [key, val] of webResponse.headers.entries()) {
      res.set(key, val);
    }
    const responseBody = await webResponse.text();
    res.send(responseBody);
  } catch (err) {
    console.error('Request error:', err);
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Leaderboard server running on http://localhost:${PORT}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down...`);
    server.close(() => {
      kv.quit().then(() => process.exit(0));
    });
  });
}
