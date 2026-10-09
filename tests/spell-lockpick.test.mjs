// Plan item 2.05, «Взлом замка»: Pick Lock (1804), Kadgar's picks and the keys are OPEN_LOCK (33) with
// ImplicitTargetA 26 (TARGET_GAMEOBJECT_ITEM_TARGET) and Targets 0 — the gateway's `itemOrObject`
// (`/dbc/spells?v=14`). The original client ORs TARGET_FLAG_GAMEOBJECT_ITEM (0x4000) into the pending
// mask for that implicit target (Wow.exe 0x00809610), so the cursor takes a carried item
// (mask & 0x4010 → TARGET_FLAG_ITEM) or a game object in the world (mask & 0x4800 →
// TARGET_FLAG_GAMEOBJECT), 0x0080bc80. TrinityCore opens either (`Spell::EffectOpenLock`: the GO's
// lock, else the item's `LockID`).
import assert from "node:assert/strict";
import test from "node:test";

const cursor = await import("../dist/code/browser/game/SpellCursor.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { buildCastSpellTargeted, buildUseItemTargeted } = await import("../dist/code/world/SpellTargets.js");

const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;
const box = { typeId: 1, guid: 0x303n, fields: new Map([[ENTRY, 4632]]) };
const chest = { typeId: 5, guid: 0xF110_0000_0000_0042n, fields: new Map([[ENTRY, 2843]]) };

function world() {
  const calls = [];
  return {
    calls,
    mapId: 0,
    state: { objects: new Map([[box.guid, box], [chest.guid, chest]]) },
    itemTemplates: new Map([[4632, { flags: 0, inventoryType: 0 }]]),
    castSpellOnItem(...args) { calls.push(["castSpellOnItem", ...args]); },
    castSpellOnGameObject(...args) { calls.push(["castSpellOnGameObject", ...args]); return true; },
    useItemOnItem(...args) { calls.push(["useItemOnItem", ...args]); return true; },
    useItemOnGameObject(...args) { calls.push(["useItemOnGameObject", ...args]); return true; },
  };
}

const PICK_LOCK = { itemOrObject: true, requiredTargetMode: 0, effects: [33, 0, 0], recoveryTime: 0, categoryRecoveryTime: 0 };

test("itemOrObject raises the item cursor that also takes a game object", () => {
  assert.equal(cursor.isItemTargetSpell(PICK_LOCK), true);
  assert.equal(cursor.isItemTargetSpell({ requiredTargetMode: 0 }), false);
  assert.equal(cursor.spellTargetsObject(PICK_LOCK), true);
  assert.equal(cursor.spellTargetsObject({ requiredTargetMode: 2 }), false, "a poison takes only items");
});

test("Pick Lock on a locked box in the bags: CMSG_CAST_SPELL with TARGET_FLAG_ITEM", () => {
  cursor.cancelItemTarget();
  const live = world();
  assert.equal(cursor.armItemTarget(live, 1804, undefined, true), true);
  assert.equal(cursor.pendingItemTarget(live)?.orObject, true);
  assert.equal(cursor.targetItemWithCursor(box, box.guid, live, () => PICK_LOCK).kind, "sent");
  assert.deepEqual(live.calls, [["castSpellOnItem", 1804, box.guid, 0, false]]);
  assert.equal(cursor.pendingItemTarget(live), undefined);
});

test("Pick Lock on a chest in the world: CMSG_CAST_SPELL with TARGET_FLAG_GAMEOBJECT; items-only cursors ignore it", () => {
  cursor.cancelItemTarget();
  const live = world();
  cursor.armItemTarget(live, 1804, undefined, true);
  assert.equal(cursor.targetGameObjectWithCursor(chest.guid, live, () => PICK_LOCK).kind, "sent");
  assert.deepEqual(live.calls, [["castSpellOnGameObject", 1804, chest.guid, 0, false]]);
  assert.equal(cursor.pendingItemTarget(live), undefined);

  cursor.armItemTarget(live, 13262);
  assert.equal(cursor.targetGameObjectWithCursor(chest.guid, live, () => ({ requiredTargetMode: 2 })).kind, "none");
  assert.equal(cursor.pendingItemTarget(live)?.spellId, 13262, "Disenchant stays up over a chest");
  cursor.cancelItemTarget();
  cursor.armItemTarget(live, 1804, undefined, true);
  assert.equal(cursor.targetGameObjectWithCursor(box.guid, live, () => PICK_LOCK).kind, "none", "an item is not an object");
  cursor.cancelItemTarget();
});

test("a key or pick item: its own spell on the chest is CMSG_USE_ITEM with the object", () => {
  cursor.cancelItemTarget();
  const live = world();
  cursor.armItemTarget(live, 19646, { bag: 255, slot: 24, guid: 0x404n }, true);
  assert.equal(cursor.targetGameObjectWithCursor(chest.guid, live, () => PICK_LOCK).kind, "sent");
  assert.deepEqual(live.calls, [["useItemOnGameObject", 255, 24, 0x404n, 19646, chest.guid]]);
});

test("the wire: TARGET_FLAG_GAMEOBJECT (0x800) and a packed object guid", () => {
  const cast = buildCastSpellTargeted(1804, 3, { gameObject: chest.guid });
  // u8 castCount, u32 spellId, u8 castFlags, u32 mask, packed guid
  assert.deepEqual([...cast.subarray(0, 10)], [3, 0x0c, 0x07, 0, 0, 0, 0x00, 0x08, 0, 0]);
  const use = buildUseItemTargeted(255, 24, 1, 19646, 0x404n, { gameObject: chest.guid });
  assert.equal(new DataView(use.buffer, use.byteOffset).getUint32(20, true), 0x800);
  game.world = undefined;
});

test("WorldClient.castSpellOnGameObject: a known spell at an object in view, one CMSG_CAST_SPELL (0x800)", async () => {
  const { WorldClient } = await import("../dist/code/world/WorldClient.js");
  const { OPCODES } = await import("../dist/code/generated/opcodes.js");
  const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
  const queue = [{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(4).toUint8Array() }];
  const connection = {
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return queue.length ? Promise.resolve(queue.shift()) : new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  await client.loginCharacter(1n);
  await new Promise((resolve) => setImmediate(resolve));
  client.state.selfGuid ??= 1n;
  client.state.objects.set(chest.guid, { ...chest, position: { x: 0, y: 0, z: 0 }, movementFlags: 0 });
  connection.sent.length = 0;
  assert.equal(client.castSpellOnGameObject(1804, chest.guid), false, "an unknown spell is not sent");
  client.knownSpells.push({ id: 1804 });
  assert.equal(client.castSpellOnGameObject(1804, 0x999n), false, "no such object");
  assert.equal(client.castSpellOnGameObject(1804, chest.guid), true);
  const casts = connection.sent.filter((packet) => packet.opcode === OPCODES.CMSG_CAST_SPELL);
  assert.equal(casts.length, 1);
  const view = new DataView(casts[0].payload.buffer, casts[0].payload.byteOffset);
  assert.equal(view.getUint32(1, true), 1804);
  assert.equal(view.getUint32(6, true), 0x800, "TARGET_FLAG_GAMEOBJECT");
  client.close?.();
});
