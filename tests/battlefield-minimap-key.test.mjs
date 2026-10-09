import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.14 (05.10-L17t): Bindings.xml's TOGGLEBATTLEFIELDMINIMAP («Карта зоны», body
// `ToggleBattlefieldMinimap();`, FrameXML/Bindings.xml:703-705) on DefaultBindings.wtf's SHIFT-M. The key
// runs stock UIParent's ToggleBattlefieldMinimap (UIParent.lua:392-397) in the mounted stock UI, which the
// load-on-demand owner (FrameXmlBattlefieldMinimapLod.ts) hooks: it loads Blizzard_BattlefieldMinimap and
// replays stock BattlefieldMinimap_Toggle, which decides by IsInInstance() — a battleground «pvp» (CVar 1),
// not an arena, anywhere else the zone map (CVar 2). Without the stock UI there is no such frame: the key
// does nothing and says so (false).
const Bindings = await import("../dist/code/browser/input/Bindings.js");
const { DEFAULT_BINDINGS, INPUT_ACTIONS } = Bindings;
const { STOCK_DEFAULT_KEYS } = await import("../dist/code/generated/stockBindings.js");
const { FRAMEXML_STOCK_BINDING_SECTIONS, frameXmlBindingCommand } = await import("../dist/code/browser/framexml/FrameXmlBinding.js");

test("the stock row ships on Shift+M, alone on its chord, in the INTERFACE section", () => {
  const row = INPUT_ACTIONS.find((entry) => entry.action === "toggleBattlefieldMinimap");
  assert.ok(row, "the bindings window lists it");
  assert.equal(row.command, "TOGGLEBATTLEFIELDMINIMAP");
  assert.equal(row.group, "Интерфейс");
  assert.equal(row.label, "Карта зоны");
  assert.deepEqual(STOCK_DEFAULT_KEYS.TOGGLEBATTLEFIELDMINIMAP, ["SHIFT-M"]);
  assert.deepEqual(DEFAULT_BINDINGS.toggleBattlefieldMinimap, ["Shift+KeyM", ""]);
  const holders = INPUT_ACTIONS.filter((entry) => (DEFAULT_BINDINGS[entry.action] ?? []).includes("Shift+KeyM"));
  assert.deepEqual(holders.map((entry) => entry.action), ["toggleBattlefieldMinimap"]);
  assert.equal(frameXmlBindingCommand("toggleBattlefieldMinimap"), "TOGGLEBATTLEFIELDMINIMAP");
  const section = FRAMEXML_STOCK_BINDING_SECTIONS.find((entry) => entry.header === "INTERFACE");
  const commands = section.rows.map(([command]) => command);
  assert.ok(commands.includes("TOGGLEBATTLEFIELDMINIMAP"));
  assert.ok(commands.indexOf("TOGGLEWORLDMAP") < commands.indexOf("TOGGLEBATTLEFIELDMINIMAP"), "Bindings.xml order");
});

function makeNode(tag = "div") {
  const node = {
    tagName: String(tag).toUpperCase(), children: [], hidden: false, disabled: false,
    value: "", textContent: "", type: "", dataset: {}, id: "", className: "", title: "",
    style: { setProperty() {}, removeProperty() {} },
    parentNode: undefined,
    classList: { add() {}, remove() {}, toggle() { return false; }, contains: () => false },
    append(...kids) { node.children.push(...kids); },
    prepend(...kids) { node.children.unshift(...kids); },
    replaceChildren(...kids) { node.children = [...kids]; },
    remove() {}, addEventListener() {}, removeEventListener() {},
    setAttribute(name, value) { node[name] = value; },
    getAttribute(name) { return node[name] ?? null; },
    removeAttribute() {}, focus() {}, blur() {},
    querySelector() { return makeNode("button"); }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  return node;
}
const byId = new Map();
globalThis.document = {
  createElement: (tag) => makeNode(tag),
  createElementNS: (_ns, tag) => makeNode(tag),
  body: makeNode("body"),
  documentElement: makeNode("html"),
  createTextNode: (text) => ({ textContent: text }),
  getElementById: (id) => {
    if (!byId.has(id)) byId.set(id, makeNode("div"));
    return byId.get(id);
  },
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 800 };
globalThis.location = { origin: "http://127.0.0.1:5173", protocol: "http:", hostname: "127.0.0.1" };
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};

const { game } = await import("../dist/code/browser/game/Context.js");
const { runAction } = await import("../dist/code/browser/input/Actions.js");
const { publishFrameXmlBattlefieldMinimapKey, toggleFrameXmlBattlefieldMinimap } = await import(
  "../dist/code/browser/framexml/FrameXmlBattlefieldMinimapKey.js",
);

function fakeBoot() {
  const ran = [];
  return { ran, vm: { executeReported: (code, chunk) => { ran.push([code, chunk]); return true; } } };
}

test("the key runs stock ToggleBattlefieldMinimap in the mounted stock UI, and nothing without one", () => {
  try {
    game.world = { targetGuid: undefined };
    assert.equal(toggleFrameXmlBattlefieldMinimap(), false, "no stock UI: nothing to toggle");
    assert.equal(runAction("toggleBattlefieldMinimap"), false);

    const first = fakeBoot();
    const cleanupFirst = publishFrameXmlBattlefieldMinimapKey(first);
    assert.equal(runAction("toggleBattlefieldMinimap"), true);
    assert.equal(first.ran.length, 1);
    assert.match(first.ran[0][0], /^\s*ToggleBattlefieldMinimap\(\)\s*;?\s*$/, "the Bindings.xml body, nothing else");

    // A remount publishes a new boot; the old mount's late cleanup must not unpublish it.
    const second = fakeBoot();
    const cleanupSecond = publishFrameXmlBattlefieldMinimapKey(second);
    cleanupFirst();
    assert.equal(runAction("toggleBattlefieldMinimap"), true);
    assert.deepEqual([first.ran.length, second.ran.length], [1, 1]);

    cleanupSecond();
    assert.equal(runAction("toggleBattlefieldMinimap"), false, "after teardown the key is inert");
    assert.equal(second.ran.length, 1);

    // A Lua error inside stock is the VM's to report; the key still counts as handled.
    const throwing = { vm: { executeReported: () => { throw new Error("vm closed"); } } };
    const cleanupThrowing = publishFrameXmlBattlefieldMinimapKey(throwing);
    assert.equal(runAction("toggleBattlefieldMinimap"), true);
    cleanupThrowing();

    game.world = undefined;
    publishFrameXmlBattlefieldMinimapKey(fakeBoot())();
    assert.equal(runAction("toggleBattlefieldMinimap"), false, "no world: no key");
  } finally {
    game.world = undefined;
  }
});

// 05.10 review: a table saved before the row existed gets Shift+M, but never over a key the player put on
// something else — a compiled-in row or a module's (the module blob is the player's own choice too:
// modules ship unbound, `bindKey` is the only writer).
test("an older saved table gains Shift+M only where the player left it free", () => {
  const { useBindingStorage, bindingsOf, keysOf, actionFor } = Bindings;
  const older = Object.fromEntries(
    INPUT_ACTIONS.filter((entry) => entry.action !== "toggleBattlefieldMinimap")
      .map((entry) => [entry.action, [...DEFAULT_BINDINGS[entry.action]]]),
  );
  const store = (core, modules) => {
    const values = new Map([["webclient.keybindings.v1", JSON.stringify(core)]]);
    if (modules) values.set("webclient.keybindings.modules.v1", JSON.stringify(modules));
    return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
  };
  try {
    useBindingStorage(store(older));
    assert.deepEqual(bindingsOf("toggleBattlefieldMinimap"), ["Shift+KeyM", ""], "free chord: the new default");
    assert.equal(actionFor("Shift+KeyM"), "toggleBattlefieldMinimap");

    useBindingStorage(store({ ...older, toggleWorldMap: ["KeyM", "Shift+KeyM"] }));
    assert.deepEqual(bindingsOf("toggleBattlefieldMinimap"), ["", ""], "a compiled-in row of the player's keeps it");
    assert.equal(actionFor("Shift+KeyM"), "toggleWorldMap");

    useBindingStorage(store(older, { "module:survival:map": ["Shift+KeyM", ""] }));
    assert.deepEqual(keysOf("module:survival:map"), ["Shift+KeyM", ""]);
    assert.deepEqual(bindingsOf("toggleBattlefieldMinimap"), ["", ""], "a module row of the player's keeps it");
    assert.equal(actionFor("Shift+KeyM"), undefined, "the press still reaches the module's action");
  } finally {
    useBindingStorage(undefined);
  }
});
