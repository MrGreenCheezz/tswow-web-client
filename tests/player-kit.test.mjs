// tools/player-kit.mjs — the kit sent to playtesters (bat\30): the Markdown-to-text conversion of
// docs/PLAYTEST.ru.md and the folder it assembles. Everything is built in a temporary folder; the
// real dist is never touched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  KIT_FILES, KIT_FOLDER, KIT_ZIP, PLAYTEST_FILE, START_FILE, buildKit, markdownToText, playerLink, windowsText,
} from "../tools/player-kit.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("Markdown becomes plain text: headings underlined, emphasis and backticks gone, code lines kept", () => {
  const text = markdownToText([
    "# Плейтест",
    "",
    "## 1. Как зайти",
    "",
    "**Лучше приложение**: распакуйте `WoWWebClient.zip`, *целиком*.",
    "- пункт со ссылкой [план](docs/PLAN.md) и https://example.invalid/",
    "> цитата",
    "",
    "```",
    "webclientUnhandledOpcodes()",
    "frameXmlWorld().errors.length",
    "```",
    "",
    "",
    "",
    "Конец.",
  ].join("\r\n"));
  assert.equal(text, [
    "Плейтест",
    "========",
    "",
    "1. Как зайти",
    "------------",
    "",
    "Лучше приложение: распакуйте WoWWebClient.zip, целиком.",
    "- пункт со ссылкой план (docs/PLAN.md) и https://example.invalid/",
    "цитата",
    "",
    "    webclientUnhandledOpcodes()",
    "    frameXmlWorld().errors.length",
    "",
    "Конец.",
    "",
  ].join("\n"));
});

test("the playtest guide converts without Markdown left in it, its console lines intact", () => {
  const text = markdownToText(readFileSync(join(root, "docs", "PLAYTEST.ru.md"), "utf8"));
  assert.doesNotMatch(text, /\*\*|`|^#/m);
  assert.match(text, /^Плейтест WoW WebClient\n=+\n/);
  for (const line of ["webclientUnhandledOpcodes()", "webclientPacketErrors()", "frameXmlWorld().errors.length"]) {
    assert.ok(text.includes(`\n    ${line}\n`), `${line} stays as its own indented line`);
  }
});

test("the browser link: --url= first, else PUBLIC_HOST and PUBLIC_WEB_PORT; no address is refused", () => {
  assert.equal(playerLink({ PUBLIC_HOST: "203.0.113.10" }, []), "http://203.0.113.10:8091/");
  assert.equal(playerLink({ PUBLIC_HOST: " 203.0.113.10 ", PUBLIC_WEB_PORT: "80" }, []), "http://203.0.113.10/");
  assert.equal(playerLink({ PUBLIC_HOST: "203.0.113.10" }, ["--open", "--url=http://198.51.100.7:9000/"]), "http://198.51.100.7:9000/");
  assert.throws(() => playerLink({}, ["--open"]), /PUBLIC_HOST is not set/);
  assert.throws(() => playerLink({ PUBLIC_HOST: "  " }, []), /PUBLIC_HOST is not set/);
});

test("Windows text: one BOM, CRLF only", () => {
  assert.equal(windowsText("a\nb\r\nc\n"), "﻿a\r\nb\r\nc\r\n");
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "player-kit-"));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "PLAYTEST.ru.md"), "# Плейтест\n\nПроверьте **вход**: `F12`.\n");
  return dir;
}

test("the kit refuses without the player app or without an address", (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => buildKit({ root: dir, env: { PUBLIC_HOST: "203.0.113.10" }, zip: false }), /WoWWebClient\.zip not found/);
  mkdirSync(join(dir, "dist", "player"), { recursive: true });
  writeFileSync(join(dir, "dist", "player", "WoWWebClient.zip"), "app");
  assert.throws(() => buildKit({ root: dir, env: {}, zip: false }), /PUBLIC_HOST is not set/);
  assert.equal(existsSync(join(dir, "dist", KIT_FOLDER)), false, "nothing is assembled before both are there");
});

test("the kit folder: the app, the start guide with the link, the playtest text — and one zip of it", (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "dist", "player"), { recursive: true });
  writeFileSync(join(dir, "dist", "player", "WoWWebClient.zip"), "app");
  const zip = process.platform === "win32";
  const kit = buildKit({ root: dir, env: { PUBLIC_HOST: "203.0.113.10", PUBLIC_WEB_PORT: "8091" }, zip });

  assert.deepEqual(KIT_FILES, ["WoWWebClient.zip", START_FILE, PLAYTEST_FILE]);
  assert.equal(kit.folder, join(dir, "dist", KIT_FOLDER));
  assert.deepEqual(readdirSync(kit.folder).sort(), [...KIT_FILES].sort());
  assert.equal(readFileSync(join(kit.folder, "WoWWebClient.zip"), "utf8"), "app");

  const start = readFileSync(join(kit.folder, START_FILE), "utf8");
  const playtest = readFileSync(join(kit.folder, PLAYTEST_FILE), "utf8");
  for (const [name, text] of [[START_FILE, start], [PLAYTEST_FILE, playtest]]) {
    assert.ok(text.startsWith("﻿"), `${name} starts with a BOM`);
    assert.doesNotMatch(text, /[^\r]\n/, `${name} has CRLF line ends only`);
  }
  assert.match(start, /http:\/\/203\.0\.113\.10:8091\//);
  assert.match(start, /Логин: ______ {2}Пароль: ______/);
  assert.match(start, /Подробнее» → «Выполнить в любом случае/);
  assert.match(start, /F11[^\r]*Ctrl\+R[^\r]*F12/);
  assert.match(start, /в файле Плейтест\.txt/);
  assert.equal(playtest, "﻿Плейтест\r\n========\r\n\r\nПроверьте вход: F12.\r\n");

  if (zip) {
    assert.equal(kit.archive, join(dir, "dist", KIT_ZIP));
    const bytes = readFileSync(kit.archive);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50, "a zip archive");
    assert.ok(bytes.readUInt16LE(6) & 0x0800, "names are marked UTF-8");
    assert.ok(bytes.includes(Buffer.from(`${KIT_FOLDER}/${START_FILE}`)), "the folder and its files, by their UTF-8 names");
  }

  // A second run replaces the kit rather than adding to it.
  writeFileSync(join(kit.folder, "stray.txt"), "x");
  buildKit({ root: dir, env: { PUBLIC_HOST: "203.0.113.10" }, zip: false });
  assert.deepEqual(readdirSync(kit.folder).sort(), [...KIT_FILES].sort());
});
