import { createHash, createHmac } from "node:crypto";
import {
  EMAIL_TIMEOUT_MS,
  EmailSendError,
  type EmailFetch,
  type EmailMessage,
  type EmailPort,
} from "./port.js";

export type SesEmailConfig = {
  from: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  fetch?: EmailFetch;
  timeoutMs?: number;
  now?: () => Date;
};

type SesSimpleBody = {
  FromEmailAddress: string;
  Destination: { ToAddresses: string[] };
  Content: {
    Simple: {
      Subject: { Data: string; Charset: "UTF-8" };
      Body: {
        Text: { Data: string; Charset: "UTF-8" };
        Html?: { Data: string; Charset: "UTF-8" };
      };
      Headers?: Array<{ Name: string; Value: string }>;
    };
  };
};

export function parseAwsRegion(value: string | undefined): string | null {
  const raw = value === undefined || value === "" ? "us-east-1" : value.trim();
  if (!/^[a-z]{2}(-gov)?(-[a-z]+)+-\d+$/.test(raw)) {
    return null;
  }
  return raw;
}

/** Live SES v2 EmailPort. Host is derived from a validated region only. */
export function createSesEmail(config: SesEmailConfig): EmailPort {
  const region = parseAwsRegion(config.region);
  if (region === null) {
    throw new EmailSendError("AWS_REGION is invalid");
  }
  const host = `email.${region}.amazonaws.com`;
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = config.timeoutMs ?? EMAIL_TIMEOUT_MS;
  const now = config.now ?? (() => new Date());

  return {
    async send(message: EmailMessage): Promise<void> {
      const payload: SesSimpleBody = {
        FromEmailAddress: config.from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: message.text, Charset: "UTF-8" },
            },
          },
        },
      };
      if (message.html !== undefined) {
        payload.Content.Simple.Body.Html = {
          Data: message.html,
          Charset: "UTF-8",
        };
      }
      if (message.headers !== undefined) {
        payload.Content.Simple.Headers = Object.entries(message.headers).map(
          ([Name, Value]) => ({ Name, Value }),
        );
      }

      const body = JSON.stringify(payload);
      const url = new URL(`https://${host}/v2/email/outbound-emails`);
      const signed = signAwsV4({
        method: "POST",
        url,
        body,
        region,
        service: "ses",
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        ...(config.sessionToken !== undefined
          ? { sessionToken: config.sessionToken }
          : {}),
        now: now(),
      });

      let response: Response;
      try {
        response = await fetchImpl(url.toString(), {
          method: "POST",
          redirect: "manual",
          headers: signed.headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new EmailSendError(sendFailureMessage(err), 0);
      }

      if (response.status >= 200 && response.status < 300) {
        return;
      }
      throw new EmailSendError(
        `SES send failed with HTTP ${response.status}`,
        response.status,
      );
    },
  };
}

export type AwsV4SignArgs = {
  method: string;
  url: URL;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  now: Date;
};

export type AwsV4Signed = {
  authorization: string;
  amzDate: string;
  contentSha256: string;
  headers: Record<string, string>;
};

export function signAwsV4(args: AwsV4SignArgs): AwsV4Signed {
  const amzDate = toAmzDate(args.now);
  const dateStamp = amzDate.slice(0, 8);
  const contentSha256 = sha256Hex(args.body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: args.url.host,
    "x-amz-content-sha256": contentSha256,
    "x-amz-date": amzDate,
  };
  if (args.sessionToken !== undefined && args.sessionToken !== "") {
    headers["x-amz-security-token"] = args.sessionToken;
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name].trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    args.method,
    args.url.pathname,
    args.url.search.startsWith("?") ? args.url.search.slice(1) : "",
    canonicalHeaders,
    signedHeaders,
    contentSha256,
  ].join("\n");

  const credentialScope = `${dateStamp}/${args.region}/${args.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hmac(
    signingKey(args.secretAccessKey, dateStamp, args.region, args.service),
    stringToSign,
  ).toString("hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    authorization,
    amzDate,
    contentSha256,
    headers: {
      ...headers,
      authorization,
    },
  };
}

function toAmzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function signingKey(
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function sendFailureMessage(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") {
    return "SES send timed out";
  }
  if (err instanceof Error && err.name === "AbortError") {
    return "SES send timed out";
  }
  return err instanceof Error ? err.message : "SES send failed";
}
