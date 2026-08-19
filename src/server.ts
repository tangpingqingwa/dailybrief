import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp({
  logger: true,
  databasePath: config.databasePath,
  authSecret: config.authSecret,
  publicBaseUrl: config.publicBaseUrl,
  secureCookies: config.nodeEnv === "production",
});
await app.listen({ host: "0.0.0.0", port: config.port });
