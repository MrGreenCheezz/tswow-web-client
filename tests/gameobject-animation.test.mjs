import assert from "node:assert/strict";
import test from "node:test";
import {
  ANIMATION_DATA_AVAILABLE, ANIMATION_FALLBACK, ANIMATION_IDS,
} from "../dist/code/generated/animations.js";
import {
  CUSTOM_ANIMATIONS, GO_STATE_ACTIVE, GO_STATE_DESTROYED, GO_STATE_READY,
  GO_KIND_CLOSED, GO_KIND_CLOSING, GO_KIND_CUSTOM0, GO_KIND_DESTROYED, GO_KIND_DESTROYING, GO_KIND_OPENED,
  GO_KIND_OPENING, GO_KIND_REBUILDING, GO_DESPAWN_ANIM_INDEX, GameObjectAnimator,
  animatesAsGameObject, customGameObjectAnimation, gameObjectClip, gameObjectClipTime, gameObjectKindRequest,
  gameObjectNextKind, gameObjectStateKind,
} from "../dist/code/browser/GameObjectAnimation.js";
import {
  PLAYBACK_BACKWARD, PLAYBACK_FORWARD, PLAYBACK_HOLD_FIRST, PLAYBACK_HOLD_LAST,
} from "../dist/code/browser/AnimationPlayback.js";
import {
  TRANSPORT_CUT_SPEED, placeOnTransportPath, sampleTransportPath,
} from "../dist/code/browser/TransportPath.js";
import { liftPhaseMs } from "../dist/code/browser/LiftClock.js";
import { parseTransportPaths } from "../dist/code/gateway/TransportPaths.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

const { Close, Closed, Open, Opened, Destroy, Destroyed } = ANIMATION_IDS;
const withAnimationData = {
  skip: ANIMATION_DATA_AVAILABLE ? false : "no locally generated animation data",
};

/** A chest: it has the two transitions and the held-open pose, and no held-closed one. */
const CHEST = new Set([0, Close, Open, Opened]);

const hasIn = (set) => (animation) => set.has(animation);

test("11.11 6.03: a state change is the kind Wow.exe 0x0070d690 picks from the old state and the new", () => {
  // First sight is the same state twice: the hold, never the swing.
  assert.equal(gameObjectStateKind(GO_STATE_ACTIVE, undefined), GO_KIND_OPENED);
  assert.equal(gameObjectStateKind(GO_STATE_READY, undefined), GO_KIND_CLOSED);
  assert.equal(gameObjectStateKind(GO_STATE_DESTROYED, undefined), GO_KIND_DESTROYED);
  assert.equal(gameObjectStateKind(GO_STATE_ACTIVE, GO_STATE_READY), GO_KIND_OPENING);
  assert.equal(gameObjectStateKind(GO_STATE_READY, GO_STATE_ACTIVE), GO_KIND_CLOSING);
  assert.equal(gameObjectStateKind(GO_STATE_DESTROYED, GO_STATE_READY), GO_KIND_DESTROYING);
  assert.equal(gameObjectStateKind(GO_STATE_READY, GO_STATE_DESTROYED), GO_KIND_REBUILDING);
  // The original's asymmetries: only READY swings open or collapses.
  assert.equal(gameObjectStateKind(GO_STATE_ACTIVE, GO_STATE_DESTROYED), GO_KIND_OPENED);
  assert.equal(gameObjectStateKind(GO_STATE_DESTROYED, GO_STATE_ACTIVE), GO_KIND_DESTROYED);
  // 0x0070d7e0: a transition hands on to its hold, a hold replays itself, a custom returns to the state.
  assert.equal(gameObjectNextKind(GO_KIND_OPENING, GO_STATE_ACTIVE), GO_KIND_OPENED);
  assert.equal(gameObjectNextKind(GO_KIND_CLOSING, GO_STATE_READY), GO_KIND_CLOSED);
  assert.equal(gameObjectNextKind(GO_KIND_REBUILDING, GO_STATE_READY), GO_KIND_CLOSED);
  assert.equal(gameObjectNextKind(GO_KIND_DESTROYING, GO_STATE_DESTROYED), GO_KIND_DESTROYED);
  assert.equal(gameObjectNextKind(GO_KIND_OPENED, GO_STATE_ACTIVE), GO_KIND_OPENED);
  assert.equal(gameObjectNextKind(GO_KIND_CUSTOM0, GO_STATE_ACTIVE), GO_KIND_OPENED);
  assert.equal(gameObjectNextKind(GO_KIND_CUSTOM0 + 3, GO_STATE_READY), GO_KIND_CLOSED);
});

test("11.11 6.03: a missing door clip is steered as 0x0070d1e0 steers it before the fallback", () => {
  const openOnly = hasIn(new Set([0, Open]));
  const closeOnly = hasIn(new Set([0, Close]));
  // Closed missing with no Close: Open frozen on its first frame (the closed pose), or Stand.
  assert.deepEqual(gameObjectKindRequest(GO_KIND_CLOSED, openOnly), { animation: Open, frozen: true });
  assert.deepEqual(gameObjectKindRequest(GO_KIND_CLOSED, hasIn(new Set([0]))), { animation: ANIMATION_IDS.Stand, frozen: false });
  // Opened missing with no Open: Close frozen on its first frame (the open pose).
  assert.deepEqual(gameObjectKindRequest(GO_KIND_OPENED, closeOnly), { animation: Close, frozen: true });
  // Close missing with no Open either: Closed. Open missing with no Close: Destroy if there, else Opened.
  assert.deepEqual(gameObjectKindRequest(GO_KIND_CLOSING, hasIn(new Set([0]))), { animation: Closed, frozen: false });
  assert.deepEqual(gameObjectKindRequest(GO_KIND_OPENING, hasIn(new Set([0, Destroy]))), { animation: Destroy, frozen: false });
  assert.deepEqual(gameObjectKindRequest(GO_KIND_OPENING, hasIn(new Set([0]))), { animation: Opened, frozen: false });
  // Otherwise the request stays, for the model's own fallback.
  assert.deepEqual(gameObjectKindRequest(GO_KIND_CLOSED, hasIn(CHEST)), { animation: Closed, frozen: false });
  assert.deepEqual(gameObjectKindRequest(GO_KIND_OPENED, hasIn(CHEST)), { animation: Opened, frozen: false });
});

test("11.11 6.03: the model's fallback plays a door's missing clip held or backwards (0x00826350)", withAnimationData, () => {
  // A chest with no Closed shows Close held on its last frame — not its lid shutting forever.
  assert.deepEqual(gameObjectClip({ animation: Closed, frozen: false }, hasIn(CHEST)), { animation: Close, mode: PLAYBACK_HOLD_LAST });
  // A door with Open alone: Opened is Open held on its last frame, Close is Open played backwards.
  const openOnly = hasIn(new Set([0, Open]));
  assert.deepEqual(gameObjectClip({ animation: Opened, frozen: false }, openOnly), { animation: Open, mode: PLAYBACK_HOLD_LAST });
  assert.deepEqual(gameObjectClip({ animation: Close, frozen: false }, openOnly), { animation: Open, mode: PLAYBACK_BACKWARD });
  assert.deepEqual(gameObjectClip({ animation: Open, frozen: true }, openOnly), { animation: Open, mode: PLAYBACK_HOLD_FIRST });
  // A wreck with Destroy alone: Destroyed is Destroy held on its last frame.
  assert.deepEqual(gameObjectClip({ animation: Destroyed, frozen: false }, hasIn(new Set([0, Destroy]))),
    { animation: Destroy, mode: PLAYBACK_HOLD_LAST });
  // A model with its own clip plays it forwards; one with nothing on the chain is left alone.
  assert.deepEqual(gameObjectClip({ animation: Open, frozen: false }, hasIn(CHEST)), { animation: Open, mode: PLAYBACK_FORWARD });
  assert.equal(gameObjectClip({ animation: Open, frozen: false }, hasIn(new Set([0]))), undefined);
});

test("11.11 6.03: an opening hands on to the open hold at its clip's end, and the hold loops instead of re-swinging", withAnimationData, () => {
  const has = hasIn(new Set([0, Open])); // Open only: the hold is Open held on its last frame
  const seconds = () => 1;
  const door = new GameObjectAnimator();
  door.observe(GO_STATE_READY, 0);
  assert.equal(door.frame(0, has, seconds)?.kind, GO_KIND_CLOSED);
  door.observe(GO_STATE_ACTIVE, 100);
  const swing = door.frame(100, has, seconds);
  assert.deepEqual([swing.kind, swing.animation, swing.mode, swing.loop], [GO_KIND_OPENING, Open, PLAYBACK_FORWARD, false]);
  assert.equal(door.frame(1099, has, seconds).serial, swing.serial, "still swinging just before the clip ends");
  const held = door.frame(1100, has, seconds);
  assert.deepEqual([held.kind, held.animation, held.mode, held.loop], [GO_KIND_OPENED, Open, PLAYBACK_HOLD_LAST, true]);
  // Standing open for a long time is the same hold, never a new start of the swing.
  assert.equal(door.frame(60_000, has, seconds).serial, held.serial);
});

test("11.11 6.03: a door closed mid-swing closes from where it is (0x0070d510)", withAnimationData, () => {
  const has = hasIn(new Set([0, Open]));
  const seconds = () => 1;
  const door = new GameObjectAnimator();
  door.observe(GO_STATE_READY, 0);
  door.observe(GO_STATE_ACTIVE, 0);
  door.frame(0, has, seconds);
  door.observe(GO_STATE_READY, 300); // 30 % open
  const closing = door.frame(300, has, seconds);
  assert.equal(closing.kind, GO_KIND_CLOSING);
  assert.ok(Math.abs(closing.fraction - 0.7) < 1e-9, `starts at ${closing.fraction}`);
  // Close is Open backwards here: the clip time is where the opening stood, 0.3 s into Open.
  assert.ok(Math.abs(gameObjectClipTime(closing, 1, 0) - 0.3) < 1e-9);
  // And it is over after the 0.3 s left of it.
  assert.equal(door.frame(599, has, seconds).kind, GO_KIND_CLOSING);
  assert.equal(door.frame(600, has, seconds).kind, GO_KIND_CLOSED);
});

test("11.11 6.03: a custom animation plays only on a model that has it, then the state's hold returns", withAnimationData, () => {
  const lever = hasIn(new Set([0, Open, Opened, ANIMATION_IDS.Custom0]));
  const seconds = () => 2;
  const goober = new GameObjectAnimator();
  goober.observe(GO_STATE_ACTIVE, 0);
  goober.custom(1, lever, 10); // Custom1 is not in the model: nothing (0x0070c480)
  assert.equal(goober.frame(10, lever, seconds).kind, GO_KIND_OPENED);
  goober.custom(0, lever, 20);
  const custom = goober.frame(20, lever, seconds);
  assert.deepEqual([custom.kind, custom.animation, custom.loop], [GO_KIND_CUSTOM0, ANIMATION_IDS.Custom0, false]);
  assert.equal(goober.frame(2020, lever, seconds).kind, GO_KIND_OPENED);
  goober.custom(100, lever, 3000); // animation progress, not an index
  assert.equal(goober.frame(3000, lever, seconds).kind, GO_KIND_OPENED);
});

test("11.11 6.03: a despawn plays Despawn and holds the object to the clip's end; without the clip nothing holds it", withAnimationData, () => {
  const Despawn = ANIMATION_IDS.Despawn;
  assert.equal(Despawn, 157);
  const seconds = () => 1.5;
  const vein = hasIn(new Set([0, Despawn]));
  const node = new GameObjectAnimator();
  node.observe(GO_STATE_READY, 0);
  assert.equal(node.pinnedUntil(0, vein, seconds), undefined, "a hold pins nothing");
  node.custom(GO_DESPAWN_ANIM_INDEX, vein, 100);
  const play = node.frame(100, vein, seconds);
  assert.deepEqual([play.animation, play.loop], [Despawn, false]);
  assert.equal(node.pinnedUntil(100, vein, seconds), 1600, "drawn until Despawn has played out (0x004d4d60 / 0x004d77e0)");
  assert.equal(node.pinnedUntil(1600, vein, seconds), undefined);
  // A model with no Despawn plays nothing (0x0070c480) and goes with its destroy.
  const chest = new GameObjectAnimator();
  chest.observe(GO_STATE_READY, 0);
  chest.custom(GO_DESPAWN_ANIM_INDEX, hasIn(CHEST), 100);
  assert.equal(chest.pinnedUntil(100, hasIn(CHEST), seconds), undefined);
  // A swing in progress pins too: a door destroyed mid-swing finishes it.
  const door = new GameObjectAnimator();
  door.observe(GO_STATE_READY, 0);
  door.observe(GO_STATE_ACTIVE, 0);
  assert.equal(door.pinnedUntil(500, hasIn(CHEST), () => 1), 1000);
});

test("11.11 6.03: SMSG_GAMEOBJECT_DESPAWN_ANIM no longer removes the object; it asks for its Despawn", async () => {
  const queue = [];
  let wake;
  const connection = {
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) { const resume = wake; wake = undefined; resume(queue.shift()); }
    },
    send() {},
    read() { return queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => { wake = resolve; }); },
    close() {},
  };
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  for (let round = 0; round < 4; round += 1) await new Promise((resolve) => { setImmediate(resolve); });
  const GUID = 0xf1100000000000aan;
  client.state.objects.set(GUID, { guid: GUID, typeId: 5, fields: new Map(), movementFlags: 0 });
  const asked = [];
  client.onGameObjectAnimation = (guid, index) => asked.push([guid, index]);
  connection.push(OPCODES.SMSG_GAMEOBJECT_DESPAWN_ANIM, new PacketWriter().u64(GUID).toUint8Array());
  for (let round = 0; round < 400 && asked.length === 0; round += 1) await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(asked, [[GUID, GO_DESPAWN_ANIM_INDEX]]);
  assert.ok(client.state.objects.has(GUID), "the destroy that follows removes it, not this");
  client.close();
});

test("the unit chooser's fallback table is why game objects have their own", withAnimationData, () => {
  // The generated fallback chain sends an idle request from Stand to Closed to Close, and 146 and
  // 148 point at each other. Wow.exe never asks a door for Stand: a closed one asks for Closed, and
  // Closed's row (Flags 0x20) holds the Close it falls back to.
  assert.equal(ANIMATION_FALLBACK[0], Closed);
  assert.equal(ANIMATION_FALLBACK[Closed], Close);
  assert.equal(ANIMATION_FALLBACK[Close], Open);
  assert.equal(ANIMATION_FALLBACK[Open], Close);
  assert.equal(new GameObjectAnimator().frame(0, hasIn(CHEST), () => 1), undefined, "no state, no pose");
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
  // 11.01: the create block's transport word (the worldserver's uptime for a lift) from the moment it
  // was read, modulo the period — what Wow.exe runs a lift on (0x00714250, 0x007139e0, 0x00710640).
  const DYNAMIC = UPDATE_FIELDS.GAMEOBJECT_DYNAMIC.offset;
  const lift = { transportTime: 25_000, transportTimeAt: 1000, fields: new Map([[DYNAMIC, 0x8000_0000 >>> 0]]) };
  assert.equal(liftPhaseMs(lift, 20_000, 1000), 5000, "the create block's clock, modulo the period");
  assert.equal(liftPhaseMs(lift, 20_000, 3000), 7000, "and the time since it was read");
  // Only a block without the word (never from this core) falls back on the dynamic phase word:
  // uint16(timer / period * 65535), its window's middle.
  const wordless = { transportTime: undefined, transportTimeAt: undefined, fields: new Map([[DYNAMIC, 0x8000_0000 >>> 0]]) };
  assert.ok(Math.abs(liftPhaseMs(wordless, 20_000, 0) - 20_000 * (0x8000 + 0.5) / 65535) < 1e-9);
  // 0xFFFF is the "not a transport" value — the field is written as int16 and is −1 for every
  // chest and door — so it must not read as 99.998% of the cycle.
  const none = { transportTime: undefined, transportTimeAt: undefined, fields: new Map([[DYNAMIC, 0xffff_0000]]) };
  assert.equal(liftPhaseMs(none, 20_000, 0), 0);
  assert.equal(liftPhaseMs(lift, 0, 1000), 0, "a model that does not move has no phase");
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
