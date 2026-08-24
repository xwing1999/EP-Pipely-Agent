import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// AUTH — shared-secret pattern, same as every other agent in this project.
// /oauth/* stays exempt (one-time browser flow, no header a redirect can
// carry).
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/oauth/')) return next();
  const provided = req.header('x-api-key');
  if (!process.env.API_KEY || provided !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ---------------------------------------------------------------------------
// XERO OAUTH TOKEN MANAGEMENT — same pattern as wellington-xero-agent.
// READ-ONLY scopes only: this agent checks reconciliation, it never writes
// to Xero. If you later want it to auto-create the invoice instead of just
// flagging a mismatch, that's a bigger process change (it replaces the
// current manual "raise the invoice inside Pipely" step) — confirm that
// separately before adding write scopes here.
// ---------------------------------------------------------------------------
const TOKEN_FILE = process.env.XERO_TOKEN_FILE || '/data/xero-token.json';

const tokenState = {
  accessToken: null,
  refreshToken: process.env.XERO_REFRESH_TOKEN || null,
  tenantId: process.env.XERO_TENANT_ID || null,
  expiresAt: 0
};

function loadPersistedToken() {
  try {
    const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (saved.refreshToken) tokenState.refreshToken = saved.refreshToken;
    if (saved.tenantId) tokenState.tenantId = saved.tenantId;
    console.log('Loaded persisted Xero token from disk.');
  } catch {
    // No persisted file yet, or no volume mounted — fall back to env vars.
  }
}
loadPersistedToken();

function persistToken() {
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({
      refreshToken: tokenState.refreshToken,
      tenantId: tokenState.tenantId
    }));
  } catch (err) {
    console.warn(
      'Could not persist Xero token to disk (no volume mounted at ' + TOKEN_FILE + '?). ' +
      'Relying on in-memory cache + env var fallback. Error:', err.message
    );
  }
}

async function refreshAccessToken() {
  if (!tokenState.refreshToken) {
    throw new Error('No Xero refresh token available yet — visit /oauth/start in a browser to authorize this agent.');
  }
  const res = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString('base64')
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokenState.refreshToken })
  });
  if (!res.ok) {
    throw new Error(`Xero token refresh failed ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  tokenState.accessToken = data.access_token;
  tokenState.refreshToken = data.refresh_token;
  tokenState.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  console.log('Xero access token refreshed. New refresh_token (fallback only — prefer the persisted file):', tokenState.refreshToken);
  persistToken();

  if (!tokenState.tenantId) {
    const connRes = await fetch('https://api.xero.com/connections', {
      headers: { Authorization: `Bearer ${tokenState.accessToken}` }
    });
    const conns = await connRes.json();
    if (!conns.length) throw new Error('No Xero tenant connections found for this token.');
    tokenState.tenantId = conns[0].tenantId;
    persistToken();
  }
}

async function getAccessToken() {
  if (!tokenState.accessToken || Date.now() >= tokenState.expiresAt) {
    await refreshAccessToken();
  }
  return tokenState.accessToken;
}

async function xeroRequest(pathSegment, { params, headers = {} } = {}) {
  const token = await getAccessToken();
  const url = new URL(pathSegment, 'https://api.xero.com/api.xro/2.0/');
  if (params) Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Xero-tenant-id': tokenState.tenantId,
      Accept: 'application/json',
      ...headers
    }
  });
  if (!res.ok) {
    throw new Error(`Xero API error ${res.status} on GET ${pathSegment}: ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

app.get('/oauth/start', (_req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.XERO_CLIENT_ID,
    redirect_uri: process.env.XERO_REDIRECT_URI,
    scope: 'accounting.invoices.read accounting.contacts offline_access',
    state: 'setup'
  });
  res.redirect(`https://login.xero.com/identity/connect/authorize?${params}`);
});

app.get('/oauth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`Xero returned an error: ${error}`);
  if (!code) return res.status(400).send('Missing code parameter.');

  try {
    const tokenRes = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.XERO_REDIRECT_URI
      })
    });
    if (!tokenRes.ok) throw new Error(await tokenRes.text());
    const data = await tokenRes.json();

    tokenState.accessToken = data.access_token;
    tokenState.refreshToken = data.refresh_token;
    tokenState.expiresAt = Date.now() + (data.expires_in - 60) * 1000;

    const connRes = await fetch('https://api.xero.com/connections', {
      headers: { Authorization: `Bearer ${tokenState.accessToken}` }
    });
    const conns = await connRes.json();
    tokenState.tenantId = conns[0]?.tenantId ?? null;
    persistToken();

    res.send(`
      <h2>Xero connected</h2>
      <p>Organisation: ${conns[0]?.tenantName ?? 'unknown'}</p>
      <p>Tenant ID: ${tokenState.tenantId ?? 'not found'}</p>
      <p>Confirm this says Everest Plunge, not Kiwiseal. This is saved. If this
      Railway service has no persistent volume attached, also copy this refresh
      token into the <code>XERO_REFRESH_TOKEN</code> Railway variable as a
      backup so a future restart doesn't strand this agent:</p>
      <pre>${tokenState.refreshToken}</pre>
      <p>You can close this tab.</p>
    `);
  } catch (err) {
    res.status(500).send(`Token exchange failed: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// PIPELY (GoHighLevel/LeadConnector) — same proven REST pattern as
// franchisor-revenue-agent's fetchPipelyWonOpportunities, but single-
// location (Everest Plunge is one business, not three franchises).
// ---------------------------------------------------------------------------
const PIPELY_BASE_URL = process.env.PIPELY_BASE_URL || 'https://services.leadconnectorhq.com';

async function fetchPipelyWonOpportunities(sinceDate) {
  if (!process.env.PIPELY_API_KEY) throw new Error('PIPELY_API_KEY not configured');
  if (!process.env.PIPELY_LOCATION_ID) throw new Error('PIPELY_LOCATION_ID not configured');

  const all = [];
  let startAfter, startAfterId;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ location_id: process.env.PIPELY_LOCATION_ID, limit: '100', status: 'won' });
    if (startAfter) params.set('startAfter', startAfter);
    if (startAfterId) params.set('startAfterId', startAfterId);
    const res = await fetch(`${PIPELY_BASE_URL}/opportunities/search?${params}`, {
      headers: { Authorization: `Bearer ${process.env.PIPELY_API_KEY}`, Version: '2021-07-28' }
    });
    if (!res.ok) throw new Error(`Pipely API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const batch = data.opportunities ?? [];
    all.push(...batch);
    if (!data.meta?.nextPage || batch.length < 100) break;
    startAfter = String(data.meta.startAfter);
    startAfterId = data.meta.startAfterId;
  }
  return sinceDate ? all.filter((o) => new Date(o.lastStageChangeAt ?? o.createdAt).getTime() >= sinceDate) : all;
}

async function fetchPipelyContact(contactId) {
  const res = await fetch(`${PIPELY_BASE_URL}/contacts/${contactId}`, {
    headers: { Authorization: `Bearer ${process.env.PIPELY_API_KEY}`, Version: '2021-07-28' }
  });
  if (!res.ok) throw new Error(`Pipely contact lookup error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.contact ?? data;
}

// ---------------------------------------------------------------------------
// RECONCILIATION
//
// Matching signal: email only. Xavier's own matching discipline for
// cross-system records (see CLAUDE.md) ranks phone above email, with
// name/address/value as corroborating-only — but Xero's Contacts API
// `where` filter can't reliably query into the nested Phones array, so
// email is the strongest signal actually queryable here. If email-based
// matching produces too many false "no match" flags in practice, revisit
// this with phone as a fallback lookup.
//
// A "match" means: a Xero contact exists for that email AND has at least
// one invoice within VALUE_TOLERANCE of the Pipely deal value. This does
// NOT create or touch anything in Xero — read-only, flag-only.
// ---------------------------------------------------------------------------
const VALUE_TOLERANCE = Number(process.env.VALUE_TOLERANCE ?? 1); // dollars

async function checkOpportunity(opp) {
  const contact = await fetchPipelyContact(opp.contactId);
  const email = contact.email;
  const dealValue = Number(opp.monetaryValue ?? 0);

  if (!email) {
    return { ok: false, reason: 'Pipely contact has no email — cannot match against Xero', opportunity: summarizeOpp(opp) };
  }

  const xeroContacts = await xeroRequest('Contacts', { params: { where: `EmailAddress=="${email}"` } });
  if (!xeroContacts.Contacts?.length) {
    return { ok: false, reason: `No Xero contact found for ${email} — deal may not be invoiced yet, or invoiced under a different email`, opportunity: summarizeOpp(opp) };
  }

  const contactIds = xeroContacts.Contacts.map((c) => c.ContactID);
  const invoiceData = await xeroRequest('Invoices', { params: { ContactIDs: contactIds.join(',') } });
  const invoices = invoiceData.Invoices ?? [];
  const matchingInvoice = invoices.find((inv) => Math.abs(Number(inv.Total ?? 0) - dealValue) <= VALUE_TOLERANCE);

  if (!matchingInvoice) {
    return {
      ok: false,
      reason: invoices.length
        ? `Xero contact found for ${email}, but no invoice matches the deal value ($${dealValue}) within $${VALUE_TOLERANCE}`
        : `Xero contact found for ${email}, but has no invoices at all`,
      opportunity: summarizeOpp(opp)
    };
  }

  return { ok: true };
}

function summarizeOpp(opp) {
  return { opportunityId: opp.id, name: opp.name, value: opp.monetaryValue, wonAt: opp.lastStageChangeAt ?? opp.createdAt };
}

const MISMATCH_FILE = process.env.MISMATCH_FILE || '/data/pipely-xero-mismatches.json';

function persistMismatches(mismatches) {
  try {
    fs.mkdirSync(path.dirname(MISMATCH_FILE), { recursive: true });
    fs.writeFileSync(MISMATCH_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), mismatches }, null, 2));
  } catch (err) {
    console.warn('Could not persist mismatch log to disk:', err.message);
  }
}

function loadMismatches() {
  try {
    return JSON.parse(fs.readFileSync(MISMATCH_FILE, 'utf8'));
  } catch {
    return { generatedAt: null, mismatches: [] };
  }
}

// Recomputes the FULL current mismatch state on every run (not an
// append-only log) — this is a periodic snapshot of "what's currently
// unreconciled", not a record of past events, so a deal that reconciles
// correctly on a later run should disappear from the list rather than
// leaving a stale flag behind.
async function runReconciliation() {
  const lookbackDays = Number(process.env.RECONCILE_LOOKBACK_DAYS ?? 30);
  const sinceDate = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  const opportunities = await fetchPipelyWonOpportunities(sinceDate);
  const mismatches = [];

  for (const opp of opportunities) {
    try {
      const result = await checkOpportunity(opp);
      if (!result.ok) mismatches.push({ ...result.opportunity, reason: result.reason });
    } catch (err) {
      mismatches.push({ ...summarizeOpp(opp), reason: `Check failed: ${err.message}` });
    }
  }

  persistMismatches(mismatches);
  console.log(`Reconciliation run: ${opportunities.length} won deals checked, ${mismatches.length} unreconciled.`);
  return mismatches;
}

let reconciliationTimer = null;
function scheduleReconciliation() {
  const intervalMinutes = Number(process.env.CHECK_INTERVAL_MINUTES ?? 60);
  // Run once immediately on startup — otherwise /admin/mismatches reads as
  // "nothing wrong" for up to a full interval, which looks identical to
  // "checked, all clean" even though nothing has actually run yet. Also
  // covers the case where Xero OAuth hasn't been completed yet at boot
  // (throws, gets caught, logged, and the schedule still proceeds normally).
  runReconciliation().catch((err) => console.error('Initial reconciliation run failed:', err.message));
  reconciliationTimer = setInterval(() => {
    runReconciliation().catch((err) => console.error('Scheduled reconciliation run failed:', err.message));
  }, intervalMinutes * 60 * 1000);
}
scheduleReconciliation();

// ---------------------------------------------------------------------------
// ADMIN ENDPOINTS
// ---------------------------------------------------------------------------
app.get('/admin/mismatches', (_req, res) => {
  res.json(loadMismatches());
});

app.post('/admin/run-check', async (_req, res) => {
  try {
    const mismatches = await runReconciliation();
    res.json({ ok: true, mismatchCount: mismatches.length, mismatches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3008;
app.listen(port, () => console.log(`Everest Plunge Pipely-Xero Reconciliation Agent listening on :${port}`));
