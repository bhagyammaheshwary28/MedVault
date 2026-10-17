# Putting MedVault on the internet (Railway)

This guide puts MedVault at a public `https://…up.railway.app` address that you can open from any phone or computer.
Railway runs the app from the `Dockerfile` in this folder, gives it HTTPS automatically, and keeps the database and
encrypted files on a persistent disk (a "volume") so they survive restarts and redeploys.

You deploy straight from this folder with Railway's command-line tool, so nothing has to be pushed to GitHub.

> Use made-up records while trying it out. MedVault has not had an independent security review or a medical-data
> compliance review, so don't store real patients' records on it yet.

## What you need

- **A Railway account.** Sign up at [railway.com](https://railway.com) with GitHub, Google or email. New accounts get
  trial credit; after that Railway charges a small monthly amount for a hobby project. Check
  [railway.com/pricing](https://railway.com/pricing) for current prices before you start.
- **Node.js**, which you already have, to install Railway's command-line tool.

## 1. Install the Railway CLI and sign in

```bash
npm install -g @railway/cli
```

```bash
railway login
```

`railway login` opens your browser so you can approve the sign-in.

## 2. Create the project

From this `medvault` folder:

```bash
railway init
```

Name the project `medvault` when asked.

## 3. Add a volume for the vault's data

In the [Railway dashboard](https://railway.com/dashboard), open the `medvault` project, select the service, and add a
**Volume** with the mount path **`/data`**. Everything MedVault stores lives there. Without a volume, every redeploy
wipes all accounts and records.

(If your CLI version supports it, `railway volume add --mount-path /data` does the same.)

## 4. Set the settings (environment variables)

First generate the encryption key on your own computer:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Save that key in a password manager.** Every stored file is encrypted with it; if the key is lost, the files can
never be decrypted. Don't paste it into chat, email or the code.

Then, in the dashboard, open the service's **Variables** tab and add:

| Variable | Value | Why |
|---|---|---|
| `MEDVAULT_KEY` | the key you just generated | Encrypts every stored page |
| `SECURE_COOKIES` | `1` | Sign-in cookies only travel over HTTPS, and browsers are told to always use HTTPS |
| `TRUST_PROXY` | `1` | Railway's proxy sits in front of the app; this makes the sign-in attempt limit count each visitor separately |
| `MEDVAULT_SIGNUP_CODE` | a code you choose, e.g. `try-medvault-24` | Only people you give the code to can create accounts. Leave it unset to let anyone sign up |

`MEDVAULT_DATA_DIR` is already set to `/data` by the Dockerfile, and Railway sets `PORT` itself.

## 5. Deploy

```bash
railway up
```

This uploads this folder, builds the Dockerfile and starts the app. The first build takes a minute or two.

## 6. Get the public address

In the service's **Settings → Networking**, choose **Generate Domain**. Railway gives you an address like
`https://medvault-production-1234.up.railway.app`. Open it on your phone and computer, create an account with your
sign-up code, and try everything.

Share links and QR codes use this address automatically, so doctors can open them from anywhere.

## Updating after changes

Run `railway up` from this folder again. Your data stays on the volume.

## If something goes wrong

- **The deploy fails:** open the deployment's **Logs** in the dashboard. The app prints
  `MedVault running at … (data in /data)` when it starts correctly.
- **Everything is gone after a redeploy:** the volume isn't mounted at `/data` (step 3).
- **"Too many attempts" for everyone at once:** Railway's proxy setup has changed so the visitor's address isn't the
  last `X-Forwarded-For` entry. Remove `TRUST_PROXY` and tell whoever maintains MedVault.
- **Files won't open after you changed `MEDVAULT_KEY`:** put the original key back. Files encrypted with one key can't
  be read with another.

## Backups

Railway volumes can be backed up from the dashboard. Also download your own copy from MedVault's Account page
("Download all my records") from time to time.
