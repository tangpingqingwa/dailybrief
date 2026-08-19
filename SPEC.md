# DailyBrief — Product Development Spec

**Version:** 1.0  
**Status:** Ready to build  
**Repo:** https://github.com/tangpingqingwa/dailybrief  
**Upstream (required):** ClipAPI  
**Upstream (gated):** RedditAPI, ThreadAPI, StoreAPI  
**Forbidden:** any scraper inside this repo

Application layer. Recapio-shaped. Assume consumer conversion is poor. Success is dogfood + production load on the APIs + a written kill switch.

---

## 1. Product statement

One morning email: new public items from creators / subreddits / X accounts / (optional) App Store review spikes the user picked.

Every line links to the source. Summaries ≤ 80 words, shared across subscribers.

One-line pitch: **Stop opening four apps. One 7:30 email.**

---

## 2. Goals and non-goals

### Goals

- Anything published before 07:00 in the user’s timezone appears in that day’s send.
- Founder’s own brief comes only from DailyBrief.
- ClipAPI-only at launch.
- If model cost > 30% of that user’s subscription, cut length or frequency the same week.
- After 90 days: if paid users < 50 **and** nobody is asking to pay, freeze features.

### Non-goals

- Feed / social / For You.
- Second brain / notes database.
- Browser extension everything-bucket.
- Second transcript extractor.
- Enterprise SSO in year one.

---

## 3. Source types

| type | id | upstream | launch |
|---|---|---|---|
| `tiktok_creator` | handle | ClipAPI `/v1/creators/{handle}/latest` + transcript | M1 |
| `reddit_sub` | sub name | RedditAPI `/v1/r/{sub}/latest` | when RedditAPI M3 |
| `x_account` | handle | ThreadAPI `/v1/users/{handle}/posts` | when ThreadAPI M2 |
| `ios_reviews` | app id | StoreAPI reviews, 1★/2★ only | when StoreAPI M3 |

If upstream is not production, the type is hidden in the UI. No stubs that scrape.

---

## 4. Accounts and billing

Auth: email magic link.

| Plan | Price | Sources | Extra |
|---|---|---|---|
| Free trial | $0 / 7 days | 3 | watermark “trial” in footer |
| Starter | $9 / mo | 5 | email only |
| Pro | $19 / mo | 25 | email + Slack incoming webhook |

Annual = 2 months free (optional M4). Stripe Customer Portal. One-click unsubscribe in every email (RFC 8058 `List-Unsubscribe`).

No enterprise deck.

---

## 5. Data model

```ts
type User = {
  id: string
  email: string
  timezone: string          // IANA, default America/New_York
  plan: "trial" | "starter" | "pro"
  sendHour: 7               // v1 fixed 07:00 local
}

type Source = {
  id: string
  userId: string            // or shared catalog later; v1 per-user
  type: SourceType
  externalId: string
  label: string
}

type Item = {
  id: string                // hash(type, externalItemId)
  type: SourceType
  externalItemId: string
  url: string
  title: string
  publishedAt: string
  transcriptOrBody: string | null   // stored hashed / truncated; not a second warehouse
  summary: string                   // ≤ 80 words
  summaryModel: string
}

type Delivery = {
  id: string
  userId: string
  date: string              // user-local date
  itemIds: string[]
  sentAt: string | null
  providerId: string | null
}
```

**Shared summary:** `Item.summary` is global. User A and user B following the same creator share one summary. This is the main COGS control.

---

## 6. Pipeline

```
hourly (or 15 min for latest):
  for source in distinct(sources):
    pull latest ids from upstream
    insert new Items without summary

continuous:
  for item in items where summary is null:
    fetch transcript/body via upstream (ClipAPI transcript, etc.)
    summarize ≤ 80 words, cheap model
    write summary once

daily per user at 07:00 local:
  select items published in [yesterday 07:00, today 07:00) local
    that match user sources
  render email
  send
  record Delivery
```

Empty day: still send a one-line “Nothing new yesterday” so the user knows the machine is alive. Starter+ only; trial can skip empties.

Idempotent: one Delivery per (user, local date).

---

## 7. Summary rules

- Model: cheapest hosted tier that stays coherent (pin name in env `SUMMARY_MODEL`).
- Prompt: 80 words max, no intro fluff, include 1 factual hook, no hashtags, English.
- If no transcript (`no_transcript`): summary = first 200 chars of description + “(no transcript)”.
- Never summarize behind a paywall we did not fetch.
- Cost alert: daily model $ / active paid user. If > 30% of ARPU, auto-switch to description-only for Starter.

No user-custom prompts in v1 (Recapio Pro feature — skip).

---

## 8. Email

Provider: cheapest transactional (Resend / Postmark / SES). Do not run a mail server.

Subject: `DailyBrief — {weekday}` or `DailyBrief — {N} new from your sources`.

Body: HTML + text. Each item: source label, title, ≤80 word summary, **Read source** button.

Footer: unsubscribe, manage sources, “Powered by the same APIs we sell” + ClipAPI link.

Slack: Pro only, same text, incoming webhook. If webhook 4xx, email still sends.

---

## 9. Web app

```
GET  /                    marketing
GET  /app                 source list (auth)
POST /app/sources         add (validate via upstream latest)
POST /app/sources/:id/delete
GET  /app/preview         last delivery
GET  /app/billing
GET  /unsub/:token
```

Add-source UX: paste TikTok profile URL or `@handle`. Call ClipAPI latest; if 404, refuse.

No infinite browse. This is not a feed.

---

## 10. COGS and caps

| Lever | Rule |
|---|---|
| Source cap | 5 / 25 hard |
| Summary length | 80 words |
| Shared cache | mandatory |
| Email | transactional only |
| Poll | latest endpoint (0 credits on ClipAPI) + transcript only for **new** ids |
| Transcript | 1 ClipAPI credit per new item, paid from DailyBrief’s internal key |

Internal ClipAPI key billed to this product’s P&L.

---

## 11. Kill switch (normative)

At day 90 after first paid sub **or** first 1,000 trial signups, whichever later:

- If `paid_users < 50` AND support inbox has no “I want to pay / raise limits” thread → **freeze**: no new source types, no Slack upgrades, only keep ClipAPI path alive for dogfood.
- Do not pivot into a second brain.

---

## 12. Acceptance

| # | Case | Expected |
|---|---|---|
| 1 | User adds 3 TikTok handles | latest poll works |
| 2 | New video before 07:00 local | in next email |
| 3 | Two users same video | one summary row |
| 4 | Unsubscribe link | one click, no login |
| 5 | ClipAPI down | email says source delayed, no scrape fallback |
| 6 | Empty day | one-line empty mail (paid) |
| 7 | Founder 14-day dogfood | checklist in repo `/dogfood.md` |

---

## 13. Milestones

**M1:** magic link, 3 TikTok sources, 07:00 email, unsub.  
**M2:** Stripe $9/$19, source caps, shared summaries.  
**M3:** Slack; Reddit type if API ready.  
**M4:** X + Store types if APIs ready.

Launch = M2.

---

## 14. Layout

```
/
  SPEC.md
  README.md
  src/
    web/
    worker/
    email/
    clients/clip.ts   # only official clients
  dogfood.md
```

`clients/` may not import adapters from other monorepos’ internal scrapers.

## 15. Git collaboration (normative)

Development is GitHub trunk-based. **`main` is always cloneable, buildable, and testable.**

| Rule | Requirement |
|---|---|
| Integration branch | `main` only. No long-lived `develop`. |
| How code lands | Pull request into `main`. No direct push. |
| Required check | GitHub Actions workflow `ci` (job id `ci`) must be green. |
| Local / CI test | `bash scripts/test.sh` — offline, no production secrets. |
| Branch names | `feat/` `fix/` `docs/` `chore/` `test/` + short slug. |
| Merge | Squash. Delete the head branch. |
| Broken `main` | Treat as an incident. Fix on `fix/…` via PR. |

Full process: [CONTRIBUTING.md](./CONTRIBUTING.md).

Implementation plan (stack, modules, PR DAG): [BUILD.md](./BUILD.md).

Until there is an application binary, `scripts/test.sh` still has to pass: contract files exist, SPEC/CONTRIBUTING agree, no tracked secrets. Adding a server or CLI means **extending** that script with unit/contract tests. Live upstream calls are optional and must not be required for `main` to stay green.
