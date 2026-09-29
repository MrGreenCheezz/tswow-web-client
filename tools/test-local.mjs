// Tries the setup for other players on this machine alone, before anything is sent
// (online\test-local.bat): the server of online\start-server.bat, but listening on 127.0.0.1 only,
// so nothing is reachable from outside, and the very player app from dist\player (or the browser)
// pointed at it. A players' server that already runs is used as it is.
//
//   node tools/test-local.mjs            the player app
//   node tools/test-local.mjs browser    the page in the default browser
//
// Unlike the real address, 127.0.0.1 is a secure context, so a browser here has Web Crypto; the
// plain-http path players' browsers take (src/auth/Sha1.ts) is covered by its tests instead.

import "./env.mjs";

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

// `node --test` with no file list (`npm test`, `npm run test:source`) collects every `test-*.mjs`,
// this launcher included, and runs it as a test file: it rebuilt dist, opened the players' server
// window and started the player app in the middle of a test run. The runner marks each file it
// spawns with NODE_TEST_CONTEXT; a launcher has nothing to test there.
if (process.env.NODE_TEST_CONTEXT) {
  console.log("tools/test-local.mjs is a launcher, not a test: skipped under node --test");
  process.exit(0);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const webPort = Number.parseInt(process.env.PUBLIC_WEB_PORT ?? "8091", 10);
const gatewayPort = Number.parseInt(process.env.GATEWAY_PORT ?? "8090", 10);
const pageUrl = `http://127.0.0.1:${webPort}/`;
const app = `${root}dist\\player\\WoWWebClient\\WoWWebClient.exe`;
const browser = process.argv.includes("browser");
/** Everything else goes to the app, as with the other launchers (e.g. --window=1280x720). */
const appOptions = process.argv.slice(2).filter((arg) => arg !== "browser");

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

if (!browser && !existsSync(app)) {
  console.error("The player app is not built yet: run online\\build-player.bat first.");
  process.exit(1);
}

if (await listening(webPort)) {
  console.log(`A players' server already answers on ${pageUrl}; using it.`);
} else {
  // Its own window, as online\start-server.bat always runs; loopback only, whatever .env says.
  spawn("cmd.exe", ["/c", "start", "TSWoW WebClient - server for players (local test)", `${root}online\\start-server.bat`], {
    env: { ...process.env, PUBLIC_BIND: "127.0.0.1", PUBLIC_HOST: "127.0.0.1" },
    detached: true,
    stdio: "ignore",
  }).unref();
  console.log("Started the players' server on 127.0.0.1 only, in its own window; close that window to stop it.");
}

if (browser) {
  // A browser shows black until the gateway answers; the player app waits by itself.
  console.log(`Waiting for ${pageUrl} and its gateway (the first start may rebuild the game)...`);
  const deadline = Date.now() + 600_000;
  while (!((await listening(webPort)) && (await listening(gatewayPort)))) {
    if (Date.now() > deadline) { console.error("The server did not come up within 10 minutes."); process.exit(1); }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  execFile("cmd.exe", ["/c", "start", "", pageUrl], { windowsHide: true });
  console.log(`Opened ${pageUrl}`);
} else {
  spawn(app, [`--server-url=${pageUrl}`, ...appOptions], { detached: true, stdio: "ignore" }).unref();
  console.log(`Started the player app against ${pageUrl}`);
}
