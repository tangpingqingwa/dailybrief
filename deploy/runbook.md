# DailyBrief — one-VPS runbook

Single Docker host. SQLite on a named volume. Email, Stripe, and Slack stay fail-closed until you opt in with `EMAIL_LIVE=1` / `STRIPE_LIVE=1` / `SLACK_LIVE=1`.

## Env

Copy [`.env.example`](../.env.example) to `/etc/dailybrief.env` (mode `600`). Set:

| Variable | Production |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | listen port (default `3000`) |
| `DAILYBRIEF_DATABASE` | required; must sit on the volume, e.g. `/app/data/dailybrief.sqlite` |
| `AUTH_SECRET` | required; ≥ 16 chars |
| `PUBLIC_BASE_URL` | public `https://` origin (magic links + unsub) |
| `FREEZE_NEW_SOURCES` | leave `0` until the 90-day review |
| `EMAIL_LIVE` | leave `0` (or unset) until soak. Only `1` goes live |
| `STRIPE_LIVE` | leave `0` until checkout is ready. Only `1` goes live |
| `SLACK_LIVE` | leave `0` until Pro Slack send is ready. Only `1` goes live |

Do not bake secrets into the image. Do not commit `.env`. A bind-mount over `/app/data` must be writable by uid `1000` (`node`).

## Build and run

```bash
docker build -t dailybrief:local .
docker run -d --name dailybrief --restart unless-stopped --init \
  --env-file /etc/dailybrief.env \
  -p 127.0.0.1:3000:3000 \
  -v dailybrief-data:/app/data \
  dailybrief:local
```

The process listens on `0.0.0.0:$PORT` as the non-root `node` user (uid 1000). Keep the published port on loopback and terminate TLS on Caddy or nginx.

## Health

`GET /healthz` → `200 {"ok":true}`. No auth.

```bash
curl -fsS "http://127.0.0.1:${PORT:-3000}/healthz"
```

Magic-link mail stays console / fail-closed until `EMAIL_LIVE=1`. Checkout is `503 billing_unavailable` until `STRIPE_LIVE=1`. Pro Slack posts stay `{ok:false,status:503}` until `SLACK_LIVE=1` (email still sends).

## Enable live email / Stripe / Slack

1. Confirm `/healthz` is green with all live flags off.
2. Email: set `EMAIL_LIVE=1`, `EMAIL_PROVIDER=resend` or `ses`, `EMAIL_FROM`, plus `RESEND_API_KEY` or AWS SES keys. `EMAIL_FIXTURE_ONLY=1` always wins.
3. Stripe: set `STRIPE_LIVE=1`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`. Point Stripe at `POST /billing/webhook`. Unset / `0` / `true` stay fail-closed.
4. Slack: set `SLACK_LIVE=1`. Users still paste their own incoming webhook on `POST /app/slack` (Pro only). A webhook 4xx does not block email.
5. Recreate the container. Leave the flags unset in CI. `scripts/test.sh` unsets them and fails if `.github/workflows/ci.yml` sets `EMAIL_LIVE=1`, `STRIPE_LIVE=1`, or `SLACK_LIVE=1`.

Roll back: set the flag to `0` (or unset) and recreate. Do not run live Stripe, Slack, or mail from CI.

## Data

Back up the SQLite file on the volume. Founder 14-day checklist lives in [`/dogfood.md`](../dogfood.md); do not mark those days done from this deploy.
