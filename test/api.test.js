import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../server.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
let server, base, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medvault-test-'));
  // Every test signs in from the same address, so the per-IP attempt limit is raised.
  server = createServer({ dataDir, authAttemptLimit: 1000 });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
});

function client() {
  let cookie = '';
  return async (p, { method = 'GET', body, raw, headers = {}, csrf = true } = {}) => {
    const h = { ...headers };
    if (csrf) h['X-MedVault'] = '1';
    if (cookie) h.Cookie = cookie;
    if (body) h['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers: h, body: raw ?? (body && JSON.stringify(body)) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const isJson = (res.headers.get('content-type') || '').includes('json');
    return { status: res.status, headers: res.headers, data: isJson ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
}

const pageUrl = (rec, i = 0) => `/api/records/${rec.id}/pages/${rec.pages[i].id}/file`;
const sharedPageUrl = (token, rec, i = 0) => `/api/s/${token}/records/${rec.id}/pages/${rec.pages[i].id}/file`;
const meta = (m) => Buffer.from(JSON.stringify(m)).toString('base64url');

async function upload(call, title = 'Blood test', file = PDF) {
  return call('/api/records', {
    method: 'POST',
    raw: file,
    headers: { 'X-Record-Meta': meta({ title, category: 'Lab report', recordDate: '2026-09-01', fileName: 'cbc.pdf' }) },
  });
}

test('register, upload, read back and encrypt at rest', async () => {
  const call = client();
  const reg = await call('/api/auth/register', { method: 'POST', body: { name: 'Asha', email: 'asha@example.com', password: 'longpassword' } });
  assert.equal(reg.status, 201);

  const up = await upload(call);
  assert.equal(up.status, 201);
  assert.deepEqual(up.data.record.pages.map((p) => [p.id, p.mime]), [[up.data.record.id, 'application/pdf']]);

  const list = await call('/api/records');
  assert.equal(list.data.records.length, 1);

  const file = await call(pageUrl(up.data.record));
  assert.equal(file.status, 200);
  assert.deepEqual(file.data, PDF);

  const onDisk = fs.readFileSync(path.join(dataDir, 'files', `${up.data.record.id}.bin`));
  assert.ok(!onDisk.includes(Buffer.from('%PDF')), 'file must be encrypted on disk');
});

test('rejects unsupported files, missing CSRF header and anonymous access', async () => {
  const call = client();
  await call('/api/auth/register', { method: 'POST', body: { name: 'B', email: 'b@example.com', password: 'longpassword' } });
  const bad = await upload(call, 'script', Buffer.from('<script>alert(1)</script>'));
  assert.equal(bad.status, 415);

  const noCsrf = await call('/api/auth/logout', { method: 'POST', csrf: false });
  assert.equal(noCsrf.status, 403);

  const anon = await client()('/api/records');
  assert.equal(anon.status, 401);
});

test('users cannot see each other\'s records', async () => {
  const a = client();
  const b = client();
  await a('/api/auth/register', { method: 'POST', body: { name: 'A', email: 'a1@example.com', password: 'longpassword' } });
  await b('/api/auth/register', { method: 'POST', body: { name: 'B', email: 'b1@example.com', password: 'longpassword' } });
  const { data } = await upload(a);
  assert.equal((await b(pageUrl(data.record))).status, 404);
  assert.equal((await b(`/api/records/${data.record.id}`, { method: 'DELETE' })).status, 404);
});

test('share links expose only chosen records, log access and can be revoked', async () => {
  const call = client();
  await call('/api/auth/register', { method: 'POST', body: { name: 'Ravi', email: 'ravi@example.com', password: 'longpassword' } });
  await call('/api/me', { method: 'PUT', body: { name: 'Ravi', profile: { bloodGroup: 'O+', allergies: 'Penicillin' } } });
  const shared = (await upload(call, 'Shared')).data.record;
  const hidden = (await upload(call, 'Private')).data.record;

  const share = await call('/api/shares', { method: 'POST', body: { label: 'Dr. Rao', hours: 24, includeProfile: true, recordIds: [shared.id] } });
  assert.equal(share.status, 201);

  const doctor = client();
  const view = await doctor(`/api/s/${share.data.token}`);
  assert.equal(view.status, 200);
  assert.equal(view.data.profile.bloodGroup, 'O+');
  assert.deepEqual(view.data.records.map((r) => r.title), ['Shared']);

  assert.equal((await doctor(sharedPageUrl(share.data.token, shared))).status, 200);
  assert.equal((await doctor(sharedPageUrl(share.data.token, hidden))).status, 404);

  const log = await call('/api/access-log');
  assert.deepEqual(log.data.entries.map((e) => e.event), ['Viewed record', 'Opened shared link']);

  await call(`/api/shares/${share.data.id}`, { method: 'DELETE' });
  assert.equal((await doctor(`/api/s/${share.data.token}`)).status, 404);
  assert.equal((await doctor(sharedPageUrl(share.data.token, shared))).status, 404);
});

test('expired share links no longer open the share or its pages', async () => {
  const call = client();
  await call('/api/auth/register', { method: 'POST', body: { name: 'Exp', email: 'exp@example.com', password: 'longpassword' } });
  const rec = (await upload(call, 'Expiring')).data.record;
  const share = await call('/api/shares', { method: 'POST', body: { label: 'Dr. Late', hours: 1, includeProfile: false, recordIds: [rec.id] } });
  const doctor = client();
  assert.equal((await doctor(sharedPageUrl(share.data.token, rec))).status, 200);

  // Expiry is wall-clock based, so move it into the past through a second connection.
  const db = new DatabaseSync(path.join(dataDir, 'medvault.db'));
  try {
    db.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, share.data.id);
  } finally {
    db.close();
  }
  assert.equal((await doctor(`/api/s/${share.data.token}`)).status, 404);
  assert.equal((await doctor(sharedPageUrl(share.data.token, rec))).status, 404);
});

test('account deletion removes records and files', async () => {
  const call = client();
  await call('/api/auth/register', { method: 'POST', body: { name: 'D', email: 'd@example.com', password: 'longpassword' } });
  const { data } = await upload(call);
  assert.equal((await call('/api/me', { method: 'DELETE' })).status, 200);
  assert.ok(!fs.existsSync(path.join(dataDir, 'files', `${data.record.id}.bin`)));
  const relog = await client()('/api/auth/login', { method: 'POST', body: { email: 'd@example.com', password: 'longpassword' } });
  assert.equal(relog.status, 401);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-page')]);

async function signUp(email) {
  const call = client();
  await call('/api/auth/register', { method: 'POST', body: { name: email, email, password: 'longpassword' } });
  return call;
}

const appendPage = (call, rec, file = PNG, fileName = 'page.png') =>
  call(`/api/records/${rec.id}/pages`, { method: 'POST', raw: file, headers: { 'X-Page-Meta': meta({ fileName }) } });

test('pages can be appended in order and each serves its own bytes', async () => {
  const call = await signUp('pages1@example.com');
  const rec = (await upload(call)).data.record;
  const res = await appendPage(call, rec, PNG, 'second.png');
  assert.equal(res.status, 201);
  const pages = res.data.record.pages;
  assert.deepEqual(pages.map((p) => [p.fileName, p.mime]), [['cbc.pdf', 'application/pdf'], ['second.png', 'image/png']]);
  assert.deepEqual((await call(pageUrl(res.data.record, 0))).data, PDF);
  assert.deepEqual((await call(pageUrl(res.data.record, 1))).data, PNG);
});

test('a record holds at most 30 pages and rejects unsupported files', async () => {
  const call = await signUp('pages2@example.com');
  const rec = (await upload(call)).data.record;
  for (let i = 1; i < 30; i++) assert.equal((await appendPage(call, rec)).status, 201);
  const full = await appendPage(call, rec);
  assert.equal(full.status, 409);
  const list = (await call('/api/records')).data.records;
  assert.equal(list[0].pages.length, 30);

  const other = (await upload(call, 'Other')).data.record;
  assert.equal((await appendPage(call, other, Buffer.from('just text'))).status, 415);
  assert.equal((await call('/api/records')).data.records.find((r) => r.id === other.id).pages.length, 1);
});

test('pages can be deleted except the last one, and deleting a record removes every page file', async () => {
  const call = await signUp('pages3@example.com');
  const rec = (await appendPage(call, (await upload(call)).data.record)).data.record;
  const second = rec.pages[1];
  assert.equal((await call(`/api/records/${rec.id}/pages/${second.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!fs.existsSync(path.join(dataDir, 'files', `${second.id}.bin`)));
  const last = await call(`/api/records/${rec.id}/pages/${rec.pages[0].id}`, { method: 'DELETE' });
  assert.equal(last.status, 409);

  const two = (await appendPage(call, (await upload(call, 'Two pages')).data.record)).data.record;
  assert.equal((await call(`/api/records/${two.id}`, { method: 'DELETE' })).status, 200);
  for (const p of two.pages) assert.ok(!fs.existsSync(path.join(dataDir, 'files', `${p.id}.bin`)));
});

test('page routes are bound to the record and its owner', async () => {
  const a = await signUp('owner-a@example.com');
  const b = await signUp('owner-b@example.com');
  const aRec = (await appendPage(a, (await upload(a)).data.record)).data.record;
  const bRec = (await upload(b)).data.record;
  const aPage = aRec.pages[1];

  assert.equal((await appendPage(b, aRec)).status, 404);
  assert.equal((await b(pageUrl(aRec, 1))).status, 404);
  assert.equal((await b(`/api/records/${aRec.id}/pages/${aPage.id}`, { method: 'DELETE' })).status, 404);

  // B's own record id with A's page id must not reach A's page.
  assert.equal((await b(`/api/records/${bRec.id}/pages/${aPage.id}/file`)).status, 404);
  assert.equal((await b(`/api/records/${bRec.id}/pages/${aPage.id}/file?download=1`)).status, 404);
  assert.equal((await b(`/api/records/${bRec.id}/pages/${aPage.id}`, { method: 'DELETE' })).status, 404);
  assert.deepEqual((await a(pageUrl(aRec, 1))).data, PNG);
});

test('share links serve pages added after sharing, only for granted records, and log page views', async () => {
  const call = await signUp('share-pages@example.com');
  const shared = (await upload(call, 'Shared')).data.record;
  const hidden = (await appendPage(call, (await upload(call, 'Hidden')).data.record)).data.record;
  const share = await call('/api/shares', { method: 'POST', body: { label: 'Dr. Pages', hours: 24, recordIds: [shared.id] } });

  const grown = (await appendPage(call, shared)).data.record;
  const doctor = client();
  const view = await doctor(`/api/s/${share.data.token}`);
  assert.equal(view.data.records[0].pages.length, 2);
  assert.deepEqual((await doctor(sharedPageUrl(share.data.token, grown, 1))).data, PNG);

  assert.equal((await doctor(sharedPageUrl(share.data.token, hidden, 1))).status, 404);
  assert.equal((await doctor(`/api/s/${share.data.token}/records/${shared.id}/pages/${hidden.pages[1].id}/file`)).status, 404);

  const log = (await call('/api/access-log')).data.entries;
  assert.equal(log[0].event, 'Viewed record');
  assert.equal(log[0].record_title, 'Shared');
});

const changePassword = (call, currentPassword, newPassword) =>
  call('/api/me/password', { method: 'PUT', body: { currentPassword, newPassword } });
const login = (email, password) => client()('/api/auth/login', { method: 'POST', body: { email, password } });

test('changing the password ends other sessions and keeps this one', async () => {
  const email = 'rotate@example.com';
  const phone = await signUp(email);
  const laptop = client();
  assert.equal((await laptop('/api/auth/login', { method: 'POST', body: { email, password: 'longpassword' } })).status, 200);

  assert.equal((await changePassword(phone, 'longpassword', 'brand-new-pass')).status, 200);
  assert.equal((await login(email, 'longpassword')).status, 401);
  assert.equal((await login(email, 'brand-new-pass')).status, 200);
  assert.equal((await laptop('/api/records')).status, 401);
  assert.equal((await phone('/api/records')).status, 200);
});

test('a wrong current password or a short new one changes nothing', async () => {
  const email = 'rotate2@example.com';
  const call = await signUp(email);
  const wrong = await changePassword(call, 'not-my-password', 'brand-new-pass');
  assert.equal(wrong.status, 403);
  assert.equal((await changePassword(call, 'longpassword', 'short')).status, 400);
  assert.equal((await login(email, 'longpassword')).status, 200);
  assert.equal((await call('/api/records')).status, 200);
});
