# Security summary — OM Gate Portal

## Lockdowns

| Control | Implementation |
|--------|----------------|
| No unauthenticated docs | PDFs only via HMAC-signed `/v/:token` after gate submit |
| Bind address | Default `127.0.0.1`; `PUBLIC_HOST` does not bypass token checks |
| Admin auth | httpOnly `cookie-session` + `ADMIN_PASSWORD` (timing-safe compare) |
| Secrets | `.env.local` / env only — gitignored; **mode 600** (not world-readable); never commit keys |
| Encryption at rest | AES-256-GCM (`FILE_ENCRYPTION_KEY`); random UUID object keys |
| TLS in transit | Required when deployed (reverse proxy); S3 SDK uses HTTPS |
| Input validation | `validator` + length caps; PDF MIME + `%PDF` magic bytes |
| Rate limits | Gate + admin login (`express-rate-limit`) |
| CSRF | SameSite cookies + Origin/Referer host check on admin mutations |
| Path traversal | Object-key allowlist; resolve under `data/objects` |
| Headers | Helmet CSP, `X-Content-Type-Options`, no `X-Powered-By`, no dir listing |
| Body limits | JSON/urlencoded 64kb; upload 40MB |
| Logging | Emails masked (`ab***@domain`); never log PDF bytes |
| Watermarks | Unique per viewer; cached encrypted copies |
| Tokens | HMAC-SHA256 opaque payload (`v,lid,leadId,exp,nonce` only — **no PII/email in URL**); `crypto.randomBytes` nonce; configurable TTL |
| IP privacy | Optional salted SHA-256 hash only in view log |

## Threat notes

- Share **gate URLs** (`/l/:id`), never object keys or filesystem paths.
- Rotate `ADMIN_PASSWORD`, `TOKEN_HMAC_SECRET`, `FILE_ENCRYPTION_KEY`, `SESSION_SECRET` if leaked.
- Place behind TLS terminator + firewall when exposing beyond loopback.
- HubSpot / AWS credentials stay in env or a secrets manager — not in repo.


## Opaque access tokens (no PII in query string)

Viewer URLs are `/v/:token`. The signed token body is **opaque**: it carries listing id, lead id, expiry, and nonce only — **never cleartext email or other PII**. Watermark and "Issued for …" UI resolve the viewer email **server-side** from the lead store (`leadId` + matching `listingId`) after HMAC + expiry verification. If the lead is missing or mismatched, treat as unauthorized (no OM bytes). Do not put emails in shareable links or logs beyond masked form (`ab***@domain`).

## Out of scope

Outbound email sequences, auto-replies, and reply templates are intentionally excluded.
