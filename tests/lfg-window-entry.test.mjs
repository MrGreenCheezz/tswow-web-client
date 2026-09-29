import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("native LFG window has discoverable entries outside the FrameXML microbutton", async () => {
  const [html, dom, windows, menu, chat, css] = await Promise.all([
    source("index.html"),
    source("src/browser/ui/Dom.ts"),
    source("src/browser/ui/Windows.ts"),
    source("src/browser/ui/GameMenu.ts"),
    source("src/browser/ui/Chat.ts"),
    source("src/browser/style.css"),
  ]);

  assert.match(html, /id="lfg-toggle"[^>]*aria-label="Поиск подземелий"/);
  const toggle = html.match(/<button[^>]*id="lfg-toggle"[^>]*>.*?<\/button>/s)?.[0] ?? "";
  assert.ok(toggle, "the dungeon finder toggle exists");
  assert.doesNotMatch(toggle, /micro-button-glyph/,
    "the stock LFG plate comes from the client art, not a glyph fallback");
  assert.match(dom, /element<HTMLButtonElement>\("lfg-toggle"\)/);
  assert.match(windows, /lfgToggle\.addEventListener\("click",\s*\(\) => toggleLfgWindow\(\)\)/);
  assert.match(menu, /menuButton\("Поиск подземелий", \(\) => \{ panel\.hide\(\); toggleLfgWindow\(\); \}\)/);
  assert.match(chat, /names: \["lfg"\]/);
  assert.match(chat, /run\(\) \{ toggleLfgWindow\(\); \}/);
  assert.doesNotMatch(chat, /lfgWindow\.hidden = false/, "the slash command must go through the toggle so the catalog renders");
  assert.match(windows, /\{ isOpen: lfgWindowOpen, close: closeLfgWindow \}/);
  assert.match(css, /#lfg-toggle/);
});

test("the HUD micro-button row fits all ten buttons in one row", async () => {
  const [css, skin] = await Promise.all([
    source("src/browser/style.css"),
    source("src/browser/ui/NativeUiSkin.ts"),
  ]);
  assert.match(css, /#game-buttons \{\s*[^}]*grid-template-columns:\s*repeat\(10,\s*24px\)/s,
    "character, bags, spellbook, talents, quest, socials, map, calendar, dungeon finder and menu share one row");
  assert.match(skin, /"--wow-micro-lfg":\s*"Interface\\\\Buttons\\\\UI-MicroButton-LFG-Up\.blp"/,
    "the dungeon finder plate is the stock micro-button art named by LoadMicroButtonTextures");
  assert.match(css, /#lfg-toggle \{\s*background-image:\s*var\(--wow-micro-lfg/s,
    "the button paints that plate over the bevel fallback");
});
