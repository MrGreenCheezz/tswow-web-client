// 05.11 (6.44): how a unit's model leans with the ground, against what Wow.exe drew and the axes its 0x0082DD80 builds.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  ShownGroundNormal, UNIT_TILT_LEFT_AFTER_A_SECOND, UNIT_TILT_MIN_UP, UNIT_TILT_PITCH, UNIT_TILT_ROLL, unitTiltAngles,
} from "../dist/code/world/UnitTilt.js";
import { UnitGroundNormals } from "../dist/code/browser/game/UnitGroundNormals.js";
import { CollisionMesh, CollisionWorld } from "../dist/code/browser/game/Collision.js";
import { RenderInputsReceiver, RenderInputsSender } from "../dist/code/browser/RenderTablesBridge.js";
import { NO_RENDER_INPUTS } from "../dist/code/browser/RenderInputs.js";
import { WVM9_TILT_X, WVM9_TILT_Y } from "../tools/wvm.mjs";

const DEG = Math.PI / 180;
const angles = (bits, facing, n) => unitTiltAngles(bits, facing, n[0], n[1], n[2], { pitch: 0, roll: 0 });
const near = (a, b, what, within = 1e-6) => assert.ok(Math.abs(a - b) < within, `${what}: ${a} against ${b}`);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v) => { const n = Math.hypot(...v); return v.map((c) => c / n); };

/** A slope of `degrees` rising towards the direction `uphill`. */
const slope = (degrees, uphill) => [-Math.sin(degrees * DEG) * Math.cos(uphill), -Math.sin(degrees * DEG) * Math.sin(uphill), Math.cos(degrees * DEG)];

test("the lean is what Wow.exe drew on a slope of 18 degrees", () => {
  const uphill = 1.43;
  const n = slope(18, uphill);
  // Horse and wolf, `flags & 3` = 1: 18.1 facing uphill, 0.7 across, −18.1 downhill.
  near(angles(UNIT_TILT_PITCH, uphill, n).pitch / DEG, 18, "a horse facing uphill");
  near(angles(UNIT_TILT_PITCH, uphill + Math.PI / 2, n).pitch / DEG, 0, "a horse facing across");
  near(angles(UNIT_TILT_PITCH, uphill + Math.PI, n).pitch / DEG, -18, "a horse facing downhill");
  assert.equal(angles(UNIT_TILT_PITCH, uphill + Math.PI / 2, n).roll, 0, "a horse never rolls");
  // Kodo, `flags & 3` = 3: 18.1 of roll across, −18.1 of pitch downhill.
  near(Math.abs(angles(UNIT_TILT_ROLL, uphill + Math.PI / 2, n).roll) / DEG, 18, "a kodo facing across");
  near(angles(UNIT_TILT_ROLL, uphill + Math.PI, n).pitch / DEG, -18, "a kodo facing downhill");
  // A human stands upright, and so does the one value no model of the client has.
  for (const bits of [0, 2]) assert.deepEqual(angles(bits, uphill, n), { pitch: 0, roll: 0 });
});

test("Ry(facing) Rx(roll) Rz(pitch) builds the axes 0x0082DD80 builds, and the facing stays", () => {
  // The renderer's composition, in world axes: wow (x, y, z) is the scene's (x, z, −y).
  const composed = (facing, { pitch, roll }) => {
    const rz = (v) => [v[0] * Math.cos(pitch) - v[1] * Math.sin(pitch), v[0] * Math.sin(pitch) + v[1] * Math.cos(pitch), v[2]];
    const rx = (v) => [v[0], v[1] * Math.cos(roll) - v[2] * Math.sin(roll), v[1] * Math.sin(roll) + v[2] * Math.cos(roll)];
    const ry = (v) => [v[0] * Math.cos(facing) + v[2] * Math.sin(facing), v[1], -v[0] * Math.sin(facing) + v[2] * Math.cos(facing)];
    const toWorld = (v) => [v[0], -v[2], v[1]];
    const axis = (v) => toWorld(ry(rx(rz(v))));
    return { forward: axis([1, 0, 0]), left: axis([0, 0, -1]), up: axis([0, 1, 0]) };
  };
  const same = (a, b, what) => a.forEach((c, i) => near(c, b[i], `${what}[${i}]`, 1e-5));
  for (let i = 0; i < 400; i++) {
    const facing = (i * 0.37) % (Math.PI * 2);
    const n = normalize([Math.sin(i * 1.3) * 0.7, Math.cos(i * 2.1) * 0.7, 0.6 + (i % 7) * 0.05]);
    const f = [Math.cos(facing), Math.sin(facing), 0];
    {
      const left = normalize([-f[1], f[0], 0]);
      const forward = normalize(cross(left, n));
      const up = cross(forward, left);
      const got = composed(facing, angles(UNIT_TILT_PITCH, facing, n));
      same(got.forward, forward, "pitch forward");
      same(got.left, left, "pitch left");
      same(got.up, up, "pitch up");
    }
    {
      const left = normalize(cross(n, f));
      const forward = cross(left, n);
      const got = composed(facing, angles(UNIT_TILT_ROLL, facing, n));
      same(got.forward, forward, "roll forward");
      same(got.left, left, "roll left");
      same(got.up, n, "roll up");
    }
  }
});

test("the kept normal follows by Wow.exe's law, in seconds", () => {
  const n = slope(18, 0);
  const shown = new ShownGroundNormal();
  shown.step(n, 100);
  near(angles(UNIT_TILT_PITCH, 0, [shown.x, shown.y, shown.z]).pitch / DEG, 18, "settled");
  // On the stand, jumped to the flat: frames of 38 ms fell 3.9, 3.4 and 3.1 degrees (a Stand clip moving under it).
  const fallen = [];
  let before = 18;
  for (let frame = 0; frame < 3; frame++) {
    shown.step([0, 0, 1], 0.038);
    const now = angles(UNIT_TILT_PITCH, 0, [shown.x, shown.y, shown.z]).pitch / DEG;
    fallen.push(before - now);
    before = now;
  }
  near(fallen[0], 3.86, "the first frame", 0.05);
  near(fallen[1], 3.03, "the second", 0.05);
  assert.equal(UNIT_TILT_LEFT_AFTER_A_SECOND, 0.0018);
});

test("a surface too steep, or none known, leaves the kept normal as it is", () => {
  const shown = new ShownGroundNormal();
  shown.step(slope(10, 0), 100);
  const { x, y, z } = shown;
  shown.step(undefined, 1);
  shown.step([0.95, 0, UNIT_TILT_MIN_UP - 0.001], 1);
  assert.deepEqual([shown.x, shown.y, shown.z], [x, y, z]);
  shown.step([0.93, 0, UNIT_TILT_MIN_UP], 100);
  near(shown.z, UNIT_TILT_MIN_UP, "at the limit it follows");
  const still = new ShownGroundNormal();
  still.step(slope(10, 0), 0);
  assert.deepEqual([still.x, still.y, still.z], [0, 0, 1], "no time, no step");
});

/** A plane z = a x + b y + c, as the terrain client answers. */
const plane = (a, b, c = 0, resident = () => true) => ({
  residentHeightAt: (map, x, y) => (resident(x, y) ? a * x + b * y + c : undefined),
  isHole: () => false,
});
const unit = (guid, x, y, z, more = {}) => [guid, { guid, typeId: 3, position: { x, y, z }, transport: undefined, ...more }];
const objects = (...units) => new Map(units);

test("the ground under a unit is the terrain's slope, and level ground is one record", () => {
  const ground = new UnitGroundNormals();
  const sources = { map: 0, terrain: plane(0.5, 0, 0), collision: undefined };
  const got = ground.collect(objects(unit(1n, 10, 0, 5)), sources).get(1n);
  const length = Math.hypot(0.5, 1);
  near(got[0], -0.5 / length, "x", 1e-5);
  near(got[1], 0, "y", 1e-5);
  near(got[2], 1 / length, "z", 1e-5);
  const flat = new UnitGroundNormals();
  const a = flat.collect(objects(unit(1n, 10, 0, 0), unit(2n, 40, 0, 0)), { map: 0, terrain: plane(0, 0), collision: undefined });
  assert.equal(a.get(1n), a.get(2n));
  assert.deepEqual([...a.get(1n)], [0, 0, 1]);
});

test("the column is read at any height over the ground, and not from under it", () => {
  const sources = { map: 0, terrain: plane(0.5, 0, 0), collision: undefined };
  for (const over of [0, 1, 3, 15, 40]) {
    assert.ok(new UnitGroundNormals().collect(objects(unit(1n, 10, 0, 5 + over)), sources).get(1n)[0] < -0.4, `${over} yards up`);
  }
  assert.equal(new UnitGroundNormals().collect(objects(unit(1n, 10, 0, 5 - 2)), sources).has(1n), false, "two yards under");
  assert.ok(new UnitGroundNormals().collect(objects(unit(1n, 10, 0, 5 - 0.5)), sources).has(1n), "a server's height is not exact");
});

test("a floor over the terrain wins, and its normal points up however it is wound", () => {
  // A ramp over level terrain, wound both ways: z = 60 + 0.5 x.
  for (const triangles of [
    [-100, -100, -40, 100, -100, 60, 100, 100, 60, -100, -100, -40, 100, 100, 60, -100, 100, -40],
    [100, -100, 60, -100, -100, -40, 100, 100, 60, 100, 100, 60, -100, -100, -40, -100, 100, -40],
  ]) {
    const world = new CollisionWorld();
    const lifted = triangles.map((v, i) => (i % 3 === 2 ? v + 50 : v));
    world.set(1, new CollisionMesh(new Float32Array(lifted)));
    const sources = { map: 0, terrain: plane(0, 0), collision: world };
    const on = new UnitGroundNormals().collect(objects(unit(1n, 0, 0, 60)), sources).get(1n);
    const length = Math.hypot(0.5, 1);
    near(on[0], -0.5 / length, "the ramp's x", 1e-4);
    near(on[2], 1 / length, "the ramp's z", 1e-4);
    // Under the ramp the terrain is what is underfoot.
    assert.deepEqual([...new UnitGroundNormals().collect(objects(unit(1n, 0, 0, 2)), sources).get(1n)], [0, 0, 1]);
  }
});

test("a unit is read again only when it has moved, and a crowd is spread over frames", () => {
  let reads = 0;
  const terrain = plane(0.5, 0);
  const counted = { ...terrain, residentHeightAt: (map, x, y) => { reads++; return terrain.residentHeightAt(map, x, y); } };
  const sources = { map: 0, terrain: counted, collision: undefined };
  const ground = new UnitGroundNormals();
  const one = unit(1n, 10, 0, 5);
  const list = new Map([one]);
  const first = ground.collect(list, sources).get(1n);
  const after = reads;
  assert.ok(after > 0);
  ground.collect(list, sources);
  assert.equal(reads, after, "standing: nothing read");
  one[1].position.x = 10.2;
  ground.collect(list, sources);
  assert.equal(reads, after, "a fifth of a yard: nothing read");
  one[1].position.x = 10.6;
  one[1].position.z = 5.3;
  assert.equal(ground.collect(list, sources).get(1n), first, "the same slope keeps its record, so nothing crosses");
  assert.ok(reads > after);
  const crowd = new Map(Array.from({ length: 80 }, (_, i) => unit(BigInt(i + 1), i, 0, i / 2)));
  const many = new UnitGroundNormals();
  assert.equal(many.collect(crowd, { map: 0, terrain, collision: undefined }).size, 32);
  assert.equal(many.collect(crowd, { map: 0, terrain, collision: undefined }).size, 64);
  assert.equal(many.collect(crowd, { map: 0, terrain, collision: undefined }).size, 80);
});

test("what is not there is not read: a passenger, a game object, a tile not resident, a unit gone, another map", () => {
  const sources = { map: 0, terrain: plane(0.5, 0), collision: undefined };
  const ground = new UnitGroundNormals();
  assert.equal(ground.collect(objects(unit(1n, 10, 0, 5, { transport: {} })), sources).size, 0, "a passenger");
  assert.equal(ground.collect(objects(unit(1n, 10, 0, 5, { typeId: 5 })), sources).size, 0, "a game object");
  assert.equal(ground.collect(objects(unit(1n, 10, 0, 5, { typeId: 4 })), sources).size, 1, "a player is a unit");
  assert.equal(ground.collect(objects(), sources).size, 0, "gone");
  const absent = { map: 0, terrain: plane(0.5, 0, 0, () => false), collision: undefined };
  assert.equal(ground.collect(objects(unit(1n, 10, 0, 5)), absent).size, 0, "no tile, no answer");
  ground.collect(objects(unit(1n, 10, 0, 5)), sources);
  assert.equal(ground.collect(objects(unit(1n, 500, 0, 5)), absent).size, 1, "what was known stands until the ground is read");
  assert.equal(ground.collect(objects(unit(1n, 500, 0, 5)), { ...absent, map: 1 }).size, 0, "another map");
  assert.equal(ground.collect(undefined, sources).size, 0);
});

test("the normals cross to the renderer by difference and arrive whole", () => {
  const sender = new RenderInputsSender();
  const receiver = new RenderInputsReceiver();
  const normals = new Map([[1n, [0, 0, 1]]]);
  const base = { ...NO_RENDER_INPUTS, groundNormals: normals };
  const first = sender.encode(base);
  assert.deepEqual(first.groundNormals.set, [[1n, [0, 0, 1]]]);
  assert.deepEqual([...receiver.apply(first).groundNormals.get(1n)], [0, 0, 1]);
  const quiet = sender.encode(base);
  assert.equal(quiet.groundNormals, undefined, "nothing moved, nothing sent");
  normals.set(1n, [0.1, 0, 0.99]);
  const inputs = receiver.apply(sender.encode(base));
  assert.deepEqual([...inputs.groundNormals.get(1n)], [0.1, 0, 0.99]);
  assert.equal(NO_RENDER_INPUTS.groundNormals.size, 0, "nothing pushed: nothing leans");
});

test("the artifact says how a model leans; the renderer asks the mount first and leaves the facing alone", () => {
  assert.equal(WVM9_TILT_X, 0x20);
  assert.equal(WVM9_TILT_Y, 0x40);
  const generator = readFileSync(new URL("../tools/generate-visual-model.mjs", import.meta.url), "utf8");
  assert.match(generator, /tiltBits: asWowExe \? m2Data\.readUInt32LE\(0x10\) & 3 : 0/);
  const renderer = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(renderer, /\(unit\.mount\?\.wvm \?\? unit\.wvm\)\?\.tiltBits/);
  assert.match(renderer, /rotation\.set\(lean\.roll, rotation\.y, lean\.pitch, "YXZ"\)/);
});
