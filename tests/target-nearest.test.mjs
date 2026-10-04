import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { game } from "../dist/code/browser/game/Context.js";
import {
  cycleEnemyTarget, targetLastUnit, targetNearestUnit, targetSelectionKind,
} from "../dist/code/browser/game/Targeting.js";
import {
  NEAREST_ENEMY_PLAYER, NEAREST_FRIEND, NEAREST_FRIEND_PLAYER, NEAREST_PARTY_MEMBER, NEAREST_RAID_MEMBER,
} from "../dist/code/browser/game/TargetNearestModes.js";
import { TargetHistory, targetHistoryKind } from "../dist/code/world/TargetHistory.js";
import { FRAMEXML_TARGET_NEAREST_BINDINGS } from "../dist/code/browser/framexml/FrameXmlTargetNearest.js";
import { FRAMEXML_SEAM_BINDINGS } from "../dist/code/browser/framexml/FrameXmlWorldSeam.js";
import { LiveWorldSeam } from "../dist/code/browser/framexml/LiveWorldSeam.js";

/*
 * WORK_PLAN 1.10 (lane L2): TargetNearest* over the Tab list of game/Targeting.ts — one list for every
 * mode, rebuilt when the mode changes (0x524fc0's 0x00bd08d4) — the browser's judge of a new selection
 * for the world client's history (0x524bf0: 0x729a70 enemy, else 0x7293d0 friend), and the Lua names
 * of the stock UI (registration 0xac82c8–0xac8328). Notes: .runtime/re-2026-10-04/l2-targeting/.
 */

const HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;
const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
const BYTES_2 = UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset;
const FACTION = UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset;
const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;

/** Template 2 hostile to everyone; anything else friendly (FactionClient's reaction for the pair). */
const factions = { ready: true, reaction: (_mine, theirs) => (theirs === 2 ? -1 : 1), factionOf: () => undefined };

function unit(guid, { typeId = 3, x = 0, health = 100, faction = 1, pvp = 0, entry = 0 } = {}) {
  const fields = new Map([[HEALTH, health], [FACTION, faction], [BYTES_2, pvp << 8], [ENTRY, entry]]);
  // A player character is player-controlled (UNIT_FLAG_PLAYER_CONTROLLED), as the wire says.
  fields.set(FLAGS, typeId === 4 ? 0x8 : 0);
  return { guid, typeId, position: { x, y: 0, z: 0, orientation: 0 }, fields };
}

const SELF = 1n;
const WOLF = 10n; // hostile creature, 5 yd
const RAPTOR = 11n; // hostile creature, 15 yd
const ALLY = 20n; // friendly player, 8 yd
const GUARD = 21n; // friendly PvP-flagged creature, 12 yd
const VILLAGER = 22n; // friendly creature, not flagged and not CAN_ASSIST: no help to give, 6 yd
const SQUIRREL = 23n; // friendly flagged critter (CreatureType 8), 4 yd
const FALLEN = 24n; // friendly player at 0 health, 7 yd
const RAIDER = 25n; // friendly player of the raid, another subgroup, 9 yd

function world() {
  const objects = new Map([
    [SELF, unit(SELF, { typeId: 4 })],
    [WOLF, unit(WOLF, { x: 5, faction: 2 })],
    [RAPTOR, unit(RAPTOR, { x: 15, faction: 2 })],
    [ALLY, unit(ALLY, { typeId: 4, x: 8 })],
    [GUARD, unit(GUARD, { x: 12, pvp: 0x01 })],
    [VILLAGER, unit(VILLAGER, { x: 6, entry: 501 })],
    [SQUIRREL, unit(SQUIRREL, { x: 4, pvp: 0x01, entry: 502 })],
    [FALLEN, unit(FALLEN, { typeId: 4, x: 7, health: 0 })],
    [RAIDER, unit(RAIDER, { typeId: 4, x: 9 })],
  ]);
  return {
    state: { selfGuid: SELF, objects },
    targetGuid: undefined,
    forcedReactions: new Map(),
    selectionClears: 0,
    creatureTemplates: new Map([
      [501, { entry: 501, found: true, flags: 0, creatureType: 7 }],
      [502, { entry: 502, found: true, flags: 0, creatureType: 8 }],
    ]),
    group: undefined,
    targetHistory: new TargetHistory(),
    selected: [],
    selectTarget(guid) {
      this.selected.push(guid);
      this.targetHistory.selected(this.targetGuid, guid, guid === undefined ? undefined : targetSelectionKind(objects.get(guid)));
      this.targetGuid = guid;
    },
  };
}

async function withWorld(body) {
  const previous = { world: game.world, factions: game.factions };
  try {
    const current = world();
    game.world = current;
    game.factions = factions;
    await body(current);
  } finally {
    game.world = previous.world;
    game.factions = previous.factions;
  }
}

test("TargetNearestFriend steps the units the player can assist, and Tab then rebuilds its own list", () => withWorld((w) => {
  assert.equal(targetNearestUnit(NEAREST_FRIEND, false), true);
  assert.equal(targetNearestUnit(NEAREST_FRIEND, false), true);
  assert.equal(targetNearestUnit(NEAREST_FRIEND, false), true);
  // Self is the mover; the villager cannot be helped (no PvP flag, no CAN_ASSIST), the squirrel is a
  // critter (0x524440's net), the fallen player has no health (mode 3).
  assert.deepEqual(w.selected, [ALLY, RAIDER, GUARD]);
  assert.equal(targetNearestUnit(NEAREST_FRIEND, true), true);
  assert.deepEqual(w.selected.at(-1), RAIDER, "reverse steps back");
  cycleEnemyTarget(1);
  assert.equal(w.selected.at(-1), WOLF, "Tab after a friend search starts its own list from the best enemy");
  cycleEnemyTarget(1);
  assert.equal(w.selected.at(-1), RAPTOR);
  assert.equal(targetNearestUnit(NEAREST_ENEMY_PLAYER, false), false, "no enemy player around");
  assert.equal(w.targetGuid, RAPTOR, "and the selection stays");
  assert.equal(targetNearestUnit(NEAREST_FRIEND_PLAYER, false), true);
  assert.equal(w.selected.at(-1), ALLY, "a friendly player; the flagged guard is no player");
}));

test("TargetNearestPartyMember takes the subgroup, TargetNearestRaidMember the whole raid, the dead included", () => withWorld((w) => {
  w.group = {
    groupType: 0x02, ownSubGroup: 0,
    members: [{ guid: FALLEN, subGroup: 0 }, { guid: RAIDER, subGroup: 1 }],
  };
  assert.equal(targetNearestUnit(NEAREST_PARTY_MEMBER, false), true);
  assert.equal(w.selected.at(-1), FALLEN, "a dead party member is still taken (0x52c680)");
  assert.equal(targetNearestUnit(NEAREST_PARTY_MEMBER, false), true);
  assert.equal(w.selected.at(-1), FALLEN, "the raider of another subgroup is not party");
  assert.equal(targetNearestUnit(NEAREST_RAID_MEMBER, false), true);
  assert.equal(targetNearestUnit(NEAREST_RAID_MEMBER, false), true);
  assert.deepEqual(w.selected.slice(-2), [FALLEN, RAIDER]);
}));

test("a new selection is judged with the browser's tables: enemy, friend or neither", () => withWorld((w) => {
  const { objects } = w.state;
  assert.equal(targetSelectionKind(objects.get(WOLF)), "enemy");
  assert.equal(targetSelectionKind(objects.get(ALLY)), "friend");
  assert.equal(targetSelectionKind(objects.get(GUARD)), "friend");
  assert.equal(targetSelectionKind(objects.get(VILLAGER)), undefined);
  assert.equal(targetHistoryKind(objects.get(ALLY), () => true), "friend", "importing game/Targeting registers the judge");
  game.factions = undefined;
  assert.equal(targetSelectionKind(objects.get(WOLF)), undefined, "without the faction table nothing is judged");
  assert.equal(targetSelectionKind(objects.get(ALLY)), undefined);
}));

test("TargetLastEnemy after healing a friend goes back to the enemy; TargetLastTarget swaps", () => withWorld((w) => {
  w.selectTarget(WOLF);
  w.selectTarget(ALLY);
  assert.equal(targetLastUnit("enemy"), true);
  assert.equal(w.targetGuid, WOLF);
  assert.equal(targetLastUnit("friend"), true);
  assert.equal(w.targetGuid, ALLY);
  assert.equal(targetLastUnit("target"), true);
  assert.equal(w.targetGuid, WOLF);
  assert.equal(targetLastUnit("target"), true);
  assert.equal(w.targetGuid, ALLY);
}));

test("the stock UI's TargetNearest* and TargetLast* reach the browser's list through the live seam", () => withWorld((w) => {
  const calls = [];
  const host = { targetNearest: { nearest: (mode, reverse) => calls.push([mode, reverse]), last: (kind) => calls.push([kind]) } };
  const names = Object.keys(FRAMEXML_TARGET_NEAREST_BINDINGS);
  assert.deepEqual(names, [
    "TargetNearest", "TargetNearestEnemy", "TargetNearestEnemyPlayer", "TargetNearestFriend", "TargetNearestFriendPlayer",
    "TargetNearestPartyMember", "TargetNearestRaidMember", "TargetLastTarget", "TargetLastEnemy", "TargetLastFriend",
  ]);
  for (const [index, name] of names.slice(0, 7).entries()) {
    assert.deepEqual(FRAMEXML_SEAM_BINDINGS[name](host, ["1"]), [], `${name} returns nothing`);
    assert.deepEqual(calls.at(-1), [index, true], name);
  }
  // ChatFrame.lua passes the text left after the options: "" for a bare /targetenemy.
  FRAMEXML_SEAM_BINDINGS.TargetNearestEnemy(host, [""]);
  assert.deepEqual(calls.at(-1), [1, false]);
  FRAMEXML_SEAM_BINDINGS.TargetLastEnemy(host, ["1"]);
  assert.deepEqual(calls.at(-1), ["enemy"], "TargetLastEnemy(action) never reads its argument");
  FRAMEXML_SEAM_BINDINGS.TargetLastTarget(host, []);
  FRAMEXML_SEAM_BINDINGS.TargetLastFriend(host, []);
  assert.deepEqual(calls.slice(-2), [["target"], ["friend"]]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.TargetNearestFriend({}, []), [], "no host member: nothing, no error");

  const seam = new LiveWorldSeam({
    world: () => w, store: () => undefined, spell: () => undefined, focusGuid: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  FRAMEXML_SEAM_BINDINGS.TargetNearestFriend(seam, []);
  assert.equal(w.targetGuid, ALLY, "/targetfriend steps the same list Ctrl+Tab does");
  FRAMEXML_SEAM_BINDINGS.TargetNearestEnemy(seam, []);
  FRAMEXML_SEAM_BINDINGS.TargetLastFriend(seam, []);
  assert.deepEqual(w.selected, [ALLY, WOLF, ALLY]);
}));
