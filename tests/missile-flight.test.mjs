// 05.10-A7a-E (6.12): a spell missile in flight (browser/MissileFlight.ts) — homing, no invented arc,
// the motion script's offsets in Wow.exe's frame (0x00700550), speed outputs, arrival and facing.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  flyMissileInstance, launchMissile, missileQuaternion, missileSample, missileStateOf, stepMissile,
} from "../dist/code/browser/MissileFlight.js";

const near = (actual, expected, message, epsilon = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} vs ${expected}`);

const PARABOLA = `local angle = 0
local maxMagnitude = startDistance * .15
transAngle = angle
transMag = (progress * 2) - 1
transMag = (1 - (transMag * transMag)) * maxMagnitude`;

function points(map) {
  return {
    point(guid, attachment, out) {
      const at = map.get(`${guid}:${attachment}`);
      if (!at) return false;
      out.x = at.x; out.y = at.y; out.z = at.z;
      return true;
    },
  };
}

test("without a script the missile flies the straight line, with no arc, and arrives on schedule", () => {
  const state = launchMissile({ from: { x: 0, y: 0, z: 0 }, to: { x: 30, y: 0, z: 0 } },
    { x: 0, y: 0, z: 2 }, { x: 30, y: 0, z: 2 }, 1000, 1000);
  const out = missileSample();
  assert.equal(stepMissile(state, { x: 30, y: 0, z: 2 }, 1500, out), true);
  near(out.position.x, 15, "halfway at half time");
  assert.equal(out.position.z, 2, "no bow: MISSILE_ARC is gone");
  near(state.progress, 0.5, "progress");
  assert.equal(stepMissile(state, { x: 30, y: 0, z: 2 }, 2000, out), false, "arrived at the planned time");
});

test("the missile homes: it arrives at the target's current point, not the planned one", () => {
  const state = launchMissile({ from: { x: 0, y: 0, z: 0 }, to: { x: 20, y: 0, z: 0 } },
    { x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }, 0, 1000);
  const out = missileSample();
  const runner = { x: 20, y: 0, z: 0 };
  let now = 0;
  let flying = true;
  while (flying && now < 5000) {
    now += 50;
    runner.y += 0.5; // the target runs sideways, 10 yd/s
    flying = stepMissile(state, runner, now, out);
  }
  assert.equal(flying, false);
  near(out.position.x, runner.x, "arrived at the runner's x");
  near(out.position.y, runner.y, "arrived at the runner's y (read every frame)");
  assert.ok(runner.y > 4, "the target had moved well off the planned point");
});

test("a Parabola script bows straight up: peak 0.15 · startDistance at half way, zero at the ends", () => {
  const plan = { from: { x: 0, y: 0, z: 0 }, to: { x: 40, y: 0, z: 0 }, motion: { id: 13, script: PARABOLA, count: 1 } };
  const state = launchMissile(plan, { x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 0 }, 0, 1000);
  const out = missileSample();
  stepMissile(state, { x: 40, y: 0, z: 0 }, 500, out);
  near(out.position.x, 20, "base point half way");
  near(out.position.z, 40 * 0.15, "peak height");
  assert.equal(out.position.y, 0, "transAngle 0 is up, not sideways");
  near(out.direction.x, 1, "facing stays along the line to the target (Wow.exe 0x00701230), not the bow");
  stepMissile(state, { x: 40, y: 0, z: 0 }, 999, out);
  assert.ok(out.position.z < 0.1, `near the target the bow has closed: ${out.position.z}`);
});

test("offsets use Wow.exe's frame: right = (−h.y, h.x), front = h, angle 90° turns the bow onto right", () => {
  const plan = {
    from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 10, z: 0 },
    motion: { id: 0, script: "transRight = 1\ntransFront = 2\ntransUp = 3\ntransMag = 4\ntransAngle = 90", count: 1 },
  };
  const state = launchMissile(plan, { x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }, 0, 1000);
  const out = missileSample();
  stepMissile(state, { x: 0, y: 10, z: 0 }, 100, out);
  // h = (0, 1): right = (−1, 0); base y = 1 after 0.1 s of a 1 s flight.
  near(out.position.x, -1 - 4, "transRight + transMag·sin 90° along (−h.y, h.x)");
  near(out.position.y, 1 + 2, "base + transFront along h");
  near(out.position.z, 3, "transUp, and transMag·cos 90° adds nothing");
});

test("speed outputs: speedScalar scales the base speed, speedAbs sets it, speedOffset adds with a floor", () => {
  for (const [script, expected] of [
    ["speedScalar = 2", 40],
    ["speedAbs = 7", 7],
    ["speedOffset = -100", 0.01],
    ["speedAbs = 7\nspeedScalar = 3", 60],
  ]) {
    const plan = { from: { x: 0, y: 0, z: 0 }, to: { x: 20, y: 0, z: 0 }, motion: { id: 0, script, count: 1 } };
    const state = launchMissile(plan, { x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }, 0, 1000);
    stepMissile(state, { x: 20, y: 0, z: 0 }, 10, missileSample());
    near(state.speed, expected, script);
  }
});

test("rand1..3 are drawn once per missile, and missileIndex/Count travel into the script", () => {
  const plan = {
    from: { x: 0, y: 0, z: 0 }, to: { x: 20, y: 0, z: 0 }, missileIndex: 2, missileCount: 3,
    motion: { id: 0, script: "transUp = rand1 + missileIndex * 10 + missileCount * 100", count: 3 },
  };
  let draws = 0;
  const state = launchMissile(plan, { x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }, 0, 1000, () => { draws++; return 0.25; });
  const out = missileSample();
  stepMissile(state, { x: 20, y: 0, z: 0 }, 100, out);
  near(out.position.z, 0.25 + 20 + 300, "inputs");
  stepMissile(state, { x: 20, y: 0, z: 0 }, 200, out);
  assert.equal(draws, 3, "three draws at launch, none per frame");
});

test("an instance launches from the caster's attachment once and follows the target's attachment", () => {
  const where = new Map([["1:22", { x: 0, y: 0, z: 1.5 }], ["2:34", { x: 24, y: 0, z: 1.2 }]]);
  const instance = {
    startedAt: 0, endsAt: 1000,
    flight: {
      from: { x: 0, y: 0, z: 0 }, to: { x: 24, y: 0, z: 0 },
      launch: { guid: 1n, attachment: 22 }, target: { guid: 2n, attachment: 34 },
    },
  };
  const out = missileSample();
  assert.equal(flyMissileInstance(instance, 0, points(where), out), true);
  near(out.position.z, 1.5, "starts at the hand, not the feet");
  where.set("1:22", { x: -50, y: 0, z: 0 }); // the caster moves on; the missile has left the hand
  where.set("2:34", { x: 24, y: 6, z: 1.2 }); // the target steps aside
  flyMissileInstance(instance, 500, points(where), out);
  assert.ok(out.position.x > 0, "the launch point was read once");
  let now = 500;
  while (flyMissileInstance(instance, (now += 16), points(where), out)) { /* fly */ }
  near(out.position.y, 6, "arrives where the target is now");
  assert.ok(instance.endsAt <= now, "arrival cuts the instance's life");
  assert.ok(missileStateOf(instance).arrived);
});

test("a slowed missile outlives its planned arrival, boundedly", () => {
  const instance = {
    startedAt: 0, endsAt: 1000,
    flight: { from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 }, motion: { id: 0, script: "speedScalar = 0.5", count: 1 } },
  };
  const none = points(new Map());
  const out = missileSample();
  let now = 0;
  while (flyMissileInstance(instance, now, none, out) && now < 10_000) now += 100;
  assert.ok(now >= 1900 && now <= 2100, `arrived at half speed after ≈2 s: ${now}`);
  assert.ok(instance.endsAt <= 5000);
});

test("facing: model +X goes to the scene direction, yaw turns it about the up axis", () => {
  const sample = missileSample();
  sample.direction.x = 30; sample.direction.y = 8; sample.direction.z = 10;
  const len = Math.hypot(30, 8, 10);
  sample.direction.x /= len; sample.direction.y /= len; sample.direction.z /= len;
  const q = missileQuaternion(sample, new THREE.Quaternion());
  const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const expected = new THREE.Vector3(30, 10, -8).normalize();
  assert.ok(forward.distanceTo(expected) < 1e-6, `${forward.toArray()} vs ${expected.toArray()}`);
  const level = missileSample();
  level.yaw = 90;
  const turned = new THREE.Vector3(1, 0, 0).applyQuaternion(missileQuaternion(level, new THREE.Quaternion()));
  // Server +X yawed 90° is server +Y, which is scene −Z.
  assert.ok(turned.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-6, `${turned.toArray()}`);
});

test("a target that leaves mid-flight keeps its last point instead of snapping back to the planned one", () => {
  const where = new Map([["2:34", { x: 10, y: 8, z: 0 }]]);
  const instance = {
    startedAt: 0, endsAt: 1000,
    flight: { from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 }, target: { guid: 2n, attachment: 34 } },
  };
  const out = missileSample();
  flyMissileInstance(instance, 0, points(where), out);
  flyMissileInstance(instance, 300, points(where), out);
  where.clear();
  let now = 300;
  while (flyMissileInstance(instance, (now += 50), points(where), out)) { /* fly */ }
  near(out.position.y, 8, "arrived at the last seen point");
});
