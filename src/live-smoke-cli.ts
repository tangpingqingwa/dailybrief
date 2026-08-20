import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildApp } from "./app.js";
import { createClipClient } from "./clients/clip.js";
import { loadAuthSecret, parsePublicBaseUrl } from "./config.js";
import { openDatabase } from "./db.js";
import { createEmail } from "./email/create.js";
import { extractUnsubToken } from "./email/fake.js";
import {
  LIVE_SMOKE_HANDLE_DEFAULT,
  missingClipKey,
  missingMailVendorSecret,
  readSentFile,
  runLiveSmoke,
  type LiveSmokeCase,
  type LiveSmokeVerdict,
} from "./live-smoke.js";

const handle = (process.env.LIVE_SMOKE_HANDLE ?? LIVE_SMOKE_HANDLE_DEFAULT).replace(
  /^@+/,
  "",
);
const workdir = process.env.LIVE_SMOKE_WORKDIR ?? "/tmp/dailybrief-live-smoke";
const sinkPath = process.env.EMAIL_SINK_PATH ?? join(workdir, "sent.json");
const reportPath = process.env.LIVE_SMOKE_REPORT ?? join(workdir, "report.json");

function record(name: string, verdict: LiveSmokeVerdict, detail: string): LiveSmokeCase {
  console.log(`| ${name} | ${verdict} | ${detail} |`);
  return { name, verdict, detail };
}

function writeReport(cases: LiveSmokeCase[], blocked: string | null): void {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify({ cases, blockedSecret: blocked }, null, 2)}\n`,
    "utf8",
  );
}

function exitFrom(cases: LiveSmokeCase[]): number {
  const fail = cases.filter((row) => row.verdict === "FAIL").length;
  const pass = cases.filter((row) => row.verdict === "PASS").length;
  const passError = cases.filter((row) => row.verdict === "PASS-ERROR").length;
  const blocked = cases.filter((row) => row.verdict === "BLOCKED-SECRET").length;
  console.log("");
  console.log(
    `summary: PASS=${pass} PASS-ERROR=${passError} BLOCKED-SECRET=${blocked} FAIL=${fail}`,
  );
  if (fail > 0) {
    console.log("RESULT: FAIL");
    return 1;
  }
  if (blocked > 0 && pass === 0) {
    console.log("RESULT: BLOCKED-SECRET");
    return 0;
  }
  console.log("RESULT: PASS");
  return 0;
}

async function main(): Promise<number> {
  const cases: LiveSmokeCase[] = [];
  const clipMissing = missingClipKey();

  console.log("== live-smoke (operator only; not CI) ==");
  console.log(`handle=@${handle}`);
  console.log(`clip=${clipMissing === null ? "CLIPAPI_KEY set" : `missing ${clipMissing}`}`);
  console.log("");
  console.log("| case | verdict | detail |");
  console.log("|---|---|---|");

  if (clipMissing !== null) {
    cases.push(
      record(
        "ingest one TikTok via live ClipAPI",
        "BLOCKED-SECRET",
        `${clipMissing} is unset`,
      ),
    );
    cases.push(
      record(
        "EmailPort receives ingest+send",
        "BLOCKED-SECRET",
        `${clipMissing} is unset; no live ingest to send`,
      ),
    );
    cases.push(
      record("unsub token works", "BLOCKED-SECRET", `${clipMissing} is unset`),
    );
    writeReport(cases, clipMissing);
    return exitFrom(cases);
  }

  mkdirSync(dirname(sinkPath), { recursive: true });
  process.env.EMAIL_SINK = process.env.EMAIL_SINK ?? "file";
  process.env.EMAIL_SINK_PATH = sinkPath;

  const vendorEnv = { ...process.env };
  delete vendorEnv.EMAIL_SINK;
  delete vendorEnv.EMAIL_SINK_PATH;
  const mailMissing = missingMailVendorSecret(vendorEnv);
  if (mailMissing !== null) {
    delete process.env.EMAIL_LIVE;
    cases.push(
      record(
        "mail vendor secret",
        "BLOCKED-SECRET",
        `${mailMissing} is unset; using EMAIL_SINK=file ${sinkPath}`,
      ),
    );
  } else {
    cases.push(
      record(
        "mail vendor secret",
        "PASS",
        `EMAIL_LIVE=1 provider=${process.env.EMAIL_PROVIDER ?? "?"}`,
      ),
    );
  }

  const dbPath = process.env.DAILYBRIEF_DATABASE ?? join(workdir, "dailybrief.sqlite");
  const db = openDatabase(dbPath);
  const authSecret = loadAuthSecret();
  const publicBaseUrl = parsePublicBaseUrl();
  const now = new Date();
  // Live latest+transcript can exceed the default 8s client budget.
  const clip = createClipClient({ timeoutMs: 25_000 });
  const email = createEmail();
  const app = await buildApp({
    db,
    email,
    clip,
    authSecret,
    publicBaseUrl,
    logger: false,
  });

  try {
    const result = await runLiveSmoke({
      db,
      clip,
      email,
      authSecret,
      publicBaseUrl,
      handle,
      now,
      readSent: () => (existsSync(sinkPath) ? readSentFile(sinkPath) : []),
    });
    for (const row of result.cases) {
      cases.push(record(row.name, row.verdict, row.detail));
    }

    const last = result.message;
    if (last !== null && /\/unsub\//.test(last.text)) {
      const token = extractUnsubToken(last.text);
      const res = await app.inject({ method: "GET", url: `/unsub/${token}` });
      const again = await app.inject({ method: "GET", url: `/unsub/${token}` });
      const ok =
        res.statusCode === 200 &&
        /unsubscribed/i.test(res.body) &&
        again.statusCode === 200;
      cases.push(
        record(
          "unsub token works",
          ok ? "PASS" : "FAIL",
          ok
            ? `GET /unsub/:token → ${res.statusCode}; replay → ${again.statusCode}`
            : `GET /unsub/:token → ${res.statusCode} ${res.body.slice(0, 80)}`,
        ),
      );
    } else if (result.cases.some((row) => row.verdict === "PASS-ERROR")) {
      cases.push(
        record("unsub token works", "PASS-ERROR", "no mail when ingest was delayed"),
      );
    } else {
      cases.push(record("unsub token works", "FAIL", "no unsub token in sent mail"));
    }
  } finally {
    await app.close();
    db.close();
  }

  writeReport(cases, null);
  return exitFrom(cases);
}

const code = await main();
process.exit(code);
