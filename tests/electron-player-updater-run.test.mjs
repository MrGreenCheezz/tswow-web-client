// 10.17 — the player app's updater script, run for real on temp folders (Windows only): started by
// a short-lived process exactly as the app starts it (player-update.cjs launchUpdater), it must
// outlive that process (libuv kills a non-detached child's job with its parent), copy the new app
// over the old one through paths with spaces, `&`, parentheses, `%` and Cyrillic, keep the player's
// server.json and their own files, and clean its unpacked copy. Relaunch is off here
// (WOWUPD_RELAUNCH=0): the "exe" is a text file.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const modulePath = require.resolve("../electron/player-update.cjs");
const update = require(modulePath);
const skip = process.platform !== "win32" && "cmd.exe and robocopy are Windows'";

function put(dir, file, text) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}

/** Plays the app: starts the updater, waits for its first stage, exits at once. */
function launchFromShortLivedProcess(root, environment) {
  const code = "require(process.env.T_MODULE).launchUpdater({ root: process.env.T_ROOT, environment: JSON.parse(process.env.T_ENV) })"
    + ".then(() => process.exit(0), (error) => { console.error(error.message); process.exit(1); });";
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["-e", code], {
      env: { ...process.env, T_MODULE: modulePath, T_ROOT: root, T_ENV: JSON.stringify(environment) }, windowsHide: true,
    }, (error, _stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve()));
  });
}

async function waitForLog(file, pattern, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = existsSync(file) ? readFileSync(file, "latin1") : "";
    if (pattern.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${file} never matched ${pattern}:\n${existsSync(file) ? readFileSync(file, "latin1") : "(missing)"}`);
}

/** An install folder and an unpacked update in one awkwardly named temp folder. */
function scene({ playerServerJson = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "webclient-updater-run-"));
  const odd = join(base, "WoW & Web (тест) 100%");
  const install = join(odd, "WoWWebClient");
  const root = join(odd, `${update.TEMP_PREFIX}run`);
  const files = join(root, "files", "WoWWebClient");
  put(install, "WoWWebClient.exe", "old exe");
  put(install, "resources/app/main.cjs", "old main");
  if (playerServerJson) put(install, "resources/app/server.json", '{"url":"http://203.0.113.10:8091/"}');
  put(install, "saves/keep-me.txt", "the player's own file");
  put(files, "WoWWebClient.exe", "new exe");
  put(files, "resources/app/main.cjs", "new main");
  put(files, "resources/app/server.json", '{"url":"http://198.51.100.20:8091/"}');
  put(files, "locales/ru.pak", "new locale");
  mkdirSync(root, { recursive: true });
  update.writeUpdaterScript(root);
  const environment = update.updaterEnvironment({
    root, files, installDir: install, waitFor: join(install, "WoWWebClient.exe"), version: "0.1.0.3", relaunch: false,
  });
  return { base, install, root, files, environment };
}

test("the updater outlives the app that started it and copies the new app, keeping server.json", { skip }, async () => {
  const { base, install, root, environment } = scene();
  try {
    await launchFromShortLivedProcess(root, environment);
    // The first stage has exited and so has the process that started it, while the second stage
    // still waits a second before its first look at the exe: the copy happens after they are gone.
    const log = await waitForLog(join(install, update.UPDATE_LOG), /^Updated\.\r?$/m);
    assert.match(log, /^WoW WebClient update to 0\.1\.0\.3/);
    assert.equal(readFileSync(join(install, "WoWWebClient.exe"), "utf8"), "new exe");
    assert.equal(readFileSync(join(install, "resources", "app", "main.cjs"), "utf8"), "new main");
    assert.equal(readFileSync(join(install, "locales", "ru.pak"), "utf8"), "new locale");
    assert.equal(readFileSync(join(install, "resources", "app", "server.json"), "utf8"), '{"url":"http://203.0.113.10:8091/"}',
      "the player's server.json stays");
    assert.equal(readFileSync(join(install, "saves", "keep-me.txt"), "utf8"), "the player's own file");
    assert.equal(existsSync(join(root, "files")), false, "the unpacked copy is removed");
    assert.equal(existsSync(join(install, update.FAILED_MARKER)), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an install without server.json gets the new build's", { skip }, async () => {
  const { base, install, root, environment } = scene({ playerServerJson: false });
  try {
    await launchFromShortLivedProcess(root, environment);
    await waitForLog(join(install, update.UPDATE_LOG), /^Updated\.\r?$/m);
    assert.equal(readFileSync(join(install, "resources", "app", "server.json"), "utf8"), '{"url":"http://198.51.100.20:8091/"}');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a first stage that cannot start is reported, not waited for", { skip }, async () => {
  const base = mkdtempSync(join(tmpdir(), "webclient-updater-run-"));
  try {
    // No update.cmd in the folder: cmd exits non-zero at once.
    await assert.rejects(update.launchUpdater({ root: base, environment: {} }),
      (error) => error instanceof update.UpdateError && /Установка не запустилась \(код \d+\)/.test(error.message));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
