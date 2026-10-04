import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

// A ratchet on the browser's own `title` hint (item 4.01). The interface's tooltip replaces it
// (`setTip`, ui/Tooltip.ts) and `NativeAppShell` converts any that is left before the browser can
// show it; this keeps new code from writing more. Each file below may keep at most the number
// recorded for it, a file not listed may keep none, and a slice that converts a file lowers or
// removes its line — the ceiling only goes down.
//
// Excluded: the stock FrameXML DOM (`framexml/`, other lanes; the shell converts its titles at run
// time), the tooltip module itself, and `Panel.title`, the window heading setter in Widgets.ts —
// assignments to a variable named `…panel`/`…Panel` are that setter, not the attribute.
const CEILINGS = new Map([
  // Not in ui/: the patch-chain pill's hint. The shell converts it.
  ["src/browser/PatchChainChanged.ts", 1],
  // The page markup: two HUD hints the shell converts. L7 4.10: the micro buttons' ten went — ui/HudKeys.ts
  // writes their hints from GlobalStrings and the binding table.
  ["index.html", 2],
]);

const root = new URL("../", import.meta.url);
const rootPath = root.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PATTERN = /\.title\s*=(?!=)|setAttribute\(\s*["']title["']|\btitle="/g;
const PANEL_SETTER = /[Pp]anel\.title\s*=(?!=)/g;

function count(text) {
  const all = text.match(PATTERN)?.length ?? 0;
  const panels = text.match(PANEL_SETTER)?.length ?? 0;
  return all - panels;
}

function sources(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      if (name === "framexml") continue;
      found.push(...sources(path));
    } else if (name.endsWith(".ts") && name !== "Tooltip.ts") found.push(path);
  }
  return found;
}

test("4.01 no browser `title` beyond the recorded ceilings", () => {
  const counts = new Map();
  for (const path of sources(join(rootPath, "src", "browser"))) {
    const n = count(readFileSync(path, "utf8"));
    if (n > 0) counts.set(relative(rootPath, path).replaceAll("\\", "/"), n);
  }
  const markup = count(readFileSync(join(rootPath, "index.html"), "utf8"));
  if (markup > 0) counts.set("index.html", markup);
  const over = [...counts].filter(([file, n]) => n > (CEILINGS.get(file) ?? 0));
  assert.deepEqual(over, [], `new browser titles: use setTip (ui/Tooltip.ts) — ${JSON.stringify(over)}`);
});

test("the ratchet sees a title, and does not count the window heading setter", () => {
  assert.equal(count(`button.title = "x";`), 1);
  assert.equal(count(`el.setAttribute("title", text);`), 1);
  assert.equal(count(`<button title="Персонаж (C)">`), 1);
  assert.equal(count(`panel.title = "Банк"; parts.panel.title = name; keyringPanel.title = s;`), 0);
  assert.equal(count(`if (button.title !== label) {}`), 0, "a comparison is not a write");
});
