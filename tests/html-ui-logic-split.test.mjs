// Plan item 4.17, stage 5: the logic the stock interface needs leaves the HTML files. What these pin
// is that it can live without them: stage 6 deletes the windows, and with them every side effect a
// painter had.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isolatedActionBar, isolatedUi } from "./fixtures/isolated-ui.mjs";

const LOGIC = ["SpellTooltip", "SpellData", "SpellCast", "ActionSlots", "ProfessionCraft", "MacroRun", "EquipmentSetUse", "HtmlWindowHosts"];
const HTML = ["Dom", "Widgets", "Slots", "Spellbook", "ActionBar", "Professions", "Macros", "EquipmentSets", "PetSpellbook", "DragGhost"];

test("the moved logic imports none of the page's files, and touches no page", async () => {
  for (const file of LOGIC) {
    const source = await readFile(new URL(`../src/browser/ui/${file}.ts`, import.meta.url), "utf8");
    for (const html of HTML) {
      assert.doesNotMatch(source, new RegExp(`from "\\./${html}\\.js"`), `${file} imports ${html}`);
    }
    assert.doesNotMatch(source, /\bdocument\.|spellStatus/, `${file} touches the page`);
  }
});

test("the staying callers reach the logic, not the windows", async () => {
  const read = (file) => readFile(new URL(`../src/browser/${file}`, import.meta.url), "utf8");
  const [mount, actions, combat, wiring, live, login] = await Promise.all([
    read("framexml/FrameXmlWorldMount.ts"), read("input/Actions.ts"), read("ui/CombatCommands.ts"),
    read("ui/ActionBarAccountWiring.ts"), read("framexml/FrameXmlTradeSkillLive.ts"), read("app/Login.ts"),
  ]);
  for (const [name, source] of Object.entries({ mount, actions, combat, wiring, live, login })) {
    assert.doesNotMatch(source, /from "[^"]*ui\/(Spellbook|ActionBar|Professions)\.js"|from "\.\/(Spellbook|ActionBar|Professions)\.js"/, name);
  }
});

function slotsWorld(buttons) {
  return { actionButtons: buttons, state: {}, knownSpells: [] };
}

test("the rows a stock bar reads are asked for with no painter in the page", async () => {
  const requested = [];
  const loaded = [];
  const world = slotsWorld([
    { slot: 0, action: 133, type: 0 },
    { slot: 1, action: 6948, type: 128 },
    { slot: 2, action: 5, type: 64 },
  ]);
  const game = { world, spells: new Map(), itemMetadata: { load: async (ids) => { loaded.push(...ids); return false; } } };
  const slots = await isolatedUi("ActionSlots", {
    "../game/Context.js": { game },
    "../../world/ActionBarProtocol.js": await import("../dist/code/world/ActionBarProtocol.js"),
    "./SpellNames.js": { ensureSpellNames: (ids) => requested.push(...ids) },
    "./HtmlWindowHosts.js": await isolatedUi("HtmlWindowHosts"),
  });
  slots.refreshActionSlots();
  assert.deepEqual(requested, [133], "the spell slot's row, whatever draws the bar");
  assert.deepEqual(loaded, [6948], "and the item slot's");
});

test("turning the page keeps the page without rows, and redraws them when they exist", async () => {
  const hosts = await isolatedUi("HtmlWindowHosts");
  const slots = await isolatedUi("ActionSlots", {
    "../game/Context.js": { game: { world: slotsWorld([]), spells: new Map() } },
    "../../world/ActionBarProtocol.js": await import("../dist/code/world/ActionBarProtocol.js"),
    "./HtmlWindowHosts.js": hosts,
  });
  slots.turnActionPage(2);
  assert.equal(slots.getActionBarPage(), 3);
  let redraws = 0;
  hosts.setActionBarRedraw(() => { redraws += 1; });
  slots.turnActionPage(1);
  assert.equal(slots.getActionBarPage(), 2);
  assert.equal(redraws, 1);
  slots.turnActionPage(99);
  assert.equal(slots.getActionBarPage(), 6, "clamped to the main pages");
});

test("the fixture's two modules are wired: a page turn reaches the rows", async () => {
  const actionBar = { children: [], append(...children) { this.children.push(...children); },
    parentElement: { insertBefore() {} }, closest: () => null };
  const originalDocument = globalThis.document;
  const element = () => ({ dataset: {}, hidden: false, children: [], append(...children) { this.children.push(...children); } });
  globalThis.document = { createElement: element, getElementById: () => null, documentElement: { style: { setProperty() {} } } };
  try {
    class IconButton {
      root = { dataset: {}, classList: { add() {} }, addEventListener() {} };
      setContent() {} setCooldown() {} setUsable() {}
    }
    const bar = await isolatedActionBar({
      "../game/Context.js": { game: { world: slotsWorld([]), spells: new Map() } },
      "../../world/ActionBarProtocol.js": await import("../dist/code/world/ActionBarProtocol.js"),
      "./Dom.js": { actionBar },
      "./Widgets.js": { IconButton, attachTooltip() {} },
    });
    assert.equal(actionBar.children.length, 0, "built on the first draw");
    bar.turnActionPage(1);
    assert.equal(actionBar.children.length, 12);
  } finally {
    globalThis.document = originalDocument;
  }
});
