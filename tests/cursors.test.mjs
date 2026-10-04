import assert from "node:assert/strict";
import test from "node:test";
import {
  CURSOR_FILES, CURSOR_UNABLE_OFFSET, cursorCss, cursorFile, cursorTexturePath, iconCursor, meleeRange,
  stockCursorFile, worldObjectCursor,
} from "../dist/code/browser/input/Cursors.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

// 5.17: the client's cursor choice (Wow.exe 0x004F8190 → 0x004F7A50 units, 0x0070CE10 objects) and
// its table (0x00AD280C), offline.

const F = UPDATE_FIELDS;
const float = (value) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
};

function unitAt(guid, x, { typeId = 3, health = 100, flags = 0, npcFlags = 0, dynamic = 0, entry = 0, reach = 1.5, charmedBy = 0 } = {}) {
  return {
    guid, typeId,
    position: { x, y: 0, z: 0, orientation: 0 },
    fields: new Map([
      [F.OBJECT_FIELD_ENTRY.offset, entry],
      [F.UNIT_FIELD_HEALTH.offset, health],
      [F.UNIT_FIELD_MAXHEALTH.offset, 100],
      [F.UNIT_FIELD_FLAGS.offset, flags],
      [F.UNIT_NPC_FLAGS.offset, npcFlags],
      [F.UNIT_DYNAMIC_FLAGS.offset, dynamic],
      [F.UNIT_FIELD_COMBATREACH.offset, float(reach)],
      [F.UNIT_FIELD_CHARMEDBY.offset, charmedBy],
    ]),
  };
}

function gameObjectAt(guid, x, { type, entry = 50, flags = 0, dynamic = 0 }) {
  return {
    guid, typeId: 5,
    position: { x, y: 0, z: 0, orientation: 0 },
    fields: new Map([
      [F.OBJECT_FIELD_ENTRY.offset, entry],
      [F.GAMEOBJECT_BYTES_1.offset, type << 8],
      [F.GAMEOBJECT_FLAGS.offset, flags],
      [F.GAMEOBJECT_DYNAMIC.offset, dynamic],
    ]),
  };
}

function worldWith(objects, { creature = {}, gameObject = {}, quest = new Map(), loot } = {}) {
  const self = unitAt(1n, 0, { typeId: 4, reach: 1.5 });
  const map = new Map([[1n, self], ...objects.map((object) => [object.guid, object])]);
  return {
    self,
    state: { selfGuid: 1n, objects: map },
    creatureTemplate: (entry) => creature[entry],
    gameObjectTemplate: (entry) => gameObject[entry],
    questGiverStatus: quest,
    loot,
  };
}

function rules(overrides = {}) {
  return {
    reaction: () => 0,
    canAttack: () => false,
    autoLoot: () => false,
    gatherSpell: () => undefined,
    spellRange: () => undefined,
    lockCase: () => undefined,
    ...overrides,
  };
}

const template = (overrides = {}) => ({
  entry: 10, found: true, name: "", subName: "", cursorName: "", flags: 0, creatureType: 7, creatureFamily: 0,
  classification: 0, proxyCreatureIds: [], displayIds: [], healthModifier: 1, powerModifier: 1, leader: false,
  questItems: [], movementId: 0, ...overrides,
});

test("the table is Wow.exe's: 26 names, each with an Unable twin 26 ids on", () => {
  assert.equal(CURSOR_FILES.length, 27);
  assert.equal(cursorFile(1), "Point");
  assert.equal(cursorFile(4), "Attack");
  assert.equal(cursorFile(26), "vehichleCursor", "the file's own spelling");
  assert.equal(cursorFile(4 + CURSOR_UNABLE_OFFSET), "UnableAttack");
  assert.equal(cursorFile(52), "UnablevehichleCursor");
  assert.equal(cursorFile(53), undefined, "53 is a path of its own");
  assert.equal(CURSOR_FILES.includes("EngineerSkin"), false, "no engineering cursor in 3.3.5");
  assert.equal(stockCursorFile("ATTACK_CURSOR"), "Attack");
  assert.equal(stockCursorFile("loot_all_error_cursor"), "UnableLootAll");
  assert.equal(stockCursorFile("GATHER_CURSOR"), "GatherHerbs");
  assert.equal(stockCursorFile("LOCK_CURSOR"), "PickLock");
  assert.equal(stockCursorFile("Interface\\Cursor\\Point"), undefined);
  assert.equal(cursorTexturePath("UnableSkin"), "Interface\\Cursor\\UnableSkin.blp");
  assert.equal(iconCursor("speak", false), "Speak", "IconName is compared case-blind");
  assert.equal(iconCursor("Speak", true), "UnableSpeak");
  assert.equal(iconCursor("Directions", false), "Directions", "a name outside the table is a file of its own");
  assert.equal(iconCursor("Directions", true), "UnableDirections");
  assert.equal(iconCursor("Directions", true), iconCursor("Directions", true), "and is interned");
});

test("an NPC: quest status, then IconName, then the flags in Wow.exe's order; greyed past reach + 4", () => {
  const vendor = unitAt(2n, 3, { npcFlags: 0x80 | 0x1, entry: 10 });
  const world = worldWith([vendor], { creature: { 10: template() } });
  assert.equal(worldObjectCursor(world, vendor, 0, rules()), "Pickup", "a vendor's own flag is Pickup (0x004F7A50 bit 7 → 8)");
  vendor.fields.set(F.UNIT_NPC_FLAGS.offset, 0x1);
  assert.equal(worldObjectCursor(world, vendor, 0, rules()), "Speak", "gossip");
  vendor.fields.set(F.UNIT_NPC_FLAGS.offset, 0x1000 | 0x80 | 0x1);
  assert.equal(worldObjectCursor(world, vendor, 0, rules()), "RepairNPC", "repair outranks the vendor and gossip");
  vendor.fields.set(F.UNIT_NPC_FLAGS.offset, 0x20000);
  assert.equal(worldObjectCursor(world, vendor, 0, rules()), "Buy", "a banker is the coin bag");
  vendor.fields.set(F.UNIT_NPC_FLAGS.offset, 0x2000 | 0x10);
  assert.equal(worldObjectCursor(world, vendor, 0, rules()), "Taxi", "flight master before trainer");
  vendor.fields.set(F.UNIT_NPC_FLAGS.offset, 0x2);
  assert.equal(worldObjectCursor(world, vendor, 0, rules()), "", "a quest giver with nothing to say keeps the default");
  world.questGiverStatus.set(2n, 8);
  assert.equal(worldObjectCursor(world, vendor, 0, rules()), "Quest");
  world.questGiverStatus.set(2n, 6);
  assert.equal(worldObjectCursor(world, vendor, 0, rules()), "QuestRepeatable");
  world.questGiverStatus.set(2n, 10);
  assert.equal(worldObjectCursor(world, vendor, 0, rules()), "QuestTurnIn");
  world.questGiverStatus.set(2n, 1);
  vendor.fields.set(F.UNIT_NPC_FLAGS.offset, 0x80);
  world.creatureTemplate = () => template({ cursorName: "Directions" });
  assert.equal(worldObjectCursor(world, vendor, 0, rules()), "Directions", "the template's IconName comes before the flags");
  world.creatureTemplate = () => template({ cursorName: "Buy" });
  assert.equal(worldObjectCursor(world, vendor, 0, rules()), "Buy");
  // Combat reach 1.5 + 4 = 5.5 yards.
  vendor.position.x = 5.4;
  assert.equal(worldObjectCursor(world, vendor, 0, rules()), "Buy");
  vendor.position.x = 5.6;
  assert.equal(worldObjectCursor(world, vendor, 0, rules()), "UnableBuy");
  // Not interactable: hostile, uninteractible, charmed self.
  vendor.position.x = 3;
  assert.equal(worldObjectCursor(world, vendor, 0, rules({ reaction: () => -1 })), "", "a hostile NPC's services are not offered");
  vendor.fields.set(F.UNIT_FIELD_FLAGS.offset, 0x2000000);
  assert.equal(worldObjectCursor(world, vendor, 0, rules()), "");
});

test("a body: loot first (Pickup, LootAll with auto-loot), then gathering, greyed out of range", () => {
  const body = unitAt(3n, 2, { health: 0, dynamic: 0x1, entry: 20, flags: 0x4000000 });
  const world = worldWith([body], { creature: { 20: template({ flags: 0 }) } });
  // Melee range: max(5, 1.5 + 1.5 + 4/3) = 5.
  assert.equal(meleeRange(world.self, body), 5);
  assert.equal(worldObjectCursor(world, body, 0, rules()), "Pickup", "loot is the hand, not the bag");
  assert.equal(worldObjectCursor(world, body, 0, rules({ autoLoot: () => true })), "LootAll", "auto-loot is the bag");
  body.position.x = 6;
  assert.equal(worldObjectCursor(world, body, 0, rules()), "UnablePickup");
  world.loot = { guid: 3n };
  assert.equal(worldObjectCursor(world, body, 0, rules()), "Pickup", "the body being looted is never greyed");
  world.loot = undefined;
  // Looted: the skinnable branch, only with the spell.
  body.fields.set(F.UNIT_DYNAMIC_FLAGS.offset, 0);
  body.position.x = 2;
  assert.equal(worldObjectCursor(world, body, 0, rules()), "", "without the gathering spell: the default");
  const gather = rules({ gatherSpell: () => 8613, spellRange: () => 5 });
  assert.equal(worldObjectCursor(world, body, 0, gather), "Skin");
  world.creatureTemplate = () => template({ flags: 0x100 });
  assert.equal(worldObjectCursor(world, body, 0, gather), "GatherHerbs");
  world.creatureTemplate = () => template({ flags: 0x8000 });
  assert.equal(worldObjectCursor(world, body, 0, gather), "Mine", "engineering shows Mine (0x00715E50 case 3)");
  body.position.x = 6;
  assert.equal(worldObjectCursor(world, body, 0, gather), "UnableMine", "past the spell's range");
});

test("a unit to fight: Attack inside melee range, UnableAttack outside, nothing when pacified", () => {
  const mob = unitAt(4n, 4, { reach: 1.5 });
  const world = worldWith([mob]);
  const attack = rules({ canAttack: () => true });
  assert.equal(worldObjectCursor(world, mob, 0, attack), "Attack");
  mob.position.x = 5.1;
  assert.equal(worldObjectCursor(world, mob, 0, attack), "UnableAttack");
  world.self.fields.set(F.UNIT_FIELD_FLAGS.offset, 0x20000);
  assert.equal(worldObjectCursor(world, mob, 0, attack), "", "UNIT_FLAG_PACIFIED");
  world.self.fields.set(F.UNIT_FIELD_FLAGS.offset, 0);
  assert.equal(worldObjectCursor(world, mob, 0, rules()), "", "a unit that cannot be attacked: the default");
  assert.equal(worldObjectCursor(world, world.self, 0, attack), "", "never over the player itself");
});

test("a game object: IconName, else its type's own; greyed out of use range; no cursor for scenery", () => {
  const chest = gameObjectAt(5n, 3, { type: 3, entry: 50 });
  const lock = { 3: [{ type: 2, index: 3 }] };
  const world = worldWith([chest], {
    gameObject: { 50: { entry: 50, type: 3, iconName: "", name: "Жила", data: [7, 0, 0], displayId: 1, castBarCaption: "", size: 1 } },
  });
  const withLocks = rules({ lockCase: (id) => (id === 7 ? lock[3][0] : undefined) });
  assert.equal(worldObjectCursor(world, chest, 3, withLocks), "Mine", "lock 7's first case is LockType 3, Mining");
  chest.position.x = 6;
  assert.equal(worldObjectCursor(world, chest, 3, withLocks), "UnableMine", "past the 5-yard use range");
  chest.position.x = 3;
  assert.equal(worldObjectCursor(world, chest, 3, rules()), "Interact", "no lock name: Interact");
  world.gameObjectTemplate = () => ({ entry: 50, type: 3, iconName: "Taxi", name: "", data: [], displayId: 1, castBarCaption: "", size: 1 });
  assert.equal(worldObjectCursor(world, chest, 3, rules()), "Taxi", "the template's IconName first");
  const mailbox = gameObjectAt(6n, 3, { type: 19 });
  world.state.objects.set(6n, mailbox);
  world.gameObjectTemplate = () => ({ entry: 50, type: 19, iconName: "", name: "", data: [], displayId: 1, castBarCaption: "", size: 1 });
  assert.equal(worldObjectCursor(world, mailbox, 19, rules()), "Mail");
  mailbox.position.x = 11;
  assert.equal(worldObjectCursor(world, mailbox, 19, rules()), "UnableMail", "a mailbox is used from 10 yards");
  const text = gameObjectAt(7n, 2, { type: 9 });
  world.gameObjectTemplate = () => ({ entry: 50, type: 9, iconName: "", name: "", data: [], displayId: 1, castBarCaption: "", size: 1 });
  assert.equal(worldObjectCursor(world, text, 9, rules()), "Inspect");
  const generic = gameObjectAt(8n, 2, { type: 5 });
  assert.equal(worldObjectCursor(world, generic, 5, rules()), "", "a generic object has no cursor (0x00427A90)");
  const busy = gameObjectAt(9n, 2, { type: 3, flags: 0x1 });
  world.gameObjectTemplate = () => ({ entry: 50, type: 3, iconName: "", name: "", data: [], displayId: 1, castBarCaption: "", size: 1 });
  assert.equal(worldObjectCursor(world, busy, 3, rules()), "", "GO_FLAG_IN_USE: no cursor");
  const cond = gameObjectAt(10n, 2, { type: 3, flags: 0x4 });
  assert.equal(worldObjectCursor(world, cond, 3, rules()), "", "INTERACT_COND without the ACTIVATE dynamic flag");
  cond.fields.set(F.GAMEOBJECT_DYNAMIC.offset, 0x1);
  assert.equal(worldObjectCursor(world, cond, 3, rules()), "Interact");
});

test("without a picture the cursor is the keyword, and nothing is fetched without a texture route", () => {
  assert.equal(cursorCss("Attack"), "pointer");
  assert.equal(cursorCss("UnableAttack"), "not-allowed");
  assert.equal(cursorCss("Point"), "", "the default is the stylesheet's until its picture lands");
  assert.equal(cursorCss(""), "");
});

test("a picture comes once through the texture route, with its (0, 0) hotspot and the keyword behind it", async () => {
  const { useCursorPictures, onCursorPicture, resetCursorPictures, castCursorForBody } = await import("../dist/code/browser/input/Cursors.js");
  const properties = new Map();
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  globalThis.document = { documentElement: { style: {
    getPropertyValue: (name) => properties.get(name) ?? "",
    setProperty: (name, value) => properties.set(name, value),
  } } };
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(url);
    if (url.includes("UnableFishingCursor")) return { ok: false, status: 404 };
    return { ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }) };
  };
  let landed = 0;
  const stop = onCursorPicture(() => { landed += 1; });
  try {
    resetCursorPictures();
    useCursorPictures((path) => `http://gateway/texture?path=${encodeURIComponent(path)}`);
    assert.equal(cursorCss("Attack"), "pointer", "the keyword while the picture is on its way");
    assert.equal(cursorCss("Attack"), "pointer");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(asked, ["http://gateway/texture?path=Interface%5CCursor%5CAttack.blp"], "asked once");
    assert.match(cursorCss("Attack"), /^url\("blob:[^"]+"\) 0 0, pointer$/);
    assert.equal(landed, 1, "a stationary pointer is told to redraw");
    cursorCss("Cast");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(properties.get("--framexml-cast-cursor") ?? "", /^url\("blob:[^"]+"\) 0 0, crosshair$/,
      "the body-class cast cursor gets the same picture");
    properties.delete("--framexml-cast-cursor");
    castCursorForBody();
    assert.match(properties.get("--framexml-cast-cursor") ?? "", /^url\("blob:/, "and gets it back when its owner let it go");
    // A file the archive lacks is asked for once, not on every hover.
    assert.equal(cursorCss("UnableFishingCursor"), "not-allowed");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cursorCss("UnableFishingCursor"), "not-allowed");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(asked.filter((url) => url.includes("UnableFishingCursor")).length, 1);
  } finally {
    stop();
    resetCursorPictures();
    useCursorPictures(undefined);
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  }
});
