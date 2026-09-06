#!/usr/bin/env node

/**
 * Copy leaderboard data between deployments over HTTP.
 *
 * Both ends speak the same /api/export and /api/import contract, so this works
 * regardless of what either side stores data in (KV, Postgres, SQLite).
 *
 * Usage:
 *   # Pull from a running instance to a local file
 *   node scripts/migrate.mjs export --from https://old.example.net --file export.json
 *
 *   # Push a file into an instance
 *   node scripts/migrate.mjs import --to http://localhost:3000 --file export.json
 *
 *   # One shot
 *   node scripts/migrate.mjs sync --from https://old.example.net --to http://localhost:3000
 *
 * Add --token <t> if the target requires one (see /setup.html).
 */

import { writeFileSync, readFileSync } from 'fs';

const args = process.argv.slice(2);
const command = args[0];

function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

function summarize(data) {
  console.log(`  Users:        ${data.users?.length || 0}`);
  console.log(`  Usage logs:   ${data.usageLogs?.length || 0}`);
  console.log(`  History logs: ${data.historyLogs?.length || 0}`);
  console.log(`  Weekly logs:  ${data.weeklyLogs?.length || 0}`);
  console.log(`  User configs: ${data.userConfigs?.length || 0}`);
}

async function exportFrom(baseUrl, token) {
  console.log(`Exporting from ${baseUrl}/api/export ...`);
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${baseUrl}/api/export`, { headers });
  if (!res.ok) throw new Error(`Export failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  summarize(data);
  return data;
}

async function importTo(data, baseUrl, token) {
  console.log(`Importing into ${baseUrl}/api/import ...`);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}/api/import`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Import failed: ${res.status} ${JSON.stringify(body)}`);
  console.log(`  Imported ${body.imported} users, ${body.total} total on target.`);
}

const token = getArg('token');
const file = getArg('file') || 'export.json';

try {
  if (command === 'export') {
    const from = getArg('from');
    if (!from) throw new Error('--from <url> is required');
    writeFileSync(file, JSON.stringify(await exportFrom(from, token), null, 2));
    console.log(`Wrote ${file}`);
  } else if (command === 'import') {
    const to = getArg('to');
    if (!to) throw new Error('--to <url> is required');
    await importTo(JSON.parse(readFileSync(file, 'utf-8')), to, token);
  } else if (command === 'sync') {
    const from = getArg('from');
    const to = getArg('to');
    if (!from || !to) throw new Error('--from <url> and --to <url> are both required');
    await importTo(await exportFrom(from, token), to, token);
  } else {
    console.error('Usage: migrate.mjs <export|import|sync> [--from url] [--to url] [--file f] [--token t]');
    process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
