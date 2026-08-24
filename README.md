# Everest Plunge Pipely ↔ Xero Agent

Two separate jobs, both between Pipely and Xero:

1. **Reconciliation** (read-only) — checks that won Pipely deals have a
   matching invoice in Xero, flags anything that doesn't line up.
2. **Deposit invoicing** (write) — creates and emails a booking-deposit
   Xero invoice automatically when a deal reaches the "send deposit" stage
   in Pipely. Added 2026-08-24 once Xavier confirmed this should be
   automated, not just checked.

## Reconciliation

Every `CHECK_INTERVAL_MINUTES` (default 60), and once immediately on
startup:

1. Fetches Pipely deals marked "won" within the last `RECONCILE_LOOKBACK_DAYS`.
2. For each, looks up the deal's contact email in Pipely, then searches Xero
   for a contact with that email and an invoice matching the deal value
   within `VALUE_TOLERANCE`.
3. Anything that doesn't match — no Xero contact, contact exists but no
   invoice, or invoice value doesn't line up — gets flagged.

The flagged list is a **current snapshot**, not an event log: a deal that
reconciles correctly on a later run drops off the list automatically.

## Deposit invoicing

`POST /webhooks/pipely/deposit-trigger` — intended to be called by a
**GoHighLevel Workflow automation** you set up in Pipely: a workflow
triggered by "opportunity stage changed to [send deposit stage]", with a
Webhook action step pointing at this URL. That's the "drag the bucket"
trigger Xavier described — GHL workflows do the dragging-detection, this
agent just reacts to the webhook.

On trigger: fetches the real opportunity + contact from Pipely (not
trusting webhook payload fields for anything financial, since GHL's exact
webhook payload shape isn't confirmed), computes `DEPOSIT_PERCENTAGE`
(default 50%) of the deal value, matches/creates a Xero contact by email,
creates an **AUTHORISED** (unpaid) invoice, and emails it. Does NOT mark it
paid — unlike the Shopify agent, the deposit hasn't actually been paid yet
at trigger time; that happens later via bank transfer and Xero's own
reconciliation.

**The final 50% payment is NOT built here.** Per Xavier: 50% deposit up
front, 50% final payment due the week before shipping, which must clear
before the product ships. That depends on a per-order ship date living in
the batch-tab spreadsheet, whose real column layout isn't confirmed yet —
building that blind risks either not invoicing the final payment at all, or
worse, the product shipping before it's actually paid. Get the batch tab +
MASTER ORDER LIST CSV exports (same method used for Stock Overview) before
this gets built.

**Qwilr is the other stated trigger** ("client accepts the Qwilr
proposal") but has no confirmed API/webhook access — not wired up.

On failure: flagged to a persisted log, never auto-retried. Fix the root
cause, then call `POST /admin/replay-deposit`.

## Admin endpoints (require `x-api-key`)

- `GET /admin/mismatches` — current flagged reconciliation deals.
- `POST /admin/run-check` — trigger a reconciliation check immediately.
- `GET /admin/deposit-failures` — flagged deposit-invoice failures.
- `POST /admin/replay-deposit` — body `{ "opportunityId": "..." }`,
  reprocesses a failed deposit invoice after you've fixed the cause.

## Not yet confirmed — verify once you have real data flowing

- **Matching signal for reconciliation is email only** — see the note in
  the original build; Xavier's own matching rules rank phone above email,
  but Xero's API can't reliably filter on the nested Phones field.
- **`opportunity.contactId`** (linking a Pipely opportunity to its contact)
  is based on GoHighLevel's documented API shape, not verified against
  Everest Plunge's real account yet.
- **The GHL workflow webhook payload shape** is unknown — the endpoint
  pulls an opportunity ID from a few likely field names rather than
  trusting one guessed shape. Watch the first real trigger's logs to
  confirm it actually finds the ID; adjust `extractOpportunityId` in
  `index.js` if GHL sends something different.
- **`DEPOSIT_PERCENTAGE` × deal value assumes `opportunity.monetaryValue`
  is the full deal value** (not already net of a deposit, or GST-exclusive,
  etc.) — sanity-check the first real invoice's amount by hand.

## Setup checklist

1. Xero Developer app pointed at Everest Plunge's org (can reuse the same
   app as the Shopify agent — add this service's `/oauth/callback` as an
   additional redirect URI). Deploy, visit `/oauth/start` once.
2. Pipely: Everest Plunge's own location ID + API key.
3. Fill in `XERO_SALES_ACCOUNT_CODE`/`XERO_TAX_TYPE` (same real values as
   the Shopify agent) and `PIPELY_WEBHOOK_SECRET`.
4. In Pipely, build a GoHighLevel Workflow: trigger = opportunity moved to
   the "send deposit" stage, action = Webhook to
   `https://<this-service>/webhooks/pipely/deposit-trigger?token=<PIPELY_WEBHOOK_SECRET>`.
5. Test with one real deal before trusting this unattended — check the
   invoice amount, the contact it landed on, and that the email actually
   arrived.

## Deployment

Same pattern as every other agent in this project: push to its own GitHub
repo, create a Railway service in the Everest Plunge Railway project, paste
env vars into Railway's Variables tab, attach a small volume at `/data` so
the Xero token, mismatch snapshot, and failure logs survive restarts.
