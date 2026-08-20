import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createEmail } from "./email/create.js";

const config = loadConfig();
const app = await buildApp({
  logger: true,
  databasePath: config.databasePath,
  authSecret: config.authSecret,
  publicBaseUrl: config.publicBaseUrl,
  secureCookies: config.nodeEnv === "production",
  email: createEmail(),
});
await app.listen({ host: "0.0.0.0", port: config.port });
