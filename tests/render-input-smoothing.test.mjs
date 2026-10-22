// 22.10 ARC-2 S7: the render worker's frames without fresh input (RenderInputSmoothing.ts, MirrorMotion.ts,
// MirrorRestore.ts) through the real worker path: the page's WorldState encoded by RenderFrameSender, cloned as a post
// copies it, applied by RenderFrameReceiver — then drawn later on the worker's clock with `advance`.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { WorldState } from "../dist/code/world/WorldState.js";
import { parseMonsterMove } from "../dist/code/world/MonsterMoveProtocol.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { RenderFrameReceiver, RenderFrameSender, emptyFrameApplied } from "../dist/code/browser/RenderWorkerBridge.js";
import {
  EXTRAPOLATION_CAP_MS, INPUT_EXTRAPOLATED, INPUT_FRESH, INPUT_HELD, INPUT_INTERPOLATED, summarizeInputStates,
} from "../dist/code/browser/RenderInputSmoothing.js";
import { liftCarrierPose } from "../dist/code/browser/LiftClock.js";
import { livingSplineCreatePacket, monsterMovePacket } from "./fixtures/world-packets.mjs";

const F = (name) => UPDATE_FIELDS[name].offset;
const ON_TRANSPORT = 0x200;
const PERIOD = 10;
const ARGS = { map: 0, cameraYaw: 0, cameraPitch: -0.2, cameraDistance: 10, cameraAnchorDistance: 10,
  cameraPivotHeight: 1.6, wmoFloor: undefined, frameTime: undefined };
const LIFT_ENTRY = 4242;
const LIFT_PATH = { entry: LIFT_ENTRY, period: 4000,
  frames: [{ time: 0, x: 0, y: 0, z: 0 }, { time: 2000, x: 0, y: 0, z: 20 }, { time: 4000, x: 0, y: 0, z: 0 }] };
const PATHS = { path: (entry) => (entry === LIFT_ENTRY ? LIFT_PATH : undefined) };

function create(state, guid, options, now = 0) {
  state.applyUpdate(livingSplineCreatePacket(guid, { movementFlags: 0, ...options }), now);
}

/** One page frame posted to the worker: encoded, cloned as `postMessage` copies it, applied. */
function send(sender, receiver, state, at, args = ARGS) {
  let message;
  sender.post({ postMessage(posted) { message = posted; } }, state, args, undefined, undefined, undefined, undefined, at);
  receiver.apply(structuredClone(message), emptyFrameApplied());
  return message;
}

/** The page's world: a player, a spline with a tier, a path aboard a carrier ending on a target, a lift passenger. */
function pageWorld(now) {
  const state = new WorldState();
  create(state, 1n, { typeId: 4, updateFlags: 0x0021, position: { x: 0, y: 0, z: 0, orientation: 0 } }, now - 1000);
  create(state, 2n, { typeId: 3, position: { x: 10, y: 0, z: 0, orientation: 0 } }, now - 1000);
  create(state, 3n, { typeId: 5, position: { x: 100, y: 100, z: 5, orientation: 0.8 } }, now - 1000);
  create(state, 4n, { typeId: 3, position: { x: 101, y: 100, z: 5, orientation: 0 } }, now - 1000);
  create(state, 5n, { typeId: 5, position: { x: 300, y: 300, z: 0, orientation: 0.3 } }, now - 1000);
  create(state, 6n, { typeId: 3, position: { x: 301, y: 301, z: 0, orientation: 0 } }, now - 1000);
  state.setField(5n, F("OBJECT_FIELD_ENTRY"), LIFT_ENTRY);
  state.setField(5n, F("GAMEOBJECT_BYTES_1"), 11 << 8);
  const lift = state.objects.get(5n);
  lift.transportTime = 500;
  lift.transportTimeAt = now - 1000; // the create block was read with the others
  state.carrierPoseProvider = liftCarrierPose(PATHS);
  // Aboard the lift a second before, so the boarding glide (page-only, 11.01-E) is over.
  state.move(6n, { flags: ON_TRANSPORT, position: { x: 301, y: 301, z: 0, orientation: 0 },
    transport: { guid: 5n, x: 1, y: 1, z: 0, orientation: 0.5, seat: -1 } }, now - 1000);
  state.updateMotions(now - 500);
  state.startSpline(parseMonsterMove(monsterMovePacket({
    guid: 2n, splineId: 9, flags: 0x200000, animation: { tier: 3, startMs: 100 }, duration: 1000,
    path: [{ x: 10, y: 0, z: 0 }, { x: 20, y: 5, z: 1 }],
  })), now);
  const aboard = parseMonsterMove(monsterMovePacket({
    guid: 4n, splineId: 10, type: 3, facing: { guid: 1n }, duration: 800, path: [{ x: 1, y: 0, z: 0 }, { x: 5, y: 3, z: 0 }],
  }));
  aboard.transportGuid = 3n;
  aboard.transportSeat = 0;
  state.startSpline(aboard, now);
  return state;
}

/** The same direction: a passenger the page carried one more frame after its arrival reads `carrier + seat`, unwrapped. */
function sameAngle(a, b) {
  const delta = (a - b) % (Math.PI * 2);
  return Math.min(Math.abs(delta), Math.PI * 2 - Math.abs(delta)) < 1e-9;
}

function assertSameMotion(main, mirror, where) {
  assert.deepEqual({ ...mirror.position, orientation: 0 }, { ...main.position, orientation: 0 }, `${where}: position`);
  assert.ok(sameAngle(mirror.position.orientation, main.position.orientation),
    `${where}: orientation ${mirror.position.orientation} vs ${main.position.orientation}`);
  assert.equal(mirror.motion === undefined, main.motion === undefined, `${where}: spline presence`);
  assert.equal(mirror.movementFlags, main.movementFlags, `${where}: flags`);
  assert.equal(mirror.splineTier?.tier, main.splineTier?.tier, `${where}: latch tier`);
  assert.deepEqual(mirror.transport === undefined ? undefined : { ...mirror.transport },
    main.transport === undefined ? undefined : { ...main.transport }, `${where}: seat`);
}

function assertExact(state, receiver, where) {
  for (const [guid, main] of state.objects) assertSameMotion(main, receiver.world.objects.get(guid), `${where}, ${guid}`);
}

test("the worker's advance equals the page's updateMotions: splines, tiers, paths aboard, arrivals, lift passengers", () => {
  const start = 1000;
  const state = pageWorld(start);
  state.updateMotions(start);
  const sender = new RenderFrameSender();
  const receiver = new RenderFrameReceiver();
  receiver.smoothing.carrierPose = liftCarrierPose(PATHS);
  send(sender, receiver, state, start);
  const sent = { ...receiver.world.objects.get(2n).position };
  // The page stalls; it keeps its own clock below only to say where everything should be.
  for (const now of [start + 40, start + 250, start + 600, start + 850, start + 1300]) {
    state.updateMotions(now);
    receiver.advance(now + PERIOD, PERIOD);
    assert.notEqual(receiver.smoothing.lastState, INPUT_FRESH, `${now}: drawn without fresh input`);
    for (const guid of [2n, 4n, 6n]) assertSameMotion(state.objects.get(guid), receiver.world.objects.get(guid), `t=${now}, ${guid}`);
  }
  assert.notDeepEqual({ ...receiver.world.objects.get(2n).position }, sent, "the spline went on");
  assert.equal(receiver.world.objects.get(2n).motion, undefined, "and arrived, as on the page");
  assert.notEqual(receiver.world.objects.get(6n).position.z, 0, "the lift carried its passenger");
});

test("a fresh input is drawn exactly, and the next input wins over whatever the worker advanced", () => {
  const start = 1000;
  const state = pageWorld(start);
  state.updateMotions(start);
  const sender = new RenderFrameSender();
  const receiver = new RenderFrameReceiver();
  receiver.smoothing.carrierPose = liftCarrierPose(PATHS);
  send(sender, receiver, state, start);
  // Fresh: within a display period of the input, nothing moves and the page's arguments are drawn as given.
  assert.equal(receiver.advance(start + PERIOD - 1, PERIOD), receiver.args);
  assert.equal(receiver.smoothing.lastState, INPUT_FRESH);
  assertExact(state, receiver, "fresh");
  // The player walks between two inputs, then stalls: the worker extrapolates it and advances the splines.
  state.objects.get(1n).position.x = 0.4;
  state.updateMotions(start + 20);
  send(sender, receiver, state, start + 20);
  receiver.advance(start + 20 + PERIOD + 30, PERIOD);
  assert.equal(receiver.smoothing.lastState, INPUT_EXTRAPOLATED);
  assert.notEqual(receiver.world.objects.get(1n).position.x, 0.4);
  // The page comes back: the player has stopped (no motion row for it), the splines are where the page put them.
  state.updateMotions(start + 60);
  send(sender, receiver, state, start + 60);
  assertExact(state, receiver, "after the stall");
  assert.equal(receiver.world.objects.get(1n).position.x, 0.4, "the extrapolated player is back on its input");
});

test("camera and player go on linearly from the last two inputs, at most 50 ms past the newest, then hold", () => {
  const state = new WorldState();
  create(state, 1n, { typeId: 4, updateFlags: 0x0021, position: { x: 0, y: 0, z: 0, orientation: 3.1 } });
  const sender = new RenderFrameSender();
  const receiver = new RenderFrameReceiver();
  send(sender, receiver, state, 1000, { ...ARGS, cameraYaw: 3.1, cameraPitch: -0.2, cameraDistance: 10 });
  const self = state.objects.get(1n).position;
  self.x = 0.5;
  self.orientation = -3.1;
  const args = { ...ARGS, cameraYaw: -3.1, cameraPitch: -0.1, cameraDistance: 11 };
  send(sender, receiver, state, 1020, args);
  const player = receiver.world.objects.get(1n).position;
  const turn = 2 * Math.PI - 6.2; // 3.1 → -3.1 the short way: +0.0832 rad in 20 ms
  // 10 ms past the input (the worker draws one period behind its clock).
  let drawn = receiver.advance(1020 + PERIOD + 10, PERIOD);
  assert.equal(receiver.smoothing.lastState, INPUT_EXTRAPOLATED);
  assert.ok(Math.abs(player.x - 0.75) < 1e-12, `x ${player.x}`);
  // The packets' orientations are f32: 3.1 reads 3.0999999.
  assert.ok(Math.abs(player.orientation - (-3.1 + turn / 2)) < 1e-6, "orientation the short way round");
  assert.ok(Math.abs(drawn.cameraYaw - (-3.1 + turn / 2)) < 1e-12, `yaw ${drawn.cameraYaw}`);
  assert.ok(Math.abs(drawn.cameraPitch - (-0.05)) < 1e-12);
  assert.ok(Math.abs(drawn.cameraDistance - 11.5) < 1e-12);
  assert.equal(drawn.cameraAnchorDistance, args.cameraAnchorDistance);
  assert.equal(receiver.args.cameraYaw, -3.1, "the input itself is untouched");
  // Far past the input: held at the cap.
  drawn = receiver.advance(1020 + PERIOD + 400, PERIOD);
  assert.equal(receiver.smoothing.lastState, INPUT_HELD);
  assert.ok(Math.abs(player.x - (0.5 + 0.025 * EXTRAPOLATION_CAP_MS)) < 1e-12, `held x ${player.x}`);
  assert.ok(Math.abs(drawn.cameraDistance - (11 + 0.05 * EXTRAPOLATION_CAP_MS)) < 1e-12);
  // Exact again for a lockstep draw.
  receiver.exact();
  assert.equal(player.x, 0.5);
  assert.equal(player.orientation, state.objects.get(1n).position.orientation);
});

test("a teleport, a blink, a map change or a reset world stops the extrapolation until the next pair", () => {
  const cases = [
    ["a teleport", (self) => { self.x = 15; }, ARGS],
    ["a blink-fast step", (self) => { self.x = 5; }, ARGS],
    ["a map change", (self) => { self.x = 0.4; }, { ...ARGS, map: 1 }],
  ];
  for (const [name, step, args] of cases) {
    const state = new WorldState();
    create(state, 1n, { typeId: 4, updateFlags: 0x0021, position: { x: 0, y: 0, z: 0, orientation: 0 } });
    const sender = new RenderFrameSender();
    const receiver = new RenderFrameReceiver();
    send(sender, receiver, state, 1000, { ...ARGS, cameraYaw: 0 });
    step(state.objects.get(1n).position);
    send(sender, receiver, state, 1020, { ...args, cameraYaw: 0.3 });
    const exact = state.objects.get(1n).position.x;
    const drawn = receiver.advance(1020 + PERIOD + 30, PERIOD);
    assert.equal(receiver.smoothing.lastState, INPUT_INTERPOLATED, `${name}: nothing extrapolated`);
    assert.equal(receiver.world.objects.get(1n).position.x, exact, `${name}: the player stays on its input`);
    assert.equal(drawn.cameraYaw, 0.3, `${name}: the camera too`);
    // The next pair moves again.
    state.objects.get(1n).position.x = exact + 0.2;
    send(sender, receiver, state, 1040, { ...args, cameraYaw: 0.3 });
    receiver.advance(1040 + PERIOD + 10, PERIOD);
    assert.equal(receiver.smoothing.lastState, INPUT_EXTRAPOLATED, `${name}: the next pair extrapolates`);
    assert.ok(Math.abs(receiver.world.objects.get(1n).position.x - (exact + 0.3)) < 1e-12);
  }
});

test("lockstep draws use the exact input: the bench worker restores it before every answered draw", async () => {
  const state = new WorldState();
  create(state, 1n, { typeId: 4, updateFlags: 0x0021, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  const sender = new RenderFrameSender();
  const receiver = new RenderFrameReceiver();
  send(sender, receiver, state, 1000);
  state.objects.get(1n).position.y = 0.5;
  send(sender, receiver, state, 1020);
  receiver.advance(1100, PERIOD);
  assert.notEqual(receiver.world.objects.get(1n).position.y, 0.5);
  // A lockstep message with an unchanged world carries no motion row: the restore alone puts the player back.
  send(sender, receiver, state, 1100);
  assert.equal(receiver.world.objects.get(1n).position.y, 0.5);
  receiver.advance(1200, PERIOD);
  receiver.exact();
  assert.equal(receiver.world.objects.get(1n).position.y, 0.5);
  const source = await readFile(new URL("../src/browser/bench/BenchRender.worker.ts", import.meta.url), "utf8");
  const drawNow = source.slice(source.indexOf("async #drawNow("), source.indexOf("#readiness() {"));
  assert.match(drawNow, /this\.#receiver\.exact\(\);\s*(\/\/[^\n]*\n\s*)*this\.#draw\(undefined\)/, "drawNow draws the exact input");
  assert.doesNotMatch(drawNow, /advance\(/);
});

test("the bench summary counts the worker frames by what they drew", () => {
  const columns = ["rafAtMs", "inputAgeMs", "inputState"];
  const frames = [[0, 5, INPUT_FRESH], [1, 30, INPUT_EXTRAPOLATED], [2, 90, INPUT_HELD], [3, 20, INPUT_INTERPOLATED],
    [4, 6, INPUT_FRESH]];
  assert.deepEqual(summarizeInputStates(frames, columns), { fresh: 2, interpolated: 1, extrapolated: 1, held: 1,
    inputAgeMs: { p50: 20, p99: 90, max: 90 } });
});
