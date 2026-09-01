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

async function xeroRequest(pathSegment, { method = 'GET', params, body, headers = {} } = {}) {
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
app.get('/oauth/start', (_req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.XERO_CLIENT_ID,
    redirect_uri: process.env.XERO_REDIRECT_URI,
    scope: 'accounting.transactions accounting.contacts offline_access',
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
