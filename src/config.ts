const DEFAULT_PORT = 3000;
const DEFAULT_DATABASE_PATH = "./data/dailybrief.sqlite";

export type AppConfig = {
  port: number;
  databasePath: string;
  nodeEnv: string;
  freezeNewSources: boolean;
};

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
  };
}
