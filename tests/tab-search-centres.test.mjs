// 5.16 (11.11): Tab's two small branches of Wow.exe 0x524fc0 / 0x518e40 — the second search centre around a seated
// player whose seat can attack, and the second "friendly" test 0x715df0 (TREAT_AS_RAID_UNIT on CanAttack's `this`,
// which is the search centre). Notes: .runtime/re-2026-11-11/moves/ (m1.lst, m2.lst), .runtime/re-2026-10-01/a9-combat/.
import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { REACTION_HOSTILE } from "../dist/code/world/FactionRules.js";
import {
  CREATURE_TYPE_FLAG_TREAT_AS_RAID_UNIT, collectTabList, isAttackableUnit,
} from "../dist/code/world/TargetSearch.js";
import { game } from "../dist/code/browser/game/Context.js";
import { cycleEnemyTarget } from "../dist/code/browser/game/Targeting.js";

const HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;
const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
const FACTION = UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset;
const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;
const PLAYER_CONTROLLED = 0x8;
const CAN_ATTACK_SEAT = 0x4000;

function unit(guid, { typeId = 3, x = 0, y = 0, orientation = 0, flags = 0, faction = 1, entry = 0, transport } = {}) {
  const fields = new Map([[HEALTH, 100], [FLAGS, flags], [FACTION, faction], [ENTRY, entry]]);
  return { guid, typeId, position: { x, y, z: 0, orientation }, fields, transport };
}

test("0x514050 / 0x715df0: a TREAT_AS_RAID_UNIT self counts every unit a friend where CanAttack asks it", () => {
  const vehicle = unit(1n, { flags: PLAYER_CONTROLLED });
  const wolf = unit(2n);
  assert.equal(isAttackableUnit(vehicle, wolf, REACTION_HOSTILE), true, "a player-driven vehicle swings at a wolf");
  assert.equal(isAttackableUnit(vehicle, wolf, REACTION_HOSTILE, true), false, "not with the bit (PvC branch)");
  const rival = unit(3n, { typeId: 4, flags: PLAYER_CONTROLLED });
  rival.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, 0x01 << 8);
  vehicle.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, 0x01 << 8);
  assert.equal(isAttackableUnit(vehicle, rival, REACTION_HOSTILE, true), false, "nor in the PvP branch");
  const creature = unit(4n);
  assert.equal(isAttackableUnit(creature, wolf, REACTION_HOSTILE, true), true,
    "the creature-to-creature branch asks 0x514080, which has no such test");
});

/** A vehicle the player drives at the origin facing east; the player in a rear seat facing west; a raider 20 yd west. */
function seated({ seatFlags = CAN_ATTACK_SEAT, rides = 10n } = {}) {
  const vehicle = unit(10n, { flags: PLAYER_CONTROLLED, orientation: 0 });
  const player = unit(1n, { typeId: 4, flags: PLAYER_CONTROLLED, orientation: Math.PI, transport: { guid: rides } });
  const raider = unit(30n, { x: -20 });
  return { objects: [vehicle, player, raider], vehicle, player, raider, seatFlags };
}

test("0x524fc0: nothing around the vehicle, a seat that can attack — the search starts again around the player", () => {
  const { objects, vehicle, player, raider, seatFlags } = seated();
  const centres = [];
  const accept = (object, centre) => {
    centres.push(centre.guid);
    return object.guid === raider.guid;
  };
  const out = [];
  assert.equal(collectTabList(objects, vehicle, player, seatFlags, accept, out), 1);
  assert.equal(out[0].guid, raider.guid, "20 yards ahead of the player's own facing");
  assert.ok(centres.includes(player.guid), "judged with the player as CanAttack's `this`");
  assert.equal(collectTabList(objects, vehicle, player, 0, accept, out), 0, "a seat without CAN_ATTACK: nothing");
  const other = seated({ rides: 99n });
  assert.equal(collectTabList(other.objects, other.vehicle, other.player, CAN_ATTACK_SEAT, accept, out), 0,
    "the mover is not the vehicle the player sits on: nothing");
  assert.equal(collectTabList(objects, player, player, CAN_ATTACK_SEAT, accept, out), 1,
    "the player as the mover finds it the first time");
});

test("0x524fc0: something around the vehicle — no second search", () => {
  const { objects, vehicle, player, seatFlags } = seated();
  const ahead = unit(31n, { x: 15 });
  const out = [];
  assert.equal(collectTabList([...objects, ahead], vehicle, player, seatFlags, (object) => object.guid >= 30n, out), 1);
  assert.equal(out[0].guid, ahead.guid);
});

test("Tab from a TREAT_AS_RAID_UNIT vehicle takes nothing; from an ordinary one it takes the wolf", async () => {
  const previous = { world: game.world, factions: game.factions };
  const make = (templateFlags) => {
    const objects = new Map([
      [1n, unit(1n, { typeId: 4, flags: PLAYER_CONTROLLED, transport: { guid: 10n } })],
      [10n, unit(10n, { flags: PLAYER_CONTROLLED, entry: 900 })],
      [20n, unit(20n, { x: 8, faction: 2 })],
    ]);
    return {
      state: { selfGuid: 1n, objects },
      controlledGuid: 10n,
      targetGuid: undefined,
      forcedReactions: new Map(),
      selectionClears: 0,
      creatureTemplates: new Map([[900, { entry: 900, found: true, flags: templateFlags, creatureType: 9 }]]),
      selected: [],
      selectTarget(guid) {
        this.selected.push(guid);
        this.targetGuid = guid;
      },
    };
  };
  try {
    game.factions = { ready: true, reaction: (_mine, theirs) => (theirs === 2 ? -1 : 1), factionOf: () => undefined };
    const plain = make(0);
    game.world = plain;
    cycleEnemyTarget(1);
    assert.deepEqual(plain.selected, [20n], "an ordinary vehicle's Tab takes the wolf");
    const raidUnit = make(CREATURE_TYPE_FLAG_TREAT_AS_RAID_UNIT);
    game.world = raidUnit;
    cycleEnemyTarget(1);
    assert.deepEqual(raidUnit.selected, [], "a TREAT_AS_RAID_UNIT vehicle's takes nothing");
  } finally {
    game.world = previous.world;
    game.factions = previous.factions;
  }
});
