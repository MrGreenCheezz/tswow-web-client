import assert from "node:assert/strict";
import test from "node:test";

// The glyph tab's C API (FrameXmlGlyph.ts) over a scripted host, the live host over a scripted
// WorldClient (FrameXmlGlyphLive.ts), the canned stand-in realm, the glyph field of CMSG_USE_ITEM, and
// the gateway catalog against this dataset's DBCs (gateway/GlyphCatalog.ts).
const {
  FrameXmlGlyphModel, FRAMEXML_GLYPH_BINDINGS, FRAMEXML_GLYPH_SOCKETS, frameXmlGlyphCatalog,
} = await import("../dist/code/browser/framexml/FrameXmlGlyph.js");
const { createLiveFrameXmlGlyphs, FRAMEXML_GLYPH_CATALOG_VERSION, FRAMEXML_GLYPH_CATALOG_PATH } = await import(
  "../dist/code/browser/framexml/FrameXmlGlyphLive.js");
const { createCannedFrameXmlGlyphs, CANNED_GLYPH_CATALOG, frameXmlGlyphEnabledMask } = await import(
  "../dist/code/browser/framexml/FrameXmlGlyphCanned.js");
const { GLYPH_CATALOG_VERSION, loadGlyphCatalog } = await import("../dist/code/gateway/GlyphCatalog.js");
const { buildUseItem } = await import("../dist/code/world/ItemProtocol.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const CATALOG = {
  version: 1,
  glyphs: [
    { id: 319, spellId: 56370, slotFlags: 0, icon: "Interface\\Spellbook\\UI-Glyph-Rune-11" },
    { id: 451, spellId: 57925, slotFlags: 1, icon: "" },
  ],
  slots: [
    { id: 21, type: 0, order: 1 }, { id: 22, type: 1, order: 2 }, { id: 23, type: 1, order: 3 },
    { id: 24, type: 0, order: 4 }, { id: 25, type: 1, order: 5 }, { id: 26, type: 0, order: 6 },
  ],
  itemSpells: [[56590, 319], [58241, 451]],
};

function harness({ mask = 0x0f, groups = { 1: [319, 451, 0, 0, 0, 0] }, active = 1, names = {} } = {}) {
  const calls = [];
  const events = [];
  const state = { mask, groups, active, catalog: frameXmlGlyphCatalog(CATALOG, 1), session: {}, holds: true };
  const model = new FrameXmlGlyphModel({
    catalog: () => state.catalog,
    enabledMask: () => state.mask,
    slotId: (index) => CATALOG.slots[index]?.id,
    activeGroup: () => state.active,
    glyph: (index, group) => state.groups[group]?.[index],
    spellName: (id) => names[id],
    holds: () => state.holds,
    place: (item, index) => calls.push(["place", item.glyphId, item.bag, item.slot, index]),
    remove: (index) => calls.push(["remove", index]),
    session: () => state.session,
  });
  model.attach({ fire: (event, ...args) => { events.push([event, ...args]); return 1; } });
  return { model, state, calls, events, host: { glyphs: model } };
}

test("the catalog answer is validated and keyed as the wire keys it", () => {
  assert.equal(frameXmlGlyphCatalog({ ...CATALOG, version: 2 }, 1), undefined, "another route version is refused");
  assert.equal(frameXmlGlyphCatalog({ version: 1 }, 1), undefined);
  const catalog = frameXmlGlyphCatalog(CATALOG, 1);
  assert.deepEqual({ ...catalog.glyph(319) }, { spellId: 56370, slotFlags: 0, icon: "Interface\\Spellbook\\UI-Glyph-Rune-11" });
  assert.deepEqual({ ...catalog.slot(22) }, { type: 1 });
  assert.equal(catalog.glyphForSpell(58241), 451);
  assert.equal(catalog.glyphForSpell(116), undefined, "an ordinary spell is no glyph");
});

test("GetGlyphSocketInfo: enabled bit, GlyphSlot type + 1, the glyph's spell and rune, nil for the unknown", () => {
  const { host, state } = harness();
  const info = (...args) => [...FRAMEXML_GLYPH_BINDINGS.GetGlyphSocketInfo(host, args)];
  assert.deepEqual(info(1), [true, 1, 56370, "Interface\\Spellbook\\UI-Glyph-Rune-11"], "major socket, filled");
  assert.deepEqual(info(2), [true, 2, 57925, undefined], "minor socket; a row without an icon is nil (stock's Rune1 fallback)");
  assert.deepEqual(info(3), [true, 2, undefined, undefined], "open and empty");
  assert.deepEqual(info(5), [false, 2, undefined, undefined], "locked by PLAYER_GLYPHS_ENABLED");
  assert.deepEqual(info(2, 1), info(2), "the active group passed explicitly");
  assert.deepEqual(info(1, 2), [true, 1, undefined, undefined], "a group the packet did not carry is nil, not empty data");
  assert.deepEqual(info(0), [], "socket out of range");
  assert.deepEqual(info(7), []);
  state.mask = undefined;
  assert.deepEqual(info(1), [], "no player object: nothing is known");
  state.mask = 0x0f;
  state.catalog = undefined;
  assert.deepEqual(info(1), [true, undefined, undefined, undefined], "no catalog: only the enabled bit is known");
  assert.deepEqual([...FRAMEXML_GLYPH_BINDINGS.GetNumGlyphSockets(host, [])], [FRAMEXML_GLYPH_SOCKETS]);
  assert.deepEqual([...FRAMEXML_GLYPH_BINDINGS.GetNumGlyphSockets({}, [])], [0]);
  assert.deepEqual([...FRAMEXML_GLYPH_BINDINGS.GetGlyphSocketInfo({}, [1])], []);
});

test("a glyph item raises USE_GLYPH and the cursor only while stock owns glyphs; the socket is the realm's to accept", () => {
  const { model, host, calls, events, state } = harness();
  const item = { guid: 0x55n, bag: 1, slot: 3, spellId: 56590 };
  assert.equal(model.useItem(item), false, "not owned: the ordinary use goes out");
  model.owned = true;
  assert.equal(model.useItem({ ...item, spellId: 116 }), false, "an ordinary item is used as before");
  assert.deepEqual(events, []);
  assert.equal(model.useItem(item), true);
  assert.deepEqual(events, [["USE_GLYPH"]]);
  assert.deepEqual([...FRAMEXML_GLYPH_BINDINGS.SpellIsTargeting(host, [])], [1]);
  // Spell::EffectApplyGlyph compares GlyphSlotFlags with GlyphSlot.Type; a locked socket cannot take it.
  const matches = (socket) => FRAMEXML_GLYPH_BINDINGS.GlyphMatchesSocket(host, [socket])[0];
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(matches), [true, false, false, true, false, false]);
  FRAMEXML_GLYPH_BINDINGS.PlaceGlyphInSocket(host, [4]);
  assert.deepEqual(calls, [["place", 319, 1, 3, 3]], "CMSG_USE_ITEM for that bag slot with the zero-based socket");
  assert.equal(model.targeting, undefined, "the cursor is spent");
  assert.deepEqual([...FRAMEXML_GLYPH_BINDINGS.GlyphMatchesSocket(host, [1])], [false]);
  FRAMEXML_GLYPH_BINDINGS.PlaceGlyphInSocket(host, [1]);
  assert.equal(calls.length, 1, "no cursor, nothing sent");

  model.useItem(item);
  assert.deepEqual([...FRAMEXML_GLYPH_BINDINGS.SpellStopTargeting(host, [])], [1], "Escape drops the glyph cursor");
  assert.equal(model.targeting, undefined);
  model.useItem(item);
  state.holds = false;
  model.tick();
  assert.equal(model.targeting, undefined, "the item left its slot: the cursor goes with it");
  FRAMEXML_GLYPH_BINDINGS.RemoveGlyphFromSocket(host, [2]);
  FRAMEXML_GLYPH_BINDINGS.RemoveGlyphFromSocket(host, [9]);
  assert.deepEqual(calls.at(-1), ["remove", 1], "CMSG_REMOVE_GLYPH with the zero-based socket; out of range sends nothing");
});

test("GetGlyphLink is TrinityCore's glyph hyperlink over GlyphSlot and GlyphProperties ids", () => {
  const { host } = harness({ names: { 56370: "Символ ледяной стрелы" } });
  assert.deepEqual([...FRAMEXML_GLYPH_BINDINGS.GetGlyphLink(host, [1])],
    ["|cff66bbff|Hglyph:21:319|h[Символ ледяной стрелы]|h|r"]);
  assert.deepEqual([...FRAMEXML_GLYPH_BINDINGS.GetGlyphLink(host, [2])], [], "the spell name has not resolved");
  assert.deepEqual([...FRAMEXML_GLYPH_BINDINGS.GetGlyphLink(host, [3])], [], "an empty socket has no link");
});

test("the per-frame compare fires GLYPH_ADDED / REMOVED / UPDATED with the socket id, once", () => {
  const { model, state, events } = harness({ groups: { 1: [319, 451, 0, 0, 0, 0], 2: [0, 451, 319, 0, 0, 0] } });
  model.tick();
  assert.deepEqual(events, [], "the first look is the baseline");
  state.groups[1] = [0, 451, 0, 319, 0, 0];
  model.tick();
  model.tick();
  assert.deepEqual(events, [["GLYPH_REMOVED", 1], ["GLYPH_ADDED", 4]]);
  events.length = 0;
  state.active = 2;
  model.tick();
  assert.deepEqual(events, [["GLYPH_ADDED", 3], ["GLYPH_REMOVED", 4]], "a talent-group swap moves sockets too");
  events.length = 0;
  state.groups[2] = [0, 451, 451, 0, 0, 0];
  model.tick();
  assert.deepEqual(events, [["GLYPH_UPDATED", 3]]);
  events.length = 0;
  state.session = {};
  state.groups[2] = [0, 0, 0, 0, 0, 0];
  model.tick();
  assert.deepEqual(events, [], "a replaced world session restarts the compare silently");
  let refreshed = 0;
  model.onCatalog = () => { refreshed += 1; };
  state.catalog = frameXmlGlyphCatalog(CATALOG, 1);
  model.tick();
  model.tick();
  assert.equal(refreshed, 1, "the catalog's arrival asks the owner to redraw once");
});

test("the live host reads the glyph fields, the talents packet, the bags and the gateway catalog", async () => {
  const fields = new Map([
    [UPDATE_FIELDS.PLAYER_GLYPHS_ENABLED.offset, 0x3f],
    ...[21, 22, 23, 24, 25, 26].map((id, index) => [UPDATE_FIELDS.PLAYER_FIELD_GLYPH_SLOTS_1.offset + index, id]),
    ...[319, 0, 0, 0, 0, 0].map((id, index) => [UPDATE_FIELDS.PLAYER_FIELD_GLYPHS_1.offset + index, id]),
  ]);
  const player = { guid: 1n, typeId: 4, fields };
  const sent = [];
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, player]]) },
    talents: { pet: false, unspentPoints: 0, activeSpec: 0, specs: [
      { talents: [], glyphs: [451, 0, 0, 0, 0, 0] },
      { talents: [], glyphs: [0, 451, 0, 0, 0, 0] },
    ] },
    useGlyphItem: (...args) => sent.push(["use", ...args]),
    removeGlyph: (slot) => sent.push(["remove", slot]),
  };
  const requests = [];
  const { model, prepare } = createLiveFrameXmlGlyphs({
    world: () => world,
    spellName: (id) => (id === 56370 ? "Символ ледяной стрелы" : undefined),
    gatewayOrigin: () => "http://127.0.0.1:8090",
    fetch: async (url) => { requests.push(url); return { ok: true, json: async () => CATALOG }; },
  });
  assert.deepEqual(model.socketInfo(1), [true, undefined, undefined, undefined], "before the catalog only the bit is known");
  await prepare();
  await prepare();
  assert.deepEqual(requests, [`http://127.0.0.1:8090${FRAMEXML_GLYPH_CATALOG_PATH}`], "fetched once");
  assert.deepEqual(model.socketInfo(1), [true, 1, 56370, "Interface\\Spellbook\\UI-Glyph-Rune-11"],
    "the active group reads PLAYER_FIELD_GLYPHS_1 ahead of the older packet");
  assert.deepEqual(model.socketInfo(2, 2), [true, 2, 57925, undefined], "the second group reads SMSG_TALENTS_INFO");
  assert.equal(model.link(1), "|cff66bbff|Hglyph:21:319|h[Символ ледяной стрелы]|h|r");
  model.remove(1);
  model.attach({ fire: () => 1 });
  model.owned = true;
  assert.equal(model.useItem({ guid: 9n, bag: 0, slot: 1, spellId: 56590 }), true);
  model.place(4);
  assert.deepEqual(sent, [["remove", 0]], "the item is no longer in that bag slot: nothing is inscribed");
  world.talents = undefined;
  assert.deepEqual(model.socketInfo(1), [true, 1, undefined, undefined], "no talents packet: no active group");
});

test("CMSG_USE_ITEM carries the zero-based glyph socket after the item guid", () => {
  const plain = buildUseItem(255, 23, 7, 0, 0x1234n);
  const glyph = buildUseItem(255, 23, 7, 0, 0x1234n, undefined, 3);
  assert.equal(plain.length, glyph.length);
  // bag, slot, castCount, spellId u32, guid u64 → the glyph index u32 at byte 15.
  assert.deepEqual([...glyph.subarray(15, 19)], [3, 0, 0, 0]);
  assert.deepEqual([...plain.subarray(15, 19)], [0, 0, 0, 0]);
  assert.deepEqual([...glyph.subarray(0, 15)], [...plain.subarray(0, 15)]);
  assert.deepEqual([...glyph.subarray(19)], [...plain.subarray(19)]);
});

test("the canned realm answers with the core's level lock and kind check", () => {
  assert.equal(frameXmlGlyphEnabledMask(14), 0);
  assert.equal(frameXmlGlyphEnabledMask(60), 0x0f);
  assert.equal(frameXmlGlyphEnabledMask(80), 0x3f);
  const { model, world } = createCannedFrameXmlGlyphs(() => 60);
  const events = [];
  model.attach({ fire: (...args) => { events.push(args); return 1; } });
  model.owned = true;
  model.tick();
  assert.equal(world.use(56593), true, "Glyph of Ice Lance");
  model.place(5);
  assert.deepEqual(world.sockets(), [319, 451, 0, 0, 0, 0], "socket 5 is locked at 60: SPELL_FAILED_GLYPH_SOCKET_LOCKED");
  world.use(56593);
  model.place(3);
  assert.deepEqual(world.sockets(), [319, 451, 0, 0, 0, 0], "socket 3 is minor: SPELL_FAILED_INVALID_GLYPH");
  world.use(56593);
  model.place(4);
  model.tick();
  assert.deepEqual(world.sockets(), [319, 451, 0, 322, 0, 0]);
  assert.deepEqual(events.slice(-1), [["GLYPH_ADDED", 4]]);
  assert.deepEqual(world.sent, [["place", 322, 4], ["place", 322, 2], ["place", 322, 3]]);
});

test("the route version is pinned on both sides", () => {
  assert.equal(FRAMEXML_GLYPH_CATALOG_VERSION, GLYPH_CATALOG_VERSION);
  assert.equal(CANNED_GLYPH_CATALOG.version, GLYPH_CATALOG_VERSION);
});

let dbcDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  dbcDirectory = paths.dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const { existsSync } = await import("node:fs");
const withDataset = { skip: dbcDirectory && existsSync(`${dbcDirectory}/GlyphSlot.dbc`) ? false : "no dataset DBCs on this machine" };

test("the gateway catalog over this dataset: six sockets, every glyph item resolves, the canned rows are measured", withDataset, async () => {
  const catalog = await loadGlyphCatalog(dbcDirectory);
  assert.equal(catalog.version, GLYPH_CATALOG_VERSION);
  const sockets = catalog.slots.filter((slot) => slot.order > 0).sort((a, b) => a.order - b.order);
  assert.deepEqual(sockets.map((slot) => slot.order), [1, 2, 3, 4, 5, 6],
    "InitGlyphsForLevel's six sockets (SetGlyphSlot(Tooltip - 1, ID))");
  assert.ok(sockets.every((slot) => slot.type === 0 || slot.type === 1));
  const glyphs = new Map(catalog.glyphs.map((glyph) => [glyph.id, glyph]));
  assert.ok(catalog.itemSpells.length > 300);
  assert.ok(catalog.itemSpells.every(([, glyph]) => glyphs.has(glyph)), "every APPLY_GLYPH MiscValue is a GlyphProperties row");
  for (const row of CANNED_GLYPH_CATALOG.glyphs) assert.deepEqual(glyphs.get(row.id), { ...row });
  for (const row of CANNED_GLYPH_CATALOG.slots) assert.deepEqual(catalog.slots.find((slot) => slot.id === row.id), { ...row });
  const spells = new Map(catalog.itemSpells);
  for (const [spell, glyph] of CANNED_GLYPH_CATALOG.itemSpells) assert.equal(spells.get(spell), glyph);
});
