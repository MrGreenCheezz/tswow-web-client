import assert from "node:assert/strict";
import test from "node:test";
import { isolatedModule } from "./fixtures/isolated-ui.mjs";

// WORK_PLAN 4.11 (the owner's decision 0.4g of 12.10): the default key layout is the stock one. Every
// action that answers a Bindings.xml command ships exactly the keys the client's DefaultBindings.wtf
// gives that command (generated/stockBindings.ts), this client's own two actions ship unbound, the
// diagnostics window and the window editor sit behind the developer flag, and a table saved before
// the switch takes the new layout only on the rows the player left alone.
const bindings = await import("../dist/code/browser/input/Bindings.js");
const stock = await import("../dist/code/browser/input/StockActions.js");
const { STOCK_DEFAULT_KEYS } = await import("../dist/code/generated/stockBindings.js");
const { FRAMEXML_STOCK_BINDING_SECTIONS, FRAMEXML_WEBCLIENT_BINDING_ROWS } =
  await import("../dist/code/browser/framexml/FrameXmlBinding.js");
const developer = await import("../dist/code/browser/DeveloperMode.js");

const { DEFAULT_BINDINGS, INPUT_ACTIONS, actionFor, bindingsOf, keysOf, useBindingStorage } = bindings;
const STORAGE_KEY = "webclient.keybindings.v1";
const MODULE_STORAGE_KEY = "webclient.keybindings.modules.v1";

/** The rows 4.11 moved, as they shipped before it: what a table saved then holds on an untouched row. */
const OLD_LAYOUT = {
  jump: ["Space", ""],
  openChatSlash: ["Slash", ""],
  setFocus: ["KeyF", ""],
  interact: ["KeyG", ""],
  toggleBags: ["KeyB", ""],
  toggleKeyring: ["Shift+KeyB", ""],
  toggleProfessions: ["KeyJ", ""],
  toggleDiagnostics: ["KeyO", ""],
  toggleFps: ["Ctrl+Shift+KeyF", ""],
  toggleKeyBindings: ["KeyK", ""],
  toggleBackpack: ["", ""],
  assistTarget: ["", ""],
  toggleSocial: ["", ""],
  targetLastHostile: ["", ""],
};

/** Keys a row carries beyond the stock ones, and why. */
const EXTRA_KEYS = {
  // The client names the keypad Enter ENTER too (there is no KEY_NUMPADENTER); the table can hold it apart.
  openChat: ["NumpadEnter"],
};

/** A DefaultBindings.wtf command's keys as this table's chords: no mouse, nothing left off, two at most. */
function stockChords(command) {
  return (STOCK_DEFAULT_KEYS[command] ?? [])
    .filter((key) => stock.STOCK_KEYS_LEFT_OFF[key.toUpperCase()] === undefined)
    .map(stock.clientKeyToChord)
    .filter((chord) => chord !== undefined)
    .slice(0, 2);
}

/**
 * Every way `table` departs from the stock layout, one line each: a stock command's row whose keys are
 * not DefaultBindings.wtf's, a WebClient-only row with a key, a chord on two rows. Empty is the stock layout.
 */
function layoutProblems(table) {
  const problems = [];
  for (const section of FRAMEXML_STOCK_BINDING_SECTIONS) {
    for (const [command, action] of section.rows) {
      const extra = EXTRA_KEYS[action] ?? [];
      const keys = table[action].filter((chord) => chord && !extra.includes(chord));
      const expected = stockChords(command);
      if (JSON.stringify(keys) !== JSON.stringify(expected)) {
        problems.push(`${command} (${action}) ships ${JSON.stringify(keys)}, DefaultBindings.wtf ${JSON.stringify(expected)}`);
      }
    }
  }
  for (const [command, action] of FRAMEXML_WEBCLIENT_BINDING_ROWS) {
    if (table[action].some(Boolean)) problems.push(`${command} (${action}) is this client's own and ships ${JSON.stringify(table[action])}`);
  }
  const seen = new Map();
  for (const { action } of INPUT_ACTIONS) {
    for (const chord of table[action]) {
      if (!chord) continue;
      if (seen.has(chord)) problems.push(`${chord} is on both ${seen.get(chord)} and ${action}`);
      seen.set(chord, action);
    }
  }
  return problems;
}

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  let writes = 0;
  return {
    values,
    get writes() { return writes; },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { writes += 1; values.set(key, String(value)); },
  };
}

/** What `persist` wrote before 4.11: every row, each on the default of the day, and no layout row. */
function savedBefore(changes = {}) {
  const table = {};
  for (const { action } of INPUT_ACTIONS) table[action] = [...(OLD_LAYOUT[action] ?? DEFAULT_BINDINGS[action])];
  return { ...table, ...changes };
}

test.after(() => useBindingStorage(memoryStorage()));

test("every row ships its command's DefaultBindings.wtf keys; this client's own ship unbound", () => {
  assert.deepEqual(layoutProblems(DEFAULT_BINDINGS), []);
  // Spot checks of the keys that moved, so a failure reads as the layout and not as a table.
  const keys = (action) => DEFAULT_BINDINGS[action].filter(Boolean);
  assert.deepEqual(keys("toggleSocial"), ["KeyO"], "O is TOGGLESOCIAL, not diagnostics");
  assert.deepEqual(keys("toggleProfessions"), ["KeyK"], "K is TOGGLECHARACTER1, not the bindings window");
  assert.deepEqual(keys("assistTarget"), ["KeyF"]);
  assert.deepEqual(keys("targetLastHostile"), ["KeyG"]);
  assert.deepEqual(keys("toggleBackpack"), ["KeyB"]);
  assert.deepEqual(keys("toggleBags"), ["Shift+KeyB"], "OPENALLBAGS");
  assert.deepEqual(keys("toggleFps"), ["Ctrl+KeyR"], "TOGGLEFPS");
  assert.deepEqual(keys("jump"), ["Space", "Numpad0"]);
  assert.deepEqual(keys("openChatSlash"), ["Slash", "Period"]);
  for (const action of ["setFocus", "interact", "toggleKeyring", "toggleDiagnostics", "toggleKeyBindings"]) {
    assert.deepEqual(keys(action), [], `${action} ships unbound`);
  }
  assert.deepEqual([...stock.STOCK_DEFAULTS_HELD], [], "no stock row gives its key up to a core action");
});

test("mutation check: the old layout, or any one row of it, is caught", () => {
  // The check run on scratch copies of the table: the real one is not touched.
  const old = layoutProblems({ ...DEFAULT_BINDINGS, ...OLD_LAYOUT });
  for (const action of Object.keys(OLD_LAYOUT)) {
    assert.ok(old.some((line) => line.includes(`(${action})`)), `the old ${action} row is reported`);
  }
  const diagnosticsOnO = layoutProblems({ ...DEFAULT_BINDINGS, toggleDiagnostics: ["KeyO", ""], toggleSocial: ["", ""] });
  assert.deepEqual(diagnosticsOnO.length, 2, diagnosticsOnO.join("\n"));
  assert.match(diagnosticsOnO.join("\n"), /TOGGLESOCIAL \(toggleSocial\) ships \[\]/);
  assert.match(diagnosticsOnO.join("\n"), /WEBCLIENT_TOGGLEDIAGNOSTICS/);
  const bindingsOnK = layoutProblems({ ...DEFAULT_BINDINGS, toggleKeyBindings: ["KeyK", ""], toggleProfessions: ["KeyJ", ""] });
  assert.match(bindingsOnK.join("\n"), /TOGGLECHARACTER1 \(toggleProfessions\) ships \["KeyJ"\]/);
  // A stock key put on a second row is a duplicate even when both rows are otherwise right.
  assert.match(layoutProblems({ ...DEFAULT_BINDINGS, toggleKeyBindings: ["KeyO", ""] }).join("\n"), /KeyO is on both/);
});

test("the developer flag: the address first, both ways, then the browser's remembered value, off otherwise", () => {
  const { developerModeFrom } = developer;
  assert.equal(developerModeFrom(""), false);
  assert.equal(developerModeFrom("?dev=1"), true);
  assert.equal(developerModeFrom("?dev"), true, "a bare flag means yes");
  assert.equal(developerModeFrom("?x=1&dev=on"), true);
  assert.equal(developerModeFrom("", "1"), true, "remembered");
  assert.equal(developerModeFrom("?dev=0", "1"), false, "the address overrides what the browser remembers");
  assert.equal(developerModeFrom("", ""), false);
  assert.equal(developerModeFrom("", "0"), false);
  assert.equal(developerModeFrom("?dev=maybe", "yes"), true, "an unreadable flag leaves it to the remembered value");
  assert.equal(developerModeFrom("?framexml=1"), false);
  assert.deepEqual([...bindings.DEVELOPER_ACTIONS], ["toggleDiagnostics", "toggleGmConsole"]);
  assert.equal(bindings.actionOffered("toggleDiagnostics", false), false);
  assert.equal(bindings.actionOffered("toggleDiagnostics", true), true);
  assert.equal(bindings.actionOffered("toggleKeyBindings", false), true);
  // Outside a browser there is no address and no store: off.
  developer.useDeveloperMode(undefined);
  assert.equal(developer.developerMode(), false);
  assert.equal(bindings.actionOffered("toggleDiagnostics"), false);
});

test("the diagnostics verb answers only with the developer flag; without it the key stays the browser's", async () => {
  let flag = false;
  const calls = [];
  const diagnosticsWindow = { hidden: true };
  const actions = await isolatedModule("browser/input/Actions", {
    "../game/Context.js": { game: { world: {} } },
    "./Bindings.js": bindings,
    "../../world/ActionBarProtocol.js": await import("../dist/code/world/ActionBarProtocol.js"),
    "../DeveloperMode.js": { developerMode: () => flag },
    "../ui/Dom.js": { diagnosticsWindow, chatInput: {}, spellbookWindow: {} },
    "../ui/Windows.js": { toggleGameWindow: (window) => { window.hidden = !window.hidden; calls.push("toggle"); } },
    "../ui/Diagnostics.js": { showUnhandledOpcodes: () => calls.push("refresh") },
    "../ui/GmConsole.js": { toggleGmConsole: () => calls.push("gm") },
  });
  assert.equal(actions.runAction("toggleDiagnostics"), false, "unanswered, so Controls leaves the press alone");
  assert.equal(actions.runAction("toggleGmConsole"), false, "the GM console is behind the same flag");
  assert.equal(diagnosticsWindow.hidden, true);
  assert.deepEqual(calls, []);
  flag = true;
  assert.equal(actions.runAction("toggleDiagnostics"), true);
  assert.equal(diagnosticsWindow.hidden, false, "with the flag it opens as before");
  assert.deepEqual(calls, ["toggle", "refresh"]);
  assert.equal(actions.runAction("toggleGmConsole"), true);
  assert.deepEqual(calls, ["toggle", "refresh", "gm"]);
});

test("a table saved before 4.11 takes the stock layout on every row the player left alone, writing nothing", () => {
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(savedBefore()) });
  useBindingStorage(storage);
  for (const { action } of INPUT_ACTIONS) {
    assert.deepEqual([...bindingsOf(action)], [...DEFAULT_BINDINGS[action]], `${action} is on the stock default`);
  }
  assert.equal(actionFor("KeyO"), "toggleSocial");
  assert.equal(actionFor("KeyK"), "toggleProfessions");
  assert.equal(actionFor("KeyF"), "assistTarget");
  assert.equal(actionFor("KeyG"), "targetLastHostile");
  assert.equal(actionFor("KeyB"), "toggleBackpack");
  assert.equal(actionFor("Shift+KeyB"), "toggleBags");
  assert.equal(actionFor("Ctrl+KeyR"), "toggleFps");
  assert.equal(actionFor("KeyJ"), undefined, "J is free in the stock layout");
  assert.equal(storage.writes, 0, "loading writes nothing back: reading the same table again gives the same keys");
  useBindingStorage(storage);
  assert.equal(actionFor("KeyO"), "toggleSocial");
});

test("a row the player changed before 4.11 is kept whole, and keeps its keys from the new defaults", () => {
  // O moved onto jump (which stole it off diagnostics), the focus on Shift+F, the bags on B's second slot.
  const table = savedBefore({
    jump: ["KeyO", ""], toggleDiagnostics: ["", ""], setFocus: ["Shift+KeyF", ""], toggleBags: ["", "KeyB"],
  });
  useBindingStorage(memoryStorage({
    [STORAGE_KEY]: JSON.stringify(table),
    [MODULE_STORAGE_KEY]: JSON.stringify({ "module:shop:Лавка": ["KeyG", ""] }),
  }));
  assert.deepEqual([...bindingsOf("jump")], ["KeyO", ""], "a choice is not a default");
  assert.deepEqual([...bindingsOf("toggleSocial")], ["", ""], "the stock O yields to the player's jump");
  assert.deepEqual([...bindingsOf("setFocus")], ["Shift+KeyF", ""]);
  assert.deepEqual([...bindingsOf("assistTarget")], ["KeyF", ""], "F was nobody's choice, so it is ASSISTTARGET's");
  assert.deepEqual([...bindingsOf("toggleBags")], ["", "KeyB"], "a key moved to the other slot is a change too");
  assert.deepEqual([...bindingsOf("toggleBackpack")], ["", ""], "and B stays the player's");
  assert.deepEqual([...bindingsOf("targetLastHostile")], ["", ""], "a module row's key is the player's as well");
  assert.deepEqual([...keysOf("module:shop:Лавка")], ["KeyG", ""]);
  assert.deepEqual([...bindingsOf("interact")], ["", ""], "an untouched G row is forgotten, not kept");
});

test("a table saved under the stock layout is read as it stands: an old default chosen again stays", () => {
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(savedBefore()) });
  useBindingStorage(storage);
  // The player wants the focus back on F; the bind takes F off ASSISTTARGET and saves the table.
  bindings.bindAction("setFocus", 0, "KeyF");
  const saved = JSON.parse(storage.values.get(STORAGE_KEY));
  assert.deepEqual(saved.$layout, ["stock", ""], "the save marks the table");
  assert.deepEqual(saved.setFocus, ["KeyF", ""]);
  assert.deepEqual(saved.toggleSocial, ["KeyO", ""], "and carries the new layout with it");
  useBindingStorage(storage);
  assert.equal(actionFor("KeyF"), "setFocus", "the next load keeps the choice rather than forgetting it as a default");
  assert.deepEqual([...bindingsOf("assistTarget")], ["", ""]);
  // «Вернуть стандартные» marks the table too.
  bindings.resetBindings();
  assert.deepEqual(JSON.parse(storage.values.get(STORAGE_KEY)).$layout, ["stock", ""]);
  assert.equal(actionFor("KeyF"), "assistTarget");
});

test("the account copy carries the mark, and a copy without it is read as saved before 4.11", () => {
  useBindingStorage(memoryStorage());
  assert.deepEqual(bindings.bindingTables().core.$layout, ["stock", ""]);
  bindings.applyBindingTables(savedBefore({ setFocus: ["Shift+KeyF", ""] }), {});
  assert.equal(actionFor("KeyO"), "toggleSocial");
  assert.deepEqual([...bindingsOf("setFocus")], ["Shift+KeyF", ""]);
  bindings.applyBindingTables({ ...savedBefore(), $layout: ["stock", ""] }, {});
  assert.equal(actionFor("KeyO"), "toggleDiagnostics", "a marked copy holding O on diagnostics is a choice");
  assert.deepEqual([...bindingsOf("toggleSocial")], ["", ""]);
});
