import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";
import {
  SPELL_ATTR1_CHANNEL_TRACK_TARGET, ShownUnitFacing, UNIT_FACING_SNAP, unitAutoFacing, unitFacingTurn,
} from "../dist/code/world/UnitFacing.js";

// 11.10: «enemies do not look toward the one they attack». The core turns a creature to its victim
// only server-side (`Unit::SetInFront` sends nothing) and leaves the drawing to the client: Wow.exe
// 0x00735f60 draws every unit that is not the active player at its UNIT_FIELD_TARGET while it stands
// and nothing forbids the turn, and follows the chosen facing smoothly.

const F = UPDATE_FIELDS;
let nextGuid = 10n;

function unit({ x = 0, y = 0, orientation = 0, typeId = 3, flags = 0, flags2 = 0, standState = 0, movementFlags = 0,
  target, channelObject, channelSpell = 0, motion, transport } = {}) {
  const fields = new Map();
  const guid = nextGuid++;
  const put = (offset, value) => {
    if (value === undefined) return;
    fields.set(offset, Number(value & 0xffffffffn));
    fields.set(offset + 1, Number(value >> 32n));
  };
  fields.set(F.UNIT_FIELD_FLAGS.offset, flags);
  fields.set(F.UNIT_FIELD_FLAGS_2.offset, flags2);
  fields.set(F.UNIT_FIELD_BYTES_1.offset, standState);
  fields.set(F.UNIT_CHANNEL_SPELL.offset, channelSpell);
  put(F.UNIT_FIELD_TARGET.offset, target);
  put(F.UNIT_FIELD_CHANNEL_OBJECT.offset, channelObject);
  return { guid, typeId, fields, movementFlags, position: { x, y, z: 0, orientation }, motion, transport };
}

function world(...objects) {
  return new Map(objects.map((object) => [object.guid, object]));
}

test("11.10 a standing creature faces its target; one that moves keeps its own facing", () => {
  const victim = unit({ x: 0, y: 5, typeId: 4 });
  const wolf = unit({ x: 0, y: 0, orientation: Math.PI, target: victim.guid });
  const objects = world(victim, wolf);
  assert.ok(Math.abs(unitAutoFacing(wolf, objects) - Math.PI / 2) < 1e-12, "toward +y is a quarter turn");
  // Moving on its own axes, or on a spline, it faces where it goes (0x00735f60: `+0x7cc & 0xf`).
  for (const flags of [MOVEMENT_FLAGS.forward, MOVEMENT_FLAGS.backward, MOVEMENT_FLAGS.strafeLeft, MOVEMENT_FLAGS.strafeRight]) {
    assert.equal(unitAutoFacing({ ...wolf, movementFlags: flags }, objects), undefined);
  }
  assert.equal(unitAutoFacing({ ...wolf, motion: {} }, objects), undefined, "a chase spline steers it");
  // Turning on the spot is not moving.
  assert.ok(unitAutoFacing({ ...wolf, movementFlags: MOVEMENT_FLAGS.turnLeft }, objects) !== undefined);
  // No target, a target out of view, a target that is no unit: nothing to face.
  assert.equal(unitAutoFacing(unit({ target: undefined }), objects), undefined);
  assert.equal(unitAutoFacing(unit({ target: 999n }), objects), undefined);
  const chest = { ...unit(), typeId: 5 };
  assert.equal(unitAutoFacing(unit({ target: chest.guid }), world(chest)), undefined);
});

test("11.10 what keeps a unit's own facing: a player, a stun, CANNOT_TURN, possession, a seat, sitting", () => {
  const victim = unit({ x: 3, y: 0 });
  const objects = world(victim);
  const facing = (options) => unitAutoFacing(unit({ target: victim.guid, ...options }), objects);
  assert.equal(facing({}), 0, "the control case faces +x");
  assert.equal(facing({ typeId: 4 }), undefined, "a player turns itself");
  assert.equal(facing({ flags: 0x0004_0000 }), undefined, "UNIT_FLAG_STUNNED");
  assert.equal(facing({ flags: 0x0100_0000 }), undefined, "UNIT_FLAG_POSSESSED");
  assert.equal(facing({ flags2: 0x0000_8000 }), undefined, "UNIT_FLAG2_CANNOT_TURN");
  assert.equal(facing({ standState: 1 }), undefined, "sitting: the stand state must be 0 (vtable+0x138)");
  assert.equal(facing({ standState: 0x0300 }), 0, "only byte 0 of UNIT_FIELD_BYTES_1 is the stand state");
  // A vehicle seat keeps its facing; a ship's deck does not.
  const vehicle = unit({ x: 9, y: 9 });
  const ship = { ...unit({ x: 9, y: 9 }), typeId: 5 };
  const aboard = (carrier) => unitAutoFacing(unit({ target: victim.guid, transport: { guid: carrier.guid } }), world(victim, carrier));
  assert.equal(aboard(vehicle), undefined);
  assert.equal(aboard(ship), 0);
  // Pet-like flags do not stop it: UNIT_FLAG_PLAYER_CONTROLLED and PET_IN_COMBAT.
  assert.equal(facing({ flags: 0x0000_0808 }), 0);
});

test("11.10 a channel that tracks its target faces the channel's object", () => {
  const victim = unit({ x: 3, y: 0 });
  const totem = unit({ x: 0, y: -3 });
  const objects = world(victim, totem);
  const caster = unit({ target: victim.guid, channelObject: totem.guid, channelSpell: 1234 });
  const tracks = (spellId) => (spellId === 1234 ? true : undefined);
  assert.ok(Math.abs(unitAutoFacing(caster, objects, tracks) + Math.PI / 2) < 1e-12, "SPELL_ATTR1_CHANNEL_TRACK_TARGET");
  assert.equal(unitAutoFacing(caster, objects, () => false), 0, "any other channel keeps the target");
  assert.equal(unitAutoFacing(caster, objects, () => undefined), 0, "and so does an unknown row");
  assert.equal(SPELL_ATTR1_CHANNEL_TRACK_TARGET, 0x4000);
});

test("11.10 the drawn facing takes half the averaged difference a frame, and never overshoots", () => {
  const shown = new ShownUnitFacing();
  assert.equal(shown.step(1, "average", 1 / 60), 1, "the first frame draws the chosen facing");
  // A turn of a quarter: half of it on the first frame, then half the average of the last four.
  const quarter = 1 + Math.PI / 2;
  assert.ok(Math.abs(shown.step(quarter, "average", 1 / 60) - (1 + Math.PI / 4)) < 1e-12);
  let previous = shown.angle;
  for (let frame = 0; frame < 30; frame++) {
    const next = shown.step(quarter, "average", 1 / 60);
    assert.ok(next >= previous - 1e-12 && next <= quarter + 1e-12, `frame ${frame}: ${next}`);
    previous = next;
  }
  assert.equal(shown.angle, quarter, "inside UNIT_FACING_SNAP it lands exactly");
  assert.equal(UNIT_FACING_SNAP, 0.01);
  // The short way round across ±π.
  const across = new ShownUnitFacing();
  across.step(3, "average", 1 / 60);
  const stepped = across.step(-3, "average", 1 / 60);
  assert.ok(stepped > 3 || stepped < -3, `went the long way: ${stepped}`);
});

test("11.10 a pet's drawn facing springs at 20 rad/s, 30 in combat", () => {
  assert.equal(unitFacingTurn(unit({})), "average");
  assert.equal(unitFacingTurn(unit({ typeId: 4, flags: 0x8 })), "average", "a player averages whatever its flags");
  assert.equal(unitFacingTurn(unit({ flags: 0x8 })), 20);
  assert.equal(unitFacingTurn(unit({ flags: 0x808 })), 30);
  const shown = new ShownUnitFacing();
  shown.step(0, 20, 1 / 60);
  let angle = 0;
  for (let frame = 0; frame < 6; frame++) angle = shown.step(1, 20, 1 / 60);
  assert.ok(angle > 0.5 && angle < 1, `a tenth of a second in: ${angle}`);
  for (let frame = 0; frame < 60; frame++) angle = shown.step(1, 20, 1 / 60);
  assert.ok(Math.abs(angle - 1) < 1e-3, `a second in: ${angle}`);
});

test("11.10 the renderer draws a unit it does not move at that facing, and the character at its own", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const start = source.indexOf("    unit.node.position.set(position.x, position.z, -position.y);");
  const end = source.indexOf("const content = unitContentVisible(", start);
  assert.ok(start > 0 && end > start, "the unit's placement in #drawUnit");
  const yaw = source.slice(start, end);
  assert.match(yaw, /unit\.node\.rotation\.y = mover \|\| world === undefined \? position\.orientation/);
  assert.match(yaw, /unitAutoFacing\(object, world\.objects\) \?\? position\.orientation, unitFacingTurn\(object\), elapsed/);
  assert.match(yaw, /const mover = self \|\| \(world !== undefined && world\.predictedGuid === object\.guid\)/);
  assert.match(source, /this\.#unitShadowCasters\.decide\(object\.guid, rank, distance, this\.#lightingProfile\),[^\n]*\n\s*state\);/,
    "the frame's world state reaches #drawUnit");
});
