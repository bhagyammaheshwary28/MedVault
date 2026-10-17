import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createServer } from '../server.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-bytes')]);
let server, base, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medvault-export-'));
  server = createServer({ dataDir });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
});

async function signUp(email) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MedVault': '1' },
    body: JSON.stringify({ name: 'Export Tester', email, password: 'longpassword' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const meta = (m) => Buffer.from(JSON.stringify(m)).toString('base64url');
  const post = (url, body, header) =>
    fetch(base + url, { method: 'POST', headers: { Cookie: cookie, 'X-MedVault': '1', ...header }, body }).then((r) => r.json());
  return {
    cookie,
    record: (title, file, recordDate = '2026-09-01') =>
      post('/api/records', file, { 'X-Record-Meta': meta({ title, category: 'Lab report', recordDate, fileName: 'f' }) })
        .then((r) => r.record),
    page: (rec, file) => post(`/api/records/${rec.id}/pages`, file, { 'X-Page-Meta': meta({ fileName: 'p' }) }).then((r) => r.record),
    exportZip: () => fetch(`${base}/api/export`, { headers: { Cookie: cookie } }),
  };
}

// Reads a stored-method ZIP through its central directory, the way extractors do.
function readZip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'end of central directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory header');
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    assert.equal(buf.readUInt32LE(offset), 0x04034b50, `local header for ${name}`);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.subarray(start, start + size);
    entries.push({ name, crc, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test('export contains every page with matching bytes and CRCs, plus an index', async () => {
  const u = await signUp('export1@example.com');
  const one = await u.record('Blood test', PDF);
  const two = await u.page(await u.record('Chest X-ray', PNG, '2026-08-15'), PDF);

  const res = await u.exportZip();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="medvault-records-\d{4}-\d{2}-\d{2}\.zip"/);
  const entries = readZip(Buffer.from(await res.arrayBuffer()));

  assert.deepEqual(entries.map((e) => e.name).sort(), [
    '2026-08-15 Chest X-ray/page-1.png',
    '2026-08-15 Chest X-ray/page-2.pdf',
    '2026-09-01 Blood test/page-1.pdf',
    'index.html',
  ]);
  for (const e of entries) assert.equal(e.crc, zlib.crc32(e.data), `CRC of ${e.name}`);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e.data]));
  assert.deepEqual(byName['2026-09-01 Blood test/page-1.pdf'], PDF);
  assert.deepEqual(byName['2026-08-15 Chest X-ray/page-1.png'], PNG);
  assert.deepEqual(byName['2026-08-15 Chest X-ray/page-2.pdf'], PDF);

  const index = byName['index.html'].toString('utf8');
  assert.match(index, /Blood test/);
  assert.match(index, /href="2026-08-15%20Chest%20X-ray\/page-2\.pdf"/);
  assert.ok(one && two);
});

// The OS archive tool, not our own reader, decides whether the export really opens.
const bsdtar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const canUnzip = spawnSync(bsdtar, ['--version'], { encoding: 'utf8' }).stdout?.includes('bsdtar');

test('export extracts with the system archive tool', { skip: !canUnzip && 'bsdtar not available' }, async () => {
  const u = await signUp('export2@example.com');
  await u.page(await u.record('Prescription', PNG), PDF);
  const zipPath = path.join(dataDir, 'export2.zip');
  fs.writeFileSync(zipPath, Buffer.from(await (await u.exportZip()).arrayBuffer()));
  const out = fs.mkdtempSync(path.join(dataDir, 'x-'));
  const run = spawnSync(bsdtar, ['-xf', zipPath, '-C', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(fs.readFileSync(path.join(out, '2026-09-01 Prescription', 'page-1.png')), PNG);
  assert.deepEqual(fs.readFileSync(path.join(out, '2026-09-01 Prescription', 'page-2.pdf')), PDF);
  assert.ok(fs.existsSync(path.join(out, 'index.html')));
});

test('unsafe titles become safe, distinct folder names and escaped index text', async () => {
  const u = await signUp('export3@example.com');
  await u.record('../../<script>alert(1)</script>', PDF);
  await u.record('Blood Test.', PDF);
  await u.record('blood test', PDF);
  const entries = readZip(Buffer.from(await (await u.exportZip()).arrayBuffer()));
  const folders = entries.map((e) => e.name).filter((n) => n !== 'index.html').map((n) => n.split('/')[0]);

  for (const f of folders) {
    assert.ok(!/[\\:*?"<>|]/.test(f), `unsafe character in ${f}`);
    assert.ok(!/[. ]$/.test(f), `trailing dot or space in ${f}`);
  }
  // Windows treats names case-insensitively, so two records must never share a folder there.
  assert.equal(new Set(folders.map((f) => f.toLowerCase())).size, 3);
  for (const e of entries) assert.ok(!e.name.split('/').includes('..'), `traversal in ${e.name}`);

  const index = entries.find((e) => e.name === 'index.html').data.toString('utf8');
  assert.ok(!index.includes('<script>alert(1)'));
  assert.match(index, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('a vault with no records exports just the index', async () => {
  const u = await signUp('export4@example.com');
  const entries = readZip(Buffer.from(await (await u.exportZip()).arrayBuffer()));
  assert.deepEqual(entries.map((e) => e.name), ['index.html']);
});

test('export requires sign-in', async () => {
  assert.equal((await fetch(`${base}/api/export`)).status, 401);
});

test('a page that fails to decrypt mid-export aborts the download instead of ending it cleanly', async () => {
  const u = await signUp('export5@example.com');
  const rec = await u.page(await u.record('Will break', PDF), PNG);
  // The file still exists, so the pre-flight check passes, but its GCM tag no longer verifies.
  const broken = path.join(dataDir, 'files', `${rec.pages[1].id}.bin`);
  fs.writeFileSync(broken, Buffer.alloc(fs.statSync(broken).size, 7));

  // Depending on buffering the break lands before or after the status line; either way the
  // client must see a failed transfer, never a complete archive.
  await assert.rejects(async () => {
    const res = await u.exportZip();
    await res.arrayBuffer();
  });
});

test('an emoji at the folder-name length limit does not break the export', async () => {
  const u = await signUp('export6@example.com');
  await u.record(`${'a'.repeat(79)}😀 rest of a long title`, PDF);
  const res = await u.exportZip();
  assert.equal(res.status, 200);
  const names = readZip(Buffer.from(await res.arrayBuffer())).map((e) => e.name);
  const folder = names.find((n) => n !== 'index.html').split('/')[0];
  assert.ok(!/[\uD800-\uDFFF]/u.test(folder.normalize()), 'no lone surrogate in the folder name');
  assert.ok(folder.endsWith('😀'), 'the emoji is kept whole');
});
