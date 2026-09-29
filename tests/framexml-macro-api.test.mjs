import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";

// The macro C API (FrameXmlMacro.ts) over the store the native window writes (MacroModel.ts), the
// icon list client (FrameXmlMacroIcons.ts) and the gateway route that feeds it (gateway/MacroIcons.ts).
const {
  FrameXmlMacroModel, FRAMEXML_MACRO_BINDINGS, createFrameXmlMemoryMacroStore,
} = await import("../dist/code/browser/framexml/FrameXmlMacro.js");
const { parseMacros, serialiseMacros, nativeMacroEdit, MACRO_DEFAULT_ICON } = await import("../dist/code/browser/ui/MacroModel.js");
const { FrameXmlMacroIconClient } = await import("../dist/code/browser/framexml/FrameXmlMacroIcons.js");
const { createCannedFrameXmlMacros } = await import("../dist/code/browser/framexml/FrameXmlMacroCanned.js");

const ICONS = ["Interface\\Icons\\INV_Misc_QuestionMark", "Interface\\Icons\\Ability_Defend", "Interface\\Icons\\Spell_Fire_FlameBolt"];

function pump() {
  const events = [];
  return { events, now: () => 0, fire(event, ...args) { events.push([event, ...args]); return 1; } };
}

const settle = async () => { for (let index = 0; index < 4; index += 1) await Promise.resolve(); };

function model(macros = [], extra = {}) {
  const store = createFrameXmlMemoryMacroStore(macros);
  const placed = [];
  const events = pump();
  const instance = new FrameXmlMacroModel({
    store,
    icons: { spellIcons: () => ICONS, itemIcons: () => ["Interface\\Icons\\INV_Robe_02"] },
    placeOnActionBar: (slot, macro) => { placed.push([slot, macro]); return true; },
    ...extra,
  });
  instance.attach(events);
  return { model: instance, store, placed, events };
}

test("Lua positions close the store's gaps: account 1..N, character 37..36+M, in slot order", () => {
  const { model: macros } = model([
    { index: 5, name: "B", body: "/b" }, { index: 2, name: "A", body: "/a" }, { index: 40, name: "C", body: "/c" },
  ]);
  assert.deepEqual(macros.counts(), [2, 1]);
  assert.deepEqual(macros.info(1), ["A", MACRO_DEFAULT_ICON, "/a"]);
  assert.deepEqual(macros.info(2), ["B", MACRO_DEFAULT_ICON, "/b"]);
  assert.equal(macros.info(3), undefined);
  assert.deepEqual(macros.info(37), ["C", MACRO_DEFAULT_ICON, "/c"]);
  assert.equal(macros.info(38), undefined);
  assert.deepEqual(macros.info("c"), ["C", MACRO_DEFAULT_ICON, "/c"], "by name, case-insensitively");
  assert.equal(macros.indexByName("B"), 2);
  assert.equal(macros.indexByName("nope"), 0);
  assert.equal(macros.position(40), 37);
  assert.equal(macros.position(6), 0);
});

test("CreateMacro takes the lowest free slot of its set and answers its position; EditMacro keeps what it is not given", async () => {
  const { model: macros, store, events } = model([{ index: 2, name: "A", body: "/a" }]);
  // The stock popup: CreateMacro(name, selectedIcon, nil, perCharacter).
  assert.equal(macros.create("Новый", 2, undefined, false), 1, "slot 1 is free and sorts first");
  assert.deepEqual(store.list().map((macro) => [macro.index, macro.name, macro.icon]),
    [[1, "Новый", "Interface\\Icons\\Ability_Defend"], [2, "A", undefined]]);
  assert.equal(macros.create("Мой", 1, "/wave", true), 37);
  assert.equal(store.list().find((macro) => macro.index === 37).icon, undefined, "the question mark is not stored");
  // MacroFrame_SaveMacro: EditMacro(selected, nil, nil, text).
  assert.equal(macros.edit(1, undefined, undefined, "/say Привет"), 1);
  assert.deepEqual(macros.info(1), ["Новый", "Interface\\Icons\\Ability_Defend", "/say Привет"]);
  // The popup's edit: EditMacro(selected, name, icon).
  assert.equal(macros.edit(1, "Имя длиннее шестнадцати", 3), 1);
  assert.deepEqual(macros.info(1), ["Имя длиннее шест", "Interface\\Icons\\Spell_Fire_FlameBolt", "/say Привет"]);
  // A body is stored as written, up to 255 characters, even one this client cannot run.
  assert.equal(macros.edit(1, undefined, undefined, `/cast [combat] X\n${"x".repeat(300)}`), 1);
  assert.equal(macros.info(1)[2].length, 255);
  // An add-on may pass a texture instead of an index.
  macros.edit(1, undefined, "Ability_Warrior_Charge");
  assert.equal(macros.info(1)[1], "Interface\\Icons\\Ability_Warrior_Charge");
  await settle();
  assert.deepEqual(events.events, [["UPDATE_MACROS"]], "one UPDATE_MACROS after the chain");
  // A full set refuses.
  const full = model(Array.from({ length: 18 }, (_, offset) => ({ index: 37 + offset, name: `M${offset}`, body: "/x" }))).model;
  assert.equal(full.create("X", 1, "", true), undefined);
  assert.deepEqual(full.counts(), [0, 18]);
});

test("DeleteMacro closes the positions up, as MacroFrame_DeleteMacro expects", () => {
  const { model: macros } = model([
    { index: 1, name: "A", body: "" }, { index: 3, name: "B", body: "" }, { index: 4, name: "C", body: "" },
  ]);
  macros.remove(2);
  assert.deepEqual(macros.counts(), [2, 0]);
  assert.deepEqual([macros.info(1)[0], macros.info(2)[0]], ["A", "C"]);
  macros.remove("a");
  assert.deepEqual(macros.info(1)[0], "C");
  macros.remove(9);
  assert.deepEqual(macros.counts(), [1, 0]);
});

test("icons: the catalog when loaded, the question mark alone before; item icons for the guild-bank picker", async () => {
  const { model: macros } = model();
  assert.equal(macros.iconCount(), 3);
  assert.equal(macros.icon(1), ICONS[0]);
  assert.equal(macros.icon(4), undefined);
  assert.equal(macros.itemIconCount(), 1);
  const bare = new FrameXmlMacroModel({ store: createFrameXmlMemoryMacroStore() });
  assert.equal(bare.iconCount(), 1);
  assert.equal(bare.icon(1), MACRO_DEFAULT_ICON);
  assert.equal(bare.itemIconCount(), 0);
  await bare.loadIcons();
  // The seam bindings without any model.
  assert.deepEqual(FRAMEXML_MACRO_BINDINGS.GetNumMacroIcons({}, []), [1]);
  assert.deepEqual(FRAMEXML_MACRO_BINDINGS.GetMacroIconInfo({}, [1]), [MACRO_DEFAULT_ICON]);
  assert.deepEqual(FRAMEXML_MACRO_BINDINGS.GetNumMacros({}, []), [0, 0]);
  assert.deepEqual(FRAMEXML_MACRO_BINDINGS.CreateMacro({}, ["x", 1]), []);
});

test("PickupMacro puts the macro's slot on the cursor; PlaceAction or a button press puts it on the bar", async () => {
  const { model: macros, placed, events } = model([{ index: 3, name: "A", body: "/a" }, { index: 40, name: "B", body: "/b" }]);
  let clearedItem = 0;
  const seam = { macros, cursorHasItem: () => true, clearCursor: () => { clearedItem += 1; } };
  FRAMEXML_MACRO_BINDINGS.PickupMacro(seam, [37]);
  assert.equal(clearedItem, 1, "a macro picked up drops the item on the cursor");
  assert.equal(macros.cursorSlot(), 40, "the cursor holds the slot, the id an action button keeps");
  assert.deepEqual(macros.cursorInfo(), ["macro", 37]);
  assert.equal(macros.placeCursor(7), true);
  assert.deepEqual(placed, [[7, 40]]);
  assert.equal(macros.cursorInfo(), undefined);
  assert.equal(macros.placeCursor(8), false, "nothing on the cursor: the press is the button's own");
  macros.pickup("a");
  FRAMEXML_MACRO_BINDINGS.PlaceAction({ macros }, [12]);
  assert.deepEqual(placed, [[7, 40], [12, 3]]);
  // Picking the same macro up twice drops it; deleting the held macro drops it.
  macros.pickup(1);
  macros.pickup(1);
  assert.equal(macros.cursorSlot(), undefined);
  macros.pickup(1);
  macros.remove(1);
  assert.equal(macros.cursorSlot(), undefined);
  await settle();
  const names = events.events.map(([event]) => event);
  assert.deepEqual(names.filter((event) => event === "ACTIONBAR_SHOWGRID").length,
    names.filter((event) => event === "ACTIONBAR_HIDEGRID").length, "every grid shown is hidden again");
  // What an action button holding the slot shows.
  assert.equal(macros.slotName(40), "B");
  assert.equal(macros.slotTexture(40), MACRO_DEFAULT_ICON);
  assert.equal(macros.slotTexture(3), undefined, "a deleted macro's button shows nothing");
});

test("a store change from outside (the server's copy, the native window) is UPDATE_MACROS", async () => {
  const listeners = new Set();
  let macros = [{ index: 1, name: "A", body: "" }];
  const store = {
    list: () => macros, put() {}, remove() {},
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const instance = new FrameXmlMacroModel({ store });
  const events = pump();
  instance.attach(events);
  macros = [...macros, { index: 2, name: "B", body: "" }];
  for (const listener of listeners) listener();
  await settle();
  assert.deepEqual(events.events, [["UPDATE_MACROS"]]);
  instance.detach();
  assert.equal(listeners.size, 0);
});

test("the saved blob keeps its shape: an icon is an optional field both ways", () => {
  const old = '[{"index":1,"name":"A","body":"/a"},{"index":38,"name":"B","body":"/b"}]';
  assert.deepEqual(parseMacros(old), [{ index: 1, name: "A", body: "/a" }, { index: 38, name: "B", body: "/b" }]);
  assert.equal(serialiseMacros(parseMacros(old)), old, "a blob without icons is written back unchanged");
  const withIcon = serialiseMacros([{ index: 2, name: "C", body: "", icon: "Interface\\Icons\\Ability_Defend" }]);
  assert.deepEqual(parseMacros(withIcon), [{ index: 2, name: "C", body: "", icon: "Interface\\Icons\\Ability_Defend" }]);
  assert.deepEqual(parseMacros('[{"index":2,"name":"C","body":"","icon":"http://evil/x.png"}]'),
    [{ index: 2, name: "C", body: "" }], "an icon that is not a client texture path is dropped");
});

test("a save in the native window keeps the icon the stock window chose", () => {
  const chosen = { index: 2, name: "Старое", body: "/old", icon: "Interface\\Icons\\Ability_Defend" };
  assert.deepEqual(nativeMacroEdit(chosen, 2, "  Новое  ", "/new"),
    { index: 2, name: "Новое", body: "/new", icon: "Interface\\Icons\\Ability_Defend" });
  assert.deepEqual(nativeMacroEdit(undefined, 40, "Щит", "x".repeat(300)), { index: 40, name: "Щит", body: "x".repeat(255) },
    "a new macro has no icon field: the question mark");
});

test("the icon client builds client texture paths from the route and fails closed to the question mark", async () => {
  const requested = [];
  const client = new FrameXmlMacroIconClient("http://127.0.0.1:8090", async (url) => {
    requested.push(String(url));
    return { ok: true, json: async () => ({ spell: ["INV_Misc_QuestionMark", "Ability_Defend"], item: ["INV_Robe_02"] }) };
  });
  assert.equal(client.spellIcons(), undefined, "nothing is fetched before the window asks");
  await Promise.all([client.load(), client.load()]);
  assert.deepEqual(requested, ["http://127.0.0.1:8090/dbc/macro-icons?v=1"], "one fetch");
  assert.deepEqual(client.spellIcons(), ["Interface\\Icons\\INV_Misc_QuestionMark", "Interface\\Icons\\Ability_Defend"]);
  assert.deepEqual(client.itemIcons(), ["Interface\\Icons\\INV_Robe_02"]);
  const missing = new FrameXmlMacroIconClient("http://127.0.0.1:8090", async () => ({ ok: false, status: 404 }));
  await missing.load();
  assert.equal(missing.spellIcons(), undefined);
  assert.match(missing.failure, /404/);
  const hostile = new FrameXmlMacroIconClient("http://127.0.0.1:8090",
    async () => ({ ok: true, json: async () => ({ spell: ["..\\..\\x"], item: [] }) }));
  await hostile.load();
  assert.equal(hostile.spellIcons(), undefined, "a name with a path separator rejects the whole answer");
  const withModel = new FrameXmlMacroModel({ store: createFrameXmlMemoryMacroStore(), icons: missing });
  assert.equal(withModel.iconCount(), 1);
});

const dataset = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
test("the gateway's icon lists: distinct SpellIcon textures with the question mark first, and item icons", {
  skip: existsSync(`${dataset}/SpellIcon.dbc`) ? false : "no dataset DBC on this machine",
}, async () => {
  const { loadMacroIcons } = await import("../dist/code/gateway/MacroIcons.js");
  const catalog = await loadMacroIcons(dataset);
  assert.equal(catalog.spell[0], "INV_Misc_QuestionMark");
  assert.equal(new Set(catalog.spell.map((name) => name.toLowerCase())).size, catalog.spell.length, "no repeats");
  assert.equal(new Set(catalog.item.map((name) => name.toLowerCase())).size, catalog.item.length);
  assert.ok(catalog.spell.every((name) => !/[\\/]/.test(name)));
  console.log(`[macro icons] spell ${catalog.spell.length} item ${catalog.item.length} json ${JSON.stringify(catalog).length} bytes`);
  // Measured on the tswow dataset (2026-09-25): 3,182 distinct Interface\Icons\ textures in SpellIcon.dbc
  // and 4,761 distinct inventory icons in ItemDisplayInfo.dbc.
  assert.equal(catalog.spell.length, 3182);
  assert.equal(catalog.item.length, 4761);
});

test("/dbc/macro-icons is origin-protected, versioned and served from the active dataset", {
  skip: existsSync(`${dataset}/SpellIcon.dbc`) ? false : "no dataset DBC on this machine",
}, async () => {
  // In process, on an ephemeral port; the realm addresses point nowhere and are never dialled.
  const { startGateway } = await import("../dist/code/gateway/Gateway.js");
  const origin = "http://127.0.0.1:5173";
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [origin], dbcDirectory: dataset, datasetPollMs: 0,
  });
  const base = `http://127.0.0.1:${gateway.port}/dbc/macro-icons`;
  try {
    assert.equal((await fetch(`${base}?v=1`)).status, 403);
    assert.equal((await fetch(`${base}?v=2`, { headers: { origin } })).status, 400);
    const response = await fetch(`${base}?v=1`, { headers: { origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    // The browser client reads it into texture paths.
    const client = new FrameXmlMacroIconClient(`http://127.0.0.1:${gateway.port}`,
      (url) => fetch(url, { headers: { origin } }));
    await client.load();
    assert.equal(client.failure, undefined);
    assert.equal(client.spellIcons()[0], "Interface\\Icons\\INV_Misc_QuestionMark");
    assert.equal(client.spellIcons().length, 3182);
    assert.equal(client.itemIcons().length, 4761);
    void response.body?.cancel();
  } finally {
    await gateway.close();
  }
});

test("the canned fixture: three macros over a gap and six icons, placements recorded", () => {
  const canned = createCannedFrameXmlMacros();
  assert.deepEqual(canned.model.counts(), [2, 1]);
  assert.deepEqual(canned.model.info(2), ["Привет", MACRO_DEFAULT_ICON, "/say Привет!\n/wave"]);
  assert.equal(canned.model.iconCount(), 6);
  canned.model.pickup(37);
  canned.model.placeCursor(5);
  assert.deepEqual(canned.placed, [[5, 37]]);
});
