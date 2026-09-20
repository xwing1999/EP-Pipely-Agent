import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// KEYED LOCK — added 2026-08-31 after an audit found a real race: without
// this, two overlapping triggers for the same opportunity (a GHL workflow
// re-run, or a double-click on "send final invoice") could both pass the
// "does an invoice already exist?" check before either finished, creating
// two deposit or two final invoices for one deal. Serializes calls sharing
// a key within this process — sufficient at this scale (one Railway
// instance).
// ---------------------------------------------------------------------------
const locks = new Map();
function withLock(key, fn) {
  const prevTail = locks.get(key) || Promise.resolve();
  const run = prevTail.then(fn, fn);
  locks.set(key, run.then(() => {}, () => {}));
  return run;
}

// ---------------------------------------------------------------------------
// AUTH — shared-secret pattern, same as every other agent in this project.
// /oauth/* stays exempt (one-time browser flow, no header a redirect can
// carry), and /webhooks/* stays exempt too — GoHighLevel's workflow
// webhook action has its own separate secret check (verifyPipelyWebhookSecret,
// further down) rather than sending an x-api-key header.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/oauth/') || req.path.startsWith('/webhooks/')) return next();
  const provided = req.header('x-api-key');
  if (!process.env.API_KEY || provided !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ---------------------------------------------------------------------------
// XERO OAUTH TOKEN MANAGEMENT — same pattern as wellington-xero-agent. Both
// read (reconciliation) and write (deposit invoicing, added 2026-08-24 —
// see "DEPOSIT INVOICING" below) scopes are requested.
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

// Retries once on a 429 (rate limit) — added 2026-09-17 after
// /admin/invoice-check's extra per-deal Xero lookups (checking Reference
// directly for every won-stage deal, not just ones with a Pipely invoice)
// started tripping Xero's rate limit across ~25 deals in one run. Honors
// Xero's Retry-After header when present, but capped at 5s — Xero can
// return a much larger Retry-After under sustained rate limiting, and
// this is called synchronously from HTTP admin endpoints, not a background
// job; a genuinely long wait belongs in a client-side retry, not a hung
// request. A real, non-429 error still throws immediately — this is only
// for the "the server itself said to slow down" case, not a general
// retry-on-any-failure.
async function xeroRequest(pathSegment, { method = 'GET', params, body, headers = {}, _retriesLeft = 1 } = {}) {
  const token = await getAccessToken();
  const url = new URL(pathSegment, 'https://api.xero.com/api.xro/2.0/');
  if (params) Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Xero-tenant-id': tokenState.tenantId,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 429 && _retriesLeft > 0) {
    const retryAfterMs = Math.min((Number(res.headers.get('retry-after')) || 2) * 1000, 5000);
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    return xeroRequest(pathSegment, { method, params, body, headers, _retriesLeft: _retriesLeft - 1 });
  }
  if (!res.ok) {
    throw new Error(`Xero API error ${res.status} on ${method} ${pathSegment}: ${await res.text()}`);
  }
  // Some endpoints (e.g. Invoices/{id}/Email) return 204 with an empty body
  // on success — res.json() throws on that. Read as text first.
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// WRITE scopes — this agent now also creates/sends deposit invoices (see
// "DEPOSIT INVOICING" below, added 2026-08-24 once Xavier confirmed he
// wants this automated), not just reading for reconciliation.
//
// accounting.transactions failed live 2026-09-01 with invalid_scope — this
// app was created against a newer Xero API version that's split it into
// granular scopes (accounting.invoices, accounting.contacts, etc., same
// split seen on the Custom Connection screen earlier). accounting.invoices
// covers creating/reading/emailing invoices (this agent never creates
// Payment records directly, so no separate accounting.payments scope is
// needed for what's built today — add it if that changes).
app.get('/oauth/start', (_req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.XERO_CLIENT_ID,
    redirect_uri: process.env.XERO_REDIRECT_URI,
    scope: 'accounting.invoices accounting.contacts offline_access',
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

// Shared paginated fetch — used both for reconciliation (status: 'won') and
// the general deal-visibility endpoint below (status: 'open'). GHL's
// documented status enum for opportunities is open/won/lost/abandoned;
// omitting `status` entirely would return all of them.
async function fetchPipelyOpportunities(status) {
  if (!process.env.PIPELY_API_KEY) throw new Error('PIPELY_API_KEY not configured');
  if (!process.env.PIPELY_LOCATION_ID) throw new Error('PIPELY_LOCATION_ID not configured');

  const all = [];
  let startAfter, startAfterId;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ location_id: process.env.PIPELY_LOCATION_ID, limit: '100' });
    if (status) params.set('status', status);
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
  return all;
}

async function fetchPipelyWonOpportunities(sinceDate) {
  const all = await fetchPipelyOpportunities('won');
  return sinceDate ? all.filter((o) => new Date(o.lastStageChangeAt ?? o.createdAt).getTime() >= sinceDate) : all;
}

// Pipeline/stage names — opportunities only carry pipelineId/pipelineStageId,
// not human-readable names, so the deal-listing endpoint below resolves
// them against this. Not verified against Everest Plunge's real account yet
// (endpoint shape taken from GoHighLevel's documented API) — confirm the
// response actually has {pipelines: [{id, name, stages: [{id, name}]}]}
// once this is deployed and hit for real.
async function fetchPipelyPipelines() {
  if (!process.env.PIPELY_API_KEY) throw new Error('PIPELY_API_KEY not configured');
  if (!process.env.PIPELY_LOCATION_ID) throw new Error('PIPELY_LOCATION_ID not configured');

  const res = await fetch(`${PIPELY_BASE_URL}/opportunities/pipelines?locationId=${process.env.PIPELY_LOCATION_ID}`, {
    headers: { Authorization: `Bearer ${process.env.PIPELY_API_KEY}`, Version: '2021-07-28' }
  });
  if (!res.ok) throw new Error(`Pipely pipelines error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.pipelines ?? [];
}

// Pipely's OWN invoicing feature (GoHighLevel Invoices API) — distinct from
// Xero invoices created elsewhere in this file. Not yet confirmed against
// Everest Plunge's real account (added 2026-09-01, endpoint shape taken
// from GoHighLevel's documented Invoices API: GET /invoices/?altId=
// {locationId}&altType=location). Paginated via `limit`/`offset` per GHL's
// documented shape — capped at 20 pages (2000 invoices) same as the
// opportunities fetchers, logged if hit rather than silently truncating.
async function fetchPipelyInvoices() {
  if (!process.env.PIPELY_API_KEY) throw new Error('PIPELY_API_KEY not configured');
  if (!process.env.PIPELY_LOCATION_ID) throw new Error('PIPELY_LOCATION_ID not configured');

  const all = [];
  const limit = 100;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      altId: process.env.PIPELY_LOCATION_ID,
      altType: 'location',
      limit: String(limit),
      offset: String(page * limit)
    });
    const res = await fetch(`${PIPELY_BASE_URL}/invoices/?${params}`, {
      headers: { Authorization: `Bearer ${process.env.PIPELY_API_KEY}`, Version: '2021-07-28' }
    });
    if (!res.ok) throw new Error(`Pipely invoices error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const batch = data.invoices ?? data.data ?? [];
    all.push(...batch);
    if (batch.length < limit) break;
    if (page === 19) console.warn('fetchPipelyInvoices hit the 2000-invoice pagination cap — results may be incomplete.');
  }
  return all;
}

async function fetchPipelyContact(contactId) {
  const res = await fetch(`${PIPELY_BASE_URL}/contacts/${contactId}`, {
    headers: { Authorization: `Bearer ${process.env.PIPELY_API_KEY}`, Version: '2021-07-28' }
  });
  if (!res.ok) throw new Error(`Pipely contact lookup error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.contact ?? data;
}

async function fetchPipelyOpportunity(opportunityId) {
  const res = await fetch(`${PIPELY_BASE_URL}/opportunities/${opportunityId}`, {
    headers: { Authorization: `Bearer ${process.env.PIPELY_API_KEY}`, Version: '2021-07-28' }
  });
  if (!res.ok) throw new Error(`Pipely opportunity lookup error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.opportunity ?? data;
}

// First write this codebase makes to a Pipely opportunity — every other
// Pipely call in this file is read-only. Added 2026-09-01 for the
// deposit-paid stage sync (see that section below). GoHighLevel's
// documented PUT /opportunities/:id requires BOTH pipelineId and
// pipelineStageId together (setting stage alone isn't accepted), and
// docs list the header as `Version: v3` — a different value than every
// read call in this file uses (`2021-07-28`). Not yet exercised against
// the real account; if this throws a version/auth error on first real
// use, that header is the first thing to check.
async function updatePipelyOpportunityStage(opportunityId, pipelineId, pipelineStageId) {
  const res = await fetch(`${PIPELY_BASE_URL}/opportunities/${opportunityId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${process.env.PIPELY_API_KEY}`,
      Version: 'v3',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ pipelineId, pipelineStageId })
  });
  if (!res.ok) throw new Error(`Pipely opportunity update error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.opportunity ?? data;
}

// ---------------------------------------------------------------------------
// DEPOSIT INVOICING (added 2026-08-24) — Xavier confirmed the booking
// deposit invoice should go out automatically the moment a deal is marked
// accepted: either the client accepts the Qwilr proposal, or a rep drags
// the Pipely opportunity into the "send deposit" pipeline stage. Qwilr has
// no confirmed API/webhook access yet, so only the Pipely-stage trigger is
// wired up below. GoHighLevel's own Workflow automations can fire a
// webhook on a pipeline stage change — that's the intended trigger source
// for /webhooks/pipely/deposit-trigger, not polling.
//
// Deposit amount is DEPOSIT_PERCENTAGE (default 50%) of the opportunity's
// monetaryValue. This creates an ordinary AUTHORISED (unpaid) invoice and
// emails it — unlike the Shopify agent, it does NOT mark it paid, because
// the deposit hasn't actually been paid yet at trigger time; that happens
// later via the client's bank transfer and Xero's own reconciliation.
//
// The final 50% payment ("the week before we ship, must be paid before
// sending") is NOT built here — it depends on a per-order ship date that
// lives in the batch-tab spreadsheet, whose real layout isn't confirmed
// yet. Don't guess that part; it's a separate build once the sheet export
// is in hand.
// ---------------------------------------------------------------------------
const DEPOSIT_PERCENTAGE = Number(process.env.DEPOSIT_PERCENTAGE ?? 0.5);

async function findOrCreateXeroContactForPipely(contact) {
  const email = contact.email;
  if (!email) throw new Error('Pipely contact has no email — cannot match/create a Xero contact.');

  const existing = await xeroRequest('Contacts', { params: { where: `EmailAddress=="${email}"` } });
  if (existing.Contacts?.length) return existing.Contacts[0].ContactID;

  const created = await xeroRequest('Contacts', {
    method: 'PUT',
    body: {
      Contacts: [{
        Name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.name || email,
        EmailAddress: email,
        Addresses: contact.address1 ? [{
          AddressType: 'STREET',
          AddressLine1: contact.address1,
          City: contact.city || '',
          Region: contact.state || '',
          PostalCode: contact.postalCode || '',
          Country: contact.country || ''
        }] : []
      }]
    }
  });
  return created.Contacts[0].ContactID;
}

// Locked by opportunity ID — an audit found that without this, two
// overlapping triggers (GHL workflow re-run, a manual re-trigger) could
// both pass the idempotency check below before either finished, creating
// two deposit invoices for one deal.
async function createDepositInvoice(opportunity, contact) {
  return withLock(`deposit:${opportunity.id}`, () => createDepositInvoiceLocked(opportunity, contact));
}

async function createDepositInvoiceLocked(opportunity, contact) {
  const reference = `Deposit - ${opportunity.id}`;

  // Idempotency: this webhook could fire more than once for the same
  // stage-change (GHL workflow re-runs, a manual re-trigger, etc.) — check
  // Xero for an invoice with this Reference before creating a duplicate.
  // Excludes VOIDED/DELETED — audit 2026-08-31: without this, voiding a
  // mistaken deposit invoice in Xero would permanently block a real one
  // from ever being created, since the voided invoice still matches.
  const already = await xeroRequest('Invoices', { params: { where: `Reference=="${reference}"&&Status!="VOIDED"&&Status!="DELETED"` } });
  if (already.Invoices?.length) {
    console.log(`Deposit invoice already exists for opportunity ${opportunity.id} — checking it was actually emailed.`);
    const invoice = already.Invoices[0];
    // Re-sent even on the already-exists path — cheap and safe, and the
    // alternative (previous behavior) silently never emailed at all if
    // the first attempt failed after invoice creation.
    await xeroRequest(`Invoices/${invoice.InvoiceID}/Email`, { method: 'POST' });
    return invoice;
  }

  const dealValue = Number(opportunity.monetaryValue ?? 0);
  if (dealValue <= 0) throw new Error(`Opportunity ${opportunity.id} has no positive monetaryValue — cannot compute a deposit.`);
  const depositAmount = Math.round(dealValue * DEPOSIT_PERCENTAGE * 100) / 100;

  const contactId = await findOrCreateXeroContactForPipely(contact);
  const today = new Date().toISOString().slice(0, 10);

  const invoicePayload = {
    Type: 'ACCREC',
    Contact: { ContactID: contactId },
    LineAmountTypes: 'Inclusive',
    Date: today,
    DueDate: today,
    Reference: reference,
    Status: 'AUTHORISED',
    LineItems: [{
      Description: `${Math.round(DEPOSIT_PERCENTAGE * 100)}% Booking Deposit — ${opportunity.name ?? opportunity.id}`,
      Quantity: 1,
      UnitAmount: depositAmount,
      AccountCode: process.env.XERO_SALES_ACCOUNT_CODE,
      TaxType: process.env.XERO_TAX_TYPE
    }]
  };

  const created = await xeroRequest('Invoices', { method: 'PUT', body: { Invoices: [invoicePayload] } });
  const invoice = created.Invoices[0];

  // Sends via Xero's own email delivery, same as the Shopify agent — not
  // yet exercised against a real Xero org at write time, verify once
  // OAuth is connected.
  await xeroRequest(`Invoices/${invoice.InvoiceID}/Email`, { method: 'POST' });

  return invoice;
}

// ---------------------------------------------------------------------------
// FINAL PAYMENT INVOICING (added 2026-08-31) — the other 50%, per Xavier:
// "50% booking deposit, 50% final payment the week before we ship, must be
// paid before sending." Deliberately NOT triggered automatically on any
// schedule — nothing here knows a real ship date yet (that lives in the
// still-unconfirmed batch tabs). Triggered by a human via
// POST /admin/create-final-invoice once they've decided an order is ready
// to release, from the ops console's ready-to-ship view. Requires the
// deposit invoice to already exist — refuses to invent a final-payment
// amount for a deal that was never deposit-invoiced in the first place.
// ---------------------------------------------------------------------------
// Locked by opportunity ID — same reasoning as createDepositInvoice: an
// audit found two overlapping calls (double-click on "send final invoice",
// or a client retry) could both pass the idempotency check before either
// finished, creating two final invoices for one deal.
async function createFinalInvoice(opportunity, contact) {
  return withLock(`final:${opportunity.id}`, () => createFinalInvoiceLocked(opportunity, contact));
}

async function createFinalInvoiceLocked(opportunity, contact) {
  const depositReference = `Deposit - ${opportunity.id}`;
  const finalReference = `Final Payment - ${opportunity.id}`;

  // Excludes VOIDED/DELETED — a voided deposit invoice must not count as
  // "the deposit exists" (audit 2026-08-31).
  const depositInvoices = await xeroRequest('Invoices', { params: { where: `Reference=="${depositReference}"&&Status!="VOIDED"&&Status!="DELETED"` } });
  if (!depositInvoices.Invoices?.length) {
    throw new Error(`No valid (non-voided) deposit invoice found for opportunity ${opportunity.id} — cannot create a final invoice before the deposit exists.`);
  }

  const already = await xeroRequest('Invoices', { params: { where: `Reference=="${finalReference}"&&Status!="VOIDED"&&Status!="DELETED"` } });
  if (already.Invoices?.length) {
    console.log(`Final invoice already exists for opportunity ${opportunity.id} — checking it was actually emailed and stock-sheet notified.`);
    const invoice = already.Invoices[0];
    await notifyFinalInvoiceCreated(opportunity, invoice);
    return invoice;
  }

  const dealValue = Number(opportunity.monetaryValue ?? 0);
  if (dealValue <= 0) throw new Error(`Opportunity ${opportunity.id} has no positive monetaryValue — cannot compute a final payment.`);
  // Same percentage split as the deposit, not "deal value minus whatever
  // the deposit invoice actually says" — keeps deposit + final summing to
  // exactly the deal value even if the deposit was edited in Xero after
  // the fact, which "deal value minus deposit invoice total" would not.
  const finalAmount = Math.round(dealValue * (1 - DEPOSIT_PERCENTAGE) * 100) / 100;

  const contactId = await findOrCreateXeroContactForPipely(contact);
  const today = new Date().toISOString().slice(0, 10);

  const invoicePayload = {
    Type: 'ACCREC',
    Contact: { ContactID: contactId },
    LineAmountTypes: 'Inclusive',
    Date: today,
    DueDate: today,
    Reference: finalReference,
    Status: 'AUTHORISED',
    LineItems: [{
      Description: `Final Payment — ${opportunity.name ?? opportunity.id}`,
      Quantity: 1,
      UnitAmount: finalAmount,
      AccountCode: process.env.XERO_SALES_ACCOUNT_CODE,
      TaxType: process.env.XERO_TAX_TYPE
    }]
  };

  const created = await xeroRequest('Invoices', { method: 'PUT', body: { Invoices: [invoicePayload] } });
  const invoice = created.Invoices[0];
  await notifyFinalInvoiceCreated(opportunity, invoice);

  return invoice;
}

// Shared by both the newly-created and already-existed paths in
// createFinalInvoiceLocked — an audit found the "already exists" path
// previously skipped email + stock-sheet notification entirely, so a
// failure right after invoice creation (before either of these ran) left
// the invoice permanently un-emailed and the stock sheet never told,
// since a replay would hit "already exists" and short-circuit.
async function notifyFinalInvoiceCreated(opportunity, invoice) {
  // Re-sent even when the invoice already existed — cheap and safe.
  await xeroRequest(`Invoices/${invoice.InvoiceID}/Email`, { method: 'POST' });

  // Best-effort — tells the stock sheet agent this deal is now waiting on
  // final payment, so the ops console's release gate can show it as
  // "Invoiced" rather than "not invoiced". Does not throw: the invoice
  // above is what actually matters and has already succeeded.
  if (process.env.STOCK_SHEET_AGENT_URL) {
    await fetch(`${process.env.STOCK_SHEET_AGENT_URL}/admin/set-final-payment-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.STOCK_SHEET_AGENT_API_KEY },
      body: JSON.stringify({ externalRef: opportunity.id, status: 'Invoiced' })
    }).catch((err) => console.error(`Opportunity ${opportunity.id}: failed to set final payment status on stock sheet:`, err.message));
  }
}

// ---------------------------------------------------------------------------
// FINAL INVOICE SWEEP (added 2026-09-01) — Xavier's replacement for the
// earlier "ship date lives in a spreadsheet, unconfirmed" blocker and for
// Pipely's own "5 - Ops Pipeline" (explicitly being retired, not used for
// this): "I want rather a countdown on orders arriving to shores from
// their container boats and the invoices will go out on that." Confirmed
// same day: the ETA is set per BATCH/shipment, not per order (matches how
// the real spreadsheet already tracks it — one ETA per batch tab, shared
// by every client on that shipment), entered manually by ops (Mainfreight's
// real API isn't confirmed), and the final invoice should go out
// AUTOMATICALLY once an order's batch is within FINAL_INVOICE_LEAD_DAYS of
// its ETA — no human approval step, per Xavier's explicit choice over the
// flagged-for-review alternative.
//
// Runs on the same periodic-timer pattern as reconciliation. Reads
// stock-sheet-agent's Automation Log via its existing GET
// /admin/automation-log, which now resolves a computed "Ship ETA" field
// per entry (from stock-sheet-agent's own batch-ETA store, joined by
// "Batch Reference" — see that agent's BATCH ETA / COUNTDOWN comment).
// Computes days-until-arrival from that, and calls the SAME
// createFinalInvoice used by the human-triggered POST
// /admin/create-final-invoice endpoint — so it inherits that function's
// existing idempotency (checks Xero for an existing "Final Payment -
// {opportunityId}" invoice before creating another) for free. That's what
// makes it safe to run this sweep repeatedly on a schedule without
// double-invoicing an order that's already been handled.
//
// Only acts on entries with an External Ref (linked Pipely opportunity) —
// an order logged without one (e.g. before this field existed, or entered
// by hand with a typo) is skipped and logged, not guessed at.
// ---------------------------------------------------------------------------
const FINAL_INVOICE_LEAD_DAYS = Number(process.env.FINAL_INVOICE_LEAD_DAYS ?? 7);
const FINAL_SWEEP_INTERVAL_MINUTES = Number(process.env.FINAL_SWEEP_INTERVAL_MINUTES ?? 60);
const FINAL_SWEEP_LOG_FILE = process.env.FINAL_SWEEP_LOG_FILE || '/data/final-invoice-sweep-log.json';

async function fetchAutomationLogEntries() {
  if (!process.env.STOCK_SHEET_AGENT_URL) throw new Error('STOCK_SHEET_AGENT_URL not configured');
  const res = await fetch(`${process.env.STOCK_SHEET_AGENT_URL}/admin/automation-log`, {
    headers: { 'x-api-key': process.env.STOCK_SHEET_AGENT_API_KEY }
  });
  if (!res.ok) throw new Error(`Stock sheet agent error ${res.status} on /admin/automation-log: ${await res.text()}`);
  const data = await res.json();
  return data.entries ?? [];
}

function daysUntil(dateStr) {
  const target = new Date(dateStr);
  if (isNaN(target.getTime())) return null;
  const msPerDay = 24 * 60 * 60 * 1000;
  // Compare by calendar day, not exact ms, so "today" reads as 0 rather
  // than a small negative/positive fraction depending on time-of-day.
  const todayUTC = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const targetUTC = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate());
  return Math.round((targetUTC - todayUTC) / msPerDay);
}

function loadFinalSweepLog() {
  try { return JSON.parse(fs.readFileSync(FINAL_SWEEP_LOG_FILE, 'utf8')); } catch { return []; }
}
function appendFinalSweepLog(entry) {
  const log = loadFinalSweepLog();
  log.push({ ...entry, at: new Date().toISOString() });
  try {
    fs.mkdirSync(path.dirname(FINAL_SWEEP_LOG_FILE), { recursive: true });
    fs.writeFileSync(FINAL_SWEEP_LOG_FILE, JSON.stringify(log, null, 2));
  } catch (err) {
    console.warn('Could not persist final-invoice sweep log to disk:', err.message);
  }
}

async function runFinalInvoiceSweep() {
  const entries = await fetchAutomationLogEntries();
  const due = entries.filter((e) => {
    if (!e['Ship ETA'] || !e['External Ref']) return false;
    if (e['Final Payment Status'] === 'Paid' || e['Final Payment Status'] === 'Invoiced') return false;
    if (e['Deposit Status'] === 'Paid in full') return false; // Shopify-style full-payment orders — no final invoice to send
    const days = daysUntil(e['Ship ETA']);
    return days !== null && days <= FINAL_INVOICE_LEAD_DAYS;
  });

  const results = [];
  for (const entry of due) {
    const opportunityId = entry['External Ref'];
    try {
      const opportunity = await fetchPipelyOpportunity(opportunityId);
      const contact = await fetchPipelyContact(opportunity.contactId);
      const invoice = await createFinalInvoice(opportunity, contact);
      results.push({ orderId: entry['Order ID'], opportunityId, ok: true, invoiceNumber: invoice.InvoiceNumber });
      console.log(`Final invoice sweep: order ${entry['Order ID']} (opportunity ${opportunityId}) -> invoice ${invoice.InvoiceNumber}.`);
    } catch (err) {
      results.push({ orderId: entry['Order ID'], opportunityId, ok: false, error: err.message });
      appendFinalSweepLog({ orderId: entry['Order ID'], opportunityId, error: err.message });
      console.error(`Final invoice sweep FAILED for order ${entry['Order ID']} (opportunity ${opportunityId}):`, err.message);
    }
  }

  console.log(`Final invoice sweep: ${entries.length} orders checked, ${due.length} within ${FINAL_INVOICE_LEAD_DAYS}-day window, ${results.filter((r) => r.ok).length} invoiced OK.`);
  return results;
}

let finalSweepTimer = null;
// PAUSE_AUTOMATION (added 2026-09-17) — Xavier: "nothing can be currently
// edited apart from the console using AI... has to request each time...
// until I'm happy with it." Gates only the SCHEDULED/automatic timer
// firing below — the manual POST /admin/run-final-invoice-sweep and
// /admin/run-deposit-sync endpoints deliberately still work even while
// paused, since those only run when a human (via the AI) explicitly asks
// for it right now, which is exactly what "has to request each time" means.
function isAutomationPaused() {
  return process.env.PAUSE_AUTOMATION === 'true';
}

function scheduleFinalInvoiceSweep() {
  const runIfNotPaused = (label) => {
    if (isAutomationPaused()) { console.log(`Final-invoice sweep (${label}) skipped — automation paused.`); return; }
    runFinalInvoiceSweep().catch((err) => console.error(`${label} final-invoice sweep failed:`, err.message));
  };
  runIfNotPaused('Initial');
  finalSweepTimer = setInterval(() => runIfNotPaused('Scheduled'), FINAL_SWEEP_INTERVAL_MINUTES * 60 * 1000);
}
scheduleFinalInvoiceSweep();

const DEPOSIT_FAILED_LOG_FILE = process.env.DEPOSIT_FAILED_LOG_FILE || '/data/deposit-invoice-failures.json';

function loadDepositFailedLog() {
  try { return JSON.parse(fs.readFileSync(DEPOSIT_FAILED_LOG_FILE, 'utf8')); } catch { return []; }
}
function appendDepositFailedLog(entry) {
  const log = loadDepositFailedLog();
  log.push({ ...entry, at: new Date().toISOString() });
  try {
    fs.mkdirSync(path.dirname(DEPOSIT_FAILED_LOG_FILE), { recursive: true });
    fs.writeFileSync(DEPOSIT_FAILED_LOG_FILE, JSON.stringify(log, null, 2));
  } catch (err) {
    console.warn('Could not persist deposit-failure log to disk:', err.message);
  }
}

function extractOpportunityId(body) {
  return body?.opportunityId || body?.opportunity_id || body?.id || body?.opportunity?.id || null;
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

// Disabled 2026-09-20 — this job was found running unconditionally every
// hour (CHECK_INTERVAL_MINUTES default 60), making up to ~50 real Xero API
// calls per run (2 sequential calls -- Contacts + Invoices -- per
// tracked-pipeline opportunity, one at a time, no batching) for a check
// this project's own comments already call "known unreliable" and
// superseded by /admin/invoice-check back on 2026-09-01. Nothing in the
// console links to /admin/mismatches anymore. Left running continuously
// for weeks, this was very likely the dominant contributor to the
// persistent Xero 429 rate-limiting that made both invoice-check and the
// Payment Audit cache unable to get a clean read (Xavier: "heaps of
// errors with the ai stuff here?"). The endpoint and runReconciliation()
// itself are untouched -- /admin/run-check and /admin/mismatches still
// work on demand -- only the automatic hourly re-run is removed.
let reconciliationTimer = null;
function scheduleReconciliation() {
  // Intentionally not called. Kept as a function (not deleted) in case a
  // manual scheduled re-check is ever wanted again with real batching.
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

// ---------------------------------------------------------------------------
// DEAL VISIBILITY (added 2026-09-01) — Xavier wants to see all open Pipely
// deals through this agent, for tracking, independent of the reconciliation/
// invoicing logic above. Pipely-only — does not touch Xero, so this works
// even before Xero OAuth is set up for this agent.
// ---------------------------------------------------------------------------
app.get('/admin/deals', async (req, res) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : 'open';
    const [opportunities, pipelines] = await Promise.all([
      fetchPipelyOpportunities(status),
      fetchPipelyPipelines()
    ]);

    const pipelineNameById = new Map();
    const stageNameById = new Map();
    for (const p of pipelines) {
      pipelineNameById.set(p.id, p.name);
      for (const s of p.stages ?? []) stageNameById.set(s.id, s.name);
    }

    const deals = opportunities.map((o) => ({
      id: o.id,
      name: o.name,
      value: o.monetaryValue,
      status: o.status,
      pipeline: pipelineNameById.get(o.pipelineId) || o.pipelineId,
      stage: stageNameById.get(o.pipelineStageId) || o.pipelineStageId,
      contactId: o.contactId,
      contactName: o.contact?.name || [o.contact?.firstName, o.contact?.lastName].filter(Boolean).join(' ') || null,
      contactEmail: o.contact?.email || null,
      contactPhone: o.contact?.phone || null,
      createdAt: o.createdAt,
      lastStageChangeAt: o.lastStageChangeAt
    }));

    res.json({ count: deals.length, deals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/pipelines', async (_req, res) => {
  try {
    res.json({ pipelines: await fetchPipelyPipelines() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic (added 2026-09-17) — Xavier asked to check what products are
// actually offered in Pipely so the console's SKU dropdown can be
// expanded to match. Two angles: (1) the location's custom field
// definitions, in case a real "Product" picklist field exists (this is
// the field resolveSkuFromOpportunity has been stubbed out waiting on,
// per its comment above), and (2) real opportunity names + a sample of
// full opportunity detail (customFields included), since product info
// may just live in free-text deal names instead. Not a permanent
// feature — remove once this question is answered.
app.get('/admin/pipely-product-diagnostic', async (_req, res) => {
  try {
    const fieldsRes = await fetch(`${PIPELY_BASE_URL}/locations/${process.env.PIPELY_LOCATION_ID}/customFields`, {
      headers: { Authorization: `Bearer ${process.env.PIPELY_API_KEY}`, Version: '2021-07-28' }
    });
    const customFieldsResult = fieldsRes.ok
      ? await fieldsRes.json()
      : { error: `${fieldsRes.status}: ${await fieldsRes.text()}` };

    const opportunities = await fetchPipelyOpportunities();
    const dealNames = opportunities.map((o) => o.name);

    const sample = opportunities.slice(0, 5);
    const sampleDetail = await Promise.all(
      sample.map((o) => fetchPipelyOpportunity(o.id).catch((err) => ({ error: err.message, id: o.id })))
    );

    res.json({ customFieldsResult, dealNameCount: dealNames.length, dealNames, sampleDetail });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic (added 2026-09-01) — raw Xero contact + invoices for one
// email, to answer a real question that came up while testing: does Xero
// actually have ANY invoices for deals Pipely shows as paid, or none at
// all (i.e. Pipely's invoicing might not sync into Xero at all)? Not a
// permanent feature — remove once that's answered and any resulting build
// decision is made.
app.get('/admin/xero-contact-check', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query param is required' });
  try {
    const contacts = await xeroRequest('Contacts', { params: { where: `EmailAddress=="${email}"` } });
    const contactIds = (contacts.Contacts ?? []).map((c) => c.ContactID);
    const invoices = contactIds.length
      ? await xeroRequest('Invoices', { params: { ContactIDs: contactIds.join(',') } })
      : { Invoices: [] };
    res.json({ contacts: contacts.Contacts ?? [], invoices: invoices.Invoices ?? [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Raw pass-through of Pipely's own Invoicing feature — added 2026-09-01 to
// see the real shape before deciding what (if anything) needs shaping into
// its own tracked view, same discovery-first approach as /admin/pipelines.
app.get('/admin/invoices', async (_req, res) => {
  try {
    const invoices = await fetchPipelyInvoices();
    res.json({ count: invoices.length, invoices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DEPOSIT-TO-WON TRACKING (added 2026-09-01) — narrowed scope per Xavier,
// across three messages the same day:
// 1. "the main purpose of the AI and checking system is mainly monitor the
//    transition from deposit sent to won deal and then so on... keep the
//    scope fairly narrow for now."
// 2. "we need to only monitor the end of Joel's pipeline only, he is the
//    only current sales rep."
// 3. "there will be a deposit sent column and the a won month and won all
//    time column, these are the 3 that we will be watching over solely."
// Exactly three numbers, nothing else: depositSent (current snapshot),
// wonThisMonth, wonAllTime.
//
// Confirmed against the real Pipely account (2026-09-01): "2 - Joel -
// Pipeline" has a 5-stage WON sequence, the first being
// "3.1 - WON - Deposit Invoice Sent" — the depositSent bucket below.
// Hardcoded to real pipeline IDs (confirmed live, not guessed).
//
// Also tracks "2 - Dion - Pipeline" (added same day, same real-ID
// discipline) — Dion is Everest Plunge's founder/director, not currently
// doing sales, but Xavier said he will be soon, so track it now rather
// than waiting to add it later. Same identical WON stage sequence
// confirmed live. If a rep's pipeline is ever recreated (new ID), update
// TRACKED_PIPELINES below.
//
// depositSent is matched by STAGE, not opportunity status — Xavier also
// said the same day "we need to only flick a job to the Won status once a
// deposit is paid," implying status currently may (or, going forward,
// should) not flip to 'won' at the Deposit Invoice Sent stage. Trusting
// status for this bucket would risk missing deals if that's ever
// inconsistent; the stage itself is unambiguous.
//
// wonThisMonth/wonAllTime use Pipely's own status='won' — matches
// Xavier's rule as long as the underlying GHL Workflow is actually
// configured to flip status at Deposit Paid, not before (that's a Pipely
// Workflow setting, outside this codebase — confirm it's set that way).
// "This month" is approximated by lastStageChangeAt falling in the current
// calendar month, since Pipely's opportunity object doesn't expose a
// dedicated "became won" timestamp — this is a real approximation: a deal
// that became won two months ago and then moved stage again this month
// (e.g. progressed to "Product To Send") would double up as "this month"
// too. Flagged here rather than silently treated as exact; revisit if it
// produces a visibly wrong count once real data is watched over time.
// ---------------------------------------------------------------------------
const TRACKED_PIPELINES = [
  { id: 'IHzw1og6HSaa5TxKbLTX', rep: 'Joel' }, // "2 - Joel - Pipeline", confirmed live 2026-09-01
  { id: 'UOoyzw59VqVIYfsSQydC', rep: 'Dion' }  // "2 - Dion - Pipeline", confirmed live 2026-09-01
];
const WON_STAGE_LABEL_RE = /WON\s*-\s*(.+)$/i;

function normalizeWonStageLabel(stageName) {
  const match = stageName.match(WON_STAGE_LABEL_RE);
  return match ? match[1].trim() : null;
}

function isThisCalendarMonth(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
}

function summarizeTrackedDeal(o, extra = {}) {
  return {
    id: o.id,
    name: o.name,
    value: o.monetaryValue,
    status: o.status,
    contactName: o.contact?.name || [o.contact?.firstName, o.contact?.lastName].filter(Boolean).join(' ') || null,
    contactEmail: o.contact?.email || null,
    contactPhone: o.contact?.phone || null,
    lastStageChangeAt: o.lastStageChangeAt,
    ...extra
  };
}

// ---------------------------------------------------------------------------
// DEPOSIT-PAID STAGE SYNC (added 2026-09-01) — closes a real gap Xavier
// raised: deposit invoices are created directly in Xero (see DEPOSIT
// INVOICING above), so a sales rep looking at Pipely — "this is where the
// sales reps live" — would have no way to see whether a deposit has
// actually been paid. Rather than build a separate status screen,
// automatically drags the deal into Pipely's own existing "Deposit Paid"
// stage once Xero confirms it — visible right inside the pipeline reps
// already use, no new screen needed.
//
// Runs on the same periodic-timer pattern as the other sweeps. For every
// tracked-pipeline opportunity currently sitting at "Deposit Invoice
// Sent", checks Xero for that deal's deposit invoice (same Reference
// pattern createDepositInvoiceLocked's idempotency check already uses:
// "Deposit - {opportunityId}", excluding VOIDED/DELETED) — if it's paid
// (AmountDue <= 0), moves the opportunity to "Deposit Paid" via
// updatePipelyOpportunityStage. Naturally idempotent: an opportunity
// already at or past "Deposit Paid" won't be at the "Deposit Invoice
// Sent" stage anymore, so it's simply not selected on the next run.
// ---------------------------------------------------------------------------
const DEPOSIT_SYNC_INTERVAL_MINUTES = Number(process.env.DEPOSIT_SYNC_INTERVAL_MINUTES ?? 60);
const DEPOSIT_SYNC_LOG_FILE = process.env.DEPOSIT_SYNC_LOG_FILE || '/data/deposit-sync-log.json';

function loadDepositSyncLog() {
  try { return JSON.parse(fs.readFileSync(DEPOSIT_SYNC_LOG_FILE, 'utf8')); } catch { return []; }
}
function appendDepositSyncLog(entry) {
  const log = loadDepositSyncLog();
  log.push({ ...entry, at: new Date().toISOString() });
  try {
    fs.mkdirSync(path.dirname(DEPOSIT_SYNC_LOG_FILE), { recursive: true });
    fs.writeFileSync(DEPOSIT_SYNC_LOG_FILE, JSON.stringify(log, null, 2));
  } catch (err) {
    console.warn('Could not persist deposit-sync log to disk:', err.message);
  }
}

async function runDepositPaidSync() {
  const [opportunities, pipelines] = await Promise.all([
    fetchPipelyOpportunities(),
    fetchPipelyPipelines()
  ]);

  // Per tracked pipeline, resolve both stage IDs by label — each pipeline
  // has its own copy of these stages with a different ID.
  const stageIdsByPipeline = new Map(); // pipelineId -> { depositSentId, depositPaidId }
  for (const { id } of TRACKED_PIPELINES) {
    const pipeline = pipelines.find((p) => p.id === id);
    const depositSentId = (pipeline?.stages ?? []).find((s) => normalizeWonStageLabel(s.name) === 'Deposit Invoice Sent')?.id;
    const depositPaidId = (pipeline?.stages ?? []).find((s) => normalizeWonStageLabel(s.name) === 'Deposit Paid')?.id;
    if (depositSentId && depositPaidId) stageIdsByPipeline.set(id, { depositSentId, depositPaidId });
  }

  const candidates = opportunities.filter((o) => {
    const stages = stageIdsByPipeline.get(o.pipelineId);
    return stages && o.pipelineStageId === stages.depositSentId;
  });

  const results = [];
  for (const opp of candidates) {
    try {
      const reference = `Deposit - ${opp.id}`;
      const invoiceData = await xeroRequest('Invoices', { params: { where: `Reference=="${reference}"&&Status!="VOIDED"&&Status!="DELETED"` } });
      const invoice = invoiceData.Invoices?.[0];
      if (!invoice) { results.push({ opportunityId: opp.id, ok: true, action: 'skipped — no deposit invoice yet' }); continue; }
      if (Number(invoice.AmountDue ?? 0) > 0.01) { results.push({ opportunityId: opp.id, ok: true, action: 'skipped — not yet paid' }); continue; }

      const { depositPaidId } = stageIdsByPipeline.get(opp.pipelineId);
      await updatePipelyOpportunityStage(opp.id, opp.pipelineId, depositPaidId);
      results.push({ opportunityId: opp.id, ok: true, action: 'moved to Deposit Paid' });
      console.log(`Deposit sync: opportunity ${opp.id} moved to Deposit Paid stage.`);
    } catch (err) {
      results.push({ opportunityId: opp.id, ok: false, error: err.message });
      appendDepositSyncLog({ opportunityId: opp.id, error: err.message });
      console.error(`Deposit sync FAILED for opportunity ${opp.id}:`, err.message);
    }
  }

  console.log(`Deposit sync: ${candidates.length} deals at "Deposit Invoice Sent" checked, ${results.filter((r) => r.action === 'moved to Deposit Paid').length} moved to Deposit Paid.`);
  return results;
}

let depositSyncTimer = null;
function scheduleDepositPaidSync() {
  const runIfNotPaused = (label) => {
    if (isAutomationPaused()) { console.log(`Deposit-paid sync (${label}) skipped — automation paused.`); return; }
    runDepositPaidSync().catch((err) => console.error(`${label} deposit-paid sync failed:`, err.message));
  };
  runIfNotPaused('Initial');
  depositSyncTimer = setInterval(() => runIfNotPaused('Scheduled'), DEPOSIT_SYNC_INTERVAL_MINUTES * 60 * 1000);
}
scheduleDepositPaidSync();

app.get('/admin/deposit-sync-log', (_req, res) => {
  res.json({ failures: loadDepositSyncLog() });
});

app.post('/admin/run-deposit-sync', async (_req, res) => {
  try {
    const results = await runDepositPaidSync();
    res.json({ ok: true, checked: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// STUCK AT DEPOSIT INVOICE SENT (added 2026-09-17) — Xavier: "Dion isn't on
// sales full-time and doesn't update it. So any jobs that are in 3.1 that
// are actually deposit paid, that needs to be flagged to be moved over."
// Read-only twin of runDepositPaidSync's own detection logic above (same
// "Deposit - {id}" Reference check against Xero) — reports which deals are
// stuck at "Deposit Invoice Sent" in Pipely despite Xero showing the
// deposit already paid, WITHOUT moving them. Automation stays paused
// (Xavier: "nothing can be currently edited apart from the console...
// until I'm happy with it") — this only tells staff which ones need a
// manual drag to "Deposit Paid" in Pipely.
//
// Batched, not one Xero call per candidate deal — /admin/invoice-check
// already learned this lesson: sequential per-deal Xero calls reliably
// trip the rate limit once there's more than a handful.
// ---------------------------------------------------------------------------
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

app.get('/admin/stuck-deposit-paid', async (_req, res) => {
  try {
    const [opportunities, pipelines] = await Promise.all([
      fetchPipelyOpportunities(),
      fetchPipelyPipelines()
    ]);

    const depositSentIdByPipeline = new Map();
    for (const { id } of TRACKED_PIPELINES) {
      const pipeline = pipelines.find((p) => p.id === id);
      const depositSentId = (pipeline?.stages ?? []).find((s) => normalizeWonStageLabel(s.name) === 'Deposit Invoice Sent')?.id;
      if (depositSentId) depositSentIdByPipeline.set(id, depositSentId);
    }

    const candidates = opportunities.filter((o) => depositSentIdByPipeline.get(o.pipelineId) === o.pipelineStageId);

    const invoiceByReference = new Map();
    let checkError = null;
    for (const batch of chunkArray(candidates, 15)) {
      if (!batch.length) continue;
      const clause = batch.map((o) => `Reference=="Deposit - ${o.id}"`).join('||');
      try {
        const result = await xeroRequest('Invoices', { params: { where: `(${clause})&&Status!="VOIDED"&&Status!="DELETED"` } });
        for (const inv of result.Invoices ?? []) {
          if (inv.Reference) invoiceByReference.set(inv.Reference, inv);
        }
      } catch (err) {
        checkError = err.message;
      }
    }

    const stuck = [];
    const checkFailed = [];
    for (const opp of candidates) {
      const rep = TRACKED_PIPELINES.find((p) => p.id === opp.pipelineId)?.rep;
      if (checkError) { checkFailed.push({ opportunityId: opp.id, dealName: opp.name, rep, checkError }); continue; }
      const invoice = invoiceByReference.get(`Deposit - ${opp.id}`);
      if (!invoice) continue; // no deposit invoice yet in Xero -- nothing to flag
      if (Number(invoice.AmountDue ?? 0) > 0.01) continue; // genuinely not paid yet

      stuck.push({
        opportunityId: opp.id,
        dealName: opp.name,
        rep,
        xeroInvoiceNumber: invoice.InvoiceNumber,
        xeroAmountPaid: Number(invoice.AmountPaid ?? 0)
      });
    }

    res.json({ count: stuck.length, stuck, checkFailedCount: checkFailed.length, checkFailed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/deposit-to-won', async (_req, res) => {
  try {
    const [allOpportunities, wonOpportunities, pipelines] = await Promise.all([
      fetchPipelyOpportunities(), // no status filter — for depositSent, matched by stage not status
      fetchPipelyOpportunities('won'), // Pipely's own won status — for the two won columns
      fetchPipelyPipelines()
    ]);

    // Per tracked pipeline, find its "Deposit Invoice Sent" stage ID — each
    // rep pipeline has its own copy of that stage with a different ID, even
    // though the name pattern is identical.
    const depositSentStageIdByPipeline = new Map();
    for (const { id, rep } of TRACKED_PIPELINES) {
      const pipeline = pipelines.find((p) => p.id === id);
      const stageId = (pipeline?.stages ?? [])
        .find((s) => normalizeWonStageLabel(s.name) === 'Deposit Invoice Sent')?.id;
      if (stageId) depositSentStageIdByPipeline.set(stageId, rep);
    }

    const depositSentDeals = allOpportunities
      .filter((o) => depositSentStageIdByPipeline.has(o.pipelineStageId))
      .map((o) => summarizeTrackedDeal(o, { rep: depositSentStageIdByPipeline.get(o.pipelineStageId) }));

    const wonAllTimeDeals = wonOpportunities.map((o) => summarizeTrackedDeal(o));
    const wonThisMonthDeals = wonOpportunities
      .filter((o) => isThisCalendarMonth(o.lastStageChangeAt ?? o.createdAt))
      .map(summarizeTrackedDeal);

    res.json({
      depositSent: { count: depositSentDeals.length, deals: depositSentDeals },
      wonThisMonth: { count: wonThisMonthDeals.length, deals: wonThisMonthDeals },
      wonAllTime: { count: wonAllTimeDeals.length, deals: wonAllTimeDeals }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// INVOICE CHECK (added 2026-09-01) — per Xavier: "we want the pipely agent
// to be able to compare over from the sales pipeline and make sure there
// are invoices sitting there... because Xero is our true accounting
// software we need the pipely agent to check with the Xero agent that
// everything matches up. For example an invoice reconciled as paid in
// Xero needs to be showing paid in Pipely." Both halves now built.
//
// Matching keys, both confirmed against real live data on 2026-09-01, NOT
// guessed:
// - Pipely invoice -> opportunity: `opportunityDetails.opportunityId`,
//   exact match against the opportunity's own `id`.
// - Pipely invoice -> Xero invoice: Xero's `InvoiceNumber` equals Pipely's
//   `invoiceNumberPrefix + invoiceNumber` (e.g. "INV-" + "000155" =
//   "INV-000155") — confirmed by cross-referencing a real invoice
//   (Tess Gleeson, Pipely #000155 / Xero INV-000155) found via
//   /admin/xero-contact-check. The original email+value-based
//   reconciliation elsewhere in this file is NOT reliable for this
//   purpose — many Pipely opportunities have `monetaryValue: 0` even when
//   the real Xero invoice total is thousands of dollars, which is why
//   that logic flagged every single won deal as a false mismatch when
//   Xero was first connected.
//
// Known real gap: not every Pipely invoice has `opportunityDetails` set
// (the Tess Gleeson one above has it null) — so hasInvoice below can
// undercount if an invoice exists but was never linked back to its
// opportunity in Pipely. Flagged here rather than silently trusted. This
// does NOT affect the noInvoiceInXero check (see below), which looks at
// Xero directly rather than trusting Pipely's own invoice object.
// ---------------------------------------------------------------------------
function pipelyStatusMatchesXero(pipelyStatus, xeroInvoice) {
  if (!xeroInvoice) return false;
  const amountDue = Number(xeroInvoice.AmountDue ?? 0);
  const amountPaid = Number(xeroInvoice.AmountPaid ?? 0);
  if (pipelyStatus === 'paid') return amountDue <= 0.01 && amountPaid > 0.01;
  if (pipelyStatus === 'sent') return amountPaid <= 0.01;
  if (pipelyStatus === 'partially_paid') return amountPaid > 0.01 && amountDue > 0.01;
  return null; // unrecognized Pipely status — can't judge, not a silent pass
}
// Extracted to a plain function (2026-09-17) so both the live admin route
// AND the scheduled cache-refresh job (see PAYMENT AUDIT CACHE below) share
// one implementation — no behavior change from the route's own perspective.
async function computeInvoiceCheck() {
    const [allOpportunities, invoices, pipelines] = await Promise.all([
      fetchPipelyOpportunities(),
      fetchPipelyInvoices(),
      fetchPipelyPipelines()
    ]);

    // Every stage across tracked pipelines from "Deposit Invoice Sent"
    // onward — any deal that's reached one of these should have an
    // invoice by now.
    const wonStageLabelById = new Map();
    for (const { id } of TRACKED_PIPELINES) {
      const pipeline = pipelines.find((p) => p.id === id);
      for (const s of pipeline?.stages ?? []) {
        const label = normalizeWonStageLabel(s.name);
        if (label) wonStageLabelById.set(s.id, label);
      }
    }

    const invoiceByOpportunityId = new Map();
    for (const inv of invoices) {
      // Confirmed live 2026-09-01: opportunityId is nested under
      // opportunityDetails, not a top-level field — a naive top-level
      // read silently matched zero invoices despite the data being there.
      const oppId = inv.opportunityDetails?.opportunityId;
      if (oppId) invoiceByOpportunityId.set(oppId, inv);
    }

    const checked = [];
    for (const o of allOpportunities) {
      const stage = wonStageLabelById.get(o.pipelineStageId);
      if (!stage) continue; // not far enough along to be expected to have an invoice

      const rep = TRACKED_PIPELINES.find((p) => p.id === o.pipelineId)?.rep;
      const invoice = invoiceByOpportunityId.get(o.id);

      checked.push({
        opportunityId: o.id,
        dealName: o.name,
        rep,
        stage,
        dealValue: o.monetaryValue,
        contactEmail: o.contact?.email || null,
        hasInvoice: Boolean(invoice),
        invoiceNumber: invoice?.invoiceNumber ?? null,
        invoiceStatus: invoice?.status ?? null, // Pipely's own status — 'paid'/'sent'/'partially_paid' seen live
        invoiceTotal: invoice?.invoiceTotal ?? null,
        amountDue: invoice?.amountDue ?? null,
        _xeroInvoiceNumber: invoice ? `${invoice.invoiceNumberPrefix ?? ''}${invoice.invoiceNumber}` : null
      });
    }

    // Batch Xero into a handful of calls total, not one (or two) per deal —
    // an earlier version of this endpoint made up to 2 sequential Xero
    // requests PER checked deal (~35 calls for 25 deals), which reliably
    // tripped Xero's rate limit. Worse, once xeroRequest grew a retry-on-
    // 429 (honoring Xero's real Retry-After header, sometimes tens of
    // seconds), those waits stacked sequentially across every call and
    // made a single /admin/invoice-check request hang for minutes. Fixed
    // by chunking: build the list of every Reference/InvoiceNumber this
    // run needs up front, then fetch them in small batched `where`/
    // InvoiceNumbers queries instead of one round-trip per deal.
    function chunk(arr, size) {
      const out = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    }

    // Xero is the true accounting record — per Xavier 2026-09-17: "Xero is
    // the final resting place... the most important thing is that there is
    // an invoice in Xero. If there is an invoice in pipely but not in xero
    // there is an issue. If one is in xero but not in pipely this is ok."
    // So the real "missing invoice" check is against Xero directly, by the
    // exact Reference this agent itself invoices under (see
    // createDepositInvoiceLocked/createFinalInvoiceLocked) — NOT against
    // whether Pipely's own separate invoice object happens to exist. The
    // old version keyed entirely off Pipely's hasInvoice flag, which
    // falsely flagged plenty of deals that already had a perfectly real
    // Xero invoice, just because Pipely's native invoicing feature wasn't
    // also used for them.
    const invoiceByReference = new Map();
    let referenceCheckError = null;
    const referencePairs = checked.map((c) => ({
      opportunityId: c.opportunityId,
      finalReference: `Final Payment - ${c.opportunityId}`,
      depositReference: `Deposit - ${c.opportunityId}`
    }));
    // 10 deals = 20 References per query — comfortably under Xero's URL
    // length limits while cutting a 25-deal run to ~3 calls instead of 25.
    for (const batch of chunk(referencePairs, 10)) {
      const clause = batch.map((p) => `Reference=="${p.finalReference}"||Reference=="${p.depositReference}"`).join('||');
      try {
        const result = await xeroRequest('Invoices', {
          params: { where: `(${clause})&&Status!="VOIDED"&&Status!="DELETED"` }
        });
        for (const inv of result.Invoices ?? []) {
          if (inv.Reference) invoiceByReference.set(inv.Reference, inv);
        }
      } catch (err) {
        referenceCheckError = err.message;
      }
    }
    for (const c of checked) {
      const finalReference = `Final Payment - ${c.opportunityId}`;
      const depositReference = `Deposit - ${c.opportunityId}`;
      if (referenceCheckError) {
        // The batch(es) covering this deal may not have run at all if an
        // earlier batch failed — null (not false) means "unresolved this
        // run", never reported as a confirmed missing-invoice finding.
        c.xeroInvoiceExists = null;
        c.xeroCheckError = referenceCheckError;
        continue;
      }
      const realInvoice = invoiceByReference.get(finalReference) ?? invoiceByReference.get(depositReference) ?? null;
      c.xeroInvoiceExists = Boolean(realInvoice);
      c.xeroRealReference = realInvoice?.Reference ?? null;
      c.xeroRealInvoiceNumber = realInvoice?.InvoiceNumber ?? null;
      c.xeroRealStatus = realInvoice?.Status ?? null;

      // Specifically the DEPOSIT invoice (not "whichever of final/deposit
      // exists" above) — needed to detect a deal stuck at "Deposit Invoice
      // Sent" in Pipely despite Xero showing the deposit already paid. See
      // "STUCK AT DEPOSIT INVOICE SENT" below, folded into this same
      // batched check 2026-09-20 so Needs Attention never has to trigger
      // its own separate live Xero call just to load.
      const depositInvoice = invoiceByReference.get(depositReference) ?? null;
      c.xeroDepositAmountDue = depositInvoice ? Number(depositInvoice.AmountDue ?? 0) : null;
      c.xeroDepositInvoiceNumber = depositInvoice?.InvoiceNumber ?? null;
      c.xeroDepositAmountPaid = depositInvoice ? Number(depositInvoice.AmountPaid ?? 0) : null;
    }

    // Separate check: where Pipely DOES have its own native invoice, does
    // its exact InvoiceNumber actually exist in Xero, and does its status
    // agree with Xero's? Xero's InvoiceNumbers param already accepts a
    // comma-separated batch — one call for every Pipely-linked invoice
    // number this run needs, not one call per deal.
    const dealsWithPipelyInvoice = checked.filter((c) => c._xeroInvoiceNumber);
    const invoiceByNumber = new Map();
    let numberCheckError = null;
    for (const batch of chunk([...new Set(dealsWithPipelyInvoice.map((c) => c._xeroInvoiceNumber))], 50)) {
      try {
        const xeroResult = await xeroRequest('Invoices', { params: { InvoiceNumbers: batch.join(',') } });
        for (const inv of xeroResult.Invoices ?? []) {
          if (inv.InvoiceNumber) invoiceByNumber.set(inv.InvoiceNumber, inv);
        }
      } catch (err) {
        numberCheckError = err.message;
      }
    }
    for (const c of checked) {
      const xeroInvoiceNumber = c._xeroInvoiceNumber;
      delete c._xeroInvoiceNumber;
      if (!xeroInvoiceNumber) continue;
      if (numberCheckError) {
        c.xeroCheckError = c.xeroCheckError ? `${c.xeroCheckError}; ${numberCheckError}` : numberCheckError;
        continue;
      }
      const xeroInvoice = invoiceByNumber.get(xeroInvoiceNumber) ?? null;
      c.xeroInvoiceNumber = xeroInvoiceNumber;
      c.xeroFound = Boolean(xeroInvoice);
      c.xeroStatus = xeroInvoice?.Status ?? null;
      c.xeroAmountDue = xeroInvoice ? Number(xeroInvoice.AmountDue ?? 0) : null;
      c.statusMatchesXero = pipelyStatusMatchesXero(c.invoiceStatus, xeroInvoice);
    }

    // Full invoice picture per deal, for a human "big scan" — per Xavier
    // 2026-09-17: some deals are 50% deposit + 50% final, others are 100%
    // upfront, decided as "a manual judgment call, not recorded anywhere"
    // in Pipely. A manually-created 100%-upfront invoice in Xero won't
    // carry either the "Deposit - <id>" or "Final Payment - <id>"
    // Reference tag above, so it would be invisible to (and wrongly
    // flagged missing by) the Reference-based check. Matched instead by
    // CONTACT EMAIL — the same lookup findOrCreateXeroContactForPipely
    // uses to invoice in the first place — so every real invoice for that
    // customer shows up regardless of how it was created or what
    // Reference it used. This does not try to auto-judge whether the
    // total charged is "correct" (no rule exists to check that against);
    // it just surfaces the real numbers for a human to eyeball. Batched:
    // one Contacts lookup, one Invoices lookup, not one pair per deal.
    const dealsWithEmail = checked.filter((c) => c.contactEmail);
    const contactIdByEmail = new Map();
    const invoicesByContactId = new Map();
    let contactCheckError = null;
    for (const batch of chunk([...new Set(dealsWithEmail.map((c) => c.contactEmail))], 10)) {
      const clause = batch.map((email) => `EmailAddress=="${email}"`).join('||');
      try {
        const contactsResult = await xeroRequest('Contacts', { params: { where: `(${clause})` } });
        for (const contact of contactsResult.Contacts ?? []) {
          if (contact.EmailAddress) contactIdByEmail.set(contact.EmailAddress.toLowerCase(), contact.ContactID);
        }
      } catch (err) {
        contactCheckError = err.message;
      }
    }
    if (!contactCheckError) {
      for (const batch of chunk([...new Set(contactIdByEmail.values())], 50)) {
        try {
          const invoicesResult = await xeroRequest('Invoices', { params: { ContactIDs: batch.join(',') } });
          for (const inv of invoicesResult.Invoices ?? []) {
            const cid = inv.Contact?.ContactID;
            if (!cid) continue;
            if (!invoicesByContactId.has(cid)) invoicesByContactId.set(cid, []);
            invoicesByContactId.get(cid).push(inv);
          }
        } catch (err) {
          contactCheckError = err.message;
        }
      }
    }
    for (const c of checked) {
      if (!c.contactEmail) { c.xeroInvoicesForContact = null; continue; }
      if (contactCheckError) {
        c.xeroCheckError = c.xeroCheckError ? `${c.xeroCheckError}; ${contactCheckError}` : contactCheckError;
        c.xeroInvoicesForContact = null;
        continue;
      }
      const contactId = contactIdByEmail.get(c.contactEmail.toLowerCase());
      const contactInvoices = contactId ? (invoicesByContactId.get(contactId) ?? []) : [];
      c.xeroInvoicesForContact = contactInvoices
        .filter((inv) => inv.Status !== 'VOIDED' && inv.Status !== 'DELETED')
        .map((inv) => ({
          reference: inv.Reference ?? null,
          invoiceNumber: inv.InvoiceNumber,
          total: Number(inv.Total ?? 0),
          amountPaid: Number(inv.AmountPaid ?? 0),
          amountDue: Number(inv.AmountDue ?? 0),
          status: inv.Status
        }));
      c.xeroTotalInvoicedToContact = c.xeroInvoicesForContact.reduce((sum, inv) => sum + inv.total, 0);
    }

    // The real problem list: a won-stage deal with NO invoice in Xero at
    // all — checked TWO ways before calling it missing: by our own
    // Reference tag, AND by contact email (so a manually-created
    // 100%-upfront invoice that skipped our Reference convention doesn't
    // get wrongly flagged). Strictly `=== false` plus an empty contact
    // invoice list, not just falsy — `null`/unresolved either check must
    // never be reported as a confirmed "missing" finding.
    const noInvoiceInXero = checked.filter((c) =>
      c.xeroInvoiceExists === false && Array.isArray(c.xeroInvoicesForContact) && c.xeroInvoicesForContact.length === 0
    );
    // Also real: Pipely shows an invoice, but that exact invoice doesn't
    // exist in Xero — Xavier: "if there is an invoice in pipely but not in
    // xero there is an issue."
    const notFoundInXero = checked.filter((c) => c.hasInvoice && c.xeroFound === false);
    const statusMismatch = checked.filter((c) => c.hasInvoice && c.statusMatchesXero === false);
    // Deals where the Xero check itself errored (rate limit, etc.) — not a
    // real finding either way, surfaced separately so it isn't silently
    // dropped or miscounted as a pass or a fail.
    const checkFailed = checked.filter((c) => c.xeroCheckError);
    // Stuck at "Deposit Invoice Sent" in Pipely despite Xero showing the
    // deposit already paid — folded in from the old standalone
    // /admin/stuck-deposit-paid endpoint 2026-09-20, per Xavier: "the api
    // should be checking and then logging on the spreadsheet and not
    // calling the whole system everytime." Same data this endpoint's own
    // batched Reference check already computes, just filtered
    // differently — no extra Xero calls for it.
    const stuckDepositPaid = checked.filter((c) =>
      c.stage === 'Deposit Invoice Sent' && c.xeroDepositInvoiceNumber && (c.xeroDepositAmountDue ?? 1) <= 0.01
    );

    return {
      count: checked.length,
      noInvoiceInXeroCount: noInvoiceInXero.length,
      noInvoiceInXero,
      statusMismatchCount: statusMismatch.length,
      statusMismatch,
      notFoundInXeroCount: notFoundInXero.length,
      notFoundInXero,
      checkFailedCount: checkFailed.length,
      checkFailed,
      stuckDepositPaidCount: stuckDepositPaid.length,
      stuckDepositPaid,
      deals: checked
    };
}

app.get('/admin/invoice-check', async (_req, res) => {
  try {
    res.json(await computeInvoiceCheck());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PAYMENT AUDIT CACHE REFRESH (added 2026-09-17) — Xavier: "I'm having a bit
// of delay on loading times, the group needs to be backed in the
// spreadsheet... I want everything to be recorded as it happens inside of
// the spreadsheet. So the spreadsheet fully backs this sales view with all
// the data possible." computeInvoiceCheck() makes several real (if batched)
// Xero API calls — ~20s — which was making the console's Needs
// Attention/Payment Audit pages slow on every single page load. This runs
// that same computation on a schedule instead, and writes the result into
// stock-sheet-agent's "Payment Audit Cache" tab — the console reads from
// there (fast, a plain Sheets read) instead of triggering a live Xero check
// every time someone opens the page.
//
// Read-only against Xero/Pipely (computeInvoiceCheck never writes to
// either), and only writes to OUR OWN spreadsheet cache tab — not the kind
// of edit PAUSE_AUTOMATION exists to gate (that's about writes to Xero/
// Pipely, external systems of record). Runs regardless of the pause, same
// as the existing (also read-only) reconciliation job.
// ---------------------------------------------------------------------------
const PAYMENT_AUDIT_CACHE_INTERVAL_MINUTES = Number(process.env.PAYMENT_AUDIT_CACHE_INTERVAL_MINUTES ?? 15);

function summarizeXeroInvoices(invoices) {
  if (!invoices || !invoices.length) return 'None found';
  return invoices
    .map((inv) => `${inv.invoiceNumber || '—'} ($${inv.total}, ${inv.amountDue > 0.01 ? `$${inv.amountDue} due` : 'paid'})`)
    .join(' | ');
}

async function refreshPaymentAuditCache() {
  if (!process.env.STOCK_SHEET_AGENT_URL) {
    console.log('Payment-audit cache refresh skipped — STOCK_SHEET_AGENT_URL not configured.');
    return;
  }
  const result = await computeInvoiceCheck();
  const generatedAt = new Date().toISOString();
  const rows = result.deals.map((d) => ({
    opportunityId: d.opportunityId,
    dealName: d.dealName,
    rep: d.rep,
    stage: d.stage,
    dealValue: d.dealValue,
    contactEmail: d.contactEmail,
    hasInvoice: d.hasInvoice,
    invoiceNumber: d.invoiceNumber,
    invoiceStatus: d.invoiceStatus,
    xeroInvoiceNumber: d.xeroInvoiceNumber,
    xeroStatus: d.xeroStatus,
    xeroAmountDue: d.xeroAmountDue,
    noInvoiceInXero: result.noInvoiceInXero.some((x) => x.opportunityId === d.opportunityId),
    statusMismatch: result.statusMismatch.some((x) => x.opportunityId === d.opportunityId),
    notFoundInXero: result.notFoundInXero.some((x) => x.opportunityId === d.opportunityId),
    checkFailed: Boolean(d.xeroCheckError),
    xeroCheckError: d.xeroCheckError || '',
    xeroInvoicesSummary: summarizeXeroInvoices(d.xeroInvoicesForContact),
    xeroInvoicesForContact: d.xeroInvoicesForContact || [],
    xeroTotalInvoicedToContact: d.xeroTotalInvoicedToContact ?? '',
    stuckDepositPaid: result.stuckDepositPaid.some((x) => x.opportunityId === d.opportunityId),
    xeroDepositInvoiceNumber: d.xeroDepositInvoiceNumber || '',
    xeroDepositAmountPaid: d.xeroDepositAmountPaid ?? ''
  }));

  const res = await fetch(`${process.env.STOCK_SHEET_AGENT_URL}/admin/write-payment-audit-cache`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.STOCK_SHEET_AGENT_API_KEY },
    body: JSON.stringify({ rows, generatedAt })
  });
  if (!res.ok) throw new Error(`Writing payment-audit cache failed: ${res.status} ${await res.text()}`);
  console.log(`Payment-audit cache refreshed: ${rows.length} deals written, generated ${generatedAt}.`);
}

let paymentAuditCacheTimer = null;
function schedulePaymentAuditCacheRefresh() {
  refreshPaymentAuditCache().catch((err) => console.error('Initial payment-audit cache refresh failed:', err.message));
  paymentAuditCacheTimer = setInterval(() => {
    refreshPaymentAuditCache().catch((err) => console.error('Scheduled payment-audit cache refresh failed:', err.message));
  }, PAYMENT_AUDIT_CACHE_INTERVAL_MINUTES * 60 * 1000);
}
schedulePaymentAuditCacheRefresh();

app.post('/admin/refresh-payment-audit-cache', async (_req, res) => {
  try {
    await refreshPaymentAuditCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// UNALLOCATED DEALS (added 2026-09-17) — Xavier: "we don't want to have a
// client that does not have stock allocated somewhere." Cross-references
// every tracked-pipeline WON-stage deal against stock-sheet-agent's
// Automation Log (matched by External Ref == this deal's opportunity id)
// — flags any deal with NO Automation Log entry at all, meaning nobody's
// logged it / given it an allocation (On Shore / On Water / Next Custom
// Order) yet. Computed fresh each call, not from any queue that depends on
// the (currently paused) deposit webhook having fired — so it stays
// correct even while automation is off and deals are being caught up by
// hand.
// ---------------------------------------------------------------------------
app.get('/admin/unallocated-deals', async (_req, res) => {
  try {
    const [allOpportunities, pipelines, automationLogEntries] = await Promise.all([
      fetchPipelyOpportunities(),
      fetchPipelyPipelines(),
      fetchAutomationLogEntries()
    ]);

    const wonStageLabelById = new Map();
    for (const { id } of TRACKED_PIPELINES) {
      const pipeline = pipelines.find((p) => p.id === id);
      for (const s of pipeline?.stages ?? []) {
        const label = normalizeWonStageLabel(s.name);
        if (label) wonStageLabelById.set(s.id, label);
      }
    }

    const loggedExternalRefs = new Set(automationLogEntries.map((e) => e['External Ref']).filter(Boolean));

    const unallocated = [];
    for (const o of allOpportunities) {
      const stage = wonStageLabelById.get(o.pipelineStageId);
      if (!stage) continue; // not far enough along to need an allocation yet
      if (loggedExternalRefs.has(o.id)) continue; // already logged somewhere

      const rep = TRACKED_PIPELINES.find((p) => p.id === o.pipelineId)?.rep;
      unallocated.push({
        opportunityId: o.id,
        dealName: o.name,
        rep,
        stage,
        dealValue: o.monetaryValue,
        contactEmail: o.contact?.email || null
      });
    }

    res.json({ count: unallocated.length, unallocated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DEPOSIT INVOICE WEBHOOK — intended trigger is a GoHighLevel Workflow
// automation (configured in Pipely) that fires on the opportunity being
// dragged into the "send deposit" pipeline stage, with this URL as a
// Webhook action step. Protected by a shared secret since GHL workflow
// webhook actions typically only let you set a URL (so the secret travels
// as a query param) — accepts either that or a header, whichever your
// workflow setup supports.
//
// The payload shape GHL actually sends from a workflow webhook action is
// NOT confirmed — rather than trust a guessed field name, this pulls
// whatever opportunity ID it can find from a few likely shapes, then
// fetches the real opportunity + contact from Pipely's API directly
// (already-proven endpoints) instead of trusting webhook body fields for
// anything that matters financially.
// ---------------------------------------------------------------------------
function verifyPipelyWebhookSecret(req) {
  if (!process.env.PIPELY_WEBHOOK_SECRET) return false;
  const provided = req.query.token || req.header('x-webhook-secret');
  return provided === process.env.PIPELY_WEBHOOK_SECRET;
}

// ---------------------------------------------------------------------------
// STOCK SHEET LINK (added 2026-08-31) — the connection itself is trivial
// (same pattern as shopify-xero-agent calling stock-sheet-agent), but
// Pipely has no field yet saying which SKU/product a deal is for. Rather
// than wait for that, or guess from the deal name (unreliable — free text,
// not a real field), this flags every deposit-invoiced deal for a human to
// assign a SKU to, same "capture what we have, let a human close the last
// gap" pattern used for the Qwilr agent. Once Xavier's Pipely product
// dropdown exists, this becomes fully automatic — resolveSku (a stub
// below, mirroring qwilr-agent's tryResolveOpportunityId) is where that
// gets wired in, without changing anything else in this flow.
// ---------------------------------------------------------------------------
const NEEDS_SKU_FILE = process.env.NEEDS_SKU_FILE || '/data/pipely-needs-sku.json';

function loadNeedsSkuQueue() {
  try { return JSON.parse(fs.readFileSync(NEEDS_SKU_FILE, 'utf8')); } catch { return []; }
}
function saveNeedsSkuQueue(arr) {
  try {
    fs.mkdirSync(path.dirname(NEEDS_SKU_FILE), { recursive: true });
    fs.writeFileSync(NEEDS_SKU_FILE, JSON.stringify(arr, null, 2));
  } catch (err) {
    console.warn('Could not persist needs-SKU queue to disk:', err.message);
  }
}

// Stub, same honesty as qwilr-agent's tryResolveOpportunityId — returns
// null until Xavier's Pipely product dropdown exists and its field key is
// known. Update this once it does; nothing else here needs to change.
function resolveSkuFromOpportunity(_opportunity) {
  return null;
}

async function callStockSheetAgent(pathSegment, body) {
  const res = await fetch(`${process.env.STOCK_SHEET_AGENT_URL}${pathSegment}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.STOCK_SHEET_AGENT_API_KEY },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Stock sheet agent error ${res.status} on ${pathSegment}: ${await res.text()}`);
}

// Called once per opportunity right after its deposit invoice is created
// (or found already existing) — idempotent per opportunityId via the
// queue itself, so a replayed trigger doesn't add a duplicate entry.
async function flagOrLinkStockForOpportunity(opportunity, contact) {
  if (!process.env.STOCK_SHEET_AGENT_URL) return;

  const queue = loadNeedsSkuQueue();
  if (queue.some((e) => e.opportunityId === opportunity.id)) return; // already flagged or already resolved

  // Same name-derivation as findOrCreateXeroContactForPipely above, for consistency.
  const contactName = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || contact?.name || contact?.email || '';

  const sku = resolveSkuFromOpportunity(opportunity);
  if (sku) {
    // Unreachable until resolveSkuFromOpportunity is implemented for real.
    await callStockSheetAgent('/admin/record-order', { sku, quantity: 1 });
    await callStockSheetAgent('/admin/log-sold-deal', {
      source: 'Pipely', externalRef: opportunity.id, customerName: contactName || opportunity.name,
      email: contact?.email || '', sku, quantity: 1, dealValue: opportunity.monetaryValue,
      depositStatus: 'Deposit invoiced', notes: `Pipely deal ${opportunity.id}, auto-resolved`
    });
    return;
  }

  queue.push({
    opportunityId: opportunity.id,
    dealName: opportunity.name,
    dealValue: opportunity.monetaryValue,
    contactName,
    contactEmail: contact?.email || '',
    at: new Date().toISOString()
  });
  saveNeedsSkuQueue(queue);
}

app.get('/admin/needs-sku-assignment', (_req, res) => {
  res.json({ pending: loadNeedsSkuQueue().filter((e) => !e.resolved) });
});

// A human supplies the SKU/quantity this deal is actually for. Calls the
// same two stock-sheet-agent endpoints the Shopify agent already uses.
// Locked by opportunity ID — an audit found that without this, two
// near-simultaneous submissions (double-click, or a client retry after a
// slow response) could both find the entry still unresolved and both fire
// the downstream stock/log calls, double-recording one real deal.
app.post('/admin/assign-sku', async (req, res) => {
  const { opportunityId, sku, quantity, allocation, batchReference, expectedDate } = req.body;
  if (!opportunityId || !sku || !quantity) {
    return res.status(400).json({ error: 'opportunityId, sku, and quantity are required' });
  }
  try {
    const result = await withLock(`assign-sku:${opportunityId}`, async () => {
      const queue = loadNeedsSkuQueue();
      const entry = queue.find((e) => e.opportunityId === opportunityId && !e.resolved);
      if (!entry) throw new Error(`No pending SKU assignment found for opportunity ${opportunityId}`);

      await callStockSheetAgent('/admin/record-order', { sku, quantity: Number(quantity) });
      await callStockSheetAgent('/admin/log-sold-deal', {
        source: 'Pipely', externalRef: opportunityId, customerName: entry.contactName || entry.contactEmail || entry.dealName,
        email: entry.contactEmail, sku, quantity: Number(quantity), dealValue: entry.dealValue,
        depositStatus: 'Deposit invoiced', allocation, batchReference, expectedDate,
        notes: `Pipely deal ${opportunityId}, SKU assigned manually`
      });
      entry.resolved = true;
      entry.resolvedSku = sku;
      entry.resolvedAt = new Date().toISOString();
      saveNeedsSkuQueue(queue);
      return { opportunityId, sku, quantity };
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = err.message.startsWith('No pending SKU assignment') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.post('/webhooks/pipely/deposit-trigger', async (req, res) => {
  if (!verifyPipelyWebhookSecret(req)) {
    console.warn('Rejected deposit-trigger webhook with invalid/missing secret.');
    return res.status(401).send('Invalid signature');
  }

  const opportunityId = extractOpportunityId(req.body);
  if (!opportunityId) {
    console.warn('Deposit-trigger webhook fired with no recognisable opportunity ID in the payload:', JSON.stringify(req.body));
    return res.status(400).send('No opportunityId found in payload');
  }

  // Ack immediately, same reasoning as the Shopify webhook — the Pipely +
  // Xero calls below can exceed a typical webhook timeout, and GHL will
  // not retry this delivery either way once it gets a 200.
  res.status(200).send('OK');

  // PAUSE_AUTOMATION (added 2026-09-17) — Xavier: "nothing can be currently
  // edited apart from the console using AI... has to request each time...
  // until I'm happy with it." Queued into the same deposit-failure log
  // /admin/replay-deposit already knows how to reprocess, distinct reason
  // so it isn't mistaken for a real failure.
  if (process.env.PAUSE_AUTOMATION === 'true') {
    console.log(`Opportunity ${opportunityId}: automation paused, queued for manual approval — not touching Xero.`);
    appendDepositFailedLog({ opportunityId, error: 'PAUSED: automation paused, awaiting explicit approval' });
    return;
  }

  try {
    const opportunity = await fetchPipelyOpportunity(opportunityId);
    const contact = await fetchPipelyContact(opportunity.contactId);
    const invoice = await createDepositInvoice(opportunity, contact);
    console.log(`Opportunity ${opportunityId}: deposit invoice ${invoice.InvoiceNumber} (${invoice.InvoiceID}) ready.`);
    // Best-effort, does not throw — the invoice above is what actually
    // matters and has already succeeded. See "STOCK SHEET LINK" above.
    await flagOrLinkStockForOpportunity(opportunity, contact).catch((err) =>
      console.error(`Opportunity ${opportunityId}: stock sheet link failed:`, err.message)
    );
  } catch (err) {
    console.error(`Opportunity ${opportunityId} deposit invoice FAILED — flagging, not retrying automatically:`, err.message);
    appendDepositFailedLog({ opportunityId, error: err.message });
  }
});

app.get('/admin/deposit-failures', (_req, res) => {
  res.json({ failures: loadDepositFailedLog() });
});

app.get('/admin/final-invoice-sweep-log', (_req, res) => {
  res.json({ failures: loadFinalSweepLog() });
});

app.post('/admin/run-final-invoice-sweep', async (_req, res) => {
  try {
    const results = await runFinalInvoiceSweep();
    res.json({ ok: true, checked: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reprocess a flagged deposit-invoice failure after the underlying problem
// is fixed. Never automatic, per the project's flag-and-stop rule.
app.post('/admin/replay-deposit', async (req, res) => {
  const { opportunityId } = req.body;
  if (!opportunityId) return res.status(400).json({ error: 'opportunityId is required' });

  const log = loadDepositFailedLog();
  const entry = log.find((e) => e.opportunityId === opportunityId && !e.resolved);
  if (!entry) return res.status(404).json({ error: `No unresolved deposit failure found for opportunity ${opportunityId}` });

  try {
    const opportunity = await fetchPipelyOpportunity(opportunityId);
    const contact = await fetchPipelyContact(opportunity.contactId);
    const invoice = await createDepositInvoice(opportunity, contact);
    await flagOrLinkStockForOpportunity(opportunity, contact).catch((err) =>
      console.error(`Opportunity ${opportunityId}: stock sheet link failed:`, err.message)
    );
    entry.resolved = true;
    entry.resolvedAt = new Date().toISOString();
    try {
      fs.writeFileSync(DEPOSIT_FAILED_LOG_FILE, JSON.stringify(log, null, 2));
    } catch (err) {
      console.warn('Could not persist resolved status to disk:', err.message);
    }
    res.json({ ok: true, invoiceId: invoice.InvoiceID, invoiceNumber: invoice.InvoiceNumber });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Human-triggered (see "FINAL PAYMENT INVOICING" above for why this isn't
// on any automatic schedule) — the ops console's ready-to-ship view calls
// this once an order's stock is ready and someone's decided it's time to
// release the final invoice.
app.post('/admin/create-final-invoice', async (req, res) => {
  const { opportunityId } = req.body;
  if (!opportunityId) return res.status(400).json({ error: 'opportunityId is required' });
  try {
    const opportunity = await fetchPipelyOpportunity(opportunityId);
    const contact = await fetchPipelyContact(opportunity.contactId);
    const invoice = await createFinalInvoice(opportunity, contact);
    res.json({ ok: true, invoiceId: invoice.InvoiceID, invoiceNumber: invoice.InvoiceNumber });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3008;
app.listen(port, () => console.log(`Everest Plunge Pipely-Xero Agent listening on :${port}`));
