import assert from "node:assert/strict";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import {
  advancePhysics, beginHeld, characterPitchNow, endHeld, forgetMovementState, releaseAllInput, requestMoverPitch, setSteering,
} from "../dist/code/browser/input/Movement.js";
import { vehicleAimInput, setVehicleAimPower } from "../dist/code/browser/game/VehicleAim.js";
import { missileShotFor, pageMissileShotSource, worldSegmentHit } from "../dist/code/browser/game/MissileShot.js";
import { forgetSpellMissileClient, spellMissileClient, spellMissiles } from "../dist/code/browser/SpellMissileClient.js";
import { startVehicleData, vehicleCatalog } from "../dist/code/browser/VehicleClient.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { missileShotSource } from "../dist/code/world/MissileCast.js";
import { SPELL_MISSILE_CATALOG_VERSION, SpellMissileCatalog, spellMissileEntry } from "../dist/code/world/SpellMissileDbc.js";
import {
  VEHICLE_CATALOG_VERSION, VEHICLE_COLUMN, VEHICLE_FORMAT, VEHICLE_SEAT_FORMAT, vehicleCatalogFrom,
} from "../dist/code/world/VehicleDbc.js";

// 11.02-E: the browser half of aiming — the movement code's pitch as the aim (Movement.ts `requestMoverPitch` and its
// registration in game/VehicleAim.ts; Wow.exe 0x005fb3a0 for the active mover), the page's missile solver
// (game/MissileShot.ts: the tables, the mover's pitch, the power, the terrain and the collision world as 0x0077f310's
// ray test) and the missile tables' client (browser/SpellMissileClient.ts, `/dbc/spell-missiles?v=1`).

const SELF = 0x1n;
const VEHICLE = 0xf150_7d9a_0000_0042n;
const OTHER = 0xf150_7d9a_0000_0043n;
const TURRET = 9101; // ALLOW_PITCHING | CUSTOM_PITCH | ADJUST_AIM_ANGLE, −0.3…0.4
const FLAT = 9102;   // no ALLOW_PITCHING: its pitch does not count
const POWER = 9103;  // ALLOW_PITCHING | ADJUST_AIM_POWER

function vehicleRow({ id, flags, pitchMin = 0, pitchMax = 0 }) {
  const row = [...VEHICLE_FORMAT].map((kind) => (kind === "s" ? "" : 0));
  row[VEHICLE_COLUMN.ID] = id;
  row[VEHICLE_COLUMN.Flags] = flags;
  row[VEHICLE_COLUMN.TurnSpeed] = 1;
  row[VEHICLE_COLUMN.PitchSpeed] = 1;
  row[VEHICLE_COLUMN.PitchMin] = pitchMin;
  row[VEHICLE_COLUMN.PitchMax] = pitchMax;
  return row;
}

const VEHICLES = {
  version: VEHICLE_CATALOG_VERSION,
  vehicles: [
    vehicleRow({ id: TURRET, flags: 0x10 | 0x40 | 0x400, pitchMin: -0.3, pitchMax: 0.4 }),
    vehicleRow({ id: FLAT, flags: 0x40 | 0x400, pitchMin: -0.3, pitchMax: 0.4 }),
    vehicleRow({ id: POWER, flags: 0x10 | 0x800 }),
  ],
  seats: [[...VEHICLE_SEAT_FORMAT].map((_, column) => (column === 0 ? 1 : 0))],
  indicators: [],
  indicatorSeats: [],
};

let gateway = 0;
async function useVehicles(answer) {
  gateway++;
  const client = startVehicleData(`ws://127.0.0.${gateway}:28090`, { fetch: async () => new Response(JSON.stringify(answer), { status: 200 }) });
  await client.load();
  return vehicleCatalog();
}

const toggles = () => ({ rooted: false, waterWalking: false, featherFall: false, hovering: false, canFly: false, gravityDisabled: false, collisionHeight: 0 });

function vehicleWorld(vehicleId) {
  const sent = [];
  const character = {
    guid: SELF, typeId: 4, movementFlags: 0, position: { x: 0, y: 0, z: 2, orientation: 0 },
    transport: { guid: VEHICLE, x: 0, y: 0, z: 2, orientation: 0, seat: 0 }, fields: new Map(),
  };
  const vehicle = {
    guid: VEHICLE, typeId: 3, movementFlags: 0, vehicleId, position: { x: 10, y: 20, z: 5, orientation: 0.5 },
    speeds: new Map([["run", 7], ["turnRate", Math.PI], ["pitchRate", 1]]), fields: new Map(),
  };
  const other = { guid: OTHER, typeId: 3, movementFlags: 0, vehicleId: TURRET, pitch: 0.2, position: { x: 0, y: 0, z: 0, orientation: 0 }, fields: new Map() };
  const objects = new Map([[SELF, character], [VEHICLE, vehicle], [OTHER, other]]);
  const world = {
    mapId: 0, movementReady: true, controlledGuid: VEHICLE, state: { selfGuid: SELF, objects },
    movementState: toggles(), speeds: new Map([["run", 7]]),
    movementStateOf: () => toggles(), speedsOf: () => new Map(),
    sendMovement: (opcode, flags, position, extra) => sent.push({ guid: SELF, opcode, extra }),
    sendMovementAs: (guid, opcode, flags, position, extra) => sent.push({ guid, opcode, extra }),
  };
  return { world, sent, vehicle };
}

function withWorld(world, body) {
  forgetMovementState();
  game.world = world;
  game.worldLoading = false;
  game.terrain = { heightAt: () => 0, liquidAt: () => undefined, isHole: () => false };
  try {
    return body();
  } finally {
    releaseAllInput();
    setSteering(false);
    forgetMovementState();
    game.world = undefined;
    game.terrain = undefined;
  }
}

test("11.02-E: loading the movement code registers the aim input and the page's missile solver", () => {
  assert.equal(missileShotSource(), pageMissileShotSource);
  const input = vehicleAimInput();
  assert.ok(input);
  assert.equal(typeof input.moverPitch, "function");
});

test("11.02-E: the aim request — a pitching vehicle mover takes it inside its band (0x005fb3a0); nothing else does", async () => {
  await useVehicles(VEHICLES);
  const { world, sent } = vehicleWorld(TURRET);
  withWorld(world, () => {
    advancePhysics(0.016);
    assert.equal(requestMoverPitch(0.25), true);
    assert.equal(characterPitchNow(), 0.25);
    assert.equal(vehicleAimInput().moverPitch(), 0.25, "the aim input reads the same pitch");
    assert.equal(vehicleAimInput().setMoverPitch(5), true);
    assert.equal(characterPitchNow(), 0.4, "PitchMax");
    assert.equal(requestMoverPitch(Number.NaN), false);
    advancePhysics(0.016);
    assert.equal(characterPitchNow(), 0.4, "held: no key, no steer, on the ground with ALWAYS_ALLOW_PITCHING");
    sent.length = 0;
    vehicleAimInput().pitchKey("down", true);
    assert.deepEqual(sent.map(({ guid, opcode }) => [guid, opcode]), [[VEHICLE, OPCODES.MSG_MOVE_START_PITCH_DOWN]],
      "VehicleAimDownStart is PitchDownStart (0x005fc920)");
    vehicleAimInput().pitchKey("down", false);
    assert.equal(sent.at(-1).opcode, OPCODES.MSG_MOVE_STOP_PITCH);
  });
  const flat = vehicleWorld(FLAT);
  withWorld(flat.world, () => {
    assert.equal(requestMoverPitch(0.25), false, "its pitch does not count (no ALLOW_PITCHING)");
    assert.equal(characterPitchNow(), 0);
  });
  const foot = vehicleWorld(TURRET);
  foot.world.controlledGuid = undefined;
  foot.world.state.objects.get(SELF).transport = undefined;
  withWorld(foot.world, () => {
    assert.equal(requestMoverPitch(0.25), false, "the character on foot");
    assert.equal(characterPitchNow(), 0);
  });
});

test("11.02-E: the world's ray test — the collision world and the heightfield, the nearer one, holes are open", () => {
  const savedCollision = game.collision;
  const savedTerrain = game.terrain;
  try {
    // Ground rising at x ≥ 10 to z = 5.
    game.terrain = { heightAt: (_map, x) => (x >= 10 ? 5 : 0), isHole: (_map, x) => x >= 30 };
    game.collision = undefined;
    const from = { x: 0, y: 0, z: 3 };
    assert.ok(Math.abs(worldSegmentHit(0, from, { x: 20, y: 0, z: 3 }) - 0.5) < 1e-3, "the step up at x = 10");
    assert.equal(worldSegmentHit(0, from, { x: 9, y: 0, z: 2 }), undefined, "above the ground all the way");
    assert.equal(worldSegmentHit(0, { x: 31, y: 0, z: 3 }, { x: 39, y: 0, z: 1 }), undefined, "a hole is no ground");
    assert.equal(worldSegmentHit(undefined, from, { x: 20, y: 0, z: 3 }), undefined, "no map, no terrain");
    game.collision = { world: { firstHit: () => ({ t: 0.25, flags: 0 }) } };
    assert.equal(worldSegmentHit(0, from, { x: 20, y: 0, z: 3 }), 0.25, "a wall before the slope");
    game.collision = { world: { firstHit: () => ({ t: 0.75, flags: 0 }) } };
    assert.ok(Math.abs(worldSegmentHit(0, from, { x: 20, y: 0, z: 3 }) - 0.5) < 1e-3, "the slope before the wall");
    game.terrain = { heightAt: () => undefined, isHole: () => false };
    assert.equal(worldSegmentHit(0, from, { x: 20, y: 0, z: -3 }), 0.75, "tiles not loaded: only the wall");
  } finally {
    game.collision = savedCollision;
    game.terrain = savedTerrain;
  }
});

test("11.02-E: the solver over the page — the mover's pitch, another unit's packet pitch, the power, the unit's place", async () => {
  const vehicles = await useVehicles(VEHICLES);
  const missiles = new SpellMissileCatalog(
    [spellMissileEntry([1023, 1, -0.262, 1.047, 30, 90, 0, 0, 0, 0, 0, 0, 40, 0, 0])], [[57609, 1023]]);
  const { world } = vehicleWorld(TURRET);
  const fixed = () => 0.5;
  withWorld(world, () => {
    requestMoverPitch(0.3);
    const shot = missileShotFor(VEHICLE, 57609, missiles, vehicles, () => 0, fixed);
    assert.ok(Math.abs(shot.elevation - 0.3) < 1e-12, "the movement code's pitch, plus the centred jitter");
    assert.equal(shot.speed, 60, "no ADJUST_AIM_POWER: the middle of 30…90");
    assert.deepEqual([shot.fire.x, shot.fire.y, shot.fire.z].map((v) => +v.toFixed(9)), [10, 20, 5], "the unit's position (0x0071a720's fallback)");
    assert.equal(shot.time, 0, "the first step hit");
    const other = missileShotFor(OTHER, 57609, missiles, vehicles, () => 0, fixed);
    assert.ok(Math.abs(other.elevation - 0.2) < 1e-12, "not the mover: its last packet's pitch");
    assert.equal(missileShotFor(VEHICLE, 133, missiles, vehicles, () => 0, fixed), undefined, "no row");
    assert.equal(missileShotFor(0x99n, 57609, missiles, vehicles, () => 0, fixed), undefined, "not in view");
    world.state.objects.get(VEHICLE).vehicleId = POWER;
    setVehicleAimPower(0.25);
    assert.equal(missileShotFor(VEHICLE, 57609, missiles, vehicles, () => 0, fixed).speed, 45, "30 + 60 × 0.25");
    setVehicleAimPower(0);
  });
});

test("11.02-E: the missile tables' client — lazily from the gateway origin; a 404 leaves every cast as it was", async () => {
  forgetSpellMissileClient();
  assert.equal(spellMissiles(undefined), undefined, "no origin, no request");
  const answer = { version: SPELL_MISSILE_CATALOG_VERSION, missiles: [[1023, 1, -0.262, 1.047, 65, 65, 0, 0, 0, 0, 0, 0, 40, 0, 0]], spells: [[57609, 1023]] };
  const asked = [];
  const ok = "http://127.0.0.7:28091";
  const client = spellMissileClient(ok, { fetch: async (url) => { asked.push(String(url)); return new Response(JSON.stringify(answer), { status: 200 }); } });
  assert.equal(spellMissiles(ok), undefined, "the first ask starts the load");
  assert.equal(asked.length, 1);
  await client.load();
  assert.deepEqual(asked, [`${ok}/dbc/spell-missiles?v=1`]);
  assert.equal(spellMissiles(ok)?.trajectoryMissile(57609)?.id, 1023);
  const savedOrigin = game.gatewayOrigin;
  game.gatewayOrigin = ok;
  try {
    assert.equal(pageMissileShotSource.trajectoryMissile(57609)?.gravity, 40);
    assert.equal(pageMissileShotSource.trajectoryMissile(133), undefined);
  } finally {
    game.gatewayOrigin = savedOrigin;
  }

  const old = "http://127.0.0.8:28091";
  let stalls = 0;
  const stale = spellMissileClient(old, {
    fetch: async () => { stalls++; return new Response("", { status: 404 }); }, maxAttempts: 1,
    clock: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  spellMissiles(old);
  await stale.load();
  assert.equal(stale.state, "failed");
  assert.equal(spellMissiles(old), undefined, "an older gateway: no tables, no trajectory spell");
  assert.equal(stalls, 1, "a cast asking does not start another cycle");
  spellMissiles(old, true);
  await stale.load();
  assert.equal(stalls, 2, "a bar arriving (prime) does");
  forgetSpellMissileClient();
});
