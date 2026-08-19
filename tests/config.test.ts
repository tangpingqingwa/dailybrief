import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadAuthSecret,
  loadConfig,
  parseFreezeNewSources,
  parseListenPort,
  parsePublicBaseUrl,
} from "../src/config.js";

test("parseListenPort defaults unset and empty to 3000 and rejects out of range", () => {
  assert.equal(parseListenPort(undefined), 3000);
  assert.equal(parseListenPort(""), 3000);
  assert.throws(() => parseListenPort("0"), /PORT must be an integer/);
  assert.throws(() => parseListenPort("abc"), /PORT must be an integer/);
  assert.throws(() => parseListenPort("70000"), /PORT must be an integer/);
});

test("FREEZE_NEW_SOURCES is 0/1 only and defaults off", () => {
  assert.equal(parseFreezeNewSources(undefined), false);
  assert.equal(parseFreezeNewSources(""), false);
  assert.equal(parseFreezeNewSources("0"), false);
  assert.equal(parseFreezeNewSources("1"), true);
  assert.throws(() => parseFreezeNewSources("true"), /FREEZE_NEW_SOURCES must be 0 or 1/);
});

test("loadConfig requires DAILYBRIEF_DATABASE and AUTH_SECRET in production", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production" }),
    /DAILYBRIEF_DATABASE is required in production/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        DAILYBRIEF_DATABASE: "/tmp/dailybrief.sqlite",
      }),
    /AUTH_SECRET is required in production/,
  );
  const config = loadConfig({
    NODE_ENV: "production",
    DAILYBRIEF_DATABASE: "/tmp/dailybrief.sqlite",
    AUTH_SECRET: "production-auth-secret",
    FREEZE_NEW_SOURCES: "1",
    PUBLIC_BASE_URL: "https://dailybrief.example/",
  });
  assert.equal(config.databasePath, "/tmp/dailybrief.sqlite");
  assert.equal(config.freezeNewSources, true);
  assert.equal(config.nodeEnv, "production");
  assert.equal(config.authSecret, "production-auth-secret");
  assert.equal(config.publicBaseUrl, "https://dailybrief.example");
});

test("AUTH_SECRET defaults in development and rejects short values", () => {
  const secret = loadAuthSecret({ NODE_ENV: "development" });
  assert.ok(secret.length >= 16);
  assert.throws(
    () => loadAuthSecret({ AUTH_SECRET: "short" }),
    /AUTH_SECRET must be at least 16 characters/,
  );
  assert.equal(parsePublicBaseUrl(undefined), "http://localhost:3000");
  assert.throws(() => parsePublicBaseUrl("not-a-url"), /PUBLIC_BASE_URL/);
});
