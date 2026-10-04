// The page needs the WebClient gateway in the Electron window just as in a browser; without it the
// login screen gets none of its files and stays black. The built Electron version therefore starts
// the gateway itself when nothing listens on its port: the same `node tools/start-gateway.mjs` that
// restart-gateway.bat runs, from the WebClient checkout the build came from, on the dist/code that
// electron\build.bat built alongside the page. The shell stops that gateway again when it exits; a
// gateway somebody else started is used as it is and left alone.

"use strict";

const { execFileSync, spawn } = require("node:child_process");
const { execFile } = require("node:child_process"); // L10 (10.11)
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

/** Whether something accepts connections on `host:port`. */
function listening(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.connect({ host: host.replace(/^\[|\]$/g, ""), port });
    socket.setTimeout(3000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

/** Resolves once something listens on `host:port`, however long that takes. */
async function waitUntilListening(port, host) {
  while (!(await listening(port, host))) await new Promise((resolve) => setTimeout(resolve, 1000));
}

/** The first candidate that is a WebClient checkout with a built gateway. */
function findWebClientRoot(candidates) {
  return candidates.find((dir) => fs.existsSync(path.join(dir, "tools", "start-gateway.mjs"))
    && fs.existsSync(path.join(dir, "dist", "code", "gateway", "main.js")));
}

/** node.exe as the .bat files pick it: WEBCLIENT_NODE_DIR, then the bundled .runtime\node, then PATH. */
function nodeExecutable(root) {
  for (const dir of [process.env.WEBCLIENT_NODE_DIR, path.join(root, ".runtime", "node")]) {
    if (dir && fs.existsSync(path.join(dir, "node.exe"))) return path.join(dir, "node.exe");
  }
  return "node";
}

/** The last `count` lines of a log file, or nothing when it cannot be read. */
function logTail(file, count = 20) {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split(/\r?\n/).slice(-count).join("\n");
  } catch {
    return "";
  }
}

/**
 * Starts the gateway with its output in `logFile`. `ready` resolves once the port listens and
 * rejects when the gateway exits first or has not listened within `timeoutMs`; `stop` ends the
 * gateway and anything it forked.
 */
function startGateway(root, { port, logFile, timeoutMs = 120_000 }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.openSync(logFile, "w");
  const child = spawn(nodeExecutable(root), ["--enable-source-maps", "tools/start-gateway.mjs"],
    { cwd: root, stdio: ["ignore", log, log], windowsHide: true });
  fs.closeSync(log);

  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (error) reject(error); else resolve();
    };
    child.once("error", (error) => settle(new Error(`Node.js не запустился: ${error.message}`)));
    child.once("exit", (code) => settle(new Error(`Шлюз завершился с кодом ${code}.`)));
    const started = Date.now();
    let probing = false;
    const timer = setInterval(async () => {
      if (settled || probing) return;
      probing = true;
      if (await listening(port)) settle();
      else if (Date.now() - started > timeoutMs) settle(new Error(`Шлюз не открыл порт ${port} за ${timeoutMs / 1000} с.`));
      probing = false;
    }, 500);
  });

  function stop() {
    if (child.exitCode !== null || child.pid === undefined) return;
    if (process.platform === "win32") {
      try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
    } else {
      child.kill();
    }
  }

  return { ready, stop };
}

// L10 (10.11, slice 3): the gateway this shell would start runs whatever dist/code holds; built
// before its sources last changed, it serves yesterday's routes (a new one answers 404 and the page
// reports the feature missing). The checkout answers itself — `tools/build-gateway.mjs --check`
// walks the gateway's imports and compares times, compiling nothing.

/**
 * The check's exit code and output as the shell acts on them: 0 is a stale build (its last line
 * names the first stale source), 1 a current one. Anything else — a crash, a timeout, no Node.js —
 * is `unknown`, which never stops the game.
 */
function describeStaleness(exitCode, output) {
  const line = String(output ?? "").trim().split(/\r?\n/).pop()?.trim() ?? "";
  if (exitCode === 0) return { stale: true, text: line || "dist/code is older than the gateway's sources." };
  if (exitCode === 1) return { stale: false };
  return { stale: false, unknown: true, text: line || `the freshness check ended with ${exitCode}` };
}

/**
 * Whether the checkout at `root` has a stale gateway build. Never rejects; a checkout from before
 * the check existed answers `unknown`.
 */
function gatewayBuildState(root, { node = nodeExecutable(root), timeoutMs = 20_000 } = {}) {
  const script = path.join(root, "tools", "build-gateway.mjs");
  if (!fs.existsSync(script)) return Promise.resolve({ stale: false, unknown: true, text: `${script} not found` });
  return new Promise((resolve) => {
    execFile(node, [script, "--check"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: timeoutMs },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        resolve(describeStaleness(code, code === 0 ? stdout : `${stdout ?? ""}${stderr ?? ""}` || error?.message));
      });
  });
}

module.exports = { findWebClientRoot, listening, logTail, startGateway, waitUntilListening };
module.exports.describeStaleness = describeStaleness; // L10 (10.11)
module.exports.gatewayBuildState = gatewayBuildState; // L10 (10.11)
