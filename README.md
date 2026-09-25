# OM Gate Portal

Gated Offering Memorandum portal for **Chad Nasir** — California Commercial Advisors / eXp.

Prospects see confidential OM PDFs only after submitting a lead form. Each viewer gets a unique watermarked copy via a signed, expiring link. Files are encrypted at rest (AES-256-GCM).

## Features

- Branded gate pages (`/l/:listingId`) with optional NDA checkbox
- Lead capture (name, email, optional company/phone) → local DB + optional HubSpot Forms API
- Admin upload (PDF only; drag-and-drop) with encrypted object storage
- HMAC-signed expiring viewer tokens (default 72h; opaque payload — no email/PII in the URL)
- Per-viewer PDF watermarking (email + timestamp on every page) via pdf-lib
- View tracking + admin dashboard (listings, leads, views)
- Security hardening (Helmet, rate limits, httpOnly admin sessions, path allowlists, CSRF origin checks)

**Excluded:** email reply templates, auto-replies, outbound mail sequences.

## Quick start

```bash
cd om-gate
cp .env.example .env.local
chmod 600 .env.local   # secrets must not be world-readable
# Set strong ADMIN_PASSWORD, TOKEN_HMAC_SECRET (openssl rand -hex 32),
# FILE_ENCRYPTION_KEY (openssl rand -hex 32), SESSION_SECRET

npm install
npm run seed          # optional demo listing
npm start             # http://127.0.0.1:8790
```

Default bind is **127.0.0.1** only. Do not expose without TLS + reverse proxy.

## UX analytics (optional)

Step-by-step for Chad: [`/workspace/design-toolkit/ux/CLARITY-SETUP.md`](../design-toolkit/ux/CLARITY-SETUP.md).

The portal loads `/js/clarity-loader.js` only when `CLARITY_PROJECT_ID` is set. Set it to the real Microsoft Clarity project ID in `.env.local` to enable heatmaps/session insights; do not invent or commit a project ID. Hotjar is similarly opt-in with `HOTJAR_SITE_ID` (and optional `HOTJAR_VERSION`). Analytics loaders are included on the HTML shell only, never on raw PDF bytes.


## Box note (local demo)

On some shared boxes port **8790** may already be bound by an egress helper. This project's `.env.local` may use **8879** instead. Prefer `PORT=8790` on a clean host.

Live demo on this machine: `http://127.0.0.1:8879` (loopback only — no public tunnel).

## Admin

1. Open http://127.0.0.1:8790/admin
2. Sign in with `ADMIN_PASSWORD` from `.env.local`
3. Upload OM → copy share link (`/l/:id`) for prospects

## Prospect flow

`/l/:listingId` → form (+ NDA) → lead stored / HubSpot stub → redirect `/v/:token` → watermarked PDF inline

## HubSpot

Set in `.env.local` (all optional — missing values stub gracefully and still grant access):

- `HUBSPOT_PORTAL_ID`
- `HUBSPOT_FORM_ID`
- `HUBSPOT_ACCESS_TOKEN` (optional Bearer)

## AWS S3 encrypted store

Local store is default under `data/objects/*.enc`. To swap:

1. Install `@aws-sdk/client-s3`
2. Set `AWS_S3_BUCKET`, `AWS_REGION`, credentials (or IAM role)
3. Optional `AWS_S3_PREFIX=om-gate/`

`lib/s3-stub.js` provides `S3EncryptedStore` + `createObjectStore()` factory.

## Deploy notes

This is a Node/Express app with encrypted local (or S3) storage — **not** a static Netlify/Tiiny site. Preferred publish path: GitHub + run on a VPS/container with env secrets, TLS, and bind behind a reverse proxy. Set `PUBLIC_HOST=https://your.domain` when behind HTTPS. Documents still always require signed tokens.

## Stack

Node 18+, Express, cookie-session, Helmet, multer, pdf-lib, JSON DB, AES-256-GCM `LocalEncryptedStore`.

## License

UNLICENSED — private for Chad Nasir / California Commercial Advisors.
