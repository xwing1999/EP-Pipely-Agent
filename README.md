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
1. **Reconciliation** (read-only) — checks that won Pipely deals have a
   matching invoice in Xero, flags anything that doesn't line up.
2. **Deposit invoicing** (write) — creates and emails a booking-deposit
   Xero invoice automatically when a deal reaches the "send deposit" stage
   in Pipely. Added 2026-08-24.
3. **Final payment invoicing** (write, human-triggered) — creates and
   emails the remaining 50% once someone decides an order is ready to
   release. Added 2026-08-31 alongside the stock sheet agent's release
   gate — see below.

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

**Deliberately not on any automatic schedule.** Nothing here knows a real
ship date yet — that lives in the still-unconfirmed batch tabs — so
there's no reliable "the week before shipping" trigger to hang this off
of. A human calls this (via the ops console) once they've decided an order
is ready. After creating the invoice, this also tells
`everest-plunge-stock-sheet-agent` the deal's final payment status is now
"Invoiced" (via its `External Ref`, best-effort, doesn't block on failure)
— that agent then refuses to let the order be marked sent until someone
confirms the payment actually cleared and calls
`POST /admin/mark-final-payment-received` there. That's the real release
gate; this agent only creates the invoice.

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

1. Xero: this agent uses a **Custom Connection** app ("EP-Agent", created
   2026-09-01), not the redirect-based OAuth flow the older Kiwiseal Xero
   agents use — there's no `/oauth/start` here, nothing to visit in a
   browser for this agent specifically. In Xero's developer portal, invite
   yourself (or whoever should approve it) by email on the app's
   Connection page, then approve that invite once, logged into **Everest
   Plunge's** Xero org (not Kiwiseal's). Once "Connected organisation"
   shows connected, paste `XERO_CLIENT_ID`/`XERO_CLIENT_SECRET` into
   Railway — no redirect URI, no refresh token, nothing else Xero-side to
   configure.
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
