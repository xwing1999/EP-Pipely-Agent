# Everest Plunge Pipely → Xero Reconciliation Agent

Checks that won Pipely deals have a matching invoice in Xero and flags
anything that doesn't reconcile. **Read-only against both systems** — this
agent never creates, updates, or emails anything. It watches; it doesn't act.

## Why read-only, unlike the Shopify agent

Shopify orders have no existing manual invoicing step, so auto-creating the
Xero invoice was a clean addition. Pipely deals are different: today, a rep
already raises the invoice by hand inside Pipely once a deal is accepted.
Having this agent auto-create Xero invoices instead would replace that human
step — a real process change, not just an automation layer, and it hasn't
been confirmed as wanted yet. Until it is, this agent's job is narrower:
watch the two systems and tell you when something doesn't line up.

## What it does

Every `CHECK_INTERVAL_MINUTES` (default 60), and once immediately on
startup:

1. Fetches Pipely deals marked "won" within the last `RECONCILE_LOOKBACK_DAYS`.
2. For each, looks up the deal's contact email in Pipely, then searches Xero
   for a contact with that email and an invoice matching the deal value
   within `VALUE_TOLERANCE`.
3. Anything that doesn't match — no Xero contact, contact exists but no
   invoice, or invoice value doesn't line up — gets flagged.

The flagged list is a **current snapshot**, not an event log: a deal that
reconciles correctly on a later run drops off the list automatically, it
doesn't need manual dismissal.

## Admin endpoints (require `x-api-key`)

- `GET /admin/mismatches` — current flagged deals + when the last check ran.
- `POST /admin/run-check` — trigger a check immediately instead of waiting
  for the schedule.

## Not yet confirmed — verify once you have real data flowing

- **Matching signal is email only.** Your own cross-system matching rules
  (documented in the Kiwiseal CLAUDE.md) rank phone number above email, with
  name/address/value as corroborating-only — but Xero's Contacts API can't
  reliably filter on the nested Phones array, so email is what's actually
  usable here. If this produces too many false "no match" flags in
  practice (e.g. a customer used a different email in Pipely vs. their Xero
  invoice), that's the first thing to revisit.
- **Pipely opportunity → contact linkage** (`opportunity.contactId`) is
  based on GoHighLevel's documented API shape, not verified against
  Everest Plunge's actual account yet — confirm real opportunity records
  actually carry this field once you have API access.
- Same discipline as everywhere else in this project: don't trust these
  until you've watched a real run against real data and the numbers make
  sense.

## Setup checklist

1. Xero Developer app pointed at Everest Plunge's org (can reuse the same
   app as the Shopify agent — just add this service's `/oauth/callback`
   URL as an additional redirect URI on that app). Deploy, then visit
   `/oauth/start` once.
2. Pipely: Everest Plunge's own location ID + API key (Settings > Business
   Info / API Keys in Pipely).
3. Watch the first few scheduled runs (or trigger `/admin/run-check`
   manually) and sanity-check the flagged list against what you already
   know about recent deals before trusting it unattended.

## Deployment

Same pattern as every other agent in this project: push to its own GitHub
repo, create a Railway service in the Everest Plunge Railway project, paste
env vars into Railway's Variables tab, attach a small volume at `/data` so
the Xero token and mismatch snapshot survive restarts.
