'use strict';

/**
 * HubSpot Forms API submit. Stubs gracefully when env vars missing.
 * Env: HUBSPOT_PORTAL_ID, HUBSPOT_FORM_ID, optional HUBSPOT_ACCESS_TOKEN
 */

function maskEmail(email) {
  if (!email || typeof email !== 'string') return '[no-email]';
  const [u, d] = email.split('@');
  if (!d) return '***';
  return (u.slice(0, 2) || '*') + '***@' + d;
}

async function submitLeadToHubSpot(lead) {
  const portalId = process.env.HUBSPOT_PORTAL_ID;
  const formId = process.env.HUBSPOT_FORM_ID;
  const token = process.env.HUBSPOT_ACCESS_TOKEN;

  if (!portalId || !formId) {
    console.log(
      `[hubspot] SKIP (missing HUBSPOT_PORTAL_ID/HUBSPOT_FORM_ID) — would sync lead ${maskEmail(lead.email)}`
    );
    return { ok: false, skipped: true, reason: 'missing_config' };
  }

  const fields = [
    { name: 'email', value: lead.email },
    { name: 'firstname', value: (lead.name || '').split(/\s+/)[0] || lead.name || '' },
    { name: 'lastname', value: (lead.name || '').split(/\s+/).slice(1).join(' ') || '' },
  ];
  if (lead.company) fields.push({ name: 'company', value: lead.company });
  if (lead.phone) fields.push({ name: 'phone', value: lead.phone });

  const body = {
    fields,
    context: {
      pageUri: lead.pageUri || '',
      pageName: lead.listingTitle || 'OM Gate',
    },
  };

  const url = `https://api.hsforms.com/submissions/v3/integration/submit/${portalId}/${formId}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[hubspot] submit failed status=${res.status} lead=${maskEmail(lead.email)} body=${text.slice(0, 120)}`);
      return { ok: false, status: res.status };
    }
    console.log(`[hubspot] synced lead ${maskEmail(lead.email)}`);
    return { ok: true };
  } catch (e) {
    console.warn(`[hubspot] network error for ${maskEmail(lead.email)}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { submitLeadToHubSpot, maskEmail };
