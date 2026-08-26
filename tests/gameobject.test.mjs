import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import {
  GO_TYPE_AREADAMAGE, GO_TYPE_CHAIR, GO_TYPE_CHEST, GO_TYPE_DOOR, GO_TYPE_FISHINGHOLE,
  GO_TYPE_FISHINGNODE, GO_TYPE_GOOBER, GO_TYPE_MAILBOX, GO_TYPE_QUESTGIVER, GO_TYPE_TRANSPORT,
  buildGameObjectQuery, buildGameObjectUse, interactionDistance, lockIdOf, parseGameObjectCustomAnim,
  parseGameObjectDespawnAnim, parseGameObjectQueryResponse, usableByHand,
} from "../dist/code/world/GameObjectProtocol.js";
import { LOCK_KEY_ITEM, LOCK_KEY_SKILL, LOCK_KEY_SPELL, spellForLock } from "../dist/code/world/LockRules.js";
import { buildCastSpell, buildCastSpellOnGameObject } from "../dist/code/world/SpellProtocol.js";

function queryResponse({ entry = 1731, type = GO_TYPE_CHEST, displayId = 324, name = "Copper Vein", icon = "", caption = "Mining" }) {
  const writer = new PacketWriter().u32(entry).u32(type).u32(displayId)
    .cString(name).cString("").cString("").cString("").cString(icon).cString(caption).cString("");
  for (let index = 0; index < 24; index++) writer.u32(index === 0 ? 1782 : 0);
  writer.f32(1);
  for (let index = 0; index < 6; index++) writer.u32(0);
  return writer.toUint8Array();
}

test("a game object template reads back whole", () => {
  const template = parseGameObjectQueryResponse(queryResponse({}));
  assert.ok(template);
  assert.equal(template.entry, 1731);
  assert.equal(template.type, GO_TYPE_CHEST);
  assert.equal(template.displayId, 324);
  assert.equal(template.name, "Copper Vein");
  assert.equal(template.castBarCaption, "Mining");
  assert.equal(template.data.length, 24);
  assert.equal(template.data[0], 1782, "a chest keeps its lock id in the first data word");
  assert.equal(template.size, 1);
});

test("an entry the server does not know answers in four bytes and stops", () => {
  // Bit 31 set means "never heard of it", and nothing follows — reading on would run off the end.
  const packet = new PacketWriter().u32(0x80000000 | 999_999).toUint8Array();
  assert.equal(parseGameObjectQueryResponse(packet), undefined);
});

test("the icon name survives, because one value of it makes an object unusable", () => {
  // The server refuses to hand back any object whose icon is "Point" before it checks anything
  // else, so a client that offered a button for one would be offering a silent no-op.
  const template = parseGameObjectQueryResponse(queryResponse({ icon: "Point" }));
  assert.equal(template.iconName, "Point");
});

test("using an object is eight plain bytes, not a packed guid", () => {
  assert.deepEqual([...buildGameObjectUse(0x0102030405060708n)],
    [0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);
  assert.equal(buildGameObjectQuery(1731, 5n).length, 12);
});

test("the animation packets are read", () => {
  const anim = new PacketWriter().u64(0xf1100000n).u32(3).toUint8Array();
  assert.deepEqual(parseGameObjectCustomAnim(anim), { guid: 0xf1100000n, animation: 3 });
  assert.equal(parseGameObjectDespawnAnim(new PacketWriter().u64(0xf1100000n).toUint8Array()), 0xf1100000n);
});

test("only the types the server's own use handler accepts are offered", () => {
  // A door, a lever, a quest object, a chair and a portal are used directly.
  for (const type of [GO_TYPE_DOOR, GO_TYPE_QUESTGIVER, GO_TYPE_CHAIR, GO_TYPE_GOOBER]) {
    assert.equal(usableByHand(type), true, `type ${type} should be usable`);
  }
  // A chest is not in that switch at all — it is opened by casting at it. A mailbox has its own
  // packet. A transport and an area trigger are not usable by anyone.
  for (const type of [GO_TYPE_CHEST, GO_TYPE_MAILBOX, GO_TYPE_TRANSPORT, GO_TYPE_AREADAMAGE]) {
    assert.equal(usableByHand(type), false, `type ${type} should not be usable by hand`);
  }
});

test("interaction range is per type, not a flat five yards", () => {
  assert.equal(interactionDistance(GO_TYPE_DOOR), 5);
  assert.equal(interactionDistance(GO_TYPE_CHAIR), 3, "a chair has to be sat in from close up");
  assert.equal(interactionDistance(GO_TYPE_FISHINGNODE), 100, "a bobber is far away by design");
  assert.equal(interactionDistance(GO_TYPE_MAILBOX), 10);
  assert.equal(interactionDistance(GO_TYPE_AREADAMAGE), 0, "never usable at any distance");
  assert.ok(interactionDistance(GO_TYPE_QUESTGIVER) > 5.5);
});

test("the lock id lives in a different data word for different types", () => {
  const template = (type, data) => ({ entry: 1, type, displayId: 0, name: "", iconName: "",
    castBarCaption: "", data, size: 1 });
  const words = Array.from({ length: 24 }, (_, index) => index * 100);
  // A door and a lever keep it second, a fishing hole fifth, everything else that has one first.
  assert.equal(lockIdOf(template(GO_TYPE_DOOR, words)), 100);
  assert.equal(lockIdOf(template(GO_TYPE_CHEST, words)), 0);
  assert.equal(lockIdOf(template(GO_TYPE_QUESTGIVER, words)), 0);
  assert.equal(lockIdOf(template(GO_TYPE_FISHINGHOLE, words)), 400);
  // A type with no lock at all must not read someone else's word as one.
  assert.equal(lockIdOf(template(GO_TYPE_MAILBOX, words)), 0);
  assert.equal(lockIdOf(template(GO_TYPE_TRANSPORT, words)), 0);
});

test("the spell that opens a lock is the one the server would accept", () => {
  const data = {
    locks: {
      // A copper vein: mining, and the rank does not matter to this decision.
      10: [{ type: LOCK_KEY_SKILL, index: 3, skill: 25 }],
      // A lock whose key is a spell outright.
      20: [{ type: LOCK_KEY_SPELL, index: 1843, skill: 0 }],
      // A key in the bag, with a skill case behind it that must never be reached.
      30: [{ type: LOCK_KEY_ITEM, index: 1234, skill: 0 }, { type: LOCK_KEY_SKILL, index: 3, skill: 1 }],
      // An empty first case is skipped, not treated as the end.
      40: [{ type: LOCK_KEY_SKILL, index: 2, skill: 1 }],
    },
    openers: [
      { spell: 2575, lockType: 3, value: 0 },
      { spell: 2366, lockType: 2, value: 0 },
      { spell: 1843, lockType: 0, value: 0 },
    ],
  };

  assert.equal(spellForLock(data, 10, [2575]), 2575, "a miner mines");
  // The spell's own value is 0 and the vein asks for 25; comparing those would open nothing ever,
  // because the server checks the player's profession skill instead and says so if it is short.
  assert.equal(spellForLock(data, 10, [2366]), 0, "a herbalist cannot mine");
  assert.equal(spellForLock(data, 10, []), 0);

  // A spell key is accepted by the server even from someone who never learned it.
  assert.equal(spellForLock(data, 20, []), 1843);

  // An item key ends the search rather than being skipped, exactly as the server ends it.
  assert.equal(spellForLock(data, 30, [2575]), 0, "a key in the bag is not a spell");

  assert.equal(spellForLock(data, 40, [2366]), 2366);
  assert.equal(spellForLock(data, 999, [2575]), 0, "an unknown lock opens for nobody");
});

test("casting at an object names it, and casting at a creature no longer names one", () => {
  const atUnit = buildCastSpell(2575, 1);
  const atObject = buildCastSpellOnGameObject(2575, 1, 0x40n);
  // Byte 6 onward is the target mask: no unit flag since Ж0 (0 with no point to send, 0x40 —
  // `TARGET_FLAG_DEST_LOCATION` — with one), 0x800 for a game object.
  assert.deepEqual([...atUnit.slice(6, 10)], [0, 0, 0, 0]);
  assert.deepEqual([...buildCastSpell(2575, 1, { x: 0, y: 0, z: 0 }).slice(6, 10)], [0x40, 0, 0, 0]);
  assert.deepEqual([...atObject.slice(6, 10)], [0x00, 0x08, 0, 0]);
  // The two packets are no longer the same length, and that is the whole difference between them:
  // the ore vein still carries its packed guid, because the server's own selection is never a game
  // object — `CMSG_SET_SELECTION` cannot name one — so there is nothing for it to fall back on.
  assert.equal(atUnit.length, 10);
  assert.equal(atObject.length, 12);
  assert.deepEqual([...atObject.slice(10)], [0x01, 0x40], "the packed guid of the chest");
});
