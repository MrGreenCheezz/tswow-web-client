"use strict";

/**
 * The player app's `server.json` (written by build.mjs --player), checked without `electron` so a
 * test can require it. A broken file used to throw from `JSON.parse` while main.cjs was being
 * loaded — the app died with Electron's generic dialog and no hint which file was wrong.
 */
function parseServerConfig(text, file = "server.json") {
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: не читается как JSON (${error.message}). Переустановите приложение или исправьте файл.`);
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${file}: ожидался объект { "url": "http://…" }`);
  }
  if (typeof config.url !== "string" || !/^https?:\/\//.test(config.url)) {
    throw new Error(`${file}: url must be http(s)://…`);
  }
  return config;
}

module.exports = { parseServerConfig };
