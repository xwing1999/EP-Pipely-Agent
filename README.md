# Everest Plunge Pipely ↔ Xero Agent

Five jobs — the first two are Pipely-only, the rest are between Pipely and Xero:

0. **Deposit-to-won tracking** (read-only, Pipely-only) — the main thing to
   watch day-to-day. Three numbers: deals currently sitting at "deposit
   sent," deals won this month, deals won all time. Scoped to Joel's and
   Dion's pipelines (the active/soon-to-be-active sales reps — see
   `TRACKED_PIPELINES` in `index.js`). Added 2026-09-01.
0.5. **Deal visibility** (read-only, Pipely-only) — the broader primitive
   deposit-to-won tracking is built on; lists all open Pipely deals with
   pipeline/stage names resolved. Not the thing to check day-to-day, just
   useful for exploring the raw data. Added 2026-09-01.
0.7. **Invoice check** (read-only, Pipely + Xero) — the other half of what
   Xavier described: confirms every tracked deal has an invoice, and that
   each invoice's Pipely status actually matches Xero. Added 2026-09-01,
   see below — supersedes the older `1. Reconciliation` job below for
   this purpose, kept for now since it's a different lookback/window.
1. **Reconciliation** (read-only) — checks that won Pipely deals have a
   matching invoice in Xero, flags anything that doesn't line up. **Not
   reliable** — see the note under Invoice check below.
2. **Deposit invoicing** (write) — creates and emails a booking-deposit
   Xero invoice automatically when a deal reaches the "send deposit" stage
   in Pipely. Added 2026-08-24.
3. **Final payment invoicing** (write, human-triggered OR automatic) —
   creates and emails the remaining 50% once an order is ready to release.
   Added 2026-08-31 alongside the stock sheet agent's release gate — see
   below. As of 2026-09-01, also fires automatically via the final invoice
   sweep — see below.
4. **Final invoice sweep** (write, fully automatic, added 2026-09-01) —
   periodically checks every order's batch ETA and fires the final invoice
   once it's within the lead-time window. See below.

## Deposit-to-won tracking

`GET /admin/deposit-to-won` — the main endpoint to check. Returns exactly
three columns, per Xavier's explicit scope ("these are the 3 that we will
be watching over solely"):

```json
{
  "depositSent": { "count": 0, "deals": [...] },
  "wonThisMonth": { "count": 0, "deals": [...] },
  "wonAllTime": { "count": 0, "deals": [...] }
}
```

- `depositSent` — deals currently sitting in the "Deposit Invoice Sent"
  stage of any tracked pipeline (Joel, Dion). Matched by stage, not
  opportunity status (see code comment on why). Each deal is tagged with
  `rep` so you can tell them apart.
- `wonThisMonth` / `wonAllTime` — deals with Pipely's own `status: 'won'`,
  filtered by `lastStageChangeAt` falling in the current calendar month for
  the first. **This "this month" figure is an approximation** — Pipely
  doesn't expose a dedicated "became won" timestamp, so a deal that became
  won two months ago and then moved stage again this month (e.g.
  progressed from "Deposit Paid" to "Product To Send") would double-count
  as won this month too. Watch this against what you know actually
  happened before trusting it fully.
- Depends on Joel's pipeline being correctly identified
  (`JOEL_PIPELINE_ID` in `index.js`, hardcoded to the real, confirmed ID —
  update it if that pipeline is ever recreated) and, going forward, on the
  Pipely/GoHighLevel Workflow that flips an opportunity's status to "Won"
  actually being configured to fire at the Deposit Paid stage rather than
  Deposit Invoice Sent — that's a Pipely-side setting, not something this
  code controls or verifies.

## Deal visibility (general, not the main thing to watch)

`GET /admin/deals` — returns every open Pipely opportunity (pass
`?status=won`/`lost`/`abandoned` to look at other buckets instead), with
`pipelineId`/`pipelineStageId` resolved to human-readable names via
`GET /opportunities/pipelines`. Contact name/email/phone are read from
whatever the opportunity search response embeds — not a separate per-deal
contact lookup, so this stays cheap even with a lot of open deals.

`GET /admin/pipelines` — raw pipeline/stage list, for reference.

## Invoice check (added 2026-09-01)

`GET /admin/invoice-check` — the real two-way check Xavier asked for:
"compare over from the sales pipeline and make sure there are invoices
sitting there... an invoice reconciled as paid in Xero needs to be
showing paid in Pipely."

For every deal in a tracked pipeline (Joel, Dion) sitting at or past
"Deposit Invoice Sent":
- Confirms a Pipely invoice actually exists for it (matched by
  `opportunityDetails.opportunityId`, exact).
- If one exists, looks it up in Xero by `InvoiceNumber` — confirmed to
  equal Pipely's `invoiceNumberPrefix + invoiceNumber` (e.g.
  `"INV-000155"` for Pipely invoice `#000155`) — and compares payment
  status: Pipely `paid` should mean Xero `AmountDue == 0`, `sent` should
  mean nothing paid yet, `partially_paid` should mean partially paid on
  both sides.

Response has three flagged buckets plus the full list: `missingInvoice`
(deal reached a WON stage, no Pipely invoice found), `notFoundInXero`
(Pipely invoice exists, nothing in Xero with that InvoiceNumber),
`statusMismatch` (both exist, but payment status disagrees — e.g. Pipely
still shows "sent" while Xero shows it's actually been paid).

**Known real gap**: not every Pipely invoice has `opportunityDetails` set
— one found while testing (Tess Gleeson, real, paid, $5,922.50) had it
`null` despite a genuine matching Xero invoice existing. This means
`missingInvoice` can have false positives — a deal might actually have an
invoice that simply isn't linked back to its opportunity in Pipely. Not
fixable from this agent's side; worth asking Xavier whether that's
something reps need to always set when creating invoices in Pipely.

**Why `1. Reconciliation` above is unreliable for this purpose**: it
matches by contact email + comparing `Invoice.Total` against the Pipely
opportunity's `monetaryValue` — but many real opportunities have
`monetaryValue: 0` even when the actual Xero invoice is for thousands of
dollars (reps aren't consistently filling that field in), so it flagged
every single won deal as a mismatch the first time Xero was connected,
none of which were real. `/admin/invoice-check` uses the confirmed
InvoiceNumber key instead, not deal value.

**Not yet verified against Everest Plunge's real Pipely account**: the
`/opportunities/pipelines` response shape (`{pipelines: [{id, name, stages:
[{id, name}]}]}`) and whether the opportunity search response actually
embeds a usable `contact` object — both taken from GoHighLevel's documented
API, not confirmed live yet. Check the first real `/admin/deals` response
once deployed; if `pipeline`/`stage` come back as raw IDs instead of names,
or contact fields are all `null`, the shape differs from what's assumed
here and `fetchPipelyPipelines`/the `.map()` in `/admin/deals` need
adjusting.

## Final payment invoicing

`POST /admin/create-final-invoice` — body `{ "opportunityId": "..." }`.
Requires the deposit invoice to already exist (refuses to invent a final
amount for a deal that was never deposit-invoiced). Computes the final
amount as the same `DEPOSIT_PERCENTAGE` split off the deal value, not
"deal value minus whatever the deposit invoice says now" — so it can't
drift if the deposit invoice was edited after the fact.

Can be called two ways: a human, via the ops console's "Send final
invoice" button, or automatically by the final invoice sweep below. After
creating the invoice, this also tells `everest-plunge-stock-sheet-agent`
the deal's final payment status is now "Invoiced" (via its `External
Ref`, best-effort, doesn't block on failure) — that agent then refuses to
let the order be marked sent until someone confirms the payment actually
cleared and calls `POST /admin/mark-final-payment-received` there. That's
the real release gate; this agent only creates the invoice.

## Final invoice sweep (added 2026-09-01)

Replaces the earlier "nothing here knows a real ship date" blocker.
Xavier: "I want a countdown on orders arriving to shores from their
container boats and the invoices will go out on that" — confirmed
**fully automatic**, no human approval step.

Every `FINAL_SWEEP_INTERVAL_MINUTES` (default 60), and once immediately
on startup: fetches `everest-plunge-stock-sheet-agent`'s Automation Log
(`GET /admin/automation-log`, which resolves a computed `Ship ETA` per
entry from that agent's own per-batch ETA store — see its README). Any
entry with an External Ref (linked Pipely opportunity), not already
final-invoiced, whose batch is within `FINAL_INVOICE_LEAD_DAYS` (default
7) of its ETA gets `createFinalInvoice` called on it — the same function
the human-triggered endpoint above uses, so it inherits that function's
existing idempotency for free (checks Xero for an existing "Final Payment
- {opportunityId}" invoice first) — safe to run repeatedly without
double-invoicing.

**ETA is per batch/shipment, not per order** — matches the real
spreadsheet, where one ETA is shared by every client on a shipment. Ops
sets it once via the ops console's "Batch ETA" section.

- `GET /admin/final-invoice-sweep-log` — failures from past sweeps.
- `POST /admin/run-final-invoice-sweep` — trigger a sweep immediately,
  same logic as the scheduled run.

**Overdue orders still fire** — an ETA that's already passed (negative
days-until-arrival) still qualifies, it doesn't get skipped for being
late; the sweep doesn't distinguish "about to arrive" from "should have
arrived already," both are inside the lead-time window.

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

## Stock sheet link (added 2026-08-31)

Right after a deposit invoice is created, this agent also tells
`everest-plunge-stock-sheet-agent` about the sale — same as the Shopify
agent already does. The catch: Pipely has no field yet saying which
SKU/product a deal is for, so the connection itself is real but every deal
lands in a "needs SKU" queue for a human to finish, rather than guessing
from the deal's free-text name. Fully automatic once your product dropdown
exists — see `resolveSkuFromOpportunity` in `index.js`, currently a stub
matching `everest-plunge-qwilr-agent`'s honesty about what isn't confirmed
yet. Nothing else in this flow needs to change when that's wired in.

## Admin endpoints (require `x-api-key`)

- `GET /admin/mismatches` — current flagged reconciliation deals.
- `POST /admin/run-check` — trigger a reconciliation check immediately.
- `GET /admin/deposit-failures` — flagged deposit-invoice failures.
- `POST /admin/replay-deposit` — body `{ "opportunityId": "..." }`,
  reprocesses a failed deposit invoice after you've fixed the cause.
- `GET /admin/needs-sku-assignment` — Pipely deals waiting on a human to
  say which product they're for.
- `POST /admin/assign-sku` — body `{ "opportunityId", "sku", "quantity" }`,
  completes the stock sheet update for one deal.

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
