import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { TARGET_SEARCH_RANGE, enemiesAround, nextTarget } from "../dist/code/world/TargetSearch.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { game } from "../dist/code/browser/game/Context.js";
import { clearFocusOn } from "../dist/code/browser/game/Targeting.js";

/** One object as the world state holds it, with only the fields Tab actually reads. */
function object(guid, { typeId = 3, x = 0, y = 0, z = 0, health = 100, flags = 0, dynamicFlags = 0 } = {}) {
  const fields = new Map();
  fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health);
  fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, flags);
  fields.set(UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset, dynamicFlags);
  return { guid, typeId, position: { x, y, z, orientation: 0 }, fields };
}

/** Dead, with `UNIT_DYNFLAG_LOOTABLE` still set: a body the server is showing loot on. */
const corpseWithLoot = (guid, options = {}) => object(guid, { ...options, health: 0, dynamicFlags: 0x01 });

const here = { x: 0, y: 0, z: 0, orientation: 0 };
const everyone = () => true;

test("enemies come back nearest first", () => {
  const found = enemiesAround([
    object(3n, { x: 30 }),
    object(1n, { x: 5 }),
    object(2n, { x: 12 }),
  ], here, undefined, everyone);
  assert.deepEqual(found.map((entry) => entry.guid), [1n, 2n, 3n]);
});

test("two spawns at the same spot keep the same order between presses", () => {
  // Sorting by distance alone leaves ties to whatever order the map happened to be walked in, and
  // then Tab swaps between the same two forever instead of moving on.
  const first = enemiesAround([object(9n, { x: 5 }), object(4n, { x: 5 })], here, undefined, everyone);
  const second = enemiesAround([object(4n, { x: 5 }), object(9n, { x: 5 })], here, undefined, everyone);
  assert.deepEqual(first.map((entry) => entry.guid), second.map((entry) => entry.guid));
});

test("the player, corpses, objects and the unattackable are not enemies", () => {
  const found = enemiesAround([
    object(1n, { x: 1 }),
    object(2n, { x: 2, health: 0 }),
    object(3n, { x: 3, typeId: 5 }),
    object(4n, { x: 4, flags: 0x00000002 }),
    object(5n, { x: 5, flags: 0x02000000 }),
    object(6n, { x: 6, flags: 0x00010000 }),
    object(7n, { x: 7 }),
  ], here, 7n, everyone);
  assert.deepEqual(found.map((entry) => entry.guid), [1n],
    "a spent corpse, a chest, three flagged units and the player itself all have to be skipped");
});

test("Л1 a corpse with loot on it stays in the cycle, and stays at the end of it", () => {
  // Tab used to throw out everything dead, so the keyboard had no way at all to select a body —
  // and the «Обыскать» button lives on the target frame, which means it had no way to reach loot
  // either. The reference client keeps them and sorts them behind everything alive: «live enemies
  // cycle first (nearest to farthest); lootable corpses last»
  // (`wowee/src/game/combat_handler.cpp:1634-1639`).
  const found = enemiesAround([
    corpseWithLoot(1n, { x: 2 }),
    object(2n, { x: 30 }),
    object(3n, { x: 8 }),
  ], here, undefined, everyone);
  assert.deepEqual(found.map((entry) => entry.guid), [3n, 2n, 1n],
    "the body is two yards away and still comes after the enemy thirty yards off");
  assert.deepEqual(found.map((entry) => entry.lootable), [false, false, true]);

  // Two bodies keep their own order among themselves, nearest first, so the cycle is stable.
  const bodies = enemiesAround([corpseWithLoot(5n, { x: 12 }), corpseWithLoot(4n, { x: 3 })], here, undefined, everyone);
  assert.deepEqual(bodies.map((entry) => entry.guid), [4n, 5n]);

  // And the press after the kill still lands on the next live enemy rather than back on the body.
  assert.equal(nextTarget(found, 1n), 3n);
  assert.equal(nextTarget(found, 2n), 1n, "and the press after that comes back to it");
});

test("Л1 an emptied corpse leaves the cycle, and the bit is the only thing that says so", () => {
  // Indication and cycle alike are built on `UNIT_DYNFLAG_LOOTABLE` and never on health: a body
  // whose loot has been taken has the same zero health as one that has not, and the core clears
  // the bit for it (`LootHandler.cpp:411`). Reading health here would leave every kill of the day
  // in the Tab cycle for as long as the corpse stood.
  const spent = object(1n, { x: 2, health: 0 });
  assert.deepEqual(enemiesAround([spent], here, undefined, everyone), []);

  // A corpse is exempt from the reaction test, for the reason the reference client's
  // `isValidTabTarget` never asks about a corpse's faction (`combat_handler.cpp:1589-1593`): the
  // bit is already the server saying this body is yours. A live unit is not exempt.
  const nobodyIsHostile = () => false;
  const mixed = enemiesAround([corpseWithLoot(1n, { x: 2 }), object(2n, { x: 3 })], here, undefined, nobodyIsHostile);
  assert.deepEqual(mixed.map((entry) => entry.guid), [1n]);

  // What the server has flagged unselectable stays unselectable, dead or alive.
  const hidden = corpseWithLoot(3n, { x: 2, flags: 0x02000000 });
  assert.deepEqual(enemiesAround([hidden], here, undefined, everyone), []);
});

test("Л1 no body is a Tab target while the fight is still on", () => {
  // The review's finding: sorting corpses last orders the cycle, it does not shorten it, and the
  // cycle wraps — so the press that should have moved from the second live enemy to the first
  // moved onto the body instead, where no swing can land. The reference refuses the same body one
  // step earlier, before its list is built at all (`combat_handler.cpp:1590`, inside
  // `isValidTabTarget`: `if (unit->getHealth() == 0) { if (playerInCombat) return false; ... }`).
  const fight = [object(3n, { x: 6 }), object(4n, { x: 8 }), corpseWithLoot(2n, { x: 2 })];

  // Out of combat, which is when a body is worth cycling to, nothing changes.
  const calm = enemiesAround(fight, here, 1n, everyone, undefined, undefined, false);
  assert.deepEqual(calm.map((entry) => entry.guid), [3n, 4n, 2n]);
  assert.equal(nextTarget(calm, 4n), 2n, "the press after the last live enemy reaches the body");

  // In combat the body is gone from the list, so the same press wraps to the nearest enemy.
  const fighting = enemiesAround(fight, here, 1n, everyone, undefined, undefined, true);
  assert.deepEqual(fighting.map((entry) => entry.guid), [3n, 4n]);
  assert.equal(nextTarget(fighting, 4n), 3n);
  // And it is the corpse that goes, not everything: the living are untouched by the flag.
  assert.deepEqual(enemiesAround([corpseWithLoot(2n, { x: 2 })], here, 1n, everyone, undefined, undefined, true), []);
});

test("Л1 the combat flag Tab reads is the player's own, straight off UNIT_FIELD_FLAGS", async () => {
  // `enemyCandidates` is where the bit is read, and it reads it off the `self` it already holds
  // for the position — no second lookup. 0x00080000 is `UNIT_FLAG_IN_COMBAT` (`UnitDefines.h:154`),
  // which the core sets on the unit when a combat reference is taken and clears when the last one
  // goes (`CombatManager.cpp:465` and `:475`).
  const { enemyCandidates } = await import("../dist/code/browser/game/Targeting.js");
  const previous = game.world;
  try {
    const self = object(1n, { typeId: 4, x: 0 });
    const objects = new Map([[1n, self], [2n, corpseWithLoot(2n, { x: 2 })], [3n, object(3n, { x: 6 })]]);
    game.world = { state: { selfGuid: 1n, objects }, targetGuid: undefined };
    game.factions = undefined;

    assert.deepEqual(enemyCandidates().map((entry) => entry.guid), [3n, 2n],
      "out of combat the body is at the end of the cycle");
    self.fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x00080000);
    assert.deepEqual(enemyCandidates().map((entry) => entry.guid), [3n],
      "and in combat it is not in it at all");
  } finally {
    game.world = previous;
  }
});

test("a unit with no position yet is skipped rather than placed at the origin", () => {
  const nowhere = object(2n, { x: 40 });
  nowhere.position = undefined;
  const found = enemiesAround([object(1n, { x: 4 }), nowhere], here, undefined, everyone);
  assert.deepEqual(found.map((entry) => entry.guid), [1n]);
});

test("the search has an edge, and it is measured in three dimensions", () => {
  const inside = enemiesAround([object(1n, { x: TARGET_SEARCH_RANGE - 1 })], here, undefined, everyone);
  assert.equal(inside.length, 1);
  const outside = enemiesAround([object(1n, { x: TARGET_SEARCH_RANGE + 1 })], here, undefined, everyone);
  assert.equal(outside.length, 0);
  // Something on the floor below is as far away as something across the field.
  const below = enemiesAround([object(1n, { z: TARGET_SEARCH_RANGE + 1 })], here, undefined, everyone);
  assert.equal(below.length, 0);
});

test("the reaction is the caller's to decide, and it decides everything", () => {
  const units = [object(1n, { x: 1 }), object(2n, { x: 2 })];
  const found = enemiesAround(units, here, undefined, (unit) => unit.guid === 2n);
  assert.deepEqual(found.map((entry) => entry.guid), [2n]);
  assert.deepEqual(enemiesAround(units, here, undefined, () => false), []);
});

test("Tab steps along the list and wraps at both ends", () => {
  const list = [{ guid: 1n, distance: 1 }, { guid: 2n, distance: 2 }, { guid: 3n, distance: 3 }];
  assert.equal(nextTarget(list, undefined), 1n);
  assert.equal(nextTarget(list, 1n), 2n);
  assert.equal(nextTarget(list, 3n), 1n);
  assert.equal(nextTarget(list, undefined, -1), 3n);
  assert.equal(nextTarget(list, 1n, -1), 3n);
  assert.equal(nextTarget([], 1n), undefined, "nothing in range is not a target of nothing");
});

test("a target that has left the list starts the cycle again rather than ending it", () => {
  // This is the case that matters in a fight: the thing you were hitting died, so it is no longer
  // a candidate, and the next press has to find the next one instead of returning undefined.
  const list = [{ guid: 5n, distance: 1 }, { guid: 6n, distance: 2 }];
  assert.equal(nextTarget(list, 99n), 5n);
  assert.equal(nextTarget(list, 99n, -1), 6n);
});

test("Tab takes what the character faces before what is merely near", () => {
  // Facing +x. A closer unit behind the shoulder must not beat a further one straight ahead:
  // the original client's Tab follows the camera, which is why turning changes what it gives you.
  const behind = object(1n, { x: -4 });
  const ahead = object(2n, { x: 25 });
  const found = enemiesAround([behind, ahead], here, undefined, everyone, undefined, 0);
  assert.deepEqual(found.map((entry) => entry.guid), [2n, 1n]);
  assert.deepEqual(found.map((entry) => entry.ahead), [true, false]);

  // Turn around and the order turns with the character, without either unit moving.
  const turned = enemiesAround([behind, ahead], here, undefined, everyone, undefined, Math.PI);
  assert.deepEqual(turned.map((entry) => entry.guid), [1n, 2n]);

  // Nothing is dropped for being behind: a player who has cleared what is in front keeps cycling
  // rather than pressing Tab at an empty screen.
  assert.equal(turned.length, 2);
});

test("the arc is ninety degrees each way, and its edge is inclusive", () => {
  const at = (angle, distance = 10) =>
    object(1n, { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance });
  const ahead = (angle) => enemiesAround([at(angle)], here, undefined, everyone, undefined, 0)[0].ahead;
  assert.equal(ahead(0), true, "straight ahead");
  assert.equal(ahead(Math.PI / 2 - 0.01), true, "just inside the edge");
  assert.equal(ahead(Math.PI / 2 + 0.01), false, "just outside it");
  assert.equal(ahead(Math.PI), false, "straight behind");
  // The wrap has to be an angle and not a winding number: -170 degrees is behind, not ahead.
  assert.equal(ahead(-Math.PI + 0.05), false);
  assert.equal(ahead(-0.2), true);
});

test("without a facing the order is exactly what it was before there was an arc", () => {
  const found = enemiesAround([object(3n, { x: 30 }), object(1n, { x: 5 })], here, undefined, everyone);
  assert.deepEqual(found.map((entry) => entry.guid), [1n, 3n]);
  assert.deepEqual(found.map((entry) => entry.ahead), [true, true]);
});

/**
 * A world connection a test can push packets into after the login handshake has finished.
 *
 * The read loop is already parked on `read()` by then, so a queue that is only drained on demand
 * would never wake it — the pending promise has to be the thing the push resolves.
 */
function fakeConnection() {
  const sent = [];
  const queue = [];
  let wake;
  return {
    sent,
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume(queue.shift());
      }
    },
    send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

/** Lets the world loop finish with whatever was pushed. `#dispatch` is async several layers deep. */
async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

const SELF = 0x1234n;

/** A client that has entered the world, with the player and one creature standing in it. */
async function inWorld() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  const here = { x: 0, y: 0, z: 0, orientation: 0 };
  client.state.move(SELF, { flags: 0, position: here });
  client.state.move(0x5678n, { flags: 0, position: { ...here, x: 5 } });
  client.state.move(0x9abcn, { flags: 0, position: { ...here, x: 9 } });
  client.state.selfGuid = SELF;
  return { client, connection };
}

/** `SMSG_CLEAR_TARGET` carries a full guid; its sibling packs one. Both name the *caster*. */
const clearTarget = (guid) => new PacketWriter().u64(guid).toUint8Array();
const breakTarget = (guid) => new PacketWriter().packedGuid(guid).toUint8Array();

test("Н3 SMSG_CLEAR_TARGET drops the target it names, and leaves any other one alone", async () => {
  // `Spell::EffectForceDeselect` writes `unitCaster->GetGUID()` (`SpellEffects.cpp:4314-4317`) and
  // sends it to everyone hostile to that caster, so the guid in the packet is the thing that is to
  // stop being targeted. It used to be compared against `state.selfGuid` — a guid the player can
  // never be sent through a hostile deliverer — so the branch was dead and the effect did nothing.
  const { client, connection } = await inWorld();
  client.selectTarget(0x5678n);

  connection.push(OPCODES.SMSG_CLEAR_TARGET, clearTarget(0x9abcn));
  await settle();
  assert.equal(client.targetGuid, 0x5678n, "a caster nobody was looking at must not clear a selection");

  connection.push(OPCODES.SMSG_CLEAR_TARGET, clearTarget(0x5678n));
  await settle();
  assert.equal(client.targetGuid, undefined, "and the one that was being looked at has to");

  // The old comparison, for the record: the player's own guid is not what the packet carries, and
  // reading it as though it were is what made this branch unreachable.
  client.selectTarget(0x9abcn);
  connection.push(OPCODES.SMSG_CLEAR_TARGET, clearTarget(SELF));
  await settle();
  assert.equal(client.targetGuid, 0x9abcn, "the player's own guid in that packet means nothing");
  client.close();
});

test("Н3 SMSG_BREAK_TARGET is the focus's half, and the selection is its sibling's", async () => {
  // The same effect sends this three lines earlier (`SpellEffects.cpp:4308-4311`), with the same
  // caster guid packed rather than full. It was parsed and thrown away, so a fear or a vanish took
  // the selection and left the focus pointed at the caster.
  //
  // The focus and nothing else, because the core labels the pair that way — «clear focus» over
  // this one (`SpellEffects.cpp:4307`), «and selection» over `SMSG_CLEAR_TARGET` (`:4313`) — and
  // because this one has a second sender that its sibling does not: `Unit::SendClearTarget`
  // (`Unit.cpp:13413-13418`) broadcasts it with `SendMessageToSet` to everyone in sight, and
  // `Vehicle.cpp:933` calls it on the passenger every time somebody boards a controllable seat. A
  // client that dropped its selection here would deselect that passenger for every bystander who
  // had them selected, and put a `CMSG_SET_SELECTION 0` on the wire for each of them.
  const { client, connection } = await inWorld();
  client.selectTarget(0x5678n);
  const seen = [];
  client.events.on("TARGET_BROKEN", (broken) => seen.push(broken.guid));

  connection.push(OPCODES.SMSG_BREAK_TARGET, breakTarget(0x9abcn));
  await settle();
  assert.equal(client.targetGuid, 0x5678n, "a unit nobody was looking at leaves the selection");
  assert.deepEqual(seen, [0x9abcn], "and it is announced, because a focus may be on it");

  connection.push(OPCODES.SMSG_BREAK_TARGET, breakTarget(0x5678n));
  await settle();
  assert.equal(client.targetGuid, 0x5678n,
    "and the one being looked at keeps it: boarding a vehicle must not deselect anybody");
  assert.deepEqual(seen, [0x9abcn, 0x5678n]);

  // The fear takes the selection anyway, because it sends both packets: the sibling lands three
  // lines later with the same guid, and that is the branch that drops it.
  connection.push(OPCODES.SMSG_CLEAR_TARGET, clearTarget(0x5678n));
  await settle();
  assert.equal(client.targetGuid, undefined);
  client.close();
});

test("Н3 the focus lets go of a unit that has broken away, and holds on to anyone else", async () => {
  // The focus lives in the interface and the world client has never heard of it, which is why the
  // packet is announced rather than acted on twice.
  const previous = game.focusGuid;
  try {
    game.focusGuid = 0x5678n;
    clearFocusOn(0x9abcn);
    assert.equal(game.focusGuid, 0x5678n);
    clearFocusOn(0x5678n);
    assert.equal(game.focusGuid, undefined);
    // And a broken target with no focus at all is not a way to acquire one.
    clearFocusOn(0x5678n);
    assert.equal(game.focusGuid, undefined);
  } finally {
    game.focusGuid = previous;
  }
});

test("Н3 one's own body stays selected through one's own death", async () => {
  // `#checkTarget` drops a target whose `UNIT_FIELD_HEALTH` has reached zero, and the player is
  // always in their own object list — so a character who had selected themselves lost that
  // selection at the instant of their own death, silently, with the status line saying «Цель вышла
  // из видимости» about someone standing right there. The original client keeps it, and the target
  // frame is how a dead player watches their own corpse timer.
  const { client, connection } = await inWorld();
  const self = client.state.objects.get(SELF);
  const other = client.state.objects.get(0x5678n);
  self.typeId = 3;
  other.typeId = 3;
  self.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  other.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);

  client.selectTarget(SELF);
  self.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
  // Any handled packet at all runs `#checkTarget`; this one is chosen for being inert.
  connection.push(OPCODES.SMSG_AI_REACTION, new PacketWriter().u64(0x9abcn).u32(0).toUint8Array());
  await settle();
  assert.equal(client.targetGuid, SELF, "the player's own corpse is still a legitimate selection");

  // Ж0 widened this exception into the rule: nobody's corpse is dropped now, because the target
  // frame is where «Обыскать» lives. The swing still stops — see the Ж0 test below for that half.
  client.selectTarget(0x5678n);
  other.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
  connection.push(OPCODES.SMSG_AI_REACTION, new PacketWriter().u64(0x9abcn).u32(0).toUint8Array());
  await settle();
  assert.equal(client.targetGuid, 0x5678n);

  // A self that has left the object list altogether is a different thing — that is not a death,
  // it is a world change, and there is nothing left to keep.
  client.selectTarget(SELF);
  client.state.objects.delete(SELF);
  connection.push(OPCODES.SMSG_AI_REACTION, new PacketWriter().u64(0x9abcn).u32(0).toUint8Array());
  await settle();
  assert.equal(client.targetGuid, undefined);
  client.close();
});

test("Ж0 a corpse keeps the selection, and only leaving the world loses it", async () => {
  // The player's report was «лут не реализован: не видно, что можно полутать», and this is the
  // whole of it: `#checkTarget` runs from `#dispatch` after every packet of the main chain, and
  // `SMSG_UPDATE_OBJECT` is applied in the same call — so the frame that carries the «Обыскать»
  // button emptied in the same breath that reported the kill, and the button had never once been
  // on the screen. Looting worked only by right click, because `SMSG_LOOT_RESPONSE` is handled in
  // `#handleUtilityPacket`, which returns early and never reaches this check.
  //
  // What death still means is the swing: the reference client keeps a corpse selectable
  // (`wowee/src/game/combat_handler.cpp:1304-1307`, `setTarget` takes one) and has no path that
  // deselects on death.
  const { client, connection } = await inWorld();
  const said = [];
  client.onCombatStatus = (message) => said.push(message);
  const boar = client.state.objects.get(0x5678n);
  boar.typeId = 3;
  boar.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  client.selectTarget(0x5678n);
  client.attacking = true;
  said.length = 0; // «Цель выбрана», which the selection itself said.
  const sentBeforeDeath = connection.sent.length;

  boar.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
  // Any handled packet at all runs `#checkTarget`; this one is chosen for being inert.
  connection.push(OPCODES.SMSG_AI_REACTION, new PacketWriter().u64(0x9abcn).u32(0).toUint8Array());
  await settle();
  assert.equal(client.targetGuid, 0x5678n, "a corpse is a legitimate selection — it is the loot");
  assert.equal(client.attacking, false, "and the swing stops, which is what this check was for");
  assert.equal(connection.sent.slice(sentBeforeDeath).some(({ opcode }) => opcode === OPCODES.CMSG_ATTACK_STOP), true,
    "the silent local invariant still cancels the server-side melee swing");
  assert.deepEqual(said, [], "nothing left the player's sight, so nothing is announced");

  // Gone from `state.objects` — out of sight, out of phase, a map change — and only then is the
  // selection let go, with the line that says so.
  client.state.objects.delete(0x5678n);
  connection.push(OPCODES.SMSG_AI_REACTION, new PacketWriter().u64(0x9abcn).u32(0).toUint8Array());
  await settle();
  assert.equal(client.targetGuid, undefined);
  assert.deepEqual(said, ["Цель вышла из видимости"]);
  client.close();
});
