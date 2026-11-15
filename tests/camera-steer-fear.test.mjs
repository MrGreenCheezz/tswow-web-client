import assert from "node:assert/strict";
import test from "node:test";
import { CameraViews } from "../dist/code/browser/game/CameraViews.js";
import { CameraFollow } from "../dist/code/browser/game/CameraFollow.js";
import { cameraSteerPitch } from "../dist/code/browser/game/CameraSteerPitch.js";
import { CAMERA_WATER_NONE, CAMERA_WATER_SUBMERGED, CAMERA_WATER_SURFACE } from "../dist/code/browser/game/CameraWater.js";

// 5.14 / 3.11 (15.11), Wow.exe 3.3.5a 12340: the right-button steer's pitch (0x006023d0; notes
// .runtime/re-2026-10-03/l1102gf3/r1.c, CVars .runtime/re-2026-11-15/camera5/k1.c) and the yaw held in the world while the
// camera's subject is on a server spline (0x00602eb0, 0x006019b0/0x00601a70, 0x005fe5f0, 0x00602680, 0x00602760).

const DEG = Math.PI / 180;
const WORLD = {};
const near = (actual, expected, message, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${message}: ${actual} against ${expected}`);
const water = (state, overrides = {}) => ({ state, dive: true, surfacePitch: 0, submergePitch: 18, drunk: false, ...overrides });

test("the steer pitches the mover as the view looks: the camera's pitch with the smart pivot's turn, within ±89°", () => {
  near(cameraSteerPitch(0.3, 0), 0.3, "the camera's own");
  near(cameraSteerPitch(0.1, -0.2), 0.3, "a pivot turned 0.2 further up steers 0.2 further up");
  near(cameraSteerPitch(-0.1, 0.25), -0.35, "and down");
  near(cameraSteerPitch(2, 0), 1.5533430576324463, "held to 89°");
  assert.equal(cameraSteerPitch(Number.NaN, 0), 0);
  near(cameraSteerPitch(0.3, 0, water(CAMERA_WATER_NONE)), 0.3, "out of the water nothing more");
});

test("at the surface, looking down less than cameraSubmergePitch (18°) keeps the swimmer level", () => {
  assert.equal(cameraSteerPitch(-10 * DEG, 0, water(CAMERA_WATER_SURFACE)), 0, "10° down: level");
  near(cameraSteerPitch(-20 * DEG, 0, water(CAMERA_WATER_SURFACE)), -20 * DEG, "20° down: dives");
  near(cameraSteerPitch(10 * DEG, 0, water(CAMERA_WATER_SURFACE)), 10 * DEG, "looking up is left alone");
  near(cameraSteerPitch(-10 * DEG, 0, water(CAMERA_WATER_SURFACE, { dive: false })), -10 * DEG, "cameraDive off");
  near(cameraSteerPitch(-10 * DEG, 0, water(CAMERA_WATER_SURFACE, { drunk: true })), -10 * DEG, "a drunk player dives");
  // The pivot's turn counts toward the 18°: a camera 10° down with the view turned 10° more is 20° down.
  near(cameraSteerPitch(-10 * DEG, 10 * DEG, water(CAMERA_WATER_SURFACE)), -20 * DEG, "the view, not the arm");
});

test("under water cameraSurfacePitch flattens looking up only when it is negative (\"0.0\" by default: inert)", () => {
  near(cameraSteerPitch(10 * DEG, 0, water(CAMERA_WATER_SUBMERGED)), 10 * DEG, "default: rises");
  assert.equal(cameraSteerPitch(10 * DEG, 0, water(CAMERA_WATER_SUBMERGED, { surfacePitch: -15 })), 0, "within 15° up: level");
  near(cameraSteerPitch(20 * DEG, 0, water(CAMERA_WATER_SUBMERGED, { surfacePitch: -15 })), 20 * DEG, "past it: rises");
  near(cameraSteerPitch(-10 * DEG, 0, water(CAMERA_WATER_SUBMERGED)), -10 * DEG, "the 18° is the surface's alone");
});

/** A unit facing `facing`, the camera behind it (view 2: yaw 0). */
function setup() {
  const views = new CameraViews(null);
  const rig = { yaw: 0, pitch: -10 * DEG, distance: 5.55 };
  views.frame(rig, 0, WORLD, undefined);
  return { views, rig, follow: new CameraFollow() };
}
/** cameraSmoothStyle 2 (Always): its Fear row is delay 0, factor 1 — Smarter's (the tracking style's default) 0.4 and 10. */
const host = { style: 2, yawSpeed: 180, pitchSpeed: 45, subject: { typeId: 4, movementFlags: 0 } };

test("on a server spline the camera's yaw stays in the world as the unit turns, then glides behind it (Fear)", () => {
  const s = setup();
  s.follow.spline(true, 0, s.rig, 0, s.views, host);
  assert.equal(s.follow.held, true);
  assert.equal(s.views.gliding, false, "behind the unit: nothing to do");
  // The fear turns the unit a quarter turn left: the camera does not swing with it.
  s.follow.spline(true, 90 * DEG, s.rig, 100, s.views, host);
  near(s.rig.yaw + 90 * DEG, 0, "the camera's world yaw is where it was");
  assert.equal(s.views.gliding, true, "and a glide back behind the unit is under way");
  // cameraSmoothTrackingStyle (default 4, Smarter) and not cameraSmoothStyle: the Fear row's 0.4 s delay, factor 10 —
  // a quarter turn at 180°/s × 10 = 5 s, held to cameraSmoothTimeMax 2 s.
  near(s.views.glideSeconds, 2, "the tracking style's factor");
  s.views.frame(s.rig, 450, WORLD, undefined);
  near(s.rig.yaw, -90 * DEG, "still in the delay");
  s.follow.spline(true, 90 * DEG, s.rig, 1500, s.views, host);
  s.views.frame(s.rig, 1500, WORLD, undefined);
  const t = (1500 - 500) / 2000;
  near(s.rig.yaw, -90 * DEG + 90 * DEG * 0.5 * (1 - Math.cos(Math.PI * t)), "half way along the half cosine", 1e-6);
  // A further turn mid-glide turns the glide with it: the world yaw is kept on that frame, too.
  const before = s.rig.yaw + 90 * DEG;
  s.follow.spline(true, 120 * DEG, s.rig, 1500, s.views, host);
  near(s.rig.yaw + 120 * DEG, before, "held through the second turn");
  // The spline over: the yaw is the facing's again; the unit turning now turns the camera with it.
  s.follow.spline(false, 120 * DEG, s.rig, 1600, s.views, host);
  assert.equal(s.follow.held, false);
  const kept = s.rig.yaw;
  s.follow.spline(false, 150 * DEG, s.rig, 1700, s.views, host);
  assert.equal(s.rig.yaw, kept, "from the facing once more");
});

test("without a host (a view that is not the player's) the yaw is still held but nothing glides", () => {
  const s = setup();
  s.follow.spline(true, 0, s.rig, 0, s.views, undefined);
  s.follow.spline(true, 45 * DEG, s.rig, 100, s.views, undefined);
  near(s.rig.yaw, -45 * DEG, "held");
  assert.equal(s.views.gliding, false);
});
