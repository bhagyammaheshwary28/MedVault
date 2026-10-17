import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../server.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const LEGACY_COLUMNS = ['file_name', 'mime', 'size', 'iv', 'tag'];

// The schema MedVault shipped with before records could hold several pages.
const V0_SCHEMA = `
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL, profile TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
  CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL);
  CREATE TABLE records (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, category TEXT NOT NULL, record_date TEXT NOT NULL, provider TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '', file_name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
    iv TEXT NOT NULL, tag TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX records_user ON records(user_id, record_date DESC);
  CREATE TABLE shares (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, include_profile INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE share_records (share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, PRIMARY KEY (share_id, record_id));
  CREATE TABLE access_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    share_id TEXT, record_id TEXT, event TEXT NOT NULL, ip TEXT NOT NULL, at TEXT NOT NULL);
`;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Builds a data dir exactly as a pre-upgrade MedVault would have left it.
function makeV0Vault() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medvault-v0-'));
  fs.mkdirSync(path.join(dataDir, 'files'));
  const key = crypto.randomBytes(32);
  fs.writeFileSync(path.join(dataDir, 'secret.key'), key.toString('base64'));

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(PDF), cipher.final()]);
  const recordId = crypto.randomUUID();
  fs.writeFileSync(path.join(dataDir, 'files', `${recordId}.bin`), data);

  const salt = 'abcd';
  const db = new DatabaseSync(path.join(dataDir, 'medvault.db'));
  db.exec(V0_SCHEMA);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO users (id, email, name, pw_salt, pw_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('u1', 'old@example.com', 'Old', salt, crypto.scryptSync('longpassword', salt, 64).toString('hex'), now);
  db.prepare(`INSERT INTO records (id, user_id, title, category, record_date, file_name, mime, size, iv, tag, created_at)
    VALUES (?, 'u1', 'Old scan', 'Lab report', '2025-01-02', 'old.pdf', 'application/pdf', ?, ?, ?, ?)`)
    .run(recordId, PDF.length, iv.toString('hex'), cipher.getAuthTag().toString('hex'), now);
  const shareToken = 'legacy-share-token';
  db.prepare(`INSERT INTO shares (id, user_id, token_hash, label, include_profile, expires_at, created_at)
    VALUES ('s1', 'u1', ?, 'Dr. Old', 0, ?, ?)`).run(sha256(shareToken), Date.now() + 3_600_000, now);
  db.prepare("INSERT INTO share_records (share_id, record_id) VALUES ('s1', ?)").run(recordId);
  db.close();
  return { dataDir, recordId, shareToken };
}

async function start(dataDir) {
  const server = createServer({ dataDir });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  };
  return { base, stop };
}

function inspect(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'medvault.db'));
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const columns = db.prepare('PRAGMA table_info(records)').all().map((c) => c.name);
  const pages = db.prepare('SELECT * FROM pages').all();
  db.close();
  return { version, columns, pages };
}

async function login(base) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MedVault': '1' },
    body: JSON.stringify({ email: 'old@example.com', password: 'longpassword' }),
  });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

test('upgrades a version 0 vault: records become one-page records and stay readable and shared', async () => {
  const { dataDir, recordId, shareToken } = makeV0Vault();
  const { base, stop } = await start(dataDir);
  try {
    const cookie = await login(base);
    const { records } = await (await fetch(`${base}/api/records`, { headers: { Cookie: cookie } })).json();
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].pages.map((p) => [p.id, p.fileName, p.mime]), [[recordId, 'old.pdf', 'application/pdf']]);

    const own = await fetch(`${base}/api/records/${recordId}/pages/${recordId}/file`, { headers: { Cookie: cookie } });
    assert.equal(own.status, 200);
    assert.deepEqual(Buffer.from(await own.arrayBuffer()), PDF);

    const shared = await fetch(`${base}/api/s/${shareToken}/records/${recordId}/pages/${recordId}/file`);
    assert.equal(shared.status, 200);
    assert.deepEqual(Buffer.from(await shared.arrayBuffer()), PDF);
  } finally {
    await stop();
  }

  const after = inspect(dataDir);
  assert.equal(after.version, 1);
  for (const col of LEGACY_COLUMNS) assert.ok(!after.columns.includes(col), `records.${col} should be dropped`);

  const snapshot = new DatabaseSync(path.join(dataDir, 'medvault.pre-v1.db'));
  const snapCols = snapshot.prepare('PRAGMA table_info(records)').all().map((c) => c.name);
  assert.equal(snapshot.prepare('SELECT COUNT(*) AS n FROM records').get().n, 1);
  snapshot.close();
  for (const col of LEGACY_COLUMNS) assert.ok(snapCols.includes(col), `snapshot keeps records.${col}`);

  // A second start against the migrated vault changes nothing.
  const again = await start(dataDir);
  await again.stop();
  const second = inspect(dataDir);
  assert.equal(second.version, 1);
  assert.equal(second.pages.length, 1);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
});

test('a fresh vault starts at version 1 with no legacy columns and no snapshot', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medvault-fresh-'));
  const { stop } = await start(dataDir);
  await stop();
  const state = inspect(dataDir);
  assert.equal(state.version, 1);
  assert.equal(state.pages.length, 0);
  for (const col of LEGACY_COLUMNS) assert.ok(!state.columns.includes(col));
  assert.ok(!fs.existsSync(path.join(dataDir, 'medvault.pre-v1.db')));
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
});
