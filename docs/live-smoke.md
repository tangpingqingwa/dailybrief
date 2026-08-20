# Live smoke — ingest + send one TikTok via live ClipAPI

Operator-only. `bash scripts/live-smoke.sh` is **not** called from `scripts/test.sh` or GitHub Actions. `EMAIL_LIVE` and `CLIPAPI_KEY` stay unset in CI.

Ran this session against a local process started by the script (temp SQLite + documented console / `EMAIL_SINK=file` EmailPort). Live ClipAPI was not called: `CLIPAPI_KEY` is unset on this machine.

| Field | Value |
|---|---|
| Date | 2026-08-20 |
| SHA | `feat/live-smoke` (this PR) |
| Command | `bash scripts/live-smoke.sh` |
| Base | `http://127.0.0.1:<ephemeral>` started by the script |
| Mail | documented console / `EMAIL_SINK=file` (no vendor secret) |
| ClipAPI | `CLIPAPI_KEY` unset |

## Cases

| case | verdict | detail |
|---|---|---|
| ingest one TikTok via live ClipAPI | BLOCKED-SECRET | `CLIPAPI_KEY` is unset |
| EmailPort receives ingest+send | BLOCKED-SECRET | `CLIPAPI_KEY` is unset; no live ingest to send |
| unsub token works | BLOCKED-SECRET | `CLIPAPI_KEY` is unset |

**Totals:** PASS=0 PASS-ERROR=0 BLOCKED-SECRET=3 FAIL=0  
**RESULT: BLOCKED-SECRET**

## What the process actually saw

The script started `npm start`, waited for `GET /healthz`, then ran `src/live-smoke-cli.ts`. Because `CLIPAPI_KEY` is missing, it did **not** invent a creator page or a transcript. It recorded `BLOCKED-SECRET` and named the exact env var: **`CLIPAPI_KEY`**.

Mail vendor secrets (`RESEND_API_KEY`, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) are also unset. The documented fallback is wired: `EMAIL_SINK=file` plus `EMAIL_SINK_PATH` (console still prints). That sink was not exercised this run because ingest never started. A follow-up with `CLIPAPI_KEY` set will send through that file sink (or live Resend/SES when `EMAIL_LIVE=1` plus secrets).

## Re-run

```bash
# starts its own server; file/console EmailPort
CLIPAPI_KEY=ck_live_... bash scripts/live-smoke.sh

# or attach to an already-live box
LIVE_SMOKE_BASE=http://127.0.0.1:3000 \
CLIPAPI_KEY=ck_live_... \
bash scripts/live-smoke.sh
```

Overrides: `LIVE_SMOKE_HANDLE` (default `khaby.lame`), `EMAIL_SINK_PATH`, `LIVE_SMOKE_WORKDIR`.

Do not set `EMAIL_LIVE=1` or `CLIPAPI_KEY` in `.github/workflows/ci.yml`. Offline gate remains `bash scripts/test.sh`.
