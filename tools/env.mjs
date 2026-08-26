import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const envFile = fileURLToPath(new URL("../.env", import.meta.url));

// Node loads an env file without overwriting values supplied by the parent shell. Keeping this
// tiny loader dependency-free also means every generator can use the same machine description as
// the gateway.
if (process.env.WEBCLIENT_SKIP_ENV !== "1" && existsSync(envFile)) {
  if (typeof process.loadEnvFile !== "function") {
    throw new Error("TSWoW WebClient requires Node.js 22 or newer");
  }
  try {
    process.loadEnvFile(envFile);
  } catch (error) {
    throw new Error(`Could not load ${envFile}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}
