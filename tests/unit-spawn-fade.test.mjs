import assert from "node:assert/strict";
import test from "node:test";
import {
  UNIT_SPAWN_FADE_MS, carrierGuid, noteUnitSpawn, unitAlphaWalking, unitFadesIn, unitSpawnFactor,
} from "../dist/code/browser/UnitSpawnFade.js";
import { unitDisplayAlpha } from "../dist/code/browser/UnitDisplayFade.js";

// 15.11 (6.11): a new unit fades in as Wow.exe does — byte +0xc8 from 0 (constructor 0x00745e60) to CreatureModelAlpha
// over 1000 ms on creation (0x0073fcc0 → 0x00744a50), in whole bytes (0x0071ac30), unless 0x00716650 says no.

test("6.11 a new unit's alpha walks 0 → its target byte over 1000 ms in whole bytes", () => {
  assert.equal(UNIT_SPAWN_FADE_MS, 1000);
  const unit = {};
  assert.equal(unitSpawnFactor(unit, undefined, 5000), 1, "no stamp: drawn as it is");
  assert.equal(unitSpawnFactor(unit, 1000, 1000), 0, "the first frame from nothing");
  assert.equal(unitSpawnFactor(unit, 1000, 1400), Math.trunc(255 * 400 / 1000) / 255, "not done at 0.4 s");
  assert.equal(unitSpawnFactor(unit, 1000, 2000), 1);
  // A display with CreatureModelAlpha 128: the byte walks to 128, so the share is trunc(128·t/1000)/128.
  const ghost = {};
  unitDisplayAlpha(ghost, 128 / 255, 0);
  assert.equal(unitSpawnFactor(ghost, 0, 500), 64 / 128);
});

test("6.11 the three flags of 0x00716650 skip the fade, and a skip is kept for the unit", () => {
  assert.equal(unitFadesIn({}), true);
  assert.equal(unitFadesIn({ flags2: 0x20 }), false, "UNIT_FLAG2_DO_NOT_FADE_IN");
  assert.equal(unitFadesIn({ flags: 0x2 }), false, "UNIT_FLAG_NON_ATTACKABLE (the core's old SPAWNING)");
  assert.equal(unitFadesIn({ visFlags: 0x2 }), false, "UNIT_VIS_FLAGS_CREEP");
  assert.equal(unitFadesIn({ flags: 0x4, flags2: 0x10, visFlags: 0x1 }), true, "other bits do not");
  const unit = {};
  noteUnitSpawn(unit, false);
  assert.equal(unitSpawnFactor(unit, 1000, 1000), 1, "there at once");
});

test("6.11 a passenger asks its carrier (0x0074b8b0): absent or itself fading → no fade", () => {
  assert.equal(carrierGuid(0xf150000000001234n), true, "a vehicle");
  assert.equal(carrierGuid(0x0000000000000042n), true, "a player");
  assert.equal(carrierGuid(0xf130000000001234n), false, "a creature");
  assert.equal(carrierGuid(0x1fc0000000000005n), false, "a transport game object (ship, zeppelin)");
  assert.equal(carrierGuid(0n), false);
  assert.equal(unitFadesIn({ carrier: { present: true, fading: false } }), true);
  assert.equal(unitFadesIn({ carrier: { present: true, fading: true } }), false);
  assert.equal(unitFadesIn({ carrier: { present: false, fading: false } }), false);
  const vehicle = {};
  assert.equal(unitAlphaWalking(vehicle, 0, 300), true, "the vehicle's own fade-in");
  assert.equal(unitAlphaWalking(vehicle, 0, 1000), false);
});
