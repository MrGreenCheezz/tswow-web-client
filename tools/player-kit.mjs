// The kit to send to playtesters, assembled after the player app build (bat\30, «Игроки - собрать
// набор»): dist\Для игроков\ with
//   WoWWebClient.zip   the player app (a copy of dist\player\WoWWebClient.zip);
//   Как начать.txt     what this is, the two ways in (the app; the browser at
//                      http://PUBLIC_HOST:PUBLIC_WEB_PORT/ from .env), a line for the login and
//                      password, the keys;
//   Плейтест.txt       docs/PLAYTEST.ru.md as plain text;
// and the same folder as dist\Для игроков.zip beside it, so one file can be sent.
//
//   node tools/player-kit.mjs [--url=http://host:port/] [--open]
//
// --url= is the address the player build was given instead of PUBLIC_HOST (bat\30 passes its
// options through); --open shows the folder in Explorer at the end. dist is git-ignored: the real
// address lives only in this local copy. The text files are UTF-8 with a BOM and CRLF, like the
// player app's own README.txt, so Notepad on any Windows shows them as written.

import "./env.mjs";

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { PLAYER_ZIP } = createRequire(import.meta.url)("../electron/player-update.cjs");

export const KIT_FOLDER = "Для игроков";
export const KIT_ZIP = `${KIT_FOLDER}.zip`;
export const START_FILE = "Как начать.txt";
export const PLAYTEST_FILE = "Плейтест.txt";
/** What the kit folder holds, in this order. */
export const KIT_FILES = Object.freeze([PLAYER_ZIP, START_FILE, PLAYTEST_FILE]);

/** Inline Markdown to plain text: code spans keep their text, emphasis loses its markers, links show the address. */
function inlineText(line) {
  return line.split(/(`[^`]+`)/).map((part) => {
    if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) return part.slice(1, -1);
    return part
      .replace(/!?\[([^\]]*)\]\(([^)\s]+)\)/g, (_, text, target) => (!text || text === target ? target : `${text} (${target})`))
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/__(.+?)__/g, "$1")
      .replace(/(^|[^\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, "$1$2")
      .replace(/\\([\\`*_[\]#>-])/g, "$1");
  }).join("");
}

/**
 * Markdown as readable plain text: headings underlined (`=` for the first level, `-` below it),
 * emphasis and backticks dropped, fenced code kept line by line and indented by four spaces,
 * block quotes unquoted. Lists and tables stay as written. Lines end with "\n".
 */
export function markdownToText(markdown) {
  const out = [];
  let fence;
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fence) {
      if (fenceMark && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = undefined;
      else out.push(raw.trim() === "" ? "" : `    ${raw}`);
      continue;
    }
    if (fenceMark) { fence = fenceMark; continue; }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (heading) {
      const text = inlineText(heading[2]);
      out.push(text, (heading[1].length === 1 ? "=" : "-").repeat(text.length));
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) { out.push("-".repeat(40)); continue; }
    out.push(inlineText(raw.replace(/^\s*>\s?/, "")).replace(/\s+$/, ""));
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/** Text as Notepad expects it everywhere: a UTF-8 BOM and CRLF line ends. */
export function windowsText(text) {
  return `\uFEFF${text.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n")}`;
}

/** The page players open in a browser: --url=, else PUBLIC_HOST and PUBLIC_WEB_PORT, as electron/build.mjs builds it. */
export function playerLink(env, argv) {
  const given = argv.find((arg) => arg.startsWith("--url="))?.slice("--url=".length);
  if (given) return new URL(given).href;
  const host = env.PUBLIC_HOST?.trim();
  if (!host) {
    throw new Error("PUBLIC_HOST is not set in .env (the address players reach this machine by): "
      + "the kit has no link to give. Set it, or pass --url=.");
  }
  const port = Number.parseInt(env.PUBLIC_WEB_PORT ?? "8091", 10);
  return new URL(`http://${host}${port === 80 ? "" : `:${port}`}/`).href;
}

/** «Как начать.txt»: the short guide that goes with the app. */
export function startGuide(link) {
  return [
    "WoW WebClient — плейтест",
    "========================",
    "",
    "Это клиент World of Warcraft 3.3.5a, который работает в небольшом приложении или в браузере.",
    "Устанавливать саму игру не нужно: всё приходит с сервера. Клиент ещё в разработке,",
    "поэтому ошибки ожидаемы — ради них и тест.",
    "",
    "Как зайти — любой из двух способов:",
    "",
    "1. Приложение (лучше: стабильнее и быстрее браузера)",
    `   - Распакуйте ${PLAYER_ZIP} целиком в любую папку, куда можно писать`,
    "     (например, Документы\\WoWWebClient, но не Program Files).",
    "   - Запустите WoWWebClient.exe.",
    "   - Если Windows покажет «Система Windows защитила ваш компьютер» — у программы нет цифровой",
    "     подписи: нажмите «Подробнее» → «Выполнить в любом случае».",
    "",
    "2. Браузер (Chrome, Edge или другой на Chromium)",
    `   - Откройте ссылку: ${link}`,
    "",
    "Логин: ______  Пароль: ______",
    "",
    "Клавиши приложения: F11 — полный экран, Ctrl+R — перезагрузить, F12 — инструменты разработчика.",
    "",
    `Что проверить и как сообщать о проблемах — в файле ${PLAYTEST_FILE}`,
    "",
  ].join("\n");
}

/**
 * Assembles the kit under `dist`: the folder with KIT_FILES and, with `zip`, KIT_ZIP beside it
 * (Windows' own tar, UTF-8 names so Explorer shows the Cyrillic ones on any system locale).
 * Throws with a reason when the player app is not built or there is no address.
 */
export function buildKit({ root, dist = join(root, "dist"), env = process.env, argv = [], zip = true }) {
  const appZip = join(dist, "player", PLAYER_ZIP);
  if (!existsSync(appZip)) {
    throw new Error(`${appZip} not found: build the player app first (node electron/build.mjs --player; bat\\30 does both).`);
  }
  const link = playerLink(env, argv);
  const playtest = readFileSync(join(root, "docs", "PLAYTEST.ru.md"), "utf8");
  const folder = join(dist, KIT_FOLDER);
  const archive = join(dist, KIT_ZIP);
  try {
    rmSync(folder, { recursive: true, force: true });
    rmSync(archive, { force: true });
  } catch (error) {
    throw new Error(`Cannot replace ${folder} (${error.code}): close what holds it open (Explorer, an editor) and try again.`);
  }
  mkdirSync(folder, { recursive: true });
  copyFileSync(appZip, join(folder, PLAYER_ZIP));
  writeFileSync(join(folder, START_FILE), windowsText(startGuide(link)));
  writeFileSync(join(folder, PLAYTEST_FILE), windowsText(markdownToText(playtest)));
  if (zip) {
    // -a picks zip from the extension, as in electron/build.mjs; hdrcharset=UTF-8 marks the names
    // as UTF-8 (without it bsdtar writes them in the OEM code page).
    execFileSync(join(env.SystemRoot ?? process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
      ["-a", "-c", "-f", archive, "--options", "hdrcharset=UTF-8", "-C", dist, KIT_FOLDER], { stdio: "inherit" });
  }
  return { folder, archive: zip ? archive : undefined, link, files: [...KIT_FILES] };
}

function main() {
  const argv = process.argv.slice(2);
  const root = fileURLToPath(new URL("..", import.meta.url));
  let kit;
  try {
    kit = buildKit({ root, argv });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  console.log(`Player kit for ${kit.link}`);
  console.log(`  folder: ${kit.folder}`);
  console.log(`  send:   ${kit.archive}`);
  console.log(`  The login and password line in "${START_FILE}" is empty: fill it in for each tester`);
  console.log("  (then send the folder's files) or send the login and password separately.");
  if (argv.includes("--open")) spawn("explorer.exe", [kit.folder], { detached: true, stdio: "ignore" }).unref();
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
