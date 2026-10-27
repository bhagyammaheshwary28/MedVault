import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';

// Starts a server with the given hosting options; each test gets its own vault.
async function start(options) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medvault-hosting-'));
  const server = createServer({ dataDir, ...options });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (p, { method = 'GET', body, headers = {} } = {}) =>
    fetch(base + p, {
      method,
      headers: { 'X-MedVault': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body && JSON.stringify(body),
    });
  const stop = async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  };
  return { call, stop };
}

const register = (call, email, extra = {}) =>
  call('/api/auth/register', { method: 'POST', body: { name: 'Host Tester', email, password: 'longpassword', ...extra } });

test('a sign-up code, when configured, is required to create an account', async () => {
  const { call, stop } = await start({ signupCode: 'clinic-2026' });
  try {
    assert.equal((await (await call('/api/me')).json()).signupCodeRequired, true);
    assert.equal((await register(call, 'nocode@example.com')).status, 403);
    assert.equal((await register(call, 'wrong@example.com', { signupCode: 'guess' })).status, 403);
    assert.equal((await register(call, 'right@example.com', { signupCode: 'clinic-2026' })).status, 201);
    // Signing in never needs the code.
    const login = await call('/api/auth/login', { method: 'POST', body: { email: 'right@example.com', password: 'longpassword' } });
    assert.equal(login.status, 200);
  } finally {
    await stop();
  }
});

test('without a sign-up code anyone can register', async () => {
  const { call, stop } = await start({});
  try {
    assert.equal((await (await call('/api/me')).json()).signupCodeRequired, false);
    assert.equal((await register(call, 'open@example.com')).status, 201);
  } finally {
    await stop();
  }
});

test('behind a trusted proxy, each visitor gets their own sign-in attempt limit', async () => {
  const { call, stop } = await start({ trustProxy: true, authAttemptLimit: 2 });
  const attempt = (ip) =>
    call('/api/auth/login', {
      method: 'POST',
      body: { email: 'nobody@example.com', password: 'wrong-password' },
      headers: { 'X-Forwarded-For': `203.0.113.9, ${ip}` },
    });
  try {
    assert.equal((await attempt('198.51.100.1')).status, 401);
    assert.equal((await attempt('198.51.100.1')).status, 401);
    assert.equal((await attempt('198.51.100.1')).status, 429);
    // A different visitor behind the same proxy is not locked out by the first one.
    assert.equal((await attempt('198.51.100.2')).status, 401);
  } finally {
    await stop();
  }
});

test('without trusting a proxy, forwarded addresses are ignored', async () => {
  const { call, stop } = await start({ authAttemptLimit: 1 });
  const attempt = (ip) =>
    call('/api/auth/login', {
      method: 'POST',
      body: { email: 'nobody@example.com', password: 'wrong-password' },
      headers: { 'X-Forwarded-For': ip },
    });
  try {
    assert.equal((await attempt('198.51.100.1')).status, 401);
    // Spoofing a new X-Forwarded-For value must not reset the limit.
    assert.equal((await attempt('198.51.100.2')).status, 429);
  } finally {
    await stop();
  }
});

test('Clarity is off unless a project ID is configured', async () => {
  const { call, stop } = await start({});
  try {
    assert.equal((await (await call('/api/me')).json()).clarityProjectId, null);
    assert.doesNotMatch((await call('/')).headers.get('content-security-policy'), /clarity/);
  } finally {
    await stop();
  }
});

test('a Clarity project ID is shared with the page and allowed by its CSP', async () => {
  const { call, stop } = await start({ clarityProjectId: 'abc123xyz' });
  try {
    assert.equal((await (await call('/api/me')).json()).clarityProjectId, 'abc123xyz');
    const csp = (await call('/')).headers.get('content-security-policy');
    assert.match(csp, /script-src [^;]*https:\/\/\*\.clarity\.ms/);
    assert.match(csp, /connect-src 'self' https:\/\/\*\.clarity\.ms https:\/\/c\.bing\.com/);
    assert.match(csp, /img-src [^;]*https:\/\/c\.bing\.com/);
  } finally {
    await stop();
  }
});

test('a malformed Clarity project ID leaves analytics off', async () => {
  const { call, stop } = await start({ clarityProjectId: "x'; script-src *" });
  try {
    assert.equal((await (await call('/api/me')).json()).clarityProjectId, null);
    assert.doesNotMatch((await call('/')).headers.get('content-security-policy'), /clarity/);
  } finally {
    await stop();
  }
});

test('HTTPS deployments send HSTS and Secure session cookies', async () => {
  const { call, stop } = await start({ secureCookies: true });
  try {
    const home = await call('/');
    assert.match(home.headers.get('strict-transport-security') || '', /max-age=\d+/);
    const reg = await register(call, 'secure@example.com');
    assert.match(reg.headers.get('set-cookie'), /; Secure/);
  } finally {
    await stop();
  }
});

test('server.js reads its hosting settings from the environment, as the Dockerfile runs it', async () => {
  const { spawn } = await import('node:child_process');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medvault-entry-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: path.join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      MEDVAULT_DATA_DIR: dataDir,
      SECURE_COOKIES: '1',
      TRUST_PROXY: '1',
      MEDVAULT_SIGNUP_CODE: 'entry-code',
    },
  });
  try {
    const banner = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
        if (out.includes('MedVault running')) resolve(out);
      });
      child.on('exit', (code) => reject(new Error(`server exited early (${code}): ${out}`)));
      setTimeout(() => reject(new Error(`no start banner: ${out}`)), 10_000);
    });
    assert.ok(banner.includes(`(data in ${dataDir})`), banner);
    const me = await fetch(`http://127.0.0.1:${port}/api/me`);
    assert.equal((await me.json()).signupCodeRequired, true);
    assert.match(me.headers.get('strict-transport-security') || '', /max-age=/);
    assert.ok(fs.existsSync(path.join(dataDir, 'medvault.db')), 'the database lives in MEDVAULT_DATA_DIR');
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('with an origin secret, requests that skip Vercel are refused', async () => {
  const { call, stop } = await start({ originSecret: 'test-secret' });
  try {
    assert.equal((await call('/')).status, 403);
    assert.equal((await call('/api/me')).status, 403);
    assert.equal((await call('/api/me', { headers: { 'x-origin-secret': 'wrong' } })).status, 403);
    assert.equal((await call('/api/me', { headers: { 'x-origin-secret': 'test-secret' } })).status, 200);
  } finally {
    await stop();
  }
});

test('with an origin secret, each visitor behind Vercel gets their own sign-in attempt limit', async () => {
  const { call, stop } = await start({ originSecret: 'test-secret', authAttemptLimit: 1 });
  const attempt = (ip) =>
    call('/api/auth/login', {
      method: 'POST',
      body: { email: 'nobody@example.com', password: 'wrong-password' },
      headers: { 'x-origin-secret': 'test-secret', 'x-vercel-forwarded-for': ip },
    });
  try {
    assert.equal((await attempt('198.51.100.1')).status, 401);
    assert.equal((await attempt('198.51.100.1')).status, 429);
    assert.equal((await attempt('198.51.100.2')).status, 401);
  } finally {
    await stop();
  }
});
