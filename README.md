# MedVault

A patient-owned vault for medical records. Upload a photo or PDF of any record once, open it from anywhere, and
share it with a doctor through a link or QR code that stops working when you choose.

**Live instance:** https://medvault2.vercel.app (sign-up is invite-only)

> MedVault has not had an independent security review or a medical-data compliance review. Use made-up records,
> not real patients' records, until it has.

## The problem

Why can't patients get digital copies of their medical records? Records are spread across each hospital's own
system or kept on paper, so patients carry folders to every appointment, lose reports, re-take tests, and arrive at
emergencies with no history. MedVault gives the patient their own copy.

## Features

- **Multi-page records.** A record holds up to 30 pages. Add several PDFs or photos at once, or photograph pages
  straight from a phone's camera. Each page is a PDF or image (JPG, PNG, WEBP, GIF) of up to 20 MB. The server checks
  the file's actual bytes, not its extension. If one page fails to upload, the rest can be retried.
- **Encrypted at rest.** Every page is encrypted with AES-256-GCM before it is written to disk.
- **Organised records.** Records are grouped by year, with search and a filter by type: lab report, prescription,
  scan, discharge summary, consultation note, vaccination, insurance and other.
- **Viewer.** Page through a record in the browser, add or delete pages, edit details, download or delete.
- **Health summary.** Date of birth, blood group, allergies, conditions, medications and emergency contact, shown as
  an emergency card.
- **Share with a doctor.** Choose records, choose how long the link lasts (1 hour to 30 days), and get a link and QR
  code. The doctor doesn't need an account and sees every page, including pages added later. The patient can revoke a
  link at any time.
- **Access history.** Every time a share link is opened or a file in it is viewed or downloaded, with the time and
  the visitor's IP address.
- **Download everything.** One ZIP with a folder of pages per record and a readable index of the records and health
  summary. It opens on any computer without MedVault.
- **Account control.** Changing the password signs out every other device. Deleting the account permanently removes
  all records and files from the live vault. It can't reach backups or the upgrade snapshot described under
  [Upgrading](#upgrading).

## How it works

MedVault is one Node.js server with **no third-party dependencies**: it uses only `node:http`, `node:sqlite` and
`node:crypto`. The front end is plain HTML, CSS and JavaScript with no build step.

```
Browser ──► Vercel (public address) ──► Railway (MedVault server) ──► /data volume
                                                                     ├─ medvault.db   (SQLite)
                                                                     └─ files/*.bin   (encrypted pages)
```

- **Uploads** send each page's raw bytes in the request body, with the record details as base64url JSON in a header.
  The server detects the file type from its bytes, encrypts it and stores it as `files/<page id>.bin`.
- **The database** holds users, sessions, records, pages, share links and the access log. The schema is versioned with
  `PRAGMA user_version` and upgrades itself on start.
- **Share links** are random 256-bit tokens. Only their SHA-256 hash is stored, so the full link is shown once, when
  it is created.
- **Vercel is optional.** It forwards every request to Railway. The app runs just as well with Railway alone, or on
  any server that can keep a folder on disk.

## Security

- Passwords are hashed with scrypt and a per-user salt.
- Sessions use HttpOnly, `SameSite=Strict` cookies that last 7 days; the database stores only token hashes.
- Every request that changes data must carry a custom header, which blocks cross-site request forgery.
- Every file lookup checks that the page belongs to the record and the record to the caller, or to a live share link.
- Uploaded files are served with `nosniff`, a restrictive Content-Security-Policy and a sanitised file name.
- The pages run under a strict Content-Security-Policy, and the front end never inserts raw HTML.
- Sign-in, sign-up and password changes are limited to 20 attempts per IP address every 15 minutes.

**What is not encrypted:** record titles, notes, provider names and the health summary are stored as plain text in
SQLite. Only the files themselves are encrypted. Anyone with both the database and the encryption key can read
everything, so keep `MEDVAULT_KEY` out of the data folder in production (see [Configuration](#configuration)).

## Run it locally

Requires Node.js 22.13 or later. There is nothing to install.

```bash
npm start
```

Open http://localhost:4000. Data is stored in `data/`: the SQLite database, the encrypted files and a generated
encryption key.

```bash
npm test
```

The tests use Node's built-in test runner and create their own temporary vaults.

### Using it from your phone

Photographing paper records works best on a phone. With the server running on your computer, open
`http://<your computer's local IP address>:4000` on a phone on the same Wi-Fi network. For anyone outside your
network, deploy it behind HTTPS.

Share links use the address you opened MedVault from. A link created on `localhost` only works on that computer.

## Configuration

All settings are environment variables.

| Variable | Default | What it does |
|---|---|---|
| `MEDVAULT_KEY` | generated in `data/secret.key` | 32 random bytes, base64. Encrypts every stored page. **Back it up**: without it, the files can never be decrypted. |
| `SECURE_COOKIES` | off | Set to `1` behind HTTPS. Cookies then only travel over HTTPS, and HSTS is turned on. |
| `TRUST_PROXY` | off | Set to `1` behind one reverse proxy, as on Railway, so the attempt limit counts each visitor separately. |
| `MEDVAULT_SIGNUP_CODE` | none | Makes sign-up invite-only: new accounts need this code. Signing in never does. |
| `MEDVAULT_ORIGIN_SECRET` | none | With Vercel in front: requests without this value in `x-origin-secret` are refused, and each visitor's IP is read from Vercel's headers. |
| `MEDVAULT_DATA_DIR` | `data/` | Where the database, encrypted files and key file live, such as a mounted volume. |
| `PORT` | `4000` | The port to listen on. Hosts like Railway set it for you. |

Generate a key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Deployment

### Railway (runs the app)

[DEPLOY.md](DEPLOY.md) walks through it step by step. In short:

1. `railway init`, then `railway up` from this folder. Railway builds the [Dockerfile](Dockerfile).
2. Add a volume mounted at exactly `/data`. Without it, every redeploy wipes the vault.
3. Set `MEDVAULT_KEY`, `SECURE_COOKIES=1`, `TRUST_PROXY=1` and, if you want, `MEDVAULT_SIGNUP_CODE`.
4. Generate a domain. Its target port must match the port in the startup log (`MedVault running at
   http://localhost:<port>`), or Railway shows "Application failed to respond".

### Vercel in front (optional)

Vercel can't run the app itself: its functions have no permanent disk and accept request bodies of only 4.5 MB.
Instead, [vercel-proxy/vercel.json](vercel-proxy/vercel.json) forwards every request to Railway and adds a secret
header, so Railway only answers traffic that came through Vercel.

1. Put your Railway address in `vercel-proxy/vercel.json`.
2. Generate a secret:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. From **inside `vercel-proxy`**, run `vercel link`, then `vercel env add ORIGIN_SECRET production` with the secret,
   then `vercel --prod`. Never deploy to Vercel from the project root: that would upload the code and any local
   `data/` folder.
4. In the Vercel project settings, turn off **Deployment Protection → Vercel Authentication**, or every visitor has
   to sign in to Vercel.
5. On Railway, set `MEDVAULT_ORIGIN_SECRET` to the same secret. The Railway address then returns `403 Forbidden`, and
   only the Vercel address works.

The app sends `Cache-Control: no-store` on every API response, so Vercel never caches private data.

## Upgrading

The first start after upgrading to multi-page records migrates the database automatically, turning each existing
record into a one-page record. Before the migration changes anything, MedVault saves a copy of the old database as
`data/medvault.pre-v1.db`. Back up the whole `data/` folder before upgrading anyway.

The snapshot is a full, unencrypted copy of the database: every patient's name, email, health summary and record
details. The files themselves stay encrypted in `data/files/`. Deleting an account doesn't remove it from the
snapshot. Once you have checked that the upgraded vault works, delete `data/medvault.pre-v1.db`. MedVault prints a
reminder on every start while it is there.

## Limits

| | |
|---|---|
| Pages per record | 30 |
| Size per page | 20 MB |
| Share link lifetime | 1 hour to 30 days |
| Full export | Under 4 GB and 65,535 files, as one ZIP without ZIP64 |
| Railway requests | Up to 15 minutes while data is moving; uploads must finish within 5 minutes |

## Project structure

```
server.js            HTTP server, routes, sign-in, database and migrations, encryption
export.js            Streaming ZIP writer and index page for "Download everything"
public/
  index.html         Patient app: page templates and dialogs
  app.js             Patient app logic (hash-routed, no build step)
  share.html         Read-only page a doctor sees at /s/<token>
  share.js           Doctor view logic
  styles.css         Shared styles, light and dark
test/                API, export, hosting and migration tests (node:test)
vercel-proxy/        Vercel config that forwards everything to Railway
Dockerfile           Production image; the vault lives on a volume at /data
DEPLOY.md            Step-by-step Railway guide
```

## API overview

Every route is under `/api`. Requests that change data must send the header `X-MedVault: 1`.

| Method and path | Purpose |
|---|---|
| `POST /auth/register`, `/auth/login`, `/auth/logout` | Create an account, sign in, sign out |
| `GET`, `PUT`, `DELETE /me` | Read the account and health summary, update them, delete the account |
| `PUT /me/password` | Change the password and sign out other devices |
| `GET`, `POST /records` | List records; create a record from its first page |
| `PATCH`, `DELETE /records/:id` | Edit a record's details; delete the record and its files |
| `POST /records/:id/pages` | Add a page |
| `DELETE /records/:id/pages/:pageId` | Delete a page, unless it is the last one |
| `GET /records/:id/pages/:pageId/file` | View a page; add `?download` to download it |
| `GET /export` | Download everything as a ZIP |
| `GET`, `POST /shares`, `DELETE /shares/:id` | List, create and revoke share links |
| `GET /access-log` | The last 200 access-history entries |
| `GET /s/:token`, `/s/:token/records/:id/pages/:pageId/file` | The doctor's read-only view and files |
