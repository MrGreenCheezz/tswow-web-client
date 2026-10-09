import assert from "node:assert/strict";
import test from "node:test";
import {
  CAMERA_DISTANCE_SMOOTH_SPEED, CAMERA_SMOOTH_TIME_MAX, CAMERA_SMOOTH_TIME_MIN, CAMERA_VIEW_DEFAULTS, CameraViews,
  cameraViewCVar, cameraViewStorageKey, cameraYawOffFlip,
} from "../dist/code/browser/game/CameraViews.js";
import { CAMERA_SMOOTH_WHEN_MOVING, advanceCameraFollow } from "../dist/code/browser/game/CameraRig.js";
import { CAMERA_DEFAULT_PITCH } from "../dist/code/browser/SimpleScene.js";

/*
 * DEC-B 3.11 (04.10): the stock camera views as Wow.exe 3.3.5a 12340 keeps them — SetView 0x6039b0,
 * SaveView 0x5ff260 → 0x5fe440, ResetView 0x604c80 → 0x6048a0, NextView 0x604ce0, PrevView 0x604d10,
 * FlipCameraYaw 0x5ff2c0, the switch 0x603330, the glide 0x603d30/0x8ca080, the CVars registered at
 * 0x5fdc4b. Notes: .runtime/re-2026-10-04/decb-views/ (v1–v3) and l2-targeting/ (g1–g3).
 */

const DEG = Math.PI / 180;
const MOTION = { yawSpeed: 180, pitchSpeed: 45, ceiling: 55 };
/** The world a frame belongs to: the same object while it lasts, another one is a new camera. */
const WORLD = {};
const near = (actual, expected, message, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${message}: ${actual} against ${expected}`);
const wrap = (angle) => angle - 2 * Math.PI * Math.floor((angle + Math.PI) / (2 * Math.PI));

function memory(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

function saved(storage, key) {
  return JSON.parse(storage.values.get(key) ?? "{}").cvars ?? {};
}

/** A camera views instance bound to an account's record, as a world entry binds it. */
function views(storage = memory(), account = "Tester") {
  const instance = new CameraViews(storage);
  const rig = { yaw: 0, pitch: CAMERA_DEFAULT_PITCH, distance: 21.31 };
  instance.frame(rig, 0, WORLD, account);
  return { instance, rig, storage, key: cameraViewStorageKey(account) };
}

test("the five views are Wow.exe's defaults (0xad1ba8), view 2 is the current one (cameraView \"2\")", () => {
  assert.deepEqual(CAMERA_VIEW_DEFAULTS.map((row) => [...row]), [
    [0, 0, 0], [0, 0, 0], [5.55, 10, 0], [5.55, 20, 0], [13.88, 30, 0], [13.88, 10, 0], [0, 0, 0], [5, 10, 0],
  ]);
  const { instance } = views();
  assert.equal(instance.current, 2);
  assert.deepEqual(instance.view(1), { distance: 0, pitch: 0, yaw: 0 }, "view 1 is first person");
  assert.deepEqual(instance.view(4), { distance: 13.88, pitch: 30, yaw: 0 });
  assert.equal(cameraViewCVar("Distance", 1), "cameraDistanceA");
  assert.equal(cameraViewCVar("Pitch", 3), "cameraPitchC");
  assert.equal(cameraViewCVar("Yaw", 5), "cameraYawE");
  assert.equal(cameraViewCVar("Distance", 0), "cameraDistance");
  assert.equal(cameraViewCVar("Distance", 7), "cameraDistanceBarber Shop");
  assert.equal(cameraViewStorageKey("TeSTер"), "webclient.camera-views.v1:testер", "Latin letters fold, as the account key does");
});

test("SetView glides every axis together over the longest one's time, along 0.5·(1 − cos πt)", () => {
  const { instance, rig } = views();
  rig.yaw = 0.5;
  assert.equal(instance.setView(2, rig, 1000, MOTION), true);
  // Distance 21.31 → 5.55 at 8.33 yd/s is the longest: 1.892 s (pitch 0.306 s, yaw 0.159 s).
  const seconds = (21.31 - 5.55) / CAMERA_DISTANCE_SMOOTH_SPEED;
  assert.equal(instance.gliding, true);
  instance.frame(rig, 1000 + seconds * 250, WORLD, "Tester");
  const quarter = 0.5 * (1 - Math.cos(Math.PI / 4));
  near(rig.distance, 21.31 + (5.55 - 21.31) * quarter, "a quarter of the time is 14.6% of the way");
  near(rig.pitch, CAMERA_DEFAULT_PITCH + (-10 * DEG - CAMERA_DEFAULT_PITCH) * quarter, "the pitch on the same curve");
  near(rig.yaw, 0.5 * (1 - quarter), "and the yaw, home behind the character");
  instance.frame(rig, 1000 + seconds * 500, WORLD, "Tester");
  near(rig.distance, (21.31 + 5.55) / 2, "half the time is half the way");
  instance.frame(rig, 1000 + seconds * 1000 + 1, WORLD, "Tester");
  assert.equal(rig.distance, 5.55);
  near(rig.pitch, -10 * DEG, "Wow.exe's 10° looks down: this rig's pitch is its negative (0x5fbe70)");
  assert.equal(rig.yaw, 0);
  assert.equal(instance.gliding, false);
});

test("the shared time is held to cameraSmoothTimeMin/Max (0.1–2 s); a step under a thousandth does not glide", () => {
  const short = views();
  short.rig.distance = 5.55;
  short.rig.pitch = -9 * DEG;
  short.instance.setView(2, short.rig, 0, MOTION);
  assert.equal(short.instance.glideSeconds, CAMERA_SMOOTH_TIME_MIN, "1° at 45°/s is 0.022 s: held to 0.1");
  const long = views();
  long.rig.distance = 50;
  long.instance.setView(1, long.rig, 0, MOTION);
  assert.equal(long.instance.glideSeconds, CAMERA_SMOOTH_TIME_MAX, "50 yd at 8.33 yd/s is 6 s: held to 2");
  long.instance.frame(long.rig, 2000, WORLD, "Tester");
  assert.equal(long.rig.distance, 0, "first person at the end, exactly");
  near(long.rig.pitch, 0, "level");
  const still = views();
  still.rig.distance = 5.5505;
  still.rig.pitch = -10 * DEG;
  still.instance.setView(2, still.rig, 0, MOTION);
  assert.equal(still.instance.gliding, false, "0x5fe950: nothing to glide inside 0.001");
});

test("NextView and PrevView step the current view by one inside 1–5 and write cameraView", () => {
  const { instance, rig, storage, key } = views();
  const steps = [];
  for (let press = 0; press < 4; press += 1) steps.push([instance.nextView(rig, 0, MOTION), instance.current]);
  assert.deepEqual(steps, [[true, 3], [true, 4], [true, 5], [false, 5]], "End stops at view 5");
  assert.equal(saved(storage, key).cameraView, "5", "the index is the account's cameraView (\"%d\")");
  steps.length = 0;
  for (let press = 0; press < 5; press += 1) steps.push([instance.prevView(rig, 0, MOTION), instance.current]);
  assert.deepEqual(steps, [[true, 4], [true, 3], [true, 2], [true, 1], [false, 1]], "Home stops at first person");
  assert.equal(saved(storage, key).cameraView, "1");
  assert.equal(instance.setView(0, rig, 0, MOTION), false, "SetView acts on 1–5 only");
  assert.equal(instance.setView(6, rig, 0, MOTION), false);
  assert.equal(instance.current, 1);
});

test("the blend style: 2 jumps, anything but 1 and 2 moves nothing; the same view untouched jumps", () => {
  const instant = views(memory({ [cameraViewStorageKey("Tester")]: JSON.stringify({ cvars: { cameraViewBlendStyle: "2" } }) }));
  instant.instance.setView(4, instant.rig, 0, MOTION);
  assert.equal(instant.instance.gliding, false);
  assert.equal(instant.rig.distance, 13.88);
  near(instant.rig.pitch, -30 * DEG, "pitch");
  const none = views(memory({ [cameraViewStorageKey("Tester")]: JSON.stringify({ cvars: { cameraViewBlendStyle: "0" } }) }));
  none.instance.setView(4, none.rig, 0, MOTION);
  assert.equal(none.instance.current, 4, "the index moves");
  assert.equal(none.rig.distance, 21.31, "the camera does not");
  // 0x603330: the same view again with the camera untouched since (camera+0x98 bit 0x40 clear) jumps.
  const same = views();
  same.instance.setView(3, same.rig, 0, MOTION);
  same.instance.frame(same.rig, 100, WORLD, "Tester");
  assert.equal(same.instance.gliding, true);
  same.instance.setView(3, same.rig, 100, MOTION);
  assert.equal(same.instance.gliding, false);
  assert.equal(same.rig.distance, 5.55, "straight to the view's own numbers");
  // Moved by the wheel since: it glides back.
  same.rig.distance = 9;
  same.instance.setView(3, same.rig, 200, MOTION);
  assert.equal(same.instance.gliding, true);
});

test("the wheel or the mouse during a glide takes that axis over; the others go on", () => {
  const { instance, rig } = views();
  instance.setView(4, rig, 0, MOTION);
  instance.frame(rig, 100, WORLD, "Tester");
  rig.distance = 30;
  instance.frame(rig, 200, WORLD, "Tester");
  assert.equal(rig.distance, 30, "the player's number stands");
  assert.notEqual(rig.pitch, CAMERA_DEFAULT_PITCH);
  instance.frame(rig, 5000, WORLD, "Tester");
  near(rig.pitch, -30 * DEG, "the pitch still arrives");
  assert.equal(rig.distance, 30);
});

test("SaveView keeps where the camera is going, in the view and its three CVars; ResetView only in the camera", () => {
  const { instance, rig, storage, key } = views();
  rig.distance = 8;
  rig.pitch = -15 * DEG;
  rig.yaw = -30 * DEG;
  assert.equal(instance.saveView(3, rig), true);
  const view = instance.view(3);
  near(view.distance, 8, "distance");
  near(view.pitch, 15, "pitch");
  near(view.yaw, 330, "yaw, in 0–360 as the camera keeps it");
  assert.deepEqual(saved(storage, key), {
    cameraDistanceC: "8.000000", cameraPitchC: "15.000000", cameraYawC: "330.000000",
  });
  assert.equal(instance.saveView(0, rig), false);
  assert.equal(instance.saveView(6, rig), false);
  // Mid-glide: the targets (camera+0x1e8/0x230/0x260), not the frame's numbers.
  instance.setView(5, rig, 0, MOTION);
  instance.frame(rig, 100, WORLD, "Tester");
  instance.saveView(2, rig);
  near(instance.view(2).distance, 13.88, "the glide's destination");
  near(instance.view(2).pitch, 10, "pitch destination");
  // Past the CVar's 50 yards (the validator 0x5fd680): the camera keeps it, the CVar does not.
  rig.distance = 52;
  instance.frame(rig, 5000, WORLD, "Tester");
  instance.saveView(3, rig);
  assert.equal(instance.view(3).distance, 52);
  assert.equal(saved(storage, key).cameraDistanceC, "8.000000");
  // ResetView puts the defaults back in the camera only; the next load brings the saved view back.
  assert.equal(instance.resetView(3, rig, 0, MOTION), true);
  assert.deepEqual(instance.view(3), { distance: 5.55, pitch: 20, yaw: 0 });
  const later = views(storage);
  assert.deepEqual(later.instance.view(3), { distance: 8, pitch: 10, yaw: 0 }, "the saved view is the account's (its last SaveView)");
});

test("ResetView of the current view moves the camera back to the default", () => {
  const { instance, rig } = views();
  instance.saveView(2, { distance: 9, pitch: -40 * DEG, yaw: 0 });
  instance.setView(2, rig, 0, MOTION);
  instance.frame(rig, 5000, WORLD, "Tester");
  assert.equal(rig.distance, 9);
  instance.resetView(2, rig, 5000, MOTION);
  instance.frame(rig, 10000, WORLD, "Tester");
  assert.equal(rig.distance, 5.55);
  near(rig.pitch, -10 * DEG, "pitch");
});

test("a stored record is read through the CVars' own ranges; a new world takes cameraView", () => {
  const storage = memory({
    [cameraViewStorageKey("Tester")]: JSON.stringify({ cvars: {
      cameraView: "4", cameraDistanceD: "20.5", cameraPitchD: "95", cameraYawD: "-5", cameraDistanceE: "x",
    } }),
  });
  const { instance } = views(storage);
  assert.equal(instance.current, 4);
  assert.deepEqual(instance.view(4), { distance: 20.5, pitch: 30, yaw: 0 }, "±89° and 0–360° (0x5fd6d0, 0x5fd7b0)");
  assert.equal(instance.view(5).distance, 13.88);
  const odd = views(memory({ [cameraViewStorageKey("Tester")]: JSON.stringify({ cvars: { cameraView: "9" } }) }));
  assert.equal(odd.instance.current, 2, "outside 0–7 (0x5fd630): the default");
  const broken = views(memory({ [cameraViewStorageKey("Tester")]: "{" }));
  assert.equal(broken.instance.current, 2);
  // Another account reads its own record.
  instance.nextView({ yaw: 0, pitch: 0, distance: 0 }, 0, MOTION);
  const other = views(storage, "Other");
  assert.equal(other.instance.current, 2);
});

test("FlipCameraYaw turns a yaw of its own that views, SaveView and a new camera treat apart (camera+0x12c)", () => {
  const { instance, rig } = views();
  rig.yaw = 0.2;
  instance.flipCameraYaw(180, rig);
  near(rig.flipYaw, wrap(Math.PI), "the flip");
  near(wrap(rig.yaw - (0.2 + Math.PI)), 0, "drawn yaw carries it");
  near(cameraYawOffFlip(rig), 0.2, "the yaw the steer and the follow see");
  instance.setView(2, rig, 0, MOTION);
  instance.frame(rig, 5000, WORLD, "Tester");
  near(wrap(rig.yaw - Math.PI), 0, "the view's yaw 0, still flipped (0x604490 adds +0x12c after it)");
  rig.yaw = wrap(Math.PI + 0.3);
  instance.saveView(4, rig);
  near(instance.view(4).yaw, 0.3 / DEG, "saved without the flip");
  instance.flipCameraYaw(180, rig);
  near(rig.flipYaw, 0, "flipped back");
  near(rig.yaw, 0.3, "and the drawn yaw with it");
  instance.flipCameraYaw(90, rig);
  instance.frame(rig, 6000, { another: true }, "Tester");
  assert.equal(rig.flipYaw, 0, "a new camera has none (0x606b30)");
  near(rig.yaw, 0.3, "and the drawn yaw loses it");
  assert.equal(cameraYawOffFlip({ yaw: 1.25 }), 1.25, "no flip: the yaw itself");
});

test("the follow brings the camera home to the flip, not through it", () => {
  const rig = { yaw: Math.PI - 0.5, pitch: CAMERA_DEFAULT_PITCH, flipYaw: Math.PI };
  advanceCameraFollow(rig, CAMERA_SMOOTH_WHEN_MOVING, 180, true, false, 1);
  near(wrap(rig.yaw - Math.PI), 0, "flipped camera stays flipped while running");
  const plain = { yaw: 0.5, pitch: CAMERA_DEFAULT_PITCH };
  advanceCameraFollow(plain, CAMERA_SMOOTH_WHEN_MOVING, 180, true, false, 1);
  assert.equal(plain.yaw, 0, "without a flip, behind the character as ever");
});

test("the ceiling holds a view's distance; a pitch past this rig's limit is held to it", () => {
  const { instance, rig } = views();
  instance.saveView(5, { distance: 40, pitch: -1.54, yaw: 0 });
  instance.setView(5, rig, 0, { ...MOTION, ceiling: 15 });
  instance.frame(rig, 5000, WORLD, "Tester");
  assert.equal(rig.distance, 15, "the wheel's own ceiling");
  near(rig.pitch, -85 * DEG, "CAMERA_PITCH_LIMIT", 1e-12);
});

test("the yaw glides the short way round, through the back (0x601410 unwraps it against the target)", () => {
  const { instance, rig } = views();
  instance.saveView(3, { distance: 5.55, pitch: -20 * DEG, yaw: 190 * DEG });
  near(instance.view(3).yaw, 190, "kept as 0–360");
  rig.distance = 5.55;
  rig.pitch = -20 * DEG;
  rig.yaw = 170 * DEG;
  instance.setView(3, rig, 0, MOTION);
  near(instance.glideSeconds, 20 / 180, "20°, not 340°, at 180°/s");
  instance.frame(rig, 1000 * 20 / 180 / 2, WORLD, "Tester");
  near(rig.yaw, wrap(180 * DEG), "half way is straight behind", 1e-9);
});

// DEC-review 3.11 (04.10): every new camera reads the five views from their CVars — Wow.exe 0x00606b30 calls 0x005fe510
// (.runtime/re-2026-10-04/decb-views/v1.c, its callers 0x00606f20 and 0x00518c61) — so a ResetView, which puts the
// defaults back in the camera only, lasts until the next world, not until the page is reloaded. A blocked or
// throwing browser storage keeps the views for the session and never throws into the frame or a key.
test("DEC-review 3.11: a new world's camera takes the saved views back from the CVars; a broken storage throws nothing", () => {
  const { instance, rig, storage, key } = views();
  instance.saveView(3, { distance: 8, pitch: -15 * DEG, yaw: 0 });
  instance.resetView(3, rig, 0, MOTION);
  assert.deepEqual(instance.view(3), { distance: 5.55, pitch: 20, yaw: 0 }, "ResetView: the default in the camera");
  instance.frame(rig, 100, WORLD, "Tester");
  assert.deepEqual(instance.view(3), { distance: 5.55, pitch: 20, yaw: 0 }, "the same world keeps it");
  instance.frame(rig, 200, { next: true }, "Tester");
  assert.deepEqual(instance.view(3), { distance: 8, pitch: 15, yaw: 0 }, "a new world's camera reads cameraDistanceC/PitchC/YawC (0x005fe510)");
  assert.equal(saved(storage, key).cameraDistanceC, "8.000000");

  const broken = {
    getItem() { throw new Error("SecurityError: storage is disabled"); },
    setItem() { throw new Error("QuotaExceededError"); },
  };
  const blocked = new CameraViews(broken);
  const camera = { yaw: 0, pitch: CAMERA_DEFAULT_PITCH, distance: 21.31 };
  assert.doesNotThrow(() => blocked.frame(camera, 0, WORLD, "Tester"));
  assert.equal(blocked.current, 2, "nothing read: cameraView's default");
  assert.doesNotThrow(() => blocked.nextView(camera, 0, MOTION));
  assert.doesNotThrow(() => blocked.saveView(4, camera));
  assert.equal(blocked.current, 3, "the switch happened all the same");
  assert.equal(blocked.view(4).distance, 5.55, "and the view (where the glide goes) is kept for the session");
  const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("SecurityError"); } });
  try {
    const page = new CameraViews();
    assert.doesNotThrow(() => page.frame(camera, 0, WORLD, "Tester"), "the page's localStorage itself refused");
    assert.doesNotThrow(() => page.saveView(2, camera));
  } finally {
    if (realStorage) Object.defineProperty(globalThis, "localStorage", realStorage);
    else delete globalThis.localStorage;
  }
});
