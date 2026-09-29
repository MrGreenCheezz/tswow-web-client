// Serves the game to other players from this machine (online\start-server.bat): the built page
// (dist/web) on PUBLIC_WEB_PORT and the gateway on GATEWAY_PORT, both on every interface, for the
// public address PUBLIC_HOST from .env. Players open http://<PUBLIC_HOST>:<PUBLIC_WEB_PORT>/ in a
// browser or start the player app (online\build-player.bat), which opens the same page; the page
// finds the gateway on the same host, port 8090.
//
// Only this process's environment changes; .env keeps local development as it is:
//   GATEWAY_HOST         PUBLIC_BIND, default 0.0.0.0 (every interface)
//   ALLOWED_ORIGINS      .env's origins plus the public page origin and its loopback twins
//   MODULE_UI_WRITE=0    a forwarded connection can look local, and the write guard trusts that
//   GATEWAY_RESTART_ON_PATCH=1 (unless .env says 0) after a TSWoW build the gateway restarts by
//                        itself once nobody is connected, keeping this environment
// The page server lives in this process too, so stopping it (Ctrl+C, restart-gateway.bat) stops both.

import "./env.mjs";

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// The same loopback-safe static server the Electron version serves its built page with.
const { serveStatic } = createRequire(import.meta.url)("../electron/static-server.cjs");

function port(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid ${name}: ${process.env[name]}`);
  return value;
}

const publicHost = process.env.PUBLIC_HOST?.trim();
if (!publicHost) {
  throw new Error("PUBLIC_HOST is not set in .env: the address other players reach this machine by, "
    + "for example PUBLIC_HOST=203.0.113.10 (see .env.example).");
}
const webPort = port("PUBLIC_WEB_PORT", 8091);
const gatewayPort = port("GATEWAY_PORT", 8090);
const bind = process.env.PUBLIC_BIND?.trim() || "0.0.0.0";
if (gatewayPort !== 8090 && !process.env.VITE_GATEWAY_ORIGIN) {
  console.warn(`WARNING: the page looks for the gateway on port 8090, but GATEWAY_PORT is ${gatewayPort}.`);
}
const webRoot = fileURLToPath(new URL("../dist/web", import.meta.url));
if (!existsSync(`${webRoot}/index.html`)) throw new Error("dist/web is not built: run web\\build.bat first.");

const withPort = (host) => `http://${host}${webPort === 80 ? "" : `:${webPort}`}`;
const publicUrl = `${withPort(publicHost)}/`;
const origins = new Set((process.env.ALLOWED_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173")
  .split(",").map((origin) => origin.trim()).filter(Boolean));
for (const host of [publicHost, "127.0.0.1", "localhost"]) origins.add(withPort(host));
process.env.ALLOWED_ORIGINS = [...origins].join(",");
process.env.GATEWAY_HOST = bind;
process.env.MODULE_UI_WRITE = "0";
process.env.GATEWAY_RESTART_ON_PATCH ??= "1";

try {
  await serveStatic(webRoot, { host: bind, port: webPort });
} catch (error) {
  throw new Error(error.code === "EADDRINUSE"
    ? `Port ${webPort} is taken; free it or set PUBLIC_WEB_PORT in .env.` : error.message, { cause: error });
}
console.log(`Page for players: ${publicUrl} (dist/web on ${bind}:${webPort})`);
console.log(`Gateway for players: http://${publicHost}:${gatewayPort}/ (on ${bind}:${gatewayPort})`);
console.log(`Players need TCP ${webPort} and ${gatewayPort} forwarded to this machine.`);

await import("./start-gateway.mjs");
