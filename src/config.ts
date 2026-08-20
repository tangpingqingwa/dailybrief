const DEFAULT_PORT = 3000;
const DEFAULT_DATABASE_PATH = "./data/dailybrief.sqlite";
const DEFAULT_PUBLIC_BASE_URL = "http://localhost:3000";
const DEV_AUTH_SECRET = "dev-only-auth-secret-not-for-production";

export type AppConfig = {
  port: number;
  databasePath: string;
  nodeEnv: string;
  freezeNewSources: boolean;
  authSecret: string;
  publicBaseUrl: string;
  liveEmail: boolean;
  liveStripe: boolean;
  liveSlack: boolean;
};

/** BUILD env flags are `"1"` to enable; anything else is off. */
export function isEnvFlagEnabled(value: string | undefined): boolean {
  return value === "1";
}

/**
 * Live transactional mail. EMAIL_FIXTURE_ONLY=1 always wins so CI / test.sh
 * stay offline even if EMAIL_LIVE leaks into the environment.
 */
export function liveEmailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isEnvFlagEnabled(env.EMAIL_FIXTURE_ONLY)) {
    return false;
  }
  return isEnvFlagEnabled(env.EMAIL_LIVE);
}

/**
 * Live Stripe checkout / portal / webhooks. EMAIL_FIXTURE_ONLY=1 always wins
 * so CI stays offline even if STRIPE_LIVE leaks into the environment.
 */
export function liveStripeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isEnvFlagEnabled(env.EMAIL_FIXTURE_ONLY)) {
    return false;
  }
  return isEnvFlagEnabled(env.STRIPE_LIVE);
}

/**
 * Live Slack incoming webhooks on the daily send path. EMAIL_FIXTURE_ONLY=1
 * always wins so CI stays offline even if SLACK_LIVE leaks into the environment.
 */
export function liveSlackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isEnvFlagEnabled(env.EMAIL_FIXTURE_ONLY)) {
    return false;
  }
  return isEnvFlagEnabled(env.SLACK_LIVE);
}

export function parseListenPort(value = process.env.PORT): number {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer 1-65535, got ${JSON.stringify(value)}`);
  }
  return port;
}

export function parseFreezeNewSources(
  value = process.env.FREEZE_NEW_SOURCES,
): boolean {
  if (value === undefined || value === "" || value === "0") {
    return false;
  }
  if (value === "1") {
    return true;
  }
  throw new Error(
    `FREEZE_NEW_SOURCES must be 0 or 1, got ${JSON.stringify(value)}`,
  );
}

export function parsePublicBaseUrl(
  value = process.env.PUBLIC_BASE_URL,
): string {
  if (value === undefined || value === "") {
    return DEFAULT_PUBLIC_BASE_URL;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`PUBLIC_BASE_URL must be an absolute URL, got ${JSON.stringify(value)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`PUBLIC_BASE_URL must be http(s), got ${JSON.stringify(value)}`);
  }
  return url.origin;
}

export function loadAuthSecret(
  env: NodeJS.ProcessEnv = process.env,
  nodeEnv = env.NODE_ENV ?? "development",
): string {
  const secret = env.AUTH_SECRET;
  if (secret !== undefined && secret !== "") {
    if (secret.length < 16) {
      throw new Error("AUTH_SECRET must be at least 16 characters");
    }
    return secret;
  }
  if (nodeEnv === "production") {
    throw new Error("AUTH_SECRET is required in production");
  }
  return DEV_AUTH_SECRET;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const databasePath = env.DAILYBRIEF_DATABASE;
  if ((databasePath === undefined || databasePath === "") && nodeEnv === "production") {
    throw new Error("DAILYBRIEF_DATABASE is required in production");
  }
  return {
    port: parseListenPort(env.PORT),
    databasePath:
      databasePath !== undefined && databasePath !== ""
        ? databasePath
        : DEFAULT_DATABASE_PATH,
    nodeEnv,
    freezeNewSources: parseFreezeNewSources(env.FREEZE_NEW_SOURCES),
    authSecret: loadAuthSecret(env, nodeEnv),
    publicBaseUrl: parsePublicBaseUrl(env.PUBLIC_BASE_URL),
    liveEmail: liveEmailEnabled(env),
    liveStripe: liveStripeEnabled(env),
    liveSlack: liveSlackEnabled(env),
  };
}
