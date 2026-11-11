import assert from "node:assert/strict";
import test from "node:test";
import { PacketReader } from "../dist/code/protocol/index.js";
import {
  CREATURE_TYPE_FLAG_COLLIDE_WITH_MISSILES, MISSILE_COLLISION_NONE, MissileCollisionTracker, ballisticPoint, missileCollides,
  missileCollisionCosine, missileCollisionKeep, missileCollisionPath, missileCollisionReach, missileCollisionSphere,
  missileCollisionTargets, missileCollisionUnits, missileSegmentHit, solveMissileBallistic,
} from "../dist/code/world/MissileCollision.js";
import { missileCollisionLaunch, ownsMissileCollision } from "../dist/code/world/MissileCollisionWorld.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import {
  clearProjectileFlights, launchMissile, missileSample, setProjectilePosition, stepMissile,
} from "../dist/code/browser/MissileFlight.js";

// 11.02 (11.11): CMSG_UPDATE_PROJECTILE_POSITION and SMSG_SET_PROJECTILE_POSITION as Wow.exe 3.3.5a 12340 has them
// (.runtime/re-2026-11-11/vehicle2/v1-v4.c): the path 0x006fcb60, the pick 0x006fcaa0/0x006fc4a0, the sphere
// 0x006fbff0/0x006fc0a0, the step test 0x006fc360, the send 0x00703640, the receive 0x008005a0 → 0x006ff2c0 and the
// cut in 0x007015d0 (+0x68 0x400000).

const row = (flags, collisionRadius = 0.5) => ({
  id: 1, flags, defaultPitchMin: 0, defaultPitchMax: 0, defaultSpeedMin: 0, defaultSpeedMax: 0, randomizeFacingMin: 0,
  randomizeFacingMax: 0, randomizePitchMin: 0, randomizePitchMax: 0, randomizeSpeedMin: 0, randomizeSpeedMax: 0,
  gravity: 19.291105270385742, maxDuration: 0, collisionRadius,
});

test("11.11: the row collides with Flags & 0x3c only", () => {
  assert.equal(missileCollides(row(0x1)), false);
  assert.equal(missileCollides(row(0x3)), false);
  assert.equal(missileCollides(row(0x11)), true);
  assert.equal(missileCollides(row(0x3f)), true);
});

test("11.11: 0x006fcb60's cosine is the cubic of the rest of elevation / π", () => {
  assert.equal(missileCollisionCosine(0), 1);
  assert.ok(Math.abs(missileCollisionCosine(Math.PI / 2)) < 1e-6);
  // f = 0.25: 1 − 5 · 0.0625 = 0.6875, not cos(π/4) = 0.7071.
  assert.ok(Math.abs(missileCollisionCosine(Math.PI / 4) - 0.6875) < 1e-6);
  assert.ok(Math.abs(missileCollisionCosine(-Math.PI / 4) - 0.6875) < 1e-6);
});

test("11.11: the path in the plane — direction, normal, horizontal speed, time; the degenerate path", () => {
  const path = missileCollisionPath({ x: 0, y: 0, z: 0 }, { x: 30, y: 40, z: 5 }, 0, 25);
  assert.equal(path.length, 50);
  assert.ok(Math.abs(path.dirX - 0.6) < 1e-12 && Math.abs(path.dirY - 0.8) < 1e-12);
  assert.ok(Math.abs(path.perpX + 0.8) < 1e-12 && Math.abs(path.perpY - 0.6) < 1e-12);
  assert.equal(path.speed, 25);
  assert.equal(path.time, 2);
  const flat = missileCollisionPath({ x: 5, y: 5, z: 0 }, { x: 5, y: 5, z: 20 }, 1.5, 10);
  assert.equal(flat.length, 1);
  assert.equal(flat.startX, 4.99);
  assert.ok(Math.abs(flat.speed - 0.01 / 2) < 1e-12);
});

test("11.11: the sphere — MissileCollisionRadius × scale, else half the unscaled height, pushed and raised; no model: 1", () => {
  const path = { dirX: 1, dirY: 0 };
  const model = { collisionHeight: 2, missileCollisionRadius: 0, missileCollisionPush: 0, missileCollisionRaise: 0 };
  const half = missileCollisionSphere({ position: { x: 10, y: 0, z: 0 }, scale: 3, model }, path, row(0x11, 0.5));
  assert.deepEqual(half, { x: 10, y: 0, z: 1, r: 1.5 });
  const own = missileCollisionSphere({ position: { x: 10, y: 0, z: 0 }, scale: 2,
    model: { collisionHeight: 2, missileCollisionRadius: 2, missileCollisionPush: 1, missileCollisionRaise: -1 } }, path, row(0x11, 0));
  assert.deepEqual(own, { x: 8, y: 0, z: 2, r: 4 });
  const none = missileCollisionSphere({ position: { x: 1, y: 2, z: 3 }, scale: 5, model: undefined }, path, row(0x11, 0));
  assert.deepEqual(none, { x: 1, y: 2, z: 4, r: 1 });
});

test("11.11: who the row lets through — players by 0xc, creatures by 0x30 with COLLIDE_WITH_MISSILES", () => {
  const player = (canAttack) => ({ isPlayer: true, creatureTypeFlags: undefined, canAttack });
  const creature = (flags, canAttack) => ({ isPlayer: false, creatureTypeFlags: flags, canAttack });
  const C = CREATURE_TYPE_FLAG_COLLIDE_WITH_MISSILES;
  assert.equal(missileCollisionTargets(0x11, player(true)), false);
  assert.equal(missileCollisionTargets(0x04, player(true)), true);
  assert.equal(missileCollisionTargets(0x04, player(false)), false);
  assert.equal(missileCollisionTargets(0x08, player(false)), true);
  assert.equal(missileCollisionTargets(0x0c, player(undefined)), true);
  assert.equal(missileCollisionTargets(0x04, player(undefined)), false);
  assert.equal(missileCollisionTargets(0x11, creature(C, true)), true);
  assert.equal(missileCollisionTargets(0x11, creature(C, false)), false);
  assert.equal(missileCollisionTargets(0x11, creature(0, true)), false);
  assert.equal(missileCollisionTargets(0x11, creature(undefined, true)), false);
  assert.equal(missileCollisionTargets(0x21, creature(C, false)), true);
  assert.equal(missileCollisionTargets(0x31, creature(C, undefined)), true);
});

test("11.11: the reach key — a unit on the path, one too far to get there, one slower than nothing", () => {
  const path = missileCollisionPath({ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, 0, 50);
  const on = { x: 50, y: 0, z: 1, r: 2 };
  assert.ok(missileCollisionReach(path, on, 0) > 0);
  const far = { x: 50, y: 500, z: 1, r: 2 };
  assert.equal(missileCollisionReach(path, far, 7), MISSILE_COLLISION_NONE);
  // Faster than the shot: only the end counts; 2 s × 60 yd/s reaches anything within 120 yards of the aim.
  assert.ok(missileCollisionReach(path, far, 0) === MISSILE_COLLISION_NONE);
  assert.ok(missileCollisionReach(path, { x: 100, y: 100, z: 1, r: 2 }, 60) > 0);
});

test("11.11: more than 15 candidates — the 15 largest keys stay", () => {
  const candidates = Array.from({ length: 20 }, (_, index) => ({ unit: index, key: index }));
  assert.deepEqual(missileCollisionKeep(candidates), [19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
  assert.deepEqual(missileCollisionKeep(candidates.slice(0, 3)), [0, 1, 2]);
});

test("11.11: 0x006fc360 — the fraction where the step passes the centre closest, ahead and within the radius", () => {
  const from = { x: 0, y: 0, z: 0 };
  const to = { x: 10, y: 0, z: 0 };
  assert.equal(missileSegmentHit(from, to, [{ x: 4, y: 1, z: 0, r: 1.5 }]), 0.4);
  assert.equal(missileSegmentHit(from, to, [{ x: 4, y: 2, z: 0, r: 1.5 }]), MISSILE_COLLISION_NONE);
  assert.equal(missileSegmentHit(from, to, [{ x: 12, y: 0, z: 0, r: 5 }]), MISSILE_COLLISION_NONE);
  assert.equal(missileSegmentHit(from, to, [{ x: -1, y: 0, z: 0, r: 5 }]), MISSILE_COLLISION_NONE);
  // The list ends at a radius not above 0.
  assert.equal(missileSegmentHit(from, to, [{ x: 0, y: 0, z: 0, r: 0 }, { x: 4, y: 0, z: 0, r: 1 }]), MISSILE_COLLISION_NONE);
  assert.equal(missileSegmentHit(from, from, [{ x: 0, y: 0, z: 0, r: 1 }]), MISSILE_COLLISION_NONE);
});

function world(units, bodies) {
  return {
    *units() { yield* units; },
    body: (guid) => bodies.get(guid),
  };
}

test("11.11: the pick excludes the caster's root and what rides it", () => {
  const launch = { exclude: 1n, row: row(0x3f, 1) };
  const path = missileCollisionPath({ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, 0.3, 60);
  const unit = (guid, root) => ({ guid, root, isPlayer: true, creatureTypeFlags: undefined, canAttack: true, maxSpeed: 7 });
  const body = { position: { x: 50, y: 0, z: 0 }, scale: 1, model: undefined };
  const bodies = new Map([[1n, body], [2n, body], [3n, body]]);
  assert.deepEqual(missileCollisionUnits(launch, path, world([unit(1n), unit(2n, 1n), unit(3n)], bodies)), [3n]);
});

function manualTimers() {
  const queue = [];
  return { queue, set: (callback) => { queue.push(callback); return queue.length; }, clear: () => {} };
}

test("11.11: the tracker sends caster, spell, cast count and the point the arc passes the unit, once", () => {
  const sent = [];
  let clock = 1000;
  const timers = manualTimers();
  const tracker = new MissileCollisionTracker((payload) => sent.push(payload), () => clock, timers);
  const fire = { x: 0, y: 0, z: 0 };
  const aim = { x: 100, y: 0, z: 0 };
  const launch = { caster: 0xF130000000000001n, exclude: 0xF130000000000001n, spellId: 62345, castCount: 7,
    row: row(0x11, 1), fire, aim, elevation: 0.5, delayMs: 2000 };
  const C = CREATURE_TYPE_FLAG_COLLIDE_WITH_MISSILES;
  const flight = solveMissileBallistic(fire, aim, 0.5, row(0x11).gravity, 2000);
  // A tower standing on the arc's midpoint.
  const mid = ballisticPoint(fire, flight, 1000, { x: 0, y: 0, z: 0 });
  const tower = { guid: 9n, root: undefined, isPlayer: false, creatureTypeFlags: C, canAttack: true, maxSpeed: 0 };
  const bodies = new Map([[9n, { position: { x: mid.x, y: 0, z: mid.z - 1 }, scale: 1, model: undefined }]]);
  assert.equal(tracker.launch(launch, world([tower], bodies)), true);
  for (let frame = 0; frame < 200 && sent.length === 0; frame++) {
    clock += 16;
    tracker.step(clock);
  }
  assert.equal(sent.length, 1);
  assert.equal(tracker.size, 0);
  const reader = new PacketReader(sent[0]);
  assert.equal(reader.u64(), launch.caster);
  assert.equal(reader.u32(), 62345);
  assert.equal(reader.u8(), 7);
  const x = reader.f32();
  reader.f32();
  const z = reader.f32();
  // The point where the arc comes closest to the sphere's centre (z + 1): the midpoint, within float precision.
  assert.ok(Math.abs(x - mid.x) < 0.2, `x ${x} vs ${mid.x}`);
  assert.ok(Math.abs(z - mid.z) < 0.2);
  clock += 16;
  tracker.step(clock);
  assert.equal(sent.length, 1);
});

test("11.11: nothing on the way — nothing sent, the flight ends at its delay; a row without 0x3c — not tracked", () => {
  const sent = [];
  let clock = 0;
  const tracker = new MissileCollisionTracker((payload) => sent.push(payload), () => clock, manualTimers());
  const launch = { caster: 2n, exclude: 2n, spellId: 1, castCount: 1, row: row(0x11, 1), fire: { x: 0, y: 0, z: 0 },
    aim: { x: 100, y: 0, z: 0 }, elevation: 0.5, delayMs: 2000 };
  const off = { guid: 9n, root: undefined, isPlayer: false, creatureTypeFlags: CREATURE_TYPE_FLAG_COLLIDE_WITH_MISSILES, canAttack: true, maxSpeed: 7 };
  // Near enough to be picked (it could run there) but standing aside.
  const bodies = new Map([[9n, { position: { x: 50, y: 6, z: 0 }, scale: 1, model: undefined }]]);
  assert.equal(tracker.launch(launch, world([off], bodies)), true);
  for (; clock <= 2100; clock += 16) tracker.step(clock);
  assert.equal(sent.length, 0);
  assert.equal(tracker.size, 0);
  assert.equal(tracker.launch({ ...launch, row: row(0x1, 1) }, world([off], bodies)), false);
});

test("11.11: whose missiles are tested — the active player uncharmed, or the unit this client controls", () => {
  const charmed = UPDATE_FIELDS.UNIT_FIELD_CHARMEDBY.offset;
  const objects = new Map([[1n, { fields: new Map() }]]);
  assert.equal(ownsMissileCollision(1n, 1n, undefined, objects), true);
  assert.equal(ownsMissileCollision(5n, 1n, 5n, objects), true);
  assert.equal(ownsMissileCollision(5n, 1n, undefined, objects), false);
  objects.get(1n).fields.set(charmed, 77);
  assert.equal(ownsMissileCollision(1n, 1n, undefined, objects), false);
});

test("11.11: a SPELL_GO's launch — the source and destination, the caster's vehicle excluded", () => {
  const go = { casterUnit: 3n, spellId: 5, castId: 9, adjustMissile: { elevation: 0.4, delayMs: 1500 },
    targets: { targetFlags: 0x60, source: { x: 1, y: 2, z: 3 }, destination: { x: 50, y: 2, z: 3 } } };
  const objects = new Map([[3n, { guid: 3n, typeId: 4, transport: { guid: 8n } }], [8n, { guid: 8n, typeId: 3 }]]);
  const launch = missileCollisionLaunch(go, row(0x11), objects);
  assert.equal(launch.exclude, 8n);
  assert.equal(launch.castCount, 9);
  assert.deepEqual(launch.fire, { x: 1, y: 2, z: 3 });
  assert.equal(missileCollisionLaunch(go, row(0x1), objects), undefined);
  assert.equal(missileCollisionLaunch({ ...go, adjustMissile: undefined }, row(0x11), objects), undefined);
});

test("11.11: SMSG_SET_PROJECTILE_POSITION lands the named flight where the step would take it past the point", () => {
  clearProjectileFlights();
  const plan = (count) => ({ from: { x: 0, y: 0, z: 0 }, to: { x: 100, y: 0, z: 0 }, cast: { caster: 4n, count } });
  const named = launchMissile(plan(3), { x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, 0, 1000);
  const other = launchMissile(plan(4), { x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, 0, 1000);
  const out = missileSample();
  assert.equal(stepMissile(named, { x: 100, y: 0, z: 0 }, 100, out), true);
  stepMissile(other, { x: 100, y: 0, z: 0 }, 100, out);
  assert.equal(setProjectilePosition(4n, 3, { x: 25, y: 0, z: 0 }), 1);
  // 10 → 20: still nearer the point.
  assert.equal(stepMissile(named, { x: 100, y: 0, z: 0 }, 200, out), true);
  assert.ok(Math.abs(out.position.x - 20) < 1e-9);
  // 20 → 30 takes it further away (5 > 5? no: |30−25| = 5 = |20−25|), 30 → 40 does.
  assert.equal(stepMissile(named, { x: 100, y: 0, z: 0 }, 300, out), true);
  assert.equal(stepMissile(named, { x: 100, y: 0, z: 0 }, 400, out), false);
  assert.ok(Math.abs(out.position.x - 30) < 1e-9);
  assert.equal(named.arrived, true);
  // The other cast count flies on.
  assert.equal(stepMissile(other, { x: 100, y: 0, z: 0 }, 400, out), true);
  assert.ok(Math.abs(out.position.x - 40) < 1e-9);
  assert.equal(setProjectilePosition(4n, 3, { x: 0, y: 0, z: 0 }), 0);
  clearProjectileFlights();
});
