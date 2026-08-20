import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

test("deploy artifacts exist and stay fail-closed", () => {
  const dockerfile = read("Dockerfile");
  const envExample = read(".env.example");
  const runbook = read("deploy/runbook.md");
  const dogfood = read("dogfood.md");

  assert.match(dockerfile, /node:22/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /PORT/);
  assert.match(dockerfile, /src\/server\.ts/);
  assert.doesNotMatch(dockerfile, /EMAIL_LIVE=1/);
  assert.doesNotMatch(dockerfile, /STRIPE_LIVE=1/);
  assert.doesNotMatch(dockerfile, /SLACK_LIVE=1/);
  assert.doesNotMatch(dockerfile, /sk_live_|whsec_|re_/);

  assert.match(envExample, /DAILYBRIEF_DATABASE=/);
  assert.match(envExample, /AUTH_SECRET=/);
  assert.match(envExample, /EMAIL_LIVE=0/);
  assert.match(envExample, /STRIPE_LIVE=0/);
  assert.match(envExample, /SLACK_LIVE=0/);
  assert.doesNotMatch(envExample, /sk_live_[A-Za-z0-9]+/);
  assert.doesNotMatch(envExample, /whsec_[A-Za-z0-9]{8,}/);

  assert.match(runbook, /\/healthz/);
  assert.match(runbook, /docker build/);
  assert.match(runbook, /docker run/);
  assert.match(runbook, /STRIPE_LIVE=1/);
  assert.match(runbook, /SLACK_LIVE=1/);
  assert.match(runbook, /EMAIL_LIVE=1/);
  assert.doesNotMatch(runbook, /docker-compose/);

  assert.match(dogfood, /Day 1/);
  assert.match(dogfood, /Day 14/);
  assert.doesNotMatch(dogfood, /14 days (are )?done|checklist complete|dogfood complete/i);
});
