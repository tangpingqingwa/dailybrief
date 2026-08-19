import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadConfig,
  parseFreezeNewSources,
  parseListenPort,
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

test("loadConfig requires DAILYBRIEF_DATABASE in production", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production" }),
    /DAILYBRIEF_DATABASE is required in production/,
  );
  const config = loadConfig({
    NODE_ENV: "production",
    DAILYBRIEF_DATABASE: "/tmp/dailybrief.sqlite",
    FREEZE_NEW_SOURCES: "1",
  });
  assert.equal(config.databasePath, "/tmp/dailybrief.sqlite");
  assert.equal(config.freezeNewSources, true);
  assert.equal(config.nodeEnv, "production");
});
