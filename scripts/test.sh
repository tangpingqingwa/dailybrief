#!/usr/bin/env bash
# Offline gate for main. Must exit 0 on a clean clone with no secrets.
# Contract checks stay; once package.json exists we also typecheck and run
# node:test. Do not require live third-party networks.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

echo "== contract files =="
for f in README.md SPEC.md BUILD.md CONTRIBUTING.md scripts/test.sh; do
  [[ -f "$f" ]] || fail "missing $f"
  [[ -s "$f" ]] || fail "empty $f"
done

echo "== contributing rules are documented =="
grep -q 'main must always be buildable' CONTRIBUTING.md \
  || grep -q 'main` must always be buildable' CONTRIBUTING.md \
  || fail "CONTRIBUTING.md does not state the main-branch rule"

echo "== SPEC mentions git collaboration =="
grep -q 'Git collaboration' SPEC.md || fail "SPEC.md missing Git collaboration section"

echo "== no committed secrets =="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git ls-files | grep -E '(^|/)\.env$|(^|/)id_rsa$|\.pem$|credentials\.json$' >/dev/null; then
    fail "secret-like path is tracked"
  fi
fi

echo "== markdown is UTF-8 text =="
file -b --mime-encoding README.md SPEC.md BUILD.md CONTRIBUTING.md | grep -qiE 'utf-8|us-ascii' \
  || fail "docs are not UTF-8/ASCII"

echo "== magic-link contract =="
grep -q 'HMAC-signed token, 20 min TTL' SPEC.md \
  || fail "SPEC.md missing magic-link TTL contract"
grep -q 'EmailPort.send' SPEC.md || fail "SPEC.md missing EmailPort.send"
grep -q 'EmailPort.send' BUILD.md || fail "BUILD.md missing EmailPort.send"
[[ -f src/auth/token.ts ]] || fail "missing src/auth/token.ts"
[[ -f src/email/port.ts ]] || fail "missing src/email/port.ts"
[[ -f tests/auth.test.ts ]] || fail "missing tests/auth.test.ts"
grep -q 'createFakeEmail' tests/auth.test.ts \
  || fail "auth tests must use fake email (offline)"

echo "== clip ingest contract =="
grep -q 'GET /v1/creators/{handle}/latest' BUILD.md \
  || fail "BUILD.md missing ClipAPI latest poll"
grep -q 'shared summary' BUILD.md || fail "BUILD.md missing shared summary test"
grep -q 'SummaryPort.summarize' BUILD.md || fail "BUILD.md missing SummaryPort"
[[ -f src/clients/clip.ts ]] || fail "missing src/clients/clip.ts"
[[ -f src/ingest.ts ]] || fail "missing src/ingest.ts"
[[ -f src/summary/fake.ts ]] || fail "missing src/summary/fake.ts"
[[ -f tests/ingest.test.ts ]] || fail "missing tests/ingest.test.ts"
grep -q 'createFakeClip' tests/ingest.test.ts \
  || fail "ingest tests must use fake ClipAPI (offline)"
grep -q 'tiktok.com\|vm.tiktok.com\|www.tiktok.com' src/ingest.ts \
  && fail "ingest must not scrape TikTok hosts"

echo "== daily send contract =="
grep -q 'Nothing new yesterday' SPEC.md \
  || fail "SPEC.md missing empty-day copy"
grep -q 'List-Unsubscribe' SPEC.md \
  || fail "SPEC.md missing List-Unsubscribe"
grep -q 'GET  /unsub/:token' SPEC.md \
  || fail "SPEC.md missing GET /unsub/:token"
[[ -f src/send.ts ]] || fail "missing src/send.ts"
[[ -f src/email/templates/daily.ts ]] || fail "missing src/email/templates/daily.ts"
[[ -f src/http/routes/unsub.ts ]] || fail "missing src/http/routes/unsub.ts"
[[ -f tests/send.test.ts ]] || fail "missing tests/send.test.ts"
grep -q 'createFakeEmail' tests/send.test.ts \
  || fail "send tests must use fake email (offline)"
grep -q 'Nothing new yesterday' src/email/templates/daily.ts \
  || fail "empty-mail template missing 'Nothing new yesterday'"
if grep -Eqi 'resend|postmark|ses\.amazonaws|smtp' src/send.ts src/email/templates/daily.ts src/http/routes/unsub.ts; then
  fail "daily send must use EmailPort only (no live mail)"
fi

echo "== live EmailPort (env-gated) =="
[[ -f src/email/create.ts ]] || fail "missing src/email/create.ts"
[[ -f src/email/resend.ts ]] || fail "missing src/email/resend.ts"
[[ -f src/email/ses.ts ]] || fail "missing src/email/ses.ts"
[[ -f tests/email.test.ts ]] || fail "missing tests/email.test.ts"
grep -q 'liveEmailEnabled' src/config.ts || fail "config missing liveEmailEnabled"
grep -q 'EMAIL_LIVE' src/config.ts || fail "config missing EMAIL_LIVE"
grep -q 'EMAIL_FIXTURE_ONLY' src/config.ts || fail "config missing EMAIL_FIXTURE_ONLY"
grep -q 'createEmail' src/email/create.ts || fail "missing createEmail factory"
grep -q 'createResendEmail' src/email/resend.ts || fail "missing createResendEmail"
grep -q 'createSesEmail' src/email/ses.ts || fail "missing createSesEmail"
grep -q 'createFakeEmail' tests/email.test.ts \
  || fail "email tests must keep fake email (offline)"
grep -q 'EMAIL_FIXTURE_ONLY' tests/email.test.ts \
  || fail "email tests must assert EMAIL_FIXTURE_ONLY wins"
if grep -Eqi 'https?://[^[:space:]]*(api\.resend\.com|email\.[^[:space:]]*amazonaws\.com)' \
  src/send.ts src/app.ts src/auth/*.ts src/http/routes/*.ts src/email/fake.ts src/email/console.ts src/email/templates/*.ts; then
  fail "app send path must use EmailPort only (no live Resend/SES hosts)"
fi
if grep -Eqi 'EMAIL_LIVE=1|EMAIL_LIVE=true' .github/workflows/ci.yml; then
  fail "CI must not set EMAIL_LIVE=1"
fi
if grep -RInE 'RESEND_API_KEY=|AWS_SECRET_ACCESS_KEY=' .github >/dev/null 2>&1; then
  fail "CI must not set live email secrets"
fi

echo "== stripe billing + source caps =="
grep -Fq '| Starter | $9 / mo | 5 |' SPEC.md \
  || fail "SPEC.md missing Starter $9 / 5 sources"
grep -Fq '| Pro | $19 / mo | 25 |' SPEC.md \
  || fail "SPEC.md missing Pro $19 / 25 sources"
grep -q '6th source on starter' BUILD.md \
  || fail "BUILD.md missing starter cap test"
[[ -f src/billing/port.ts ]] || fail "missing src/billing/port.ts"
[[ -f src/billing/fake.ts ]] || fail "missing src/billing/fake.ts"
[[ -f src/billing/plans.ts ]] || fail "missing src/billing/plans.ts"
[[ -f src/sources.ts ]] || fail "missing src/sources.ts"
[[ -f tests/billing.test.ts ]] || fail "missing tests/billing.test.ts"
[[ -f tests/sources.test.ts ]] || fail "missing tests/sources.test.ts"
grep -q 'createFakeStripe' tests/billing.test.ts \
  || fail "billing tests must use fake Stripe (offline)"
grep -q 'source_cap' tests/sources.test.ts \
  || fail "sources tests must assert the plan cap"
if grep -Eqi 'https?://[^[:space:]]*stripe\.com' \
  src/billing/*.ts src/http/routes/billing.ts src/sources.ts; then
  fail "billing must use StripePort only (no live Stripe)"
fi

echo "== slack webhook (pro) =="
grep -q 'Slack: Pro only' SPEC.md \
  || fail "SPEC.md missing Slack Pro-only contract"
grep -q 'If webhook 4xx, email still sends' SPEC.md \
  || fail "SPEC.md missing Slack 4xx still-email rule"
grep -q 'POST /app/slack' SPEC.md \
  || fail "SPEC.md missing POST /app/slack"
[[ -f src/slack/port.ts ]] || fail "missing src/slack/port.ts"
[[ -f src/slack/fake.ts ]] || fail "missing src/slack/fake.ts"
[[ -f src/slack/webhook.ts ]] || fail "missing src/slack/webhook.ts"
[[ -f src/http/routes/slack.ts ]] || fail "missing src/http/routes/slack.ts"
[[ -f src/migrations/005_slack.sql ]] || fail "missing src/migrations/005_slack.sql"
[[ -f tests/slack.test.ts ]] || fail "missing tests/slack.test.ts"
grep -q 'createFakeSlack' tests/slack.test.ts \
  || fail "slack tests must use fake Slack (offline)"
grep -q 'slack_not_allowed' tests/slack.test.ts \
  || fail "slack tests must refuse non-Pro plans"
grep -q 'createFakeSlack' src/send.ts \
  && fail "send must not import the Slack fake"
if grep -Eqi 'https?://hooks\.slack\.com' \
  src/slack/*.ts src/http/routes/slack.ts src/send.ts src/auth/users.ts; then
  fail "slack must use SlackPort only (no live Slack)"
fi

if [[ -f package.json ]]; then
  echo "== install =="
  if [[ ! -d node_modules ]]; then
    if [[ -f package-lock.json ]]; then
      npm ci
    else
      npm install
    fi
  fi

  # Never inherit a live ClipAPI, Stripe, Slack, or mail target. Tests use fakes only.
  unset CLIPAPI_BASE CLIPAPI_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_API_KEY SLACK_WEBHOOK_URL
  unset EMAIL_LIVE EMAIL_PROVIDER EMAIL_FROM RESEND_API_KEY
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION AWS_DEFAULT_REGION SES_REGION
  export EMAIL_FIXTURE_ONLY=1
  [[ "${EMAIL_LIVE:-}" != "1" ]] || fail "EMAIL_LIVE must stay unset in test.sh"

  echo "== tsc --noEmit =="
  npx tsc --noEmit

  echo "== unit tests =="
  # Quoted so bash 3.2 does not eat **; Node 22's test runner expands the glob.
  test_log="$(mktemp)"
  trap 'rm -f "$test_log"' EXIT
  set +e
  npx tsx --test --test-reporter spec 'tests/**/*.test.ts' | tee "$test_log"
  test_status=${PIPESTATUS[0]}
  set -e
  [[ $test_status -eq 0 ]] || fail "unit tests failed"
  grep -Eq 'tests[[:space:]]+[1-9][0-9]*' "$test_log" \
    || fail "test runner reported 0 tests"
fi

echo "OK: buildable and testable"
