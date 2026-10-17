// Read-only view a doctor sees when opening a patient's share link.

const $ = (sel) => document.querySelector(sel);
const token = location.pathname.split('/')[2] || '';
const base = `/api/s/${encodeURIComponent(token)}`;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

const fmtDate = (d) =>
  new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateTime = (d) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const pagesLabel = (n) => `${n} page${n === 1 ? '' : 's'}`;
const recordSize = (r) => r.pages.reduce((s, p) => s + p.size, 0);
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

const LABELS = {
  dob: 'Date of birth',
  bloodGroup: 'Blood group',
  allergies: 'Allergies',
  conditions: 'Ongoing conditions',
  medications: 'Current medications',
  emergencyContact: 'Emergency contact',
};

const viewer = { record: null, index: 0 };

function openViewer(r) {
  Object.assign(viewer, { record: r, index: 0 });
  $('#view-title').textContent = r.title;
  showPage();
  $('#dlg-view').showModal();
}

function showPage() {
  const { record: r, index } = viewer;
  const page = r.pages[index];
  const src = `${base}/records/${encodeURIComponent(r.id)}/pages/${encodeURIComponent(page.id)}/file`;
  const label = `${r.title}, page ${index + 1}`;
  $('#view-frame').replaceChildren(
    page.mime === 'application/pdf' ? el('iframe', { src, title: label }) : el('img', { src, alt: label }),
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
    ...row('Patient notes', r.notes),
    ...row(many ? `Page ${index + 1}` : 'File', `${page.fileName} · ${fmtSize(page.size)}`),
  );
  $('#view-download').href = src + '?download=1';
}

$('#view-prev').addEventListener('click', () => (viewer.index--, showPage()));
$('#view-next').addEventListener('click', () => (viewer.index++, showPage()));
$('#view-close').addEventListener('click', () => $('#dlg-view').close());
$('#dlg-view').addEventListener('close', () => $('#view-frame').replaceChildren());

(async () => {
  const main = $('#share');
  const res = await fetch(base);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    main.replaceChildren(
      el('div', { class: 'card empty' },
        el('div', { class: 'big' }, '⏳'),
        el('h2', {}, 'This link is no longer available'),
        el('p', { class: 'muted' }, data.error || 'Ask the patient to send you a new link.'),
      ),
    );
    return;
  }

  const parts = [
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, `Medical records of ${data.patient}`),
        el('div', { class: 'muted' }, `Shared for: ${data.label} · Link expires ${fmtDateTime(data.expiresAt)}`),
      ),
    ),
  ];

  if (data.profile) {
    const p = data.profile;
    const rows = Object.entries(LABELS).flatMap(([k, label]) => {
      let v = p[k];
      if (k === 'dob' && v) v = `${fmtDate(v)} (age ${Math.floor((Date.now() - new Date(v)) / 31557600000)})`;
      return [el('dt', {}, label), el('dd', {}, v || '—')];
    });
    parts.push(
      el('div', { class: 'card ecard', style: 'margin-bottom:24px' },
        el('h2', { style: 'font-size:18px' }, '🩺 Health summary'),
        el('dl', {}, rows),
      ),
    );
  }

  parts.push(el('h2', { style: 'font-size:18px' }, `Records (${data.records.length})`));
  parts.push(
    data.records.length
      ? el('div', { class: 'records' },
          data.records.map((r) =>
            el('button', { class: 'card record', type: 'button', onclick: () => openViewer(r) },
              el('span', { class: 'chip' }, r.category),
              el('h3', {}, r.title),
              el('div', { class: 'meta' }, fmtDate(r.recordDate), r.provider ? ` · ${r.provider}` : ''),
              el('div', { class: 'meta' }, `${pagesLabel(r.pages.length)} · ${fmtSize(recordSize(r))}`),
            ),
          ),
        )
      : el('p', { class: 'muted' }, 'No documents were included in this share.'),
  );
  parts.push(el('p', { class: 'muted small', style: 'margin-top:24px' },
    'The patient can see when this page and each document are opened, and can revoke access at any time.'));
  main.replaceChildren(...parts);
})();
