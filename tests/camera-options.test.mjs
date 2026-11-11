import assert from "node:assert/strict";
import test from "node:test";
import {
  CAMERA_DEFAULT_DISTANCE, CAMERA_DEFAULT_EYE_HEIGHT, CAMERA_DEFAULT_PITCH, CAMERA_DEFAULT_PIVOT_HEIGHT, createCamera,
} from "../dist/code/browser/SimpleScene.js";
import { advanceCameraFrame } from "../dist/code/browser/game/CameraRig.js";
import { cameraCVarDefinition, cameraCVarFloat, cameraTerrainTiltCVar } from "../dist/code/browser/game/CameraCVars.js";
import {
  CameraTerrainTilt, TERRAIN_TILT_FALL, TERRAIN_TILT_FEAR, TERRAIN_TILT_IDLE, TERRAIN_TILT_LIMIT, TERRAIN_TILT_MOVE,
  TERRAIN_TILT_STRAFE, TERRAIN_TILT_SWIM, TERRAIN_TILT_TAXI, TERRAIN_TILT_TURN, sampleTerrainTilt, terrainTiltAngle,
  terrainTiltState, tiltedPitch,
} from "../dist/code/browser/game/CameraTerrainTilt.js";
import {
  CAMERA_BOB_AMPLITUDE, CameraBob, cameraBobAllowed, cameraBobInput,
} from "../dist/code/browser/game/CameraBob.js";
import {
  CAMERA_BOOM_ARM_HIT, CAMERA_BOOM_HINGE_HIT, CameraPivot, cameraPivotAllowed,
} from "../dist/code/browser/game/CameraPivot.js";
import {
  CAMERA_WATER_CLEARANCE, CAMERA_WATER_NONE, CAMERA_WATER_SUBMERGED, CAMERA_WATER_SURFACE, cameraWaterHinge,
  cameraWaterNod, cameraWaterState,
} from "../dist/code/browser/game/CameraWater.js";

test("5.33: the hinge over a swimmer at the surface stands 0.2222 over the water; a diver's 0.8333 under it", () => {
  // 0x00605d60 with 0x006049c0's state; 0.2222 0x00a1ea24, 0.8333 0x00a1e324.
  close(cameraWaterHinge(-1.7, 0, 2, 1.6), 1.7 + CAMERA_WATER_CLEARANCE, 1e-9, "1.7 deep at the surface: raised");
  assert.equal(cameraWaterHinge(-0.5, 0, 2, 1.6), 1.6, "wading: the model's own is higher");
  close(cameraWaterHinge(-2.2, 0, 2, 1.6), 2.2 - 0.8333333134651184, 1e-9, "submerged 2.2: 0.8333 under the surface");
  assert.equal(cameraWaterHinge(-3, 0, 2, 1.6), 1.6, "deeper, the model's own is lower already");
  close(cameraWaterHinge(-1.0, 0, 0.9, 1.6), 0.8333333134651184, 1e-9, "never under 0.8333 over the feet");
  assert.equal(cameraWaterHinge(-1.7, undefined, 2, 1.6), 1.6, "no water");
  assert.equal(cameraWaterHinge(-1.7, 0, undefined, 1.6), 1.6, "no body height: not judged");
});
import { createFrameXmlSettingsCVar } from "../dist/code/browser/framexml/FrameXmlSettingsCVar.js";
import { defaultSettings } from "../dist/code/browser/ui/SettingsModel.js";

/*
 * 5.14 (11.11): the stock camera options as Wow.exe 3.3.5a 12340 has them — the terrain tilt (0x00603a10, 0x00601b70,
 * 0x00600fa0; table 0x00a1e9c8, ±20° 0x00a1e318, cameraGroundSmoothSpeed 7.5 0x00a1e73c, cameraTerrainTiltTimeMin/Max
 * 3/10), the head bob (0x00600090, 0x00600030, 0x00602f30, 0x005ffd20; 0.8 0x00c24e5c, 2 × 1/36 0x00a3f854, 1/7
 * 0x00a1e90c, 0.8 yd/s 0x00a1e790), the smart pivot (0x006020b0, 0x005ffde0, 0x00602600; 90°/s 0x00a1e7c4, −1.5533
 * 0x00ad1b50) and the water nod (0x006049c0, 0x00606f90; 0.2222 0x00a1ea24, 5° 0x00a1e294). Notes:
 * .runtime/re-2026-11-11/camera/.
 */

const DEG = Math.PI / 180;
const close = (actual, expected, epsilon, label) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label ?? ""} ${actual} vs ${expected}`);

test("the terrain tilt's table: the last slope reached picks its angle, downhill looks down, held to ±20°", () => {
  assert.equal(terrainTiltAngle(0.05), 0, "under 0.09 the first row: none");
  close(terrainTiltAngle(0.09), -5 * DEG, 1e-6, "uphill 0.09 looks up 5°");
  close(terrainTiltAngle(-0.2), 10 * DEG, 1e-6, "downhill 0.2 looks down 10°");
  close(terrainTiltAngle(0.3599), -15 * DEG, 1e-6);
  close(terrainTiltAngle(0.36), -TERRAIN_TILT_LIMIT, 1e-7, "20° at 0.36");
  assert.equal(terrainTiltAngle(-0.84), TERRAIN_TILT_LIMIT, "40° is held to 20°");
  assert.equal(terrainTiltAngle(Number.POSITIVE_INFINITY), -TERRAIN_TILT_LIMIT, "a wall at the feet: the most");
  assert.equal(terrainTiltAngle(Number.NaN), 0, "no row is reached");
});

test("the probe: a ramp 3.06 yards ahead, past a wall, and a drop deeper than its line", () => {
  const ramp = { heightAt: (x) => x * 0.2 };
  close(sampleTerrainTilt(ramp, 0, 0, 0, 0), -10 * DEG, 1e-6, "rising 0.2 ahead: looks up 10°");
  close(sampleTerrainTilt(ramp, 0, 0, 0, Math.PI), 10 * DEG, 1e-6, "turned round it falls: looks down");
  assert.equal(sampleTerrainTilt({ heightAt: () => 0 }, 0, 0, 0, 1.2), 0, "flat");
  // A wall half way: the plumb line drops 0.2778 short of it, 1.3889 out; ground there 0.5 up → slope 0.36 → 20° up.
  const walled = { firstHit: () => 0.5, heightAt: (x) => (x > 1 ? 0.5 : 0) };
  close(sampleTerrainTilt(walled, 0, 0, 0, 0), -TERRAIN_TILT_LIMIT, 1e-7);
  // Nothing under the line within 7.111: the drop's end, 5.444 under the feet, is the ground.
  close(sampleTerrainTilt({}, 0, 0, 0, 0), TERRAIN_TILT_LIMIT, 1e-7);
});

test("the rows: taxi, swim or flight, fall, spline, then the input; the defaults per style", () => {
  const subject = (movementFlags, extra = {}) => ({ unit: true, x: 0, y: 0, z: 0, facing: 0, movementFlags, taxi: false, fear: false, ...extra });
  assert.equal(terrainTiltState(subject(0x1, { taxi: true })), TERRAIN_TILT_TAXI);
  assert.equal(terrainTiltState(subject(0x200001)), TERRAIN_TILT_SWIM);
  assert.equal(terrainTiltState(subject(0x2000000)), TERRAIN_TILT_SWIM);
  assert.equal(terrainTiltState(subject(0x1001)), TERRAIN_TILT_FALL);
  assert.equal(terrainTiltState(subject(0x1, { fear: true })), TERRAIN_TILT_FEAR);
  assert.equal(terrainTiltState(subject(0x2)), TERRAIN_TILT_MOVE);
  assert.equal(terrainTiltState(subject(0x8)), TERRAIN_TILT_STRAFE);
  assert.equal(terrainTiltState(subject(0x20)), TERRAIN_TILT_TURN);
  assert.equal(terrainTiltState(subject(0)), TERRAIN_TILT_IDLE);
  const value = (style, state, field) => cameraCVarDefinition(cameraTerrainTiltCVar(style, state, field))?.defaultValue;
  assert.equal(cameraTerrainTiltCVar(4, TERRAIN_TILT_MOVE, 2), "cameraTerrainTiltSmarterMoveFactor");
  assert.deepEqual([0, 1, 2].map((field) => value(4, TERRAIN_TILT_FALL, field)), ["1.0", "0.0", "0.75"]);
  assert.deepEqual([0, 1, 2].map((field) => value(4, TERRAIN_TILT_IDLE, field)), ["0.0", "0.0", "-1.0"]);
  assert.deepEqual([0, 1, 2].map((field) => value(2, TERRAIN_TILT_IDLE, field)), ["1.0", "0.0", "1.0"], "Always tilts idle");
  assert.deepEqual([0, 1, 2].map((field) => value(4, TERRAIN_TILT_SWIM, field)), ["0.0", "0.0", "1.0"]);
  assert.deepEqual([0, 1, 2].map((field) => value(0, TERRAIN_TILT_MOVE, field)), ["0.0", "0.0", "-1.0"], "Never");
  assert.equal(cameraCVarDefinition("cameraTerrainTiltTimeMin")?.defaultValue, "3.0");
  assert.equal(cameraCVarDefinition("cameraTerrainTiltTimeMax")?.defaultValue, "10.0");
});

function tiltHost(overrides = {}) {
  return {
    enabled: true, style: 4,
    cvar: (name) => cameraCVarFloat(cameraCVarDefinition(name)?.defaultValue),
    world: { heightAt: (x) => x * 0.2 }, // uphill 0.2 along +x: 10° up
    ...overrides,
  };
}
const walker = (movementFlags) => ({ unit: true, x: 0, y: 0, z: 0, facing: 0, movementFlags, taxi: false, fear: false });

test("moving, the tilt glides there over at least 3 s (10° at 7.5°/s is 1.33 s, held to Factor × 3)", () => {
  const tilt = new CameraTerrainTilt();
  tilt.frame(0, walker(0x1), tiltHost());
  close(tilt.measure, -10 * DEG, 1e-6);
  close(tilt.frame(1500, walker(0x1), tiltHost()), -5 * DEG, 1e-6, "half way at 1.5 s, the half cosine's middle");
  close(tilt.frame(3000, walker(0x1), tiltHost()), -10 * DEG, 1e-7, "there at 3 s");
  // Standing still (Idle, Factor −1) holds it; off, it glides back level.
  close(tilt.frame(3100, walker(0), tiltHost({ world: { heightAt: () => 0 } })), -10 * DEG, 1e-7, "idle keeps it");
  tilt.frame(3200, walker(0x1), tiltHost({ enabled: false }));
  close(tilt.frame(4700, walker(0x1), tiltHost({ enabled: false })), -5 * DEG, 1e-6, "off: back level over 3 s");
  close(tilt.frame(6200, walker(0x1), tiltHost({ enabled: false })), 0, 1e-9);
  // Never: the rows hold everything, the tilt stays level.
  const never = new CameraTerrainTilt();
  never.frame(0, walker(0x1), tiltHost({ style: 0 }));
  assert.equal(never.frame(5000, walker(0x1), tiltHost({ style: 0 })), 0);
  // A glide's time never past Factor × 10: 20° would take 2.67 s, inside the bounds; a factor of 0 sets at once.
  const set = new CameraTerrainTilt();
  const zero = (name) => (name === cameraTerrainTiltCVar(4, TERRAIN_TILT_MOVE, 2) ? 0 : tiltHost().cvar(name));
  close(set.frame(0, walker(0x1), tiltHost({ cvar: zero })), -10 * DEG, 1e-6, "Factor 0: at once");
});

test("the tilt is added to the drawn pitch, not to the drag's, and held to ±89°", () => {
  close(tiltedPitch(0.2, 0.1), 0.1, 1e-12, "looking down by the tilt");
  assert.equal(tiltedPitch(0.2, undefined), 0.2);
  close(tiltedPitch(-1.5, 0.2), -1.5533430576324463, 1e-12);
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const rig = (terrainTilt) => ({
    yaw: 0, pitch: CAMERA_DEFAULT_PITCH, distance: CAMERA_DEFAULT_DISTANCE, view: CAMERA_DEFAULT_DISTANCE,
    viewPitch: CAMERA_DEFAULT_PITCH, zoom: CAMERA_DEFAULT_DISTANCE, wallView: Number.POSITIVE_INFINITY,
    terrainView: Number.POSITIVE_INFINITY, pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT, eyeHeight: CAMERA_DEFAULT_EYE_HEIGHT,
    terrainTilt,
  });
  const level = rig(0);
  const tilted = rig(10 * DEG);
  advanceCameraFrame(level, player, CAMERA_DEFAULT_PIVOT_HEIGHT, { allowUpwardOrbit: true }, 1 / 60);
  advanceCameraFrame(tilted, player, CAMERA_DEFAULT_PIVOT_HEIGHT, { allowUpwardOrbit: true }, 1 / 60);
  close(tilted.viewPitch, level.viewPitch - 10 * DEG, 1e-9);
  assert.equal(tilted.pitch, CAMERA_DEFAULT_PITCH, "the drag's number is untouched");
});

const bobSubject = (extra = {}) => ({
  arm: 0, unit: true, enabled: true, movementFlags: 0x1, mounted: false, taxi: false, facing: 0, speed: 7, ...extra,
});

test("the head bob: on with a move bit, sways 0.0556 across the facing at 0.8 Hz and bobs at 1.6 Hz", () => {
  assert.equal(cameraBobInput(0x10), true, "forward");
  assert.equal(cameraBobInput(0x1000), true, "autorun");
  assert.equal(cameraBobInput(0x3), true, "both buttons");
  assert.equal(cameraBobInput(0x101), true, "right button and a turn key");
  assert.equal(cameraBobInput(0x100), false, "a turn key alone");
  assert.equal(cameraBobInput(0x1), false);
  const bob = new CameraBob();
  bob.input(true, 1000);
  const quarter = bob.frame(1000 + 312.5, bobSubject());
  close(quarter.x, 0, 1e-12);
  close(quarter.y, CAMERA_BOB_AMPLITUDE, 1e-6, "a quarter sway at r = 1 (speed 7): fully left");
  close(quarter.z, 0, 1e-6, "the bob is at its half cycle");
  const at = bob.frame(1000 + 156.25, bobSubject());
  close(at.z, CAMERA_BOB_AMPLITUDE, 1e-6, "the bob's top at 1/6.4 s");
  // Walking (2.5 → r 0.357, held to 0.5) halves the rate: a quarter sway takes 0.625 s.
  close(bob.frame(1000 + 625, bobSubject({ speed: 2.5 })).y, CAMERA_BOB_AMPLITUDE, 1e-6);
  for (const blocked of [{ arm: 5.55 }, { movementFlags: 0x200001 }, { movementFlags: 0x1001 }, { mounted: true },
    { taxi: true }, { enabled: false }, { unit: false }]) {
    assert.equal(cameraBobAllowed(bobSubject(blocked)), false, JSON.stringify(blocked));
  }
  assert.equal(cameraBobAllowed(bobSubject({ arm: 0.1666 })), true, "1/6 yard is still first person");
});

test("the head bob eases out over its largest axis / 0.8 yd/s once the move ends", () => {
  const bob = new CameraBob();
  bob.input(true, 0);
  bob.frame(312.5, bobSubject());
  bob.input(false, 312.5);
  const seconds = CAMERA_BOB_AMPLITUDE / 0.8;
  close(bob.frame(312.5 + seconds * 500, bobSubject()).y, CAMERA_BOB_AMPLITUDE / 2, 1e-6, "half way");
  assert.equal(bob.frame(312.5 + seconds * 1000 + 1, bobSubject()).y, 0);
});

test("the smart pivot: when it may, and how a look up is taken about the camera", () => {
  const may = { enabled: true, unit: true, movementFlags: 0, pitch: -0.2, boom: CAMERA_BOOM_ARM_HIT };
  assert.equal(cameraPivotAllowed(may), true);
  assert.equal(cameraPivotAllowed({ ...may, boom: CAMERA_BOOM_HINGE_HIT }), true);
  assert.equal(cameraPivotAllowed({ ...may, boom: CAMERA_BOOM_HINGE_HIT, movementFlags: 0x2000000 }), false, "flying: the arm only");
  assert.equal(cameraPivotAllowed({ ...may, boom: 0 }), false, "nothing holds the boom");
  assert.equal(cameraPivotAllowed({ ...may, movementFlags: 0x1 }), false, "moving");
  assert.equal(cameraPivotAllowed({ ...may, pitch: 0.1 }), false, "looking down");
  assert.equal(cameraPivotAllowed({ ...may, enabled: false }), false);

  const pivot = new CameraPivot();
  assert.equal(pivot.look(0.01, -0.1, true, -0.2, 0.05, 0, 0), 0, "looking up below level: the camera stays");
  close(pivot.turn, -0.1, 1e-12);
  assert.equal(pivot.look(0.06, -0.05, true, -0.2, 0.05, 0, 0), 0, "a turn under way goes on past the yaw bound");
  close(pivot.turn, -0.15, 1e-12);
  close(pivot.look(0, 0.2, true, -0.2, 0.05, 0, 0), 0.05, 1e-12, "looking down unwinds it; the rest is the arm's");
  assert.equal(pivot.turn, 0);
  // Never past 89° up together with the camera's own pitch.
  pivot.look(0, -0.2, true, -1.5, 0.05, 0, 0);
  close(pivot.turn, -1.5533430576324463 + 1.5, 1e-9);
  // Not allowed: the arm takes it all.
  const free = new CameraPivot();
  assert.equal(free.look(0, -0.1, false, -0.2, 0.05, 0, 0), -0.1);
  assert.equal(free.turn, 0);
  // A horizontal move over 0.05 rad does not start one.
  assert.equal(free.look(0.06, -0.1, true, -0.2, 0.05, 0, 0), -0.1);
});

test("a pivot no longer held glides home at 90°/s on the half cosine; one still held stays", () => {
  const pivot = new CameraPivot();
  pivot.look(0, -0.1, true, -0.2, 0.05, 0, 0);
  pivot.frame(0, true);
  pivot.frame(1000, true);
  close(pivot.turn, -0.1, 1e-12, "held");
  pivot.frame(1000, false);
  const seconds = 0.1 / (90 * DEG);
  close(pivot.frame(1000 + seconds * 500, false), -0.05, 1e-6, "half way");
  close(pivot.frame(1000 + seconds * 1000 + 1, false), 0, 1e-12);
});

test("the water nod: surfacing or diving glides the camera to 5° down; where the subject is", () => {
  assert.equal(cameraWaterState(0, undefined, 2), CAMERA_WATER_NONE);
  assert.equal(cameraWaterState(-1, 0, 2), CAMERA_WATER_SURFACE, "1 yard of water over a 2-yard body");
  assert.equal(cameraWaterState(-(2 - CAMERA_WATER_CLEARANCE), 0, 2), CAMERA_WATER_SURFACE, "exactly at the line");
  assert.equal(cameraWaterState(-1.8, 0, 2), CAMERA_WATER_SUBMERGED);
  assert.equal(cameraWaterNod(CAMERA_WATER_SUBMERGED, CAMERA_WATER_SURFACE, 5, 5), 5);
  assert.equal(cameraWaterNod(CAMERA_WATER_SURFACE, CAMERA_WATER_SUBMERGED, 5, 7), 7);
  assert.equal(cameraWaterNod(CAMERA_WATER_NONE, CAMERA_WATER_SURFACE, 5, 5), undefined, "wading in");
  assert.equal(cameraWaterNod(CAMERA_WATER_SURFACE, CAMERA_WATER_NONE, 5, 5), undefined);
  assert.equal(cameraWaterNod(CAMERA_WATER_SUBMERGED, CAMERA_WATER_SURFACE, 0, 5), undefined, "a pitch of 0 is none");
  assert.equal(cameraCVarDefinition("cameraSurfaceFinalPitch")?.defaultValue, "5.0");
});

test("from the shore, a lake behind the character stops the boom 0.2222 over it", () => {
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const rig = () => ({
    yaw: 0, pitch: 0.3, distance: CAMERA_DEFAULT_DISTANCE, view: CAMERA_DEFAULT_DISTANCE, viewPitch: 0.3,
    zoom: CAMERA_DEFAULT_DISTANCE, wallView: Number.POSITIVE_INFINITY, terrainView: Number.POSITIVE_INFINITY,
    pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT, eyeHeight: CAMERA_DEFAULT_EYE_HEIGHT,
  });
  // Looking up 0.3 rad swings the camera down behind; the lake (x < −3) has its surface at z = −0.5, the bank is dry.
  const world = { allowUpwardOrbit: true, waterAt: (x) => (x < -3 ? -0.5 : undefined) };
  const dry = rig();
  advanceCameraFrame(dry, player, CAMERA_DEFAULT_PIVOT_HEIGHT, { allowUpwardOrbit: true }, 1 / 60);
  const wet = rig();
  advanceCameraFrame(wet, player, CAMERA_DEFAULT_PIVOT_HEIGHT, world, 1 / 60);
  const camera = createCamera(player, wet.yaw, wet.viewPitch, wet.view, { pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT });
  assert.ok(wet.view < dry.view, `the arm is cut: ${wet.view} < ${dry.view}`);
  assert.ok(camera.position.z >= -0.5 + CAMERA_WATER_CLEARANCE - 0.05, `the camera at ${camera.position.z}`);
  assert.equal(wet.boomHit & CAMERA_BOOM_ARM_HIT, CAMERA_BOOM_ARM_HIT, "and the boom counts as held");
  assert.equal(dry.boomHit, 0);
  // The subject's own water (waterZ) keeps its own rule: the lake along the boom is not asked then.
  const swimmer = rig();
  advanceCameraFrame(swimmer, player, CAMERA_DEFAULT_PIVOT_HEIGHT, { ...world, waterZ: -5 }, 1 / 60);
  assert.equal(swimmer.view, dry.view);
});

test("the three stock switches are CVars of the settings model with Wow.exe's defaults; a same-value write writes nothing", () => {
  let values = defaultSettings();
  const writes = [];
  const cvars = createFrameXmlSettingsCVar({
    getSettings: () => values,
    setSetting: (id, value) => { writes.push([id, value]); values = { ...values, [id]: value }; },
  });
  assert.equal(cvars.getDefault("cameraTerrainTilt"), "0");
  assert.equal(cvars.getDefault("cameraBobbing"), "0");
  assert.equal(cvars.getDefault("cameraPivot"), "1");
  assert.equal(cvars.set("cameraTerrainTilt", "1"), true);
  assert.equal(cvars.set("cameraPivot", "1"), true, "already on");
  assert.equal(cvars.set("cameraWaterCollision", "1"), true, "already on");
  assert.equal(cvars.set("cameraYawSmoothSpeed", "180"), true, "already 180");
  assert.deepEqual(writes, [["cameraTerrainTilt", true]]);
  assert.equal(cvars.get("cameraTerrainTilt"), "1");
});
