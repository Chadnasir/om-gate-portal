'use strict';

/**
 * Seeds a sample multi-page OM PDF as an encrypted listing for demo.
 * Usage: node scripts/seed-demo.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { JsonDb } = require('../lib/db');
const { createObjectStore } = require('../lib/s3-stub');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

async function makeTinyOm() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [
    {
      title: 'CONFIDENTIAL OFFERING MEMORANDUM',
      lines: [
        '4 Corporate Plaza — Suite 240 (Sample)',
        'Irvine, California',
        '',
        'Prepared for qualified investors only.',
        'California Commercial Advisors / eXp',
        'Chad Nasir  ·  (949) 358-0056',
        'sales@realestateca.org',
      ],
    },
    {
      title: 'Property Overview',
      lines: [
        'Asset class: Office condominium',
        'Approximate SF: Sample data for demo portal',
        'This multi-page PDF demonstrates per-viewer watermarking.',
        'Each authorized viewer receives a unique stamped copy.',
      ],
    },
    {
      title: 'Disclaimer',
      lines: [
        'Confidential offering materials.',
        'Information is believed reliable but not guaranteed.',
        'Do not copy or redistribute without authorization.',
      ],
    },
  ];

  for (const p of pages) {
    const page = doc.addPage([612, 792]);
    page.drawText(p.title, { x: 50, y: 720, size: 16, font, color: rgb(0.043, 0.173, 0.373) });
    let y = 680;
    for (const line of p.lines) {
      page.drawText(line, { x: 50, y, size: 11, font: fontReg, color: rgb(0.1, 0.1, 0.1) });
      y -= 22;
    }
  }
  return Buffer.from(await doc.save());
}

async function main() {
  if (!process.env.FILE_ENCRYPTION_KEY) {
    console.error('Missing FILE_ENCRYPTION_KEY — create .env.local first');
    process.exit(1);
  }

  const db = new JsonDb(path.join(DATA_DIR, 'db.json'));
  await db.init();
  const store = await createObjectStore(DATA_DIR);

  const pdfBuf = await makeTinyOm();
  console.log('Generated tiny 3-page sample OM PDF');

  const objectKey = crypto.randomUUID();
  await store.put(objectKey, pdfBuf);

  const listing = {
    id: crypto.randomUUID(),
    title: '4 Corporate Plaza Suite 240 — Sample OM',
    objectKey,
    requireNda: true,
    expiryHours: 72,
    active: true,
    originalName: 'sample-om-demo.pdf',
    sizeBytes: pdfBuf.length,
    createdAt: Date.now(),
  };
  await db.createListing(listing);

  console.log('Seeded listing:');
  console.log('  id:', listing.id);
  console.log('  title:', listing.title);
  console.log('  gate:', `http://127.0.0.1:8790/l/${listing.id}`);
  console.log('  NDA required: yes');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
