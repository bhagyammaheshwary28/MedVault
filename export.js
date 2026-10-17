// Full-vault export: a ZIP the operating system can open on its own, with every page and a
// readable index. Entries use the "stored" method (PDFs and photos are already compressed) and
// are streamed one page at a time, so memory stays at one decrypted page.

import zlib from 'node:zlib';

// Without ZIP64, offsets and sizes are 32-bit and the entry count is 16-bit.
export const ZIP_MAX_BYTES = 0xffffffff - 0x10000;
export const ZIP_MAX_ENTRIES = 0xffff;
const UTF8_NAMES = 0x0800;
const EXTENSIONS = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// A folder name that is safe and distinct on every OS: no path separators or reserved
// characters, no trailing dots or spaces (Windows strips them), and unique ignoring case.
function folderNames(records) {
  const seen = new Set();
  return records.map((r) => {
    // Truncate by code point: slicing UTF-16 units can split an emoji into a lone surrogate.
    const title = [...r.title.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ')].slice(0, 80).join('');
    const stem = `${r.recordDate} ${title}`.replace(/[. ]+$/, '');
    let name = stem;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${stem} (${n})`;
    seen.add(name.toLowerCase());
    return name;
  });
}

export function planExport({ patient, profile, records, exportedAt }) {
  const folders = folderNames(records);
  const filesByRecord = records.map((r, i) =>
    r.pages.map((p, n) => ({ name: `${folders[i]}/page-${n + 1}.${EXTENSIONS[p.mime] || 'bin'}`, page: p, record: r })),
  );
  const index = Buffer.from(indexHtml({ patient, profile, records, filesByRecord, exportedAt }), 'utf8');
  return { files: filesByRecord.flat(), index };
}

function indexHtml({ patient, profile, records, filesByRecord, exportedAt }) {
  const labels = {
    dob: 'Date of birth', bloodGroup: 'Blood group', allergies: 'Allergies', conditions: 'Ongoing conditions',
    medications: 'Current medications', emergencyContact: 'Emergency contact',
  };
  const summary = Object.entries(labels)
    .map(([k, label]) => `<tr><th>${label}</th><td>${escapeHtml(profile[k] || '—')}</td></tr>`)
    .join('');
  const rows = records
    .map((r, i) => {
      const links = filesByRecord[i]
        .map((f, n) => `<a href="${f.name.split('/').map(encodeURIComponent).join('/')}">Page ${n + 1}</a>`)
        .join(' · ');
      return `<tr><td>${escapeHtml(r.recordDate)}</td><td><b>${escapeHtml(r.title)}</b><br>${escapeHtml(r.category)}` +
        `${r.provider ? ` · ${escapeHtml(r.provider)}` : ''}${r.notes ? `<br><i>${escapeHtml(r.notes)}</i>` : ''}</td><td>${links}</td></tr>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Medical records of ${escapeHtml(patient)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#13252b}
table{border-collapse:collapse;width:100%;margin-bottom:24px}th,td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid #dbe4e6}
th{width:200px;color:#5b6f75}</style></head><body>
<h1>Medical records of ${escapeHtml(patient)}</h1>
<p>Exported from MedVault on ${escapeHtml(exportedAt.slice(0, 10))}. Each record's pages are in its own folder.</p>
<h2>Health summary</h2><table>${summary}</table>
<h2>Records (${records.length})</h2>
<table><tr><th>Date</th><th>Record</th><th>Pages</th></tr>${rows}</table>
</body></html>`;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

// Writes stored entries to `out` one at a time; `read(entry)` returns that entry's bytes.
// Waits for 'drain' whenever the socket buffer is full, so a slow phone connection never
// makes the server buffer the whole vault.
export async function writeZip(out, entries, read, now = new Date()) {
  const { time, day } = dosDateTime(now);
  const central = [];
  let offset = 0;

  const write = async (buf) => {
    offset += buf.length;
    if (out.write(buf)) return;
    await new Promise((resolve, reject) => {
      const onClose = () => reject(new Error('Client disconnected during export'));
      out.once('drain', () => (out.off('close', onClose), resolve()));
      out.once('close', onClose);
    });
  };

  for (const entry of entries) {
    const data = await read(entry);
    const name = Buffer.from(entry.name, 'utf8');
    const crc = zlib.crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(UTF8_NAMES, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(UTF8_NAMES, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(day, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    await write(Buffer.concat([header, name]));
    await write(data);
  }

  const cdStart = offset;
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(cdStart, 16);
  await write(cdBuf);
  await write(end);
}
