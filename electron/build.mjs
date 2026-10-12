// Packs the Electron version, in one of two shapes. Both are Electron's own prebuilt runtime from
// node_modules/electron/dist with this shell as resources/app: the manual packaging Electron
// documents ("Application Packaging", with prebuilt binaries), so no packager dependency.
//
//   node electron/build.mjs            local version → dist/electron (electron\build.bat)
//     Bundles the built web page (dist/web) as resources/app/web, which main.cjs serves itself,
//     and starts the gateway from this WebClient checkout when none runs. Build the page first
//     (`npm run build`); electron\build.bat does both. Local only: the page embeds data generated
//     from this machine's client.
//
//   node electron/build.mjs --player [--url=http://host:port/]
//                                      player app → dist/player/WoWWebClient.zip (online\build-player.bat)
//     No page and no gateway inside: server.json points the shell at the page another machine
//     serves (tools/start-server.mjs), by default http://PUBLIC_HOST:PUBLIC_WEB_PORT/ from .env.
//     Nothing in it comes from a WoW client, so it is the one to send to other players.
//     10.17 (updates): every player build gets the next version (package.json's major.minor.patch
//     plus a build counter) and writes, beside the zip, latest.json and its Ed25519 signature
//     latest.json.sig; the players' server serves them under /player/, and apps built earlier
//     offer the new version themselves. The signing key is created on the first player build in
//     .runtime/player-update-key/ (git-ignored) and never leaves this machine; its public half
//     goes into the app as resources/app/update.json (electron/player-release.mjs).

import "../tools/env.mjs";

import { execFileSync } from "node:child_process";
import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module"; // L10 (10.17)

import {
  loadOrCreateSigningKey, nextRelease, readPublishedVersion, readReleaseState, removePublishedManifest, updateConfig,
  writeReleaseState, writeSignedManifest,
} from "./player-release.mjs"; // 10.17 (updates)

const { parseGatewaySettings, playerServerConfig } = createRequire(import.meta.url)("./gateway-target.cjs"); // L10 (10.17)
const { PLAYER_EXE, PLAYER_FOLDER, PLAYER_ZIP, UPDATE_CONFIG_FILE } = createRequire(import.meta.url)("./player-update.cjs"); // 10.17 (updates)
const shell = dirname(fileURLToPath(import.meta.url));
const root = resolve(shell, "..");
const runtime = join(shell, "node_modules", "electron", "dist");
const web = join(root, "dist", "web");
const executable = PLAYER_EXE; // the updater (player-update.cjs) restarts the player app by this name
/** 10.17 (updates): the signing key and the build counter; .runtime is git-ignored, the key stays here. */
const updateKeyDir = join(root, ".runtime", "player-update-key");
/** What the shell needs at run time; everything else in this folder is for building it. */
const APP_FILES = ["main.cjs", "static-server.cjs", "gateway.cjs", "recovery.cjs", "server-config.cjs", "gateway-target.cjs", "cpu-policy.ps1",
  "player-update.cjs", "update-notice.cjs"]; // L10: gateway-target.cjs (10.17); 10.17 (updates): player-update.cjs, update-notice.cjs

const player = process.argv.includes("--player");

async function mustExist(path, hint) {
  try { await access(path); } catch { throw new Error(`${path} not found. ${hint}`); }
}

/** The page the player app opens: --url, or PUBLIC_HOST and PUBLIC_WEB_PORT from .env. */
function playerUrl() {
  const given = process.argv.find((arg) => arg.startsWith("--url="))?.slice("--url=".length);
  if (given) return new URL(given).href;
  const host = process.env.PUBLIC_HOST?.trim();
  if (!host) throw new Error("PUBLIC_HOST is not set in .env (the address players reach the server by), and no --url= was given.");
  const port = Number.parseInt(process.env.PUBLIC_WEB_PORT ?? "8091", 10);
  return new URL(`http://${host}${port === 80 ? "" : `:${port}`}/`).href;
}

/**
 * L10 (10.17): the gateway the player app waits for — --gateway-url=, else --gateway-port= or the
 * server's GATEWAY_PORT from .env (tools/start-server.mjs serves the gateway there); server.json
 * carries it only when it is not the page host's 8090.
 */
function playerGateway() {
  const given = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const url = given("gateway-url");
  const port = given("gateway-port") ?? process.env.GATEWAY_PORT?.trim();
  return parseGatewaySettings({
    ...(url === undefined ? {} : { gatewayUrl: url }),
    ...(port === undefined || port === "" ? {} : { gatewayPort: Number(port) }),
  }, "--gateway-url/--gateway-port/GATEWAY_PORT");
}

/** Electron's runtime under `output`, renamed, with an empty resources/app; returns that app folder. */
async function packRuntime(output) {
  try {
    await rm(output, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`Cannot replace ${output} (${error.code}): close ${executable} if it is running.`);
  }
  await cp(runtime, output, { recursive: true });
  // Electron's placeholder app would otherwise stay beside ours.
  await rm(join(output, "resources", "default_app.asar"), { force: true });
  await rename(join(output, "electron.exe"), join(output, executable));
  const app = join(output, "resources", "app");
  await mkdir(app, { recursive: true });
  for (const file of APP_FILES) await cp(join(shell, file), join(app, file));
  return app;
}

async function writeManifest(app, name) {
  const manifest = JSON.parse(await readFile(join(shell, "package.json"), "utf8"));
  await writeFile(join(app, "package.json"), `${JSON.stringify({
    name,
    version: manifest.version,
    description: manifest.description,
    main: manifest.main,
  }, null, 2)}\n`);
}

if (process.platform !== "win32") throw new Error("The Electron version is packed for Windows only.");
await mustExist(join(runtime, "electron.exe"), 'Run "npm install" in the electron folder first.');

if (!player) {
  await mustExist(join(web, "index.html"), 'Build the web page first: "npm run build" in the WebClient root.');
  const output = join(root, "dist", "electron");
  const app = await packRuntime(output);
  // Same name as the development shell, so both keep one profile (settings, saved layouts).
  await writeManifest(app, JSON.parse(await readFile(join(shell, "package.json"), "utf8")).name);
  await cp(web, join(app, "web"), { recursive: true });
  // The page may embed data generated from the local client: the same notice as dist/web, on top.
  await cp(join(web, "LOCAL_ONLY-NOT-FOR-REDISTRIBUTION.txt"), join(output, "LOCAL_ONLY-NOT-FOR-REDISTRIBUTION.txt"))
    .catch(() => {});
  console.log(`Electron version packed: ${join(output, executable)}`);
  console.log("It serves the built page at http://127.0.0.1:5173/ and starts the gateway from this checkout when none is running.");
} else {
  const url = playerUrl();
  const gateway = playerGateway(); // L10 (10.17): checked before anything is packed
  const folder = join(root, "dist", "player");
  const output = join(folder, PLAYER_FOLDER);
  const zip = join(folder, PLAYER_ZIP);
  // 10.17 (updates): the key and the next version, before anything is packed.
  const key = loadOrCreateSigningKey(updateKeyDir);
  if (key.created) {
    console.log(`Created the player app update key ${join(updateKeyDir, "private.pem")} (fingerprint ${key.fingerprint}).`);
    console.log("  Keep that folder and never share private.pem: apps built from now on accept only updates signed");
    console.log("  with this key, and without it every player has to reinstall by hand once.");
  }
  const shellPackage = JSON.parse(await readFile(join(shell, "package.json"), "utf8"));
  const release = nextRelease({
    baseVersion: shellPackage.version, state: readReleaseState(updateKeyDir), publishedVersion: readPublishedVersion(folder),
  });
  const app = await packRuntime(output);
  // Its own profile: on the owner's machine a test run never mixes with the development shell's.
  await writeManifest(app, "wow-webclient-player");
  // No CPU pinning by default: on a stranger's machine an unsigned exe running PowerShell with
  // -ExecutionPolicy Bypass is what antivirus heuristics flag. --cpu-class=fastest still turns it on.
  await writeFile(join(app, "server.json"), `${JSON.stringify(playerServerConfig(url, gateway), null, 2)}\n`); // L10 (10.17)
  // 10.17 (updates): only this build carries update.json, so only the player app checks for updates.
  await writeFile(join(app, UPDATE_CONFIG_FILE),
    `${JSON.stringify(updateConfig({ version: release.version, publicKeyDer: key.publicKeyDer }), null, 2)}\n`);
  await writeFile(join(output, "README.txt"), `\uFEFF${[
    `WoW WebClient ${release.version}`,
    "",
    "1. Распакуйте архив целиком в любую папку.",
    "2. Запустите WoWWebClient.exe.",
    `   Игра откроется с сервера ${url}`,
    "   Устанавливать World of Warcraft не нужно, нужен только интернет.",
    "",
    "Если Windows покажет «Система Windows защитила ваш компьютер» (программа без цифровой подписи),",
    "нажмите «Подробнее» → «Выполнить в любом случае».",
    "",
    "Если сервер выключен, окно скажет «Нет связи с сервером» и подключится само, когда он заработает.",
    "F11 — полный экран, Ctrl+R — перезагрузить страницу.",
    "",
    "Обновления приложение находит само: при запуске оно предложит новую версию, если она есть на сервере.",
    "Папка приложения должна быть доступна для записи (например, не в Program Files) — иначе новую",
    "версию придётся скачать в браузере и распаковать вместо старой. Ваш server.json при обновлении",
    "сохраняется.",
    "",
  ].join("\r\n")}`);
  // 10.17 (updates): no manifest may point at a zip that is being rewritten; players are offered
  // nothing until the new one is signed below.
  removePublishedManifest(folder);
  await rm(zip, { force: true });
  // Windows' own bsdtar writes zip archives (-a picks the format from the extension).
  execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
    ["-a", "-c", "-f", zip, "-C", folder, PLAYER_FOLDER], { stdio: "inherit" });
  const published = await writeSignedManifest({ folder, zip, file: PLAYER_ZIP, version: release.version, privateKey: key.privateKey });
  writeReleaseState(updateKeyDir, release);
  console.log(`Player app ${release.version} packed for ${url}`);
  const written = playerServerConfig(url, gateway); // L10 (10.17)
  if (written.gatewayUrl ?? written.gatewayPort) console.log(`  gateway: ${written.gatewayUrl ?? `port ${written.gatewayPort}`}`);
  console.log(`  folder: ${output}`);
  console.log(`  send:   ${zip}`);
  console.log(`  update: ${published.manifestFile} (+ .sig, key ${key.fingerprint}): online\\start-server.bat offers it`);
  console.log("          to apps already installed, at /player/latest.json.");
}
