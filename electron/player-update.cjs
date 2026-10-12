"use strict";

/**
 * 10.17 — the player app updates itself: everything the app does for it except the window, without
 * `electron`, so `node --test` can require it (tests/electron-player-update.test.mjs). The signing
 * side lives in player-release.mjs (build.mjs --player); the notice in update-notice.cjs.
 *
 * The players' server serves, from dist/player (tools/start-server.mjs, static-server.cjs `files`):
 *   /player/latest.json      {"version","sha256","size","file"} — the newest player app
 *   /player/latest.json.sig  base64 Ed25519 signature of latest.json's exact bytes, one line
 *   /player/WoWWebClient.zip the app itself
 * Plain http, so the manifest is trusted only through the signature: the app verifies the bytes it
 * received against the public key build.mjs embedded into it (resources/app/update.json), never a
 * re-serialised object, then checks the zip's size and SHA-256 against the signed manifest. The
 * private key never leaves the owner's machine (.runtime/player-update-key/).
 *
 * Versions are dotted numbers compared part by part as numbers ("0.1.0.10" is newer than
 * "0.1.0.9"; a string compare says the opposite): electron/package.json's version plus the build
 * number build.mjs --player counts. An unreadable version is never newer.
 */

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/** The packed player app's layout, as build.mjs --player zips it. */
const PLAYER_FOLDER = "WoWWebClient";
const PLAYER_EXE = "WoWWebClient.exe";
const PLAYER_ZIP = "WoWWebClient.zip";
const MANIFEST_FILE = "latest.json";
const SIGNATURE_FILE = "latest.json.sig";
/** Beside main.cjs in the player build only: its own version and the key updates must be signed with. */
const UPDATE_CONFIG_FILE = "update.json";
/** Where the server serves the files above, relative to the page the app opens. */
const UPDATE_ROUTE = "player/";
/** Left beside the exe by the updater script when copying failed; the next start says so. */
const FAILED_MARKER = "update-failed.txt";
const UPDATE_LOG = "update.log";
const TEMP_PREFIX = "wowwebclient-update-";

const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const MAX_UPDATE_BYTES = 2 * 1024 * 1024 * 1024;

/** `[major, minor, patch, build]`-style parts, or undefined when `text` is not 1–4 dotted numbers. */
function parseVersion(text) {
  if (typeof text !== "string" || !/^\d{1,9}(\.\d{1,9}){0,3}$/.test(text)) return undefined;
  return text.split(".").map(Number);
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`; throws on a bad version. */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) throw new Error(`not a version: ${left === undefined ? a : b}`);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Whether `candidate` is newer than `current`; false when either cannot be read. */
function isNewerVersion(candidate, current) {
  try {
    return compareVersions(candidate, current) > 0;
  } catch {
    return false;
  }
}

/** The manifest's exact bytes as build.mjs writes and signs them. */
function manifestBytes({ version, sha256, size, file }) {
  return Buffer.from(`${JSON.stringify({ version, sha256, size, file }, null, 2)}\n`, "utf8");
}

/** The manifest object from JSON text, every field checked; `{ ok, manifest }` or `{ ok: false, reason }`. */
function parseManifest(bytes) {
  let value;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    return { ok: false, reason: `latest.json is not JSON (${error.message})` };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "latest.json is not an object" };
  const { version, sha256, size, file } = value;
  if (parseVersion(version) === undefined) return { ok: false, reason: `latest.json: bad version ${JSON.stringify(version)}` };
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return { ok: false, reason: "latest.json: bad sha256" };
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPDATE_BYTES) return { ok: false, reason: `latest.json: bad size ${JSON.stringify(size)}` };
  // A bare file name beside latest.json: never a path, never another host.
  if (typeof file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.zip$/.test(file)) {
    return { ok: false, reason: `latest.json: bad file ${JSON.stringify(file)}` };
  }
  return { ok: true, manifest: { version, sha256, size, file } };
}

/** An Ed25519 public key from update.json's base64 SPKI DER (or a KeyObject, for tests). */
function publicKeyFrom(value) {
  const key = value instanceof crypto.KeyObject ? value
    : crypto.createPublicKey({ key: Buffer.from(String(value), "base64"), format: "der", type: "spki" });
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 public key");
  return key;
}

/**
 * Checks `signatureText` (base64, as in latest.json.sig) over the exact `bytes` of latest.json with
 * the embedded public key, and only then reads them: `{ ok, manifest }` or `{ ok: false, reason }`.
 */
function verifyManifest(bytes, signatureText, publicKey) {
  let key;
  try {
    key = publicKeyFrom(publicKey);
  } catch (error) {
    return { ok: false, reason: `update key unreadable (${error.message})` };
  }
  const text = String(signatureText ?? "").trim();
  const signature = /^[A-Za-z0-9+/]+={0,2}$/.test(text) ? Buffer.from(text, "base64") : Buffer.alloc(0);
  if (signature.length !== 64) return { ok: false, reason: "latest.json.sig is not an Ed25519 signature" };
  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(bytes), key, signature);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "latest.json signature does not match the app's key" };
  return parseManifest(bytes);
}

/** update.json of the player build: `{ version, publicKey }`, checked; throws on anything else. */
function parseUpdateConfig(text) {
  const value = JSON.parse(text);
  if (value === null || typeof value !== "object") throw new Error("update.json is not an object");
  if (parseVersion(value.version) === undefined) throw new Error(`update.json: bad version ${JSON.stringify(value.version)}`);
  publicKeyFrom(value.publicKey);
  return { version: value.version, publicKey: value.publicKey };
}

/** update.json beside main.cjs, or undefined: the local Electron build and development have none. */
function readUpdateConfig(appDir, log = console) {
  const file = path.join(appDir, UPDATE_CONFIG_FILE);
  if (!fs.existsSync(file)) return undefined;
  try {
    return parseUpdateConfig(fs.readFileSync(file, "utf8"));
  } catch (error) {
    // The game must not depend on its updater: a broken file only turns updates off.
    log.warn(`[update] ${file} ignored: ${error.message}`);
    return undefined;
  }
}

/** The update files' addresses, relative to the page the app opens (server.json `url`). */
function updateUrls(serverUrl) {
  const base = new URL(UPDATE_ROUTE, serverUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error(`not an http(s) server: ${serverUrl}`);
  return {
    manifest: new URL(MANIFEST_FILE, base).href,
    signature: new URL(SIGNATURE_FILE, base).href,
    zip: new URL(PLAYER_ZIP, base).href,
  };
}

/** The read-only routes tools/start-server.mjs adds to its page server: URL path → file in dist/player. */
function playerUpdateFiles(playerDir) {
  return {
    [`/${UPDATE_ROUTE}${MANIFEST_FILE}`]: path.join(playerDir, MANIFEST_FILE),
    [`/${UPDATE_ROUTE}${SIGNATURE_FILE}`]: path.join(playerDir, SIGNATURE_FILE),
    [`/${UPDATE_ROUTE}${PLAYER_ZIP}`]: path.join(playerDir, PLAYER_ZIP),
  };
}

/** A small body, refused past `maxBytes`. */
async function fetchBytes(fetchImpl, url, signal, maxBytes) {
  const response = await fetchImpl(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${url} is too large`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maxBytes) throw new Error(`${url} is too large`);
  return body;
}

/**
 * The one check at start: latest.json and its signature from the server, within `timeoutMs`.
 * `{ status: "update", manifest, zipUrl }` when a correctly signed manifest names a newer version;
 * otherwise `{ status: "none", reason }` — never throws, so a failure stays silent.
 */
async function checkForUpdate({ fetch: fetchImpl, serverUrl, currentVersion, publicKey, timeoutMs = 3000 }) {
  let urls;
  try {
    urls = updateUrls(serverUrl);
  } catch (error) {
    return { status: "none", reason: error.message };
  }
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  let manifest;
  let signature;
  try {
    [manifest, signature] = await Promise.race([Promise.all([
      fetchBytes(fetchImpl, urls.manifest, controller.signal, MAX_MANIFEST_BYTES),
      fetchBytes(fetchImpl, urls.signature, controller.signal, MAX_SIGNATURE_BYTES),
    ]), timeout]);
  } catch (error) {
    return { status: "none", reason: `no update manifest: ${error.message}` };
  } finally {
    clearTimeout(timer);
  }
  const verdict = verifyManifest(manifest, signature.toString("utf8"), publicKey);
  if (!verdict.ok) return { status: "none", reason: verdict.reason };
  if (!isNewerVersion(verdict.manifest.version, currentVersion)) {
    return { status: "none", reason: `up to date (${currentVersion}, server ${verdict.manifest.version})` };
  }
  return { status: "update", manifest: verdict.manifest, zipUrl: new URL(verdict.manifest.file, urls.manifest).href };
}

/** An update failure the notice shows as it is (Russian, for the player). */
class UpdateError extends Error {}

/**
 * Downloads the zip to `file` (a new file), hashing as it goes: more bytes than the signed size stop
 * it at once, and the result must match the signed size and SHA-256. `onProgress(received, size)`;
 * `signal` cancels; `idleMs` without a byte aborts a stalled download.
 */
async function downloadVerified({ fetch: fetchImpl, url, file, manifest, onProgress = () => {}, signal, idleMs = 30_000 }) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  let stalled = false;
  let idle;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { stalled = true; controller.abort(); }, idleMs);
  };
  const out = fs.createWriteStream(file, { flags: "wx" });
  const outFailed = new Promise((_resolve, reject) => out.once("error", reject));
  outFailed.catch(() => {});
  try {
    touch();
    let response;
    try {
      response = await fetchImpl(url, { signal: controller.signal, cache: "no-store" });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new UpdateError(`Нет связи с сервером: ${stalled ? "он перестал отвечать" : error.message}.`);
    }
    if (!response.ok || !response.body) throw new UpdateError(`Сервер ответил ${response.status} на ${url}.`);
    const hash = crypto.createHash("sha256");
    let received = 0;
    const reader = response.body.getReader();
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new UpdateError(`Загрузка прервалась: ${stalled ? "сервер перестал отвечать" : error.message}.`);
      }
      if (chunk.done) break;
      touch();
      received += chunk.value.byteLength;
      if (received > manifest.size) {
        controller.abort();
        throw new UpdateError(`Архив обновления больше подписанного размера (${manifest.size} байт): загрузка остановлена.`);
      }
      hash.update(chunk.value);
      if (!out.write(chunk.value)) {
        await Promise.race([new Promise((resolve) => out.once("drain", resolve)), outFailed]);
      }
      onProgress(received, manifest.size);
    }
    await Promise.race([new Promise((resolve) => out.end(resolve)), outFailed]);
    if (received !== manifest.size) {
      throw new UpdateError(`Архив обновления повреждён: ${received} байт вместо ${manifest.size}.`);
    }
    if (hash.digest("hex") !== manifest.sha256) {
      throw new UpdateError("Архив обновления повреждён: контрольная сумма не совпала с подписанной.");
    }
    return { received };
  } catch (error) {
    out.destroy();
    throw error;
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener("abort", cancel);
  }
}

/**
 * Unpacks `zip` into `<root>/files` with Windows' own tar (bsdtar reads zip, Windows 10 1803+), run
 * from `root` with relative names so a non-ASCII temp path never goes through its ANSI argv.
 * Resolves with the new app's folder, `<root>/files/WoWWebClient`, once its exe and main.cjs exist.
 */
async function extractUpdate({ zip, root, tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") }) {
  const files = path.join(root, "files");
  fs.mkdirSync(files, { recursive: true });
  if (!fs.existsSync(tar)) throw new UpdateError("В этой Windows нет tar.exe, распаковать архив нечем.");
  await new Promise((resolve, reject) => {
    childProcess.execFile(tar, ["-xf", path.relative(root, zip), "-C", "files"], { cwd: root, windowsHide: true },
      (error, _stdout, stderr) => (error ? reject(new UpdateError(`Не удалось распаковать архив: ${String(stderr || error.message).trim()}`)) : resolve()));
  });
  const folder = path.join(files, PLAYER_FOLDER);
  for (const part of [PLAYER_EXE, path.join("resources", "app", "main.cjs")]) {
    if (!fs.existsSync(path.join(folder, part))) throw new UpdateError(`В архиве обновления нет ${PLAYER_FOLDER}\\${part}.`);
  }
  return folder;
}

/** Whether a file can be created in `dir` (created and removed at once). */
function probeWritable(dir) {
  const probe = path.join(dir, `.update-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, "", { flag: "wx" });
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Whether main.cjs runs as the packed app's resources/app beside its exe (not `electron .`). */
function isPackagedApp(appDir, execPath) {
  const expected = path.join(path.dirname(execPath), "resources", "app");
  return path.resolve(appDir).toLowerCase() === path.resolve(expected).toLowerCase();
}

/**
 * Install in place, or hand the player the download: `{ action: "install" }` or
 * `{ action: "browser", reason }` with the reason in Russian.
 */
function chooseInstallRoute({ platform, packaged, writable, installDir }) {
  if (platform !== "win32") return { action: "browser", reason: "Обновление на месте есть только в Windows." };
  if (!packaged) return { action: "browser", reason: "Приложение запущено не из своей папки — обновить его на месте нельзя." };
  if (!writable) {
    return { action: "browser", reason: `Нет прав на запись в папку приложения (${installDir}). `
      + "Скачайте архив и распакуйте его вместо этой папки или перенесите приложение туда, где у вас есть права, например в «Документы»." };
  }
  return { action: "install" };
}

/** A folder for cmd: no trailing separator (`"D:\"` would escape robocopy's closing quote), a root as `D:\.`. */
function cmdDirectory(dir) {
  const trimmed = path.resolve(dir).replace(/[\\/]+$/, "");
  return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}\\.` : trimmed;
}

/**
 * The updater, a .cmd file of ASCII only: paths reach it as WOWUPD_* environment variables, because
 * cmd reads a batch file in the console code page while the environment is Unicode (a Cyrillic user
 * folder stays intact), and every use is quoted. Two stages: the app starts the first inside the
 * job object libuv kills when the app exits; `start /b` runs the second outside that job in the
 * same hidden console. The second waits until the app's exe can be opened for writing (no process
 * maps it any more), drops the new build's server.json when the player has one, copies the new
 * files over the install folder, and starts the exe again. No PowerShell: an unsigned exe starting
 * it is what antivirus heuristics flag (see cpuClass "none" in build.mjs).
 */
function updaterScript() {
  return [
    "@echo off",
    "rem WoW WebClient player app updater (electron/player-update.cjs, 10.17). Paths come in",
    "rem WOWUPD_* environment variables, never in this file, and are always quoted.",
    "setlocal DisableDelayedExpansion",
    "if not defined WOWUPD_ROOT exit /b 2",
    "if not defined WOWUPD_INSTALL exit /b 2",
    "if not defined WOWUPD_FILES exit /b 2",
    "if not defined WOWUPD_WAIT exit /b 2",
    "if not defined WOWUPD_EXE exit /b 2",
    'if "%~1"=="run" goto run',
    "rem First stage: inside the app's job object, which ends with the app. The second stage runs",
    "rem outside it, in this same hidden console.",
    'cd /d "%WOWUPD_ROOT%" || exit /b 3',
    'start "" /b "%SystemRoot%\\System32\\cmd.exe" /d /c .\\update.cmd run',
    "exit /b 0",
    "",
    ":run",
    'set "WOWUPD_LOG=%WOWUPD_INSTALL%\\update.log"',
    '>"%WOWUPD_LOG%" echo WoW WebClient update to %WOWUPD_VERSION%',
    "set /a WOWUPD_TRIES=0",
    ":wait",
    "rem While any of the app's processes runs, its exe cannot be opened for writing.",
    '>nul "%SystemRoot%\\System32\\ping.exe" -n 2 127.0.0.1',
    'if not exist "%WOWUPD_WAIT%" goto copy',
    "2>nul (",
    '  >>"%WOWUPD_WAIT%" (call )',
    ") && goto copy",
    "set /a WOWUPD_TRIES+=1",
    "if %WOWUPD_TRIES% lss 120 goto wait",
    '>>"%WOWUPD_LOG%" echo FAILED: the app did not close within two minutes; nothing was changed.',
    "exit /b 1",
    "",
    ":copy",
    "rem The player's server.json stays: the new build's copy is dropped before copying.",
    'if exist "%WOWUPD_INSTALL%\\resources\\app\\server.json" del /f /q "%WOWUPD_FILES%\\resources\\app\\server.json" 2>nul',
    '"%SystemRoot%\\System32\\robocopy.exe" "%WOWUPD_FILES%" "%WOWUPD_INSTALL%" /E /IS /IT /R:10 /W:1 /NP /NJH /NJS /NDL >>"%WOWUPD_LOG%"',
    "if errorlevel 8 goto copy_failed",
    'rd /s /q "%WOWUPD_ROOT%\\files" 2>nul',
    '>>"%WOWUPD_LOG%" echo Updated.',
    "goto relaunch",
    "",
    ":copy_failed",
    '>>"%WOWUPD_LOG%" echo FAILED: robocopy could not copy every file.',
    '>"%WOWUPD_INSTALL%\\update-failed.txt" echo robocopy',
    "",
    ":relaunch",
    'if not "%WOWUPD_RELAUNCH%"=="1" exit /b 0',
    'cd /d "%WOWUPD_INSTALL%" 2>nul',
    "if not defined WOWUPD_SERVER_URL goto relaunch_plain",
    'start "" "%WOWUPD_EXE%" "--server-url=%WOWUPD_SERVER_URL%"',
    "exit /b 0",
    ":relaunch_plain",
    'start "" "%WOWUPD_EXE%"',
    "exit /b 0",
    "",
  ].join("\r\n");
}

/**
 * The updater's environment. `root` is this update's temp folder, `files` the new app inside it,
 * `installDir` the app's folder, `waitFor` the running exe, `relaunch` false only in tests,
 * `serverUrl` the --server-url the app was started with (kept for the restarted app), if any.
 */
function updaterEnvironment({ root, files, installDir, waitFor, version, relaunch = true, serverUrl }) {
  const install = cmdDirectory(installDir);
  const env = {
    WOWUPD_ROOT: cmdDirectory(root),
    WOWUPD_FILES: cmdDirectory(files),
    WOWUPD_INSTALL: install,
    WOWUPD_WAIT: path.resolve(waitFor),
    WOWUPD_EXE: path.join(install, PLAYER_EXE),
    WOWUPD_VERSION: parseVersion(version) === undefined ? "?" : version,
    WOWUPD_RELAUNCH: relaunch ? "1" : "0",
  };
  if (serverUrl !== undefined) {
    const url = new URL(serverUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`--server-url: ${serverUrl}`);
    // The URL serialiser percent-encodes '"', so the quoted argument in the script cannot be broken.
    env.WOWUPD_SERVER_URL = url.href;
  }
  return env;
}

/** Writes update.cmd into `root`; returns its path. */
function writeUpdaterScript(root) {
  const file = path.join(root, "update.cmd");
  fs.writeFileSync(file, updaterScript(), "ascii");
  return file;
}

/**
 * Starts the updater's first stage the way it must start: not detached (detached, cmd would have no
 * console, and robocopy and ping would each open a window of their own), hidden, and waited for —
 * quitting before it has started the second stage would kill both. Resolves when the first stage
 * exited 0.
 */
function launchUpdater({ root, environment, spawn = childProcess.spawn, timeoutMs = 15_000 }) {
  const script = path.join(root, "update.cmd");
  const comspec = process.env.ComSpec || path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(comspec, ["/d", "/s", "/c", `""${script}""`], {
        cwd: root,
        env: { ...process.env, ...environment },
        stdio: "ignore",
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    } catch (error) {
      reject(new UpdateError(`Не удалось запустить установку: ${error.message}`));
      return;
    }
    const timer = setTimeout(() => reject(new UpdateError("Установка не запустилась вовремя.")), timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(new UpdateError(`Не удалось запустить установку: ${error.message}`)); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new UpdateError(`Установка не запустилась (код ${code}).`));
    });
  });
}

/** Removes earlier updates' temp folders (an updater may still run from a fresh one, so only old ones). */
function cleanOldUpdateDirs(tempDir, { now = Date.now(), maxAgeMs = 60 * 60 * 1000 } = {}) {
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(tempDir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const dir = path.join(tempDir, name);
    try {
      const stats = fs.statSync(dir);
      if (!stats.isDirectory() || now - stats.mtimeMs < maxAgeMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // Still in use or already gone: the next start tries again.
    }
  }
  return removed;
}

module.exports = {
  FAILED_MARKER,
  MANIFEST_FILE,
  PLAYER_EXE,
  PLAYER_FOLDER,
  PLAYER_ZIP,
  SIGNATURE_FILE,
  TEMP_PREFIX,
  UPDATE_CONFIG_FILE,
  UPDATE_LOG,
  UpdateError,
  checkForUpdate,
  chooseInstallRoute,
  cleanOldUpdateDirs,
  cmdDirectory,
  compareVersions,
  downloadVerified,
  extractUpdate,
  isNewerVersion,
  isPackagedApp,
  launchUpdater,
  manifestBytes,
  parseManifest,
  parseUpdateConfig,
  parseVersion,
  playerUpdateFiles,
  probeWritable,
  publicKeyFrom,
  readUpdateConfig,
  updateUrls,
  updaterEnvironment,
  updaterScript,
  verifyManifest,
  writeUpdaterScript,
};
