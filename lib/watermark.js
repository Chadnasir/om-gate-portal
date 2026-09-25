'use strict';

const crypto = require('crypto');
const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');

function cacheKey(listingId, email, objectKey) {
  const h = crypto
    .createHash('sha256')
    .update(`${listingId}|${String(email).toLowerCase()}|${objectKey}`)
    .digest('hex');
  return `wm-${h}`;
}

async function watermarkPdf(pdfBytes, { email, timestamp }) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const label = `${email}  ·  ${timestamp}  ·  CONFIDENTIAL`;
  const size = 10;
  const color = rgb(0.55, 0.55, 0.55);

  for (const page of pages) {
    const { width, height } = page.getSize();
    page.drawText(label, {
      x: width * 0.12,
      y: height * 0.45,
      size,
      font,
      color,
      opacity: 0.35,
      rotate: degrees(35),
    });
    page.drawText(label, {
      x: 24,
      y: 14,
      size: 7,
      font,
      color: rgb(0.4, 0.4, 0.4),
      opacity: 0.7,
    });
    page.drawText('CONFIDENTIAL — Offering Memorandum', {
      x: 24,
      y: height - 18,
      size: 7,
      font,
      color: rgb(0.11, 0.17, 0.37),
      opacity: 0.8,
    });
  }

  return Buffer.from(await doc.save());
}

module.exports = { watermarkPdf, cacheKey };
