import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const BASE = process.env.OM_BASE || 'http://127.0.0.1:8879';
const OUT = path.resolve('qa-shots');
const LISTING = process.env.OM_LISTING;
const ADMIN_PW = process.env.OM_ADMIN_PW;
const CHROME = process.env.CHROME || '/usr/bin/google-chrome-stable';

if (!LISTING || !ADMIN_PW) {
  console.error('OM_LISTING and OM_ADMIN_PW required');
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,1100'],
  defaultViewport: { width: 1440, height: 1100, deviceScaleFactor: 1 },
});

const page = await browser.newPage();

async function shot(name, url, wait = 700) {
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 45000 });
  await new Promise((r) => setTimeout(r, wait));
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log('shot', name);
}

await shot('01-landing', `${BASE}/`);
await shot('02-gate-form', `${BASE}/l/${LISTING}`);
await shot('07-error-404', `${BASE}/does-not-exist-qa`);
await shot('07b-gate-missing', `${BASE}/l/00000000-0000-0000-0000-000000000000`);

// Gate → viewer
await page.goto(`${BASE}/l/${LISTING}`, { waitUntil: 'networkidle0' });
await page.click('#name', { clickCount: 3 });
await page.type('#name', 'Jordan Lee QA');
await page.click('#email', { clickCount: 3 });
await page.type('#email', 'jordan.lee@example.com');
const nda = await page.$('#nda');
if (nda) {
  const checked = await page.$eval('#nda', (el) => el.checked);
  if (!checked) await nda.click();
}
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 45000 }).catch(() => null),
  page.click('button[type="submit"]'),
]);
await new Promise((r) => setTimeout(r, 1000));
await page.screenshot({ path: path.join(OUT, '03-viewer.png'), fullPage: true });
console.log('shot 03-viewer', page.url());

await shot('04-admin-login', `${BASE}/admin/login`);
await page.goto(`${BASE}/admin/login`, { waitUntil: 'networkidle0' });
await page.type('#password', ADMIN_PW);
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 45000 }),
  page.click('button[type="submit"]'),
]);
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: path.join(OUT, '06-admin-listings.png'), fullPage: true });
console.log('shot 06-admin-listings', page.url());

// upload tab — support tab= or ?tab=
for (const u of [
  `${BASE}/admin/dashboard?tab=upload`,
  `${BASE}/admin/dashboard?tab=upload`,
]) {
  await page.goto(u, { waitUntil: 'networkidle0' });
  const hasDz = await page.$('.dropzone, #dz, input[type=file]');
  if (hasDz) {
    await new Promise((r) => setTimeout(r, 700));
    await page.screenshot({ path: path.join(OUT, '05-admin-upload.png'), fullPage: true });
    console.log('shot 05-admin-upload', u);
    break;
  }
}

await page.goto(`${BASE}/admin/dashboard?tab=leads`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: path.join(OUT, '07c-admin-leads.png'), fullPage: true });
console.log('shot 07c-admin-leads');

await browser.close();
console.log('done');
