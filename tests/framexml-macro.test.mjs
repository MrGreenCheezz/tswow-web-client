import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

// Merged 2026-10-20 from 2 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-macro-api.test.mjs
{
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

/**
 * The two lists counted straight from the tables with the tools' own DBC reader, not the gateway's:
 * distinct `Interface\Icons\<name>` textures of SpellIcon.dbc (the question mark always among
 * them) and distinct InventoryIcon names of ItemDisplayInfo.dbc, case-insensitively. The tswow
 * dataset with modules (2026-09-25) had 3,182 and 4,761; the base dataset of 08.10 has 3,149 of
 * 3,226 SpellIcon rows and 4,734 of 57,986 ItemDisplayInfo rows.
 */
let expectedIconCounts;
async function iconCounts() {
  if (expectedIconCounts) return expectedIconCounts;
  const { openDbcFile } = await import("../tools/dbc.mjs");
  const [icons, display] = await Promise.all([
    openDbcFile(dataset, "SpellIcon"), openDbcFile(dataset, "ItemDisplayInfo"),
  ]);
  const spell = new Set(["inv_misc_questionmark"]);
  for (const row of icons.rows()) {
    const match = /^interface\\icons\\([^\\/]+)$/i.exec(icons.string(row, "TextureFilename"));
    if (match) spell.add(match[1].toLowerCase());
  }
  const item = new Set();
  for (const row of display.rows()) {
    const name = display.string(row, "InventoryIcon", 0);
    if (name) item.add(name.toLowerCase());
  }
  return (expectedIconCounts = { spell: spell.size, item: item.size });
}

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
  // and 4,761 distinct inventory icons in ItemDisplayInfo.dbc. Since 08.10 the counts come from the
  // tables themselves (`iconCounts`): the base dataset has 3,149 and 4,734.
  const expected = await iconCounts();
  assert.ok(expected.spell > 3000 && expected.item > 4000, JSON.stringify(expected));
  assert.equal(catalog.spell.length, expected.spell);
  assert.equal(catalog.item.length, expected.item);
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
    const expected = await iconCounts();
    assert.equal(client.spellIcons().length, expected.spell);
    assert.equal(client.itemIcons().length, expected.item);
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
}

// ── framexml-macro-live-seam.test.mjs
{
// LiveWorldSeam's construction block for the MAC lane: the macro model over the host's store, the
// action bar's macro buttons (name and icon), the macro cursor on the bar (UseAction/PlaceAction →
// CMSG_SET_ACTION_BUTTON), and the binding model's RunBinding verb.
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { createFrameXmlMemoryMacroStore } = await import("../dist/code/browser/framexml/FrameXmlMacro.js");
const { ACTION_BUTTON_MACRO, ACTION_BUTTON_SPELL } = await import("../dist/code/world/ActionBarProtocol.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

bindings.useBindingStorage(undefined);

function fixture() {
  const sent = [];
  const used = [];
  const runs = [];
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, { guid: 1n, typeId: 4, fields: new Map() }]]) },
    actionButtons: [
      { slot: 0, action: 133, type: ACTION_BUTTON_SPELL },
      { slot: 4, action: 37, type: ACTION_BUTTON_MACRO },
      { slot: 5, action: 9, type: ACTION_BUTTON_MACRO },
    ],
    casts: new Map(), cooldownSnapshots: new Map(), itemCooldowns: new Map(), mirrorTimers: new Map(), itemTemplates: new Map(),
    cooldownRemaining: () => 0, cooldownState: () => undefined, isActiveMountSpell: () => false,
    setActionButton(slot, action, type) {
      sent.push([slot, action, type]);
      world.actionButtons = [...world.actionButtons.filter((button) => button.slot !== slot), { slot, action, type }];
    },
    events: { on() { return () => {}; } },
  };
  const store = createFrameXmlMemoryMacroStore([
    { index: 2, name: "Танец", body: "/dance", icon: "Interface\\Icons\\Ability_Defend" },
    { index: 37, name: "Щит", body: "/cast Блок щитом" },
  ]);
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell() {},
    useAction: (slot) => used.push(slot),
    macroStore: store,
    runBinding: (action) => { runs.push(action); return true; },
  });
  return { seam, world, sent, used, runs, store };
}

const call = (seam, name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

test("an action button holding a macro shows its name and icon; a deleted macro's button shows none", () => {
  const { seam } = fixture();
  assert.deepEqual(call(seam, "GetActionText", 5), ["Щит"]);
  assert.deepEqual(call(seam, "GetActionTexture", 5), ["Interface\\Icons\\INV_Misc_QuestionMark"]);
  assert.deepEqual(call(seam, "GetActionText", 6), ["9"], "slot 9 holds no macro: the id, as before");
  assert.deepEqual(call(seam, "GetActionTexture", 6), []);
  assert.deepEqual(call(seam, "GetNumMacros"), [1, 1]);
  assert.deepEqual(call(seam, "GetMacroInfo", 37), ["Щит", "Interface\\Icons\\INV_Misc_QuestionMark", "/cast Блок щитом"]);
});

test("a macro picked up goes on the button pressed next, through CMSG_SET_ACTION_BUTTON, and not the button's own action", () => {
  const { seam, sent, used } = fixture();
  call(seam, "PickupMacro", 1);
  assert.deepEqual(call(seam, "GetCursorInfo"), ["macro", 1]);
  call(seam, "UseAction", 1);
  assert.deepEqual(sent, [[0, 2, ACTION_BUTTON_MACRO]], "slot 1 (wire 0) now holds macro slot 2");
  assert.deepEqual(used, [], "the spell on the button was not cast");
  // The stock swap (FrameXmlCursor.ts): the spell the macro displaced is on the cursor now. Its
  // metadata is not in this fixture, so it has no book slot to name.
  assert.deepEqual(call(seam, "GetCursorInfo"), ["spell", undefined, "spell"]);
  call(seam, "ClearCursor");
  assert.deepEqual(call(seam, "GetActionText", 1), ["Танец"]);
  assert.deepEqual(call(seam, "GetActionTexture", 1), ["Interface\\Icons\\Ability_Defend"]);
  // PlaceAction, and ClearCursor dropping it.
  call(seam, "PickupMacro", "Щит");
  call(seam, "PlaceAction", 12);
  assert.deepEqual(sent.at(-1), [11, 37, ACTION_BUTTON_MACRO]);
  call(seam, "PickupMacro", 37);
  call(seam, "ClearCursor");
  call(seam, "UseAction", 1);
  assert.deepEqual(used, [1], "an empty cursor: the press is the button's own");
});

test("one thing on the cursor: a bag item picked up drops the macro, a macro picked up drops the item", () => {
  const { seam, world } = fixture();
  // A live bag item in backpack slot 1 (PLAYER_FIELD_PACK_SLOT_1), as the realm's update leaves it.
  const player = world.state.objects.get(1n);
  const item = { guid: 2n, typeId: 1, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 13446]]) };
  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, 2);
  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 1, 0);
  world.state.objects.set(item.guid, item);
  call(seam, "PickupMacro", 1);
  assert.deepEqual(call(seam, "GetCursorInfo"), ["macro", 1]);
  call(seam, "PickupContainerItem", 0, 1);
  assert.deepEqual(call(seam, "GetCursorInfo").slice(0, 2), ["item", 13446], "the item, not the macro under it");
  assert.equal(seam.macros.cursorSlot(), undefined, "the macro left the cursor");
  call(seam, "PickupMacro", 37);
  assert.deepEqual(call(seam, "CursorHasItem"), [false], "the item left the cursor");
  assert.deepEqual(call(seam, "GetCursorInfo"), ["macro", 37]);
});

test("the live seam's binding model reads the table and runs the host's verbs", () => {
  const { seam, runs } = fixture();
  assert.deepEqual(call(seam, "GetBindingKey", "ACTIONBUTTON1"), ["1"]);
  assert.deepEqual(call(seam, "GetBindingByKey", "M"), ["TOGGLEWORLDMAP"]);
  call(seam, "RunBinding", "TOGGLEWORLDMAP");
  assert.deepEqual(runs, ["toggleWorldMap"]);
});

// Macros (3.10): RunMacro/RunMacroText/StopMacro/GetClickFrame over the shared runner
// (src/browser/macro/MacroRunner.ts), and the seam's macro context over the live world.
test("RunMacro and RunMacroText run the slash lines in order with their button; StopMacro ends a run after its line", async () => {
  const { installMacroLineExecutor, macroRunButton } = await import("../dist/code/browser/macro/MacroRunner.js");
  const { seam, store } = fixture();
  store.put({ index: 3, name: "Бой", body: "#showtooltip\n/cast [mod:shift] А; Б\n#show Б\n-- заметка\nпросто текст\n  /stopmacro [combat]\n/dance\n" });
  const ran = [];
  let stopAt;
  let nested;
  const uninstall = installMacroLineExecutor((line) => {
    ran.push([line, macroRunButton() ?? null]);
    if (line === stopAt) call(seam, "StopMacro");
    if (line === "/click Вложенный" && nested) call(seam, "RunMacroText", nested, "LeftButton");
  });
  try {
    // Position 2 is slot 3 (slot 2 is «Танец»); a name reaches the same macro.
    call(seam, "RunMacro", 2);
    assert.deepEqual(ran, [
      ["/cast [mod:shift] А; Б", null], ["просто текст", null], ["/stopmacro [combat]", null], ["/dance", null],
    ], "every line runs, a line without / too (the client says it); the # directives and - comments do not");
    ran.length = 0;
    stopAt = "/stopmacro [combat]";
    call(seam, "RunMacro", "бой", "RightButton");
    assert.deepEqual(ran, [
      ["/cast [mod:shift] А; Б", "RightButton"], ["просто текст", "RightButton"], ["/stopmacro [combat]", "RightButton"],
    ]);
    assert.equal(macroRunButton(), undefined, "the button belongs to the run");
    ran.length = 0;
    call(seam, "StopMacro");
    call(seam, "RunMacroText", "/first\n/second", "MiddleButton");
    assert.deepEqual(ran, [["/first", "MiddleButton"], ["/second", "MiddleButton"]], "a stop outside a run stops nothing later");
    // A macro a macro starts (a /click of a macro button) runs inside it with its own button, and
    // its /stopmacro ends only itself.
    ran.length = 0;
    stopAt = "/n-stop";
    nested = "/n1\n/n-stop\n/n2";
    call(seam, "RunMacroText", "/a\n/click Вложенный\n/b", "RightButton");
    assert.deepEqual(ran, [
      ["/a", "RightButton"], ["/click Вложенный", "RightButton"], ["/n1", "LeftButton"], ["/n-stop", "LeftButton"],
      ["/b", "RightButton"],
    ]);
    ran.length = 0;
    call(seam, "RunMacro", 99);
    call(seam, "RunMacroText", 42);
    assert.deepEqual(ran, [], "no macro, no text: nothing runs");
  } finally {
    uninstall();
  }
});

test("GetClickFrame answers any frame of that name; the stock /click body checks it is a Button", async () => {
  const { installMacroClickFrames } = await import("../dist/code/browser/macro/MacroRunner.js");
  const { seam } = fixture();
  const frames = new Map([["Кнопка", { name: "Кнопка", type: "Button" }], ["Рамка", { name: "Рамка", type: "Frame" }]]);
  assert.deepEqual(call(seam, "GetClickFrame", "Кнопка"), [], "no interface published: no frames");
  const uninstall = installMacroClickFrames((name) => frames.get(name));
  try {
    assert.equal(call(seam, "GetClickFrame", "Кнопка")[0]?.name, "Кнопка");
    assert.equal(call(seam, "GetClickFrame", "Рамка")[0]?.name, "Рамка", "Wow.exe 0x564130 → 0x562990: any frame");
    assert.deepEqual(call(seam, "GetClickFrame", "Нет"), []);
    assert.deepEqual(call(seam, "GetClickFrame"), []);
  } finally {
    uninstall();
  }
});

test("a macro may start another only so deep: a macro that runs itself ends", async () => {
  const { installMacroLineExecutor, MACRO_RUN_DEPTH } = await import("../dist/code/browser/macro/MacroRunner.js");
  const { seam } = fixture();
  let runs = 0;
  const uninstall = installMacroLineExecutor(() => {
    runs += 1;
    call(seam, "RunMacroText", "/again");
  });
  try {
    call(seam, "RunMacroText", "/again");
    assert.equal(runs, MACRO_RUN_DEPTH, "each level ran its one line, the next level was refused");
  } finally {
    uninstall();
  }
});

test("UseAction hands the host the mouse button, which a macro on the button reads", () => {
  const presses = [];
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, { guid: 1n, typeId: 4, fields: new Map() }]]) },
    actionButtons: [{ slot: 4, action: 37, type: ACTION_BUTTON_MACRO }], casts: new Map(), cooldownSnapshots: new Map(),
    itemCooldowns: new Map(), mirrorTimers: new Map(), itemTemplates: new Map(),
    cooldownRemaining: () => 0, cooldownState: () => undefined, isActiveMountSpell: () => false,
    events: { on() { return () => {}; } },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined, monotonic: () => 0,
    globalCooldownUntil: () => 0, castSpell() {}, useAction: (slot, button) => presses.push([slot, button ?? null]),
  });
  call(seam, "UseAction", 5, undefined, "RightButton");
  call(seam, "UseAction", 5);
  assert.deepEqual(presses, [[5, "RightButton"], [5, null]]);
});

test("the live seam's macro context answers from the world the stock UI reads", async () => {
  const { frameXmlSecureCmdOptionParse } = await import("../dist/code/browser/framexml/FrameXmlChatApi.js");
  const { REACTION_HOSTILE } = await import("../dist/code/world/FactionRules.js");
  const player = { guid: 1n, typeId: 4, movementFlags: 0, fields: new Map() };
  const wolf = { guid: 2n, typeId: 3, movementFlags: 0, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 50]]) };
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, player], [2n, wolf]]) },
    targetGuid: 2n, actionButtons: [], casts: new Map(), cooldownSnapshots: new Map(), itemCooldowns: new Map(),
    mirrorTimers: new Map(), itemTemplates: new Map(), knownSpells: [], partyStats: new Map(),
    cooldownRemaining: () => 0, cooldownState: () => undefined, isActiveMountSpell: () => false,
    aurasFor: () => [], events: { on() { return () => {}; } },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell() {},
    reaction: () => REACTION_HOSTILE,
  });
  const parse = (options) => frameXmlSecureCmdOptionParse(options, seam.macroContext());
  assert.equal(seam.macroContext(), seam.macroContext(), "one context per seam");
  assert.deepEqual(parse("[combat] А; Б"), ["Б"]);
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x80000);
  assert.deepEqual(parse("[combat] А; Б"), ["А"], "UNIT_FLAG_IN_COMBAT on the player");
  assert.deepEqual(parse("[harm,nodead] А; Б"), ["А"]);
  assert.deepEqual(parse("[help] А; Б"), ["Б"]);
  assert.deepEqual(parse("[@player,help] А; Б"), ["А", "player"]);
  wolf.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
  assert.deepEqual(parse("[harm,nodead] А; Б"), ["Б"]);
  assert.deepEqual(parse("[@focus,exists] А; Б"), ["Б"]);
  assert.deepEqual(parse("[mounted] А; [swimming] Б; [flying] В; [stealth] Г; Д"), ["Д"]);
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset, 14_338);
  assert.deepEqual(parse("[mounted] А; Б"), ["А"]);
  player.movementFlags = 0x0020_0000;
  assert.deepEqual(parse("[swimming] А; Б"), ["А"], "MOVEMENTFLAG_SWIMMING of the last movement sent");
  player.movementFlags = 0x0200_0000;
  assert.deepEqual(parse("[swimming] А; [flying] Б; В"), ["Б"]);
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_1.offset, 0x02 << 16);
  assert.deepEqual(parse("[stealth] А; Б"), ["А"], "UNIT_VIS_FLAGS_CREEP, which only SPELL_AURA_MOD_STEALTH sets");
  assert.deepEqual(parse("[spec:1] А; Б"), ["Б"], "no talents yet: no spec");
  world.talents = { activeSpec: 1, unspentPoints: 0, pet: false, specs: [] };
  assert.deepEqual(parse("[spec:2] А; Б"), ["А"]);
  assert.deepEqual(parse("[stance:0,nobonusbar,actionbar:1] А; Б"), ["А"], "no forms, the main page");
  // The conditions this client has no data for yet answer «no»; without area data the player is outdoors.
  assert.deepEqual(parse("[flyable] А; [indoors] Б; [vehicleui] В; [equipped:Щиты] Г; Д"), ["Д"]);
  assert.deepEqual(parse("[outdoors] А; Б"), ["А"]);
  // [combat] also holds while only the pet fights (Wow.exe 0x5ef710).
  player.fields.delete(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset);
  assert.deepEqual(parse("[combat] А; Б"), ["Б"]);
  world.petSpells = { guid: 9n, creatureFamily: 1 };
  world.state.objects.set(9n, { guid: 9n, typeId: 3, movementFlags: 0, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x80000]]) });
  assert.deepEqual(parse("[combat] А; Б"), ["А"]);
  // [party] leaves the player out, though UnitInParty("player") is true in a group (0x5eede0); [raid]
  // is the party or the raid, which counts the player (0x5eee20).
  world.group = { groupType: 0, leaderGuid: 1n, members: [{ guid: 3n, name: "Жрец" }] };
  assert.equal(seam.unitInParty("player"), true);
  assert.deepEqual(parse("[@player,party] А; Б"), ["Б"]);
  assert.deepEqual(parse("[@player,raid] А; Б"), ["Б"]);
  world.group = { groupType: 2, leaderGuid: 1n, members: [{ guid: 3n, name: "Жрец" }] };
  assert.deepEqual(parse("[@player,raid] А; Б"), ["А", "player"]);
});

test("the live seam's [stance] is 0 without a form byte, whatever the stance bar shows as active", async () => {
  const { frameXmlSecureCmdOptionParse } = await import("../dist/code/browser/framexml/FrameXmlChatApi.js");
  const player = { guid: 1n, typeId: 4, movementFlags: 0, fields: new Map() };
  const rows = new Map([
    // Devotion Aura: on the stance bar (DisplayInStanceBar) but no shapeshift, like a DK presence.
    [465, { id: 465, name: "Аура благочестия", iconPath: "Interface\\Icons\\Spell_Holy_DevotionAura", passive: false,
      stanceBarOrder: 0, displayInStanceBar: true, effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], spellLevel: 1 }],
    [768, { id: 768, name: "Облик кошки", iconPath: "Interface\\Icons\\Ability_Druid_CatForm", passive: false,
      stanceBarOrder: 1, displayInStanceBar: false, effectAura: [36, 0, 0], effectMiscValue: [1, 0, 0], spellLevel: 20,
      bonusActionBarOffset: 1 }],
  ]);
  let lookups = 0;
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, player]]) },
    knownSpells: [{ id: 465, slot: 0 }, { id: 768, slot: 1 }], actionButtons: [], casts: new Map(),
    cooldownSnapshots: new Map(), itemCooldowns: new Map(), mirrorTimers: new Map(), itemTemplates: new Map(),
    cooldownRemaining: () => 0, cooldownState: () => undefined, isActiveMountSpell: () => false,
    aurasFor: () => [{ spellId: 465, casterGuid: 1n }], events: { on() { return () => {}; } },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => { lookups += 1; return rows.get(id); },
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell() {},
  });
  const parse = (options) => frameXmlSecureCmdOptionParse(options, seam.macroContext());
  assert.deepEqual(parse("[stance:1] А; [stance:0] Б; В"), ["Б"], "the aura is active, but GetShapeshiftForm(true) is 0");
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, 1 << 24);
  assert.deepEqual(parse("[stance:2,bonusbar:1] А; Б"), ["А"], "cat form is the second button, on bonus bar 1");
  // A state driver asks five times a second: the form lookups walk the learned spells once per form.
  const walked = lookups;
  for (let press = 0; press < 5; press += 1) parse("[stance:2,bonusbar:1] А; Б");
  assert.equal(lookups, walked, "no spell row is read again until the form, the spells or the rows change");
});
}
