import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEmail,
  createUnavailableEmail,
  EmailUnavailableError,
  parseEmailFrom,
  parseEmailProvider,
  parseEmailSinkPath,
  resolveEmailAdapter,
} from "../src/email/create.js";
import { createFakeEmail } from "../src/email/fake.js";
import {
  EmailSendError,
  EMAIL_TIMEOUT_MS,
  type EmailMessage,
} from "../src/email/port.js";
import { createResendEmail, RESEND_API_BASE } from "../src/email/resend.js";
import { createSesEmail, parseAwsRegion, signAwsV4 } from "../src/email/ses.js";

const MESSAGE: EmailMessage = {
  to: "ada@example.com",
  subject: "DailyBrief — Wednesday",
  text: "Nothing new yesterday",
  html: "<p>Nothing new yesterday</p>",
  headers: {
    "List-Unsubscribe": "<http://dailybrief.test/unsub/token>",
  },
};

const RESEND_ENV = {
  EMAIL_LIVE: "1",
  EMAIL_PROVIDER: "resend",
  EMAIL_FROM: "DailyBrief <brief@dailybrief.test>",
  RESEND_API_KEY: "re_test_key",
} satisfies NodeJS.ProcessEnv;

const SES_ENV = {
  EMAIL_LIVE: "1",
  EMAIL_PROVIDER: "ses",
  EMAIL_FROM: "brief@dailybrief.test",
  AWS_ACCESS_KEY_ID: "AKIATEST",
  AWS_SECRET_ACCESS_KEY: "secretaccesskey",
  AWS_REGION: "us-east-1",
} satisfies NodeJS.ProcessEnv;

type Captured = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

function captureFetch(
  status: number,
  onCall?: (req: Captured) => void,
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    const captured: Captured = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body: typeof init?.body === "string" ? init.body : "",
    };
    onCall?.(captured);
    return new Response("{}", {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

test("parseEmailProvider and EMAIL_FROM reject junk", () => {
  assert.equal(parseEmailProvider("resend"), "resend");
  assert.equal(parseEmailProvider("ses"), "ses");
  assert.equal(parseEmailProvider("postmark"), null);
  assert.equal(parseEmailProvider("true"), null);
  assert.equal(parseEmailFrom("brief@dailybrief.test"), "brief@dailybrief.test");
  assert.equal(
    parseEmailFrom("DailyBrief <brief@dailybrief.test>"),
    "DailyBrief <brief@dailybrief.test>",
  );
  assert.equal(parseEmailFrom("not-an-email"), null);
  assert.equal(parseEmailFrom(""), null);
  assert.equal(parseAwsRegion(undefined), "us-east-1");
  assert.equal(parseAwsRegion("eu-west-1"), "eu-west-1");
  assert.equal(parseAwsRegion("US-EAST-1"), null);
  assert.equal(parseAwsRegion("localhost"), null);
});

test("resolveEmailAdapter stays console / fail-closed unless EMAIL_LIVE=1", () => {
  assert.deepEqual(resolveEmailAdapter({}), { kind: "console" });
  assert.deepEqual(resolveEmailAdapter({ EMAIL_LIVE: "true" }), { kind: "console" });
  assert.deepEqual(resolveEmailAdapter({ EMAIL_LIVE: "0" }), { kind: "console" });
  assert.deepEqual(
    resolveEmailAdapter({ EMAIL_LIVE: "1", EMAIL_FIXTURE_ONLY: "1" }),
    { kind: "console" },
  );
  assert.deepEqual(
    resolveEmailAdapter({
      EMAIL_LIVE: "1",
      EMAIL_FIXTURE_ONLY: "1",
      EMAIL_SINK: "file",
      EMAIL_SINK_PATH: "/tmp/sent.json",
    }),
    { kind: "console", path: "/tmp/sent.json" },
  );
  assert.equal(resolveEmailAdapter({ NODE_ENV: "production" }).kind, "unavailable");
  assert.equal(
    resolveEmailAdapter({
      NODE_ENV: "production",
      EMAIL_LIVE: "1",
      EMAIL_FIXTURE_ONLY: "1",
    }).kind,
    "unavailable",
  );
  assert.equal(
    resolveEmailAdapter({ EMAIL_LIVE: "1", EMAIL_PROVIDER: "resend" }).kind,
    "unavailable",
  );
  assert.equal(
    resolveEmailAdapter({
      EMAIL_LIVE: "1",
      EMAIL_PROVIDER: "resend",
      EMAIL_FROM: "brief@dailybrief.test",
    }).kind,
    "unavailable",
  );
  assert.deepEqual(resolveEmailAdapter(RESEND_ENV), {
    kind: "resend",
    config: {
      apiKey: "re_test_key",
      from: "DailyBrief <brief@dailybrief.test>",
    },
  });
  assert.deepEqual(resolveEmailAdapter(SES_ENV), {
    kind: "ses",
    config: {
      from: "brief@dailybrief.test",
      region: "us-east-1",
      accessKeyId: "AKIATEST",
      secretAccessKey: "secretaccesskey",
    },
  });
});

test("createEmail without EMAIL_LIVE never fetches Resend or SES", async () => {
  let calls = 0;
  const fetchImpl = async (): Promise<Response> => {
    calls += 1;
    throw new Error("network must not run");
  };

  const consolePort = createEmail({ env: {}, fetch: fetchImpl });
  await consolePort.send(MESSAGE);
  assert.equal(calls, 0);

  const prod = createEmail({
    env: { NODE_ENV: "production" },
    fetch: fetchImpl,
  });
  await assert.rejects(
    () => prod.send(MESSAGE),
    (err: unknown) => {
      assert.ok(err instanceof EmailUnavailableError);
      assert.equal(err.code, "email_unavailable");
      return true;
    },
  );
  assert.equal(calls, 0);

  const gated = createEmail({
    env: { ...RESEND_ENV, EMAIL_FIXTURE_ONLY: "1" },
    fetch: fetchImpl,
  });
  await gated.send(MESSAGE);
  assert.equal(calls, 0);

  await assert.rejects(
    () => createUnavailableEmail().send(MESSAGE),
    /live email is not enabled/,
  );
});

test("createFakeEmail remains the offline test adapter", async () => {
  const email = createFakeEmail();
  await email.send(MESSAGE);
  assert.equal(email.sent.length, 1);
  assert.equal(email.sent[0].to, MESSAGE.to);
  assert.equal(email.sent[0].subject, MESSAGE.subject);
});

test("Resend adapter posts to api.resend.com with injected fetch", async () => {
  const seen: Captured[] = [];
  const email = createResendEmail({
    apiKey: "re_test_key",
    from: "brief@dailybrief.test",
    fetch: captureFetch(200, (req) => seen.push(req)),
  });
  await email.send(MESSAGE);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${RESEND_API_BASE}/emails`);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].headers.authorization, "Bearer re_test_key");
  const body = JSON.parse(seen[0].body) as {
    from: string;
    to: string[];
    subject: string;
    text: string;
    html: string;
    headers: Record<string, string>;
  };
  assert.equal(body.from, "brief@dailybrief.test");
  assert.deepEqual(body.to, ["ada@example.com"]);
  assert.equal(body.subject, MESSAGE.subject);
  assert.equal(body.text, MESSAGE.text);
  assert.equal(body.html, MESSAGE.html);
  assert.equal(
    body.headers["List-Unsubscribe"],
    "<http://dailybrief.test/unsub/token>",
  );
});

test("Resend adapter maps HTTP and transport failures", async () => {
  const http = createResendEmail({
    apiKey: "re_test_key",
    from: "brief@dailybrief.test",
    fetch: captureFetch(401),
  });
  await assert.rejects(
    () => http.send(MESSAGE),
    (err: unknown) => {
      assert.ok(err instanceof EmailSendError);
      assert.equal(err.status, 401);
      return true;
    },
  );

  const down = createResendEmail({
    apiKey: "re_test_key",
    from: "brief@dailybrief.test",
    fetch: async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.rejects(() => down.send(MESSAGE), /ECONNREFUSED/);
});

test("SES adapter signs AWS4 and posts to email.{region}.amazonaws.com", async () => {
  const seen: Captured[] = [];
  const now = new Date("2026-08-20T12:00:00.000Z");
  const email = createSesEmail({
    from: "brief@dailybrief.test",
    region: "us-east-1",
    accessKeyId: "AKIATEST",
    secretAccessKey: "secretaccesskey",
    fetch: captureFetch(200, (req) => seen.push(req)),
    now: () => now,
  });
  await email.send(MESSAGE);
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].url,
    "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails",
  );
  assert.equal(seen[0].method, "POST");
  assert.match(seen[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=/);
  assert.equal(seen[0].headers["x-amz-date"], "20260820T120000Z");
  assert.equal(seen[0].headers.host, "email.us-east-1.amazonaws.com");
  const expected = signAwsV4({
    method: "POST",
    url: new URL("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails"),
    body: seen[0].body,
    region: "us-east-1",
    service: "ses",
    accessKeyId: "AKIATEST",
    secretAccessKey: "secretaccesskey",
    now,
  });
  assert.equal(seen[0].headers.authorization, expected.authorization);
  const payload = JSON.parse(seen[0].body) as {
    FromEmailAddress: string;
    Destination: { ToAddresses: string[] };
    Content: {
      Simple: {
        Subject: { Data: string };
        Body: { Text: { Data: string }; Html?: { Data: string } };
        Headers: Array<{ Name: string; Value: string }>;
      };
    };
  };
  assert.equal(payload.FromEmailAddress, "brief@dailybrief.test");
  assert.deepEqual(payload.Destination.ToAddresses, ["ada@example.com"]);
  assert.equal(payload.Content.Simple.Subject.Data, MESSAGE.subject);
  assert.equal(payload.Content.Simple.Body.Text.Data, MESSAGE.text);
  assert.equal(payload.Content.Simple.Body.Html?.Data, MESSAGE.html);
  assert.deepEqual(payload.Content.Simple.Headers, [
    {
      Name: "List-Unsubscribe",
      Value: "<http://dailybrief.test/unsub/token>",
    },
  ]);
});

test("SES adapter rejects a bad region before fetch and maps HTTP errors", async () => {
  assert.throws(
    () =>
      createSesEmail({
        from: "brief@dailybrief.test",
        region: "not-a-region",
        accessKeyId: "AKIATEST",
        secretAccessKey: "secretaccesskey",
        fetch: captureFetch(200),
      }),
    /AWS_REGION is invalid/,
  );

  const http = createSesEmail({
    from: "brief@dailybrief.test",
    region: "eu-west-1",
    accessKeyId: "AKIATEST",
    secretAccessKey: "secretaccesskey",
    fetch: captureFetch(403),
  });
  await assert.rejects(
    () => http.send(MESSAGE),
    (err: unknown) => {
      assert.ok(err instanceof EmailSendError);
      assert.equal(err.status, 403);
      return /SES send failed with HTTP 403/.test(err.message);
    },
  );
});

test("createEmail(EMAIL_LIVE=1) uses injected fetch for Resend and SES", async () => {
  const seen: Captured[] = [];
  const fetchImpl = captureFetch(200, (req) => seen.push(req));
  const resend = createEmail({ env: RESEND_ENV, fetch: fetchImpl });
  await resend.send(MESSAGE);
  assert.equal(seen[0].url, `${RESEND_API_BASE}/emails`);

  const ses = createEmail({
    env: SES_ENV,
    fetch: fetchImpl,
    now: () => new Date("2026-08-20T12:00:00.000Z"),
  });
  await ses.send(MESSAGE);
  assert.equal(
    seen[1].url,
    "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails",
  );
  assert.equal(EMAIL_TIMEOUT_MS, 8000);
  assert.equal(parseEmailSinkPath({ EMAIL_SINK: "console" }), null);
});
