'use strict';

require('dotenv').config({ path: '.env.local' });
require('dotenv').config(); // fallback .env

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const cookieSession = require('cookie-session');
const rateLimit = require('express-rate-limit');
const uuidv4 = () => crypto.randomUUID();

const { JsonDb } = require('./lib/db');
const { createObjectStore } = require('./lib/s3-stub');
const { issueToken, verifyToken, ttlHours } = require('./lib/tokens');
const { watermarkPdf, cacheKey } = require('./lib/watermark');
const { submitLeadToHubSpot, maskEmail } = require('./lib/hubspot');
const {
  hashIp,
  sanitizeName,
  sanitizeOptional,
  isValidEmail,
  escapeHtml,
  checkOrigin,
} = require('./lib/util');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PORT = parseInt(process.env.PORT || '8790', 10);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';
/** UX analytics — set in .env.local; never invent IDs. Gate/admin chrome only (not PDF bytes). */
const CLARITY_PROJECT_ID = (process.env.CLARITY_PROJECT_ID || '').trim();
const HOTJAR_SITE_ID = (process.env.HOTJAR_SITE_ID || '').trim();

function requireEnvSecrets() {
  const need = ['ADMIN_PASSWORD', 'TOKEN_HMAC_SECRET', 'FILE_ENCRYPTION_KEY', 'SESSION_SECRET'];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('Missing required env: ' + missing.join(', ') + ' — copy .env.example to .env.local');
    process.exit(1);
  }
  if (process.env.FILE_ENCRYPTION_KEY.length !== 64) {
    console.error('FILE_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
    process.exit(1);
  }
}

requireEnvSecrets();

const app = express();
const db = new JsonDb(path.join(DATA_DIR, 'db.json'));
let objectStore;

// Trust proxy only if PUBLIC_HOST set (behind reverse proxy)
if (PUBLIC_HOST) app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': [
          "'self'",
          'https://www.clarity.ms',
          'https://scripts.clarity.ms',
          'https://static.hotjar.com',
          'https://script.hotjar.com',
        ],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'https://www.clarity.ms', 'https://*.hotjar.com'],
        'connect-src': [
          "'self'",
          'https://www.clarity.ms',
          'https://*.clarity.ms',
          'https://*.hotjar.com',
          'https://*.hotjar.io',
        ],
        'frame-src': ["'self'", 'https://vars.hotjar.com'],
        'frame-ancestors': ["'none'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
  })
);

app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '64kb' }));

app.use(
  cookieSession({
    name: 'om_admin',
    keys: [process.env.SESSION_SECRET],
    maxAge: 8 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: !!PUBLIC_HOST && PUBLIC_HOST.startsWith('https'),
    path: '/',
  })
);

// No directory listing — only serve explicit static assets
app.use('/css', express.static(path.join(ROOT, 'public/css'), { index: false, maxAge: '1h' }));
app.use('/js', express.static(path.join(ROOT, 'public/js'), { index: false, maxAge: '1h' }));

const gateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests. Please try again later.',
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts.',
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    if (file.mimetype === 'application/pdf') return cb(null, true);
    cb(new Error('Only PDF uploads are allowed. Convert Word (.docx) to PDF before uploading.'));
  },
});


/**
 * Resolve viewer email from lead store after HMAC verify.
 * Token payload is opaque (no PII); missing/mismatched lead → unauthorized.
 */
function resolveLeadForToken(payload) {
  if (!payload || !payload.leadId || !payload.lid) return null;
  const lead = db.getLead(payload.leadId);
  if (!lead || !lead.email) return null;
  if (lead.listingId !== payload.lid) return null;
  return lead;
}


function layout({ title, body, admin, analytics, privacy }) {
  const contact = `
    <div class="contact-strip">
      <span class="chip-name">Chad Nasir</span>
      <a href="tel:+19493580056">(949) 358-0056</a>
      <a href="mailto:sales@realestateca.org">sales@realestateca.org</a>
    </div>`;
  const nav = admin
    ? `<div class="contact-strip">
         <a href="/admin/dashboard">Dashboard</a>
         <a href="/admin/dashboard?tab=upload">Upload</a>
         <a href="/admin/logout">Logout</a>
       </div>`
    : contact;

  // Analytics only on gate/admin chrome when env IDs are set — never on /v/:token/pdf bytes
  const useAnalytics = !!analytics;
  const clarityMeta = useAnalytics && CLARITY_PROJECT_ID
    ? `<meta name="ux-clarity-id" content="${escapeHtml(CLARITY_PROJECT_ID)}" />`
    : '';
  const hotjarMeta = useAnalytics && HOTJAR_SITE_ID
    ? `<meta name="ux-hotjar-id" content="${escapeHtml(HOTJAR_SITE_ID)}" />
  <meta name="ux-hotjar-version" content="${escapeHtml(String(process.env.HOTJAR_VERSION || '6').trim())}" />`
    : '';
  const analyticsBoot = [];
  if (useAnalytics && CLARITY_PROJECT_ID) {
    analyticsBoot.push('window.__UX_CLARITY_ID=' + JSON.stringify(CLARITY_PROJECT_ID) + ';');
  }
  if (useAnalytics && HOTJAR_SITE_ID) {
    analyticsBoot.push('window.__UX_HOTJAR_ID=' + JSON.stringify(Number(HOTJAR_SITE_ID) || HOTJAR_SITE_ID) + ';');
  }
  const analyticsInline = analyticsBoot.length
    ? '<script>' + analyticsBoot.join('') + '</script>'
    : '';
  const analyticsScripts = [];
  if (useAnalytics && CLARITY_PROJECT_ID) {
    analyticsScripts.push('<script src="/js/clarity-loader.js" defer></script>');
  }
  if (useAnalytics && HOTJAR_SITE_ID) {
    analyticsScripts.push('<script src="/js/hotjar-loader.js" defer></script>');
  }

  const privacyNote = (admin || privacy)
    ? `<p class="privacy-note">Session analytics may record clicks on the portal UI when Clarity (or Hotjar) is configured. Analytics attach to gate/form/admin chrome only — not to confidential PDF byte streams. Mask sensitive inputs where possible.</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <meta name="theme-color" content="#0B2C5F" />
  ${clarityMeta}
  ${hotjarMeta}
  <title>${escapeHtml(title)} · OM Portal</title>
  <link rel="stylesheet" href="/css/brand.css" />
  ${analyticsInline}
  ${analyticsScripts.join('\n  ')}
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="brand-block">
      <div class="brand-mark-icon" aria-hidden="true">CA</div>
      <div class="brand-text">
        <div class="brand-mark">California Commercial Advisors <span>·</span> eXp</div>
        <div class="brand-sub">Confidential offering portal</div>
      </div>
    </div>
    ${nav}
  </header>
  ${body}
  <footer class="site-footer">
    <div class="footer-rule" aria-hidden="true"></div>
    <strong>Chad Nasir</strong> · California Commercial Advisors / eXp ·
    <a href="tel:+19493580056">(949) 358-0056</a> ·
    <a href="mailto:sales@realestateca.org">sales@realestateca.org</a>
    <p class="disclaimer">
      Confidential offering materials. Intended solely for the named recipient.
      Do not copy, forward, or distribute without written authorization.
      Information is believed reliable but not guaranteed.
    </p>
    ${privacyNote}
  </footer>
</body>
</html>`;
}


function requireAdmin(req, res, next) {
  if (req.session && req.session.admin === true) return next();
  return res.redirect('/admin/login');
}

function requireAdminMutation(req, res, next) {
  if (!req.session || req.session.admin !== true) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // SameSite cookie + origin/referer check for CSRF defense
  if (req.method !== 'GET' && req.method !== 'HEAD' && !checkOrigin(req)) {
    return res.status(403).json({ error: 'Invalid origin' });
  }
  return next();
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'om-gate-portal',
    bind: BIND_HOST,
    publicHost: PUBLIC_HOST || null,
    store: process.env.AWS_S3_BUCKET ? 's3-or-fallback' : 'local-encrypted',
  });
});

app.get('/', (req, res) => {
  res.type('html').send(
    layout({
      title: 'Offering Memorandum Portal',
      analytics: true,
      body: `<main id="main" class="wrap">
        <div class="page-hero">
          <div class="page-kicker">Private deal room</div>
          <h1>Gated Offering Memorandum Portal</h1>
          <p class="lead">Institutional-grade access control for confidential CRE offering materials.</p>
        </div>
        <div class="card home-hero-card">
          <p style="margin:0 0 0.75rem;color:var(--muted)">Prospects open a private listing link from your broker, verify identity, and receive a watermarked OM. Brokers manage listings and track every view from the admin console.</p>
          <div class="trust-bar">
            <span class="trust-pill">Signed expiring links</span>
            <span class="trust-pill">Per-viewer watermark</span>
            <span class="trust-pill">AES-256 encrypted at rest</span>
          </div>
          <div class="home-actions">
            <a class="btn btn-navy" href="/admin">Broker admin</a>
          </div>
        </div>
      </main>`,
    })
  );
});

// ---------- Gate: /l/:listingId ----------
app.get('/l/:listingId', gateLimiter, (req, res) => {
  const listing = db.getListing(req.params.listingId);
  if (!listing || listing.active === false) {
    return res.status(404).type('html').send(
      layout({
        title: 'Not found',
        analytics: true,
        body: `<main id="main" class="wrap">
          <div class="card smart-empty">
            <div class="empty-state">
              <div class="empty-icon" aria-hidden="true">⊘</div>
              <div class="empty-kicker">Private invitation</div>
              <h3>This invitation is private</h3>
              <p>Ask your broker for a listing link — this page only opens from a private invite.</p>
              <div class="empty-actions">
                <a class="btn btn-primary btn-block" href="mailto:sales@realestateca.org">Contact broker</a>
                <a class="btn btn-ghost btn-block" href="/">Home</a>
              </div>
            </div>
          </div>
        </main>`,
      })
    );
  }
  const ndaBlock = listing.requireNda
    ? `<div class="checkbox-row">
         <input type="checkbox" id="nda" name="nda" value="1" required />
         <label for="nda" style="font-weight:500;margin:0;cursor:pointer">
           I agree to treat these materials as <strong>confidential under NDA terms</strong> and will not share them with third parties without written authorization.
         </label>
       </div>`
    : '';

  const err = req.query.err ? `<div class="alert alert-error" role="alert">${escapeHtml(String(req.query.err))}</div>` : '';

  res.type('html').send(
    layout({
      title: listing.title,
      analytics: true,
      body: `<main id="main" class="wrap">
        <div class="page-hero">
          <div class="page-kicker">Confidential access</div>
          <div style="display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;margin-bottom:0.55rem">
            <span class="lock-badge">Secure gate</span>
            <span class="trust-pill">Watermarked · Expiring link</span>
          </div>
          <h1 style="font-size:clamp(1.55rem,2.6vw,2rem)">${escapeHtml(listing.title)}</h1>
          <p class="lead">Verify your identity to receive a unique watermarked Offering Memorandum.</p>
        </div>
        <div class="card card-split">
          <div class="panel-form">
            <h2 style="margin-top:0;font-size:1.15rem;color:var(--navy)">Request access</h2>
            ${err}
            <form method="POST" action="/l/${encodeURIComponent(listing.id)}/gate" autocomplete="on">
              <div class="field">
                <label for="name">Full name *</label>
                <input id="name" name="name" type="text" required maxlength="120" placeholder="Jordan Lee" data-clarity-mask="true" autocomplete="name" />
              </div>
              <div class="field">
                <label for="email">Work email *</label>
                <input id="email" name="email" type="email" required maxlength="254" placeholder="you@firm.com" data-clarity-mask="true" autocomplete="email" />
              </div>
              <div class="field-row">
                <div class="field">
                  <label for="company">Company <span class="hint" style="display:inline;font-weight:500">(optional)</span></label>
                  <input id="company" name="company" type="text" maxlength="120" placeholder="Firm name" data-clarity-mask="true" />
                </div>
                <div class="field">
                  <label for="phone">Phone <span class="hint" style="display:inline;font-weight:500">(optional)</span></label>
                  <input id="phone" name="phone" type="tel" maxlength="40" placeholder="(949) 555-0100" data-clarity-mask="true" autocomplete="tel" />
                </div>
              </div>
              ${ndaBlock}
              <button class="btn btn-block btn-icon" type="submit">View Offering Memorandum</button>
            </form>
            <div class="trust-bar">
              <span class="trust-pill">Link expires automatically</span>
              <span class="trust-pill">Watermarked per viewer</span>
            </div>
          </div>
          <aside class="panel-aside">
            <div>
              <div class="page-kicker" style="color:var(--orange)">Why gated</div>
              <h3 class="aside-title">Protecting confidential deal materials</h3>
              <p class="aside-copy">Every download is logged, watermarked with your email, and issued only after identity capture.</p>
              <ul class="aside-list">
                <li>HMAC-signed, time-limited access tokens</li>
                <li>Documents encrypted at rest (AES-256-GCM)</li>
                <li>Broker-visible lead &amp; view history</li>
              </ul>
            </div>
            <p class="aside-copy" style="font-size:0.8rem;margin:0">California Commercial Advisors / eXp · Chad Nasir</p>
          </aside>
        </div>
      </main>`,
    })
  );
});

app.post('/l/:listingId/gate', gateLimiter, async (req, res) => {
  try {
    const listing = db.getListing(req.params.listingId);
    if (!listing || listing.active === false) {
      return res.status(404).send('Listing unavailable');
    }

    const name = sanitizeName(req.body.name);
    const email = (req.body.email || '').trim().toLowerCase();
    const company = sanitizeOptional(req.body.company);
    const phone = sanitizeOptional(req.body.phone, 40);

    if (!name || name.length < 2) {
      return res.redirect(`/l/${listing.id}?err=${encodeURIComponent('Please enter your full name.')}`);
    }
    if (!isValidEmail(email)) {
      return res.redirect(`/l/${listing.id}?err=${encodeURIComponent('Please enter a valid email.')}`);
    }
    if (listing.requireNda && req.body.nda !== '1') {
      return res.redirect(`/l/${listing.id}?err=${encodeURIComponent('NDA acceptance is required.')}`);
    }

    const leadId = uuidv4();
    const lead = {
      id: leadId,
      listingId: listing.id,
      listingTitle: listing.title,
      name,
      email,
      company: company || null,
      phone: phone || null,
      ndaAccepted: !!listing.requireNda,
      createdAt: Date.now(),
    };
    await db.createLead(lead);

    // HubSpot — stub if env missing; never block access
    submitLeadToHubSpot({
      ...lead,
      pageUri: `${req.protocol}://${req.get('host')}/l/${listing.id}`,
    }).catch(() => {});

    const hours = listing.expiryHours || ttlHours();
    const { token } = issueToken({
      listingId: listing.id,
      leadId,
      ttlHoursOverride: hours,
    });

    console.log(`[gate] access granted listing=${listing.id} lead=${maskEmail(email)}`);
    return res.redirect(`/v/${token}`);
  } catch (e) {
    console.error('[gate] error', e.message);
    return res.status(500).send('Unable to process request.');
  }
});

// ---------- Viewer: /v/:token ----------
app.get('/v/:token', gateLimiter, async (req, res) => {
  try {
    const payload = verifyToken(req.params.token);
    if (!payload) {
      return res.status(403).type('html').send(
        layout({
          title: 'Link expired',
          analytics: true,
          body: `<main id="main" class="wrap">
            <div class="card" style="text-align:center;padding:2.75rem 1.5rem">
              <div class="page-kicker" style="justify-content:center">Access expired</div>
              <h1>Link invalid or expired</h1>
              <p class="lead" style="margin:0 auto 1.25rem">For security, OM links expire automatically. Return to your listing invitation or contact your broker for a fresh link.</p>
              <a class="btn btn-ghost" href="/">Return home</a>
            </div>
          </main>`,
        })
      );
    }

    const lead = resolveLeadForToken(payload);
    if (!lead) {
      return res.status(403).type('html').send(
        layout({
          title: 'Link expired',
          analytics: true,
          body: `<main id="main" class="wrap">
            <div class="card" style="text-align:center;padding:2.75rem 1.5rem">
              <div class="page-kicker" style="justify-content:center">Access expired</div>
              <h1>Link invalid or expired</h1>
              <p class="lead" style="margin:0 auto 1.25rem">For security, OM links expire automatically. Return to your listing invitation or contact your broker for a fresh link.</p>
              <a class="btn btn-ghost" href="/">Return home</a>
            </div>
          </main>`,
        })
      );
    }
    const viewerEmail = lead.email;

    const listing = db.getListing(payload.lid);
    if (!listing || !listing.objectKey) {
      return res.status(404).send('Document unavailable');
    }

    // Viewer shell with iframe/embed of PDF stream
    // Actual bytes served from /v/:token/pdf after re-validation
    const pdfUrl = `/v/${encodeURIComponent(req.params.token)}/pdf`;

    await db.addView({
      id: uuidv4(),
      listingId: listing.id,
      leadId: payload.leadId,
      emailMasked: maskEmail(viewerEmail),
      at: Date.now(),
      ipHash: hashIp(req.ip),
      kind: 'shell',
    });

    res.type('html').send(
      layout({
        title: listing.title,
        analytics: true,
        body: `<main id="main" class="wrap wrap-wide">
          <div class="page-hero" style="margin-bottom:1rem">
            <div class="page-kicker">Watermarked document</div>
            <h1 style="font-size:clamp(1.45rem,2.4vw,1.85rem)">${escapeHtml(listing.title)}</h1>
          </div>
          <div class="card card-flush">
            <div class="viewer-toolbar">
              <div>
                <p style="margin:0;font-weight:650;color:var(--navy)">Offering Memorandum</p>
                <p class="hint" style="margin:0.3rem 0 0">Issued for ${escapeHtml(maskEmail(viewerEmail))} · Confidential · Do not redistribute</p>
              </div>
              <div class="row-actions">
                <span class="lock-badge">Live session</span>
                <a class="btn btn-sm btn-ghost" href="${pdfUrl}" target="_blank" rel="noopener">Open in new tab</a>
              </div>
            </div>
            <div class="viewer-frame-wrap">
              <iframe class="viewer-frame" title="Offering Memorandum" src="${pdfUrl}"></iframe>
            </div>
          </div>
        </main>`,
      })
    );
  } catch (e) {
    console.error('[viewer] error', e.message);
    res.status(500).send('Viewer error');
  }
});

app.get('/v/:token/pdf', gateLimiter, async (req, res) => {
  try {
    const payload = verifyToken(req.params.token);
    if (!payload) return res.status(403).send('Forbidden');

    const lead = resolveLeadForToken(payload);
    if (!lead) return res.status(403).send('Forbidden');
    const viewerEmail = lead.email;

    const listing = db.getListing(payload.lid);
    if (!listing || !listing.objectKey) return res.status(404).send('Not found');

    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const ck = cacheKey(listing.id, viewerEmail, listing.objectKey);

    let pdfBuf;
    if (await objectStore.exists(ck)) {
      pdfBuf = await objectStore.get(ck);
    } else {
      const source = await objectStore.get(listing.objectKey);
      pdfBuf = await watermarkPdf(source, { email: viewerEmail, timestamp: ts });
      await objectStore.put(ck, pdfBuf);
    }

    await db.addView({
      id: uuidv4(),
      listingId: listing.id,
      leadId: payload.leadId,
      emailMasked: maskEmail(viewerEmail),
      at: Date.now(),
      ipHash: hashIp(req.ip),
      kind: 'pdf',
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="offering-memorandum.pdf"',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(pdfBuf);
  } catch (e) {
    console.error('[pdf] error', e.message);
    res.status(500).send('Unable to load document');
  }
});

// ---------- Admin ----------
app.get('/admin', (req, res) => {
  if (req.session && req.session.admin) return res.redirect('/admin/dashboard');
  return res.redirect('/admin/login');
});

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.admin) return res.redirect('/admin/dashboard');
  const err = req.query.err
    ? `<div class="alert alert-error" role="alert">${escapeHtml(String(req.query.err))}</div>`
    : '';
  res.type('html').send(
    layout({
      title: 'Admin login',
      admin: false,
      analytics: true,
      privacy: true,
      body: `<main id="main" class="login-shell">
        <div class="card login-card">
          <div class="brand-mini">
            <div class="brand-mark-icon" aria-hidden="true">CA</div>
            <div>
              <div class="page-kicker" style="margin:0">Broker console</div>
              <strong style="color:var(--navy)">OM Portal Admin</strong>
            </div>
          </div>
          <h1 style="font-size:1.75rem">Sign in</h1>
          <p class="lead" style="margin-bottom:1.25rem">Manage listings, leads, and confidential document access.</p>
          ${err}
          <form method="POST" action="/admin/login">
            <div class="field">
              <label for="password">Admin password</label>
              <input id="password" name="password" type="password" required autocomplete="current-password" placeholder="••••••••••••" />
            </div>
            <button class="btn btn-primary btn-block" type="submit">Sign in to dashboard</button>
          </form>
          <p class="hint" style="margin-top:1.1rem;text-align:center">Authorized personnel only. Sessions are httpOnly and expire automatically.</p>
        </div>
      </main>`,
    })
  );
});

app.post('/admin/login', adminLoginLimiter, (req, res) => {
  const pw = req.body.password || '';
  const expected = process.env.ADMIN_PASSWORD;
  const a = Buffer.from(pw);
  const b = Buffer.from(expected);
  // timing-safe compare with length guard
  let ok = false;
  if (a.length === b.length) {
    ok = crypto.timingSafeEqual(a, b);
  } else {
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32)); // burn
  }
  if (!ok) {
    console.warn('[admin] failed login attempt');
    return res.redirect('/admin/login?err=' + encodeURIComponent('Invalid password'));
  }
  req.session.admin = true;
  req.session.loginAt = Date.now();
  return res.redirect('/admin/dashboard');
});

app.get('/admin/logout', (req, res) => {
  req.session = null;
  res.redirect('/admin/login');
});

app.get('/admin/dashboard', requireAdmin, (req, res) => {
  const tab = req.query.tab || 'listings';
  const listings = db.listListings();
  const leads = db.listLeads();
  const views = db.listViews();

  const stats = `
    <div class="stats">
      <div class="stat"><div class="n">${listings.length}</div><div class="l">Listings</div></div>
      <div class="stat"><div class="n">${leads.length}</div><div class="l">Leads</div></div>
      <div class="stat"><div class="n">${views.filter((v) => v.kind === 'pdf').length}</div><div class="l">PDF views</div></div>
    </div>`;

  const tabs = `
    <div class="tabs" role="tablist">
      <a class="tab ${tab === 'listings' ? 'active' : ''}" href="/admin/dashboard?tab=listings">Listings</a>
      <a class="tab ${tab === 'leads' ? 'active' : ''}" href="/admin/dashboard?tab=leads">Leads</a>
      <a class="tab ${tab === 'views' ? 'active' : ''}" href="/admin/dashboard?tab=views">Views</a>
      <a class="tab ${tab === 'upload' ? 'active' : ''}" href="/admin/dashboard?tab=upload">Upload OM</a>
    </div>`;

  let panel = '';
  if (tab === 'upload') {
    panel = `
      <div class="card">
        <h2>Upload Offering Memorandum</h2>
        <div class="alert alert-info">PDF only — convert Word (.docx) to PDF before upload. Files are encrypted at rest (AES-256-GCM) using random UUID object keys.</div>
        <form id="uploadForm" method="POST" action="/admin/upload" enctype="multipart/form-data">
          <div class="field">
            <label for="title">Listing title *</label>
            <input id="title" name="title" type="text" required maxlength="200" placeholder="e.g. 4 Corporate Plaza Suite 240" />
          </div>
          <div class="field-row">
            <div class="field">
              <label for="expiryHours">Access link TTL (hours)</label>
              <input id="expiryHours" name="expiryHours" type="number" min="1" max="720" value="${ttlHours()}" />
            </div>
            <div class="field" style="display:flex;align-items:flex-end">
              <div class="checkbox-row" style="width:100%;margin:0">
                <input type="checkbox" id="requireNda" name="requireNda" value="1" />
                <label for="requireNda" style="margin:0;font-weight:500;cursor:pointer">Require NDA before access</label>
              </div>
            </div>
          </div>
          <div class="field">
            <label>OM PDF *</label>
            <div class="dropzone" id="dz">
              <div class="dz-icon" aria-hidden="true">PDF</div>
              <p class="dz-title">Drag &amp; drop your OM PDF</p>
              <p>or click to browse — 40MB max · application/pdf only</p>
              <input class="sr-only" type="file" id="file" name="file" accept="application/pdf,.pdf" required />
              <p id="dzName" class="hint"></p>
            </div>
          </div>
          <button class="btn btn-icon" type="submit">Upload &amp; create listing</button>
        </form>
      </div>
      <script src="/js/admin-upload.js"></script>`;
  } else if (tab === 'leads') {
    const rows = leads
      .map(
        (l) => `<tr>
        <td>${escapeHtml(l.name)}</td>
        <td>${escapeHtml(maskEmail(l.email))}</td>
        <td>${escapeHtml(l.company || '—')}</td>
        <td>${escapeHtml(l.listingTitle || l.listingId)}</td>
        <td>${new Date(l.createdAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT</td>
        <td>${l.ndaAccepted ? '<span class="badge">NDA</span>' : '—'}</td>
      </tr>`
      )
      .join('');
    panel = `<div class="card"><h2>Leads</h2><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Company</th><th>Listing</th><th>When</th><th>NDA</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6"><div class="empty"><div class="empty-icon">◎</div><h3>No leads yet</h3><p>When prospects pass the gate, they will appear here.</p></div></td></tr>'}</tbody>
    </table></div></div>`;
  } else if (tab === 'views') {
    const rows = views
      .slice(0, 200)
      .map(
        (v) => `<tr>
        <td>${escapeHtml(v.emailMasked || '—')}</td>
        <td class="mono">${escapeHtml(v.listingId)}</td>
        <td><span class="badge">${escapeHtml(v.kind)}</span></td>
        <td>${new Date(v.at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT</td>
        <td class="mono">${escapeHtml(v.ipHash || '—')}</td>
      </tr>`
      )
      .join('');
    panel = `<div class="card"><h2>Views</h2><p class="hint">IP stored as salted hash only. Emails masked in logs/UI.</p>
      <div class="table-wrap"><table>
      <thead><tr><th>Viewer</th><th>Listing</th><th>Kind</th><th>When</th><th>IP hash</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5"><div class="empty smart-empty"><div class="empty-icon">◉</div><div class="empty-kicker">A quiet dashboard is a good start</div><h3>No views yet</h3><p>Share the gate link. Views and leads show up here after the first open.</p><div class="empty-preview" aria-hidden="true"><span></span><span></span><span></span></div><a class="btn btn-sm btn-navy" href="/admin/dashboard?tab=listings">View share links</a></div></td></tr>'}</tbody>
    </table></div></div>`;
  } else {
    const host = PUBLIC_HOST || `http://${BIND_HOST}:${PORT}`;
    const rows = listings
      .map((l) => {
        const gateUrl = `${host}/l/${l.id}`;
        return `<tr>
          <td><strong>${escapeHtml(l.title)}</strong><div class="hint mono">${escapeHtml(l.id)}</div></td>
          <td>${l.requireNda ? '<span class="badge badge-warn">NDA</span>' : '—'}</td>
          <td>${l.expiryHours || ttlHours()}h</td>
          <td>${l.active === false ? 'Off' : 'On'}</td>
          <td class="row-actions">
            <button type="button" class="btn btn-sm btn-ghost copy-link" data-url="${escapeHtml(gateUrl)}">Copy share link</button>
            <form method="POST" action="/admin/listings/${encodeURIComponent(l.id)}/toggle" style="display:inline">
              <button class="btn btn-sm btn-ghost" type="submit">${l.active === false ? 'Activate' : 'Deactivate'}</button>
            </form>
          </td>
        </tr>`;
      })
      .join('');
    panel = `<div class="card"><h2>Listings</h2>
      <p class="hint">Share the gate URL (<code>/l/:id</code>), never a direct file path.</p>
      <div class="table-wrap"><table>
      <thead><tr><th>Title</th><th>NDA</th><th>TTL</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5"><div class="empty smart-empty"><div class="empty-icon">▢</div><div class="empty-kicker">Your next deal room starts here</div><h3>Drop your first OM PDF here</h3><p>Prospects only see it after they pass the gate.</p><div class="empty-preview" aria-hidden="true"><span></span><span></span><span></span></div><a class="btn btn-primary" id="emptyUploadCta" href="/admin/dashboard?tab=upload#dz">Upload first OM</a></div></td></tr>'}</tbody>
    </table></div></div>
    <script src="/js/admin-copy.js"></script>`;
  }

  res.type('html').send(
    layout({
      title: 'Admin',
      admin: true,
      analytics: true,
      body: `<main class="wrap wrap-wide">
        <div class="admin-top">
          <div>
            <div class="page-kicker">Broker console</div>
            <h1>OM Admin</h1>
            <p class="lead">Manage listings, capture leads, and audit document access.</p>
          </div>
          <a class="btn btn-sm" href="/admin/dashboard?tab=upload#dz">New upload</a>
        </div>
        ${stats}${tabs}${panel}
      </main>`,
    })
  );
});

app.post('/admin/upload', requireAdmin, requireAdminMutation, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      return res.status(400).type('html').send(
        layout({
          title: 'Upload error',
          admin: true,
          analytics: true,
          body: `<main class="wrap"><div class="card"><div class="alert alert-error">${escapeHtml(err.message)}</div>
            <a class="btn btn-ghost" href="/admin/dashboard?tab=upload">Back</a></div></main>`,
        })
      );
    }
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).send('PDF file required');
      }
      // Double-check magic bytes %PDF
      const head = req.file.buffer.subarray(0, 5).toString('utf8');
      if (!head.startsWith('%PDF')) {
        return res.status(400).send('File does not look like a PDF');
      }

      const title = sanitizeOptional(req.body.title, 200);
      if (!title) return res.status(400).send('Title required');

      let expiryHours = parseInt(req.body.expiryHours, 10);
      if (!Number.isFinite(expiryHours) || expiryHours < 1 || expiryHours > 720) {
        expiryHours = ttlHours();
      }
      const requireNda = req.body.requireNda === '1';

      const objectKey = uuidv4();
      await objectStore.put(objectKey, req.file.buffer);

      const listing = {
        id: uuidv4(),
        title,
        objectKey,
        requireNda,
        expiryHours,
        active: true,
        originalName: sanitizeOptional(req.file.originalname, 180) || 'document.pdf',
        sizeBytes: req.file.buffer.length,
        createdAt: Date.now(),
      };
      await db.createListing(listing);

      console.log(`[admin] listing created id=${listing.id} bytes=${listing.sizeBytes}`);
      return res.redirect('/admin/dashboard?tab=listings');
    } catch (e) {
      console.error('[admin] upload failed', e.message);
      return res.status(500).send('Upload failed');
    }
  });
});

app.post('/admin/listings/:id/toggle', requireAdmin, requireAdminMutation, async (req, res) => {
  const listing = db.getListing(req.params.id);
  if (!listing) return res.status(404).send('Not found');
  await db.updateListing(listing.id, { active: listing.active === false });
  return res.redirect('/admin/dashboard?tab=listings');
});

// 404
app.use((req, res) => {
  res.status(404).type('html').send(
    layout({
      title: 'Not found',
      body: `<main class="wrap"><div class="card"><h1>Not found</h1></div></main>`,
    })
  );
});

app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).send('Server error');
});

async function main() {
  await db.init();
  objectStore = await createObjectStore(DATA_DIR);

  app.listen(PORT, BIND_HOST, () => {
    console.log(`[om-gate] listening on http://${BIND_HOST}:${PORT}`);
    if (!PUBLIC_HOST) {
      console.log('[om-gate] PUBLIC_HOST unset — bound to loopback only. Docs always require signed tokens.');
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
