import assert from "node:assert/strict";
import test from "node:test";

// 11.01 slice A1, the browser half (browser/TransportMotion.ts) and M7-3: the transport clock is the
// create block's PathProgress (Object.cpp:442-454) plus the time since, modulo GAMEOBJECT_LEVEL
// (Transport.cpp:95), corrected by the GAMEOBJECT_DYNAMIC phase word (GameObject.cpp:2866-2873);
// the gateway's baked track is used only when its period is the server's; and the ship is moved
// through WorldState.poseProvider before passengers are carried, so a passenger stands on the deck
// where the deck is this frame. Nothing here talks to a gateway: fetch and timers are fakes.
const motion = await import("../dist/code/browser/TransportMotion.js");
const ships = await import("../dist/code/gateway/TransportShipPaths.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;
const LEVEL = UPDATE_FIELDS.GAMEOBJECT_LEVEL.offset;
const DYNAMIC = UPDATE_FIELDS.GAMEOBJECT_DYNAMIC.offset;
const BYTES_1 = UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset;

/** The gateway's own bake of twelve nodes along +x, stops at nodes 3 and 8: period 130 000 ms. */
function straightTrack() {
  const nodes = Array.from({ length: 12 }, (_, i) => ({
    pathId: 1, nodeIndex: i, mapId: 0, x: 1000 + i * 100, y: 500, z: 20,
    flags: i === 3 || i === 8 ? 2 : 0, delay: i === 3 || i === 8 ? 10 : 0, arrivalEventId: 0, departureEventId: 0,
  }));
  return JSON.parse(JSON.stringify(ships.bakeShipTrack(ships.generateShipPath(nodes, 10, 1), 1)));
}

const TRACK = straightTrack();
const pose = () => ({ map: 0, x: 0, y: 0, z: 0, orientation: 0, stop: false });

test("the browser and the gateway agree on the route version and the sample flags", () => {
  assert.equal(motion.SHIP_PATH_ROUTE_VERSION, ships.SHIP_PATHS_VERSION);
  assert.equal(motion.SHIP_SAMPLE_STOP, ships.SHIP_SAMPLE_STOP);
  assert.equal(motion.SHIP_SAMPLE_CUT, ships.SHIP_SAMPLE_CUT);
  assert.equal(TRACK.period, 130_000);
  assert.ok(motion.shipTrackFrom(TRACK));
  assert.equal(motion.shipTrackFrom({ version: 1, path: 9, speed: 1, accel: 1, error: "no path 9" }), null);
  assert.equal(motion.shipTrackFrom({ ...TRACK, version: 2 }), undefined);
  assert.equal(motion.shipTrackFrom({ ...TRACK, x: TRACK.x.slice(1) }), undefined);
});

test("shipPoseAt interpolates between samples, holds across a cut, and wraps the cycle", () => {
  const out = pose();
  motion.shipPoseAt(TRACK, 0, out);
  assert.deepEqual([out.x, out.y, out.map], [TRACK.x[0], TRACK.y[0], 0]);
  // Halfway between two moving samples.
  const i = TRACK.flags.findIndex((flags, k) => !flags && TRACK.x[k + 1] !== TRACK.x[k]);
  motion.shipPoseAt(TRACK, i * 100 + 50, out);
  assert.ok(Math.abs(out.x - (TRACK.x[i] + TRACK.x[i + 1]) / 2) < 1e-9);
  assert.equal(out.stop, false);
  // The same moment one or two cycles later.
  const again = motion.shipPoseAt(TRACK, i * 100 + 50 + 2 * TRACK.period, pose());
  assert.equal(again.x, out.x);
  // The last sample is a cut to the first: held, not dragged back along the path.
  const last = TRACK.x.length - 1;
  motion.shipPoseAt(TRACK, last * 100 + 90, out);
  assert.equal(out.x, TRACK.x[last]);
  // A stop.
  const stop = TRACK.flags.findIndex((flags) => flags & motion.SHIP_SAMPLE_STOP);
  motion.shipPoseAt(TRACK, stop * 100 + 30, out);
  assert.equal(out.stop, true);

  // Facing turns the short way across zero.
  const turning = { ...TRACK, o: TRACK.o.map((_, k) => (k === 0 ? 6.2 : 0.1)), flags: TRACK.flags.map(() => 0) };
  motion.shipPoseAt(turning, 50, out);
  const expected = (6.2 + (0.1 + 2 * Math.PI - 6.2) / 2) % (2 * Math.PI);
  assert.ok(Math.abs(out.orientation - expected) < 1e-9, `${out.orientation} vs ${expected}`);
});

test("the clock runs from PathProgress, and a dynamic phase word corrects it only when it is far off", () => {
  const object = {};
  const period = 130_000;
  // PathProgress is never reduced by the server; 3 cycles and 1 234 ms in.
  const clock = motion.anchorShipClock(object, 3 * period + 1234, (1000 << 16) >>> 0, period, 10_000);
  assert.equal(motion.shipClockPhase(clock, 10_000, period), 1234);
  assert.equal(motion.shipClockPhase(clock, 10_500, period), 1734);
  assert.equal(motion.shipClockPhase(clock, 10_000 + period, period), 1234);
  // The create block's own word is not news.
  assert.equal(motion.correctShipClock(clock, (1000 << 16) >>> 0, period, 10_000), false);

  // A word whose window holds the running phase: kept as it is.
  const now = 20_000;
  const running = motion.shipClockPhase(clock, now, period);
  const word = Math.floor((running / period) * 65535);
  assert.equal(motion.correctShipClock(clock, (word << 16) >>> 0, period, now), false);
  assert.equal(motion.shipClockPhase(clock, now, period), running);
  // A word 200 ms away: inside the slack, kept.
  const near = Math.floor(((running + 200) / period) * 65535);
  assert.equal(motion.correctShipClock(clock, (near << 16) >>> 0, period, now), false);
  // A word 30 s away (a stopped transport, a sleeping tab): the window's middle wins.
  const far = Math.floor(((running + 30_000) / period) * 65535);
  assert.equal(motion.correctShipClock(clock, ((far << 16) | 0x0001) >>> 0, period, now), true);
  const corrected = motion.shipClockPhase(clock, now, period);
  assert.ok(Math.abs(corrected - (running + 30_000)) <= period / 65535, `${corrected}`);
  assert.equal(clock.corrections, 1);
  // −1 (no period on the server) says nothing.
  assert.equal(motion.correctShipClock(clock, 0xffff0000, period, now), false);
  assert.equal(motion.dynamicPhaseWord(0xffff0000), undefined);

  // No PathProgress (never the case for a ship, but the word is a phase): its window's middle.
  const fromWord = motion.anchorShipClock(object, undefined, (32767 << 16) >>> 0, period, 0);
  assert.ok(Math.abs(motion.shipClockPhase(fromWord, 0, period) - period / 2) < 2);
});

test("the baked period must be the server's GAMEOBJECT_LEVEL", () => {
  assert.equal(motion.shipPeriodAgrees(130_000, 130_000), true);
  assert.equal(motion.shipPeriodAgrees(130_000, 130_002), true);
  assert.equal(motion.shipPeriodAgrees(130_000, 130_003), false);
  assert.equal(motion.shipPeriodAgrees(130_000, 0), false);
});

const SHIP = 0x1fc0000000000001n;
const RIDER = 0x0000000000000042n;

function shipObject({ level = TRACK.period, transportTime = 5_000, entry = 20808 } = {}) {
  return {
    guid: SHIP, typeId: 5,
    position: { x: 1, y: 2, z: 3, orientation: 0 },
    movementFlags: 0, updateFlags: 0, targetGuid: undefined, runSpeed: undefined, turnRate: undefined,
    transport: undefined, speeds: undefined, motion: undefined, glide: undefined, splineTier: undefined,
    transportTime,
    fields: new Map([[ENTRY, entry], [LEVEL, level], [BYTES_1, 15 << 8], [DYNAMIC, 0]]),
    drift: undefined, pitch: undefined, rotation: undefined, positionTransport: undefined, vehicleId: undefined,
  };
}

function riderObject() {
  return {
    ...shipObject(), guid: RIDER, typeId: 4, transportTime: undefined, fields: new Map(),
    position: { x: 0, y: 0, z: 0, orientation: 0 },
    // Two yards ahead on the deck, a yard up, facing the ship's way.
    transport: { guid: SHIP, x: 2, y: 0, z: 1, orientation: 0, seat: 0xff },
  };
}

function harness(options = {}) {
  // `track: undefined` is a case of its own (still loading), not the default.
  const track = "track" in options ? options.track : TRACK;
  const { map = 0, template = { type: 15, data: [1, 10, 1] } } = options;
  const state = new WorldState();
  const logs = [];
  const asked = [];
  const ship = new motion.ShipMotion({
    paths: { track: (path, speed, accel) => { asked.push([path, speed, accel]); return track; } },
    template: () => template,
    mapId: () => map,
    log: (message) => logs.push(message),
  });
  state.poseProvider = (s, now) => ship.update(s, now);
  return { state, ship, logs, asked };
}

test("M7-3: the ship moves to its pose before its passenger is carried", () => {
  const { state, asked } = harness();
  state.objects.set(SHIP, shipObject());
  state.objects.set(RIDER, riderObject());
  state.revision++;
  state.updateMotions(1_000);
  assert.deepEqual(asked[0], [1, 10, 1], "the template's data0..2 are path, speed, accel");
  const expected = motion.shipPoseAt(TRACK, 5_000, pose());
  const shipNow = state.objects.get(SHIP).position;
  assert.deepEqual([shipNow.x, shipNow.y, shipNow.z], [expected.x, expected.y, expected.z]);
  // 40 s later, along the path, and the rider with it.
  state.updateMotions(41_000);
  const later = motion.shipPoseAt(TRACK, 45_000, pose());
  assert.ok(Math.abs(shipNow.x - later.x) < 1e-9 && later.x !== expected.x);
  const rider = state.objects.get(RIDER).position;
  const cos = Math.cos(shipNow.orientation);
  const sin = Math.sin(shipNow.orientation);
  assert.ok(Math.abs(rider.x - (shipNow.x + 2 * cos)) < 1e-9, `${rider.x} vs ${shipNow.x + 2 * cos}`);
  assert.ok(Math.abs(rider.y - (shipNow.y + 2 * sin)) < 1e-9);
  assert.ok(Math.abs(rider.z - (shipNow.z + 1)) < 1e-9);
});

test("a ship stays where its create block put it without a track, on a wrong period, or on another map", () => {
  for (const [label, options, level] of [
    ["track still loading", { track: undefined }, TRACK.period],
    ["gateway cannot build the path", { track: null }, TRACK.period],
    ["period disagrees with GAMEOBJECT_LEVEL", {}, TRACK.period + 500],
    ["timetable on another map", { map: 571 }, TRACK.period],
    ["not an MO transport template", { template: { type: 11, data: [1, 10, 1] } }, TRACK.period],
  ]) {
    const { state, logs } = harness(options);
    state.objects.set(SHIP, shipObject({ level }));
    state.revision++;
    state.updateMotions(1_000);
    state.updateMotions(2_000);
    assert.deepEqual(state.objects.get(SHIP).position, { x: 1, y: 2, z: 3, orientation: 0 }, label);
    if (label.startsWith("period") || label.startsWith("gateway")) assert.equal(logs.length, 1, `${label}: one warning`);
  }
});

test("a new create block re-anchors the clock; a values update with a far phase corrects it", () => {
  const { state, ship } = harness();
  state.objects.set(SHIP, shipObject({ transportTime: 5_000 }));
  state.revision++;
  state.updateMotions(1_000);
  // The server re-sends the transport (a visibility pass): a new object with a newer PathProgress.
  state.objects.set(SHIP, shipObject({ transportTime: 70_000 }));
  state.revision++;
  state.updateMotions(2_000);
  const expected = motion.shipPoseAt(TRACK, 70_000, pose());
  assert.equal(state.objects.get(SHIP).position.x, expected.x);
  assert.equal(ship.clock(SHIP).progressMs, 70_000);
  // A values update whose phase is 20 s ahead: re-anchored to it.
  const word = Math.floor((90_000 / TRACK.period) * 65535);
  state.objects.get(SHIP).fields.set(DYNAMIC, (word << 16) >>> 0);
  state.revision++;
  state.updateMotions(2_000);
  assert.ok(Math.abs(motion.shipClockPhase(ship.clock(SHIP), 2_000, TRACK.period) - 90_000) <= 2);
  // Out of range: forgotten.
  state.objects.delete(SHIP);
  state.revision++;
  state.updateMotions(3_000);
  assert.equal(ship.ships, 0);
});

test("review: the clock counts from when the create block was read, not from the first frame after it", () => {
  // A transport's CREATE as the core writes it (Transport.cpp:40: UPDATEFLAG_TRANSPORT | LOWGUID |
  // STATIONARY_POSITION | ROTATION; only the first two matter here): PathProgress 5 000 ms.
  const u32 = (value) => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value >>> 0, 0); return buffer; };
  const f32 = (value) => { const buffer = Buffer.alloc(4); buffer.writeFloatLE(value, 0); return buffer; };
  const values = [[ENTRY, 20808], [DYNAMIC, 0], [LEVEL, TRACK.period], [BYTES_1, 15 << 8]];
  assert.ok(values.every(([index]) => index < 32));
  const mask = values.reduce((bits, [index]) => bits | (1 << index), 0);
  const packet = Buffer.concat([
    u32(1), Buffer.from([2]), Buffer.from([0x01, 0x2a]), Buffer.from([5]),
    Buffer.from([0x42, 0x00]), f32(1), f32(2), f32(3), f32(0),
    u32(5_000),
    Buffer.from([1]), u32(mask), ...values.map(([, value]) => u32(value)),
  ]);
  const { state } = harness();
  state.applyUpdate(packet, 1_000);
  assert.equal(state.objects.get(0x2an)?.transportTimeAt, 1_000);
  // The page was hidden: the first frame comes 30 s after the packet. The ship is 30 s further on.
  state.updateMotions(31_000);
  const expected = motion.shipPoseAt(TRACK, 35_000, pose());
  const ship = state.objects.get(0x2an).position;
  assert.deepEqual([ship.x, ship.y, ship.z], [expected.x, expected.y, expected.z]);
});

test("review: a world mount restarts a track request the last world leave cut short", async () => {
  const requests = [];
  const timers = [];
  const fetch = async (url) => {
    requests.push(url);
    return { ok: false, status: 404, json: async () => undefined };
  };
  const clock = { setTimeout: (callback) => { timers.push(callback); return timers.length; }, clearTimeout: () => {} };
  const client = new motion.ShipPathClient("http://127.0.0.1:8090", { fetch, clock });
  // An old gateway: 404, and a second try scheduled 15 s later — then the player leaves the world.
  client.track(1, 10, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.state(1, 10, 1), "loading");
  client.stop();
  assert.equal(client.state(1, 10, 1), "idle");
  // The next world mount (the gateway restarted meanwhile) asks again.
  client.retry();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.notEqual(client.state(1, 10, 1), "idle");
});

test("ShipPathClient asks once per (path, speed, accel), survives an old gateway, and keeps a refusal", async () => {
  const requests = [];
  const answers = [];
  const timers = [];
  const fetch = async (url) => {
    requests.push(url);
    const answer = answers.shift() ?? { status: 404 };
    return { ok: answer.status === 200, status: answer.status, json: async () => answer.body };
  };
  const clock = { setTimeout: (callback) => { timers.push(callback); return timers.length; }, clearTimeout: () => {} };
  const client = new motion.ShipPathClient("http://127.0.0.1:8090", { fetch, clock });

  // A gateway older than the route: 404, one more try later, the ship static meanwhile.
  answers.push({ status: 404 });
  assert.equal(client.track(1, 10, 1), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.track(1, 10, 1), undefined);
  assert.equal(requests.length, 1);
  assert.match(requests[0], /\/dbc\/ship-paths\?v=1&path=1&speed=10&accel=1$/);
  // The restarted gateway answers the scheduled retry.
  answers.push({ status: 200, body: TRACK });
  timers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.track(1, 10, 1)?.period, TRACK.period);

  answers.push({ status: 200, body: { version: 1, path: 7, speed: 10, accel: 1, error: "no path 7" } });
  client.track(7, 10, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.track(7, 10, 1), null);
  assert.equal(requests.length, 3);
  // A template without a path is never asked about.
  assert.equal(client.track(0, 10, 1), null);
  assert.equal(requests.length, 3);
});
