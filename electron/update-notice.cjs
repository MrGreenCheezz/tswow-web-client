"use strict";

/**
 * 10.17 — the player app's update notice and the update itself, wired by main.cjs only in the
 * player build (resources/app/update.json, build.mjs --player) when it opens a players' server.
 *
 * Once per session, the first time the game page (not a status page) finishes loading, the app
 * asks the server for player/latest.json and its signature (player-update.cjs, 3 s, silent on any
 * failure). A correctly signed, newer version gets a small panel over the window's top-right corner:
 * «Доступна новая версия N» with «Обновить» and «Позже». «Позже» closes it for this session and
 * remembers nothing. «Обновить» downloads the zip with progress (also on the taskbar button),
 * checks its size and SHA-256 against the signed manifest, unpacks it into a temp folder, starts the
 * updater script and quits; the script copies the new files over this folder (keeping the player's
 * server.json) and starts the app again. When the folder is not writable, or anything fails, the
 * panel says so in Russian and offers the download in the browser instead.
 *
 * The panel is a frameless child window showing a `data:` page this file writes: no preload and no
 * IPC; its buttons are links to http://update.invalid/<action>, which `will-navigate` intercepts
 * and cancels. The game page cannot reach any of it. `electron` is required lazily, so
 * `noticeView`/`noticeHtml` load under `node --test`.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const update = require("./player-update.cjs");

const NOTICE_WIDTH = 420;
const NOTICE_HEIGHTS = { offer: 128, download: 128, busy: 112, failed: 200 };
const NOTICE_MARGIN = 16;
const ACTION_PREFIX = "http://update.invalid/";
const ACTIONS = new Set(["update", "later", "cancel", "browser", "close"]);

function megabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace(".", ",");
}

/** What the panel shows for a state: `{ title, text, progress?, buttons: [{ action, label, primary }] }`. */
function noticeView(state) {
  switch (state.kind) {
    case "offer":
      return {
        title: `Доступна новая версия ${state.version}`,
        text: `Установлена ${state.current}. Загрузка ${megabytes(state.size)} МБ, затем приложение перезапустится.`,
        buttons: [{ action: "update", label: "Обновить", primary: true }, { action: "later", label: "Позже" }],
      };
    case "download": {
      const fraction = state.size > 0 ? Math.min(1, state.received / state.size) : 0;
      return {
        title: "Загрузка обновления…",
        text: `${Math.floor(fraction * 100)} % — ${megabytes(state.received)} из ${megabytes(state.size)} МБ`,
        progress: fraction,
        buttons: [{ action: "cancel", label: "Отмена" }],
      };
    }
    case "busy":
      return { title: state.title, text: state.text, buttons: [] };
    case "failed":
      return {
        title: "Не удалось обновить приложение",
        text: `${state.text}\nНовую версию можно скачать в браузере и распаковать вместо этой папки.`,
        buttons: [{ action: "browser", label: "Скачать в браузере", primary: true }, { action: "close", label: "Закрыть" }],
      };
    default:
      throw new Error(`unknown notice state ${state.kind}`);
  }
}

/** JSON safe to put inside a <script> element (no `</script>`; JSON is valid JavaScript since ES2019). */
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The panel's page: everything set through textContent, so no text can become markup. */
function noticeHtml(view) {
  return "<!doctype html><html lang=\"ru\"><meta charset=\"utf-8\"><title>WoW WebClient</title><style>"
    + "html,body{margin:0;height:100%;overflow:hidden;background:#0b0b0b;color:#ccc;font:13px 'Segoe UI',sans-serif;"
    + "user-select:none;-webkit-user-select:none}"
    + "body{box-sizing:border-box;border:1px solid #6b5a1e;padding:10px 14px;display:flex;flex-direction:column;gap:6px}"
    + "h1{margin:0;font-size:15px;font-weight:600;color:#ffd100}"
    + "p{margin:0;white-space:pre-wrap;overflow:auto;flex:1 1 auto}"
    + "#bar{height:6px;background:#262626;border-radius:3px;overflow:hidden}#bar>i{display:block;height:100%;width:0;background:#ffd100}"
    + "#buttons{display:flex;gap:8px;justify-content:flex-end}"
    + "a{padding:4px 14px;border-radius:3px;text-decoration:none;font-weight:600;background:#333;color:#ddd;cursor:default}"
    + "a.primary{background:#ffd100;color:#000}a:hover{filter:brightness(1.15)}"
    + "</style><body><h1 id=\"title\"></h1><p id=\"text\"></p><div id=\"bar\" hidden><i id=\"fill\"></i></div>"
    + "<div id=\"buttons\"></div><script>"
    + `const ACTION=${JSON.stringify(ACTION_PREFIX)};`
    + "function render(v){document.getElementById('title').textContent=v.title;"
    + "document.getElementById('text').textContent=v.text;"
    + "const bar=document.getElementById('bar');bar.hidden=typeof v.progress!=='number';"
    + "document.getElementById('fill').style.width=Math.round((v.progress||0)*100)+'%';"
    + "document.getElementById('buttons').replaceChildren(...v.buttons.map(function(b){"
    + "const a=document.createElement('a');a.href=ACTION+b.action;a.textContent=b.label;"
    + "if(b.primary)a.className='primary';a.draggable=false;return a;}));}"
    + `render(${scriptJson(view)});`
    + "</script></html>";
}

/** The action a panel link names, or undefined for anything else. */
function actionFromUrl(url) {
  if (typeof url !== "string" || !url.startsWith(ACTION_PREFIX)) return undefined;
  const action = url.slice(ACTION_PREFIX.length);
  return ACTIONS.has(action) ? action : undefined;
}

/** The panel over `parent`'s top-right corner; `show(state)` opens or updates it. */
function createNotice(parent, BrowserWindow, onAction) {
  let window;
  let ready = false;
  let pending;
  let height = NOTICE_HEIGHTS.offer;
  const place = () => {
    if (window === undefined || window.isDestroyed() || parent.isDestroyed()) return;
    const bounds = parent.getContentBounds();
    window.setBounds({
      x: Math.round(bounds.x + bounds.width - NOTICE_WIDTH - NOTICE_MARGIN), y: Math.round(bounds.y + NOTICE_MARGIN),
      width: NOTICE_WIDTH, height,
    });
  };
  const apply = (state) => {
    height = NOTICE_HEIGHTS[state.kind] ?? height;
    place();
    window.webContents.executeJavaScript(`render(${scriptJson(noticeView(state))})`).catch(() => {});
  };
  const open = (state) => {
    height = NOTICE_HEIGHTS[state.kind] ?? height;
    ready = false;
    window = new BrowserWindow({
      parent, width: NOTICE_WIDTH, height, show: false, frame: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
      backgroundColor: "#0b0b0b", title: "WoW WebClient",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    const own = window;
    own.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    own.webContents.on("will-navigate", (event, legacyUrl) => {
      event.preventDefault();
      const action = actionFromUrl(event.url ?? legacyUrl);
      if (action !== undefined) onAction(action);
    });
    own.webContents.on("did-finish-load", () => {
      ready = true;
      if (pending !== undefined) {
        const next = pending;
        pending = undefined;
        apply(next);
      }
    });
    // Shown without taking focus: a player typing a password keeps typing into the game.
    own.once("ready-to-show", () => { place(); if (!own.isDestroyed()) own.showInactive(); });
    parent.on("move", place);
    parent.on("resize", place);
    own.on("closed", () => {
      parent.removeListener("move", place);
      parent.removeListener("resize", place);
      if (window === own) { window = undefined; ready = false; pending = undefined; }
    });
    place();
    own.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(noticeHtml(noticeView(state)))}`);
  };
  return {
    show(state) {
      if (parent.isDestroyed()) return;
      if (window === undefined || window.isDestroyed()) open(state);
      else if (!ready) pending = state;
      else apply(state);
    },
    close() {
      if (window !== undefined && !window.isDestroyed()) window.close();
    },
  };
}

/**
 * Starts the once-per-session check for `window`. `serverUrl` is the page the app opens (server.json
 * `url` or --server-url), `config` update.json, `appDir` main.cjs's folder, `relaunchServerUrl` the
 * --server-url to start the updated app with (undefined: it reads server.json).
 */
function startPlayerUpdates({ window, serverUrl, config, appDir, relaunchServerUrl, log = console }) {
  const { app, BrowserWindow, net, shell } = require("electron");
  // Chromium's network stack (system proxy, like the page) where Electron has it.
  const fetchImpl = typeof net?.fetch === "function" ? net.fetch.bind(net) : globalThis.fetch;
  const installDir = path.dirname(process.execPath);
  let urls;
  try {
    urls = update.updateUrls(serverUrl);
  } catch (error) {
    log.warn(`[update] off: ${error.message}`);
    return;
  }
  let offered;
  let installing = false;
  let download;
  let cancelled = false;
  const notice = createNotice(window, BrowserWindow, (action) => {
    if (action === "update" && offered !== undefined && !installing) {
      installing = true;
      install(offered).catch((error) => log.warn(`[update] ${error.stack ?? error}`)).finally(() => { installing = false; });
    } else if (action === "later" || action === "close") {
      notice.close();
    } else if (action === "cancel") {
      cancelled = true;
      download?.abort();
    } else if (action === "browser") {
      shell.openExternal(offered?.zipUrl ?? urls.zip).catch((error) => log.warn(`[update] ${error.message}`));
      notice.close();
    }
  });
  const fail = (text) => notice.show({ kind: "failed", text });

  async function install(result) {
    const { manifest } = result;
    const packaged = update.isPackagedApp(appDir, process.execPath);
    const route = update.chooseInstallRoute({
      platform: process.platform, packaged, installDir,
      writable: packaged && update.probeWritable(installDir) && update.probeWritable(appDir),
    });
    if (route.action !== "install") {
      fail(route.reason);
      return;
    }
    cancelled = false;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), update.TEMP_PREFIX));
    const zip = path.join(root, "update.zip");
    let launched = false;
    let shown = 0;
    try {
      notice.show({ kind: "download", received: 0, size: manifest.size });
      download = new AbortController();
      await update.downloadVerified({
        fetch: fetchImpl, url: result.zipUrl, file: zip, manifest, signal: download.signal,
        onProgress: (received, size) => {
          const now = Date.now();
          if (now - shown < 200 && received < size) return;
          shown = now;
          if (!window.isDestroyed()) window.setProgressBar(received / size);
          notice.show({ kind: "download", received, size });
        },
      });
      download = undefined;
      notice.show({ kind: "busy", title: "Распаковка обновления…", text: "Это займёт несколько секунд." });
      const files = await update.extractUpdate({ zip, root });
      fs.rmSync(zip, { force: true });
      notice.show({ kind: "busy", title: `Установка версии ${manifest.version}…`, text: "Приложение закроется и запустится снова." });
      update.writeUpdaterScript(root);
      await update.launchUpdater({
        root,
        environment: update.updaterEnvironment({
          root, files, installDir, waitFor: process.execPath, version: manifest.version, serverUrl: relaunchServerUrl,
        }),
      });
      launched = true;
      log.log(`[update] updater started from ${root}; quitting for ${manifest.version}`);
      app.quit();
    } catch (error) {
      if (cancelled) {
        notice.close();
        return;
      }
      fail(error instanceof update.UpdateError ? error.message : `Ошибка: ${error.message}`);
    } finally {
      download = undefined;
      if (!window.isDestroyed()) window.setProgressBar(-1);
      if (!launched) {
        try {
          fs.rmSync(root, { recursive: true, force: true });
        } catch {
          // A later start removes it (cleanOldUpdateDirs).
        }
      }
    }
  }

  async function check() {
    update.cleanOldUpdateDirs(os.tmpdir());
    // The updater could not copy everything last time: say so once, before anything else.
    const marker = path.join(installDir, update.FAILED_MARKER);
    if (fs.existsSync(marker)) {
      fs.rmSync(marker, { force: true });
      fail(`Прошлое обновление установилось не полностью, подробности — в ${path.join(installDir, update.UPDATE_LOG)}.`);
      return;
    }
    const result = await update.checkForUpdate({
      fetch: fetchImpl, serverUrl, currentVersion: config.version, publicKey: config.publicKey, timeoutMs: 3000,
    });
    if (result.status !== "update") {
      log.log(`[update] ${result.reason}`);
      return;
    }
    log.log(`[update] ${result.manifest.version} offered (this app is ${config.version})`);
    offered = result;
    notice.show({ kind: "offer", version: result.manifest.version, current: config.version, size: result.manifest.size });
  }

  // After the window is up, and only once the server answers: the first load of the game page.
  let started = false;
  const onLoad = () => {
    if (started || window.isDestroyed() || window.webContents.getURL().startsWith("data:")) return;
    started = true;
    window.webContents.removeListener("did-finish-load", onLoad);
    check().catch((error) => log.warn(`[update] ${error.stack ?? error}`));
  };
  window.webContents.on("did-finish-load", onLoad);
}

module.exports = { actionFromUrl, noticeHtml, noticeView, startPlayerUpdates };
