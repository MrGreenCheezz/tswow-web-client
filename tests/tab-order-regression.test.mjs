import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { TargetHistory, setTargetHistoryJudge } from "../dist/code/world/TargetHistory.js";
import { game } from "../dist/code/browser/game/Context.js";
import {
  cycleEnemyTarget, enemyCandidates, targetNearestUnit, targetSelectionKind,
} from "../dist/code/browser/game/Targeting.js";
import {
  NEAREST_ANY, NEAREST_ENEMY, NEAREST_ENEMY_PLAYER, NEAREST_FRIEND, NEAREST_FRIEND_PLAYER, NEAREST_PARTY_MEMBER,
  NEAREST_RAID_MEMBER,
} from "../dist/code/browser/game/TargetNearestModes.js";
import { FRAMEXML_LIVE_TARGET_NEAREST } from "../dist/code/browser/framexml/FrameXmlTargetNearestLive.js";

/*
 * Review of lane L2 (WORK_PLAN 1.10/3.11, 04.10): Tab — TargetNearestEnemy 0x525ad0 → 0x524fc0 mode 1 —
 * must keep its list, its order, its filter and its rebuild timing now that `tabSource` serves every
 * TargetNearest* mode (game/Targeting.ts `acceptsTabMode`), and the history hook in
 * `WorldClient.selectTarget` must not change what goes on the wire or when. A fixed world; the clock
 * is `performance.now`, held here.
 */

const HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;
const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
const DYNAMIC = UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset;
const BYTES_1 = UPDATE_FIELDS.UNIT_FIELD_BYTES_1.offset;
const BYTES_2 = UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset;
const FACTION = UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset;
const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;

/** Faction template 2 is hostile to the player, 3 neutral, anything else friendly. */
const factions = {
  ready: true,
  reaction: (_mine, theirs) => (theirs === 2 ? -1 : theirs === 3 ? 0 : 1),
  factionOf: () => undefined,
};

const DEG = Math.PI / 180;

function unit(guid, {
  typeId = 3, angle = 0, distance = 0, health = 100, faction = 2, dynamic = 0, bytes1 = 0, pvp = 0, entry = 0,
} = {}) {
  const fields = new Map([
    [HEALTH, health], [FACTION, faction], [DYNAMIC, dynamic], [BYTES_1, bytes1], [BYTES_2, pvp << 8], [ENTRY, entry],
    [FLAGS, typeId === 4 ? 0x8 : 0],
  ]);
  const position = { x: Math.cos(angle * DEG) * distance, y: Math.sin(angle * DEG) * distance, z: 0, orientation: 0 };
  return { guid, typeId, position, fields };
}

const SELF = 1n;
const BOAR = 10n; // hostile, 5 yd ahead
const OGRE = 11n; // hostile, 20 yd at +20° (in the cone)
const BEHIND = 12n; // hostile, 8 yd behind (the near circle)
const YELLOW = 13n; // neutral, 12 yd at −10°: Tab takes neutrals
const GUARD = 14n; // friendly creature, 3 yd ahead
const CORPSE = 15n; // hostile, dead, 4 yd ahead
const FEIGN = 16n; // hostile, UNIT_DYNFLAG_DEAD, 6 yd ahead
const SLEEPER = 17n; // hostile, stand state dead, 7 yd ahead
const RAT = 18n; // hostile critter (CreatureType 8), 2 yd ahead
const FAR = 19n; // hostile, 45 yd ahead
const SIDE = 20n; // hostile, 15 yd at 90°: outside the cone and past 10 yd
const PALADIN = 21n; // friendly player, 9 yd ahead
const CHEST = 22n; // a game object, 1 yd ahead

function fixedWorld() {
  const objects = new Map([
    [SELF, unit(SELF, { typeId: 4, faction: 1 })],
    [BOAR, unit(BOAR, { distance: 5 })],
    [OGRE, unit(OGRE, { angle: 20, distance: 20 })],
    [BEHIND, unit(BEHIND, { angle: 180, distance: 8 })],
    [YELLOW, unit(YELLOW, { angle: -10, distance: 12, faction: 3 })],
    [GUARD, unit(GUARD, { distance: 3, faction: 1 })],
    [CORPSE, unit(CORPSE, { distance: 4, health: 0 })],
    [FEIGN, unit(FEIGN, { distance: 6, dynamic: 0x20 })],
    [SLEEPER, unit(SLEEPER, { distance: 7, bytes1: 7 })],
    [RAT, unit(RAT, { distance: 2, entry: 502 })],
    [FAR, unit(FAR, { distance: 45 })],
    [SIDE, unit(SIDE, { angle: 90, distance: 15 })],
    [PALADIN, unit(PALADIN, { typeId: 4, distance: 9, faction: 1 })],
    [CHEST, { ...unit(CHEST, { distance: 1 }), typeId: 5 }],
  ]);
  return {
    state: { selfGuid: SELF, objects },
    targetGuid: undefined,
    forcedReactions: new Map(),
    selectionClears: 0,
    creatureTemplates: new Map([[502, { entry: 502, found: true, flags: 0, creatureType: 8 }]]),
    group: undefined,
    targetHistory: new TargetHistory(),
    selected: [],
    selectTarget(guid) {
      if (guid === undefined) this.selectionClears++;
      if (guid === this.targetGuid) return;
      this.selected.push(guid);
      this.targetHistory.selected(this.targetGuid, guid, guid === undefined ? undefined : targetSelectionKind(objects.get(guid)));
      this.targetGuid = guid;
    },
  };
}

/** Runs `body` with `world` as game.world, the faction table ready and the clock at `clock.now`. */
function withClock(world, body) {
  const previous = { world: game.world, factions: game.factions };
  const clock = { now: 10_000 };
  performance.now = () => clock.now;
  try {
    game.world = world;
    game.factions = factions;
    body(clock);
  } finally {
    delete performance.now;
    game.world = previous.world;
    game.factions = previous.factions;
  }
}

const TAB_ORDER = [BOAR, YELLOW, OGRE, BEHIND];

/** Tab presses `count` times, 50 ms apart; answers what each selected. */
function tabs(world, clock, count, step = 1) {
  const picked = [];
  for (let press = 0; press < count; press++) {
    clock.now += 50;
    cycleEnemyTarget(step);
    picked.push(world.targetGuid);
  }
  return picked;
}

test("Tab's list in a fixed world: the cone by distance, then the near circle — the same list enemyCandidates gives", () => {
  const world = fixedWorld();
  withClock(world, (clock) => {
    assert.deepEqual(enemyCandidates().map((entry) => entry.guid), TAB_ORDER,
      "no friend, corpse, feigned or lying dead, critter, far or side unit, player friend or game object");
    assert.deepEqual(tabs(world, clock, 5), [...TAB_ORDER, BOAR], "Tab walks the list and wraps");
    assert.deepEqual(tabs(world, clock, 2, -1), [BEHIND, OGRE], "Shift+Tab walks it back");
  });
});

test("Tab keeps its list for 3 s and rebuilds a wrapped list older than 1 s — as before L2", () => {
  const world = fixedWorld();
  withClock(world, (clock) => {
    assert.deepEqual(tabs(world, clock, 2), [BOAR, YELLOW]);
    // The ogre walks up to 2 yards: a kept list does not see it move.
    world.state.objects.get(OGRE).position = { x: 2, y: 0, z: 0, orientation: 0 };
    assert.deepEqual(tabs(world, clock, 2), [OGRE, BEHIND], "the kept order");
    // A wrap within a second of the build stays on the old list.
    assert.deepEqual(tabs(world, clock, 1), [BOAR], "wrap, list younger than 1 s");
    // Past three seconds since the last press the next press rebuilds.
    clock.now += 3_000;
    assert.deepEqual(tabs(world, clock, 1), [OGRE], "rebuilt: the ogre now stands nearest");
    // A wrap of a list older than one second rebuilds at the wrap.
    assert.deepEqual(tabs(world, clock, 3), [BOAR, YELLOW, BEHIND]);
    clock.now += 1_000;
    world.state.objects.get(BOAR).position = { x: 1, y: 0, z: 0, orientation: 0 };
    assert.deepEqual(tabs(world, clock, 1), [BOAR], "the wrap rebuilt the list: the boar at 1 yd is first");
    // A cleared selection drops the list (0x524bf0 with guid 0 zeroes the build time).
    tabs(world, clock, 1);
    world.selectTarget(undefined);
    assert.deepEqual(tabs(world, clock, 1), [BOAR], "a fresh start after the clear");
  });
});

test("every TargetNearest* mode between Tab presses leaves Tab's own list as a fresh Tab would build it", () => {
  for (const mode of [NEAREST_ANY, NEAREST_ENEMY_PLAYER, NEAREST_FRIEND, NEAREST_FRIEND_PLAYER, NEAREST_PARTY_MEMBER,
    NEAREST_RAID_MEMBER, NEAREST_ENEMY]) {
    const world = fixedWorld();
    withClock(world, (clock) => {
      assert.deepEqual(tabs(world, clock, 2), [BOAR, YELLOW]);
      clock.now += 50;
      targetNearestUnit(mode, false);
      const afterMode = tabs(world, clock, 5);
      // Tab after another mode rebuilds (0x524fc0: mode change), so it starts over from the best —
      // or, after mode 1 itself (the same list), steps on from where that press left it.
      if (mode === NEAREST_ENEMY) {
        assert.deepEqual(afterMode, [BEHIND, BOAR, YELLOW, OGRE, BEHIND], `mode ${mode}`);
      } else {
        assert.deepEqual(afterMode, [...TAB_ORDER, BOAR], `mode ${mode}: Tab rebuilt its own list`);
      }
    });
  }
});

test("the live seam's TargetNearest*/TargetLast* pass `reverse` and the kind through to the browser game", () => {
  const world = fixedWorld();
  withClock(world, (clock) => {
    const press = (body) => { clock.now += 50; body(); return world.targetGuid; };
    assert.equal(press(() => FRAMEXML_LIVE_TARGET_NEAREST.nearest(NEAREST_ENEMY, false)), BOAR);
    assert.equal(press(() => FRAMEXML_LIVE_TARGET_NEAREST.nearest(NEAREST_ENEMY, false)), YELLOW);
    assert.equal(press(() => FRAMEXML_LIVE_TARGET_NEAREST.nearest(NEAREST_ENEMY, true)), BOAR, "reverse steps back");
    // Boar (enemy), paladin (friend), then the guard — neither: last target paladin, last enemy boar.
    world.selectTarget(PALADIN);
    world.selectTarget(GUARD);
    assert.equal(press(() => FRAMEXML_LIVE_TARGET_NEAREST.last("enemy")), BOAR);
    assert.equal(press(() => FRAMEXML_LIVE_TARGET_NEAREST.last("friend")), PALADIN);
    assert.equal(press(() => FRAMEXML_LIVE_TARGET_NEAREST.last("target")), BOAR, "the swap");
  });
});

test("a clear with nothing selected keeps the last target (0x524bf0 with guid 0 and no selection)", () => {
  const history = new TargetHistory();
  history.lastTarget = BOAR;
  history.selected(undefined, undefined, undefined);
  assert.equal(history.lastTarget, BOAR);
});

test("TargetNearest (mode 0) never offers a game object, a far or a side unit, nor the mover", () => {
  const world = fixedWorld();
  withClock(world, (clock) => {
    const picked = new Set();
    for (let press = 0; press < 14; press++) {
      clock.now += 50;
      targetNearestUnit(NEAREST_ANY, false);
      picked.add(world.targetGuid);
    }
    for (const guid of [CHEST, FAR, SIDE, SELF, RAT]) assert.equal(picked.has(guid), false, `0x${guid.toString(16)}`);
    assert.equal(picked.has(GUARD), true, "a friend is anything");
  });
});

// ---- the world client: what selectTarget sends, with and without the history's judge ----

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

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

const WOLF = 0x5678n;
const HOG = 0x9abcn;
const FRIEND = 0x4444n;

async function inWorld() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  const here = { x: 0, y: 0, z: 0, orientation: 0 };
  client.state.move(SELF, { flags: 0, position: here });
  for (const [guid, x] of [[WOLF, 5], [HOG, 9], [FRIEND, 3]]) client.state.move(guid, { flags: 0, position: { ...here, x } });
  client.state.selfGuid = SELF;
  for (const guid of [SELF, WOLF, HOG, FRIEND]) {
    const object = client.state.objects.get(guid);
    object.typeId = guid === SELF || guid === FRIEND ? 4 : 3;
    object.fields.set(HEALTH, 100);
    object.fields.set(FACTION, guid === WOLF || guid === HOG ? 2 : 1);
    if (object.typeId === 4) object.fields.set(FLAGS, 0x8);
  }
  return { client, connection };
}

/** One fixed sequence of selections; the bytes it put on the wire, each read right after its call. */
async function selectionWire(judged) {
  const { client, connection } = await inWorld();
  const previous = { world: game.world, factions: game.factions };
  game.world = client;
  game.factions = factions;
  if (!judged) setTargetHistoryJudge(undefined);
  try {
    const wire = [];
    connection.sent.length = 0;
    for (const guid of [WOLF, HOG, HOG, undefined, undefined, FRIEND, WOLF, SELF, 0x7777n]) {
      client.selectTarget(guid);
      wire.push(connection.sent.splice(0).map(({ opcode, payload }) => `${opcode}:${Buffer.from(payload).toString("hex")}`));
    }
    return { wire, history: [client.targetHistory.lastTarget, client.targetHistory.lastEnemy, client.targetHistory.lastFriend] };
  } finally {
    setTargetHistoryJudge(targetSelectionKind);
    game.world = previous.world;
    game.factions = previous.factions;
    client.close();
  }
}

test("the history's judge changes nothing on the wire: CMSG_SET_SELECTION bytes and timing as without it", async () => {
  const judged = await selectionWire(true);
  const plain = await selectionWire(false);
  assert.deepEqual(judged.wire, plain.wire);
  const select = (guid) => [`${OPCODES.CMSG_SET_SELECTION}:${Buffer.from(new PacketWriter().u64(guid).toUint8Array()).toString("hex")}`];
  assert.deepEqual(judged.wire, [
    select(WOLF), select(HOG), [], select(0n), [], select(FRIEND), select(WOLF), select(SELF), [],
  ], "one packet in the same call per change; none for the same unit, a second clear or an unknown guid");
  // What the judge adds is only the history: the player selected last is a friend by the browser's table.
  assert.deepEqual(judged.history, [WOLF, WOLF, SELF]);
});

test("a departing unit in no history slot costs three comparisons: the group is not even read", () => {
  const history = new TargetHistory();
  history.lastTarget = WOLF;
  const untouchable = { get state() { throw new Error("read"); }, get group() { throw new Error("read"); } };
  for (let guid = 0x100n; guid < 0x110n; guid++) history.unitLeft(guid, untouchable);
  assert.throws(() => history.unitLeft(WOLF, untouchable), /read/, "a remembered guid does consult the group");
});
