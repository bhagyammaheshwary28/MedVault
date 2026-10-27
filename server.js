// MedVault server: a patient-owned vault for medical records.
// Zero dependencies: node:http, node:sqlite and node:crypto only.
// Files are encrypted at rest with AES-256-GCM before they touch disk.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { planExport, writeZip, ZIP_MAX_BYTES, ZIP_MAX_ENTRIES } from './export.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 30;
const MAX_JSON_BYTES = 64 * 1024;
const SESSION_DAYS = 7;
const SHARE_MAX_HOURS = 24 * 30;
const COOKIE = 'mv_session';

export const CATEGORIES = [
  'Lab report',
  'Prescription',
  'Imaging / Scan',
  'Discharge summary',
  'Consultation note',
  'Vaccination',
  'Insurance',
  'Other',
];

const PROFILE_FIELDS = [
  'dob',
  'bloodGroup',
  'allergies',
  'conditions',
  'medications',
  'emergencyContact',
];

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Microsoft Clarity's tag loads from and reports to *.clarity.ms, plus a c.bing.com pixel; allowed only when configured.
const CLARITY_HOSTS = ' https://*.clarity.ms https://c.bing.com';
const pageCsp = (clarity) => [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com" + (clarity ? ' https://*.clarity.ms' : ''),
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob:" + (clarity ? CLARITY_HOSTS : ''),
  "connect-src 'self'" + (clarity ? CLARITY_HOSTS : ''),
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- crypto helpers ----------

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expected) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex'));
}

function loadKey(dataDir) {
  if (process.env.MEDVAULT_KEY) {
    const key = Buffer.from(process.env.MEDVAULT_KEY, 'base64');
    if (key.length !== 32) throw new Error('MEDVAULT_KEY must be 32 bytes, base64-encoded');
    return key;
  }
  const keyFile = path.join(dataDir, 'secret.key');
  if (!fs.existsSync(keyFile)) {
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
}

function encrypt(key, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data };
}

function decrypt(key, iv, tag, data) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// Trust the bytes, not the browser: only formats we can render safely are accepted.
export function sniffMime(buf) {
  const head = (n) => buf.subarray(0, n);
  if (head(5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (head(8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (head(4).toString('latin1') === 'GIF8') return 'image/gif';
  if (head(4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// ---------- database ----------

function openDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'medvault.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      pw_salt TEXT NOT NULL,
      pw_hash TEXT NOT NULL,
      profile TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      record_date TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      iv TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS records_user ON records(user_id, record_date DESC);
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      include_profile INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS share_records (
      share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      PRIMARY KEY (share_id, record_id)
    );
    CREATE TABLE IF NOT EXISTS access_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      share_id TEXT,
      record_id TEXT,
      event TEXT NOT NULL,
      ip TEXT NOT NULL,
      at TEXT NOT NULL
    );
  `);
  migrate(db, dataDir);
  return db;
}

// Schema upgrades, keyed on PRAGMA user_version. The CREATE statements above are version 0.
const MIGRATIONS = [
  {
    // Version 1: a record is made of ordered pages. Each record's existing file becomes page 0,
    // reusing the record id so files/<record id>.bin keeps working without re-encryption.
    version: 1,
    destructive: true,
    sql: `
      CREATE TABLE pages (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        iv TEXT NOT NULL,
        tag TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX pages_record ON pages(record_id, position);
      INSERT INTO pages (id, record_id, position, file_name, mime, size, iv, tag, created_at)
        SELECT id, id, 0, file_name, mime, size, iv, tag, created_at FROM records;
      ALTER TABLE records DROP COLUMN file_name;
      ALTER TABLE records DROP COLUMN mime;
      ALTER TABLE records DROP COLUMN size;
      ALTER TABLE records DROP COLUMN iv;
      ALTER TABLE records DROP COLUMN tag;
    `,
  },
];

function migrate(db, dataDir) {
  for (const m of MIGRATIONS) {
    if (db.prepare('PRAGMA user_version').get().user_version >= m.version) continue;
    const snapshot = path.join(dataDir, `medvault.pre-v${m.version}.db`);
    const hasRecords = db.prepare('SELECT COUNT(*) AS n FROM records').get().n > 0;
    if (m.destructive && hasRecords && !fs.existsSync(snapshot)) {
      db.prepare('VACUUM INTO ?').run(snapshot);
    }
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

// ---------- http helpers ----------

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

const json = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) {
        reject(new HttpError(413, `File is too large (max ${Math.round(limit / 1024 / 1024)} MB)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req, MAX_JSON_BYTES);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const str = (v, max, field, { required = false } = {}) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} is too long`);
  return s;
};

// Upload metadata travels as base64url JSON in a header because the body carries the raw file.
function decodeMeta(header) {
  try {
    const meta = JSON.parse(Buffer.from(String(header || ''), 'base64url').toString('utf8'));
    if (meta && typeof meta === 'object') return meta;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'Missing upload details');
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const nowIso = () => new Date().toISOString();

// ---------- app ----------

export function createServer({
  dataDir = path.join(HERE, 'data'),
  secureCookies = false,
  authAttemptLimit = 20,
  trustProxy = false,
  signupCode = '',
  originSecret = '',
  clarityProjectId = '',
} = {}) {
  // Clarity project IDs are short alphanumeric codes; anything else is a typo, so analytics stay off.
  const clarityId = /^[a-z0-9]{1,32}$/i.test(clarityProjectId) ? clarityProjectId : null;
  if (clarityProjectId && !clarityId) console.warn('Ignoring CLARITY_PROJECT_ID: expected a short alphanumeric code.');
  const PAGE_CSP = pageCsp(!!clarityId);
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
  const db = openDb(dataDir);
  const key = loadKey(dataDir);
  const filePath = (id) => path.join(dataDir, 'files', `${id}.bin`);

  // Behind one trusted proxy (as on Railway) the socket is the proxy, and the visitor's address is
  // the entry that proxy appended last. Without a proxy the header is client-controlled, so ignore it.
  const clientIp = (req) => {
    // Behind Vercel, Railway sees Vercel as the visitor. Vercel passes the real address in its own
    // headers, which can be trusted here because every request has already shown the origin secret.
    if (originSecret) {
      const hops = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '');
      const visitor = hops.split(',')[0].trim();
      if (visitor) return visitor;
    }
    if (trustProxy) {
      const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((h) => h.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
  };

  // Simple per-IP throttle for sign-in attempts.
  const attempts = new Map();
  function throttle(ip) {
    const now = Date.now();
    const a = attempts.get(ip) || { count: 0, reset: now + 15 * 60_000 };
    if (now > a.reset) Object.assign(a, { count: 0, reset: now + 15 * 60_000 });
    a.count += 1;
    attempts.set(ip, a);
    if (a.count > authAttemptLimit) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  }

  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare(
      'INSERT INTO users (id, email, name, pw_salt, pw_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    updateProfile: db.prepare('UPDATE users SET name = ?, profile = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    session: db.prepare(
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
    ),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    updatePassword: db.prepare('UPDATE users SET pw_salt = ?, pw_hash = ? WHERE id = ?'),
    records: db.prepare('SELECT * FROM records WHERE user_id = ? ORDER BY record_date DESC, created_at DESC'),
    record: db.prepare('SELECT * FROM records WHERE id = ? AND user_id = ?'),
    insertRecord: db.prepare(`INSERT INTO records
      (id, user_id, title, category, record_date, provider, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    pages: db.prepare('SELECT * FROM pages WHERE record_id = ? ORDER BY position'),
    insertPage: db.prepare(`INSERT INTO pages
      (id, record_id, position, file_name, mime, size, iv, tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    deletePage: db.prepare('DELETE FROM pages WHERE id = ?'),
    ownPage: db.prepare(`SELECT p.* FROM pages p JOIN records r ON r.id = p.record_id
      WHERE p.id = ? AND p.record_id = ? AND r.user_id = ?`),
    sharedPage: db.prepare(`SELECT p.* FROM pages p JOIN share_records sr ON sr.record_id = p.record_id
      WHERE sr.share_id = ? AND p.record_id = ? AND p.id = ?`),
    pageIdsForUser: db.prepare('SELECT p.id FROM pages p JOIN records r ON r.id = p.record_id WHERE r.user_id = ?'),
    updateRecord: db.prepare(
      'UPDATE records SET title = ?, category = ?, record_date = ?, provider = ?, notes = ? WHERE id = ? AND user_id = ?',
    ),
    deleteRecord: db.prepare('DELETE FROM records WHERE id = ? AND user_id = ?'),
    shares: db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM share_records sr WHERE sr.share_id = s.id) AS record_count
      FROM shares s WHERE s.user_id = ? ORDER BY s.created_at DESC`),
    shareByToken: db.prepare('SELECT * FROM shares WHERE token_hash = ?'),
    insertShare: db.prepare(`INSERT INTO shares
      (id, user_id, token_hash, label, include_profile, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    insertShareRecord: db.prepare('INSERT INTO share_records (share_id, record_id) VALUES (?, ?)'),
    revokeShare: db.prepare('UPDATE shares SET revoked = 1 WHERE id = ? AND user_id = ?'),
    sharedRecords: db.prepare(`SELECT r.* FROM records r JOIN share_records sr ON sr.record_id = r.id
      WHERE sr.share_id = ? ORDER BY r.record_date DESC`),
    log: db.prepare(
      'INSERT INTO access_log (user_id, share_id, record_id, event, ip, at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    accessLog: db.prepare(`SELECT a.event, a.ip, a.at, s.label AS share_label, r.title AS record_title
      FROM access_log a
      LEFT JOIN shares s ON s.id = a.share_id
      LEFT JOIN records r ON r.id = a.record_id
      WHERE a.user_id = ? ORDER BY a.id DESC LIMIT 200`),
  };

  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, profile: JSON.parse(u.profile) });
  const publicRecord = (r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    recordDate: r.record_date,
    provider: r.provider,
    notes: r.notes,
    createdAt: r.created_at,
    pages: q.pages.all(r.id).map((p) => ({ id: p.id, fileName: p.file_name, mime: p.mime, size: p.size })),
  });

  function startSession(res, userId) {
    const token = newToken();
    const expires = Date.now() + SESSION_DAYS * 86_400_000;
    q.insertSession.run(sha256(token), userId, expires);
    const secure = secureCookies ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`,
    );
  }

  function currentUser(req) {
    const token = parseCookies(req)[COOKIE];
    return token ? q.session.get(sha256(token), Date.now()) : undefined;
  }

  function requireUser(req) {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'Please sign in');
    return user;
  }

  function sendFile(res, page, { download }) {
    const plain = decrypt(key, page.iv, page.tag, fs.readFileSync(filePath(page.id)));
    const safeName = page.file_name.replace(/[^\w.\- ]+/g, '_');
    send(res, 200, plain, {
      'Content-Type': page.mime,
      'Content-Length': plain.length,
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${safeName}"`,
      // Uploaded content never runs scripts; PDFs need an unsandboxed frame for the built-in viewer.
      'Content-Security-Policy':
        page.mime === 'application/pdf' ? "default-src 'none'; frame-ancestors 'self'" : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'",
      'X-Frame-Options': 'SAMEORIGIN',
    });
  }

  // Reads one uploaded page from the request body; the bytes decide the type, not the browser.
  async function readPage(req) {
    const data = await readBody(req, MAX_UPLOAD_BYTES);
    if (!data.length) throw new HttpError(400, 'The file is empty');
    const mime = sniffMime(data);
    if (!mime) throw new HttpError(415, 'Only PDF, JPG, PNG, WEBP and GIF files are supported');
    return { data, mime };
  }

  function storePage(recordId, pageId, position, fileName, { data, mime }) {
    const enc = encrypt(key, data);
    fs.writeFileSync(filePath(pageId), enc.data);
    q.insertPage.run(pageId, recordId, position, fileName, mime, data.length, enc.iv, enc.tag, nowIso());
  }

  function liveShare(token) {
    const share = q.shareByToken.get(sha256(token));
    if (!share || share.revoked || share.expires_at < Date.now()) {
      throw new HttpError(404, 'This link has expired or been revoked');
    }
    return share;
  }

  // ---------- routes ----------

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$',
    );
    routes.push({ method, re, keys, handler });
  };

  route('POST', '/api/auth/register', async (req, res) => {
    throttle(clientIp(req));
    const body = await readJson(req);
    const name = str(body.name, 100, 'Name', { required: true });
    const email = str(body.email, 200, 'Email', { required: true }).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    if (signupCode && sha256(String(body.signupCode ?? '')) !== sha256(signupCode)) {
      throw new HttpError(403, 'A valid sign-up code is required to create an account');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    if (q.userByEmail.get(email)) throw new HttpError(409, 'An account with this email already exists');
    const id = crypto.randomUUID();
    const { salt, hash } = hashPassword(password);
    q.insertUser.run(id, email, name, salt, hash, nowIso());
    startSession(res, id);
    json(res, 201, { user: publicUser(q.userById.get(id)) });
  });

  route('POST', '/api/auth/login', async (req, res) => {
    throttle(clientIp(req));
    const body = await readJson(req);
    const email = str(body.email, 200, 'Email').toLowerCase();
    const user = q.userByEmail.get(email);
    if (!user || !verifyPassword(String(body.password || ''), user.pw_salt, user.pw_hash)) {
      throw new HttpError(401, 'Email or password is incorrect');
    }
    startSession(res, user.id);
    json(res, 200, { user: publicUser(user) });
  });

  route('POST', '/api/auth/logout', async (req, res) => {
    const token = parseCookies(req)[COOKIE];
    if (token) q.deleteSession.run(sha256(token));
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    json(res, 200, { ok: true });
  });

  route('GET', '/api/me', async (req, res) => {
    const user = currentUser(req);
    json(res, 200, { user: user ? publicUser(user) : null, categories: CATEGORIES, signupCodeRequired: !!signupCode, clarityProjectId: clarityId });
  });

  route('PUT', '/api/me', async (req, res) => {
    const user = requireUser(req);
    const body = await readJson(req);
    const name = str(body.name, 100, 'Name', { required: true });
    const profile = {};
    for (const f of PROFILE_FIELDS) profile[f] = str(body.profile?.[f], 1000, f);
    if (profile.dob && !isDate(profile.dob)) throw new HttpError(400, 'Date of birth is invalid');
    q.updateProfile.run(name, JSON.stringify(profile), user.id);
    json(res, 200, { user: publicUser(q.userById.get(user.id)) });
  });

  // A wrong current password is 403, not 401: the page treats 401 as "signed out".
  route('PUT', '/api/me/password', async (req, res) => {
    throttle(clientIp(req));
    const user = requireUser(req);
    const body = await readJson(req);
    if (!verifyPassword(String(body.currentPassword || ''), user.pw_salt, user.pw_hash)) {
      throw new HttpError(403, 'Your current password is incorrect');
    }
    const next = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (next.length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
    const { salt, hash } = hashPassword(next);
    q.updatePassword.run(salt, hash, user.id);
    q.deleteOtherSessions.run(user.id, sha256(parseCookies(req)[COOKIE]));
    json(res, 200, { ok: true });
  });

  route('DELETE', '/api/me', async (req, res) => {
    const user = requireUser(req);
    const pageIds = q.pageIdsForUser.all(user.id).map((p) => p.id);
    q.deleteUser.run(user.id);
    for (const id of pageIds) fs.rmSync(filePath(id), { force: true });
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    json(res, 200, { ok: true });
  });

  route('GET', '/api/records', async (req, res) => {
    const user = requireUser(req);
    json(res, 200, { records: q.records.all(user.id).map(publicRecord) });
  });

  // Upload: raw file bytes in the body, metadata as base64url JSON in X-Record-Meta.
  route('POST', '/api/records', async (req, res) => {
    const user = requireUser(req);
    const meta = decodeMeta(req.headers['x-record-meta']);
    const title = str(meta.title, 200, 'Title', { required: true });
    const category = CATEGORIES.includes(meta.category) ? meta.category : 'Other';
    const recordDate = str(meta.recordDate, 10, 'Date', { required: true });
    if (!isDate(recordDate)) throw new HttpError(400, 'Date is invalid');
    const provider = str(meta.provider, 200, 'Doctor / hospital');
    const notes = str(meta.notes, 2000, 'Notes');
    const fileName = str(meta.fileName, 200, 'File name') || 'record';
    const upload = await readPage(req);

    // The first page reuses the record id, so files/<record id>.bin always holds page one.
    const id = crypto.randomUUID();
    db.exec('BEGIN');
    try {
      q.insertRecord.run(id, user.id, title, category, recordDate, provider, notes, nowIso());
      storePage(id, id, 0, fileName, upload);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      fs.rmSync(filePath(id), { force: true });
      throw e;
    }
    json(res, 201, { record: publicRecord(q.record.get(id, user.id)) });
  });

  route('PATCH', '/api/records/:id', async (req, res, p) => {
    const user = requireUser(req);
    const rec = q.record.get(p.id, user.id);
    if (!rec) throw new HttpError(404, 'Record not found');
    const body = await readJson(req);
    const title = str(body.title, 200, 'Title', { required: true });
    const category = CATEGORIES.includes(body.category) ? body.category : rec.category;
    const recordDate = str(body.recordDate, 10, 'Date', { required: true });
    if (!isDate(recordDate)) throw new HttpError(400, 'Date is invalid');
    q.updateRecord.run(
      title, category, recordDate, str(body.provider, 200, 'Doctor / hospital'),
      str(body.notes, 2000, 'Notes'), rec.id, user.id,
    );
    json(res, 200, { record: publicRecord(q.record.get(rec.id, user.id)) });
  });

  route('DELETE', '/api/records/:id', async (req, res, p) => {
    const user = requireUser(req);
    const rec = q.record.get(p.id, user.id);
    if (!rec) throw new HttpError(404, 'Record not found');
    const pageIds = q.pages.all(rec.id).map((pg) => pg.id);
    q.deleteRecord.run(rec.id, user.id);
    for (const id of pageIds) fs.rmSync(filePath(id), { force: true });
    json(res, 200, { ok: true });
  });

  // Append a page: raw file bytes in the body, { fileName } as base64url JSON in X-Page-Meta.
  route('POST', '/api/records/:id/pages', async (req, res, p) => {
    const user = requireUser(req);
    const rec = q.record.get(p.id, user.id);
    if (!rec) throw new HttpError(404, 'Record not found');
    const meta = decodeMeta(req.headers['x-page-meta']);
    const fileName = str(meta.fileName, 200, 'File name') || 'page';
    const existing = q.pages.all(rec.id);
    if (existing.length >= MAX_PAGES) throw new HttpError(409, `A record can hold at most ${MAX_PAGES} pages`);
    const upload = await readPage(req);
    const position = existing[existing.length - 1].position + 1;
    storePage(rec.id, crypto.randomUUID(), position, fileName, upload);
    json(res, 201, { record: publicRecord(rec) });
  });

  route('DELETE', '/api/records/:id/pages/:pageId', async (req, res, p) => {
    const user = requireUser(req);
    const page = q.ownPage.get(p.pageId, p.id, user.id);
    if (!page) throw new HttpError(404, 'Page not found');
    if (q.pages.all(page.record_id).length === 1) {
      throw new HttpError(409, 'A record needs at least one page. Delete the record instead.');
    }
    q.deletePage.run(page.id);
    fs.rmSync(filePath(page.id), { force: true });
    json(res, 200, { record: publicRecord(q.record.get(page.record_id, user.id)) });
  });

  // A page is served only when it belongs to the record in the path and that record to the caller.
  route('GET', '/api/records/:id/pages/:pageId/file', async (req, res, p, url) => {
    const user = requireUser(req);
    const page = q.ownPage.get(p.pageId, p.id, user.id);
    if (!page) throw new HttpError(404, 'Page not found');
    sendFile(res, page, { download: url.searchParams.has('download') });
  });

  route('GET', '/api/export', async (req, res) => {
    const user = requireUser(req);
    const records = q.records.all(user.id).map(publicRecord);
    const plan = planExport({ patient: user.name, profile: JSON.parse(user.profile), records, exportedAt: nowIso() });
    const entries = [{ name: 'index.html', data: plan.index }, ...plan.files];

    // Refuse before sending anything when the archive can't be written correctly.
    const bytes = entries.reduce((n, e) => n + (e.data?.length ?? e.page.size) + 2 * Buffer.byteLength(e.name) + 76, 22);
    if (entries.length > ZIP_MAX_ENTRIES || bytes > ZIP_MAX_BYTES) {
      throw new HttpError(413, 'Your vault is too large to export as one ZIP file (the limit is 4 GB).');
    }
    const missing = plan.files.find((f) => !fs.existsSync(filePath(f.page.id)));
    if (missing) throw new Error(`Export stopped: stored file for page ${missing.page.id} is missing`);

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="medvault-records-${nowIso().slice(0, 10)}.zip"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    try {
      await writeZip(res, entries, (e) => {
        if (e.data) return e.data;
        const page = q.ownPage.get(e.page.id, e.record.id, user.id);
        return decrypt(key, page.iv, page.tag, fs.readFileSync(filePath(page.id)));
      });
      res.end();
    } catch (err) {
      // Headers are already sent: break the connection so the browser reports a failed
      // download, rather than ending cleanly with a truncated archive.
      console.error('Export aborted:', err.message);
      res.destroy();
    }
  });

  route('GET', '/api/shares', async (req, res) => {
    const user = requireUser(req);
    const shares = q.shares.all(user.id).map((s) => ({
      id: s.id,
      label: s.label,
      includeProfile: !!s.include_profile,
      recordCount: s.record_count,
      expiresAt: new Date(s.expires_at).toISOString(),
      status: s.revoked ? 'revoked' : s.expires_at < Date.now() ? 'expired' : 'active',
      createdAt: s.created_at,
    }));
    json(res, 200, { shares });
  });

  route('POST', '/api/shares', async (req, res) => {
    const user = requireUser(req);
    const body = await readJson(req);
    const label = str(body.label, 100, 'Label', { required: true });
    const hours = Number(body.hours);
    if (!Number.isFinite(hours) || hours < 1 || hours > SHARE_MAX_HOURS) {
      throw new HttpError(400, 'Choose how long the link stays valid');
    }
    const ids = Array.isArray(body.recordIds) ? [...new Set(body.recordIds.map(String))] : [];
    const owned = ids.filter((id) => q.record.get(id, user.id));
    if (!owned.length && !body.includeProfile) {
      throw new HttpError(400, 'Pick at least one record or include your health summary');
    }
    const id = crypto.randomUUID();
    const token = newToken();
    const expires = Date.now() + hours * 3_600_000;
    db.exec('BEGIN');
    try {
      q.insertShare.run(id, user.id, sha256(token), label, body.includeProfile ? 1 : 0, expires, nowIso());
      for (const rid of owned) q.insertShareRecord.run(id, rid);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    // The raw token is only ever returned here; the database stores its hash.
    json(res, 201, { id, token, path: `/s/${token}`, expiresAt: new Date(expires).toISOString() });
  });

  route('DELETE', '/api/shares/:id', async (req, res, p) => {
    const user = requireUser(req);
    q.revokeShare.run(p.id, user.id);
    json(res, 200, { ok: true });
  });

  route('GET', '/api/access-log', async (req, res) => {
    const user = requireUser(req);
    json(res, 200, { entries: q.accessLog.all(user.id) });
  });

  // ---------- public, link-based access for doctors ----------

  route('GET', '/api/s/:token', async (req, res, p) => {
    const share = liveShare(p.token);
    const owner = q.userById.get(share.user_id);
    q.log.run(owner.id, share.id, null, 'Opened shared link', clientIp(req), nowIso());
    json(res, 200, {
      patient: owner.name,
      label: share.label,
      expiresAt: new Date(share.expires_at).toISOString(),
      profile: share.include_profile ? JSON.parse(owner.profile) : null,
      records: q.sharedRecords.all(share.id).map(publicRecord),
    });
  });

  route('GET', '/api/s/:token/records/:id/pages/:pageId/file', async (req, res, p, url) => {
    const share = liveShare(p.token);
    const page = q.sharedPage.get(share.id, p.id, p.pageId);
    if (!page) throw new HttpError(404, 'Page not found');
    const download = url.searchParams.has('download');
    q.log.run(share.user_id, share.id, page.record_id, download ? 'Downloaded record' : 'Viewed record', clientIp(req), nowIso());
    sendFile(res, page, { download });
  });

  // ---------- static ----------

  function serveStatic(res, rel) {
    const full = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return false;
    }
    const ext = path.extname(full);
    const headers = { 'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    if (ext === '.html') {
      headers['Content-Security-Policy'] = PAGE_CSP;
      headers['X-Frame-Options'] = 'DENY';
    }
    res.writeHead(200, { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
    res.end(fs.readFileSync(full));
    return true;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      // CSRF guard: state-changing calls must come from our own scripts.
      if (req.method !== 'GET' && req.headers['x-medvault'] !== '1') {
        throw new HttpError(403, 'Forbidden');
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        return r.handler(req, res, params, url);
      }
      throw new HttpError(404, 'Not found');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    if (pathname.startsWith('/s/')) return serveStatic(res, 'share.html');
    if (pathname !== '/' && serveStatic(res, pathname.slice(1))) return;
    serveStatic(res, 'index.html');
  }

  const server = http.createServer((req, res) => {
    if (secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    // Behind Vercel, refuse requests that skipped it and came to the Railway address directly.
    if (originSecret && sha256(String(req.headers['x-origin-secret'] || '')) !== sha256(originSecret)) {
      return json(res, 403, { error: 'Forbidden' });
    }
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Something went wrong' : err.message });
      else res.end();
    });
  });
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 4000;
  const dataDir = process.env.MEDVAULT_DATA_DIR || path.join(HERE, 'data');
  const server = createServer({
    dataDir,
    secureCookies: process.env.SECURE_COOKIES === '1',
    trustProxy: process.env.TRUST_PROXY === '1',
    signupCode: process.env.MEDVAULT_SIGNUP_CODE || '',
    originSecret: process.env.MEDVAULT_ORIGIN_SECRET || '',
    clarityProjectId: process.env.CLARITY_PROJECT_ID || '',
  }).listen(port, () => {
    console.log(`MedVault running at http://localhost:${port} (data in ${dataDir})`);
  });
  // Hosts stop the app with SIGTERM on every redeploy; close cleanly so SQLite checkpoints its WAL.
  process.on('SIGTERM', () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
  // Upgrade snapshots hold every patient's data and outlive account deletion, so keep nagging until they're gone.
  for (const m of MIGRATIONS) {
    const snapshot = path.join(dataDir, `medvault.pre-v${m.version}.db`);
    if (fs.existsSync(snapshot)) {
      console.warn(`Warning: ${snapshot} is a full copy of the database from before an upgrade. ` +
        'Delete it once you have checked the upgraded vault works.');
    }
  }
}
