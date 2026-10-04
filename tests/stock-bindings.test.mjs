import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// The stock command table (WORK_PLAN 3.11 slice 0, М-A5-3): the generator's two parsers over a
// hand-written sample in the client's formats, the tracked table against the client when one is
// configured, and the defaults the stock rows of `input/StockActions.ts` ship.
import {
  parseBindingsXml, parseDefaultBindings, renderStockBindings,
} from "../tools/generate-stock-bindings.mjs";
import { STOCK_BINDING_COMMANDS, STOCK_DEFAULT_KEYS } from "../dist/code/generated/stockBindings.js";
import {
  STOCK_ACTIONS, STOCK_DEFAULTS_HELD, clientKeyToChord, stockDefaultBindings, withStockRows,
} from "../dist/code/browser/input/StockActions.js";
import { DEFAULT_BINDINGS, INPUT_ACTIONS } from "../dist/code/browser/input/Bindings.js";
import { frameXmlKeyToChord } from "../dist/code/browser/framexml/FrameXmlBinding.js";

// A sample in the two formats, written for this test (not a copy of the client's files).
const SAMPLE_XML = `<Bindings>
\t<Binding name="MOVEFORWARD" runOnUp="true" header="MOVEMENT">\r\n\t\tMoveForwardStart();\r\n\t</Binding>
\t<Binding name="TOGGLESHEATH">\r\n\t\tToggleSheath();\r\n\t</Binding>
\t<Binding name="TARGETPARTYMEMBER1" header="TARGETING">x</Binding>
\t<Binding name="TOGGLESTATS" hidden="true" debug="true">x</Binding>
\t<Binding name="ITUNES_PLAYPAUSE" header="ITUNES_REMOTE" platform="mac">x</Binding>
\t<ModifiedClick action="SELFCAST" default="ALT"/>
</Bindings>`;
const SAMPLE_WTF = "bind W MOVEFORWARD\r\nbind UP MOVEFORWARD\r\nbind Z TOGGLESHEATH\r\n# not a bind line\r\nbind F2 TARGETPARTYMEMBER1\r\n";

test("the generator reads commands, sections and flags from Bindings.xml, and keys from DefaultBindings.wtf", () => {
  const commands = parseBindingsXml(SAMPLE_XML);
  assert.deepEqual(commands.map((command) => [command.name, command.header]), [
    ["MOVEFORWARD", "MOVEMENT"], ["TOGGLESHEATH", "MOVEMENT"], ["TARGETPARTYMEMBER1", "TARGETING"],
    ["TOGGLESTATS", "TARGETING"], ["ITUNES_PLAYPAUSE", "ITUNES_REMOTE"],
  ], "a header carries over to the rows after it; <ModifiedClick> is not a command");
  assert.equal(commands[0].runOnUp, true);
  assert.equal(commands[3].hidden && commands[3].debug, true);
  assert.equal(commands[4].platform, "mac");
  const keys = parseDefaultBindings(SAMPLE_WTF);
  assert.deepEqual([...keys], [["MOVEFORWARD", ["W", "UP"]], ["TOGGLESHEATH", ["Z"]], ["TARGETPARTYMEMBER1", ["F2"]]]);
  const rendered = renderStockBindings(commands, keys);
  assert.match(rendered, /\{ name: "TOGGLESHEATH", header: "MOVEMENT", runOnUp: false, hidden: false, debug: false \}/);
  assert.match(rendered, /"MOVEFORWARD": \["W", "UP"\]/);
  assert.doesNotMatch(rendered, /ToggleSheath\(\)/, "no Lua body reaches the tracked table");
});

test("the tracked table is what the generator makes from the configured client", async (t) => {
  let paths;
  try {
    paths = await import("../tools/paths.mjs");
    paths.interfaceDirectory();
    paths.sourceClientDirectory();
  } catch {
    t.skip("no dataset or client configured");
    return;
  }
  const xmlPath = join(paths.interfaceDirectory(), "FrameXML", "Bindings.xml");
  const locale = process.env.CLIENT_LOCALE ?? "ruRU";
  const wtfPath = join(paths.sourceClientDirectory(), "Data", locale, "WTF", "DefaultBindings.wtf");
  if (!existsSync(xmlPath) || !existsSync(wtfPath)) {
    t.skip("Bindings.xml or DefaultBindings.wtf missing");
    return;
  }
  const rendered = renderStockBindings(parseBindingsXml(readFileSync(xmlPath, "utf8")),
    parseDefaultBindings(readFileSync(wtfPath, "utf8")));
  const tracked = readFileSync(new URL("../src/generated/stockBindings.ts", import.meta.url), "utf8");
  assert.equal(tracked, rendered, "run node tools/generate-stock-bindings.mjs");
});

test("the client's own keys: F2 party 1, F8 the fourth bag, Z the sheath, Print Screen the screenshot", () => {
  assert.equal(STOCK_BINDING_COMMANDS.length, 275);
  assert.deepEqual(STOCK_DEFAULT_KEYS.TARGETPARTYMEMBER1, ["F2"]);
  assert.deepEqual(STOCK_DEFAULT_KEYS.TOGGLEBAG1, ["F8"]);
  assert.deepEqual(STOCK_DEFAULT_KEYS.TOGGLESHEATH, ["Z"]);
  assert.deepEqual(STOCK_DEFAULT_KEYS.SCREENSHOT, ["PRINTSCREEN"]);
  assert.deepEqual(STOCK_DEFAULT_KEYS.TOGGLEBACKPACK, ["B", "F12"]);
  assert.equal(STOCK_DEFAULT_KEYS.TOGGLEACHIEVEMENT, undefined, "no Y: the achievements key is a retail habit");
});

test("a client key reads as the same chord here as in the FrameXML binding API", () => {
  for (const keys of Object.values(STOCK_DEFAULT_KEYS)) {
    for (const key of keys) assert.equal(clientKeyToChord(key), frameXmlKeyToChord(key === "ESCAPE" ? "" : key), key);
  }
  assert.equal(clientKeyToChord("CTRL-SHIFT-TAB"), "Ctrl+Shift+Tab");
  assert.equal(clientKeyToChord("SHIFT--"), "Shift+Minus");
  assert.equal(clientKeyToChord("NUMPADPLUS"), "NumpadAdd");
  assert.equal(clientKeyToChord("BUTTON4"), undefined);
  assert.equal(clientKeyToChord("SHIFT-MOUSEWHEELUP"), undefined);
});

test("the stock rows ship the stock keys, never a core key, never F12, never a key twice", () => {
  const keys = (action) => DEFAULT_BINDINGS[action].filter(Boolean);
  assert.deepEqual(keys("toggleSheath"), ["KeyZ"]);
  assert.deepEqual(keys("targetPartyMember1"), ["F2"]);
  assert.deepEqual(keys("targetPartyPet4"), ["Shift+F5"]);
  assert.deepEqual(keys("targetPet"), ["Shift+F1"]);
  assert.deepEqual(keys("toggleBag1"), ["F8"]);
  assert.deepEqual(keys("toggleBag4"), ["F11"]);
  assert.deepEqual(keys("toggleReputation"), ["KeyU"]);
  assert.deepEqual(keys("friendNamePlates"), ["Shift+KeyV"]);
  assert.deepEqual(keys("allNamePlates"), ["Ctrl+KeyV"]);
  assert.deepEqual(keys("previousActionPage"), ["Shift+ArrowUp"]);
  assert.deepEqual(keys("minimapZoomIn"), ["NumpadAdd"]);
  assert.deepEqual(keys("bonusAction10"), ["Ctrl+Digit0"]);
  assert.deepEqual(keys("shapeshift1"), ["Ctrl+F1"]);
  assert.deepEqual(keys("toggleWorldStateScores"), ["Shift+Space"]);
  // Held by a core action until decision 0.4g (WORK_PLAN 4.11): the core action keeps the key.
  assert.deepEqual(keys("toggleBackpack"), [], "B is the all-bags key here, F12 the developer tools'");
  assert.equal(STOCK_DEFAULTS_HELD.get("TOGGLEBACKPACK"), "KeyB");
  assert.equal(STOCK_DEFAULTS_HELD.get("ASSISTTARGET"), "KeyF");
  assert.equal(STOCK_DEFAULTS_HELD.get("TOGGLESOCIAL"), "KeyO");
  assert.deepEqual(keys("assistTarget"), []);
  assert.deepEqual(keys("toggleSocial"), []);
  // Unbound in the client too.
  assert.deepEqual(keys("stopCasting"), []);
  assert.deepEqual(keys("targetFocus"), []);
  const seen = new Map();
  for (const { action } of INPUT_ACTIONS) {
    for (const chord of DEFAULT_BINDINGS[action]) {
      if (!chord) continue;
      assert.equal(seen.get(chord), undefined, `${chord} on ${seen.get(chord)} and ${action}`);
      seen.set(chord, action);
    }
  }
  // Every stock row names a real command.
  const names = new Set(STOCK_BINDING_COMMANDS.map((command) => command.name));
  for (const row of STOCK_ACTIONS) assert.ok(names.has(row.command), row.command);
  // A taken chord moves the stock key off, and is recorded.
  const taken = stockDefaultBindings(new Set(["KeyZ"]));
  assert.deepEqual([...taken.toggleSheath], ["", ""]);
  assert.equal(STOCK_DEFAULTS_HELD.get("TOGGLESHEATH"), "KeyZ");
  stockDefaultBindings(new Set(Object.values(DEFAULT_BINDINGS).flat().filter(Boolean)
    .filter((chord) => !STOCK_ACTIONS.some((row) => DEFAULT_BINDINGS[row.action].includes(chord)))));
});

test("the stock rows join their own Bindings.xml sections, in the file's order", () => {
  const sections = withStockRows([
    { header: "MOVEMENT", rows: [["MOVEFORWARD", "moveForward"], ["JUMP", "jump"]] },
    { header: "CAMERA", rows: [] },
  ], [{ command: "TOGGLESHEATH", action: "toggleSheath" }, { command: "TARGETPARTYMEMBER1", action: "targetPartyMember1" }]);
  assert.deepEqual(sections[0].rows.map(([command]) => command), ["MOVEFORWARD", "JUMP", "TOGGLESHEATH"]);
  assert.deepEqual(sections[1].rows, [], "a row whose section is not listed is left out");
});
