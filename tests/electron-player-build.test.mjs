// 10.17 — `build.mjs --player` end to end in a sandbox (Windows only): the shell's files copied
// into a temp checkout with a stand-in Electron runtime, so the real dist/ and .runtime/ are never
// touched. Two builds in a row must create the key once, count 0.1.0.1 → 0.1.0.2, embed the key
// and version as update.json, and sign a manifest the first build's app accepts; the second build's
// zip then goes through the app's own steps — check, download, unpack, updater script — onto a
// folder that keeps its server.json.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const update = require("../electron/player-update.cjs");
const { staticHandler } = require("../electron/static-server.cjs");
const repo = fileURLToPath(new URL("..", import.meta.url));

function put(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A temp checkout: the shell's sources, tools/env.mjs and a stand-in Electron runtime. */
function prepare() {
  const root = mkdtempSync(join(tmpdir(), "webclient-player-build-"));
  mkdirSync(join(root, "electron"), { recursive: true });
  const build = readFileSync(join(repo, "electron", "build.mjs"), "utf8");
  const appFiles = [.../const APP_FILES = \[([^\]]*)\]/.exec(build)[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  for (const file of ["build.mjs", "player-release.mjs", "package.json", ...appFiles]) {
    copyFileSync(join(repo, "electron", file), join(root, "electron", file));
  }
  put(join(root, "tools", "env.mjs"), readFileSync(join(repo, "tools", "env.mjs"), "utf8"));
  // A stand-in for node_modules/electron/dist: what packRuntime copies, renames and trims.
  const runtime = join(root, "electron", "node_modules", "electron", "dist");
  put(join(runtime, "electron.exe"), "stand-in exe");
  put(join(runtime, "resources", "default_app.asar"), "placeholder app");
  put(join(runtime, "locales", "ru.pak"), "locale");
  return root;
}

function runBuild(root) {
  const env = { ...process.env, WEBCLIENT_SKIP_ENV: "1" };
  for (const name of ["PUBLIC_HOST", "PUBLIC_WEB_PORT", "GATEWAY_PORT"]) delete env[name];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [join(root, "electron", "build.mjs"), "--player", "--url=http://203.0.113.10:8091/"],
      { cwd: root, env, windowsHide: true }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : resolve(stdout)));
  });
}

async function waitForLog(file, pattern, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file) && pattern.test(readFileSync(file, "latin1"))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${file} never matched ${pattern}`);
}

test("two player builds: one key, counted versions, and an update the first app accepts and installs",
  { skip: process.platform !== "win32" && "build.mjs packs for Windows only" }, async () => {
    const root = prepare();
    try {
      const player = join(root, "dist", "player");
      const appDir = join(player, "WoWWebClient", "resources", "app");
      const first = await runBuild(root);
      assert.match(first, /Created the player app update key/);
      assert.match(first, /Player app 0\.1\.0\.1 packed for http:\/\/203\.0\.113\.10:8091\//);
      assert.ok(existsSync(join(root, ".runtime", "player-update-key", "private.pem")), "the key sits in the checkout's .runtime");
      assert.equal(existsSync(join(appDir, "private.pem")), false);
      const config = update.parseUpdateConfig(readFileSync(join(appDir, "update.json"), "utf8"));
      assert.equal(config.version, "0.1.0.1");
      assert.equal(JSON.parse(readFileSync(join(appDir, "server.json"), "utf8")).url, "http://203.0.113.10:8091/");
      assert.match(readFileSync(join(player, "WoWWebClient", "README.txt"), "utf8"), /^﻿WoW WebClient 0\.1\.0\.1/);
      assert.ok(existsSync(join(appDir, "update-notice.cjs")) && !existsSync(join(appDir, "player-release.mjs")));
      const verdict = update.verifyManifest(readFileSync(join(player, "latest.json")), readFileSync(join(player, "latest.json.sig"), "utf8"), config.publicKey);
      assert.equal(verdict.ok, true);
      assert.equal(verdict.manifest.size, readFileSync(join(player, "WoWWebClient.zip")).length);

      const second = await runBuild(root);
      assert.doesNotMatch(second, /Created the player app update key/, "the key is made once");
      assert.match(second, /Player app 0\.1\.0\.2 packed/);
      assert.equal(JSON.parse(readFileSync(join(root, ".runtime", "player-update-key", "release.json"), "utf8")).build, 2);
      assert.equal(update.parseUpdateConfig(readFileSync(join(appDir, "update.json"), "utf8")).publicKey, config.publicKey);

      // The first app meets the second build on the players' server.
      const web = join(root, "web");
      put(join(web, "index.html"), "<!doctype html>");
      const server = createServer(staticHandler(web, { compress: true, publicPages: ["/", "/index.html"], files: update.playerUpdateFiles(player) }));
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const work = mkdtempSync(join(root, update.TEMP_PREFIX));
      let files;
      try {
        const offered = await update.checkForUpdate({
          fetch, serverUrl: `http://127.0.0.1:${server.address().port}/`, currentVersion: config.version, publicKey: config.publicKey,
        });
        assert.equal(offered.status, "update");
        assert.equal(offered.manifest.version, "0.1.0.2");
        await update.downloadVerified({ fetch, url: offered.zipUrl, file: join(work, "update.zip"), manifest: offered.manifest });
        files = await update.extractUpdate({ zip: join(work, "update.zip"), root: work });
      } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
      }
      const install = join(root, "installed by a player");
      put(join(install, "WoWWebClient.exe"), "old exe");
      put(join(install, "resources", "app", "update.json"), JSON.stringify(config));
      put(join(install, "resources", "app", "server.json"), '{"url":"http://203.0.113.77:8091/"}');
      update.writeUpdaterScript(work);
      await update.launchUpdater({
        root: work,
        environment: update.updaterEnvironment({
          root: work, files, installDir: install, waitFor: join(install, "WoWWebClient.exe"), version: "0.1.0.2", relaunch: false,
        }),
      });
      await waitForLog(join(install, "update.log"), /^Updated\.\r?$/m);
      assert.equal(update.parseUpdateConfig(readFileSync(join(install, "resources", "app", "update.json"), "utf8")).version, "0.1.0.2");
      assert.equal(readFileSync(join(install, "WoWWebClient.exe"), "utf8"), "stand-in exe");
      assert.equal(JSON.parse(readFileSync(join(install, "resources", "app", "server.json"), "utf8")).url, "http://203.0.113.77:8091/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
