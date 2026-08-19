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

if [[ -f package.json ]]; then
  echo "== install =="
  if [[ ! -d node_modules ]]; then
    if [[ -f package-lock.json ]]; then
      npm ci
    else
      npm install
    fi
  fi

  # Never inherit a live ClipAPI target. Tests use tests/fake-clip.ts only.
  unset CLIPAPI_BASE CLIPAPI_KEY

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
