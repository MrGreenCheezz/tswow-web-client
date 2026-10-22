// 22.10 ARC-2 S5: the frame codec (src/browser/FrameInput*.ts) and the loopback bridge (RenderBridgeLoopback.ts).
// Every main-state change goes through the real WorldState paths (create blocks, values, moves, splines, rates,
// transports, destroy, re-create); each frame is encoded, passed through structuredClone as a post would copy it, and
// decoded — and the mirror must answer every read the renderer makes exactly as the main state does.
import assert from "node:assert/strict";
import test from "node:test";
import v8 from "node:v8";
import { WorldState, splineAnimationTier, isWorldObjectDead, appearsDead, fieldFloat } from "../dist/code/world/WorldState.js";
import { parseMonsterMove } from "../dist/code/world/MonsterMoveProtocol.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { fieldsVersion } from "../dist/code/world/FieldsVersion.js";
import {
  FrameInputDecoder, FrameInputEncoder, structuredSize,
} from "../dist/code/browser/FrameInputCodec.js";
import { RenderBridgeLoopback, renderBridgeMode } from "../dist/code/browser/RenderBridgeLoopback.js";
import { RenderInputsReceiver, RenderInputsSender, RenderLookupsReceiver, RenderLookupsSender } from "../dist/code/browser/RenderTablesBridge.js";
import { viewSubjectIn } from "../dist/code/browser/game/ViewSubject.js";
import { corpseUnitView } from "../dist/code/browser/CorpseModel.js";
import { liftPhaseMs } from "../dist/code/browser/LiftClock.js";
import { setRenderClockOffset } from "../dist/code/browser/RenderClock.js";
import { livingSplineCreatePacket, monsterMovePacket } from "./fixtures/world-packets.mjs";

const F = (name) => UPDATE_FIELDS[name].offset;
const ON_TRANSPORT = 0x200;
const FORWARD = 0x1;
const NO_ARGS = { map: 0, cameraYaw: 0, cameraPitch: 0, cameraDistance: 10, cameraAnchorDistance: 10,
  cameraPivotHeight: 1.6, wmoFloor: undefined, frameTime: undefined };

/** One frame across: encode, clone as `postMessage` would, decode. */
function cross(encoder, decoder, state, environment = []) {
  const input = encoder.encode(state, NO_ARGS, environment);
  return { input, mirror: decoder.apply(structuredClone(input)) };
}

function create(state, guid, options = {}, now = 0) {
  state.applyUpdate(livingSplineCreatePacket(guid, { movementFlags: 0, ...options }), now);
}

/** Everything the renderer reads of an object, and the derived answers it computes from them. */
function assertSameObject(main, mirror, now) {
  const where = `object ${main.guid}`;
  assert.notEqual(mirror, main, `${where}: the mirror owns its object`);
  for (const key of ["guid", "typeId", "movementFlags", "updateFlags", "targetGuid", "runSpeed", "turnRate", "pitch",
    "fallJumped", "vehicleId", "vehicleOrientation", "transportTime", "transportTimeAt"]) {
    assert.equal(mirror[key], main[key], `${where}: ${key}`);
  }
  assert.deepEqual(mirror.position, main.position, `${where}: position`);
  if (main.position) assert.notEqual(mirror.position, main.position);
  assert.deepEqual(mirror.transport, main.transport, `${where}: transport`);
  assert.deepEqual([...mirror.fields], [...main.fields], `${where}: fields, in order`);
  assert.notEqual(mirror.fields, main.fields);
  assert.deepEqual(mirror.speeds, main.speeds, `${where}: speeds`);
  assert.deepEqual(mirror.rotation, main.rotation, `${where}: rotation`);
  assert.deepEqual(mirror.positionTransport, main.positionTransport, `${where}: positionTransport`);
  assert.deepEqual(mirror.motion, main.motion, `${where}: motion`);
  assert.equal(mirror.splineTier?.tier, main.splineTier?.tier, `${where}: latch tier`);
  assert.equal(mirror.splineTier !== undefined && mirror.splineTier.track === mirror.motion?.track,
    main.splineTier !== undefined && main.splineTier.track === main.motion?.track, `${where}: latch linked`);
  for (const at of [now - 500, now, now + 250, now + 5000]) {
    assert.equal(splineAnimationTier(mirror, at), splineAnimationTier(main, at), `${where}: animation tier at ${at}`);
  }
  assert.equal(isWorldObjectDead(mirror), isWorldObjectDead(main));
  assert.equal(appearsDead(mirror), appearsDead(main));
  assert.equal(fieldFloat(mirror, F("OBJECT_FIELD_SCALE_X")), fieldFloat(main, F("OBJECT_FIELD_SCALE_X")));
}

function assertSameWorld(main, mirror, now = 0) {
  assert.equal(mirror.selfGuid, main.selfGuid);
  assert.equal(mirror.predictedGuid, main.predictedGuid);
  assert.deepEqual([...mirror.objects.keys()], [...main.objects.keys()], "same guids in the same order");
  for (const [guid, object] of main.objects) assertSameObject(object, mirror.objects.get(guid), now);
  assert.equal(viewSubjectIn(mirror)?.guid, viewSubjectIn(main)?.guid);
}

test("a session of real WorldState changes leaves the mirror equal to the main state after every frame", () => {
  const state = new WorldState();
  const encoder = new FrameInputEncoder();
  const decoder = new FrameInputDecoder();
  let now = 1000;
  // Creates: the player (self flag), a creature, a ship to ride, a lift-like object with a transport clock.
  create(state, 1n, { typeId: 4, updateFlags: 0x0021, position: { x: 1, y: 2, z: 3, orientation: 0.5 } }, now);
  create(state, 2n, { typeId: 3, position: { x: 10, y: 0, z: 0, orientation: 0 } }, now);
  create(state, 3n, { typeId: 5, position: { x: 50, y: 50, z: 0, orientation: 1 } }, now);
  state.setField(2n, F("UNIT_FIELD_DISPLAYID"), 1234);
  state.setField(2n, F("UNIT_FIELD_HEALTH"), 50);
  state.setField(2n, F("OBJECT_FIELD_SCALE_X"), 0x3fc00000); // 1.5f
  state.setField(1n, F("UNIT_FIELD_DISPLAYID"), 49);
  let { mirror } = cross(encoder, decoder, state);
  assertSameWorld(state, mirror, now);
  assert.equal(state.selfGuid, 1n);

  // Values writes, a patch, a rate, a flag, a vehicle kit.
  state.setField(2n, F("UNIT_FIELD_HEALTH"), 0);
  state.patchField(2n, F("UNIT_FIELD_DISPLAYID"), 4321);
  state.setSpeed(2n, "run", 9.5, now);
  state.setSpeed(2n, "walk", 3, now);
  state.applyMovementFlag(2n, 0x200000, true); // swimming
  state.setVehicleKit(2n, 7);
  ({ mirror } = cross(encoder, decoder, state));
  assertSameWorld(state, mirror, now);

  // A spline with an animation tier, run across its effect start, then the arrival.
  state.startSpline(parseMonsterMove(monsterMovePacket({
    guid: 2n, splineId: 9, flags: 0x200000, animation: { tier: 3, startMs: 100 }, duration: 1000,
    path: [{ x: 10, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }],
  })), now);
  ({ mirror } = cross(encoder, decoder, state));
  assertSameWorld(state, mirror, now);
  for (const step of [50, 100, 400, 600]) {
    now += step;
    state.updateMotions(now);
    ({ mirror } = cross(encoder, decoder, state));
    assertSameWorld(state, mirror, now);
  }
  assert.equal(state.objects.get(2n).motion, undefined, "the spline arrived");
  assert.notEqual(state.objects.get(2n).splineTier, undefined, "and its tier outlived it");

  // A move, a walk forward, the player's own jump flag from the physics.
  state.move(2n, { flags: FORWARD, position: { x: 22, y: 1, z: 0, orientation: 0.3 } }, now);
  state.objects.get(1n).fallJumped = true;
  state.objects.get(1n).movementFlags = 0x1000;
  ({ mirror } = cross(encoder, decoder, state));
  assertSameWorld(state, mirror, now);

  // Board the ship, ride it while it moves, leave it.
  state.move(2n, { flags: ON_TRANSPORT, position: { x: 51, y: 50, z: 1, orientation: 1 },
    transport: { guid: 3n, x: 1, y: 0, z: 1, orientation: 0, seat: -1 } }, now);
  ({ mirror } = cross(encoder, decoder, state));
  assertSameWorld(state, mirror, now);
  state.move(3n, { flags: 0, position: { x: 52, y: 51, z: 0, orientation: 1.2 } }, now);
  for (let frame = 0; frame < 3; frame++) {
    now += 90;
    state.updateMotions(now);
    ({ mirror } = cross(encoder, decoder, state));
    assertSameWorld(state, mirror, now);
  }
  state.move(2n, { flags: 0, position: { x: 60, y: 60, z: 0, orientation: 0 } }, now);
  ({ mirror } = cross(encoder, decoder, state));
  assertSameWorld(state, mirror, now);

  // A rotation and a create-block transport position, written as BenchmarkReplay and the create path write them.
  state.objects.get(3n).rotation = { x: 0, y: 0, z: 0.38, w: 0.92 };
  state.objects.get(3n).positionTransport = { guid: 9n, x: 1, y: 2, z: 3 };
  ({ mirror } = cross(encoder, decoder, state));
  assertSameWorld(state, mirror, now);

  // Removal, a position taken away, and the world cleared but for the player.
  state.invalidatePosition(1n);
  state.destroy(3n);
  ({ mirror } = cross(encoder, decoder, state));
  assertSameWorld(state, mirror, now);
  state.clearExcept(1n);
  ({ mirror } = cross(encoder, decoder, state));
  assertSameWorld(state, mirror, now);
});

test("mirror objects keep their identity across frames and are replaced with their main object", () => {
  const state = new WorldState();
  const encoder = new FrameInputEncoder();
  const decoder = new FrameInputDecoder();
  for (const guid of [1n, 2n, 3n]) create(state, guid, { typeId: 3, position: { x: Number(guid), y: 0, z: 0, orientation: 0 } });
  let { mirror } = cross(encoder, decoder, state);
  const first = new Map(mirror.objects);
  const firstPosition = mirror.objects.get(2n).position;
  state.move(2n, { flags: FORWARD, position: { x: 2.5, y: 0, z: 0, orientation: 0 } }, 0);
  state.updateMotions(100);
  ({ mirror } = cross(encoder, decoder, state));
  for (const [guid, object] of first) assert.equal(mirror.objects.get(guid), object, `guid ${guid} keeps its mirror`);
  // The main side moved its position object in place (a drift), so the mirror moved its own in place too.
  assert.equal(mirror.objects.get(2n).position, firstPosition);
  assert.equal(firstPosition.x, state.objects.get(2n).position.x);
  // A CREATE over a live guid is a new main object: a new mirror object, in the same place of the Map.
  const replacedMain = state.objects.get(2n);
  create(state, 2n, { typeId: 3, position: { x: 7, y: 0, z: 0, orientation: 0 } });
  assert.notEqual(state.objects.get(2n), replacedMain);
  let input;
  ({ input, mirror } = cross(encoder, decoder, state));
  assert.equal(input.order, undefined, "an in-place replacement needs no order");
  assert.notEqual(mirror.objects.get(2n), first.get(2n), "the replaced object is a new mirror object");
  assert.equal(mirror.objects.get(1n), first.get(1n));
  assertSameWorld(state, mirror);
  // Destroy and create again in one frame: the main Map moves the guid to the end, and so must the mirror.
  state.destroy(1n);
  create(state, 1n, { typeId: 3, position: { x: 1, y: 1, z: 0, orientation: 0 } });
  ({ input, mirror } = cross(encoder, decoder, state));
  assert.ok(input.order instanceof Int32Array, "a moved key sends the whole order");
  assertSameWorld(state, mirror);
  // The renderer's identity caches follow: the corpse view of a stable object is the same view next frame.
  create(state, 4n, { typeId: 7, position: { x: 4, y: 0, z: 0, orientation: 0 } });
  state.setField(4n, F("CORPSE_FIELD_DISPLAY_ID"), 55);
  ({ mirror } = cross(encoder, decoder, state));
  const view = corpseUnitView(mirror.objects.get(4n));
  ({ mirror } = cross(encoder, decoder, state));
  assert.equal(corpseUnitView(mirror.objects.get(4n)), view);
});

test("an unchanged world encodes to (near) nothing, and a frame passes structuredClone", () => {
  const state = new WorldState();
  const encoder = new FrameInputEncoder();
  const decoder = new FrameInputDecoder();
  for (let guid = 1n; guid <= 200n; guid++) {
    create(state, guid, { typeId: 3, position: { x: Number(guid), y: 0, z: 0, orientation: 0 } });
    state.setField(guid, F("UNIT_FIELD_DISPLAYID"), 100 + Number(guid));
    state.setField(guid, F("UNIT_FIELD_HEALTH"), 100);
  }
  const environment = [];
  const firstInput = encoder.encode(state, NO_ARGS, environment);
  assert.doesNotThrow(() => structuredClone(firstInput));
  decoder.apply(structuredClone(firstInput));
  const quiet = encoder.encode(state, NO_ARGS, environment);
  assert.equal(quiet.added.length, 0);
  assert.equal(quiet.removed.length, 0);
  assert.equal(quiet.order, undefined);
  assert.equal(quiet.motion.length, 0);
  assert.equal(quiet.fields.length, 0);
  assert.equal(quiet.changes.length, 0);
  // What is left is the header: the property names, the guids and the value arguments (about 300 bytes).
  assert.ok(structuredSize(quiet) < 400, `a quiet frame is ${structuredSize(quiet)} bytes`);
  // One field and one step: one field pair and one motion row.
  state.setField(5n, F("UNIT_FIELD_HEALTH"), 99);
  state.objects.get(6n).position.x += 0.5;
  const busy = encoder.encode(state, NO_ARGS, environment);
  assert.equal(busy.fields.length, 5, "slot, one set, no delete, key, value");
  assert.equal(busy.motion.length, 7);
  assertSameWorld(state, decoder.apply(structuredClone(busy)));
  // The size estimate is close to what V8's serializer writes for the same message.
  for (const input of [firstInput, busy]) {
    const exact = v8.serialize(input).length;
    const estimate = structuredSize(input);
    assert.ok(estimate > exact * 0.8 && estimate < exact * 1.2, `estimate ${estimate} vs v8 ${exact}`);
  }
});

test("the rates are re-sent when they are written, and only then (speeds share the fields' write counter)", () => {
  const state = new WorldState();
  const encoder = new FrameInputEncoder();
  const decoder = new FrameInputDecoder();
  create(state, 2n, { typeId: 3 });
  const speeds = state.objects.get(2n).speeds;
  const before = fieldsVersion(speeds);
  cross(encoder, decoder, state);
  state.setSpeed(2n, "run", 11, 0);
  assert.ok(fieldsVersion(speeds) > before, "setSpeed marks the rates written");
  const { input, mirror } = cross(encoder, decoder, state);
  assert.equal(input.changes.length, 1);
  assert.equal(mirror.objects.get(2n).speeds.get("run"), 11);
  assert.equal(cross(encoder, decoder, state).input.changes.length, 0);
});

test("the pushed records cross with stable identities: unchanged rows keep theirs, changed ones are new", () => {
  const sender = new RenderLookupsSender();
  const receiver = new RenderLookupsReceiver();
  const a = { id: 1, model: "a.m2" }, b = { id: 2, model: "b.m2" };
  const unitModels = new Map([[1n, a], [2n, b]]);
  const creatureDisplays = new Map([[10, { model: "x" }]]);
  const lookups = { gameObjectDisplays: undefined, gameObjectDisplayRevision: undefined, creatureDisplays,
    creatureDisplayRevision: 1, collisionModels: undefined, collisionRevision: 0, unitModels };
  const first = receiver.apply(structuredClone(sender.encode(lookups)));
  const rowA = first.unitModels.get(1n), display = first.creatureDisplays.get(10);
  assert.deepEqual(rowA, a);
  // The builder refills its Map with the same records: nothing crosses, identities stand.
  unitModels.clear(); unitModels.set(2n, b); unitModels.set(1n, a);
  const quiet = sender.encode(lookups);
  assert.equal(quiet.unitModels, undefined);
  assert.equal(quiet.creatureDisplays, undefined, "an unmoved revision is not diffed");
  const second = receiver.apply(structuredClone(quiet));
  assert.equal(second.unitModels.get(1n), rowA);
  assert.equal(second.creatureDisplays.get(10), display);
  // A new record for one unit, one unit gone, a display row added under a new revision.
  unitModels.set(1n, { id: 1, model: "c.m2" }); unitModels.delete(2n);
  creatureDisplays.set(11, { model: "y" });
  const third = receiver.apply(structuredClone(sender.encode({ ...lookups, creatureDisplayRevision: 2 })));
  assert.notEqual(third.unitModels.get(1n), rowA);
  assert.equal(third.unitModels.get(1n).model, "c.m2");
  assert.equal(third.unitModels.has(2n), false);
  assert.equal(third.creatureDisplays.get(10), display, "the unchanged row keeps its identity");
  assert.equal(third.creatureDisplays.get(11).model, "y");

  const inputsSender = new RenderInputsSender();
  const inputsReceiver = new RenderInputsReceiver();
  const vehicles = { vehicles: [], seats: [], indicators: [], indicatorSeats: [] };
  const hidden = new Set([5n]);
  const casts = new Map([[1n, { spellId: 2, startedAt: 3, duration: 4, channel: false }]]);
  const inputs = { enchantGlow: undefined, hiddenGameObjects: hidden, vehicles, publishStatus: true,
    facing: { casts, interactionNpc: 8n, movementIds: new Map([[1, 2]]), spellAttributes: new Map() },
    switches: { revision: 1, values: {} }, gatewayGeneration: undefined, frameBudgetProbe: false };
  const got = inputsReceiver.apply(structuredClone(inputsSender.encode(inputs)));
  const rows = got.vehicles;
  assert.deepEqual([...got.hiddenGameObjects], [5n]);
  assert.equal(got.facing.interactionNpc, 8n);
  assert.deepEqual(got.facing.casts.get(1n), casts.get(1n));
  hidden.clear(); hidden.add(6n); // the builder's Set is refilled in place
  const again = inputsReceiver.apply(structuredClone(inputsSender.encode(inputs)));
  assert.equal(again.vehicles, rows, "the vehicle rows keep their identity, so the catalog is not rebuilt");
  assert.deepEqual([...again.hiddenGameObjects], [6n]);
});

test("main-clock moments land on the renderer's clock (RenderClock.ts offset), and stay put in the page", () => {
  const state = new WorldState();
  create(state, 2n, { typeId: 3, position: { x: 0, y: 0, z: 0, orientation: 0 } }, 50);
  state.objects.get(2n).transportTime = 7;
  state.objects.get(2n).transportTimeAt = 40;
  state.startSpline(parseMonsterMove(monsterMovePacket({
    guid: 2n, duration: 1000, path: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }],
  })), 60);
  const casts = new Map([[2n, { spellId: 1, startedAt: 30, duration: 500, channel: false }]]);
  const inputs = { enchantGlow: undefined, hiddenGameObjects: new Set(), vehicles: undefined, publishStatus: false,
    facing: { casts, interactionNpc: undefined, movementIds: new Map(), spellAttributes: new Map() },
    switches: undefined, gatewayGeneration: undefined, frameBudgetProbe: false };
  setRenderClockOffset(100);
  try {
    const { mirror } = cross(new FrameInputEncoder(), new FrameInputDecoder(), state);
    const object = mirror.objects.get(2n);
    assert.equal(object.transportTimeAt, 140);
    assert.equal(object.motion.startedAt, state.objects.get(2n).motion.startedAt + 100);
    const facing = new RenderInputsReceiver().apply(structuredClone(new RenderInputsSender().encode(inputs))).facing;
    assert.equal(facing.casts.get(2n).startedAt, 130);
  } finally { setRenderClockOffset(0); }
  const { mirror } = cross(new FrameInputEncoder(), new FrameInputDecoder(), state);
  assertSameWorld(state, mirror, 60);
});

test("the loopback bridge draws from the mirror with the same arguments and the very environment list", () => {
  assert.equal(renderBridgeMode(new URLSearchParams("?renderbridge=loopback")), "loopback");
  assert.equal(renderBridgeMode(new URLSearchParams("?renderbridge=1")), "direct");
  assert.equal(renderBridgeMode(new URLSearchParams("")), "direct");
  const calls = [];
  const renderer = {
    draw: (...args) => { calls.push(args); return undefined; },
    setRenderInputs() {}, setRenderLookups(lookups) { calls.push(["lookups", lookups]); },
    setPortraitTargets(inputs) { calls.push(["portraits", inputs]); },
  };
  const state = new WorldState();
  create(state, 1n, { typeId: 4, updateFlags: 0x0021, position: { x: 1, y: 2, z: 3, orientation: 0 } });
  const bridge = new RenderBridgeLoopback();
  const environment = [{ id: 1 }];
  const heightAt = () => 0;
  const floor = { revision: 1, placement: { key: "k", map: 0 }, floorZ: 1, triangle: 2, groupIndex: 3, groupId: 4, groupFlags: 5 };
  const frameTime = { nowMs: 5, elapsedSeconds: 0.01, frameIndex: 2 };
  bridge.draw(renderer, state, 0, heightAt, "terrain", environment, "env", 0.1, -0.2, 9, "splat", "liquids", "paths",
    "horizon", 12, 1.7, floor, frameTime);
  const [mirror, map, sampler, terrain, objects, client, yaw, pitch, distance, splat, liquids, paths, horizon, anchor,
    pivot, wmoFloor, time] = calls[0];
  assert.notEqual(mirror, state);
  assertSameWorld(state, mirror);
  assert.equal(objects, environment, "the environment list is handed over by identity");
  assert.deepEqual([map, sampler, terrain, client, yaw, pitch, distance, splat, liquids, paths, horizon, anchor, pivot],
    [0, heightAt, "terrain", "env", 0.1, -0.2, 9, "splat", "liquids", "paths", "horizon", 12, 1.7]);
  assert.deepEqual(wmoFloor, floor);
  assert.deepEqual(time, frameTime);
  bridge.setRenderLookups(renderer, { gameObjectDisplays: undefined, gameObjectDisplayRevision: undefined,
    creatureDisplays: undefined, creatureDisplayRevision: undefined, collisionModels: undefined, collisionRevision: 0,
    unitModels: new Map() });
  const targets = { targets: new Map([["player", { guid: 1n, canvas: 3, width: 96, height: 96, stockGround: false, ready: undefined }]]),
    stock: new Map(), stockVersion: 0, rejected: [] };
  bridge.portraitTarget(renderer).setPortraitTargets(targets);
  const portraits = calls.find((call) => call[0] === "portraits")[1];
  assert.notEqual(portraits, targets);
  assert.deepEqual(portraits, targets);
  const stats = bridge.takeFrameStats();
  assert.ok(stats.bytes > 0 && stats.frameBytes > 0 && stats.frameBytes <= stats.bytes);
  assert.ok(stats.encodeMs >= 0 && stats.cloneMs >= 0 && stats.decodeMs >= 0);
  assert.equal(bridge.takeFrameStats().bytes, 0, "taken stats start again");
  // A lift's clock answers the same on the mirror (LiftClock.ts keys it on the object).
  state.objects.get(1n).transportTime = 1234;
  state.objects.get(1n).transportTimeAt = 10;
  bridge.draw(renderer, state, 0, heightAt, "terrain", environment, "env");
  const lifted = calls.at(-1)[0].objects.get(1n);
  assert.equal(liftPhaseMs(lifted, 5000, 20), liftPhaseMs(state.objects.get(1n), 5000, 20));
});
