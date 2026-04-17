#!/usr/bin/env node

import { createPgKV } from '../src/pg-kv.js';
import { runMigrations } from '../src/migrations/run.js';
import { syncCopilotUsage, syncCopilotUsageByOrgMembers } from '../src/copilot-sync.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/ai_leaderboard';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const SCOPE_TYPE = 'org';
const SCOPE_NAME = process.env.COPILOT_SCOPE_NAME || process.env.GITHUB_ORG || 'juspay';

function parseOptionalBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
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

async function main() {
  if (!SCOPE_NAME) {
    throw new Error('Missing COPILOT_SCOPE_NAME (or GITHUB_ORG).');
  }
  if (!GITHUB_TOKEN) {
    throw new Error('Missing GITHUB_TOKEN.');
  }

  const kv = await createPgKV(DATABASE_URL);
  try {
    await runMigrations(kv._pool);

    const today = getUtcDateParts();
    const filters = {
      year: parseOptionalInt(process.env.COPILOT_FILTER_YEAR) ?? today.year,
      month: parseOptionalInt(process.env.COPILOT_FILTER_MONTH) ?? today.month,
      day: parseOptionalInt(process.env.COPILOT_FILTER_DAY) ?? today.day,
      user: process.env.COPILOT_FILTER_USER || undefined,
      model: process.env.COPILOT_FILTER_MODEL || undefined,
      product: process.env.COPILOT_FILTER_PRODUCT || undefined,
    };
    const expandOrgUsers = parseOptionalBool(process.env.COPILOT_EXPAND_ORG_USERS, true);
    const concurrency = parseOptionalInt(process.env.COPILOT_CONCURRENCY) || 4;
    console.log(
      `[copilot-sync] script start: scopeType=${SCOPE_TYPE} scopeName=${SCOPE_NAME} expandOrgUsers=${expandOrgUsers} concurrency=${concurrency} filters=${JSON.stringify(filters)}`
    );

    const runPerUserOrgSync = SCOPE_TYPE === 'org' && !filters.user && expandOrgUsers;
    const result = runPerUserOrgSync
      ? await syncCopilotUsageByOrgMembers({
        pool: kv._pool,
        githubToken: GITHUB_TOKEN,
        org: SCOPE_NAME,
        filters,
        concurrency,
      })
      : await syncCopilotUsage({
        pool: kv._pool,
        githubToken: GITHUB_TOKEN,
        scopeType: SCOPE_TYPE,
        scopeName: SCOPE_NAME,
        filters,
      });

    console.log('[copilot-sync] script done');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await kv.quit();
  }
}

main().catch((error) => {
  console.error('Copilot sync failed:', error.message);
  process.exit(1);
});
