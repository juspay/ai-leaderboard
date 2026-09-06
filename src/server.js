import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createSqliteKV } from './sqlite-kv.js';
import { createAuthManager } from './auth-tokens.js';
import { runMigrations } from './migrations/run.js';
import worker from './worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// In the cluster this points inside the mounted PVC (see k8s/app/pvc.yaml).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'leaderboard.db');

// Open the database then bring the schema up to date
const kv = createSqliteKV(DB_PATH);
console.log('Running migrations...');
runMigrations(kv._db);
console.log(`Connected to SQLite at ${DB_PATH}`);

const auth = createAuthManager(kv._db);

const env = {
  LEADERBOARD_KV: kv,
  PLAN_COST: process.env.PLAN_COST || '200',
  CF_ACCESS_AUD: process.env.CF_ACCESS_AUD || '',       // empty = skip auth
  CF_ACCESS_TEAM_DOMAIN: process.env.CF_ACCESS_TEAM_DOMAIN || '',
};

const app = express();
app.use(express.json({ limit: '5mb' }));

// ============================================================
// Base path
// ============================================================

/**
 * When the app is mounted under a prefix on a shared host — e.g.
 * https://grid-sbx.ai.juspay.net/claude/usage — set BASE_PATH=/claude/usage.
 *
 * The prefix is stripped here rather than assumed to be stripped by the proxy,
 * so the app serves correctly whether or not the ingress rewrites the path.
 * Everything downstream (static files, API routes, the worker handler) keeps
 * seeing plain /api/... and /index.html and needs no prefix awareness.
 */
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');

if (BASE_PATH) {
  app.use((req, res, next) => {
    // Redirect the bare prefix to its trailing-slash form. The frontend uses
    // relative asset URLs, which only resolve correctly below a directory.
    if (req.url === BASE_PATH) return res.redirect(301, BASE_PATH + '/');
    if (req.url.startsWith(BASE_PATH + '/')) req.url = req.url.slice(BASE_PATH.length);
    next();
  });
}

// Serve static files from public/
app.use(express.static(path.join(__dirname, '..', 'public')));

// ============================================================
// Auth helpers
// ============================================================

/**
 * Extract leaderboard token from the request.
 * Priority: Authorization header → query param → leaderboard_token cookie.
 *
 * - Extension background.js sends Authorization: Bearer <token>
 * - Browser dashboard sends leaderboard_token cookie (automatic, no JS needed)
 * - CLI/debug can use ?token= query param
 */
function extractToken(req) {
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  if (req.query?.token) return req.query.token;
  const cookieHeader = req.headers['cookie'] || '';
  const match = cookieHeader.match(/(?:^|;\s*)leaderboard_token=([^\s;]+)/);
  return match ? match[1] : null;
}

/**
 * Extract Pomerium SSO identity from proxy-injected headers.
 * Returns { email, groups, user } or null.
 */
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
      } catch (e) { /* invalid JWT, ignore */ }
    }
  } else {
    groups = groups ? groups.split(',').map(g => g.trim()) : [];
  }

  if (!email) return null;
  if (typeof groups === 'string') groups = groups ? groups.split(',').map(g => g.trim()) : [];
  return { email, groups, user };
}

/**
 * Resolve the current user's identity from any available auth source.
 * Tries token first (covers browser cookie + extension header), then Pomerium.
 *
 * Returns { email, record?, source } or null if no auth found.
 *   - source: 'token' | 'pomerium'
 *   - record: auth_tokens DB row (only when source is 'token')
 */
async function resolveAuth(req) {
  // 1. Token auth (header, query, or cookie)
  const token = extractToken(req);
  if (token) {
    const record = auth.getByToken(token);
    if (record) return { email: record.email, record, source: 'token' };
    // Invalid token — don't fall through to Pomerium (avoids confused deputy)
    return null;
  }

  // 2. Pomerium SSO headers
  const identity = getPomeriumIdentity(req);
  if (identity) return { email: identity.email, source: 'pomerium' };

  return null;
}

// ============================================================
// Auth endpoints
// ============================================================

// GET /api/me — returns identity (email) from any auth source
app.get('/api/me', async (req, res) => {
  const identity = await resolveAuth(req);
  if (!identity) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ email: identity.email, source: identity.source });
});

// POST /api/auth/setup — create/return token and optionally claim a leaderboard user
// Requires auth (Pomerium for first-time, token for returning users)
app.post('/api/auth/setup', async (req, res) => {
  const identity = await resolveAuth(req);
  if (!identity) return res.status(401).json({ error: 'Authentication required.' });

  try {
    // If already authed via token, use that record; otherwise create one from email
    let record = identity.record || auth.getOrCreateToken(identity.email);

    const { userId, newUserName, newUserTeam } = req.body || {};

    if (userId) {
      const result = auth.claimUser(record.token, userId);
      if (result.error) return res.status(409).json(result);
      record.user_id = userId;
    } else if (newUserName) {
      const createRes = await worker.fetch(
        new Request(`http://localhost/api/users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newUserName, team: newUserTeam || 'NC' }),
        }),
        env
      );
      const created = await createRes.json();
      if (created.error) return res.status(createRes.status).json(created);

      const result = auth.claimUser(record.token, created.id);
      if (result.error) return res.status(409).json(result);
      record.user_id = created.id;
    }

    let userName = null;
    if (record.user_id) {
      const users = await kv.get('users', 'json') || [];
      const u = users.find(u => u.id === record.user_id);
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

// GET /api/auth/verify — verify a token, return associated user info
app.get('/api/auth/verify', async (req, res) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'No token provided.' });

  try {
    const record = auth.getByToken(token);
    if (!record) return res.status(401).json({ error: 'Invalid token.' });
    res.json({ email: record.email, userId: record.user_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/unlink — remove user mapping (keep token, clear user_id)
app.post('/api/auth/unlink', async (req, res) => {
  const identity = await resolveAuth(req);
  if (!identity) return res.status(401).json({ error: 'Authentication required.' });

  try {
    const record = identity.record || auth.getByEmail(identity.email);
    if (!record) return res.status(404).json({ error: 'No token found for this email.' });

    auth.unlinkUser(record.token);
    res.json({ ok: true, email: record.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/whoami — returns current user info for dashboard identification
app.get('/api/auth/whoami', async (req, res) => {
  try {
    const identity = await resolveAuth(req);
    if (!identity) return res.json({ userId: null });

    const record = identity.record || auth.getByEmail(identity.email);
    if (!record) return res.json({ userId: null, email: identity.email });

    if (record.user_id) {
      const users = await kv.get('users', 'json') || [];
      const u = users.find(u => u.id === record.user_id);
      return res.json({ userId: record.user_id, userName: u ? u.name : null, email: record.email });
    }

    res.json({ userId: null, email: record.email });
  } catch (err) {
    res.json({ userId: null });
  }
});

// GET /api/auth/unclaimed-users — list users not yet claimed by any token
app.get('/api/auth/unclaimed-users', async (req, res) => {
  const identity = await resolveAuth(req);
  if (!identity) return res.status(401).json({ error: 'Authentication required.' });

  try {
    const users = await kv.get('users', 'json') || [];
    const claimed = auth.getClaimedUserIds();
    const unclaimed = users.filter(u => !claimed.has(u.id));
    res.json(unclaimed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// All other API routes → worker fetch handler
// All write endpoints require token auth
// ============================================================

app.use('/api', async (req, res) => {
  try {
    const token = extractToken(req);
    const record = token ? auth.getByToken(token) : null;

    // POST /api/usage requires a valid token
    if (req.path === '/usage' && req.method === 'POST') {
      if (!record) {
        return res.status(401).json({ error: 'Valid token required. Get yours at /setup.html' });
      }
    } else if (token && !record) {
      return res.status(401).json({ error: 'Invalid token.' });
    }

    // Build a Web API Request from the Express request.
    // baseUrl + url, not originalUrl: originalUrl still carries BASE_PATH, and
    // the worker's router matches bare paths like '/api/data'.
    const url = `${req.protocol}://${req.get('host')}${req.baseUrl}${req.url}`;
    const headers = new Headers();
    for (const [key, val] of Object.entries(req.headers)) {
      if (val) headers.set(key, Array.isArray(val) ? val.join(', ') : val);
    }

    const init = { method: req.method, headers };
    if (!['GET', 'HEAD'].includes(req.method)) {
      // Read raw body for the worker to parse
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body = Buffer.concat(chunks);
      // express.json() may have consumed the body; re-serialize if needed
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

// Graceful shutdown
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down...`);
    server.close(() => {
      kv.quit();
      process.exit(0);
    });
  });
}
