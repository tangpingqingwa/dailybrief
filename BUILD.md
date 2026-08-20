# DailyBrief — Detailed Specification and Build Plan

**Contract:** [SPEC.md](./SPEC.md)  
**Git:** [CONTRIBUTING.md](./CONTRIBUTING.md)

No scrapers. ClipAPI only at launch. Shared summaries are the COGS control.

---

## 1. Stack

| Layer | Choice |
|---|---|
| API / workers | Node 22, TS, Fastify |
| DB | SQLite (users, sources, items, deliveries) |
| Auth | Magic link: signed token in email, 20 min TTL |
| Email | Provider interface `EmailPort.send`. Adapter `console` / fake in tests. Live Resend or SES when `EMAIL_LIVE=1` (env-gated; fail-closed without secrets) |
| Summary | `SummaryPort.summarize(text) → ≤80 words`. Adapter `fake` returns first 80 words; live model later |
| Scheduler | `node-cron` in-process v1 (one box). If process restarts, catch-up job on boot |
| Tests | node:test + fake ClipAPI + fake email |

---

## 2. Time windows

User timezone IANA. `sendHour` fixed 7.

For local date `D` send at `D 07:00`:

```
window = [ (D-1) 07:00 local, D 07:00 local )
```

Item `publishedAt` parsed as UTC then compared in UTC instants.  
Idempotency: unique `(user_id, local_date)`.

Empty paid window: still send “Nothing new yesterday”.

---

## 3. Ingest

```
every 15 min:
  distinct tiktok handles
  ClipAPI GET /v1/creators/{handle}/latest   # 0 credits
  for each new videoId:
    insert items (summary null)
    ClipAPI GET /v1/transcript               # 1 credit internal key
    SummaryPort.summarize(join cues)
    update item.summary once
```

Two users, one video → one `items` row. `user_sources` is N:N.

If transcript `no_transcript`: summary = first 200 chars of description + ` (no transcript)`.

---

## 4. Kill switch (code)

`src/config.ts` `FREEZE_NEW_SOURCES=0`. When 1: API rejects new source types; UI hides add for non-tiktok. Document in ops. Not a hidden date bomb — set the flag after the 90-day review.

---

## 5. Tests

| Test | Assert |
|---|---|
| window | published 06:59 local included; 07:00 excluded from that send |
| shared summary | two users one item_id |
| empty send | paid user gets empty template |
| unsub | token invalidates; no further send |
| clip down | delivery still recorded with `partial=1`, no scrape |
| cap | 6th source on starter → 400 |
| slack pro | Pro posts same text; Starter never posts; webhook 4xx still emails |
| live email | unset / `0` / `true` stay console or fail-closed; `EMAIL_LIVE=1` + secrets selects Resend or SES; `EMAIL_FIXTURE_ONLY=1` wins |

---

## 6. PR plan

### PR 1: Skeleton + schema + healthz
- **Files:** package.json, migrations (users, sources, items, deliveries), server
- **Dependencies:** None

### PR 2: Magic link auth
- **Files:** src/auth/*, fake email, tests/auth.test.ts
- **Dependencies:** PR 1

### PR 3: ClipAPI client + ingest + shared summary
- **Files:** src/clients/clip.ts, src/ingest.ts, src/summary/fake.ts, tests/ingest.test.ts
- **Dependencies:** PR 2
- **Acceptance:** SPEC 1, 3, 5

### PR 4: Daily send + unsub + empty mail
- **Files:** src/send.ts, templates, unsub route, tests/send.test.ts
- **Dependencies:** PR 3
- **Acceptance:** SPEC 2, 4, 6

### PR 5: Stripe $9/$19 + source caps
- **Files:** billing, source create guard
- **Dependencies:** PR 4
- **Acceptance:** starter 5 / pro 25

### PR 6: Slack webhook (Pro)
- **Files:** src/slack/*, src/http/routes/slack.ts, src/send.ts, migrations/005_slack.sql, tests/slack.test.ts
- **Dependencies:** PR 5
- **Acceptance:** Pro incoming webhook, same text as email; Starter/trial 403; webhook 4xx still emails

Reddit/X/Store types each get their own later PR **after** those APIs have BUILD PR “launch” on main. Not in v1 launch.

Live EmailPort (GA, after PR 6): `src/email/resend.ts`, `src/email/ses.ts`, `src/email/create.ts`. Default remains console / fake. `EMAIL_LIVE=1` plus `EMAIL_PROVIDER=resend|ses` and secrets. `EMAIL_FIXTURE_ONLY=1` always wins. `scripts/test.sh` stays offline.

---

## 7. Founder dogfood

`dogfood.md` checklist (14 days) is required before calling M2 launched. Keep it in-repo; update via PR.
