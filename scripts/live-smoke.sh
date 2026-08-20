#!/usr/bin/env bash
# Optional operator smoke: ingest + send one TikTok via *live* ClipAPI.
# Not called from scripts/test.sh. Never set CLIPAPI_KEY / EMAIL_LIVE in Actions.
#
# Starts a local process (or attaches to LIVE_SMOKE_BASE) with a documented
# console / file EmailPort sink. Walks: live latest+transcript ingest, daily
# send, one-click unsub. Each case is PASS / PASS-ERROR / FAIL / BLOCKED-SECRET.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo "FAIL: live-smoke must not run in GitHub Actions" >&2
  exit 1
fi

if [[ "${CI:-}" == "true" && "${LIVE_SMOKE_ALLOW_CI:-}" != "1" ]]; then
  echo "FAIL: live-smoke is opt-in and refuses CI unless LIVE_SMOKE_ALLOW_CI=1" >&2
  exit 1
fi

STARTED_PID=""
TMPDIR_SMOKE=""

cleanup() {
  if [[ -n "${STARTED_PID}" ]]; then
    kill "${STARTED_PID}" >/dev/null 2>&1 || true
    wait "${STARTED_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

pick_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

TMPDIR_SMOKE="${LIVE_SMOKE_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/dailybrief-live-smoke.XXXXXX")}"
export LIVE_SMOKE_WORKDIR="${TMPDIR_SMOKE}"
export EMAIL_SINK="${EMAIL_SINK:-file}"
export EMAIL_SINK_PATH="${EMAIL_SINK_PATH:-${TMPDIR_SMOKE}/sent.json}"
export LIVE_SMOKE_REPORT="${LIVE_SMOKE_REPORT:-${TMPDIR_SMOKE}/report.json}"
export LIVE_SMOKE_HANDLE="${LIVE_SMOKE_HANDLE:-khaby.lame}"
export AUTH_SECRET="${AUTH_SECRET:-live-smoke-auth-secret}"
export DAILYBRIEF_DATABASE="${DAILYBRIEF_DATABASE:-${TMPDIR_SMOKE}/dailybrief.sqlite}"
# File sink is the documented fallback when RESEND_API_KEY / SES keys are absent.
unset EMAIL_FIXTURE_ONLY || true

if [[ ! -d node_modules ]]; then
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
fi

if [[ -n "${LIVE_SMOKE_BASE:-}" ]]; then
  BASE="${LIVE_SMOKE_BASE%/}"
  echo "attach ${BASE}"
  if ! curl -fsS --max-time 5 "${BASE}/healthz" >/dev/null; then
    echo "FAIL: LIVE_SMOKE_BASE ${BASE} /healthz failed" >&2
    exit 1
  fi
else
  PORT="$(pick_port)"
  BASE="http://127.0.0.1:${PORT}"
  export PORT
  export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-${BASE}}"
  echo "start local process on ${BASE} (console/file EmailPort; live ClipAPI if CLIPAPI_KEY set)"
  npm start >"${TMPDIR_SMOKE}/server.log" 2>&1 &
  STARTED_PID=$!
  ready=0
  for _ in $(seq 1 40); do
    if ! kill -0 "${STARTED_PID}" >/dev/null 2>&1; then
      echo "FAIL: server exited before /healthz" >&2
      sed -n '1,80p' "${TMPDIR_SMOKE}/server.log" >&2 || true
      exit 1
    fi
    if curl -fsS --max-time 2 "${BASE}/healthz" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.25
  done
  if [[ "$ready" != "1" ]]; then
    echo "FAIL: server did not become ready on ${BASE}/healthz" >&2
    sed -n '1,80p' "${TMPDIR_SMOKE}/server.log" >&2 || true
    exit 1
  fi
fi

export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-${BASE}}"
npx tsx src/live-smoke-cli.ts
