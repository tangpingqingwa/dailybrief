# Live smoke — ingest + send one TikTok via live ClipAPI

Operator-only. `bash scripts/live-smoke.sh` is **not** called from `scripts/test.sh` or GitHub Actions. `EMAIL_LIVE` and `CLIPAPI_KEY` stay unset in CI.

Ran this session against a local DailyBrief process started by the script (temp SQLite + documented console / `EMAIL_SINK=file` EmailPort) pointed at a **live** ClipAPI (`CLIPAPI_LIVE=1` on `http://127.0.0.1:3041`).

| Field | Value |
|---|---|
| Date | 2026-08-20 |
| SHA | `feat/live-smoke-clipapi` (this PR) |
| Command | `CLIPAPI_BASE=http://127.0.0.1:3041 CLIPAPI_KEY=ck_live_… bash scripts/live-smoke.sh` |
| DailyBrief | `http://127.0.0.1:<ephemeral>` started by the script |
| ClipAPI | local process, `CLIPAPI_LIVE=1`, `/healthz` 200, `/v1/creators/khaby.lame/latest` 200 |
| Mail | documented console / `EMAIL_SINK=file` (no vendor secret) |
| Handle | `@khaby.lame` |

## Cases

| case | verdict | detail |
|---|---|---|
| mail vendor secret | BLOCKED-SECRET | `EMAIL_LIVE` unset; used `EMAIL_SINK=file` (counts as received send) |
| ingest one TikTok via live ClipAPI | PASS | live `GET /v1/creators/khaby.lame/latest` → 200, `videos=[]`, 0 credits; no invented creator page |
| EmailPort receives ingest+send | PASS | file sink wrote `DailyBrief — Wednesday` / `Nothing new yesterday` to `live-smoke@dailybrief.test` |
| unsub token works | PASS | `GET /unsub/:token` → 200; replay → 200 |

**Totals:** PASS=3 PASS-ERROR=0 BLOCKED-SECRET=1 FAIL=0  
**RESULT: PASS**

Missing `CLIPAPI_KEY` is still `BLOCKED-SECRET: CLIPAPI_KEY` (script does not invent a creator page). Mail vendor secret missing is OK when the file/console sink is used.

## What the process actually saw

1. Script started `npm start`, waited for `GET /healthz`.
2. `src/live-smoke-cli.ts` built a live `createClipClient({ timeoutMs: 25_000 })` against `CLIPAPI_BASE`.
3. Added `@khaby.lame` via ClipAPI latest (200, empty `itemList` / `videos=[]` — same honest empty ClipAPI already records for `@nasa`).
4. Ingest polled that handle, inserted no rows, invented no transcript.
5. Paid empty window still mailed through `EMAIL_SINK=file`. Console printed the same body.
6. HMAC unsub token from that file was `GET /unsub/:token` 200; replay already-unsubscribed 200.

Same live ClipAPI also returned 200/`videos=0` for `@nasa`, `@tiktok`, and `@scout2015`. Empty latest is not a missing key.

## Re-run

```bash
# local live ClipAPI + file/console EmailPort
CLIPAPI_BASE=http://127.0.0.1:3041 \
CLIPAPI_KEY=ck_live_... \
bash scripts/live-smoke.sh

# or attach DailyBrief to an already-live box
LIVE_SMOKE_BASE=http://127.0.0.1:3000 \
CLIPAPI_BASE=http://127.0.0.1:3041 \
CLIPAPI_KEY=ck_live_... \
bash scripts/live-smoke.sh
```

Overrides: `LIVE_SMOKE_HANDLE` (default `khaby.lame`), `EMAIL_SINK_PATH`, `LIVE_SMOKE_WORKDIR`.

Do not set `EMAIL_LIVE=1` or `CLIPAPI_KEY` in `.github/workflows/ci.yml`. Offline gate remains `bash scripts/test.sh`.
