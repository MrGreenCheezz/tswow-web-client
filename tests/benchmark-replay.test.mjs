import assert from "node:assert/strict";
import test from "node:test";

import {
  WORLD_REPLAY_SCHEMA_VERSION,
  schemaVersion,
  canonicalWorldReplayJson,
  captureWorldReplaySnapshot,
  cloneWorldReplaySnapshot,
  hashWorldReplaySnapshot,
  hashWorldReplayFrameOrder,
  hydrateWorldReplaySnapshot,
  validateWorldReplayObservation,
} from "../dist/code/browser/BenchmarkReplay.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import { parseWeather } from "../dist/code/world/WorldMessageProtocol.js";
import { parseMonsterMove } from "../dist/code/world/MonsterMoveProtocol.js";
import { monsterMovePacket } from "./fixtures/world-packets.mjs";

const camera = (frameIndex) => ({
  frameIndex,
  yaw: 0.1 + frameIndex,
  pitch: -0.2,
  distance: 21.31,
  view: 20,
  viewPitch: -0.2,
  zoom: 21.31,
  wallView: 50,
  terrainView: 50,
  pivotHeight: 1.7,
  eyeHeight: 1.4,
});

const object = (guid, overrides = {}) => ({
  guid: String(guid),
  typeId: 3,
  position: { x: 1, y: 2, z: 3, orientation: 0.5 },
  movementFlags: 0,
  updateFlags: 0,
  targetGuid: null,
  runSpeed: 7,
  turnRate: 3.14,
  transport: null,
  transportTime: null,
  speeds: [["run", 7], ["walk", 2.5]],
  fields: [[2, 99], [10, 123]],
  ...overrides,
});

const valid = () => ({
  schemaVersion: 1,
  scenarioId: "fixture",
  mapId: 0,
  selfGuid: "2",
  targetGuid: "10",
  focusGuid: null,
  halfMinute: 1440,
  weather: { state: 0, intensity: 0, abrupt: false },
  rngSeed: 123,
  frameStepMs: 16.666,
  frames: [camera(0), camera(1)],
  objects: [object(2), object(10, { targetGuid: "2" })],
  expectations: {
    scene: "exterior",
    indoors: false,
    underwater: false,
    precipitation: false,
    rainIntensity: 0,
  },
});

function clone(value) {
  return structuredClone(value);
}

test("schema version is exported and valid snapshots are owned and deeply immutable", () => {
  assert.equal(WORLD_REPLAY_SCHEMA_VERSION, 1);
  assert.equal(schemaVersion, 1);
  const input = valid();
  const snapshot = cloneWorldReplaySnapshot(input);
  assert.notEqual(snapshot, input);
  assert.deepEqual(snapshot, input);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.frames));
  assert.ok(Object.isFrozen(snapshot.frames[0]));
  assert.ok(Object.isFrozen(snapshot.objects[0]));
  assert.ok(Object.isFrozen(snapshot.objects[0].fields));
  assert.throws(() => { snapshot.objects[0].fields[0][1] = 7; }, TypeError);
  input.objects[0].fields[0][1] = 8;
  assert.equal(snapshot.objects[0].fields[0][1], 99);
});

test("wire camera clear limits use null and only +Infinity is captured", async () => {
  const input = valid();
  input.frames[0].wallView = null;
  input.frames[0].terrainView = null;
  const snapshot = cloneWorldReplaySnapshot(input);
  assert.equal(snapshot.frames[0].wallView, null);
  assert.equal(snapshot.frames[0].terrainView, null);
  const hydrated = hydrateWorldReplaySnapshot(snapshot);
  assert.equal(hydrated.frames[0].wallView, Infinity);
  assert.equal(hydrated.frames[0].terrainView, Infinity);
  for (const value of [Number.NaN, Number.NEGATIVE_INFINITY]) {
    const bad = valid();
    bad.frames[0].wallView = value;
    assert.throws(() => cloneWorldReplaySnapshot(bad));
  }
  const firstPerson = valid();
  firstPerson.frames[0] = {
    ...firstPerson.frames[0],
    distance: 0,
    view: 0,
    zoom: 0,
    wallView: null,
    terrainView: null,
  };
  const firstPersonSnapshot = cloneWorldReplaySnapshot(firstPerson);
  assert.equal(canonicalWorldReplayJson(firstPersonSnapshot), canonicalWorldReplayJson(firstPerson));
  assert.match(await hashWorldReplaySnapshot(firstPersonSnapshot), /^[0-9a-f]{64}$/);
  const firstPersonHydrated = hydrateWorldReplaySnapshot(firstPersonSnapshot);
  assert.equal(firstPersonHydrated.frames[0].distance, 0);
  assert.equal(firstPersonHydrated.frames[0].wallView, Infinity);
  assert.equal(firstPersonHydrated.frames[0].terrainView, Infinity);
});

test("strict validation rejects malformed and noncanonical values", () => {
  for (const guid of ["", "02", "+2", "2.0", "18446744073709551616", "-1", "0x2"]) {
    const input = valid();
    input.selfGuid = guid;
    assert.throws(() => cloneWorldReplaySnapshot(input), /guid/i, guid);
  }
  for (const version of [undefined, 0, 2, "1"]) {
    const input = valid();
    if (version === undefined) delete input.schemaVersion;
    else input.schemaVersion = version;
    assert.throws(() => cloneWorldReplaySnapshot(input));
  }
  for (const mutate of [
    (input) => { input.frames = []; },
    (input) => { input.frameStepMs = 0; },
    (input) => { input.frames[1].frameIndex = 2; },
    (input) => { input.frames[0].yaw = Number.NaN; },
    (input) => { input.objects[0].movementFlags = -1; },
    (input) => { input.objects[0].fields = [[2, 0x1_0000_0000]]; },
    (input) => { input.objects[0].speeds = [["walk", 2], ["run", 7]]; },
    (input) => { input.objects[0].fields = [[2, 1], [2, 2]]; },
    (input) => { input.objects[0].motion = {}; },
    (input) => { input.objects[0].glide = {}; },
    (input) => { input.objects[0].unknown = true; },
    (input) => { input.expectations.scene = "moon"; },
    (input) => { delete input.expectations.rainIntensity; },
    (input) => { input.expectations.precipitation = true; },
    (input) => { input.expectations.indoors = true; },
    (input) => { input.expectations.extra = false; },
  ]) {
    const input = valid();
    mutate(input);
    assert.throws(() => cloneWorldReplaySnapshot(input));
  }
});

test("strict validation rejects ordering, duplicates, missing references, and bad protocol values", () => {
  for (const mutate of [
    (input) => { input.objects.reverse(); },
    (input) => { input.objects.push(object(10)); },
    (input) => { input.selfGuid = "99"; },
    (input) => { input.targetGuid = "99"; },
    (input) => { input.objects[0].targetGuid = "99"; },
    (input) => { input.objects[0].transport = { guid: "99", x: 0, y: 0, z: 0, orientation: 0, seat: 0 }; },
    (input) => { input.weather.state = 0x1_0000_0000; },
    (input) => { input.weather.intensity = 2; },
    (input) => { input.weather.abrupt = 1; },
    (input) => { input.mapId = 1.5; },
  ]) {
    const input = valid();
    mutate(input);
    assert.throws(() => cloneWorldReplaySnapshot(input));
  }
});

test("strict validation rejects sparse replay arrays and pairs", async () => {
  const sparseFrames = valid();
  sparseFrames.frames = new Array(2);
  sparseFrames.frames[0] = camera(0);
  assert.throws(() => cloneWorldReplaySnapshot(sparseFrames), /present|sparse|frame/i);
  await assert.rejects(hashWorldReplayFrameOrder(sparseFrames), /present|sparse|frame/i);

  const sparseObjects = valid();
  sparseObjects.objects = new Array(2);
  sparseObjects.objects[0] = object(2);
  assert.throws(() => cloneWorldReplaySnapshot(sparseObjects), /present|sparse|object/i);

  const sparsePairs = valid();
  sparsePairs.objects[0].fields = new Array(2);
  sparsePairs.objects[0].fields[0] = [2, 99];
  assert.throws(() => cloneWorldReplaySnapshot(sparsePairs), /present|sparse|pair|field/i);

  const sparseCaptureFrames = [camera(0), ,];
  assert.throws(() => captureWorldReplaySnapshot(new WorldState(), 0, metadata(), sparseCaptureFrames), /present|sparse|frame/i);
});

test("zero nullable GUIDs normalize to null and do not alter canonical hash", async () => {
  const nulls = valid();
  const zeros = valid();
  nulls.targetGuid = null;
  nulls.focusGuid = null;
  nulls.objects[0].targetGuid = null;
  zeros.targetGuid = "0";
  zeros.focusGuid = "0";
  zeros.objects[0].targetGuid = "0";
  assert.equal(canonicalWorldReplayJson(nulls), canonicalWorldReplayJson(zeros));
  assert.equal(await hashWorldReplaySnapshot(nulls), await hashWorldReplaySnapshot(zeros));
  assert.equal(cloneWorldReplaySnapshot(zeros).targetGuid, null);
  assert.equal(cloneWorldReplaySnapshot(zeros).objects[0].targetGuid, null);
  const explicitUndefined = valid();
  explicitUndefined.objects[0].targetGuid = undefined;
  assert.equal(cloneWorldReplaySnapshot(explicitUndefined).objects[0].targetGuid, null);
});

test("scene expectations are exact and observation mismatches throw", () => {
  const snapshot = cloneWorldReplaySnapshot(valid());
  assert.equal(validateWorldReplayObservation(snapshot, {
    indoors: false,
    underwater: false,
    weather: snapshot.weather,
  }), true);
  assert.throws(() => validateWorldReplayObservation(snapshot, {
    indoors: true,
    underwater: false,
    weather: snapshot.weather,
  }), /indoors/i);
  const rain = valid();
  rain.expectations = {
    scene: "rain", indoors: false, underwater: false, precipitation: true, rainIntensity: 0.7,
  };
  rain.weather = { state: 3, intensity: 0.7, abrupt: true };
  const rainSnapshot = cloneWorldReplaySnapshot(rain);
  assert.equal(rainSnapshot.weather.intensity, Math.fround(0.7));
  assert.equal(rainSnapshot.expectations.rainIntensity, Math.fround(0.7));
  assert.equal(validateWorldReplayObservation(rainSnapshot, {
    indoors: false,
    underwater: false,
    weather: rainSnapshot.weather,
  }), true);
  const weatherPayload = new Uint8Array(9);
  const weatherView = new DataView(weatherPayload.buffer);
  weatherView.setUint32(0, 3, true);
  weatherView.setFloat32(4, 0.7, true);
  weatherPayload[8] = 1;
  const parsedRain = parseWeather(weatherPayload);
  const parsedRainInput = valid();
  parsedRainInput.expectations = {
    scene: "rain", indoors: false, underwater: false, precipitation: true, rainIntensity: Math.fround(0.7),
  };
  parsedRainInput.weather = parsedRain;
  const parsedRainSnapshot = cloneWorldReplaySnapshot(parsedRainInput);
  assert.equal(parsedRainSnapshot.weather.intensity, Math.fround(0.7));
  assert.equal(validateWorldReplayObservation(parsedRainSnapshot, {
    indoors: false, underwater: false, weather: parsedRain,
  }), true);
  const badRain = structuredClone(parsedRainInput);
  badRain.weather.intensity = 0.6;
  assert.throws(() => cloneWorldReplaySnapshot(badRain));
  for (const mutate of [
    (input) => { input.weather = { state: 0, intensity: 0, abrupt: true }; },
    (input) => { input.expectations.rainIntensity = 0.6; },
    (input) => { input.expectations.indoors = true; },
  ]) {
    const bad = structuredClone(rain);
    mutate(bad);
    assert.throws(() => cloneWorldReplaySnapshot(bad));
  }
});

test("canonical JSON and SHA-256 hash ignore object key insertion order", async () => {
  const input = valid();
  const reordered = JSON.parse(JSON.stringify(input, (key, value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).reverse());
  }));
  const left = canonicalWorldReplayJson(input);
  const right = canonicalWorldReplayJson(reordered);
  assert.equal(left, right);
  assert.equal(await hashWorldReplaySnapshot(input), await hashWorldReplaySnapshot(reordered));
  assert.match(await hashWorldReplaySnapshot(input), /^[0-9a-f]{64}$/);
  assert.equal(await hashWorldReplayFrameOrder(input), await hashWorldReplayFrameOrder(reordered));
  const frameChanged = structuredClone(input);
  frameChanged.frames.reverse();
  frameChanged.frames.forEach((frame, index) => { frame.frameIndex = index; });
  assert.notEqual(await hashWorldReplayFrameOrder(input), await hashWorldReplayFrameOrder(frameChanged));
});

test("hydration creates numeric GUID order, fresh maps/records/frames, and clears motion/glide", () => {
  const input = valid();
  const snapshot = cloneWorldReplaySnapshot(input);
  const hydrated = hydrateWorldReplaySnapshot(snapshot);
  assert.ok(hydrated.state instanceof WorldState);
  assert.equal(hydrated.state.selfGuid, 2n);
  assert.deepEqual([...hydrated.state.objects.keys()], [2n, 10n]);
  assert.notEqual(hydrated.state.objects.get(2n).fields, snapshot.objects[0].fields);
  assert.deepEqual([...hydrated.state.objects.get(2n).fields], [[2, 99], [10, 123]]);
  assert.equal(hydrated.state.objects.get(2n).motion, undefined);
  assert.equal(hydrated.state.objects.get(2n).glide, undefined);
  assert.notEqual(hydrated.frames, snapshot.frames);
  assert.notEqual(hydrated.frames[0], snapshot.frames[0]);
  hydrated.state.objects.get(2n).fields.set(2, 7);
  assert.equal(snapshot.objects[0].fields[0][1], 99);
});

function metadata() {
  return {
    scenarioId: "fixture",
    mapId: 0,
    selfGuid: 2n,
    targetGuid: undefined,
    focusGuid: undefined,
    halfMinute: 1440,
    weather: { state: 0, intensity: 0, abrupt: false },
    rngSeed: 123,
    frameStepMs: 100,
    expectations: {
      scene: "exterior", indoors: false, underwater: false, precipitation: false, rainIntensity: 0,
    },
  };
}

test("capture materializes spline and glide midpoints without mutating the live WorldState", () => {
  const spline = new WorldState();
  spline.selfGuid = 2n;
  spline.move(2n, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } }, 0);
  spline.startSpline({
    guid: 2n, transportGuid: undefined,
    points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }],
    duration: 1000, cyclic: false, flying: false, finalOrientation: undefined,
  }, 0);
  const splineObject = spline.objects.get(2n);
  const beforeSpline = structuredClone({
    position: splineObject.position, motion: splineObject.motion, fields: [...splineObject.fields],
  });
  const capturedSpline = captureWorldReplaySnapshot(spline, 500, metadata(), [camera(0)]);
  assert.equal(capturedSpline.objects[0].position.x, 5);
  assert.equal(capturedSpline.objects[0].motion, undefined);
  assert.deepEqual(splineObject.position, beforeSpline.position);
  assert.ok(splineObject.motion);
  assert.deepEqual([...splineObject.fields], beforeSpline.fields);

  const glide = new WorldState();
  glide.selfGuid = 2n;
  glide.move(2n, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } }, 0);
  glide.move(3n, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } }, 0);
  glide.move(3n, { flags: 0, position: { x: 10, y: 0, z: 0, orientation: 0 } }, 0);
  const glideObject = glide.objects.get(3n);
  const capturedGlide = captureWorldReplaySnapshot(glide, 90, metadata(), [camera(0)]);
  const capturedGlideObject = capturedGlide.objects.find((value) => value.guid === "3");
  assert.ok(capturedGlideObject);
  assert.equal(capturedGlideObject.position.x, 5);
  assert.equal(glideObject.position.x, 0);
  assert.ok(glideObject.glide);

  const clearFrame = { ...camera(0), distance: 0, view: 0, zoom: 0, wallView: Infinity, terrainView: Infinity };
  const capturedClear = captureWorldReplaySnapshot(spline, 500, metadata(), [clearFrame]);
  assert.equal(capturedClear.frames[0].wallView, null);
  assert.equal(capturedClear.frames[0].terrainView, null);
  assert.equal(hydrateWorldReplaySnapshot(capturedClear).frames[0].wallView, Infinity);
});

test("capture samples a spline by its full description and leaves the live lap clock alone", () => {
  const world = new WorldState();
  world.selfGuid = 2n;
  world.move(2n, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } }, 0);
  // A parabola: 40·1²/8 = 5 yd up at half time (MoveSpline::computeParabolicElevation).
  world.startSpline(parseMonsterMove(monsterMovePacket({
    guid: 2n, flags: 0x800, duration: 1000, parabolic: { acceleration: 40, startMs: 0 },
    path: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }],
  })), 0);
  const arc = captureWorldReplaySnapshot(world, 500, metadata(), [camera(0)]);
  assert.equal(arc.objects[0].position.x, 5);
  assert.equal(arc.objects[0].position.z, 5, "the arc, not the straight line");

  // An Enter_Cycle square one and a quarter laps in: the second lap leaves c0 out.
  const square = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }, { x: 0, y: 10, z: 0 }];
  world.startSpline(parseMonsterMove(monsterMovePacket({
    guid: 2n, flags: 0x2000 | 0x80000 | 0x100000, duration: 4000, path: square,
  })), 0);
  const track = world.objects.get(2n).motion.track;
  const before = { looped: track.looped, lapStartMs: track.lapStartMs, lapDurationMs: track.lapDurationMs };
  const lap = captureWorldReplaySnapshot(world, 5000, metadata(), [camera(0)]);
  assert.ok(Math.abs(lap.objects[0].position.x - 10) < 1e-3, "on the c1 → c2 leg");
  assert.ok(Math.abs(lap.objects[0].position.y - (10 + 10 + Math.SQRT2 * 10) / 4) < 1e-3, "measured from c1");
  assert.deepEqual({ looped: track.looped, lapStartMs: track.lapStartMs, lapDurationMs: track.lapDurationMs }, before);
  const again = captureWorldReplaySnapshot(world, 5000, metadata(), [camera(0)]);
  assert.equal(canonicalWorldReplayJson(again), canonicalWorldReplayJson(lap), "deterministic");
});

test("capture materializes transports independently of object insertion order", () => {
  const makeWorld = (passengerFirst) => {
    const world = new WorldState();
    world.selfGuid = 1n;
    world.move(1n, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } }, 0);
    const addPassenger = () => {
      world.move(3n, { flags: 0, position: { x: 1, y: 2, z: 0, orientation: 0 } }, 0);
      world.objects.get(3n).transport = { guid: 2n, x: 1, y: 2, z: 0, orientation: 0, seat: 0 };
    };
    const addTransport = () => {
      world.move(2n, { flags: 0, position: { x: 10, y: 0, z: 0, orientation: 0 } }, 0);
      world.startSpline({
        guid: 2n, transportGuid: undefined,
        points: [{ x: 10, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }],
        duration: 1000, cyclic: false, flying: false, finalOrientation: undefined,
      }, 0);
    };
    if (passengerFirst) {
      addPassenger();
      addTransport();
    } else {
      addTransport();
      addPassenger();
    }
    return world;
  };
  const passengerFirst = captureWorldReplaySnapshot(makeWorld(true), 500, metadata(), [camera(0)]);
  const transportFirst = captureWorldReplaySnapshot(makeWorld(false), 500, metadata(), [camera(0)]);
  assert.equal(canonicalWorldReplayJson(passengerFirst), canonicalWorldReplayJson(transportFirst));
  const passenger = passengerFirst.objects.find((value) => value.guid === "3");
  assert.ok(passenger);
  assert.equal(passenger.position.x, 16);
  assert.equal(passenger.position.y, 2);
});

test("capture rejects cyclic transport chains instead of recursing", () => {
  const world = new WorldState();
  world.selfGuid = 1n;
  world.move(1n, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } }, 0);
  world.move(2n, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } }, 0);
  world.move(3n, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } }, 0);
  world.objects.get(2n).transport = { guid: 3n, x: 0, y: 0, z: 0, orientation: 0, seat: 0 };
  world.objects.get(3n).transport = { guid: 2n, x: 0, y: 0, z: 0, orientation: 0, seat: 0 };
  assert.throws(() => captureWorldReplaySnapshot(world, 0, metadata(), [camera(0)]), /transport cycle/i);
});

test("Web Crypto is required for hashing", async () => {
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
  try {
    await assert.rejects(hashWorldReplaySnapshot(valid()), /Web Crypto|SHA-256|crypto/i);
  } finally {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: original });
  }
});

// Review 02.10 (5.04/5.27): a capture of a live world is the bench's picture of it. A remote player
// carried on by extrapolation stands at capture time where the live frame would draw them, and a
// game object's full rotation survives capture and hydration, so a tilted bridge stays tilted.
test("capture materializes an extrapolated runner and keeps a game object's rotation", async () => {
  const MOVE_FORWARD = 0x1;
  const world = new WorldState();
  world.selfGuid = 2n;
  world.move(2n, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } }, 0);
  world.move(3n, { flags: MOVE_FORWARD, position: { x: 0, y: 0, z: 0, orientation: 0 } }, 0);
  world.objects.get(3n).typeId = 4;
  const runner = world.objects.get(3n);
  assert.ok(runner.drift, "the live runner is extrapolated");
  const captured = captureWorldReplaySnapshot(world, 500, metadata(), [camera(0)]);
  const capturedRunner = captured.objects.find((value) => value.guid === "3");
  assert.ok(Math.abs(capturedRunner.position.x - 3.5) < 1e-9, `run 7 for half a second: ${capturedRunner.position.x}`);
  assert.equal(runner.position.x, 0, "the live world is not advanced by a capture");
  assert.equal(runner.drift.at, 0, "nor its drift");

  world.move(9n, { flags: 0, position: { x: 5, y: 5, z: 0, orientation: 0.4 } }, 0);
  const bridge = world.objects.get(9n);
  bridge.typeId = 5;
  bridge.rotation = { x: 0.17364817766693033, y: 0, z: 0, w: 0.984807753012208 };
  const withRotation = captureWorldReplaySnapshot(world, 500, metadata(), [camera(0)]);
  const capturedBridge = withRotation.objects.find((value) => value.guid === "9");
  assert.deepEqual(capturedBridge.rotation, bridge.rotation);
  assert.equal("rotation" in withRotation.objects.find((value) => value.guid === "3"), false,
    "an object without one writes no key, so older captures hash as before");
  const hydrated = hydrateWorldReplaySnapshot(withRotation).state.objects.get(9n);
  assert.deepEqual(hydrated.rotation, bridge.rotation);
  assert.equal(await hashWorldReplaySnapshot(cloneWorldReplaySnapshot(withRotation)), await hashWorldReplaySnapshot(withRotation));
});
