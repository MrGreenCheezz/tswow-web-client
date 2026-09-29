import assert from "node:assert/strict";
import test from "node:test";

// The equipment manager's C API (FrameXmlEquipmentSets.ts) over a scripted host, the live host over a
// scripted WorldClient and its inventory fields (FrameXmlEquipmentSetsLive.ts), the three opcodes with
// the raw-1 ignore marker, the canned stand-in realm, and AbandonSkill through the seams.
const {
  FrameXmlEquipmentSetModel, FRAMEXML_EQUIPMENT_SET_BINDINGS, frameXmlEquipmentSetLocation,
  frameXmlEquipmentSetIcon, FRAMEXML_EQUIPMENT_SET_DEFAULT_ICON, FRAMEXML_EQUIPMENT_SET_MISSING_LOCATION,
} = await import("../dist/code/browser/framexml/FrameXmlEquipmentSets.js");
const { createLiveFrameXmlEquipmentSets, liveFrameXmlEquipmentSetPlace } = await import(
  "../dist/code/browser/framexml/FrameXmlEquipmentSetsLive.js");
const { createCannedFrameXmlEquipmentSets, CANNED_CARRIED_PIECE, CANNED_MISSING_PIECE_GUID, CANNED_SET_GUID_BASE } = await import(
  "../dist/code/browser/framexml/FrameXmlEquipmentSetsCanned.js");
const { buildEquipmentSetSave, buildEquipmentSetUse, EQUIPMENT_SET_IGNORED } = await import("../dist/code/world/CharacterProgressProtocol.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FrameXmlCursorModel } = await import("../dist/code/browser/framexml/FrameXmlCursor.js");
const { EventBus } = await import("../dist/code/world/EventBus.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { playerInventory } = await import("../dist/code/browser/Inventory.js");

// Constants.lua:189-192, :224, :229 — and EquipmentManager_UnpackLocation (EquipmentManager.lua:133-159) as written.
const LOCATION_PLAYER = 0x00100000;
const LOCATION_BAGS = 0x00200000;
const LOCATION_BANK = 0x00400000;
const BAG_BIT_OFFSET = 8;
const BANK_BAG_OFFSET = 4;
function unpackLocation(location) {
  if (location < 0) return { player: false, bank: false, bags: false, slot: 0 };
  const player = (location & LOCATION_PLAYER) !== 0;
  const bank = (location & LOCATION_BANK) !== 0;
  const bags = (location & LOCATION_BAGS) !== 0;
  if (player) location -= LOCATION_PLAYER;
  else if (bank) location -= LOCATION_BANK;
  if (bags) {
    location -= LOCATION_BAGS;
    let bag = location >> BAG_BIT_OFFSET;
    const slot = location - (bag << BAG_BIT_OFFSET);
    if (bank) bag += BANK_BAG_OFFSET;
    return { player, bank, bags, slot, bag };
  }
  return { player, bank, bags, slot: location };
}

const WORN_HEAD = 0x11n;
const CARRIED_MAIN = 0x12n;
const GONE_OFF = 0x13n;
const BANKED_RING = 0x14n;
const pieces = () => {
  const list = new Array(19).fill(0n);
  list[0] = WORN_HEAD;
  list[10] = BANKED_RING;
  list[15] = CARRIED_MAIN;
  list[16] = GONE_OFF;
  list[18] = 1n;
  return list;
};

function harness() {
  const calls = [];
  const events = [];
  const state = {
    sets: [
      { guid: 0xa1n, setId: 1, name: "Танк", icon: "INV_Shield_04", pieces: pieces() },
      { guid: 0xa0n, setId: 0, name: "Бой", icon: "Interface\\Icons\\INV_Sword_04", pieces: pieces() },
    ],
    places: new Map([
      [WORN_HEAD, { place: { kind: "worn", slot: 1 }, bag: 255, slot: 0 }],
      [CARRIED_MAIN, { place: { kind: "bag", bagId: 2, slot: 7 }, bag: 20, slot: 6 }],
      [BANKED_RING, { place: { kind: "bank", slot: 3 }, bag: 255, slot: 41 }],
    ]),
    worn: new Map([[1, { guid: WORN_HEAD, entry: 2000, texture: "Interface\\Icons\\INV_Helmet_01" }],
      [5, { guid: 0x15n, entry: 2005, texture: "Interface\\Icons\\INV_Chest_Cloth_17" }]]),
    finished: undefined,
    session: {},
  };
  const model = new FrameXmlEquipmentSetModel({
    sets: () => state.sets,
    locate: (guid) => state.places.get(guid),
    itemId: (guid) => (guid === WORN_HEAD ? 2000 : guid === CARRIED_MAIN ? 2016 : guid === BANKED_RING ? 2011 : undefined),
    wornGuid: (slot) => state.worn.get(slot)?.guid ?? 0n,
    wornTexture: (slot) => state.worn.get(slot)?.texture,
    macroIcon: (index) => (index >= 1 && index <= 3 ? `Interface\\Icons\\Macro_${index}` : undefined),
    macroIconCount: () => 3,
    save: (...args) => calls.push(["save", ...args]),
    use: (list, finished) => { calls.push(["use", list]); state.finished = finished; },
    remove: (guid) => calls.push(["delete", guid]),
    session: () => state.session,
  });
  model.attach({ fire: (event, ...args) => { events.push([event, ...args]); return 1; } });
  const cursor = [];
  const host = { equipmentSets: model, cursor: { pickupEquipmentSet: (id) => cursor.push(id) }, getCVarBool: () => undefined };
  return { model, state, calls, events, host, cursor };
}

test("packed locations decode with EquipmentManager_UnpackLocation exactly", () => {
  assert.deepEqual(unpackLocation(frameXmlEquipmentSetLocation({ kind: "worn", slot: 5 })),
    { player: true, bank: false, bags: false, slot: 5 });
  assert.deepEqual(unpackLocation(frameXmlEquipmentSetLocation({ kind: "bag", bagId: 2, slot: 7 })),
    { player: true, bank: false, bags: true, slot: 7, bag: 2 });
  assert.deepEqual(unpackLocation(frameXmlEquipmentSetLocation({ kind: "bag", bagId: 0, slot: 16 })),
    { player: true, bank: false, bags: true, slot: 16, bag: 0 }, "the backpack is stock bag 0");
  assert.deepEqual(unpackLocation(frameXmlEquipmentSetLocation({ kind: "bank", slot: 3 })),
    { player: false, bank: true, bags: false, slot: 42 }, "BankButtonIDToInvSlotID: 39 + slot");
  assert.deepEqual(unpackLocation(frameXmlEquipmentSetLocation({ kind: "bankBag", bagId: 6, slot: 2 })),
    { player: false, bank: true, bags: true, slot: 2, bag: 6 }, "the unpacker adds ITEM_INVENTORY_BANK_BAG_OFFSET back");
  assert.deepEqual(unpackLocation(FRAMEXML_EQUIPMENT_SET_MISSING_LOCATION), { player: false, bank: false, bags: false, slot: 0 });
  assert.equal(frameXmlEquipmentSetIcon("INV_Shield_04"), "Interface\\Icons\\INV_Shield_04");
  assert.equal(frameXmlEquipmentSetIcon(""), FRAMEXML_EQUIPMENT_SET_DEFAULT_ICON);
  assert.equal(frameXmlEquipmentSetIcon("Interface\\Icons\\INV_Sword_04"), "Interface\\Icons\\INV_Sword_04");
});

test("GetEquipmentSetInfo counts each piece where it is, in the client's name order", () => {
  const { host } = harness();
  const call = (name, ...args) => [...FRAMEXML_EQUIPMENT_SET_BINDINGS[name](host, args)];
  assert.deepEqual(call("GetNumEquipmentSets"), [2]);
  assert.deepEqual(call("GetEquipmentSetInfo", 1),
    ["Бой", "Interface\\Icons\\INV_Sword_04", 0, false, 4, 1, 2, 1, 1],
    "name, icon, setID, isEquipped, numItems, numEquipped, numInventory (bag + bank), numMissing, numIgnored");
  assert.deepEqual(call("GetEquipmentSetInfo", 2).slice(0, 3), ["Танк", "Interface\\Icons\\INV_Shield_04", 1], "a bare icon name is a path");
  assert.deepEqual(call("GetEquipmentSetInfo", 3), []);
  assert.deepEqual(call("GetEquipmentSetInfoByName", "Танк").slice(0, 2), ["Interface\\Icons\\INV_Shield_04", 1]);
  assert.deepEqual(call("GetEquipmentSetInfoByName", "Нет"), [], "stock tests the first value for an overwrite prompt");
  assert.deepEqual(call("GetEquipmentSetItemIDs", "Бой"), [[2000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2011, 0, 0, 0, 0, 2016, 0, 0, 1]],
    "one table: item ids, 0 empty, 0 for a piece not in hand, 1 ignored");
  const [locations] = call("GetEquipmentSetLocations", "Бой");
  assert.equal(locations.length, 19);
  assert.deepEqual(unpackLocation(locations[0]), { player: true, bank: false, bags: false, slot: 1 });
  assert.deepEqual(unpackLocation(locations[15]), { player: true, bank: false, bags: true, slot: 7, bag: 2 });
  assert.deepEqual(unpackLocation(locations[10]), { player: false, bank: true, bags: false, slot: 42 });
  assert.equal(locations[16], FRAMEXML_EQUIPMENT_SET_MISSING_LOCATION);
  assert.equal(locations[18], 1);
  assert.equal(locations[1], 0);
  assert.deepEqual(call("GetEquipmentSetLocations", "Нет"), []);
  assert.deepEqual(call("EquipmentSetContainsLockedItems", "Бой"), [false]);
  assert.deepEqual([...FRAMEXML_EQUIPMENT_SET_BINDINGS.GetNumEquipmentSets({ getCVarBool: () => undefined }, [])], [0], "no model");
  assert.deepEqual([...FRAMEXML_EQUIPMENT_SET_BINDINGS.GetEquipmentSetInfo({ getCVarBool: () => undefined }, [1])], []);
});

test("SaveEquipmentSet sends what is worn with the ignored slots as 1, under the free index or the overwritten set's", () => {
  const { host, calls, model } = harness();
  const call = (name, ...args) => [...FRAMEXML_EQUIPMENT_SET_BINDINGS[name](host, args)];
  call("EquipmentManagerIgnoreSlotForSave", 19);
  call("EquipmentManagerIgnoreSlotForSave", 4);
  assert.deepEqual(call("EquipmentManagerIsSlotIgnoredForSave", 4), [true]);
  call("EquipmentManagerUnignoreSlotForSave", 4);
  assert.deepEqual(call("EquipmentManagerIsSlotIgnoredForSave", 4), [false]);
  call("SaveEquipmentSet", "Рейд", -5);
  assert.equal(calls.length, 1);
  const [, guid, index, name, icon, saved] = calls[0];
  assert.deepEqual([guid, index, name, icon], [0n, 2, "Рейд", "Interface\\Icons\\INV_Chest_Cloth_17"],
    "a new set: guid 0, the lowest free index (0 and 1 are taken), the worn chest's own picture for -5");
  assert.deepEqual(saved.map(String), [String(WORN_HEAD), "0", "0", "0", String(0x15n), ...new Array(13).fill("0"), "1"],
    "the worn guids, 0 for empty slots, 1 for the ignored tabard");
  call("SaveEquipmentSet", "Бой", 2);
  assert.deepEqual(calls[1].slice(1, 5), [0xa0n, 0, "Бой", "Interface\\Icons\\Macro_2"], "an existing name: its guid and index, a macro icon");
  call("SaveEquipmentSet", "Танк", 9);
  assert.equal(calls[2][4], "Interface\\Icons\\INV_Shield_04", "past the icon list: the set's own texture (the popup's special icon)");
  call("SaveEquipmentSet", "Новый", 99);
  assert.equal(calls[3][4], FRAMEXML_EQUIPMENT_SET_DEFAULT_ICON, "a new set with no picture in reach");
  call("SaveEquipmentSet", "Путь", "Interface\\Icons\\INV_Boots_01");
  assert.equal(calls[4][4], "Interface\\Icons\\INV_Boots_01", "an add-on's texture path is taken as is");
  call("EquipmentManagerClearIgnoredSlotsForSave");
  assert.equal(model.isSlotIgnored(19), false);
  call("ModifyEquipmentSet", "Танк", "Защита", -1);
  assert.deepEqual(calls[5].slice(1, 5), [0xa1n, 1, "Защита", "Interface\\Icons\\INV_Helmet_01"]);
  assert.deepEqual(calls[5][5].map(String), pieces().map(String), "the same pieces");
  call("ModifyEquipmentSet", "Танк", "Щит");
  assert.equal(calls[6][4], "Interface\\Icons\\INV_Shield_04", "no icon argument keeps the set's");
  call("DeleteEquipmentSet", "Бой");
  call("DeleteEquipmentSet", "Нет");
  assert.deepEqual(calls[7], ["delete", 0xa0n]);
  assert.equal(calls.length, 8);
  call("SaveEquipmentSet", "", 1);
  assert.equal(calls.length, 8, "an empty name sends nothing");
});

test("UseEquipmentSet names each piece's position, keeps ignored and missing slots as 1, and EQUIPMENT_SWAP_FINISHED follows the result", () => {
  const { host, calls, events, state } = harness();
  FRAMEXML_EQUIPMENT_SET_BINDINGS.UseEquipmentSet(host, ["Бой"]);
  assert.equal(calls.length, 1);
  const [, used] = calls[0];
  assert.equal(used.length, 19);
  assert.deepEqual(used[0], { guid: WORN_HEAD, bag: 255, slot: 0 });
  assert.deepEqual(used[15], { guid: CARRIED_MAIN, bag: 20, slot: 6 });
  assert.deepEqual(used[10], { guid: BANKED_RING, bag: 255, slot: 41 });
  assert.deepEqual(used[16], { guid: 1n, bag: 0, slot: 0 }, "a missing piece leaves the slot alone rather than stripping it");
  assert.deepEqual(used[18], { guid: 1n, bag: 0, slot: 0 }, "the set's own ignored slot");
  assert.deepEqual(used[1], { guid: 0n, bag: 0, slot: 0 }, "an empty slot in the set empties the slot");
  assert.deepEqual(events, []);
  state.finished(true);
  assert.deepEqual(events, [["EQUIPMENT_SWAP_FINISHED", true, "Бой"]]);
  events.length = 0;
  FRAMEXML_EQUIPMENT_SET_BINDINGS.UseEquipmentSet(host, ["Нет"]);
  assert.equal(calls.length, 1, "an unknown name sends nothing");
  state.finished(false);
  assert.deepEqual(events, [["EQUIPMENT_SWAP_FINISHED", false, "Бой"]]);
});

test("the list's edges fire EQUIPMENT_SETS_CHANGED once; the cursor lifts a set by index or name", () => {
  const { model, state, events, host, cursor } = harness();
  model.tick();
  model.tick();
  assert.deepEqual(events, [], "the first look is the baseline");
  state.sets = [...state.sets, { guid: 0n, setId: 2, name: "Рейд", icon: "", pieces: pieces() }];
  model.tick();
  model.tick();
  assert.deepEqual(events, [["EQUIPMENT_SETS_CHANGED"]]);
  events.length = 0;
  state.sets = state.sets.map((set) => (set.setId === 2 ? { ...set, guid: 0xa2n } : set));
  model.tick();
  assert.deepEqual(events, [["EQUIPMENT_SETS_CHANGED"]], "SMSG_EQUIPMENT_SET_SAVED naming the guid is an edge too");
  events.length = 0;
  state.session = {};
  state.sets = [];
  model.tick();
  assert.deepEqual(events, [], "a replaced world session restarts the compare silently");
  state.sets = [{ guid: 0xa1n, setId: 1, name: "Танк", icon: "", pieces: pieces() }];
  model.tick();
  FRAMEXML_EQUIPMENT_SET_BINDINGS.PickupEquipmentSet(host, [1]);
  FRAMEXML_EQUIPMENT_SET_BINDINGS.PickupEquipmentSetByName(host, ["Танк"]);
  FRAMEXML_EQUIPMENT_SET_BINDINGS.PickupEquipmentSetByName(host, ["Нет"]);
  FRAMEXML_EQUIPMENT_SET_BINDINGS.PickupEquipmentSet(host, [7]);
  assert.deepEqual(cursor, [1, 1]);
  assert.equal(model.iconOf(1), FRAMEXML_EQUIPMENT_SET_DEFAULT_ICON);
  assert.deepEqual([...FRAMEXML_EQUIPMENT_SET_BINDINGS.CanUseEquipmentSets({ getCVarBool: (name) => name === "equipmentManager" }, [])], [true]);
  assert.deepEqual([...FRAMEXML_EQUIPMENT_SET_BINDINGS.CanUseEquipmentSets(host, [])], [false]);
});

test("the cursor carries a lifted set with its picture and puts it on a bar as ACTION_BUTTON_EQUIPMENT_SET", () => {
  const { model } = harness();
  const placed = [];
  const buttons = new Map();
  const cursor = new FrameXmlCursorModel({
    cursorInfo: () => [], cursorHasItem: () => false, clearCursor: () => {}, spellIsPassive: () => false,
    itemInfo: () => undefined, macros: undefined, equipmentSets: model,
    actionButton: (slot) => buttons.get(slot),
    setActionButton: (slot, action, type) => { placed.push([slot, action, type]); buttons.set(slot, { action, type }); return true; },
    spellBookSpellId: () => undefined, spellInfo: () => undefined, spellTexture: () => undefined, itemTexture: () => undefined,
  });
  cursor.attach({ fire: () => 1, now: () => 0 });
  cursor.pickupEquipmentSet(1);
  assert.deepEqual(cursor.held(), { kind: "equipmentset", id: 1 });
  assert.deepEqual([...cursor.info()], ["equipmentset"]);
  assert.equal(cursor.picture(), "Interface\\Icons\\INV_Shield_04", "GetCursorInfo's picture is the set's icon");
  assert.equal(cursor.placeAction(12), true);
  assert.deepEqual(placed, [[12, 1, 0x20]]);
  assert.equal(cursor.held(), undefined);
  cursor.pickupEquipmentSet(-1);
  assert.equal(cursor.held(), undefined, "no such index");
});

test("the live host reads the sets and the inventory fields, and waits on EQUIPMENT_SET_USE_RESULT", () => {
  const player = { guid: 1n, typeId: 4, fields: new Map() };
  const guidField = (offset, guid) => { player.fields.set(offset, Number(guid & 0xffffffffn)); player.fields.set(offset + 1, Number(guid >> 32n)); };
  guidField(UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset, WORN_HEAD);
  guidField(UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 2 * 2, CARRIED_MAIN);
  const item = (guid, entry) => [guid, { guid, typeId: 1, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry]]) }];
  const events = new EventBus();
  const sent = [];
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, player], item(WORN_HEAD, 2000), item(CARRIED_MAIN, 2016)]) },
    equipmentSets: [{ guid: 0xa0n, setId: 0, name: "Бой", icon: "Interface\\Icons\\INV_Sword_04", pieces: pieces() }],
    saveEquipmentSet: (...args) => sent.push(["save", ...args]),
    useEquipmentSet: (list) => sent.push(["use", list]),
    deleteEquipmentSet: (guid) => sent.push(["delete", guid]),
    events,
  };
  const inventory = playerInventory(world.state);
  assert.deepEqual(liveFrameXmlEquipmentSetPlace(inventory, WORN_HEAD), { place: { kind: "worn", slot: 1 }, bag: 255, slot: 0 });
  assert.deepEqual(liveFrameXmlEquipmentSetPlace(inventory, CARRIED_MAIN), { place: { kind: "bag", bagId: 0, slot: 3 }, bag: 255, slot: 25 },
    "the backpack's third slot: stock bag 0 slot 3, opcode bag 255 slot 25");
  assert.equal(liveFrameXmlEquipmentSetPlace(inventory, GONE_OFF), undefined);
  const model = createLiveFrameXmlEquipmentSets({
    world: () => world,
    itemTexture: (entry) => (entry === 2000 ? "Interface\\Icons\\INV_Helmet_01" : undefined),
    macroIcon: (index) => (index === 1 ? "Interface\\Icons\\INV_Misc_QuestionMark" : undefined),
    macroIconCount: () => 1,
  });
  const fired = [];
  model.attach({ fire: (...args) => { fired.push(args); return 1; } });
  assert.deepEqual(model.info(1), ["Бой", "Interface\\Icons\\INV_Sword_04", 0, false, 4, 1, 1, 2, 1]);
  assert.deepEqual(model.itemIds("Бой").slice(0, 1), [2000]);
  model.save("Бой", -1);
  assert.deepEqual(sent[0].slice(0, 5), ["save", 0xa0n, 0, "Бой", "Interface\\Icons\\INV_Helmet_01"]);
  assert.deepEqual(sent[0][5].map(String), [String(WORN_HEAD), ...new Array(18).fill("0")], "only the head is worn; nothing ignored");
  model.use("Бой");
  assert.equal(sent[1][0], "use");
  assert.deepEqual(sent[1][1][15], { guid: CARRIED_MAIN, bag: 255, slot: 25 });
  assert.deepEqual(fired, []);
  events.emit("EQUIPMENT_SET_USE_RESULT", { result: 4 });
  events.emit("EQUIPMENT_SET_USE_RESULT", { result: 0 });
  assert.deepEqual(fired, [["EQUIPMENT_SWAP_FINISHED", false, "Бой"]], "one answer per use");
  model.remove("Бой");
  assert.deepEqual(sent[2], ["delete", 0xa0n]);
  assert.equal(createLiveFrameXmlEquipmentSets({ world: () => undefined, itemTexture: () => undefined, macroIcon: () => undefined, macroIconCount: () => 0 }).count(), 0);
});

test("the wire carries the ignore marker as the raw packed guid 1", () => {
  const list = new Array(19).fill(0n);
  list[0] = 0x1234n;
  list[18] = EQUIPMENT_SET_IGNORED;
  const save = buildEquipmentSetSave(0n, 2, "A", "B", list);
  // packed guid 0 (1 byte), u32 index, "A\0", "B\0", then the pieces: 0x1234 packs as [0x03, 0x34, 0x12].
  const piecesAt = 1 + 4 + 2 + 2;
  assert.deepEqual([...save.subarray(piecesAt, piecesAt + 3)], [0x03, 0x34, 0x12]);
  assert.deepEqual([...save.subarray(save.length - 2)], [0x01, 0x01], "the tabard's raw 1: mask 0x01, byte 1");
  const use = buildEquipmentSetUse([{ guid: EQUIPMENT_SET_IGNORED, bag: 0, slot: 0 }]);
  assert.deepEqual([...use.subarray(0, 4)], [0x01, 0x01, 0, 0]);
  assert.deepEqual([...use.subarray(4, 7)], [0x00, 0, 0], "an absent piece is packed guid 0");
});

test("the canned realm folds a save in, answers a use when told, and drops a deleted set", () => {
  const { model, world } = createCannedFrameXmlEquipmentSets({
    wornEntry: (slot) => (slot === 1 ? 13446 : undefined),
    wornTexture: (slot) => (slot === 1 ? "Interface\\Icons\\INV_Potion_54" : undefined),
    macroIcon: (index) => (index === 1 ? "Interface\\Icons\\INV_Misc_QuestionMark" : undefined),
    macroIconCount: () => 1,
  });
  const events = [];
  model.attach({ fire: (...args) => { events.push(args); return 1; } });
  model.tick();
  assert.deepEqual(model.info(1), ["Бой", "Interface\\Icons\\INV_Sword_04", 0, false, 3, 1, 1, 1, 1]);
  assert.deepEqual(model.itemIds("Бой")[15], CANNED_CARRIED_PIECE.entry);
  assert.equal(model.locations("Бой")[16], FRAMEXML_EQUIPMENT_SET_MISSING_LOCATION);
  model.use("Бой");
  assert.equal(world.sent[0][0], "use");
  assert.deepEqual(world.sent[0][1][16], { guid: 1n, bag: 0, slot: 0 }, `${CANNED_MISSING_PIECE_GUID} is gone: left alone`);
  assert.equal(world.answerUse(true), true);
  assert.equal(world.answerUse(true), false, "one answer per use");
  assert.deepEqual(events, [["EQUIPMENT_SWAP_FINISHED", true, "Бой"]]);
  events.length = 0;
  model.ignoreSlot(19);
  model.save("Рейд", 1);
  assert.deepEqual(world.sent[1].slice(0, 5), ["save", 0n, 1, "Рейд", "Interface\\Icons\\INV_Misc_QuestionMark"]);
  assert.equal(world.sets().length, 2);
  assert.equal(world.sets()[1].guid, CANNED_SET_GUID_BASE + 1n, "SMSG_EQUIPMENT_SET_SAVED's guid");
  model.tick();
  assert.deepEqual(events, [["EQUIPMENT_SETS_CHANGED"]]);
  model.remove("Рейд");
  assert.deepEqual(world.sent[2], ["delete", CANNED_SET_GUID_BASE + 1n]);
  assert.equal(world.sets().length, 1);
});

test("the canned seam answers the manager, and AbandonSkill unlearns only a profession row", () => {
  const seam = new CannedWorldSeam();
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  assert.deepEqual(call("GetNumEquipmentSets"), [1]);
  assert.deepEqual(call("GetEquipmentSetInfo", 1), ["Бой", "Interface\\Icons\\INV_Sword_04", 0, false, 3, 1, 1, 1, 1],
    "the canned potion in the head slot is the worn piece; a backpack piece; a gone one; the tabard ignored");
  assert.deepEqual(call("CanUseEquipmentSets"), [false], "the client's default: the manager is off");
  call("UseEquipmentSet", "Бой");
  assert.equal(seam.equipmentSetWorld.sent.length, 1);
  // Row 2 is «Кузнечное дело» (category 11), row 5 «Первая помощь» (category 9).
  assert.equal(call("GetSkillLineInfo", 2)[7], true, "isAbandonable for a profession");
  assert.equal(call("GetSkillLineInfo", 5)[7], false, "not for a secondary skill");
  assert.equal(call("GetSkillLineInfo", 1)[7], false, "not for a header");
  call("AbandonSkill", 5);
  call("AbandonSkill", 1);
  call("AbandonSkill", 2);
  assert.deepEqual(seam.abandonedSkills, [164], "CMSG_UNLEARN_SKILL with the SkillLine id, for the profession alone");
});
