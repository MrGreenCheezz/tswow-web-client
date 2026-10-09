import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import {
  TAB_LIST_LIFETIME_MS, TabCycle, collectTabCandidates, enemiesAround, isAttackableUnit, isTabEnemy,
} from "../dist/code/world/TargetSearch.js";
import { REACTION_FRIENDLY, REACTION_HOSTILE, REACTION_NEUTRAL } from "../dist/code/world/FactionRules.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { game } from "../dist/code/browser/game/Context.js";
import { canAttackUnit, clearFocusOn, cycleEnemyTarget, enemyCandidates, reactionBetween } from "../dist/code/browser/game/Targeting.js";

/*
 * WORK_PLAN 5.16 (and the predicate shared with 5.05): Tab as Wow.exe 3.3.5a (12340) does it —
 * TargetNearestEnemy 0x525ad0 → 0x524fc0, candidates 0x524440, order 0x5131d0, filter 0x518e40,
 * CanAttack 0x729740. Notes: .runtime/re-2026-10-01/a9-combat/ (e1–e5).
 */

/** One unit as the world state holds it, with only the fields Tab and CanAttack read. */
function object(guid, {
  typeId = 3, x = 0, y = 0, z = 0, health = 100, flags = 0, dynamicFlags = 0, bytes1 = 0, pvp = 0, playerFlags = 0,
} = {}) {
  const fields = new Map();
  fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health);
  fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, flags);
  fields.set(UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset, dynamicFlags);
  fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_1.offset, bytes1);
  fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, pvp << 8);
  if (typeId === 4) fields.set(UPDATE_FIELDS.PLAYER_FLAGS.offset, playerFlags);
  return { guid, typeId, position: { x, y, z, orientation: 0 }, fields };
}

/** A player character: player-controlled, as UNIT_FLAG_PLAYER_CONTROLLED says on the wire. */
const player = (guid, options = {}) => object(guid, { typeId: 4, ...options, flags: 0x8 | (options.flags ?? 0) });

const me = player(1n);
const here = { x: 0, y: 0, z: 0, orientation: 0 };
const everyone = () => true;
const at = (angle, distance) => ({ x: Math.cos(angle) * distance, y: Math.sin(angle) * distance });

test("CanAttack: neutral creatures yes, friendly no, and the flags the server publishes decide the rest", () => {
  assert.equal(isAttackableUnit(me, object(2n), REACTION_HOSTILE), true);
  assert.equal(isAttackableUnit(me, object(2n), REACTION_NEUTRAL), true, "a yellow boar is a target");
  assert.equal(isAttackableUnit(me, object(2n), REACTION_FRIENDLY), false);
  for (const flags of [0x2, 0x80, 0x10000, 0x100000, 0x2000000, 0x100]) {
    assert.equal(isAttackableUnit(me, object(2n, { flags }), REACTION_HOSTILE), false, `flags ${flags.toString(16)}`);
  }
  assert.equal(isAttackableUnit(me, object(2n, { health: 0 }), REACTION_HOSTILE), false, "nobody swings at the dead");
  assert.equal(isAttackableUnit(me, object(2n, { typeId: 5 }), REACTION_HOSTILE), false, "a chest is no unit");
  assert.equal(isAttackableUnit(me, object(2n, { pvp: 0x08 }), REACTION_HOSTILE), false, "a sanctuary creature");
});

test("CanAttack between players: the PvP bit, both FFA, or a duel", () => {
  assert.equal(isAttackableUnit(me, player(2n), REACTION_HOSTILE), false, "an enemy player without PvP is safe");
  assert.equal(isAttackableUnit(me, player(2n, { pvp: 0x01 }), REACTION_HOSTILE), true);
  assert.equal(isAttackableUnit(me, player(2n, { pvp: 0x01 }), REACTION_FRIENDLY), false, "flagged but friendly");
  assert.equal(isAttackableUnit(me, player(2n, { pvp: 0x01 | 0x08 }), REACTION_HOSTILE), false, "sanctuary");
  const ffaMe = player(1n, { pvp: 0x04 });
  assert.equal(isAttackableUnit(ffaMe, player(2n, { pvp: 0x04 }), REACTION_NEUTRAL), true, "both free-for-all");
  assert.equal(isAttackableUnit(me, player(2n, { pvp: 0x04 }), REACTION_NEUTRAL), false, "only one of them");
  assert.equal(isAttackableUnit(me, player(2n, { pvp: 0x01, playerFlags: 0x10 }), REACTION_HOSTILE), false, "a ghost");
  const dueller = player(1n);
  const other = player(2n);
  for (const unit of [dueller, other]) {
    unit.fields.set(UPDATE_FIELDS.PLAYER_DUEL_ARBITER.offset, 77);
    unit.fields.set(UPDATE_FIELDS.PLAYER_DUEL_ARBITER.offset + 1, 0x1f10_0000);
  }
  assert.equal(isAttackableUnit(dueller, other, REACTION_NEUTRAL), true, "the duel flag shares one arbiter");
});

test("Tab's filter drops the feigned and the lying dead, and critters, pets and gas clouds", () => {
  assert.equal(isTabEnemy(me, object(2n), REACTION_HOSTILE), true);
  assert.equal(isTabEnemy(me, object(2n, { dynamicFlags: 0x20 }), REACTION_HOSTILE), false, "UNIT_DYNFLAG_DEAD");
  assert.equal(isTabEnemy(me, object(2n, { bytes1: 7 }), REACTION_HOSTILE), false, "UNIT_STAND_STATE_DEAD");
  assert.equal(isTabEnemy(me, object(2n, { health: 0, dynamicFlags: 0x1 }), REACTION_HOSTILE), false, "a corpse with loot too");
  for (const type of [8, 12, 13]) assert.equal(isTabEnemy(me, object(2n), REACTION_NEUTRAL, type), false, `type ${type}`);
  assert.equal(isTabEnemy(me, object(2n), REACTION_NEUTRAL, 1), true, "a beast");
  assert.equal(isTabEnemy(me, object(2n), REACTION_NEUTRAL, 11), true, "a totem");
});

test("the search: ±30° out to 41 yards, every other bearing only to 10, measured in three dimensions", () => {
  const found = (unit) => enemiesAround([unit], here, 1n, everyone).length === 1;
  const unitAt = (angle, distance, z = 0) => object(2n, { ...at(angle, distance), z });
  assert.equal(found(unitAt(0, 40.9)), true, "straight ahead at 40.9");
  assert.equal(found(unitAt(0, 41.1)), false, "past 41");
  assert.equal(found(unitAt(Math.PI / 6 - 0.01, 30)), true, "just inside the cone");
  assert.equal(found(unitAt(Math.PI / 6 + 0.01, 30)), false, "just outside it, far");
  assert.equal(found(unitAt(-Math.PI / 6 + 0.01, 30)), true, "the other edge");
  assert.equal(found(unitAt(Math.PI, 9.9)), true, "behind, within 10");
  assert.equal(found(unitAt(Math.PI, 10.1)), false, "behind, past 10");
  assert.equal(found(unitAt(0, 0, 41.5)), false, "straight above counts the height");
  assert.equal(found(object(1n)), false, "the mover itself never");
});

test("the order: the cone first, then the nearest, and the same order on every rebuild", () => {
  const behind = object(2n, { ...at(Math.PI, 3) });
  const ahead = object(3n, { ...at(0, 25) });
  const aheadNear = object(4n, { ...at(0.1, 12) });
  assert.deepEqual(enemiesAround([behind, ahead, aheadNear], here, 1n, everyone).map((entry) => entry.guid), [4n, 3n, 2n]);
  const turned = { ...here, orientation: Math.PI };
  assert.deepEqual(enemiesAround([behind, ahead, aheadNear], turned, 1n, everyone).map((entry) => entry.guid), [2n],
    "facing away, the far ones are out of reach");
  const twins = [object(9n, { x: 5 }), object(5n, { x: 5 })];
  assert.deepEqual(enemiesAround(twins, here, 1n, everyone).map((entry) => entry.guid), [5n, 9n]);
  assert.deepEqual(enemiesAround(twins.reverse(), here, 1n, everyone).map((entry) => entry.guid), [5n, 9n]);
});

test("a rebuild reuses its entries, so a crowd costs no garbage after the first press", () => {
  const crowd = Array.from({ length: 30 }, (_, index) => object(BigInt(index + 2), { x: 1 + index * 0.3 }));
  const out = [];
  collectTabCandidates(crowd, here, 1n, everyone, out);
  const before = new Set(out);
  assert.equal(collectTabCandidates(crowd, here, 1n, everyone, out), 30);
  assert.equal(out.every((entry) => before.has(entry)), true);
});

/** A Tab source over a fixed list of guids, with a switchable validity. */
function listSource(guids, invalid = new Set()) {
  return {
    builds: 0,
    collect(out) {
      this.builds++;
      out.length = 0;
      guids.forEach((guid, index) => out.push({ guid, distanceSquared: index, ahead: true }));
      return guids.length;
    },
    valid(guid) { return !invalid.has(guid); },
  };
}

test("Tab steps along a kept list and wraps; a wrap rebuilds a list older than one second", () => {
  const cycle = new TabCycle();
  const source = listSource([5n, 6n, 7n]);
  assert.equal(cycle.next(1000, undefined, false, source), 5n, "first press: the best");
  assert.equal(cycle.next(1100, 5n, false, source), 6n);
  assert.equal(cycle.next(1200, 6n, false, source), 7n);
  assert.equal(source.builds, 1, "one list for presses under three seconds apart");
  assert.equal(cycle.next(1300, 7n, false, source), 5n, "a wrap inside a second keeps the list");
  assert.equal(source.builds, 1);
  assert.equal(cycle.next(1400, 5n, false, source), 6n);
  assert.equal(cycle.next(1500, 6n, false, source), 7n);
  assert.equal(cycle.next(2100, 7n, false, source), 5n, "a wrap after a second rebuilds and starts over");
  assert.equal(source.builds, 2);
});

test("Tab backwards, a three-second pause, a moved selection and a cleared one", () => {
  const cycle = new TabCycle();
  const source = listSource([5n, 6n, 7n]);
  assert.equal(cycle.next(1000, undefined, true, source), 5n, "reverse also starts at the best");
  assert.equal(cycle.next(1100, 5n, true, source), 7n, "and steps back round the end");
  assert.equal(cycle.next(1200, 7n, true, source), 6n);
  assert.equal(cycle.next(1300, 99n, false, source), 6n, "the player picked something else: re-pick where it stood");
  assert.equal(source.builds, 1);
  assert.equal(cycle.next(1300 + TAB_LIST_LIFETIME_MS, 6n, false, source), 5n, "three quiet seconds: a new list");
  assert.equal(source.builds, 2);
  cycle.invalidate();
  assert.equal(cycle.next(4400, 5n, false, source), 5n, "a cleared selection drops the list too");
  assert.equal(source.builds, 3);
});

test("Tab skips what no longer passes, and with nothing left keeps the selection", () => {
  const invalid = new Set([6n]);
  const cycle = new TabCycle();
  const source = listSource([5n, 6n, 7n], invalid);
  assert.equal(cycle.next(1000, undefined, false, source), 5n);
  assert.equal(cycle.next(1100, 5n, false, source), 7n, "6 died since the list was built");
  invalid.add(5n).add(7n);
  assert.equal(cycle.next(1200, 7n, false, source), undefined);
  assert.equal(cycle.list.length, 0, "the list is dropped (0x522220(0))");
  assert.equal(cycle.next(1300, 7n, false, listSource([])), undefined, "an empty world gives nothing");
});

test("a forced reaction overrides the faction table, both ways, and only for the player", () => {
  const previous = { world: game.world, factions: game.factions };
  try {
    const self = player(1n);
    self.fields.set(UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset, 1);
    const wolf = object(2n);
    wolf.fields.set(UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset, 2);
    const guard = object(3n);
    guard.fields.set(UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset, 3);
    const forcedReactions = new Map();
    game.world = { state: { selfGuid: 1n, objects: new Map([[1n, self], [2n, wolf], [3n, guard]]) }, forcedReactions };
    // Template 2 hostile, 3 friendly; FactionTemplate.Faction = template × 10.
    game.factions = { ready: true, reaction: (_m, t) => (t === 2 ? -1 : 1), factionOf: (template) => template * 10 };
    assert.equal(reactionBetween(self, wolf, game.factions), REACTION_HOSTILE);
    assert.equal(canAttackUnit(guard), false);
    forcedReactions.set(20, 4);
    forcedReactions.set(30, 0);
    assert.equal(reactionBetween(self, wolf, game.factions), REACTION_FRIENDLY, "REP_FRIENDLY");
    assert.equal(canAttackUnit(wolf), false);
    assert.equal(reactionBetween(self, guard, game.factions), REACTION_HOSTILE, "REP_HATED");
    assert.equal(canAttackUnit(guard), true);
    assert.equal(reactionBetween(guard, self, game.factions), REACTION_HOSTILE, "the creature's side looks the same way");
    assert.equal(reactionBetween(guard, wolf, game.factions), REACTION_HOSTILE, "between two others the table decides");
    forcedReactions.set(30, 3);
    assert.equal(reactionBetween(self, guard, game.factions), REACTION_NEUTRAL, "REP_NEUTRAL");
  } finally {
    game.world = previous.world;
    game.factions = previous.factions;
  }
});

test("CanAttack waits for the faction table: until it lands no unit is fought on a guess", () => {
  // Review of 5.05: with no table every unit reads neutral, and neutral is attackable — a right
  // click on a guard, a party member or a dungeon bot became CMSG_ATTACKSWING (with a dismount and
  // a stand-up in front of it), and clicking a friend mid-fight carried the swing to them. Wow.exe
  // always has FactionTemplate.dbc; here the safe answer while it is missing is "no".
  const previous = { world: game.world, factions: game.factions };
  try {
    const self = player(1n);
    self.fields.set(UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset, 1);
    const bot = object(2n);
    bot.fields.set(UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset, 35);
    game.world = { state: { selfGuid: 1n, objects: new Map([[1n, self], [2n, bot]]) }, forcedReactions: new Map() };
    game.factions = undefined;
    assert.equal(canAttackUnit(bot), false, "no faction client");
    game.factions = { ready: false, reaction: () => 0, factionOf: () => undefined };
    assert.equal(canAttackUnit(bot), false, "the table is still on its way");
    game.factions = { ready: true, reaction: () => 0, factionOf: () => undefined };
    assert.equal(canAttackUnit(bot), true, "a neutral unit once the table says so");
    game.factions = { ready: true, reaction: () => 1, factionOf: () => undefined };
    assert.equal(canAttackUnit(bot), false, "and a friendly one never");
  } finally {
    game.world = previous.world;
    game.factions = previous.factions;
  }
});

test("Tab in the browser: the cone list, cycling, and a fresh start after the selection is cleared", () => {
  const previous = { world: game.world, factions: game.factions };
  try {
    const self = player(1n);
    const objects = new Map([[1n, self]]);
    for (const [guid, x] of [[2n, 6], [3n, 20], [4n, -4]]) objects.set(guid, object(guid, { x }));
    objects.set(5n, object(5n, { x: 3, health: 0, dynamicFlags: 0x1 }));
    const world = {
      state: { selfGuid: 1n, objects }, targetGuid: undefined, forcedReactions: new Map(), selectionClears: 0,
      creatureTemplates: new Map(), selected: [],
      selectTarget(guid) { this.selected.push(guid); this.targetGuid = guid; },
    };
    game.world = world;
    game.factions = undefined;
    assert.deepEqual(enemyCandidates().map((entry) => entry.guid), [2n, 3n, 4n], "no body, the one behind last");
    cycleEnemyTarget(1);
    cycleEnemyTarget(1);
    cycleEnemyTarget(1);
    assert.deepEqual(world.selected, [2n, 3n, 4n]);
    world.targetGuid = undefined;
    world.selectionClears++;
    cycleEnemyTarget(1);
    assert.deepEqual(world.selected, [2n, 3n, 4n, 2n], "a clear starts the cycle again from the best");
  } finally {
    game.world = previous.world;
    game.factions = previous.factions;
  }
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
