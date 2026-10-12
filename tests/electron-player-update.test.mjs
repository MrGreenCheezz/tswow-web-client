// 10.17 — the player app updates itself: the signed manifest build.mjs --player writes, the
// verification and version rules the app applies, the /player/ routes the players' server adds,
// the download and unpacking checks, the updater script's text and the not-writable fallback —
// all without Electron (electron/player-update.cjs, electron/player-release.mjs,
// electron/update-notice.cjs), plus source pins for the wiring that needs Electron to run.
// The script run for real is in electron-player-updater-run.test.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  loadOrCreateSigningKey, nextRelease, readPublishedVersion, readReleaseState, removePublishedManifest, signManifest,
  updateConfig, writeReleaseState, writeSignedManifest,
} from "../electron/player-release.mjs";

const require = createRequire(import.meta.url);
const update = require("../electron/player-update.cjs");
const notice = require("../electron/update-notice.cjs");
const { staticHandler } = require("../electron/static-server.cjs");

const repo = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(repo, path), "utf8");
const windows = process.platform === "win32";

function temp(name) {
  return mkdtempSync(join(tmpdir(), `webclient-${name}-`));
}

/** A signed release in `folder`: zip bytes, latest.json and latest.json.sig, and the app's update.json. */
async function release(folder, { version = "0.1.0.2", zipBytes = Buffer.from("PK fake zip ".repeat(5000)), key } = {}) {
  const signing = key ?? loadOrCreateSigningKey(join(folder, "key"));
  const zip = join(folder, update.PLAYER_ZIP);
  writeFileSync(zip, zipBytes);
  const published = await writeSignedManifest({ folder, zip, file: update.PLAYER_ZIP, version, privateKey: signing.privateKey });
  return { signing, zip, zipBytes, published, config: updateConfig({ version: "0.1.0.1", publicKeyDer: signing.publicKeyDer }) };
}

async function serving(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(server.address().port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Raw request, so the headers are the server's. */
function get(port, path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const call = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    call.on("error", reject);
    call.end();
  });
}

test("versions compare as numbers part by part, never as strings", () => {
  assert.ok("0.1.0.10" < "0.1.0.9", "a string compare gets this wrong");
  assert.ok(update.compareVersions("0.1.0.10", "0.1.0.9") > 0);
  assert.ok(update.compareVersions("0.2.0.1", "0.1.0.99") > 0);
  assert.equal(update.compareVersions("1.0", "1.0.0.0"), 0, "missing parts are zero");
  assert.ok(update.compareVersions("0.1.0.9", "0.1.0.10") < 0);
  assert.equal(update.isNewerVersion("0.1.0.3", "0.1.0.2"), true);
  assert.equal(update.isNewerVersion("0.1.0.2", "0.1.0.2"), false);
  for (const bad of ["0.1.0-beta", "", "1..2", "1.2.3.4.5", " 1.2", "v1.2", undefined, 3]) {
    assert.equal(update.parseVersion(bad), undefined, `${JSON.stringify(bad)} is not a version`);
    assert.equal(update.isNewerVersion(bad, "0.0.0.1"), false, "an unreadable version is never newer");
  }
  assert.throws(() => update.compareVersions("x", "1"), /not a version/);
});

test("the release version: package.json's major.minor.patch plus a build counter nobody edits", () => {
  assert.deepEqual(nextRelease({ baseVersion: "0.1.0" }), { build: 1, version: "0.1.0.1" });
  assert.deepEqual(nextRelease({ baseVersion: "0.1.0", state: { build: 9, version: "0.1.0.9" } }), { build: 10, version: "0.1.0.10" });
  assert.deepEqual(nextRelease({ baseVersion: "0.1.0", state: { build: 7, version: "0.1.0.7" }, publishedVersion: "0.1.0.12" }),
    { build: 13, version: "0.1.0.13" }, "a published build ahead of the counter is never repeated");
  assert.deepEqual(nextRelease({ baseVersion: "0.1.0", publishedVersion: "0.1.0.4" }), { build: 5, version: "0.1.0.5" },
    "a lost counter resumes after what dist/player published");
  assert.deepEqual(nextRelease({ baseVersion: "0.2.0", state: { build: 8, version: "0.1.0.8" } }), { build: 9, version: "0.2.0.9" },
    "raising package.json keeps counting");
  assert.throws(() => nextRelease({ baseVersion: "0.0.9", state: { build: 8, version: "0.1.0.8" } }), /lowered/);
  assert.throws(() => nextRelease({ baseVersion: "0.1" }), /major\.minor\.patch/);
  assert.throws(() => nextRelease({ baseVersion: "0.1.0-beta" }), /major\.minor\.patch/);

  const dir = temp("release-state");
  try {
    assert.equal(readReleaseState(dir), undefined);
    writeReleaseState(dir, { build: 3, version: "0.1.0.3" });
    assert.deepEqual(readReleaseState(dir), { build: 3, version: "0.1.0.3" });
    writeFileSync(join(dir, "release.json"), '{"build":"x"}');
    assert.throws(() => readReleaseState(dir), /damaged/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the signing key is made once on the owner's machine, outside the repository, and reused", () => {
  const dir = temp("update-key");
  try {
    const first = loadOrCreateSigningKey(join(dir, "player-update-key"));
    assert.equal(first.created, true);
    assert.match(readFileSync(join(dir, "player-update-key", "private.pem"), "utf8"), /^-----BEGIN PRIVATE KEY-----/);
    assert.match(readFileSync(join(dir, "player-update-key", "public.pem"), "utf8"), /^-----BEGIN PUBLIC KEY-----/);
    const again = loadOrCreateSigningKey(join(dir, "player-update-key"));
    assert.equal(again.created, false);
    assert.equal(again.fingerprint, first.fingerprint);
    assert.deepEqual(again.publicKeyDer, first.publicKeyDer);
    assert.equal(first.publicKeyDer.length, 44, "Ed25519 SPKI DER");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const build = read("electron/build.mjs");
  assert.match(build, /const updateKeyDir = join\(root, "\.runtime", "player-update-key"\)/);
  const ignore = read(".gitignore").split(/\r?\n/);
  assert.ok(ignore.includes(".runtime/") && ignore.includes("*.pem"), "the key folder and any .pem stay out of git");
});

test("a player build writes latest.json and a detached signature of its exact bytes", async () => {
  const folder = temp("manifest");
  try {
    const { published, signing, zipBytes, config } = await release(folder);
    const bytes = readFileSync(published.manifestFile);
    assert.deepEqual(JSON.parse(bytes.toString()), {
      version: "0.1.0.2", sha256: createHash("sha256").update(zipBytes).digest("hex"), size: zipBytes.length, file: "WoWWebClient.zip",
    });
    assert.deepEqual(bytes, update.manifestBytes(published.manifest), "the bytes are the canonical form");
    const signature = readFileSync(published.signatureFile, "utf8");
    assert.match(signature, /^[A-Za-z0-9+/]{86}==\n$/, "one line of base64, a 64-byte signature");
    assert.deepEqual(update.verifyManifest(bytes, signature, config.publicKey), { ok: true, manifest: published.manifest });
    assert.deepEqual(Object.keys(config), ["version", "publicKey"]);
    assert.equal(Buffer.from(config.publicKey, "base64").length, 44);
    assert.equal(readPublishedVersion(folder), "0.1.0.2");
    removePublishedManifest(folder);
    assert.equal(existsSync(published.manifestFile) || existsSync(published.signatureFile), false);
    assert.equal(readPublishedVersion(folder), undefined);
    assert.equal(signing.created, true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the app accepts only the exact signed bytes, with its own key, and well-formed fields", async () => {
  const folder = temp("verify");
  try {
    const { published, signing, config } = await release(folder);
    const bytes = readFileSync(published.manifestFile);
    const signature = readFileSync(published.signatureFile, "utf8");
    assert.equal(update.verifyManifest(bytes, signature, config.publicKey).ok, true);

    const edited = (change) => update.manifestBytes({ ...published.manifest, ...change });
    const newer = update.verifyManifest(edited({ version: "9.9.9.9" }), signature, config.publicKey);
    assert.deepEqual(newer, { ok: false, reason: "latest.json signature does not match the app's key" }, "a tampered version");
    assert.equal(update.verifyManifest(edited({ sha256: "0".repeat(64) }), signature, config.publicKey).ok, false, "a tampered zip hash");
    assert.equal(update.verifyManifest(edited({ size: published.manifest.size + 1 }), signature, config.publicKey).ok, false, "a tampered size");
    const reformatted = Buffer.from(JSON.stringify(published.manifest));
    assert.equal(update.verifyManifest(reformatted, signature, config.publicKey).ok, false, "the same JSON, other bytes: refused");

    const stranger = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
    assert.equal(update.verifyManifest(bytes, signature, stranger).ok, false, "another key");
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
    assert.match(update.verifyManifest(bytes, signature, ec).reason, /update key unreadable/);
    for (const broken of ["", "not base64!", signature.slice(0, 40), Buffer.alloc(64).toString("base64")]) {
      assert.equal(update.verifyManifest(bytes, broken, config.publicKey).ok, false, `signature ${JSON.stringify(broken)}`);
    }

    // Correctly signed by the owner's key, but fields the app must not act on.
    for (const [change, reason] of [
      [{ file: "../WoWWebClient.zip" }, /bad file/],
      [{ file: "https://evil.example/x.zip" }, /bad file/],
      [{ file: "WoWWebClient.exe" }, /bad file/],
      [{ size: -1 }, /bad size/],
      [{ size: 3 * 1024 * 1024 * 1024 }, /bad size/],
      [{ version: "0.2.0-beta" }, /bad version/],
      [{ sha256: "ABC" }, /bad sha256/],
    ]) {
      const odd = edited(change);
      const verdict = update.verifyManifest(odd, signManifest(odd, signing.privateKey), config.publicKey);
      assert.equal(verdict.ok, false, JSON.stringify(change));
      assert.match(verdict.reason, reason);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("update.json: only the player build has one, and a broken one only turns updates off", () => {
  const dir = temp("update-config");
  try {
    assert.equal(update.readUpdateConfig(dir), undefined, "no file, no checks (the local build, development)");
    const { publicKey } = generateKeyPairSync("ed25519");
    const good = { version: "0.1.0.4", publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
    writeFileSync(join(dir, "update.json"), JSON.stringify(good));
    assert.deepEqual(update.readUpdateConfig(dir), good);
    const warnings = [];
    writeFileSync(join(dir, "update.json"), "{broken");
    assert.equal(update.readUpdateConfig(dir, { warn: (text) => warnings.push(text) }), undefined);
    writeFileSync(join(dir, "update.json"), JSON.stringify({ ...good, publicKey: "AAAA" }));
    assert.equal(update.readUpdateConfig(dir, { warn: (text) => warnings.push(text) }), undefined);
    assert.equal(warnings.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the players' server serves /player/latest.json, its signature and the zip, read-only", async () => {
  const web = temp("player-web");
  const player = temp("player-dist");
  try {
    writeFileSync(join(web, "index.html"), "<!doctype html>");
    writeFileSync(join(web, "glue.html"), "<!doctype html>");
    writeFileSync(join(player, "private.pem"), "never served");
    mkdirSync(join(player, "WoWWebClient"));
    writeFileSync(join(player, "WoWWebClient", "README.txt"), "never served");
    const { zipBytes, published } = await release(player);
    const options = { compress: true, publicPages: ["/", "/index.html"], files: update.playerUpdateFiles(player) };
    await serving(staticHandler(web, options), async (port) => {
      const manifest = await get(port, "/player/latest.json");
      assert.equal(manifest.status, 200);
      assert.equal(manifest.headers["content-type"], "application/json; charset=utf-8");
      assert.equal(manifest.headers["cache-control"], "no-cache", "a new build is seen at once");
      assert.match(manifest.headers.etag, /^W\/"/);
      assert.deepEqual(manifest.body, readFileSync(published.manifestFile));
      assert.equal((await get(port, "/player/latest.json", { headers: { "if-none-match": manifest.headers.etag } })).status, 304);
      const signature = await get(port, "/player/latest.json.sig");
      assert.equal(signature.headers["content-type"], "text/plain; charset=utf-8");
      assert.equal(signature.body.toString(), readFileSync(published.signatureFile, "utf8"));
      const zip = await get(port, "/player/WoWWebClient.zip");
      assert.equal(zip.headers["content-type"], "application/zip");
      assert.equal(Number(zip.headers["content-length"]), zipBytes.length, "the app shows progress from it");
      assert.deepEqual(zip.body, zipBytes);
      assert.equal((await get(port, "/player/WoWWebClient.zip", { method: "HEAD" })).status, 200);
      assert.equal((await get(port, "/player/WoWWebClient.zip", { method: "POST" })).status, 405);
      for (const path of ["/player/private.pem", "/player/", "/player/WoWWebClient/README.txt", "/player/..%2fprivate.pem",
        "/player/LATEST.JSON", "/glue.html"]) {
        assert.equal((await get(port, path)).status, 404, path);
      }
      assert.equal((await get(port, "/")).status, 200, "the page is served as before");
      rmSync(published.manifestFile);
      assert.equal((await get(port, "/player/latest.json")).status, 404, "no build, no update offered");
    });
  } finally {
    rmSync(web, { recursive: true, force: true });
    rmSync(player, { recursive: true, force: true });
  }
  const server = read("tools/start-server.mjs");
  assert.match(server, /files: playerUpdateFiles\(playerRoot\)/);
  assert.match(server, /const playerRoot = fileURLToPath\(new URL\("\.\.\/dist\/player", import\.meta\.url\)\)/);
});

test("the check at start: a newer correctly signed version is offered, anything else is silent", async () => {
  const web = temp("check-web");
  const player = temp("check-dist");
  try {
    writeFileSync(join(web, "index.html"), "<!doctype html>");
    const { config } = await release(player, { version: "0.1.0.9" });
    await serving(staticHandler(web, { compress: true, files: update.playerUpdateFiles(player) }), async (port) => {
      const check = (currentVersion, extra = {}) => update.checkForUpdate({
        fetch, serverUrl: `http://127.0.0.1:${port}/`, currentVersion, publicKey: config.publicKey, ...extra,
      });
      const offered = await check("0.1.0.8");
      assert.equal(offered.status, "update");
      assert.equal(offered.manifest.version, "0.1.0.9");
      assert.equal(offered.zipUrl, `http://127.0.0.1:${port}/player/WoWWebClient.zip`);
      assert.equal((await check("0.1.0.9")).status, "none", "same version");
      assert.equal((await check("0.1.0.10")).status, "none", "0.1.0.10 is newer than 0.1.0.9");
      const viaPage = await update.checkForUpdate({
        fetch, serverUrl: `http://127.0.0.1:${port}/index.html?gateway=127.0.0.1:9000`, currentVersion: "0.1.0.1", publicKey: config.publicKey,
      });
      assert.equal(viaPage.status, "update", "the address server.json gives, whatever its page and query");
      const stranger = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
      const foreign = await check("0.1.0.1", { publicKey: stranger });
      assert.deepEqual([foreign.status, foreign.reason], ["none", "latest.json signature does not match the app's key"]);
      writeFileSync(join(player, "latest.json.sig"), "garbage\n");
      assert.equal((await check("0.1.0.1")).status, "none");
    });
    const closed = await update.checkForUpdate({
      fetch, serverUrl: "http://127.0.0.1:9/", currentVersion: "0.1.0.1", publicKey: config.publicKey, timeoutMs: 3000,
    });
    assert.equal(closed.status, "none", "a server that is off: silent");
    await serving(() => {}, async (port) => {
      const started = Date.now();
      const hanging = await update.checkForUpdate({
        fetch, serverUrl: `http://127.0.0.1:${port}/`, currentVersion: "0.1.0.1", publicKey: config.publicKey, timeoutMs: 300,
      });
      assert.equal(hanging.status, "none");
      assert.match(hanging.reason, /no answer within 300 ms/);
      assert.ok(Date.now() - started < 2000, "the timeout holds");
    });
    assert.equal((await update.checkForUpdate({ fetch, serverUrl: "file:///C:/x", currentVersion: "1", publicKey: config.publicKey })).status, "none");
  } finally {
    rmSync(web, { recursive: true, force: true });
    rmSync(player, { recursive: true, force: true });
  }
});

test("the download is checked against the signed size and SHA-256", async () => {
  const dir = temp("download");
  try {
    const body = { bytes: Buffer.alloc(300_000, 7) };
    const manifest = {
      version: "0.1.0.2", sha256: createHash("sha256").update(body.bytes).digest("hex"), size: body.bytes.length, file: "WoWWebClient.zip",
    };
    await serving((request, response) => {
      if (request.url !== "/player/WoWWebClient.zip") { response.writeHead(404).end(); return; }
      response.writeHead(200, { "Content-Type": "application/zip" });
      response.end(body.bytes);
    }, async (port) => {
      const url = `http://127.0.0.1:${port}/player/WoWWebClient.zip`;
      let file = 0;
      const next = () => join(dir, `zip-${++file}.zip`);
      const progress = [];
      const good = next();
      await update.downloadVerified({ fetch, url, file: good, manifest, onProgress: (received, size) => progress.push([received, size]) });
      assert.deepEqual(readFileSync(good), body.bytes);
      assert.deepEqual(progress.at(-1), [manifest.size, manifest.size]);
      assert.ok(progress.every(([received], index) => index === 0 || received >= progress[index - 1][0]));

      body.bytes = Buffer.alloc(300_000, 8);
      await assert.rejects(update.downloadVerified({ fetch, url, file: next(), manifest }),
        (error) => error instanceof update.UpdateError && /контрольная сумма не совпала/.test(error.message), "same size, other bytes");
      body.bytes = Buffer.alloc(400_000, 7);
      await assert.rejects(update.downloadVerified({ fetch, url, file: next(), manifest }), /больше подписанного размера/);
      body.bytes = Buffer.alloc(200_000, 7);
      await assert.rejects(update.downloadVerified({ fetch, url, file: next(), manifest }), /200000 байт вместо 300000/);
      await assert.rejects(update.downloadVerified({ fetch, url: `${url}x`, file: next(), manifest }), /Сервер ответил 404/);
      const cancel = new AbortController();
      cancel.abort();
      await assert.rejects(update.downloadVerified({ fetch, url, file: next(), manifest, signal: cancel.signal }),
        (error) => !(error instanceof update.UpdateError), "a cancel is not reported as a failure");
    });
    await serving((_request, response) => { response.writeHead(200); response.write(Buffer.alloc(10)); }, async (port) => {
      await assert.rejects(update.downloadVerified({
        fetch, url: `http://127.0.0.1:${port}/`, file: join(dir, "stalled.zip"), manifest, idleMs: 300,
      }), /перестал отвечать/, "a stalled download ends");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unpacking uses Windows' tar and checks the app is inside", { skip: !windows && "Windows tar.exe" }, async () => {
  const dir = temp("extract");
  try {
    const source = join(dir, "source");
    mkdirSync(join(source, "WoWWebClient", "resources", "app"), { recursive: true });
    writeFileSync(join(source, "WoWWebClient", "WoWWebClient.exe"), "exe");
    writeFileSync(join(source, "WoWWebClient", "resources", "app", "main.cjs"), "main");
    const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const root = join(dir, "root");
    mkdirSync(root);
    execFileSync(tar, ["-a", "-c", "-f", join(root, "update.zip"), "-C", source, "WoWWebClient"]);
    const folder = await update.extractUpdate({ zip: join(root, "update.zip"), root, tar });
    assert.equal(folder, join(root, "files", "WoWWebClient"));
    assert.equal(readFileSync(join(folder, "resources", "app", "main.cjs"), "utf8"), "main");

    rmSync(join(source, "WoWWebClient", "resources"), { recursive: true });
    const other = join(dir, "other");
    mkdirSync(other);
    execFileSync(tar, ["-a", "-c", "-f", join(other, "update.zip"), "-C", source, "WoWWebClient"]);
    await assert.rejects(update.extractUpdate({ zip: join(other, "update.zip"), root: other, tar }), /В архиве обновления нет/);
    await assert.rejects(update.extractUpdate({ zip: join(other, "update.zip"), root: other, tar: join(dir, "no-tar.exe") }), /нет tar\.exe/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the updater script: ASCII, every path quoted, the player's server.json kept, no PowerShell", () => {
  const script = update.updaterScript();
  assert.ok(/^[\x20-\x7e\r\n]*$/.test(script), "ASCII only: cmd reads a batch file in the console code page");
  assert.ok(script.split("\n").slice(0, -1).every((line) => line.endsWith("\r")), "CRLF lines");
  assert.doesNotMatch(script, /powershell|mshta|wscript|cscript/i);
  const pathVariable = /%WOWUPD_(ROOT|FILES|INSTALL|WAIT|EXE|LOG|SERVER_URL)%/g;
  let uses = 0;
  for (const line of script.split("\r\n")) {
    for (const match of line.matchAll(pathVariable)) {
      uses++;
      const quotesBefore = line.slice(0, match.index).split('"').length - 1;
      assert.equal(quotesBefore % 2, 1, `unquoted ${match[0]} in: ${line}`);
    }
  }
  assert.ok(uses >= 15);
  const lines = script.split("\r\n");
  const keep = lines.findIndex((line) => line.startsWith('if exist "%WOWUPD_INSTALL%\\resources\\app\\server.json" del /f /q "%WOWUPD_FILES%\\resources\\app\\server.json"'));
  const copy = lines.findIndex((line) => line.includes("robocopy.exe"));
  assert.ok(keep > 0 && keep < copy, "the new build's server.json is dropped before copying, only when the player has one");
  assert.doesNotMatch(lines[copy], /\/(MIR|PURGE|MOV|MOVE)\b/i, "never deletes what the player keeps in the folder");
  assert.match(lines[copy], /"%WOWUPD_FILES%" "%WOWUPD_INSTALL%" \/E \/IS \/IT/);
  assert.equal(lines[copy + 1], "if errorlevel 8 goto copy_failed", "robocopy fails from 8 up");
  assert.ok(script.includes(`set "WOWUPD_LOG=%WOWUPD_INSTALL%\\${update.UPDATE_LOG}"`), "the log the failure notice names");
  assert.ok(script.includes(`>"%WOWUPD_INSTALL%\\${update.FAILED_MARKER}" echo`), "the marker the next start looks for");
  assert.match(script, /^start "" \/b "%SystemRoot%\\System32\\cmd\.exe" \/d \/c \.\\update\.cmd run$/m,
    "the second stage leaves the app's job object; .\\ because NoDefaultCurrentDirectoryInExePath may be set");
  assert.match(script, /2>nul \(\r\n {2}>>"%WOWUPD_WAIT%" \(call \)\r\n\) && goto copy/, "waits until the running exe can be written");
  assert.match(script, /^start "" "%WOWUPD_EXE%" "--server-url=%WOWUPD_SERVER_URL%"$/m);
});

test("the updater's environment: folders cmd can quote, the --server-url kept, nothing else", () => {
  assert.equal(update.cmdDirectory("D:\\"), "D:\\.", '"D:\\" would escape robocopy\'s closing quote');
  assert.equal(update.cmdDirectory("C:\\Games\\WoW WebClient\\"), "C:\\Games\\WoW WebClient");
  const env = update.updaterEnvironment({
    root: "C:\\Temp\\wowwebclient-update-1\\", files: "C:\\Temp\\wowwebclient-update-1\\files\\WoWWebClient", installDir: "D:\\",
    waitFor: "D:\\Renamed.exe", version: "0.1.0.3", serverUrl: 'http://203.0.113.10:8091/?a="b"&c',
  });
  assert.deepEqual(env, {
    WOWUPD_ROOT: "C:\\Temp\\wowwebclient-update-1", WOWUPD_FILES: "C:\\Temp\\wowwebclient-update-1\\files\\WoWWebClient",
    WOWUPD_INSTALL: "D:\\.", WOWUPD_WAIT: "D:\\Renamed.exe", WOWUPD_EXE: "D:\\WoWWebClient.exe", WOWUPD_VERSION: "0.1.0.3",
    WOWUPD_RELAUNCH: "1", WOWUPD_SERVER_URL: "http://203.0.113.10:8091/?a=%22b%22&c",
  });
  assert.equal(update.updaterEnvironment({ root: "C:\\t", files: "C:\\t\\f", installDir: "C:\\a", waitFor: "C:\\a\\x.exe", version: "1 & del" }).WOWUPD_VERSION, "?");
  assert.equal("WOWUPD_SERVER_URL" in update.updaterEnvironment({ root: "C:\\t", files: "C:\\t\\f", installDir: "C:\\a", waitFor: "C:\\a\\x.exe", version: "1" }), false);
  assert.throws(() => update.updaterEnvironment({ root: "C:\\t", files: "C:\\t\\f", installDir: "C:\\a", waitFor: "C:\\a\\x.exe", version: "1", serverUrl: "file:///x" }), /--server-url/);
});

test("installing in place needs Windows, the packed app and a writable folder; otherwise the browser", () => {
  assert.deepEqual(update.chooseInstallRoute({ platform: "win32", packaged: true, writable: true, installDir: "C:\\Games\\WoW" }), { action: "install" });
  const locked = update.chooseInstallRoute({ platform: "win32", packaged: true, writable: false, installDir: "C:\\Program Files\\WoW" });
  assert.equal(locked.action, "browser");
  assert.match(locked.reason, /Нет прав на запись в папку приложения \(C:\\Program Files\\WoW\)/);
  assert.equal(update.chooseInstallRoute({ platform: "win32", packaged: false, writable: true, installDir: "x" }).action, "browser");
  assert.equal(update.chooseInstallRoute({ platform: "linux", packaged: true, writable: true, installDir: "x" }).action, "browser");

  const dir = temp("writable");
  try {
    assert.equal(update.probeWritable(dir), true);
    writeFileSync(join(dir, "file"), "");
    assert.equal(update.probeWritable(join(dir, "file")), false, "not a folder");
    assert.equal(update.probeWritable(join(dir, "missing")), false);
    assert.deepEqual(readFileSync(join(dir, "file")), Buffer.alloc(0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(update.isPackagedApp("C:\\Games\\WoW\\resources\\app", "C:\\Games\\WoW\\WoWWebClient.exe"), true);
  assert.equal(update.isPackagedApp("c:\\games\\wow\\RESOURCES\\app", "C:\\Games\\WoW\\WoWWebClient.exe"), true);
  assert.equal(update.isPackagedApp("F:\\WebClient\\electron", "F:\\WebClient\\electron\\node_modules\\electron\\dist\\electron.exe"), false);

  const flow = read("electron/update-notice.cjs");
  assert.match(flow, /writable: packaged && update\.probeWritable\(installDir\) && update\.probeWritable\(appDir\)/);
  assert.match(flow, /if \(route\.action !== "install"\) \{\s+fail\(route\.reason\);\s+return;/, "decided before anything is downloaded");
});

test("old update folders are cleaned, a fresh one is left to its running updater", () => {
  const dir = temp("clean");
  try {
    for (const name of ["wowwebclient-update-old", "wowwebclient-update-new", "someone-else"]) mkdirSync(join(dir, name));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(join(dir, "wowwebclient-update-old"), old, old);
    utimesSync(join(dir, "someone-else"), old, old);
    assert.equal(update.cleanOldUpdateDirs(dir), 1);
    assert.deepEqual(["wowwebclient-update-old", "wowwebclient-update-new", "someone-else"].map((name) => existsSync(join(dir, name))), [false, true, true]);
    assert.equal(update.cleanOldUpdateDirs(join(dir, "missing")), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the notice: Russian text, its own buttons, and nothing it shows can become markup", () => {
  const offer = notice.noticeView({ kind: "offer", version: "0.1.0.3", current: "0.1.0.2", size: 130 * 1024 * 1024 });
  assert.equal(offer.title, "Доступна новая версия 0.1.0.3");
  assert.deepEqual(offer.buttons.map((button) => button.label), ["Обновить", "Позже"]);
  const download = notice.noticeView({ kind: "download", received: 65 * 1024 * 1024, size: 130 * 1024 * 1024 });
  assert.equal(download.progress, 0.5);
  assert.equal(download.text, "50 % — 65 из 130 МБ");
  const failed = notice.noticeView({ kind: "failed", text: "Нет прав на запись." });
  assert.deepEqual(failed.buttons.map((button) => button.action), ["browser", "close"]);
  assert.match(failed.text, /скачать в браузере/);
  assert.equal(notice.actionFromUrl("http://update.invalid/update"), "update");
  assert.equal(notice.actionFromUrl("http://update.invalid/rm"), undefined);
  assert.equal(notice.actionFromUrl("https://203.0.113.10/update"), undefined);
  const html = notice.noticeHtml({ title: "</script><img src=x onerror=alert(1)>", text: "x", buttons: [] });
  assert.ok(!html.includes("</script><img"), "a closing tag inside the state is escaped");
  assert.match(html, /textContent=v\.title/);
  assert.doesNotMatch(html, /innerHTML/);
});

test("main.cjs and build.mjs: only the player build carries the key and checks", () => {
  const main = read("electron/main.cjs");
  assert.match(main, /const updateConfig = remoteUrl === undefined \? undefined : readUpdateConfig\(__dirname\);/,
    "checked only against a players' server");
  const wiring = main.indexOf("startPlayerUpdates({ window, serverUrl: remoteUrl, config: updateConfig");
  assert.ok(wiring > 0 && wiring < main.indexOf("if (commandLineUrl !== undefined) window.loadURL(pageUrl);"), "listening before the first load");
  assert.match(main, /relaunchServerUrl: serverUrlOption/);

  const build = read("electron/build.mjs");
  const files = /const APP_FILES = \[([^\]]*)\]/.exec(build)?.[1] ?? "";
  for (const file of ["player-update.cjs", "update-notice.cjs"]) assert.ok(files.includes(`"${file}"`), `${file} must be packed`);
  assert.ok(!files.includes("player-release.mjs"), "the signing side stays out of the app");
  const playerBranch = build.indexOf("const url = playerUrl();");
  assert.ok(playerBranch > 0);
  assert.ok(build.indexOf("join(app, UPDATE_CONFIG_FILE)") > playerBranch, "update.json only in the player build");
  assert.equal(build.split("UPDATE_CONFIG_FILE),").length, 2, "written once");
  const order = ["removePublishedManifest(folder)", "await rm(zip, { force: true })", "writeSignedManifest({", "writeReleaseState(updateKeyDir, release)"]
    .map((text) => build.indexOf(text));
  assert.ok(order.every((at, index) => at > playerBranch && (index === 0 || at > order[index - 1])),
    "the old manifest goes before the zip is rewritten; the new one is signed after it; the counter moves last");
  assert.equal(update.PLAYER_EXE, "WoWWebClient.exe");

  const flow = read("electron/update-notice.cjs");
  assert.match(flow, /timeoutMs: 3000/);
  assert.match(flow, /net\.fetch\.bind\(net\)/);
  assert.match(flow, /showInactive\(\)/, "the notice never takes the game's focus");
});
