// The launchers in bat\: their names, their line ends, and that every script one of them names
// exists. cmd reads a .bat in the console code page, so the Cyrillic names never appear inside a
// script: a script finds another by its number (`for %%F in ("%~dp010 *.bat")`), and Node code
// that starts one names it in full.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const folder = join(root, "bat");

const EXPECTED = [
  "01 Играть - браузер.bat",
  "02 Играть - приложение (разработка).bat",
  "03 Играть - приложение (собранное).bat",
  "10 Шлюз - запустить.bat",
  "11 Шлюз - перезапустить.bat",
  "12 Шлюз - остановить.bat",
  "20 Сборка - игра.bat",
  "21 Сборка - приложение.bat",
  "22 Сборка - ресурсы.bat",
  "23 Страница - собранная.bat",
  "30 Игроки - собрать набор.bat",
  "31 Игроки - проверить у себя.bat",
  "32 Игроки - начать раздачу.bat",
];

const scripts = readdirSync(folder).filter((name) => name.toLowerCase().endsWith(".bat")).sort();

test("bat\\ holds exactly the numbered launchers", () => {
  assert.deepEqual(scripts, [...EXPECTED].sort());
});

test("every launcher is plain ASCII with CRLF line ends and starts from the repository root", () => {
  for (const name of scripts) {
    const text = readFileSync(join(folder, name), "utf8");
    assert.match(text, /^[\x09\x0a\x0d\x20-\x7e]*$/, `${name}: ASCII only (cmd reads it in the OEM code page)`);
    assert.doesNotMatch(text, /[^\r]\n/, `${name}: CRLF only (.gitattributes, cmd labels)`);
    assert.match(text, /^@echo off\r\nsetlocal\r\ntitle [^\r]+\r\ncd \/d "%~dp0\.\."\r\n/, `${name}: the common header`);
  }
});

test("a script named by number inside another one exists, exactly once", () => {
  for (const name of scripts) {
    const text = readFileSync(join(folder, name), "utf8");
    for (const [, number] of text.matchAll(/%~dp0(\d\d) \*\.bat/g)) {
      assert.equal(scripts.filter((script) => script.startsWith(`${number} `)).length, 1, `${name} looks up script ${number}`);
    }
  }
});

// 06.11 (10.11): a launcher that may start the gateway asks the gateway itself (/health), not the bare
// port; the restart rebuilds by the gateway's own sources, not the whole tree.
test("bat 01 and 02 ask /health before starting the gateway; bat 11 rebuilds by the gateway's sources", () => {
  const text = (prefix) => readFileSync(join(folder, scripts.find((name) => name.startsWith(prefix))), "utf8");
  for (const prefix of ["01 ", "02 "]) {
    const script = text(prefix);
    assert.match(script, /node tools\\port\.mjs check-gateway 8090\r\n\s*if errorlevel 2 \(/, `${prefix}asks the gateway`);
    assert.doesNotMatch(script, /port\.mjs check 8090/, `${prefix}does not take any listener on 8090 for the gateway`);
  }
  const restart = text("11 ");
  assert.match(restart, /node tools\\build-gateway\.mjs --check\r\n\s*if not errorlevel 1 set "REBUILD=1"\r\n\s*if errorlevel 2 set "REBUILD=1"/);
  assert.doesNotMatch(restart, /gateway-build-stale/);
});

test("Node code that names a launcher names one that exists", () => {
  const files = ["tools/test-local.mjs", "tools/start-server.mjs", "tools/stop-gateway.mjs", "electron/main.cjs",
    "electron/build.mjs", "src/browser/PatchChainChanged.ts", "src/browser/ui/GmConsole.ts"];
  let named = 0;
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    for (const [match] of text.matchAll(/\d\d [А-Яа-яЁё]+ - [А-Яа-яЁё ()]+?\.bat/g)) {
      assert.ok(scripts.includes(match), `${file} names ${match}`);
      named += 1;
    }
  }
  assert.ok(named >= files.length, "the pattern still finds the names it checks");
});
