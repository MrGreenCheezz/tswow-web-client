import assert from "node:assert/strict";
import test from "node:test";
import {
  ANIMATION_DATA_AVAILABLE, ANIMATION_FALLBACK, ANIMATION_IDS,
} from "../dist/code/generated/animations.js";
import {
  CUSTOM_ANIMATIONS, GO_STATE_ACTIVE, GO_STATE_DESTROYED, GO_STATE_READY,
  animatesAsGameObject, customGameObjectAnimation, gameObjectPose,
} from "../dist/code/browser/GameObjectAnimation.js";
import {
  TRANSPORT_CUT_SPEED, placeOnTransportPath, sampleTransportPath, transportPhaseMs,
} from "../dist/code/browser/TransportPath.js";
import { parseTransportPaths } from "../dist/code/gateway/TransportPaths.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

const { Close, Closed, Open, Opened, Destroy, Destroyed } = ANIMATION_IDS;
const withAnimationData = {
  skip: ANIMATION_DATA_AVAILABLE ? false : "no locally generated animation data",
};

/** A chest: it has the two transitions and the held-open pose, and no held-closed one. */
const CHEST = new Set([0, Close, Open, Opened]);

test("a game object snaps to the pose it is already in, and swings only when it changes", () => {
  // Walking up to an open door must not make it open again in the player's face. The difference
  // between the two is the whole of the transition logic, and it is one argument: what the object
  // was last seen doing, or nothing at all the first time it is drawn.
  assert.deepEqual(gameObjectPose(GO_STATE_ACTIVE, undefined, CHEST), { animation: Opened, once: true });
  assert.deepEqual(gameObjectPose(GO_STATE_ACTIVE, GO_STATE_READY, CHEST), { animation: Open, once: true });
  assert.deepEqual(gameObjectPose(GO_STATE_READY, GO_STATE_ACTIVE, CHEST), { animation: Close, once: true });
  // Standing still in a state it is already in keeps showing the held pose, not the transition.
  assert.deepEqual(gameObjectPose(GO_STATE_ACTIVE, GO_STATE_ACTIVE, CHEST), { animation: Opened, once: true });

  // 412 of the 608 models that declare Closed build no clip for it, because the closed pose *is*
  // the bind pose. Nothing to play is the right answer there, and a renderer that logged or
  // retried on it would fire on the majority of the doors in the world.
  assert.equal(gameObjectPose(GO_STATE_READY, undefined, CHEST), undefined);
  // With a held-closed pose — g_levermetal has one — it is used.
  const lever = new Set([...CHEST, Closed]);
  assert.deepEqual(gameObjectPose(GO_STATE_READY, undefined, lever), { animation: Closed, once: true });

  // No held-open pose at all: Open clamped on its last frame is that pose, measured — Opened is a
  // single key equal to Open's last on 150 of the 218 models that carry both.
  const halfDressed = new Set([0, Open]);
  assert.deepEqual(gameObjectPose(GO_STATE_ACTIVE, undefined, halfDressed), { animation: Open, once: true });
  // And a model with nothing at all is left in its bind pose rather than given a wrong clip.
  assert.equal(gameObjectPose(GO_STATE_ACTIVE, GO_STATE_READY, new Set([0])), undefined);
});

test("a destroyed object plays its collapse once and then holds the wreck", () => {
  const gate = new Set([0, Close, Open, Opened, Destroy, Destroyed]);
  assert.deepEqual(gameObjectPose(GO_STATE_DESTROYED, GO_STATE_READY, gate), { animation: Destroy, once: true });
  assert.deepEqual(gameObjectPose(GO_STATE_DESTROYED, GO_STATE_DESTROYED, gate), { animation: Destroyed, once: true });
  // 115 models carry Destroy and only 15 carry Destroyed, so the common case is the collapse
  // clamped on its last frame.
  assert.deepEqual(gameObjectPose(GO_STATE_DESTROYED, undefined, new Set([0, Destroy])), { animation: Destroy, once: true });
});

test("the unit chooser's fallback table is why game objects have their own", withAnimationData, () => {
  // This is the trap, stated as a test. The generated fallback chain sends an idle request from
  // Stand to Closed to Close: a chest asked for its resting pose the way a creature is asked comes
  // back with its lid shutting — a clip it really has, so nothing errors and every chest in the
  // world plays it forever. 146 and 148 point at each other, so the walk is a two-cycle as well.
  assert.equal(ANIMATION_FALLBACK[0], Closed);
  assert.equal(ANIMATION_FALLBACK[Closed], Close);
  assert.equal(ANIMATION_FALLBACK[Close], Open);
  assert.equal(ANIMATION_FALLBACK[Open], Close);
  // The chooser here never walks it: an idle open chest is Opened, and an idle closed one is
  // nothing at all.
  assert.notEqual(gameObjectPose(GO_STATE_ACTIVE, GO_STATE_ACTIVE, CHEST)?.animation, Close);
  assert.equal(gameObjectPose(GO_STATE_READY, GO_STATE_READY, CHEST), undefined);
});

test("a custom animation is one of four numbers, and everything else is animation progress", () => {
  assert.deepEqual(CUSTOM_ANIMATIONS, [
    ANIMATION_IDS.Custom0, ANIMATION_IDS.Custom1, ANIMATION_IDS.Custom2, ANIMATION_IDS.Custom3,
  ]);
  for (const [asked, expected] of CUSTOM_ANIMATIONS.entries()) {
    assert.equal(customGameObjectAnimation(asked), expected, `custom slot ${asked}`);
  }
  // Two of the core's twelve senders pass GAMEOBJECT_BYTES_1 byte 3 instead of an index, and that
  // byte is animation progress: 100 on 55,259 of 92,845 world spawns and 255 on 30,223 more.
  assert.equal(customGameObjectAnimation(100), undefined);
  assert.equal(customGameObjectAnimation(255), undefined);
  assert.equal(customGameObjectAnimation(-1), undefined);
});

test("the client's four custom-animation rows keep their DBC ids", withAnimationData, () => {
  assert.deepEqual(CUSTOM_ANIMATIONS, [153, 154, 155, 156]);
});

test("a model is rigged for animation only when it declares something a door could play", () => {
  assert.equal(animatesAsGameObject(new Set([0])), false, "18,385 of 22,112 game object models are this");
  assert.equal(animatesAsGameObject(new Set([0, Open])), true);
  assert.equal(animatesAsGameObject(new Set([0, CUSTOM_ANIMATIONS[0]])), true);
  // ShipStart/ShipMoving/ShipStop, which is what an elevator car carries: it is moved along a
  // path, not posed, and building a skinned mesh for it would buy nothing.
  assert.equal(animatesAsGameObject(new Set([0, 162, 163, 164])), false);
});

const LIFT = {
  entry: 1,
  period: 10_000,
  frames: [
    { time: 0, x: 0, y: 0, z: 0 },
    { time: 4000, x: 0, y: 0, z: -40 },
    { time: 6000, x: 0, y: 0, z: -40 },
    { time: 10_000, x: 0, y: 0, z: 0 },
  ],
};

test("a lift is somewhere between its keyframes, and comes back to where it started", () => {
  assert.deepEqual(sampleTransportPath(LIFT, 0), [0, 0, 0]);
  assert.deepEqual(sampleTransportPath(LIFT, 2000), [0, 0, -20]);
  // The dwell at the bottom falls out of interpolating between two equal frames; there is no
  // "wait" in the table, only two keys with the same position.
  assert.deepEqual(sampleTransportPath(LIFT, 5000), [0, 0, -40]);
  assert.deepEqual(sampleTransportPath(LIFT, 8000), [0, 0, -20]);
  // The cycle repeats, and a time before it started is the same point as one after.
  assert.deepEqual(sampleTransportPath(LIFT, 12_000), [0, 0, -20]);
  assert.deepEqual(sampleTransportPath(LIFT, -8000), [0, 0, -20]);
  // A path with one frame is a thing that does not move.
  assert.deepEqual(sampleTransportPath({ entry: 2, period: 0, frames: [{ time: 0, x: 1, y: 2, z: 3 }] }, 500), [1, 2, 3]);
  assert.deepEqual(sampleTransportPath({ entry: 3, period: 0, frames: [] }, 500), [0, 0, 0]);
});

test("a segment nothing could travel is a cut, not a journey", () => {
  // Four entries in the real table — the Icecrown gunships — end their cycle by returning to the
  // start in one 466 ms step of some 1,300 units. Interpolated, the ship crosses the zone every
  // cycle at 2,800 units a second; the fastest honest segment in the whole table is 168.
  const gunship = {
    entry: 4,
    period: 2000,
    frames: [
      { time: 0, x: 0, y: 0, z: 0 },
      { time: 1000, x: 100, y: 0, z: 0 },
      { time: 1466, x: 1400, y: 0, z: 0 },
    ],
  };
  assert.ok(1300 / 0.466 > TRANSPORT_CUT_SPEED, "the reset segment is above the cut threshold");
  assert.deepEqual(sampleTransportPath(gunship, 500), [50, 0, 0], "an ordinary segment interpolates");
  assert.deepEqual(sampleTransportPath(gunship, 1200), [100, 0, 0], "the cut holds where it left");
  assert.deepEqual(sampleTransportPath(gunship, 1466), [1400, 0, 0], "and is at the far end when it is over");
});

test("a path is turned by the object's own facing before it is added to its spawn point", () => {
  const base = { x: 100, y: 200, z: 50, orientation: 0 };
  assert.deepEqual(placeOnTransportPath(base, [10, 0, 5]), { x: 110, y: 200, z: 55 });
  // A quarter turn takes the path's own forward axis onto the world's, which is what a tram on a
  // spawn-rotated track needs and what 65 of the 82 vertical shafts do not care about.
  const turned = placeOnTransportPath({ ...base, orientation: Math.PI / 2 }, [10, 0, 5]);
  assert.ok(Math.abs(turned.x - 100) < 1e-6 && Math.abs(turned.y - 210) < 1e-6 && Math.abs(turned.z - 55) < 1e-6,
    `a quarter turn should move it along y: ${JSON.stringify(turned)}`);
});

test("a lift's phase comes from the server, not from when the player looked at it", () => {
  // The high half of GAMEOBJECT_DYNAMIC is the phase as a fraction of 65535, which is how the core
  // writes it: uint16(timer / period * 65535).
  assert.equal(transportPhaseMs(0x8000_0000 >>> 0, undefined, 20_000), 20_000 * (0x8000 / 65535));
  // 0xFFFF is the "not a transport" value — the field is written as int16 and is −1 for every
  // chest and door — so it must not read as 99.998% of the cycle.
  assert.equal(transportPhaseMs(0xffff_0000, 7000, 20_000), 7000);
  assert.equal(transportPhaseMs(undefined, 25_000, 20_000), 5000, "the create block's clock, modulo the period");
  assert.equal(transportPhaseMs(undefined, undefined, 20_000), 0);
  assert.equal(transportPhaseMs(0x1234_0000, 500, 0), 0, "a model that does not move has no phase");
});

test("the create block's transport clock is kept rather than read past", () => {
  // Two blocks: a game object created with UPDATEFLAG_TRANSPORT | UPDATEFLAG_STATIONARY, which is
  // exactly what a lift arrives as, and nothing else. Without this word a lift has no shared
  // starting point and every client animates it from wherever it happened to log in.
  const parts = [];
  const u32 = (value) => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value >>> 0, 0); return buffer; };
  const f32 = (value) => { const buffer = Buffer.alloc(4); buffer.writeFloatLE(value, 0); return buffer; };
  parts.push(u32(1));
  parts.push(Buffer.from([2])); // UPDATETYPE_CREATE_OBJECT
  parts.push(Buffer.from([0x01, 0x2a])); // packed guid 0x2a
  parts.push(Buffer.from([5])); // TYPEID_GAMEOBJECT
  parts.push(Buffer.from([0x42, 0x00])); // UPDATEFLAG_STATIONARY | UPDATEFLAG_TRANSPORT
  parts.push(f32(-9000), f32(400), f32(60), f32(1.5)); // stationary position
  parts.push(u32(123_456)); // the transport clock
  parts.push(Buffer.from([0])); // no values block
  const state = new WorldState();
  state.applyUpdate(Buffer.concat(parts));

  const object = state.objects.get(42n);
  assert.equal(object?.typeId, 5);
  assert.equal(object?.transportTime, 123_456);
  assert.equal(object?.position?.x, -9000);
});

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

test("the real transport table reads as paths, and the Mesa Elevator runs its shaft", withDataset, async () => {
  const { readFile } = await import("node:fs/promises");
  const paths = parseTransportPaths(await readFile(`${dbcDirectory}/TransportAnimation.dbc`));
  assert.equal(paths.size, 82, "82 game object entries have a path in this dataset");

  // The Mesa Elevator at Thunder Bluff. Its rows carry three different sequence ids and merge into
  // one descent and return; the numbers are the file's.
  const mesa = paths.get(4170);
  assert.equal(mesa?.frames.length, 13);
  assert.equal(mesa?.period, 30_033);
  assert.deepEqual(sampleTransportPath(mesa, 0), [0, 0, 0]);
  const bottom = sampleTransportPath(mesa, 15_000);
  assert.ok(Math.abs(bottom[2] + 61.24) < 0.01, `at fifteen seconds it is at the bottom: ${bottom[2]}`);
  const back = sampleTransportPath(mesa, 30_033);
  assert.ok(Math.hypot(...back) < 0.01, `and the cycle closes where it opened: ${JSON.stringify(back)}`);

  // The Undervator, whose shaft runs both ways from its spawn point.
  const undervator = paths.get(20649);
  assert.equal(undervator?.frames.length, 6);
  assert.equal(undervator?.period, 16_667);
  assert.ok(Math.abs(sampleTransportPath(undervator, 1833)[2] + 55.47) < 0.01);
  assert.ok(Math.abs(sampleTransportPath(undervator, 10_333)[2] - 41.04) < 0.01);

  // Every path is an offset from where the object stands, which is why it starts at nothing.
  for (const path of paths.values()) {
    const first = path.frames[0];
    assert.ok(Math.hypot(first.x, first.y, first.z) < 1e-4, `entry ${path.entry} starts at its own origin`);
  }
});

test("filtering the table by sequence would stop half the lifts in the world", withDataset, async () => {
  // tswow's own ElevatorKeyframes.getDefault() keeps only SequenceID 0. The regression guard is
  // this: SequenceID names the clip the car plays at that moment — ShipStop while it waits,
  // ShipStart while it moves — not an alternative path, and the ids interleave through one
  // continuous journey. Measured here rather than argued.
  const { readFile } = await import("node:fs/promises");
  const { openDbc } = await import("../dist/code/gateway/Dbc.js");
  const dbc = openDbc(await readFile(`${dbcDirectory}/TransportAnimation.dbc`), "TransportAnimation");
  const all = new Map();
  const zeroOnly = new Map();
  for (const row of dbc.rows()) {
    const entry = dbc.int(row, "TransportID");
    const time = dbc.int(row, "TimeIndex");
    all.set(entry, Math.max(all.get(entry) ?? 0, time));
    if (dbc.int(row, "SequenceID") === 0) zeroOnly.set(entry, Math.max(zeroOnly.get(entry) ?? 0, time));
  }
  const emptied = [...all.keys()].filter((entry) => !zeroOnly.has(entry));
  assert.equal(emptied.length, 32, "32 of the 82 entries have no sequence-0 row at all");
  assert.ok(emptied.includes(4170), "including the Mesa Elevator, whose rows are all ShipStart and ShipStop");
  const wrongPeriod = [...all].filter(([entry, period]) => (zeroOnly.get(entry) ?? 0) !== period);
  assert.equal(wrongPeriod.length, 48, "and 48 would run on a period that is not theirs");
  // The Undervator is the sharper case: it *has* a sequence-0 row, one, at time zero. Filtered, it
  // keeps a single keyframe and a period of nothing — a lift that stands still at the top forever.
  assert.equal(zeroOnly.get(20649), 0);
  assert.equal(all.get(20649), 16_667);
  assert.equal([...all].filter(([entry, period]) => period > 0 && (zeroOnly.get(entry) ?? 0) === 0).length, 39,
    "39 of the 82 lose their whole cycle that way");
});
