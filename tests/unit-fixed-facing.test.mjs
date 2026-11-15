// 15.11 (5.32): the facing a creature keeps after SMSG_ATTACK_STOP said its melee victim died (Wow.exe +0xa30 bit 0,
// +0xab8; set by 0x00756770, cleared only by the unit's own revival 0x0073d530). The sequence is the one the Wow.exe
// stand recorded (F:\WowOracle\runs\face6-q1-flag.bones against face6-q1-noflag.bones): the kill angle held through
// a cleared target, a SetFacingTo, a new target, a walk and a second fight; the revival ended it.
import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";
import { NO_UNIT_FACING_INPUTS, unitAutoFacing } from "../dist/code/world/UnitFacing.js";
import { UnitFixedFacings } from "../dist/code/world/UnitFixedFacing.js";
import { UnitFacingInputsBuilder } from "../dist/code/world/UnitFacingSources.js";

const F = UPDATE_FIELDS;
let nextGuid = 100n;

function unit({ x = 0, y = 0, orientation = 0, typeId = 3, target, standState = 0, flags = 0, health = 1000 } = {}) {
  const fields = new Map();
  fields.set(F.UNIT_FIELD_FLAGS.offset, flags);
  fields.set(F.UNIT_FIELD_BYTES_1.offset, standState);
  fields.set(F.UNIT_FIELD_HEALTH.offset, health);
  if (target !== undefined) {
    fields.set(F.UNIT_FIELD_TARGET.offset, Number(target & 0xffffffffn));
    fields.set(F.UNIT_FIELD_TARGET.offset + 1, Number(target >> 32n));
  }
  return { guid: nextGuid++, typeId, fields, movementFlags: 0, position: { x, y, z: 0, orientation } };
}
const setTarget = (object, guid) => {
  object.fields.set(F.UNIT_FIELD_TARGET.offset, Number(guid & 0xffffffffn));
  object.fields.set(F.UNIT_FIELD_TARGET.offset + 1, Number(guid >> 32n));
};
const close = (actual, expected, message) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`);

/** The stand's scene: A at the origin facing +x, its victim B to its left (+y), the player behind A (−x). */
function scene() {
  const victim = unit({ x: 0, y: 5 });
  const player = unit({ x: -5, y: 0, typeId: 4 });
  const attacker = unit({ orientation: 0, target: victim.guid });
  const objects = new Map([victim, player, attacker].map((o) => [o.guid, o]));
  const fixed = new UnitFixedFacings();
  const facing = () => unitAutoFacing(attacker, objects, undefined, undefined, { ...NO_UNIT_FACING_INPUTS, fixedFacings: fixed.current(objects) });
  return { victim, player, attacker, objects, fixed, facing };
}

test("a kill fixes the attacker's facing at its victim: no target, a new target, a walk and a second fight do not move it", () => {
  const { victim, player, attacker, objects, fixed, facing } = scene();
  close(facing(), Math.PI / 2, "facing its target");
  fixed.attackStopped(attacker.guid, victim.guid, true, objects);
  setTarget(attacker, 0n);
  close(facing(), Math.PI / 2, "target cleared: still the victim's angle, not its own facing");
  attacker.position.orientation = -Math.PI / 2; // SetFacingTo
  close(facing(), Math.PI / 2, "a new server facing does not move it");
  setTarget(attacker, player.guid);
  close(facing(), Math.PI / 2, "nor a new target");
  attacker.motion = {};
  assert.equal(facing(), undefined, "walking, it faces the way it walks");
  delete attacker.motion;
  attacker.position = { ...attacker.position, x: 2, y: -2 };
  close(facing(), Math.PI / 2, "stopped: the kill angle again, not recomputed from the new place");
  fixed.attackStopped(attacker.guid, player.guid, false, objects);
  close(facing(), Math.PI / 2, "a fight that ends without a death leaves it");
});

test("the same stop without NowDead fixes nothing: the unit follows its target and then its own facing", () => {
  const { victim, player, attacker, objects, fixed, facing } = scene();
  fixed.attackStopped(attacker.guid, victim.guid, false, objects);
  setTarget(attacker, 0n);
  assert.equal(facing(), undefined, "its own facing");
  setTarget(attacker, player.guid);
  close(facing(), Math.PI, "its new target");
});

test("its own revival ends it; dying alone does not", () => {
  const { victim, attacker, objects, fixed, facing } = scene();
  fixed.attackStopped(attacker.guid, victim.guid, true, objects);
  setTarget(attacker, 0n);
  attacker.fields.set(F.UNIT_FIELD_HEALTH.offset, 0);
  close(facing(), Math.PI / 2, "dead, the bit stays");
  attacker.fields.set(F.UNIT_FIELD_HEALTH.offset, 1000);
  assert.equal(facing(), undefined, "revived (0x0073d530): its own facing");
  // The dynamic-flags handler revives too (UNIT_DYNFLAG_DEAD cleared).
  fixed.attackStopped(attacker.guid, victim.guid, true, objects);
  attacker.fields.set(F.UNIT_DYNAMIC_FLAGS.offset, 0x20);
  close(facing(), Math.PI / 2);
  attacker.fields.set(F.UNIT_DYNAMIC_FLAGS.offset, 0);
  assert.equal(facing(), undefined);
});

test("a victim out of view, a unit created again, or a turn the unit may not make leave no fixed facing", () => {
  const { victim, attacker, objects, fixed, facing } = scene();
  objects.delete(victim.guid);
  fixed.attackStopped(attacker.guid, victim.guid, true, objects);
  setTarget(attacker, 0n);
  assert.equal(facing(), undefined, "0x00756770 needs the victim in view");
  objects.set(victim.guid, victim);
  fixed.attackStopped(attacker.guid, victim.guid, true, objects);
  close(facing(), Math.PI / 2);
  // Seated, stunned or moving on its own axes, 0x00735f60 never reaches the bit.
  attacker.fields.set(F.UNIT_FIELD_BYTES_1.offset, 1);
  assert.equal(facing(), undefined, "seated");
  attacker.fields.set(F.UNIT_FIELD_BYTES_1.offset, 0);
  attacker.fields.set(F.UNIT_FIELD_FLAGS.offset, 0x40000);
  assert.equal(facing(), undefined, "stunned");
  attacker.fields.set(F.UNIT_FIELD_FLAGS.offset, 0);
  attacker.movementFlags = MOVEMENT_FLAGS.forward;
  assert.equal(facing(), undefined, "moving");
  attacker.movementFlags = 0;
  // Destroyed and created again: the constructor starts without it.
  const again = { ...attacker, fields: new Map(attacker.fields) };
  objects.set(attacker.guid, again);
  assert.equal(fixed.current(objects).has(attacker.guid), false);
});

test("the facing inputs carry the world's fixed facings each frame", () => {
  const { victim, attacker, objects, fixed } = scene();
  fixed.attackStopped(attacker.guid, victim.guid, true, objects);
  const none = { casts: new Map(), creatureTemplates: new Map() };
  const built = new UnitFacingInputsBuilder().build({ ...none, fixedFacings: fixed, state: { objects } }, undefined);
  close(built.fixedFacings.get(attacker.guid), Math.PI / 2, "by guid");
  assert.equal(new UnitFacingInputsBuilder().build(none, undefined).fixedFacings, undefined, "a world without them");
});
