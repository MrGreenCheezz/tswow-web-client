// The Electron version of the TSWoW WebClient: the same page the browser opens, talking to the
// same local gateway, in a window whose processes run on the performance cores.
//
// Why a shell at all: on this machine's hybrid CPU (i7-12700KF, Windows 10 without Thread
// Director) Chrome's renderer lands on the efficiency cores, and the city bench measured the same
// frame at 22 ms there against 13 ms on the performance cores. A web page cannot choose its cores;
// a process can. Windows children inherit their parent's affinity mask, so the main process pins
// itself before Chromium starts the GPU and renderer processes, and every process the shell owns
// is re-checked afterwards (priority class is not inherited, so it is set per process).
//
// Which page, first match wins:
//   1. --webclient-url (or WEBCLIENT_URL): opened as is, nothing else checked (the bench uses it).
//   2. --server-url, or server.json next to this file (the player app, `build.mjs --player`): the
//      page a players' server serves (tools/start-server.mjs). The window waits, with a status
//      page, until that server and its gateway answer.
//   3. A built page served here: --web-dir, or the web/ directory build.mjs bundles next to this
//      file in dist/electron, at http://127.0.0.1:<port>/, the origin the gateway's default
//      ALLOWED_ORIGINS admits. When no gateway listens it starts one itself (gateway.cjs).
//   4. The Vite dev server at http://127.0.0.1:5173/ (web/start-dev.bat); the window waits for the
//      gateway the developer starts.
// A plain-http page on a non-loopback address (a player's server) is not a secure context, so the
// shell asks Chromium to treat that origin as secure: Web Crypto and cross-origin isolation then
// work as they do on 127.0.0.1.
//
// Options (command line, `electron . --cpu-class=fastest`):
//   --webclient-url=<url>     page to open instead of any other
//   --server-url=<url>        players' server page, instead of server.json's
//   --web-dir=<dir>           built page directory to serve, e.g. ../dist/web
//   --port=<port>             port of the built page (default 5173, the port Vite uses in development)
//   --cpu-class=fastest|slowest|none   core class (default fastest; none = Windows decides)
//   --priority=normal|abovenormal|high (default abovenormal)
//   --uncapped                no vsync and no frame-rate limit (measurement)
//   --window=<width>x<height> initial client size (default 1600x900)
//   --no-isolation            do not add the cross-origin isolation headers to the page origin
//   --no-js-profiling         do not allow the JS Self-Profiling API on the page (the freeze
//                             recording, O → «Записать фризы», then records without stack samples)
// Chromium switches such as --remote-debugging-port=<port> pass through as usual.

"use strict";

const { app, BrowserWindow, Menu, dialog, session } = require("electron");
const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { serveStatic } = require("./static-server.cjs");
const { findWebClientRoot, listening, logTail, startGateway, waitUntilListening } = require("./gateway.cjs");

function option(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

/** The player app's settings (build.mjs --player): `url` of the server's page, default CPU policy. */
function readServerConfig() {
  const file = path.join(__dirname, "server.json");
  if (!fs.existsSync(file)) return undefined;
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof config.url !== "string" || !/^https?:\/\//.test(config.url)) throw new Error(`${file}: url must be http(s)://…`);
  return config;
}

const DEV_SERVER_URL = "http://127.0.0.1:5173/";
/** Where the page looks for the gateway unless the build baked another VITE_GATEWAY_ORIGIN. */
const GATEWAY_PORT = 8090;
/** The gateway this shell started itself (built page, nothing listening); stopped on exit. */
let startedGateway;
const serverConfig = readServerConfig();
const commandLineUrl = option("webclient-url", process.env.WEBCLIENT_URL || undefined);
/**
 * The page of a players' server (player app), unless the command line names a page:
 * --server-url, else server.json. online\test-local.bat points the sent app at 127.0.0.1 this way.
 */
const serverUrlOption = option("server-url", undefined);
if (serverUrlOption !== undefined && !/^https?:\/\//.test(serverUrlOption)) throw new Error(`--server-url: ${serverUrlOption}`);
const remoteUrl = commandLineUrl === undefined ? serverUrlOption ?? serverConfig?.url : undefined;
const explicitUrl = commandLineUrl ?? remoteUrl;
const bundledWeb = path.join(__dirname, "web");
const webDirOption = option("web-dir", undefined);
const webDir = explicitUrl !== undefined ? undefined
  : webDirOption !== undefined ? path.resolve(webDirOption)
  : fs.existsSync(path.join(bundledWeb, "index.html")) ? bundledWeb : undefined;
const webPort = Number(option("port", "5173"));
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535) throw new Error(`--port: ${option("port")}`);
const cpuClass = option("cpu-class", serverConfig?.cpuClass ?? "fastest");
const priority = option("priority", serverConfig?.priority ?? "abovenormal");
const uncapped = process.argv.includes("--uncapped");
const isolated = !process.argv.includes("--no-isolation");
const jsProfiling = !process.argv.includes("--no-js-profiling");
const [windowWidth, windowHeight] = option("window", "1600x900").split("x").map(Number);
if (!["fastest", "slowest", "none"].includes(cpuClass)) throw new Error(`--cpu-class: ${cpuClass}`);
if (!["normal", "abovenormal", "high"].includes(priority)) throw new Error(`--priority: ${priority}`);

// A game window is never "in the background" for its own purposes: chat, cast bars and the
// world keep running while another window has focus.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("force_high_performance_gpu");
if (uncapped) {
  app.commandLine.appendSwitch("disable-frame-rate-limit");
  app.commandLine.appendSwitch("disable-gpu-vsync");
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
if (explicitUrl !== undefined) {
  const page = new URL(explicitUrl);
  if (page.protocol === "http:" && !LOOPBACK_HOSTS.has(page.hostname)) {
    // SRP6 login needs Web Crypto and the crowd pose worker needs cross-origin isolation; both
    // exist only in a secure context, which plain http on a public address is not.
    const gatewayOrigin = `http://${page.hostname}:${GATEWAY_PORT}`;
    app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", `${page.origin},${gatewayOrigin}`);
  }
}

const policyScript = path.join(__dirname, "cpu-policy.ps1");
const processName = path.parse(process.execPath).name;
const constrained = new Set();

function policyArgs(ids) {
  return ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", policyScript,
    "-Class", cpuClass, "-Priority", priority, "-ProcessName", processName, "-ProcessIds", ids.join(",")];
}

/**
 * Whether there is a CPU policy to apply. The player app defaults to none of it (server.json), so
 * on a stranger's machine it never runs PowerShell, and a failing policy never stops the game.
 */
let policyActive = process.platform === "win32" && !(cpuClass === "none" && priority === "normal");

/** Pins this main process before any child exists, so the children inherit the mask. */
function constrainSelf() {
  if (!policyActive) return;
  try {
    const result = JSON.parse(execFileSync("powershell.exe", policyArgs([process.pid]),
      { encoding: "utf8", windowsHide: true }));
    constrained.add(process.pid);
    console.log(`[electron] cpu policy ${result.policy}, mask ${result.mask}, priority ${result.priority}`);
  } catch (error) {
    policyActive = false;
    console.warn(`[electron] cpu policy not applied, running without it: ${error.message}`);
  }
}

/** Applies the policy to shell processes started since the last pass (GPU, renderer, utility). */
let sweeping = false;
function constrainChildren() {
  if (!policyActive || sweeping) return;
  const fresh = app.getAppMetrics().map((metric) => metric.pid).filter((pid) => !constrained.has(pid));
  if (fresh.length === 0) return;
  sweeping = true;
  execFile("powershell.exe", policyArgs(fresh), { encoding: "utf8", windowsHide: true }, (error, stdout) => {
    sweeping = false;
    if (error) { console.warn(`[electron] cpu policy failed for ${fresh.join(",")}: ${error.message}`); return; }
    for (const pid of JSON.parse(stdout).applied) constrained.add(pid);
    const types = app.getAppMetrics().filter((metric) => fresh.includes(metric.pid)).map((metric) => metric.type);
    console.log(`[electron] constrained ${fresh.length} process(es): ${types.join(", ")}`);
  });
}

constrainSelf();

/** The page to open: an explicit URL, the built page served here, or the Vite dev server. */
async function resolvePageUrl() {
  if (explicitUrl !== undefined) return explicitUrl;
  if (webDir === undefined) return DEV_SERVER_URL;
  try {
    return `${await serveStatic(webDir, { port: webPort, isolation: isolated, jsProfiling })}/`;
  } catch (error) {
    dialog.showErrorBox("WoW WebClient", error.code === "EADDRINUSE"
      ? `Порт ${webPort} уже занят — скорее всего, запущен Vite dev-сервер (web\\start-dev.bat).\n`
        + "Закройте его или запустите с --port=<порт>, добавив http://127.0.0.1:<порт> в ALLOWED_ORIGINS шлюза."
      : `Не удалось открыть собранную страницу ${webDir}: ${error.message}`);
    return undefined;
  }
}

/** A plain page for the seconds, or the fault, before the game page can open. */
function statusPage(title, text) {
  const escape = (value) => value.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  return "data:text/html;charset=utf-8," + encodeURIComponent("<!doctype html><title>WoW WebClient</title>"
    + '<body style="margin:0;height:100vh;display:grid;place-items:center;background:#000;color:#ffd100;font:15px Segoe UI,sans-serif">'
    + `<div style="max-width:100ch;padding:24px"><h2 style="text-align:center">${escape(title)}</h2>`
    + `<pre style="white-space:pre-wrap;color:#ccc;font:13px Consolas,monospace">${escape(text)}</pre></div>`);
}

/** The players' server is not answering: off, still starting, or out of reach. */
function serverStatusPage(what) {
  return statusPage("Нет связи с сервером", `${what}\n`
    + "Сервер выключен, ещё запускается или недоступен по сети. Окно подключится само, как только он ответит.");
}

/**
 * Opens the game page once the gateway listens; before that the page would only draw black. The
 * player app waits for the server's gateway. The built page starts a local gateway itself
 * (gateway.cjs). On the Vite page the gateway is the developer's to start and build, so the window
 * only says so and waits for it.
 */
async function openWhenGatewayListens(window, pageUrl) {
  if (remoteUrl !== undefined) {
    const host = new URL(remoteUrl).hostname;
    if (!(await listening(GATEWAY_PORT, host))) {
      window.loadURL(serverStatusPage(`Сервер ${host} не отвечает (порт ${GATEWAY_PORT}).`));
      await waitUntilListening(GATEWAY_PORT, host);
    }
  } else if (!(await listening(GATEWAY_PORT))) {
    const root = webDir === undefined ? undefined
      : findWebClientRoot([path.resolve(__dirname, ".."), path.resolve(path.dirname(process.execPath), "..", "..")]);
    const manual = "Запустите start-gateway.bat в папке WebClient — окно продолжит само.";
    if (root === undefined) {
      window.loadURL(statusPage("Шлюз не запущен", `На 127.0.0.1:${GATEWAY_PORT} никто не отвечает.\n${manual}`));
    } else {
      const logFile = path.join(root, ".runtime", "logs", "electron-gateway.log");
      console.log(`[electron] starting the gateway in ${root}, log ${logFile}`);
      window.loadURL(statusPage("Запуск шлюза…", `${path.join(root, "tools", "start-gateway.mjs")}\nЖурнал: ${logFile}`));
      startedGateway = startGateway(root, { port: GATEWAY_PORT, logFile });
      try {
        await startedGateway.ready;
      } catch (error) {
        startedGateway.stop();
        startedGateway = undefined;
        window.loadURL(statusPage("Шлюз не запустился",
          `${error.message}\n\n${logTail(logFile)}\n\nЖурнал: ${logFile}\n${manual}`));
      }
    }
    await waitUntilListening(GATEWAY_PORT);
  }
  if (!window.isDestroyed()) window.loadURL(pageUrl);
}

app.whenReady().then(async () => {
  const pageUrl = await resolvePageUrl();
  if (pageUrl === undefined) { app.quit(); return; }
  console.log(`[electron] page ${pageUrl}${webDir !== undefined && explicitUrl === undefined ? ` (built: ${webDir})` : ""}`);
  Menu.setApplicationMenu(null);
  // Mouse look needs pointer lock; everything else a page may ask for stays denied.
  const allowed = new Set(["pointerLock", "fullscreen", "clipboard-sanitized-write"]);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowed.has(permission));
  });

  const window = new BrowserWindow({
    width: windowWidth || 1600,
    height: windowHeight || 900,
    useContentSize: true,
    backgroundColor: "#000000",
    title: "WoW WebClient",
    // No spell checker: a chat line is not prose, and the red underline is the browser's, not the client's.
    webPreferences: {
      backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
    },
  });
  // No pinch zoom on a touchpad or screen; the page itself keeps Ctrl+wheel and Ctrl+± from zooming
  // (src/browser/app/NativeAppShell.ts), and without a menu Electron has no zoom keys of its own.
  window.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  const origin = new URL(pageUrl).origin;
  // Cross-origin isolation for the page origin, whatever serves it (the crowd pose worker needs a
  // SharedArrayBuffer): the same two headers vite.config.mjs sends, set here too so an older dev
  // server or a plain static server still yields an isolated page. Other origins pass untouched.
  // `Document-Policy: js-profiling` lets the freeze recording sample JS stacks (vite.config.mjs).
  if (isolated || jsProfiling) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      let responseOrigin;
      try { responseOrigin = new URL(details.url).origin; } catch { responseOrigin = undefined; }
      if (responseOrigin !== origin) { callback({}); return; }
      const responseHeaders = {};
      const replaced = new RegExp(`^(${[
        ...(isolated ? ["cross-origin-opener-policy", "cross-origin-embedder-policy"] : []),
        ...(jsProfiling ? ["document-policy"] : []),
      ].join("|")})$`, "i");
      for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
        if (!replaced.test(name)) responseHeaders[name] = value;
      }
      if (isolated) {
        responseHeaders["Cross-Origin-Opener-Policy"] = ["same-origin"];
        responseHeaders["Cross-Origin-Embedder-Policy"] = ["credentialless"];
      }
      if (jsProfiling) responseHeaders["Document-Policy"] = ["js-profiling"];
      callback({ responseHeaders });
    });
  }
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  // With no menu, the shell keeps the three keys a player needs from it; Alt stays the game's.
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11") { window.setFullScreen(!window.isFullScreen()); event.preventDefault(); }
    else if (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i")) {
      window.webContents.toggleDevTools(); event.preventDefault();
    } else if (input.control && input.key.toLowerCase() === "r") { window.webContents.reload(); event.preventDefault(); }
  });
  // Without an answering page server Chromium shows a bare error page; say what is missing
  // instead, and open the page as soon as its server listens.
  const UNREACHABLE = new Set([-7, -21, -100, -101, -102, -105, -106, -109, -118]);
  window.webContents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    if (!isMainFrame || !UNREACHABLE.has(code)) return;
    const target = new URL(url);
    window.loadURL(remoteUrl !== undefined || !LOOPBACK_HOSTS.has(target.hostname)
      ? serverStatusPage(`${url} не отвечает.`)
      : statusPage("Страница не отвечает", `${url} не отвечает. Запустите web\\start-dev.bat (Vite) `
        + "или соберите Electron-версию: electron\\build.bat. Окно продолжит само."));
    const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
    waitUntilListening(port, target.hostname).then(() => { if (!window.isDestroyed()) window.loadURL(url); });
  });
  if (commandLineUrl !== undefined) window.loadURL(pageUrl);
  else openWhenGatewayListens(window, pageUrl).catch((error) => console.error(`[electron] ${error.stack}`));

  constrainChildren();
  app.on("child-process-gone", constrainChildren);
  window.webContents.on("did-finish-load", constrainChildren);
  setInterval(constrainChildren, 5000).unref();
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => startedGateway?.stop());
