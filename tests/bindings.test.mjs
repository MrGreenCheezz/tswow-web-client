import assert from "node:assert/strict";
import { ACTION_BUTTONS_PER_PAGE, EXTRA_ACTION_BARS, actionPage } from "../dist/code/world/ActionBarProtocol.js";
import test from "node:test";
import {
  ACTION_BAR_PAGES, ACTION_BAR_SLOTS, DEFAULT_BINDINGS, HELD_ACTIONS, INPUT_ACTIONS, actionFor,
  addModuleAction, bindAction, bindKey, bindingsOf, chordOf, describeChord, keysOf, loadBindings,
  moduleActionFor, moduleActions, removeModuleActions, resetBindings, strafeInsteadOfTurn,
  useBindingStorage, EXTRA_ACTION_BAR_SLOTS } from "../dist/code/browser/input/Bindings.js";
import {
  STOCK_ACTIONS, STOCK_DEFAULTS_HELD, STOCK_KEYS_LEFT_OFF, clientKeyToChord,
} from "../dist/code/browser/input/StockActions.js";
import { STOCK_DEFAULT_KEYS } from "../dist/code/generated/stockBindings.js";

const STOCK_ROWS = new Map(STOCK_ACTIONS.map((row) => [row.action, row]));

/** A store the size of the one fact it holds, so the table can be saved and read back without a browser. */
function fakeStorage(seed) {
  const values = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    read: (key) => values.get(key),
  };
}

const STORAGE_KEY = "webclient.keybindings.v1";

test.beforeEach(() => {
  useBindingStorage(fakeStorage());
});

test("a chord spells its modifiers in one order, and a modifier alone spells nothing", () => {
  assert.equal(chordOf({ code: "KeyW" }), "KeyW");
  assert.equal(chordOf({ code: "Digit1", shiftKey: true }), "Shift+Digit1");
  assert.equal(chordOf({ code: "KeyA", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+KeyA");
  // Order is fixed rather than the order the flags happen to be read in, so the same press cannot
  // spell itself two ways and end up bound twice.
  assert.equal(chordOf({ code: "KeyA", shiftKey: true, ctrlKey: true }), "Ctrl+Shift+KeyA");
  // Shift held on its way to a real key must not resolve to an action of its own, and must not be
  // bindable to one either.
  assert.equal(chordOf({ code: "ShiftLeft", shiftKey: true }), "");
  assert.equal(chordOf({ code: "ControlRight", ctrlKey: true }), "");
});

test("every action ships with a key, and no two ship with the same one", () => {
  const seen = new Map();
  for (const { action, group, label } of INPUT_ACTIONS) {
    const pair = DEFAULT_BINDINGS[action];
    assert.ok(pair, `${action} is listed but has no default binding`);
    // The rule is narrowed here on purpose, and only here. It exists because an action nobody can
    // press is a feature nobody has, and it still holds for every action that is on screen by
    // default. The four extra action bars are not: each is behind its own switch, off, and its
    // twelve slots are pressable with the mouse the moment it is switched on. Requiring a chord
    // for all forty-eight would mean inventing forty-eight bindings the player did not ask for,
    // on a keyboard that does not have them free — and the original client binds none of them
    // either. Measured, for honesty: its own `Bindings.xml` carries no `default` attribute on any
    // of its 275 bindings, so it settles nothing on its own; what settles it is that these keys
    // are conventionally the player's to choose.
    // The stock rows of 3.11 ship exactly the keys DefaultBindings.wtf gives their command, less a
    // mouse button, a key left off on purpose and a chord a core action ships on (decision 0.4g);
    // a stock command the file gives no key ships unbound, as it does in the original.
    const stock = STOCK_ROWS.get(action);
    if (stock) {
      const expected = (STOCK_DEFAULT_KEYS[stock.command] ?? [])
        .filter((key) => STOCK_KEYS_LEFT_OFF[key] === undefined)
        .map(clientKeyToChord)
        .filter((chord) => chord !== undefined && STOCK_DEFAULTS_HELD.get(stock.command) !== chord);
      assert.deepEqual(pair.filter(Boolean), expected.slice(0, 2), `${action} ships ${stock.command}'s stock keys`);
      for (const chord of pair) {
        if (!chord) continue;
        assert.equal(seen.get(chord), undefined, `${chord} is on both ${seen.get(chord)} and ${action}`);
        seen.set(chord, action);
      }
      continue;
    }
    if (group.startsWith("Панель: ")) {
      assert.equal(pair[0], "", `${label} is on an optional bar and should ship unbound`);
      continue;
    }
    assert.ok(pair[0], `${label} ships unbound, so a new player cannot reach it`);
    for (const chord of pair) {
      if (!chord) continue;
      assert.equal(seen.get(chord), undefined, `${chord} is on both ${seen.get(chord)} and ${action}`);
      seen.set(chord, action);
    }
  }
  // The count is the claim slice U1 makes: about forty-five actions against the eleven there were.
  assert.ok(INPUT_ACTIONS.length >= 40, `only ${INPUT_ACTIONS.length} actions`);
});

test("a key resolves to the action that holds it, and to nothing when it holds none", () => {
  assert.equal(actionFor("KeyW"), "moveForward");
  assert.equal(actionFor("ArrowUp"), "moveForward", "the secondary key reaches the same action");
  assert.equal(actionFor("Shift+Digit1"), "actionPage1");
  assert.equal(actionFor("Digit1"), "action1", "the modifier is part of the chord, not decoration");
  // Z is the stock TOGGLESHEATH key (DefaultBindings.wtf), the first of the 3.11 rows; Y holds nothing.
  assert.equal(actionFor("KeyZ"), "toggleSheath");
  assert.equal(actionFor("KeyY"), undefined);
  assert.equal(actionFor(""), undefined);
});

test("binding a key takes it off whatever held it", () => {
  bindAction("jump", 0, "KeyW");
  assert.equal(actionFor("KeyW"), "jump");
  assert.deepEqual([...bindingsOf("moveForward")], ["", "ArrowUp"],
    "the key was stolen, so moving forward is left with only its second key");
  assert.deepEqual([...bindingsOf("jump")], ["KeyW", ""]);
});

test("a binding can be taken away, and the action keeps its other key", () => {
  bindAction("moveForward", 0, "");
  assert.equal(actionFor("KeyW"), undefined);
  assert.equal(actionFor("ArrowUp"), "moveForward");
});

test("the table is saved, and a saved table is read over the defaults rather than instead of them", () => {
  const storage = fakeStorage();
  useBindingStorage(storage);
  bindAction("jump", 0, "KeyZ");
  assert.ok(storage.read(STORAGE_KEY), "the change was never written down");

  // A table saved before an action existed: everything it does not mention has to keep its
  // default, or a player loses keys by upgrading.
  useBindingStorage(fakeStorage({ [STORAGE_KEY]: JSON.stringify({ jump: ["KeyZ", ""] }) }));
  assert.equal(actionFor("KeyZ"), "jump");
  assert.equal(actionFor("KeyW"), "moveForward");
  assert.equal(actionFor("Space"), undefined, "jump moved off space, and nothing else took it");
});

test("a table that is not a table at all leaves the defaults standing", () => {
  useBindingStorage(fakeStorage({ [STORAGE_KEY]: "{" }));
  assert.equal(actionFor("KeyW"), "moveForward");
  useBindingStorage(fakeStorage({ [STORAGE_KEY]: JSON.stringify({ jump: "KeyZ", moveForward: 7 }) }));
  assert.equal(actionFor("Space"), "jump", "a binding that is not a pair is ignored, not obeyed");
  assert.equal(actionFor("KeyW"), "moveForward");
});

test("resetting puts every key back", () => {
  bindAction("jump", 0, "KeyW");
  resetBindings();
  assert.equal(actionFor("KeyW"), "moveForward");
  assert.equal(actionFor("Space"), "jump");
});

test("with no storage at all the table still works, it just does not survive a reload", () => {
  useBindingStorage(undefined);
  assert.equal(actionFor("KeyW"), "moveForward");
  bindAction("jump", 0, "KeyZ");
  assert.equal(actionFor("KeyZ"), "jump");
  loadBindings();
  assert.equal(actionFor("KeyZ"), "toggleSheath", "the reload brought the default back");
});

test("shift turns a turn into a strafe and leaves every other action alone", () => {
  assert.equal(strafeInsteadOfTurn("turnLeft"), "strafeLeft");
  assert.equal(strafeInsteadOfTurn("turnRight"), "strafeRight");
  assert.equal(strafeInsteadOfTurn("moveForward"), "moveForward");
  assert.equal(strafeInsteadOfTurn("action1"), "action1");
  // Held means the physics reads the key while it is down; a released `B` must not stop the
  // character. Jump and sit are held as well as pressed: each is one thing tapped on the ground
  // and another held in water or in the air.
  assert.deepEqual([...HELD_ACTIONS].sort(),
    ["jump", "moveBackward", "moveForward", "pitchDown", "pitchUp", "sitOrStand", "strafeLeft", "strafeRight",
      "turnLeft", "turnRight",
      "vehicleAimDown", "vehicleAimUp", // 11.02-input: VEHICLEAIMUP/DOWN (runOnUp) — the pitch keys themselves
    ]);
});

test("the action bar lists exactly the slots and pages that exist", () => {
  assert.equal(ACTION_BAR_SLOTS.length, 12);
  assert.equal(ACTION_BAR_PAGES.length, 6);
  const named = new Set(INPUT_ACTIONS.map((entry) => entry.action));
  for (const action of [...ACTION_BAR_SLOTS, ...ACTION_BAR_PAGES]) {
    assert.ok(named.has(action), `${action} is on the bar but not in the table`);
  }
});

test("a chord is written the way a player reads it", () => {
  assert.equal(describeChord("KeyW"), "W");
  assert.equal(describeChord("Digit1"), "1");
  assert.equal(describeChord("Shift+Digit1"), "Shift+1");
  assert.equal(describeChord("Space"), "Пробел");
  assert.equal(describeChord("NumpadEnter"), "Num Enter");
  assert.equal(describeChord("ArrowUp"), "↑");
  assert.equal(describeChord(""), "—", "an unbound slot says so rather than being blank");
});

test("the four extra bars address as fixed pages of the same 144 slots", () => {
  // The server keeps 144 buttons as twelve rows of twelve and the paging keys walk the first six, so
  // an extra bar needed no new addressing: it is a row pinned to a page. L7 4.16b: the native rows
  // stand on stock's multi-bar pages 6, 5, 3 and 4 (MultiActionBars.xml:41, 159, 277, 395) — the
  // stock HUD's keys press the same slots — and pages 7–10 are left to the stance and form bars.
  assert.deepEqual(EXTRA_ACTION_BARS.map((bar) => bar.base), [60, 48, 24, 36]);
  assert.deepEqual(EXTRA_ACTION_BARS.map((bar) => bar.stockBase), [60, 48, 24, 36]);
  assert.deepEqual(EXTRA_ACTION_BARS.map((bar) => bar.legacyBase), [72, 84, 96, 108], "only the one-time move reads these");
  for (const bar of EXTRA_ACTION_BARS) {
    assert.equal(bar.base % ACTION_BUTTONS_PER_PAGE, 0, `${bar.id} does not start a row`);
    assert.equal(actionPage(bar.base), bar.base / ACTION_BUTTONS_PER_PAGE);
    // Twelve slots each, and every one of them offered in the bindings window.
    const slots = EXTRA_ACTION_BAR_SLOTS[bar.id];
    assert.equal(slots.length, ACTION_BUTTONS_PER_PAGE);
    for (const action of slots) {
      assert.ok(INPUT_ACTIONS.some((entry) => entry.action === action), `${action} is not offered`);
    }
  }
  // As in stock, each bar is one of the six main pages (the paging keys skip it while it is shown),
  // the four are distinct, and none reaches the bonus pages 7–12 of stances, forms and possession.
  const pages = EXTRA_ACTION_BARS.map((bar) => actionPage(bar.base));
  assert.deepEqual(pages, [5, 4, 2, 3]);
  assert.equal(new Set(pages).size, 4, "no two bars share a page");
  for (const page of pages) assert.ok(page >= 1 && page < 6, `page ${page + 1} is a main page other than the first`);
});

/* ---------------------------------------------------------------------------------------------
 * Actions a module offers — М6
 * ------------------------------------------------------------------------------------------- */

const moduleAction = (module, label, run = () => {}) => ({
  action: `module:${module}:${label}`, module, group: "Модули", label, run,
});

test("a module action is offered unbound, so the invariant above stays honest", () => {
  const pressed = [];
  addModuleAction(moduleAction("shop", "Лавка", () => pressed.push("shop")));
  try {
    // Unbound is the whole point: a definition file names a key it would *like*, and a module that
    // could bind itself would take a key off the player on the login after it was installed. The
    // invariant two tests up — every action ships with a key, and no two ship with the same one —
    // is only honest about the actions this client compiles in, which is why these live in their
    // own table and are not in `INPUT_ACTIONS` at all.
    assert.deepEqual([...keysOf("module:shop:Лавка")], ["", ""]);
    assert.equal(INPUT_ACTIONS.some((entry) => entry.action.startsWith("module:")), false);
    assert.equal(moduleActions().length, 1);
    assert.equal(moduleActions()[0].group, "Модули");
  } finally {
    removeModuleActions("shop");
  }
});

test("a module action can be bound, answers its key, and gives it back when the module unloads", () => {
  const storage = fakeStorage();
  useBindingStorage(storage);
  const pressed = [];
  addModuleAction(moduleAction("shop", "Лавка", () => pressed.push("shop")));
  try {
    bindKey("module:shop:Лавка", 0, "KeyZ");
    assert.equal(moduleActionFor("KeyZ")?.module, "shop");
    moduleActionFor("KeyZ").run();
    assert.deepEqual(pressed, ["shop"]);
    // And it is not a compiled-in action, so the ordinary lookup keeps answering `undefined` — the
    // held-movement machinery must never be handed a name it has no case for.
    assert.equal(actionFor("KeyZ"), undefined);

    // Stealing works across both tables. A key left on a compiled-in action *and* on a module's
    // would resolve to whichever was indexed first, and the bindings window would print it twice.
    bindKey("module:shop:Лавка", 0, "KeyB");
    assert.equal(moduleActionFor("KeyB")?.module, "shop");
    assert.deepEqual([...bindingsOf("toggleBags")], ["", ""], "the bag key was taken off the bags");
    assert.equal(moduleActionFor("KeyZ"), undefined);

    // The other direction: binding a compiled-in action to the module's key takes it back.
    bindAction("toggleBags", 0, "KeyB");
    assert.equal(actionFor("KeyB"), "toggleBags");
    assert.equal(moduleActionFor("KeyB"), undefined);
    assert.deepEqual([...keysOf("module:shop:Лавка")], ["", ""]);
  } finally {
    removeModuleActions("shop");
  }
  assert.equal(moduleActionFor("KeyB"), undefined, "an unloaded module answers for no key at all");
  assert.deepEqual(moduleActions(), []);
});

test("a module's key is kept while the module is away, and comes back when it does", () => {
  const storage = fakeStorage();
  useBindingStorage(storage);
  addModuleAction(moduleAction("shop", "Лавка"));
  bindKey("module:shop:Лавка", 0, "KeyZ");
  removeModuleActions("shop");
  // The key is free while the module is gone — nothing answers for it — but it is still written
  // down, because a module being unloaded is not the player changing their mind. Without this a
  // key would be lost every time the client started before the module's file had been read.
  assert.equal(moduleActionFor("KeyZ"), undefined);
  assert.equal(actionFor("KeyZ"), undefined);
  addModuleAction(moduleAction("shop", "Лавка"));
  assert.equal(moduleActionFor("KeyZ")?.module, "shop");

  // And it survives a reload of the tables, which the compiled-in blob could not have carried: it
  // keeps only the rows it recognises, and a module's row is not one of them.
  loadBindings();
  addModuleAction(moduleAction("shop", "Лавка"));
  assert.equal(moduleActionFor("KeyZ")?.module, "shop");
  removeModuleActions("shop");
});

test("a module cannot take a key off a compiled-in action by having it in storage", () => {
  // The two tables are two blobs, and the module one is kept whole across a session in which the
  // module was not loaded — so a stored module chord meets the compiled-in defaults at `reindex`
  // time with nobody having pressed anything. That is the case the «после встроенных» ordering in
  // `reindex` exists for, and it is reachable the moment the compiled-in blob is lost or reset
  // while the module one survives. Stealing a key is still possible; it takes a press in the
  // bindings window rather than a line in a definition file.
  useBindingStorage(fakeStorage({
    "webclient.keybindings.modules.v1": JSON.stringify({ "module:shop:Лавка": ["KeyW", ""] }),
  }));
  loadBindings();
  addModuleAction(moduleAction("shop", "Лавка"));
  try {
    assert.equal(actionFor("KeyW"), "moveForward", "a module took the movement key off the player");
    assert.equal(moduleActionFor("KeyW"), undefined);
    // The row is still written down, so the bindings window can show the player the collision and
    // they can decide — it simply does not answer for the key.
    assert.deepEqual([...keysOf("module:shop:Лавка")], ["KeyW", ""]);
  } finally {
    removeModuleActions("shop");
  }
});

test("«вернуть стандартные» answers for the module rows too", () => {
  useBindingStorage(fakeStorage());
  addModuleAction(moduleAction("shop", "Лавка"));
  bindKey("module:shop:Лавка", 0, "KeyZ");
  resetBindings();
  assert.deepEqual([...keysOf("module:shop:Лавка")], ["", ""],
    "a key left on a module row would be the one row the button did not answer for");
  assert.equal(moduleActionFor("KeyZ"), undefined);
  removeModuleActions("shop");
});
