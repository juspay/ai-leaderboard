const GITHUB_API_BASE = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const PROVIDER = 'github_copilot';

function asNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function pick(obj, keys, fallback = undefined) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return fallback;
}

function normalizeScopeType(scopeType) {
  const normalized = String(scopeType || '').toLowerCase();
  if (!normalized || normalized === 'org') return 'org';
  throw new Error('scopeType must be "org"');
}

function buildUsageUrl(scopeType, scopeName, filters = {}) {
  void scopeType;
  const encodedScope = encodeURIComponent(scopeName);
  const path = `/organizations/${encodedScope}/settings/billing/premium_request/usage`;

  const url = new URL(path, GITHUB_API_BASE);
  for (const key of ['year', 'month', 'day', 'user', 'model', 'product']) {
    const value = filters[key];
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function fetchWithRetry(url, headers, maxAttempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) return response;

      const responseText = await response.text().catch(() => '');
      const retriable = response.status === 429 || response.status >= 500;
      if (!retriable || attempt === maxAttempts) {
        throw new Error(`GitHub API ${response.status}: ${responseText || response.statusText}`);
      }
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
    }

    const delayMs = 400 * Math.pow(2, attempt - 1);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw lastError || new Error('GitHub API request failed');
}

async function fetchGithubJson(url, headers) {
  const response = await fetchWithRetry(url, headers);
  const payload = await response.json();
  return { response, payload };
}

function parseLinkHeader(linkHeader) {
  const rels = {};
  if (!linkHeader) return rels;

  const parts = linkHeader.split(',');
  for (const part of parts) {
    const section = part.trim();
    const match = section.match(/^<([^>]+)>\s*;\s*rel="([^"]+)"$/);
    if (match) rels[match[2]] = match[1];
  }
  return rels;
}

export async function listOrganizationMembers({ githubToken, org, role = 'all' }) {
  if (!githubToken) throw new Error('githubToken is required');
  if (!org) throw new Error('org is required');

  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${githubToken}`,
    'X-GitHub-Api-Version': API_VERSION,
  };

  const members = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = new URL(`/orgs/${encodeURIComponent(org)}/members`, GITHUB_API_BASE);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));
    url.searchParams.set('role', role);

    console.log(`[copilot-sync] fetching org members page=${page} url=${url.toString()}`);
    const { response, payload } = await fetchGithubJson(url.toString(), headers);
    const rows = Array.isArray(payload) ? payload : [];

    for (const row of rows) {
      if (row?.login) members.push(String(row.login));
    }

    const links = parseLinkHeader(response.headers.get('link'));
    const hasNext = Boolean(links.next);
    if (!hasNext || rows.length === 0) break;
    page += 1;
  }

  const uniqueMembers = [...new Set(members)];
  console.log(`[copilot-sync] org members fetched: total=${uniqueMembers.length}`);
  return uniqueMembers;
}

export async function fetchCopilotUsageReport({ githubToken, scopeType, scopeName, filters = {} }) {
  if (!githubToken) throw new Error('githubToken is required');
  if (!scopeName) throw new Error('scopeName is required');

  const safeScopeType = normalizeScopeType(scopeType);
  const url = buildUsageUrl(safeScopeType, scopeName, filters);
  console.log(`[copilot-sync] requesting GitHub usage API: scopeType=${safeScopeType} scopeName=${scopeName} url=${url}`);
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${githubToken}`,
    'X-GitHub-Api-Version': API_VERSION,
  };

  const { payload } = await fetchGithubJson(url, headers);

  return { url, payload };
}

function normalizeUsageRows({ scopeType, scopeName, filters = {}, payload, fetchedAt }) {
  const timePeriod = pick(payload, ['timePeriod', 'time_period'], {}) || {};
  const usageItems = pick(payload, ['usageItems', 'usage_items'], []);
  const rows = Array.isArray(usageItems) ? usageItems : [];

  const periodYear = asInt(pick(timePeriod, ['year'], filters.year ?? new Date().getUTCFullYear()));
  const periodMonth = asInt(pick(timePeriod, ['month'], filters.month ?? 0));
  const periodDay = asInt(pick(timePeriod, ['day'], filters.day ?? 0));

  const resolvedScopeName = String(
    pick(payload, ['organization', 'org', 'user'], scopeName) || scopeName
  );

  return rows.map((item) => {
    const githubUsername = String(
      pick(item, ['user', 'username', 'githubUsername', 'github_username'], filters.user || '')
    );

    return {
      scope_type: scopeType,
      scope_name: resolvedScopeName,
      period_year: periodYear,
      period_month: periodMonth,
      period_day: periodDay,
      github_username: githubUsername,
      product: String(pick(item, ['product'], '') || ''),
      sku: String(pick(item, ['sku'], '') || ''),
      model: String(pick(item, ['model'], '') || ''),
      unit_type: String(pick(item, ['unitType', 'unit_type'], '') || ''),
      price_per_unit: asNumberOrNull(pick(item, ['pricePerUnit', 'price_per_unit'])),
      gross_quantity: asNumberOrNull(pick(item, ['grossQuantity', 'gross_quantity'])),
      gross_amount: asNumberOrNull(pick(item, ['grossAmount', 'gross_amount'])),
      discount_quantity: asNumberOrNull(pick(item, ['discountQuantity', 'discount_quantity'])),
      discount_amount: asNumberOrNull(pick(item, ['discountAmount', 'discount_amount'])),
      net_quantity: asNumberOrNull(pick(item, ['netQuantity', 'net_quantity'])),
      net_amount: asNumberOrNull(pick(item, ['netAmount', 'net_amount'])),
      fetched_at: fetchedAt,
      raw_payload: {
        timePeriod,
        scopeType,
        scopeName: resolvedScopeName,
        usageItem: item,
      },
    };
  });
}

export async function upsertCopilotRows(pool, rows) {
  let upserted = 0;

  for (const row of rows) {
    await pool.query(
      `INSERT INTO copilot_usage_snapshots (
        scope_type, scope_name, period_year, period_month, period_day,
        github_username, product, sku, model, unit_type,
        price_per_unit, gross_quantity, gross_amount,
        discount_quantity, discount_amount,
        net_quantity, net_amount, fetched_at, raw_payload
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13,
        $14, $15,
        $16, $17, $18, $19
      )
      ON CONFLICT (scope_type, scope_name, period_year, period_month, period_day, github_username, product, sku, model)
      DO UPDATE SET
        unit_type = EXCLUDED.unit_type,
        price_per_unit = EXCLUDED.price_per_unit,
        gross_quantity = EXCLUDED.gross_quantity,
        gross_amount = EXCLUDED.gross_amount,
        discount_quantity = EXCLUDED.discount_quantity,
        discount_amount = EXCLUDED.discount_amount,
        net_quantity = EXCLUDED.net_quantity,
        net_amount = EXCLUDED.net_amount,
        fetched_at = EXCLUDED.fetched_at,
        raw_payload = EXCLUDED.raw_payload`,
      [
        row.scope_type,
        row.scope_name,
        row.period_year,
        row.period_month,
        row.period_day,
        row.github_username,
        row.product,
        row.sku,
        row.model,
        row.unit_type,
        row.price_per_unit,
        row.gross_quantity,
        row.gross_amount,
        row.discount_quantity,
        row.discount_amount,
        row.net_quantity,
        row.net_amount,
        row.fetched_at,
        JSON.stringify(row.raw_payload),
      ]
    );
    upserted += 1;
  }

  return { upserted };
}

export async function syncCopilotUsage({ pool, githubToken, scopeType, scopeName, filters = {} }) {
  const normalizedScopeType = normalizeScopeType(scopeType);
  const fetchedAt = new Date().toISOString();
  console.log(`[copilot-sync] sync start: scopeType=${normalizedScopeType} scopeName=${scopeName} filters=${JSON.stringify(filters)}`);

  const { url, payload } = await fetchCopilotUsageReport({
    githubToken,
    scopeType: normalizedScopeType,
    scopeName,
    filters,
  });

  const rows = normalizeUsageRows({
    scopeType: normalizedScopeType,
    scopeName,
    filters,
    payload,
    fetchedAt,
  });
  console.log(`[copilot-sync] normalized rows: ${rows.length}`);

  const { upserted } = await upsertCopilotRows(pool, rows);
  console.log(`[copilot-sync] upsert complete: upserted=${upserted}`);

  return {
    ok: true,
    sourceUrl: url,
    scopeType: normalizedScopeType,
    scopeName,
    timePeriod: pick(payload, ['timePeriod', 'time_period'], null),
    fetched: rows.length,
    upserted,
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Number.parseInt(concurrency, 10) || 1);
  const results = new Array(items.length);
  let index = 0;

  async function runWorker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

export async function syncCopilotUsageByOrgMembers({
  pool,
  githubToken,
  org,
  filters = {},
  role = 'all',
  concurrency = 4,
}) {
  const members = await listOrganizationMembers({ githubToken, org, role });
  if (members.length === 0) {
    return {
      ok: true,
      scopeType: 'org',
      scopeName: org,
      usersProcessed: 0,
      fetched: 0,
      upserted: 0,
      details: [],
    };
  }

  console.log(`[copilot-sync] per-user org sync start: org=${org} users=${members.length} concurrency=${concurrency}`);
  const details = await mapWithConcurrency(members, concurrency, async (member) => {
    try {
      const result = await syncCopilotUsage({
        pool,
        githubToken,
        scopeType: 'org',
        scopeName: org,
        filters: { ...filters, user: member },
      });
      return {
        user: member,
        ok: true,
        fetched: result.fetched,
        upserted: result.upserted,
      };
    } catch (error) {
      console.error(`[copilot-sync] per-user sync failed: user=${member} error=${error.message}`);
      return {
        user: member,
        ok: false,
        error: error.message,
        fetched: 0,
        upserted: 0,
      };
    }
  });

  const fetched = details.reduce((sum, entry) => sum + (entry.fetched || 0), 0);
  const upserted = details.reduce((sum, entry) => sum + (entry.upserted || 0), 0);
  const failed = details.filter((entry) => !entry.ok).length;

  console.log(`[copilot-sync] per-user org sync done: users=${members.length} failed=${failed} fetched=${fetched} upserted=${upserted}`);
  return {
    ok: failed === 0,
    scopeType: 'org',
    scopeName: org,
    usersProcessed: members.length,
    usersFailed: failed,
    fetched,
    upserted,
    details,
  };
}

function buildFilters(filters = {}) {
  const where = [];
  const values = [];

  const push = (sql, value) => {
    values.push(value);
    where.push(`${sql} $${values.length}`);
  };

  if (filters.scopeType) push('scope_type =', String(filters.scopeType));
  if (filters.scopeName) push('scope_name =', String(filters.scopeName));
  if (filters.year !== undefined) push('period_year =', asInt(filters.year));
  if (filters.month !== undefined) push('period_month =', asInt(filters.month));
  if (filters.day !== undefined) push('period_day =', asInt(filters.day));
  if (filters.model) push('model =', String(filters.model));
  if (filters.product) push('product =', String(filters.product));
  if (filters.githubUsername) push('github_username =', String(filters.githubUsername));

  return {
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    values,
  };
}

export async function queryCopilotSummary(pool, filters = {}) {
  const { whereSql, values } = buildFilters(filters);

  const totalsResult = await pool.query(
    `SELECT
      COALESCE(SUM(gross_amount), 0) AS net_amount,
      COALESCE(SUM(gross_quantity), 0) AS net_quantity,
      COUNT(*)::int AS rows
     FROM copilot_usage_snapshots
     ${whereSql}`,
    values
  );

  const byPeriodResult = await pool.query(
    `SELECT
      period_year,
      period_month,
      period_day,
      COALESCE(SUM(gross_amount), 0) AS net_amount,
      COALESCE(SUM(gross_quantity), 0) AS net_quantity
     FROM copilot_usage_snapshots
     ${whereSql}
     GROUP BY period_year, period_month, period_day
     ORDER BY period_year DESC, period_month DESC, period_day DESC
     LIMIT 31`,
    values
  );

  const byModelResult = await pool.query(
    `SELECT
      model,
      COALESCE(SUM(gross_amount), 0) AS net_amount,
      COALESCE(SUM(gross_quantity), 0) AS net_quantity
     FROM copilot_usage_snapshots
     ${whereSql}
     GROUP BY model
     ORDER BY net_amount DESC`,
    values
  );

  const byProductResult = await pool.query(
    `SELECT
      product,
      COALESCE(SUM(gross_amount), 0) AS net_amount,
      COALESCE(SUM(gross_quantity), 0) AS net_quantity
     FROM copilot_usage_snapshots
     ${whereSql}
     GROUP BY product
     ORDER BY net_amount DESC`,
    values
  );

  return {
    filters,
    totals: totalsResult.rows[0] || { net_amount: '0', net_quantity: '0', rows: 0 },
    byPeriod: byPeriodResult.rows,
    byModel: byModelResult.rows,
    byProduct: byProductResult.rows,
  };
}

export async function autoLinkCopilotUsers(pool, kv, { org = null } = {}) {
  const emailMap = await kv.get('copilot:github_email_map', 'json');
  if (!emailMap || typeof emailMap !== 'object') {
    return { linked: 0, skipped: 0, error: 'No email map found in KV. Set copilot:github_email_map first.' };
  }

  const unlinked = await pool.query(
    `SELECT DISTINCT u.github_username
     FROM copilot_usage_snapshots u
     LEFT JOIN user_provider_identities idt
       ON idt.provider = $1 AND idt.external_username = u.github_username
     WHERE u.github_username <> ''
       AND idt.leaderboard_user_id IS NULL`,
    [PROVIDER]
  );

  let linked = 0;
  let skipped = 0;
  const details = [];

  for (const { github_username } of unlinked.rows) {
    const email = emailMap[github_username];
    if (!email) {
      skipped += 1;
      details.push({ github_username, status: 'skipped', reason: 'not in email map' });
      continue;
    }

    const tokenRow = await pool.query(
      `SELECT user_id FROM auth_tokens WHERE LOWER(email) = LOWER($1) AND user_id IS NOT NULL LIMIT 1`,
      [email]
    );
    if (!tokenRow.rows.length) {
      skipped += 1;
      details.push({ github_username, email, status: 'skipped', reason: 'no leaderboard account (not done /setup)' });
      continue;
    }

    const leaderboardUserId = tokenRow.rows[0].user_id;
    await upsertUserProviderIdentity(pool, { leaderboardUserId, externalUsername: github_username, externalOrg: org });
    console.log(`[copilot-sync] auto-linked: github=${github_username} email=${email} userId=${leaderboardUserId}`);
    linked += 1;
    details.push({ github_username, email, leaderboardUserId, status: 'linked' });
  }

  console.log(`[copilot-sync] auto-link done: linked=${linked} skipped=${skipped}`);
  return { linked, skipped, details };
}

export async function upsertUserProviderIdentity(pool, {
  leaderboardUserId,
  externalUsername,
  externalOrg = null,
  provider = PROVIDER,
}) {
  if (!leaderboardUserId) throw new Error('leaderboardUserId is required');
  if (!externalUsername) throw new Error('externalUsername is required');

  const result = await pool.query(
    `INSERT INTO user_provider_identities (
      leaderboard_user_id,
      provider,
      external_username,
      external_org,
      updated_at
    ) VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (leaderboard_user_id, provider)
    DO UPDATE SET
      external_username = EXCLUDED.external_username,
      external_org = EXCLUDED.external_org,
      updated_at = NOW()
    RETURNING leaderboard_user_id, provider, external_username, external_org, created_at, updated_at`,
    [String(leaderboardUserId), String(provider), String(externalUsername), externalOrg ? String(externalOrg) : null]
  );

  return result.rows[0];
}

export async function listCopilotUsers(pool, filters = {}) {
  const values = [PROVIDER];
  const where = [];

  if (filters.scopeType) {
    values.push(String(filters.scopeType));
    where.push(`u.scope_type = $${values.length}`);
  }
  if (filters.scopeName) {
    values.push(String(filters.scopeName));
    where.push(`u.scope_name = $${values.length}`);
  }
  if (filters.year !== undefined) {
    values.push(asInt(filters.year));
    where.push(`u.period_year = $${values.length}`);
  }
  if (filters.month !== undefined) {
    values.push(asInt(filters.month));
    where.push(`u.period_month = $${values.length}`);
  }
  if (filters.day !== undefined) {
    values.push(asInt(filters.day));
    where.push(`u.period_day = $${values.length}`);
  }

  const whereSql = where.length ? `AND ${where.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT
      u.github_username,
      SUM(COALESCE(u.gross_amount, 0)) AS net_amount,
      SUM(COALESCE(u.gross_quantity, 0)) AS net_quantity,
      MAX(u.fetched_at) AS last_fetched_at,
      idt.leaderboard_user_id,
      idt.external_org
     FROM copilot_usage_snapshots u
     LEFT JOIN user_provider_identities idt
       ON idt.provider = $1
      AND idt.external_username = u.github_username
     WHERE u.github_username <> ''
       ${whereSql}
     GROUP BY u.github_username, idt.leaderboard_user_id, idt.external_org
     ORDER BY net_amount DESC, u.github_username ASC`,
    values
  );

  return result.rows;
}

export const COPILOT_IDENTITY_PROVIDER = PROVIDER;
