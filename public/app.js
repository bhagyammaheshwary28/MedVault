// MedVault front end: a small hash-routed app with no build step.

const state = { user: null, categories: [], records: [] };
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $('#app');

// ---------- helpers ----------

async function api(path, { method = 'GET', body, headers = {}, raw } = {}) {
  const opts = { method, headers: { 'X-MedVault': '1', ...headers }, credentials: 'same-origin' };
  if (raw) opts.body = raw;
  else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.user) {
      state.user = null;
      render();
    }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

const fmtDate = (d) =>
  new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateTime = (d) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
// The local date, not UTC: east of UTC just after midnight, UTC is still yesterday.
const today = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};

function toast(msg) {
  const t = el('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

function showError(box, err) {
  box.textContent = err ? err.message || String(err) : '';
  box.hidden = !err;
}

function useTemplate(id) {
  app.replaceChildren($(id).content.cloneNode(true));
}

const ICONS = {
  'Lab report': '🧪', Prescription: '💊', 'Imaging / Scan': '🩻', 'Discharge summary': '🏥',
  'Consultation note': '🩺', Vaccination: '💉', Insurance: '📑', Other: '📄',
};

// ---------- routing ----------

const VIEWS = { records: renderRecords, health: renderHealth, sharing: renderSharing, account: renderAccount };

function render() {
  const signedIn = !!state.user;
  $('#nav').hidden = !signedIn;
  $('#who').hidden = !signedIn;
  if (!signedIn) return renderLanding();
  $('#who-name').textContent = state.user.name;
  const view = location.hash.replace(/^#\//, '') || 'records';
  const fn = VIEWS[view] || renderRecords;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === (VIEWS[view] ? view : 'records')));
  fn();
}

window.addEventListener('hashchange', render);

$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.user = null;
  state.records = [];
  location.hash = '';
  render();
});

// ---------- landing / auth ----------

function renderLanding() {
  useTemplate('#tpl-landing');
  let mode = 'login';
  const form = $('#auth-form');
  const setMode = (m) => {
    mode = m;
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === m));
    $$('[data-only="register"]', form).forEach((n) => (n.hidden = m !== 'register'));
    $$('[data-only="register-code"]', form).forEach((n) => (n.hidden = m !== 'register' || !state.signupCodeRequired));
    $('#auth-submit').textContent = m === 'login' ? 'Sign in' : 'Create my vault';
    $('#auth-password').autocomplete = m === 'login' ? 'current-password' : 'new-password';
    showError($('#auth-error'), null);
  };
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.tab)));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#auth-submit');
    btn.disabled = true;
    try {
      const body = { email: form.email.value, password: form.password.value };
      if (mode === 'register') body.name = form.name.value;
      if (mode === 'register' && state.signupCodeRequired) body.signupCode = form.signupCode.value;
      const { user } = await api(`/api/auth/${mode}`, { method: 'POST', body });
      // Clarity must never record inside the vault, and a fresh page load is the only sure way to stop it.
      if (clarityLoaded) {
        location.hash = '#/records';
        return location.reload();
      }
      state.user = user;
      await loadRecords();
      location.hash = '#/records';
      render();
    } catch (err) {
      showError($('#auth-error'), err);
    } finally {
      btn.disabled = false;
    }
  });
  renderAnalyticsNote();
}

// ---------- usage analytics (Microsoft Clarity, signed-out landing page only) ----------

const ANALYTICS_KEY = 'mv_analytics';
let clarityLoaded = false;

function analyticsChoice() {
  try {
    return localStorage.getItem(ANALYTICS_KEY);
  } catch {
    return null;
  }
}

function setAnalyticsChoice(choice) {
  try {
    localStorage.setItem(ANALYTICS_KEY, choice);
  } catch {
    // private browsing: the choice lasts for this page only
  }
}

// Clarity's standard loader, inlined here because the page CSP forbids inline scripts.
function loadClarity() {
  if (clarityLoaded || !state.clarityProjectId) return;
  clarityLoaded = true;
  window.clarity = window.clarity || function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
  window.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' });
  document.head.append(el('script', { async: true, src: `https://www.clarity.ms/tag/${encodeURIComponent(state.clarityProjectId)}` }));
}

function renderAnalyticsNote() {
  const note = $('#analytics-note');
  if (!note || !state.clarityProjectId) return;
  const choice = analyticsChoice();
  if (choice === 'granted') loadClarity();
  const answer = (value) => () => {
    setAnalyticsChoice(value);
    if (value === 'denied' && clarityLoaded) {
      window.clarity('consent', false); // erases Clarity's cookies
      return location.reload();
    }
    renderAnalyticsNote();
  };
  note.hidden = false;
  // Unanswered, the question leads the page so visitors see it before signing in; once answered it moves to the end.
  note.classList.toggle('asking', !choice);
  if (choice) app.append(note);
  else app.prepend(note);
  if (!choice) {
    $('#analytics-text').textContent =
      'Can we use Microsoft Clarity to see how visitors use this page? It runs only on this sign-in page, ' +
      'never inside your vault, and hides everything you type.';
    $('#analytics-actions').replaceChildren(
      el('button', { type: 'button', class: 'btn small primary', onclick: answer('granted') }, 'Allow'),
      el('button', { type: 'button', class: 'btn small', onclick: answer('denied') }, 'No thanks'),
    );
  } else {
    const on = choice === 'granted';
    $('#analytics-text').textContent = `Usage analytics (Microsoft Clarity) on this page: ${on ? 'on' : 'off'}.`;
    $('#analytics-actions').replaceChildren(
      el('button', { type: 'button', class: 'btn small', onclick: answer(on ? 'denied' : 'granted') }, on ? 'Turn off' : 'Turn on'),
    );
  }
}

// ---------- records ----------

const MAX_PAGES = 30;
const MAX_PAGE_BYTES = 20 * 1024 * 1024;
const PAGE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const recordSize = (r) => r.pages.reduce((s, p) => s + p.size, 0);
const pageSrc = (r, p) => `/api/records/${encodeURIComponent(r.id)}/pages/${encodeURIComponent(p.id)}/file`;
const pageKind = (r) => {
  const pdfs = r.pages.filter((p) => p.mime === 'application/pdf').length;
  if (pdfs === r.pages.length) return 'PDF';
  return pdfs ? 'PDF + images' : 'Image';
};
const pagesLabel = (n) => `${n} page${n === 1 ? '' : 's'}`;
const base64url = (obj) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(obj))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function loadRecords() {
  state.records = (await api('/api/records')).records;
}

function renderRecords() {
  useTemplate('#tpl-records');
  const sel = $('#filter-category');
  for (const c of state.categories) sel.append(el('option', { value: c }, c));
  $('#open-upload').addEventListener('click', () => openRecordDialog());
  $('#search').addEventListener('input', drawRecordList);
  sel.addEventListener('change', drawRecordList);
  drawStats();
  drawRecordList();
}

function drawStats() {
  const r = state.records;
  const providers = new Set(r.map((x) => x.provider.toLowerCase()).filter(Boolean));
  const latest = r[0] ? fmtDate(r[0].recordDate) : '–';
  const pages = r.reduce((s, x) => s + x.pages.length, 0);
  const stat = (n, label) => el('div', { class: 'card stat' }, el('b', {}, String(n)), el('span', {}, label));
  $('#stats').replaceChildren(
    stat(r.length, 'records stored'),
    stat(pages, 'pages of paper you no longer carry'),
    stat(providers.size, 'doctors & hospitals'),
    stat(latest, 'most recent record'),
  );
}

function drawRecordList() {
  const term = $('#search').value.trim().toLowerCase();
  const cat = $('#filter-category').value;
  const list = state.records.filter(
    (r) =>
      (!cat || r.category === cat) &&
      (!term ||
        [r.title, r.provider, r.notes, r.category, ...r.pages.map((p) => p.fileName)].join(' ').toLowerCase().includes(term)),
  );
  const box = $('#record-list');
  if (!state.records.length) {
    box.replaceChildren(
      el('div', { class: 'card empty' },
        el('div', { class: 'big' }, '🗂️'),
        el('h2', {}, 'No records yet'),
        el('p', { class: 'muted' }, 'Photograph a prescription page by page, or upload a lab report PDF, to get started.'),
        el('button', { class: 'btn primary', onclick: () => openRecordDialog() }, '＋ Add your first record'),
      ),
    );
    return;
  }
  if (!list.length) {
    box.replaceChildren(el('div', { class: 'card empty' }, el('p', { class: 'muted' }, 'No records match your search.')));
    return;
  }
  const byYear = new Map();
  for (const r of list) {
    const y = r.recordDate.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(r);
  }
  box.replaceChildren(
    ...[...byYear].flatMap(([year, recs]) => [
      el('h3', { class: 'year' }, year),
      el('div', { class: 'records' },
        recs.map((r) =>
          el('button', { class: 'card record', type: 'button', onclick: () => openViewer(r) },
            el('span', { class: 'chip' }, `${ICONS[r.category] || '📄'} ${r.category}`),
            el('h3', {}, r.title),
            el('div', { class: 'meta' }, fmtDate(r.recordDate), r.provider ? ` · ${r.provider}` : ''),
            el('div', { class: 'meta' }, `${pagesLabel(r.pages.length)} · ${pageKind(r)} · ${fmtSize(recordSize(r))}`),
          ),
        ),
      ),
    ]),
  );
}

// One dialog serves three modes: 'new' (details + pages), 'edit' (details only) and 'add' (pages for an
// existing record). Once a new record has been created it switches to 'add', so a failed page can be
// retried without creating a second record.
const upload = { mode: 'new', record: null, pending: [], failed: null, saved: false, busy: false, fromViewer: false };

function openRecordDialog(existing = null) {
  setupRecordDialog(existing ? 'edit' : 'new', existing);
}

function openAddPages(record) {
  setupRecordDialog('add', record, true);
}

function setupRecordDialog(mode, record, fromViewer = false) {
  Object.assign(upload, { mode, record, pending: [], failed: null, saved: false, busy: false, fromViewer });
  const form = $('#record-form');
  form.reset();
  const cat = $('#r-category');
  cat.replaceChildren(...state.categories.map((c) => el('option', { value: c }, c)));
  form.title.value = record?.title || '';
  cat.value = record?.category || 'Lab report';
  form.recordDate.value = record?.recordDate || today();
  form.recordDate.max = today();
  form.provider.value = record?.provider || '';
  form.notes.value = record?.notes || '';
  showError($('#record-error'), null);
  showError($('#pending-error'), null);
  syncRecordDialog();
  $('#dlg-record').showModal();
}

function syncRecordDialog() {
  const { mode, record, pending, failed, busy } = upload;
  $('#record-dlg-title').textContent =
    mode === 'edit' ? 'Edit record details' : mode === 'add' ? `Add pages to “${record.title}”` : 'Add a record';
  $('#capture').hidden = mode === 'edit';
  $('#record-fields').hidden = mode === 'add';
  const offset = mode === 'add' ? record.pages.length : 0;
  $('#pending-list').replaceChildren(
    ...pending.map((file, i) =>
      el('li', { class: file === failed ? 'failed' : '' },
        el('span', { class: 'num' }, `Page ${offset + i + 1}`),
        el('span', { class: 'name', title: file.name }, file.name),
        el('span', { class: 'muted small' }, fmtSize(file.size)),
        el('button', {
          type: 'button', class: 'x', 'aria-label': `Remove ${file.name}`, disabled: busy,
          onclick: () => {
            upload.pending.splice(i, 1);
            if (upload.failed === file) upload.failed = null;
            syncRecordDialog();
          },
        }, '×'),
      ),
    ),
  );
  const save = $('#record-save');
  save.disabled = busy;
  // The upload loop owns this dialog's state until it finishes, so it can't be closed mid-upload.
  $$('#record-form [value="cancel"]').forEach((b) => (b.disabled = busy));
  // Pages can't be added while the loop is uploading, or its "page n of N" count goes wrong.
  $('#record-file').disabled = $('#record-camera').disabled = busy;
  $('#capture').classList.toggle('busy', busy);
  if (!busy) {
    save.textContent = mode === 'edit' ? 'Save changes' : failed ? 'Retry remaining pages' : mode === 'add' ? 'Upload pages' : 'Save record';
  }
}

// Validate files as they are chosen, so a bad file never reaches the server mid-upload.
function addFiles(files) {
  if (upload.busy) return;
  const existing = upload.mode === 'add' ? upload.record.pages.length : 0;
  const problems = [];
  for (const file of files) {
    if (!PAGE_TYPES.includes(file.type)) problems.push(`${file.name} isn't a PDF or JPG/PNG/WEBP/GIF image.`);
    else if (file.size > MAX_PAGE_BYTES) problems.push(`${file.name} is over 20 MB.`);
    else if (existing + upload.pending.length >= MAX_PAGES) {
      problems.push(`A record holds at most ${MAX_PAGES} pages, so ${file.name} wasn't added.`);
    } else upload.pending.push(file);
  }
  showError($('#pending-error'), problems.length ? problems.join(' ') : null);
  const title = $('#r-title');
  if (upload.mode === 'new' && !title.value && upload.pending[0]) {
    title.value = upload.pending[0].name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  }
  syncRecordDialog();
}

{
  const dz = $('#dropzone');
  for (const input of [$('#record-file'), $('#record-camera')]) {
    input.addEventListener('change', (e) => {
      addFiles([...e.target.files]);
      e.target.value = '';
    });
  }
  dz.addEventListener('dragover', (e) => (e.preventDefault(), dz.classList.add('over')));
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    addFiles([...e.dataTransfer.files]);
  });
}

async function uploadPending() {
  const total = (upload.mode === 'add' ? upload.record.pages.length : 0) + upload.pending.length;
  while (upload.pending.length) {
    const file = upload.pending[0];
    const done = total - upload.pending.length;
    $('#record-save').textContent = `Uploading page ${done + 1} of ${total}…`;
    upload.failed = file;
    try {
      if (upload.mode === 'new') {
        const f = $('#record-form');
        const meta = {
          title: f.title.value, category: f.category.value, recordDate: f.recordDate.value,
          provider: f.provider.value, notes: f.notes.value, fileName: file.name,
        };
        ({ record: upload.record } = await api('/api/records', {
          method: 'POST', raw: file, headers: { 'Content-Type': 'application/octet-stream', 'X-Record-Meta': base64url(meta) },
        }));
        upload.mode = 'add';
      } else {
        ({ record: upload.record } = await api(`/api/records/${upload.record.id}/pages`, {
          method: 'POST', raw: file,
          headers: { 'Content-Type': 'application/octet-stream', 'X-Page-Meta': base64url({ fileName: file.name }) },
        }));
      }
    } catch (err) {
      const kept = upload.saved || upload.mode === 'add' ? ' Pages already uploaded are saved.' : '';
      throw new Error(`“${file.name}” couldn't be uploaded: ${err.message}.${kept} Retry the remaining pages, or close this and add them later.`);
    }
    upload.saved = true;
    upload.failed = null;
    upload.pending.shift();
    syncRecordDialog();
  }
}

$('#record-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value === 'cancel') return;
  e.preventDefault();
  const form = e.target;
  if (upload.mode !== 'edit' && !upload.pending.length) {
    showError($('#record-error'), new Error('Add at least one page: choose a file or take a photo.'));
    return;
  }
  upload.busy = true;
  syncRecordDialog();
  showError($('#record-error'), null);
  try {
    if (upload.mode === 'edit') {
      await api(`/api/records/${upload.record.id}`, {
        method: 'PATCH',
        body: {
          title: form.title.value, category: form.category.value, recordDate: form.recordDate.value,
          provider: form.provider.value, notes: form.notes.value,
        },
      });
      toast('Record updated');
    } else {
      await uploadPending();
      toast(`${pagesLabel(upload.record.pages.length)} saved to your vault`);
    }
    upload.busy = false;
    $('#dlg-record').close();
  } catch (err) {
    upload.busy = false;
    showError($('#record-error'), err);
    syncRecordDialog();
  }
});

$('#dlg-record').addEventListener('cancel', (e) => {
  if (upload.busy) e.preventDefault();
});

$('#dlg-record').addEventListener('close', async () => {
  if (!upload.saved && upload.mode !== 'edit') return;
  await loadRecords();
  render();
  const rec = upload.fromViewer && state.records.find((r) => r.id === upload.record.id);
  if (rec) openViewer(rec, rec.pages.length - 1);
});

const viewer = { record: null, index: 0 };

function openViewer(r, index = 0) {
  Object.assign(viewer, { record: r, index });
  $('#view-title').textContent = r.title;
  showViewerPage();
  const dlg = $('#dlg-view');
  if (!dlg.open) dlg.showModal();
}

function showViewerPage() {
  const { record: r, index } = viewer;
  const page = r.pages[index];
  const src = pageSrc(r, page);
  $('#view-frame').replaceChildren(
    page.mime === 'application/pdf'
      ? el('iframe', { src, title: `${r.title}, page ${index + 1}` })
      : el('img', { src, alt: `${r.title}, page ${index + 1}` }),
  );
  const many = r.pages.length > 1;
  $('.pager').hidden = !many;
  $('#view-page').textContent = `Page ${index + 1} of ${r.pages.length}`;
  $('#view-prev').disabled = index === 0;
  $('#view-next').disabled = index === r.pages.length - 1;
  const row = (k, v) => (v ? [el('dt', {}, k), el('dd', {}, v)] : []);
  $('#view-meta').replaceChildren(
    ...row('Type', r.category),
    ...row('Date', fmtDate(r.recordDate)),
    ...row('Doctor / hospital', r.provider),
    ...row('Notes', r.notes),
    ...row(many ? `Page ${index + 1}` : 'File', `${page.fileName} · ${fmtSize(page.size)}`),
    ...row('Added', fmtDateTime(r.createdAt)),
  );
  $('#view-download').href = src + '?download=1';
  $('#view-delete-page').hidden = !many;
}

$('#view-prev').addEventListener('click', () => (viewer.index--, showViewerPage()));
$('#view-next').addEventListener('click', () => (viewer.index++, showViewerPage()));
$('#view-add-page').addEventListener('click', () => {
  $('#dlg-view').close();
  openAddPages(viewer.record);
});
$('#view-edit').addEventListener('click', () => {
  $('#dlg-view').close();
  openRecordDialog(viewer.record);
});
// Runs one viewer delete at a time. `stillShowing` tells the caller whether the viewer is still on that record,
// since the patient can close it (or open another record) while the request is in flight.
async function viewerDelete(r, request) {
  const buttons = [$('#view-delete-page'), $('#view-delete')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    const result = await request();
    await loadRecords();
    const stillShowing = $('#dlg-view').open && viewer.record === r;
    if (!stillShowing) render();
    return { result, stillShowing };
  } catch (err) {
    toast(err.message);
    return null;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

$('#view-delete-page').addEventListener('click', async () => {
  const { record: r, index } = viewer;
  if (!confirm(`Delete page ${index + 1} of "${r.title}"? This permanently removes that page.`)) return;
  const done = await viewerDelete(r, () => api(`/api/records/${r.id}/pages/${r.pages[index].id}`, { method: 'DELETE' }));
  if (!done) return;
  toast('Page deleted');
  if (!done.stillShowing) return;
  const { record } = done.result;
  Object.assign(viewer, { record, index: Math.min(index, record.pages.length - 1) });
  showViewerPage();
});
$('#view-delete').addEventListener('click', async () => {
  const r = viewer.record;
  if (!confirm(`Delete "${r.title}" and all ${pagesLabel(r.pages.length)}? This can't be undone.`)) return;
  const done = await viewerDelete(r, () => api(`/api/records/${r.id}`, { method: 'DELETE' }));
  if (!done) return;
  toast('Record deleted');
  if (done.stillShowing) $('#dlg-view').close();
});

$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
$('#dlg-view').addEventListener('close', () => {
  $('#view-frame').replaceChildren();
  render();
});

// ---------- health summary ----------

const PROFILE_LABELS = {
  dob: 'Date of birth',
  bloodGroup: 'Blood group',
  allergies: 'Allergies',
  conditions: 'Ongoing conditions',
  medications: 'Current medications',
  emergencyContact: 'Emergency contact',
};

function emergencyCard(name, profile) {
  const rows = Object.entries(PROFILE_LABELS).flatMap(([k, label]) => {
    let v = profile?.[k];
    if (k === 'dob' && v) v = `${fmtDate(v)} (age ${Math.floor((Date.now() - new Date(v)) / 31557600000)})`;
    return [el('dt', {}, label), el('dd', {}, v || '—')];
  });
  return [el('h2', { style: 'font-size:18px' }, '🩺 ', name), el('dl', {}, rows)];
}

function renderHealth() {
  useTemplate('#tpl-health');
  const form = $('#profile-form');
  const p = state.user.profile || {};
  form.name.value = state.user.name;
  for (const k of Object.keys(PROFILE_LABELS)) form[k].value = p[k] || '';
  form.dob.max = today();
  const preview = () => {
    const draft = Object.fromEntries(Object.keys(PROFILE_LABELS).map((k) => [k, form[k].value.trim()]));
    $('#ecard-preview').replaceChildren(...emergencyCard(form.name.value || state.user.name, draft));
  };
  form.addEventListener('input', preview);
  preview();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const profile = Object.fromEntries(Object.keys(PROFILE_LABELS).map((k) => [k, form[k].value]));
      state.user = (await api('/api/me', { method: 'PUT', body: { name: form.name.value, profile } })).user;
      showError($('#profile-error'), null);
      $('#who-name').textContent = state.user.name;
      toast('Health summary saved');
    } catch (err) {
      showError($('#profile-error'), err);
    }
  });
}

// ---------- sharing ----------

async function renderSharing() {
  useTemplate('#tpl-sharing');
  $('#open-share').addEventListener('click', openShareDialog);
  await drawShares();
}

async function drawShares() {
  const [{ shares }, { entries }] = await Promise.all([api('/api/shares'), api('/api/access-log')]);
  const statusChip = (s) =>
    el('span', { class: `chip ${s === 'active' ? '' : s === 'revoked' ? 'red' : 'gray'}` }, s);
  $('#share-list').replaceChildren(
    shares.length
      ? el('table', {},
          el('thead', {}, el('tr', {}, ['For', 'Contains', 'Expires', 'Status', ''].map((h) => el('th', {}, h)))),
          el('tbody', {},
            shares.map((s) =>
              el('tr', {},
                el('td', {}, el('b', {}, s.label), el('div', { class: 'muted small' }, 'Created ' + fmtDateTime(s.createdAt))),
                el('td', {}, `${s.recordCount} record${s.recordCount === 1 ? '' : 's'}${s.includeProfile ? ' + health summary' : ''}`),
                el('td', {}, fmtDateTime(s.expiresAt)),
                el('td', {}, statusChip(s.status)),
                el('td', { style: 'text-align:right' },
                  s.status === 'active' &&
                    el('button', {
                      class: 'btn small danger',
                      onclick: async () => {
                        if (!confirm(`Revoke the link for "${s.label}"? It will stop working immediately.`)) return;
                        await api(`/api/shares/${s.id}`, { method: 'DELETE' });
                        toast('Link revoked');
                        drawShares();
                      },
                    }, 'Revoke'),
                ),
              ),
            ),
          ),
        )
      : el('p', { class: 'muted' }, "You haven't shared anything yet."),
  );
  $('#access-log').replaceChildren(
    entries.length
      ? el('table', {},
          el('thead', {}, el('tr', {}, ['When', 'Link', 'What happened', 'From'].map((h) => el('th', {}, h)))),
          el('tbody', {},
            entries.map((a) =>
              el('tr', {},
                el('td', {}, fmtDateTime(a.at)),
                el('td', {}, a.share_label || '—'),
                el('td', {}, a.event, a.record_title ? el('div', { class: 'muted small' }, a.record_title) : ''),
                el('td', { class: 'muted small' }, a.ip),
              ),
            ),
          ),
        )
      : el('p', { class: 'muted' }, 'No one has opened your links yet.'),
  );
}

function openShareDialog() {
  const dlg = $('#dlg-share');
  const form = $('#share-form');
  form.reset();
  $('#share-step-1').hidden = false;
  $('#share-step-2').hidden = true;
  $('#share-create').hidden = false;
  $('#share-cancel').textContent = 'Cancel';
  showError($('#share-error'), null);
  const list = $('#s-records');
  list.replaceChildren(
    ...(state.records.length
      ? state.records.map((r) =>
          el('label', { class: 'pick' },
            el('input', { type: 'checkbox', value: r.id }),
            el('span', {}, el('b', {}, r.title), el('span', { class: 'muted small' }, ` · ${r.category} · ${fmtDate(r.recordDate)}`)),
          ),
        )
      : [el('p', { class: 'muted small', style: 'padding:8px 12px;margin:0' }, 'No records yet. You can still share your health summary.')]),
  );
  const toggle = $('#s-toggle-all');
  toggle.textContent = 'Select all';
  toggle.onclick = () => {
    const boxes = $$('input', list);
    const anyOn = boxes.some((b) => b.checked);
    boxes.forEach((b) => (b.checked = !anyOn));
    toggle.textContent = anyOn ? 'Select all' : 'Select none';
  };
  dlg.showModal();
}

$('#share-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value === 'cancel') return;
  e.preventDefault();
  const btn = $('#share-create');
  btn.disabled = true;
  try {
    const res = await api('/api/shares', {
      method: 'POST',
      body: {
        label: $('#s-label').value,
        hours: Number($('#s-hours').value),
        includeProfile: $('#s-profile').checked,
        recordIds: $$('#s-records input:checked').map((b) => b.value),
      },
    });
    const url = location.origin + res.path;
    $('#s-link').value = url;
    $('#s-expires').textContent = fmtDateTime(res.expiresAt);
    const qr = $('#s-qr');
    qr.replaceChildren();
    if (window.QRCode) new window.QRCode(qr, { text: url, width: 200, height: 200 });
    else qr.hidden = true;
    $('#share-step-1').hidden = true;
    $('#share-step-2').hidden = false;
    btn.hidden = true;
    $('#share-cancel').textContent = 'Done';
    drawShares();
  } catch (err) {
    showError($('#share-error'), err);
  } finally {
    btn.disabled = false;
  }
});

$('#s-copy').addEventListener('click', async () => {
  const input = $('#s-link');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  toast('Link copied');
});

// ---------- account ----------

function renderAccount() {
  useTemplate('#tpl-account');
  $('#acct-email').textContent = state.user.email;
  const pwForm = $('#password-form');
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = $('#password-error');
    try {
      if (pwForm.newPassword.value !== pwForm.confirmPassword.value) throw new Error('The new passwords don’t match');
      await api('/api/me/password', {
        method: 'PUT',
        body: { currentPassword: pwForm.currentPassword.value, newPassword: pwForm.newPassword.value },
      });
      pwForm.reset();
      showError(box, null);
      toast('Password changed. Other devices have been signed out.');
    } catch (err) {
      showError(box, err);
    }
  });
  $('#delete-account').addEventListener('click', async () => {
    const typed = prompt('This permanently deletes all your records. Type DELETE to confirm.');
    if (typed !== 'DELETE') return;
    await api('/api/me', { method: 'DELETE' });
    state.user = null;
    state.records = [];
    location.hash = '';
    toast('Your account has been deleted');
    render();
  });
}

// ---------- boot ----------

(async () => {
  try {
    const me = await api('/api/me');
    state.categories = me.categories;
    state.signupCodeRequired = me.signupCodeRequired;
    state.clarityProjectId = me.clarityProjectId;
    state.user = me.user;
    if (state.user) await loadRecords();
  } catch {
    // fall through to the landing page
  }
  render();
})();
