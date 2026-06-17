# withRemote — Full-Stack Backend Assignment

Two backend problems, one TypeScript service, **two fully separate databases**:

1. **Sync pipeline that doesn't lie or duplicate** — ingest HubSpot (CRM), Stripe (payments) and Google Calendar (events) into one normalized schema; fall back to a full backfill when an incremental cursor goes stale; write idempotently; and keep going when one source is down or returns garbage.
2. **One revenue number that never drifts** — compute *collected revenue* over a date range across sources with clashing status vocabularies, using a single canonical definition and an **allow-list** of collecting statuses. Two endpoints (summary + breakdown) that always agree, plus guards that catch any second, divergent way of computing the number.

> **Backend-only.** No UI. Every endpoint is documented and runnable from the built-in **Swagger UI at `/docs`**.

- **Live deployment:** `<RENDER_URL>` (Swagger at `<RENDER_URL>/docs`)
- **AI usage / chat transcript:** `<AI_SHARE_LINK>` (see [AI usage](#ai-usage))

---

## Architecture

```
                 Problem 1  (src/sync)                        Problem 2  (src/metrics)
  HubSpot ─┐                                        Stripe(test) ─┐
  Stripe  ─┼─ DataSource port → normalize()          QuickBooks*  ─┼─ normalize()
  GCal    ─┘        │  orchestrator                   Square*      ─┘     │  ONE canonical
                    │  (cursor-fallback +                                  │  revenue.ts
                    │   fault isolation)                                   ▼  (allow-list)
              records / sync_state / sync_runs                      transactions
                    │                                          ┌─────────┴─────────┐
         POST /sync/run · webhooks                       /revenue/summary   /revenue/breakdown
                    │                                          (both call the same builder)
          Supabase project A  (DATABASE_URL_SYNC)        Supabase project B  (DATABASE_URL_METRICS)
                         one Render web service · Swagger at /docs
```
\* QuickBooks/Square are simulated sources that contribute realistically different status vocabularies.

The two modules share **no code and no database**. Each owns its own Kysely client, migrations, and tables.

**Stack:** Node 22 · TypeScript · Fastify · Kysely + `pg` · Zod · Pino · Vitest · `@fastify/swagger`. Run with `tsx` (no build step).

**Ports & adapters.** The orchestrator only talks to a `DataSource` interface (`src/sync/ports/source.ts`), so it's identical whether driving HubSpot, Stripe, Google, or an in-memory fixture. Each source is **live when its credential is present, otherwise it serves recorded fixtures** (`SOURCE_MODE=auto`) — so the whole pipeline runs end to end regardless of which accounts are wired up.

---

## Run it locally

Requires Node 22 and Docker.

```bash
cp .env.example .env          # defaults point at the two docker databases
npm install
docker compose up -d          # two Postgres instances (sync :5433, metrics :5434)
npm run migrate               # migrate BOTH databases
npm run seed                  # land sync records + seed transactions (fixtures by default)
npm run dev                   # http://localhost:3000  →  open /docs
```

Run the tests (uses the docker databases):

```bash
npm test          # 27 tests: normalization, idempotency, cursor-fallback, fault isolation,
                  # allow-list, summary==breakdown agreement, and the drift guard
npm run typecheck
```

---

## Try the failure/edge cases (no real accounts needed)

```bash
# Idempotency — run twice, row count is stable
curl -X POST 'localhost:3000/sync/run?source=all'      # first run: full,  +3 each
curl -X POST 'localhost:3000/sync/run?source=all'      # again:    incremental, +0

# Same webhook firing twice — written: 1 then 0, never a duplicate row
curl -XPOST localhost:3000/webhooks/stripe -H 'content-type: application/json' \
  -d '{"type":"charge.succeeded","data":{"object":{"id":"ch_demo","object":"charge","amount":1500,"currency":"usd","status":"succeeded","created":1749000000}}}'

# Stale cursor (e.g. Google 410) → automatic full backfill
curl -X POST 'localhost:3000/sync/run?source=google_calendar&simulate=stale'   # fellBackToFull: true

# One source down → the other two still land
curl -X POST 'localhost:3000/sync/run?source=all&simulate=down&simulateOn=stripe'

# Garbage record → quarantined, the rest land (degraded, not failed)
curl -X POST 'localhost:3000/sync/run?source=hubspot&simulate=garbage'

# Metrics: summary and breakdown agree
curl -X POST  localhost:3000/metrics/seed
curl 'localhost:3000/metrics/revenue/reconcile?from=2026-06-01&to=2026-07-01'   # agree: true

# A new/unexpected status is surfaced, never silently counted
curl 'localhost:3000/metrics/status-audit'
```

---

## How each requirement is met

### Problem 1 — sync pipeline

| Requirement | Where | Verified by |
|---|---|---|
| One normalized schema from 3 different shapes | `src/sync/adapters/normalize.ts` (pure mappers) → `records` | `test/sync/normalize.test.ts` |
| Stale cursor → full backfill (no data loss / crash) | `orchestrator.ts` catches `StaleCursorError`; Google maps real **HTTP 410** on an expired `syncToken` | `orchestrator.test.ts` + `simulate=stale` |
| Idempotent writes (webhook twice / re-run) | `repository.upsertRecords` — `UPSERT … ON CONFLICT (source, external_id) … WHERE content_hash IS DISTINCT`, shared by sync **and** webhooks | `orchestrator.test.ts` (3 cases) |
| One source down/garbage doesn't wedge the rest | `orchestrator.ts` — `Promise.allSettled`, one txn per source, per-record Zod quarantine | `orchestrator.test.ts` |

### Problem 2 — metrics

| Requirement | Where | Verified by |
|---|---|---|
| One canonical "collected" definition | `src/metrics/revenue.ts` — single query builder both endpoints use | `revenue.test.ts` |
| Allow-list (not exclusion list) | `src/metrics/statusMap.ts` — unknown status ⇒ not collected | `statusMap.test.ts` |
| Two views that always agree | summary + breakdown derive from the same builder; integer **cents** ⇒ no rounding gap | `revenue.test.ts` (5 ranges × day/week) |
| Catch a new status / a second computation | completeness check (`audit.ts` + `/metrics/status-audit`) and the **no-rogue-summation** test | `revenue.test.ts`, `architecture/no-rogue-summation.test.ts` |

The **no-rogue-summation** guard scans the source tree and fails if `amount_cents` is aggregated anywhere except `revenue.ts` — so a second, slightly-different revenue calculation can't be added without CI going red.

---

## Setting up the real accounts (going live)

All free tier. Each is optional — without a key, that source uses fixtures. Set the same vars in Render.

- **Supabase ×2** — create two projects; copy each *Connection string (pooler)* into `DATABASE_URL_SYNC` and `DATABASE_URL_METRICS`. Run `npm run migrate`.
- **Stripe (test mode)** — `STRIPE_SECRET_KEY=sk_test_…`. Create a few test charges (Dashboard → Payments, or `stripe trigger charge.succeeded`). For webhooks set `STRIPE_WEBHOOK_SECRET` (use `stripe listen --forward-to localhost:3000/webhooks/stripe` locally).
- **HubSpot** — developer/test account → a Private App with CRM read scopes → `HUBSPOT_PRIVATE_APP_TOKEN`. Add a few contacts.
- **Google Calendar** — OAuth client (Web) with redirect `http://localhost:53682/callback`; set `GOOGLE_CLIENT_ID`/`SECRET`, then `npm run get-google-token` to mint `GOOGLE_REFRESH_TOKEN`. Add a few events.

## Deploy to Render (free tier)

1. Push this repo to GitHub.
2. Render → **New → Blueprint** → select the repo (`render.yaml` is detected).
3. Fill in the env vars marked `sync: false` (the two `DATABASE_URL_*`, plus any source keys you want live).
4. Deploy. The start command runs both migrations then boots; health check is `/health`.

> Free web services spin down after ~15 min idle; the first request after that cold-starts in ~1 min.

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness + per-database readiness |
| `GET` | `/docs` | Swagger UI |
| `POST` | `/sync/run?source=&simulate=` | Trigger a sync (the runnable job). `simulate=stale\|down\|garbage` |
| `GET` | `/sync/state` | Cursors, per-source health, live/fixture mode, recent runs |
| `GET` | `/records` | Normalized records |
| `POST` | `/webhooks/stripe`, `/webhooks/hubspot` | Idempotent webhook receivers |
| `POST` | `/metrics/seed` | Seed transactions (Stripe test + simulated sources) |
| `GET` | `/metrics/revenue/summary` | Single collected total |
| `GET` | `/metrics/revenue/breakdown?granularity=day\|week` | Bucketed total (sums to summary) |
| `GET` | `/metrics/revenue/reconcile` | Returns both + asserts they agree |
| `GET` | `/metrics/status-audit` | Distinct statuses + any the allow-list doesn't classify |
| `GET` | `/metrics/transactions` | Raw transactions |

---

## Tradeoffs & decisions

- **Two separate databases** (per the brief) — each module has its own Supabase project, Kysely client and migrations. Hard isolation; the cost is two connection strings and no cross-module joins (intentional).
- **Money as integer cents (`bigint`)** everywhere. No floats ⇒ summary and breakdown agree exactly.
- **Allow-list over exclusion list** — an unknown status counts as nothing and is surfaced loudly, rather than silently becoming revenue.
- **App is live, tests are isolated** — the running service hits real APIs; the suite uses recorded fixtures/fakes so it's deterministic and needs no network (the drift guards must run in CI).
- **Run via `tsx`, no build step** — fewer moving parts for a take-home; `tsx` is a runtime dependency so Render needs no compile.
- **Stripe uses a timestamp cursor** (`created[gt]`), which is monotonic and replay-safe; the stale-cursor → backfill path is demonstrated end-to-end by Google's real 410 (and reproducibly by `simulate=stale`).
- **Scheduling is external/manual** (`POST /sync/run`, optionally pinged by cron-job.org) to stay on Render's free tier.
- **DB-backed tests target the docker Postgres**; pure-logic tests need no DB.

---

## Sources & references

- HubSpot CRM API — objects & search (`@hubspot/api-client`): https://developers.hubspot.com/docs/api/crm/contacts
- Stripe API — Charges list pagination & webhooks (`stripe` Node SDK): https://stripe.com/docs/api/charges/list , https://stripe.com/docs/webhooks/signatures
- Google Calendar API — incremental sync & the **410 / syncToken** recovery: https://developers.google.com/calendar/api/guides/sync
- Postgres `INSERT … ON CONFLICT` (upsert) & `IS DISTINCT FROM`: https://www.postgresql.org/docs/current/sql-insert.html
- Kysely (typed query builder + migrations): https://kysely.dev
- Fastify & `@fastify/swagger` / `swagger-ui`: https://fastify.dev , https://github.com/fastify/fastify-swagger
- Supabase Postgres (connection pooler): https://supabase.com/docs/guides/database/connecting-to-postgres
- Render Blueprints (`render.yaml`): https://render.com/docs/blueprint-spec

## AI usage

Built with **Claude (Claude Code)**. I directed the architecture (ports & adapters, two-database split, allow-list-not-exclusion, the no-rogue-summation guard), reviewed every file, and verified behavior by running the suite and the live endpoints. Full transcript: `<AI_SHARE_LINK>`.
