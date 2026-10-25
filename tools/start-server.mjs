// Serves the game to other players from this machine (bat\32 Игроки - начать раздачу.bat): the built page
// (dist/web) on PUBLIC_WEB_PORT and the gateway on GATEWAY_PORT, both on every interface, for the
// public address PUBLIC_HOST from .env. Players open http://<PUBLIC_HOST>:<PUBLIC_WEB_PORT>/ in a
// browser or start the player app (bat\30 Игроки - собрать набор.bat), which opens the same page; the page
// finds the gateway on the same host, port 8090.
//
// Only this process's environment changes; .env keeps local development as it is:
//   GATEWAY_HOST         PUBLIC_BIND, default 0.0.0.0 (every interface)
//   ALLOWED_ORIGINS      .env's origins plus the public page origin and its loopback twins
//   MODULE_UI_WRITE=0    a forwarded connection can look local, and the write guard trusts that
//   ASSET_PRELOAD=0      background model preloading is for the owner's own play, not the served
//                        gateway (owner, 12.10)
//   HD_TEXTURES=0        23.10 (7.48): the upscaled effect textures (tools/upscale-textures.mjs) stay with the
//                        owner's own play unless .env says PUBLIC_HD_TEXTURES=1 — whether players get them
//                        is the owner's decision
//   GATEWAY_RESTART_ON_PATCH=1 (unless .env says 0) after a TSWoW build the gateway restarts by
//                        itself once nobody is connected — or, counted down on the players' pages,
//                        GATEWAY_RESTART_DEADLINE_MIN (default 5) minutes after the build settled —
//                        keeping this environment
//   GATEWAY_SUPERVISE=1  (unless .env says 0) a crashed gateway is started again by itself
// The page server answers index.html and its assets only (10.13), compressed and revalidated.
// 25.10: the players' site at / (download, open registration, play), the game at /play/.
// 10.17 (updates): it also serves the player app's update from dist/player (bat\30):
// /player/latest.json, /player/latest.json.sig and /player/WoWWebClient.zip, read-only — installed
// apps check the first two at start and offer the zip when it is newer and correctly signed.
// The page server lives in this process too, so stopping it (Ctrl+C, bat\11 or bat\12 — the gateway
// restart or stop) stops both.

import "./env.mjs";

import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { authDatabaseRegistrar } from "./account-register.mjs";
import { mysqlBinary, worldserverConf } from "./paths.mjs";
import { playerSiteHandler } from "./player-site.mjs";

const { MANIFEST_FILE, parseManifest, playerUpdateFiles } = createRequire(import.meta.url)("../electron/player-update.cjs"); // 10.17 (updates)

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
if (!existsSync(`${webRoot}/index.html`)) throw new Error("dist/web is not built: run bat\\20 Сборка - игра.bat first.");
// 10.17 (updates): read per request, so a player build made while this runs is offered at once.
const playerRoot = fileURLToPath(new URL("../dist/player", import.meta.url));

const withPort = (host) => `http://${host}${webPort === 80 ? "" : `:${webPort}`}`;
const publicUrl = `${withPort(publicHost)}/`;
const origins = new Set((process.env.ALLOWED_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173")
  .split(",").map((origin) => origin.trim()).filter(Boolean));
for (const host of [publicHost, "127.0.0.1", "localhost"]) origins.add(withPort(host));
process.env.ALLOWED_ORIGINS = [...origins].join(",");
process.env.GATEWAY_HOST = bind;
process.env.MODULE_UI_WRITE = "0";
process.env.ASSET_PRELOAD = "0";
process.env.HD_TEXTURES = process.env.PUBLIC_HD_TEXTURES?.trim() === "1" ? "1" : "0"; // 23.10 (7.48)
process.env.NEURAL_RELIEF = process.env.PUBLIC_NEURAL_RELIEF?.trim() === "1" ? "1" : "0"; // 25.10 (7.47)
process.env.GATEWAY_RESTART_ON_PATCH ??= "1";
// 10.15: whatever .env says about restarts after a build, a crashed gateway comes back by itself
// (tools/gateway-supervisor.mjs; a sixth crash in ten minutes still stops it).
process.env.GATEWAY_SUPERVISE ??= "1";

// 25.10: open registration on the players' site unless .env says PUBLIC_REGISTRATION=0.
const register = process.env.PUBLIC_REGISTRATION?.trim() === "0"
  ? undefined : await authDatabaseRegistrar({ configPath: worldserverConf(), mysql: mysqlBinary() });
try {
  // 10.13: players get index.html and its assets only — glue.html, framexml.html and
  // character-lab.html are the owner's benches, and the local-only notice is not for them —
  // compressed, with validators, and the hashed bundles cached for good. 25.10: in front of the
  // game (now /play/) the players' site from site/ (tools/player-site.mjs).
  const handler = playerSiteHandler({ webRoot, siteRoot: fileURLToPath(new URL("../site", import.meta.url)), files: playerUpdateFiles(playerRoot), register });
  await new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", reject);
    server.listen(webPort, bind, resolve);
  });
} catch (error) {
  throw new Error(error.code === "EADDRINUSE"
    ? `Port ${webPort} is taken; free it or set PUBLIC_WEB_PORT in .env.` : error.message, { cause: error });
}
console.log(`Site for players: ${publicUrl} (site/ on ${bind}:${webPort}); the game: ${publicUrl}play/ (dist/web)`);
console.log(register ? "Registration: open (PUBLIC_REGISTRATION=0 in .env closes it)." : "Registration: closed (PUBLIC_REGISTRATION=0).");
console.log(`Gateway for players: http://${publicHost}:${gatewayPort}/ (on ${bind}:${gatewayPort})`);
console.log(`Players need TCP ${webPort} and ${gatewayPort} forwarded to this machine.`);
let offered;
try {
  const verdict = parseManifest(readFileSync(`${playerRoot}/${MANIFEST_FILE}`));
  offered = verdict.ok ? verdict.manifest.version : undefined;
} catch {
  offered = undefined;
}
console.log(offered === undefined
  ? "Player app update: none in dist/player (bat\\30 Игроки - собрать набор.bat builds and signs one)."
  : `Player app update: ${offered} offered at ${publicUrl}player/latest.json`);

await import("./start-gateway.mjs");
