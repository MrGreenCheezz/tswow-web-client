// Plan item 4.17, stage 5: the logic the stock interface needs leaves the HTML files. What these pin
// is that it can live without them: stage 6 deletes the windows, and with them every side effect a
// painter had.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import test from "node:test";
import { isolatedActionBar, isolatedUi } from "./fixtures/isolated-ui.mjs";

const LOGIC = ["SpellTooltip", "SpellData", "SpellCast", "ActionSlots", "ProfessionCraft", "MacroRun", "EquipmentSetUse", "HtmlWindowHosts"];
const SPLIT = ["UnitModels", "UnitNames", "CombatHistory", "QuestLogData"];
const HTML = ["Dom", "Widgets", "Slots", "Spellbook", "ActionBar", "Professions", "Macros", "EquipmentSets", "PetSpellbook", "DragGhost",
  "SettingsWindow", "Minimap", "ChatDock", "QuestLog", "Frames"];

test("the moved logic imports none of the page's files, and touches no page", async () => {
  for (const file of [...LOGIC, ...SPLIT]) {
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

/** The modules a file's evaluation runs, `import type` aside. */
async function valueImports(path, seen = new Set()) {
  if (seen.has(path)) return seen;
  seen.add(path);
  const source = await readFile(new URL(`../src/browser/${path}.ts`, import.meta.url), "utf8").catch(() => "");
  for (const [, target] of source.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)\.js"/gm)) {
    await valueImports(normalize(join(dirname(path), target)).replaceAll("\\", "/"), seen);
  }
  return seen;
}

test("nothing the logic evaluates is a window: a module can be the first import", async () => {
  const windows = ["Widgets", "Slots", "Spellbook", "ActionBar", "Professions", "Macros", "EquipmentSets",
    "PetSpellbook", "DragGhost", "SettingsWindow", "Minimap", "ChatDock", "QuestLog", "Frames", "Windows"];
  for (const file of [...LOGIC, ...SPLIT, "Settings", "Chat"]) {
    const reached = await valueImports(`ui/${file}`);
    for (const html of windows) assert.equal(reached.has(`ui/${html}`), false, `${file} reaches ${html}`);
  }
  const reached = await valueImports("ui/Settings");
  assert.equal(reached.has("ui/Dom"), true, "the FPS counter's parent, the one element it still reaches");
  const counter = await readFile(new URL("../src/browser/ui/FpsCounter.ts", import.meta.url), "utf8");
  assert.match(counter, /import \{ worldPanel \} from "\.\/Dom\.js"/);
});

test("the callers that outlive the windows take the split modules", async () => {
  const read = (file) => readFile(new URL(`../src/browser/${file}`, import.meta.url), "utf8");
  const [loop, dressUp, overlay, plates, gm] = await Promise.all([
    read("game/Loop.ts"), read("framexml/FrameXmlDressUpLive.ts"), read("ui/HeadOverlay.ts"), read("ui/NamePlates.ts"),
    read("ui/GmConsole.ts"),
  ]);
  for (const [name, source] of Object.entries({ loop, dressUp, overlay, plates, gm })) {
    assert.doesNotMatch(source, /from "[^"]*(ui\/|\.\/)(Frames|QuestLog|ChatDock|SettingsWindow)\.js"/, name);
  }
});

test("a combat line reaches its listeners with no dock, and a failing one stops nobody", async () => {
  const history = await isolatedUi("CombatHistory", {
    "./CombatLogModel.js": await import("../dist/code/browser/ui/CombatLogModel.js"),
  });
  const line = { at: 1, text: "удар", kind: "dealt", casterGuid: 1n, targetGuid: 2n, spellId: 0 };
  const heard = [];
  const warn = console.warn;
  console.warn = () => {};
  try {
    const stopFailing = history.onCombatEntry(() => { throw new Error("mirror"); });
    const stop = history.onCombatEntry((entry) => heard.push(entry.text));
    history.recordCombatEntry(line);
    assert.deepEqual(heard, ["удар"]);
    assert.equal(history.combatHistory().length, 1);
    stop();
    stopFailing();
    history.recordCombatEntry(line);
    assert.deepEqual(heard, ["удар"]);
    assert.equal(history.combatHistory().length, 2, "history keeps what no one is listening to");
    history.resetCombatHistory();
    assert.equal(history.combatHistory().length, 0);
  } finally {
    console.warn = warn;
  }
});

test("the quest data asks the server with no window, and tells one when it exists", async () => {
  const hosts = await isolatedUi("HtmlWindowHosts");
  const asked = [];
  const pois = [];
  const listeners = new Map();
  const on = (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); };
  const world = {
    events: { on },
    state: { selfGuid: 1n, objects: new Map([[1n, {}]]) },
    questTemplates: new Map(), questPoi: new Map(),
    queryQuest: (id) => asked.push(id),
    requestQuestPoi: (ids) => pois.push(ids),
  };
  const game = { world };
  const data = await isolatedUi("QuestLogData", {
    "../game/Context.js": { game },
    "./HtmlWindowHosts.js": hosts,
    "../../world/Fields.js": { player: { quests: () => [] } },
    "../../world/QuestProtocol.js": {
      buildQuestLogView: () => [{ questId: 7, objectives: [] }],
      buildCarriedItemCounts: () => new Map(),
    },
    "../Inventory.js": { playerInventory: () => undefined },
  });
  data.bindQuestLogStore({ events: { on } }, world);
  listeners.get("PLAYER_QUEST_LOG_UPDATE")({ guid: 1n });
  assert.deepEqual(asked, [7], "the template, with nothing on the page");
  assert.deepEqual(pois, [[7]], "and where it wants the player to go");
  listeners.get("PLAYER_QUEST_LOG_UPDATE")({ guid: 1n });
  assert.deepEqual(pois, [[7]], "the same set of quests is not asked for twice");

  const told = [];
  hosts.setQuestLogWindows({
    changed: () => told.push("changed"),
    objectivesChanged: () => told.push("objectives"),
    cleared: () => told.push("cleared"),
  });
  listeners.get("PLAYER_QUEST_LOG_UPDATE")({ guid: 1n });
  assert.deepEqual(told, ["changed"]);
  data.clearQuestLog();
  assert.deepEqual(told, ["changed", "cleared"]);
  assert.equal(listeners.size, 0, "the character's bindings go with it");
  data.requestQuestPoi();
  assert.deepEqual(pois, [[7], [7]], "and so does the memory of what was asked");
});

test("the chat commands work with no dock, and reach one while it exists", async () => {
  const hosts = await isolatedUi("HtmlWindowHosts");
  const roster = [];
  const game = { world: undefined };
  const chat = await isolatedUi("Chat", {
    "../game/Context.js": { game },
    "./HtmlWindowHosts.js": hosts,
    "../framexml/FrameXmlFriendsController.js": {
      toggleFrameXmlFriendsChannel: (typed, fallback) => { roster.push([typed, fallback]); return true; },
    },
    "../../world/ChatProtocol.js": { useLearnedRaceLanguages() {} },
  });
  chat.systemLine("никуда");

  // In a world a line goes to the backlog and the event the stock chat reads, dock or no dock.
  const pushed = [];
  game.world = { pushLocalMessage: (message) => pushed.push(message.text) };
  chat.runNativeCommand("roster", "");
  assert.deepEqual(roster.at(-1), [undefined, undefined], "/roster with nothing typed and no dock opens no named channel");
  chat.runNativeCommand("tab", "Бой");
  assert.deepEqual(pushed, ["Нет вкладки «Бой»"]);

  const lines = [];
  const tabs = [];
  hosts.setChatDockHost({
    append: (message) => lines.push(message.text),
    selectTab: (name) => { tabs.push(name); return true; },
    activeChannel: () => "Торговля",
  });
  chat.runNativeCommand("roster", "");
  assert.deepEqual(roster.at(-1), [undefined, "Торговля"]);
  chat.runNativeCommand("tab", "Бой");
  assert.deepEqual(tabs, ["Бой"]);
  assert.equal(pushed.length, 1, "the tab was found: nothing to say");
  game.world = undefined;
  chat.systemLine("в док");
  assert.deepEqual(lines, ["в док"]);
});

test("the applied settings reach the renderer and the listeners, and no window is needed", async () => {
  const source = await readFile(new URL("../src/browser/ui/Settings.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bpanel\b|drawSettings|createElement/, "the window went to SettingsWindow.ts");
  const read = (file) => readFile(new URL(`../src/browser/ui/${file}.ts`, import.meta.url), "utf8");
  assert.match(await read("Minimap"), /watchSettingsApplied\(\(\) => \{ setMinimapRotation\(settingOn\("minimapRotate"\)\); \}\)/);
  assert.match(await read("Spellbook"), /watchSettingsApplied\(\(\) => \{ setSpellbookRankFilter\(settingOn\("spellbookHideLowerRanks"\)\); \}\)/);
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
