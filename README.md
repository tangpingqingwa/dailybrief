# DailyBrief

Build contract: [SPEC.md](./SPEC.md).

One morning email: the TikToks, Reddit threads, X accounts, and App Store review spikes you actually follow.

This is Recapio. It is the application layer, not the lottery ticket. It exists to force ClipAPI / RedditAPI / ThreadAPI / StoreAPI into production and to test whether consumer subs convert. Assume they convert poorly.

## Why this, and why overseas

English knowledge workers already pay for newsletters and try Recapio-class products. The job is real: stop opening four apps. Recapio’s own numbers showed traffic ≠ revenue. Build it anyway as dogfood and a conversion experiment, with a kill switch written down on day one.

Queries we can rank later: `tiktok daily recap`, `reddit newsletter`, `creator briefing email`.

## Exact demand

- Who: people who follow a fixed set of creators / subs / accounts and hate the open-app tax
- Acceptance: anything published before 07:00 local in their timezone is in that day’s mail; every line links back to the source

## Exact connector

Only our APIs. No direct platform traffic from this app.

```
user picks sources → scheduler
                   → ClipAPI.latest / transcript
                   → RedditAPI.sub / thread
                   → ThreadAPI.user/posts
                   → StoreAPI.reviews (optional source type)
                   → short summary (our model bill, hard cap)
                   → email / Slack
```

If an API is not production, that source type stays closed. Temporary scrapers here will rot the whole holding company.

## Exact combination

- Second-largest customer of the data APIs (after the free SEO sites)
- Homepage line: “powered by the same APIs we sell” — social proof for ClipAPI
- Free-site users who paste the same links every day get a subscribe CTA
- Price like Recapio: Starter $9 / Pro $19. No enterprise deck in year one

## Cost control

- ≤ 80 words per item; no essay on a 3-minute TikTok
- One summary per source item, shared across all subscribers
- Cheap model tier
- Hard source caps: Starter 5, Pro 25
- Cheapest transactional email; do not run a mail server

If model cost > 30% of that user’s subscription, cut length or frequency the same week. Do not “make it cooler.”

## Business model

Low-price subs. Primary success is not MRR:

1. Our own briefing runs every day
2. Real production traffic hits the four APIs
3. After 90 days, if paid users < 50 and nobody asks to pay, freeze features and only keep the lights on

## Will not do

- No feed, no social, no For You
- No second-brain workspace
- No browser-extension everything-bucket
- No second transcript extractor inside this repo

## First two weeks

1. ClipAPI only: three creators, one 7:30 email
2. One-click unsubscribe
3. Founder uses it for 14 days
4. Reddit / X / store reviews wait for those APIs

## Dogfood

The founder’s morning brief comes only from DailyBrief. Opening TikTok “following” by habit is logged as product debt.

## Risk

Consumer conversion will likely be Recapio-bad. That is the base case. Treat this as the factory that hardens connectors and you will not build a platform fantasy here.
