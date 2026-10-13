import assert from "node:assert/strict";
import test from "node:test";
import { CAMERA_LOOK_SENSITIVITY, cameraLookPerPixel } from "../dist/code/browser/game/CameraRig.js";
import { CameraViews } from "../dist/code/browser/game/CameraViews.js";
import {
  CAMERA_FOLLOW_IDLE, CAMERA_FOLLOW_MOVE, CAMERA_FOLLOW_STOP, CAMERA_FOLLOW_STRAFE, CAMERA_FOLLOW_TURN,
  CAMERA_INPUT_AUTORUN, CAMERA_INPUT_CAMERA_OR_SELECT, CAMERA_INPUT_FORWARD, CAMERA_INPUT_STRAFE_LEFT,
  CAMERA_INPUT_TURN_LEFT, CAMERA_INPUT_TURN_OR_ACTION, CameraFollow, cameraFollowStates, cameraInputIdle,
} from "../dist/code/browser/game/CameraFollow.js";

/*
 * 3.11 (13.10): the camera's way back behind the character as Wow.exe 3.3.5a 12340 does it — 0x00602760, run by
 * 0x005fa170/0x005fa450 on the input word's edges, gliding with the camera's own slots (0x00601190 pitch, 0x00601410
 * yaw, 0x00603d30) — with the CVars of 0x005fd910 (cameraSmooth<style><state>Delay|Factor, cameraSmoothViewData…,
 * cameraPitchSmoothMin/Max 0°/30°, cameraYawSmoothMin/Max 0/0, cameraSmoothTimeMin/Max 0.1/2). Notes:
 * .runtime/re-2026-10-11/glue-1110/cv311-a…f.txt. Was (5.14) a pull every frame read from the option tooltips.
 */

const DEG = Math.PI / 180;
const WORLD = {};
const FORWARD = CAMERA_INPUT_FORWARD;
const RIGHT = CAMERA_INPUT_TURN_OR_ACTION;
const LEFT = CAMERA_INPUT_CAMERA_OR_SELECT;
const near = (actual, expected, message, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${message}: ${actual} against ${expected}`);
const halfCosine = (t) => 0.5 * (1 - Math.cos(Math.PI * t));

/** A character on foot, 10° looking down (view 2's), the camera `yaw` degrees aside. */
function setup(yaw = 90, pitch = -10) {
  const views = new CameraViews(null);
  const rig = { yaw: yaw * DEG, pitch: pitch * DEG, distance: 5.55 };
  views.frame(rig, 0, WORLD, undefined);
  return { views, rig, follow: new CameraFollow() };
}
const host = (style = 4, movementFlags = 0, typeId = 4) => ({ style, yawSpeed: 180, pitchSpeed: 45, subject: { typeId, movementFlags } });
const input = (s, word, now, h = host(), release = undefined) => s.follow.input(word, release, s.rig, now, s.views, h);
const frame = (s, now) => s.views.frame(s.rig, now, WORLD, undefined);

test("the state is the highest of Turn, Strafe, Move, Stop and Idle (0x00602760; 0x005f9850 is idle)", () => {
  assert.equal(cameraFollowStates(0, false), CAMERA_FOLLOW_IDLE);
  assert.equal(cameraFollowStates(FORWARD, false), CAMERA_FOLLOW_MOVE);
  assert.equal(cameraFollowStates(CAMERA_INPUT_AUTORUN, false), CAMERA_FOLLOW_MOVE, "autorun runs");
  assert.equal(cameraFollowStates(FORWARD | CAMERA_INPUT_STRAFE_LEFT, false), CAMERA_FOLLOW_MOVE | CAMERA_FOLLOW_STRAFE);
  assert.equal(cameraFollowStates(CAMERA_INPUT_TURN_LEFT, false), CAMERA_FOLLOW_TURN);
  assert.equal(cameraFollowStates(RIGHT, false), CAMERA_FOLLOW_TURN | CAMERA_FOLLOW_IDLE, "the right button is a turn, and idle");
  assert.equal(cameraFollowStates(RIGHT | LEFT, false), CAMERA_FOLLOW_TURN | CAMERA_FOLLOW_MOVE | CAMERA_FOLLOW_IDLE,
    "both buttons run (0x005f9850 does not count them)");
  assert.equal(cameraFollowStates(RIGHT | CAMERA_INPUT_TURN_LEFT, false), CAMERA_FOLLOW_TURN | CAMERA_FOLLOW_STRAFE);
  assert.equal(cameraFollowStates(0, true), CAMERA_FOLLOW_IDLE | CAMERA_FOLLOW_STOP);
  assert.equal(cameraInputIdle(CAMERA_INPUT_TURN_LEFT), false);
  assert.equal(cameraInputIdle(RIGHT | LEFT), true);
});

test("Smarter: starting to run glides the yaw home over |Δ| / cameraYawSmoothSpeed, held to 0.1–2 s, on the half cosine", () => {
  const s = setup(90);
  input(s, FORWARD, 1000);
  assert.equal(s.views.gliding, true);
  near(s.views.glideSeconds, 0.5, "90° at 180°/s");
  frame(s, 1000);
  near(s.rig.yaw, 90 * DEG, "nothing moves at t = 0");
  frame(s, 1250);
  near(s.rig.yaw, 90 * DEG * (1 - halfCosine(0.5)), "half way in time, half way on the cosine");
  frame(s, 1500);
  assert.equal(s.rig.yaw, 0, "home behind the character");
  assert.equal(s.views.gliding, false);
  const small = setup(5);
  input(small, FORWARD, 0);
  near(small.views.glideSeconds, 0.1, "5° would be 0.028 s: cameraSmoothTimeMin");
  const far = setup(-179);
  input(far, FORWARD, 0);
  near(far.views.glideSeconds, 179 / 180, "the short way round, 179°");
});

test("the pitch inside cameraPitchSmoothMin…Max (0°–30° down) is left alone; outside it goes to the nearer bound", () => {
  const level = setup(0, -23.75);
  input(level, FORWARD, 0);
  assert.equal(level.views.gliding, false, "this client's 23.75° down is inside the band");
  const steep = setup(0, -40);
  input(steep, FORWARD, 0);
  near(steep.views.glideSeconds, 10 / 45, "10° at cameraPitchSmoothSpeed 45°/s");
  frame(steep, 1000);
  near(steep.rig.pitch, -30 * DEG, "to the band's 30°");
  const low = setup(0, 10);
  input(low, FORWARD, 0);
  frame(low, 1000);
  near(low.rig.pitch, 0, "looking up from below: to level");
  const both = setup(90, -40);
  input(both, FORWARD, 0);
  near(both.views.glideSeconds, 0.5, "the axes share the longest time");
  frame(both, 250);
  near(both.rig.pitch, (-40 + 10 * halfCosine(0.5)) * DEG, "the pitch on the shared time");
});

test("letting go stops the glide in hand (Smarter's Stop factor is 0); Always's Stop goes on", () => {
  const s = setup(90);
  input(s, FORWARD, 1000);
  frame(s, 1250);
  const halfway = s.rig.yaw;
  input(s, 0, 1250);
  frame(s, 1500);
  frame(s, 3000);
  assert.equal(s.rig.yaw, halfway, "the camera stays where the stop found it");
  const always = setup(90);
  input(always, FORWARD, 1000, host(2));
  frame(always, 1250);
  input(always, 0, 1250, host(2));
  frame(always, 1500);
  assert.equal(always.rig.yaw, 0, "the same glide is kept (target, delay and factor alike) and lands");
});

test("Never moves nothing; Smart moves only the yaw (its pitch factor is 0)", () => {
  const never = setup(90, -40);
  input(never, FORWARD, 0, host(0));
  assert.equal(never.views.gliding, false);
  const smart = setup(90, -40);
  input(smart, FORWARD, 0, host(1));
  frame(smart, 2000);
  assert.equal(smart.rig.yaw, 0);
  near(smart.rig.pitch, -40 * DEG, "the pitch stays");
  const unknown = setup(90);
  input(unknown, FORWARD, 0, host(7));
  assert.equal(unknown.views.gliding, false, "a style out of 0–4 has no row");
});

test("only an edge starts it: standing still nothing moves, a turn key is an edge, the same word again is none", () => {
  const s = setup(90);
  input(s, 0, 0);
  frame(s, 2000);
  near(s.rig.yaw, 90 * DEG, "nothing pressed");
  assert.equal(s.follow.pending(0, undefined), false);
  input(s, CAMERA_INPUT_TURN_LEFT, 2000);
  frame(s, 4000);
  assert.equal(s.rig.yaw, 0, "Turn's factor is 1");
  // A second edge asking for the same glide keeps it: the strafe at 1100 does not restart the clock.
  const kept = setup(90);
  input(kept, FORWARD, 1000);
  frame(kept, 1100);
  input(kept, FORWARD | CAMERA_INPUT_STRAFE_LEFT, 1100);
  frame(kept, 1500);
  assert.equal(kept.rig.yaw, 0, "landed on the first glide's time");
});

test("swimming or flying (0x200000, 0x2000000) leaves the pitch, the yaw still comes home; no unit, no follow", () => {
  for (const flags of [0x200000, 0x2000000]) {
    const s = setup(90, -40);
    input(s, FORWARD, 0, host(4, flags));
    frame(s, 2000);
    assert.equal(s.rig.yaw, 0);
    near(s.rig.pitch, -40 * DEG, `flags ${flags.toString(16)}`);
  }
  const eye = setup(90);
  input(eye, FORWARD, 0, host(4, 0, 6));
  assert.equal(eye.views.gliding, false, "a far sight's DynamicObject is not a unit");
  const out = setup(90);
  out.follow.input(FORWARD, undefined, out.rig, 0, out.views, undefined);
  assert.equal(out.views.gliding, false, "no host: the edge is taken, nothing glides");
  assert.equal(out.follow.word, FORWARD);
});

test("a mouse command holds the camera: the press stops the glides, none starts under it, the release starts the follow", () => {
  const s = setup(90);
  input(s, FORWARD, 1000);
  frame(s, 1250);
  const held = s.rig.yaw;
  input(s, FORWARD | RIGHT, 1250);
  assert.equal(s.views.freelooking, true);
  frame(s, 2000);
  assert.equal(s.rig.yaw, held, "the press stopped the yaw (0x00601ff0)");
  s.rig.pitch = -40 * DEG;
  input(s, FORWARD | RIGHT | CAMERA_INPUT_STRAFE_LEFT, 2000);
  frame(s, 3000);
  assert.equal(s.rig.yaw, held, "no glide starts while the button is down");
  assert.equal(s.rig.pitch, -40 * DEG, "the pitch's neither (0x005ffeb0 asks for no freelook)");
  input(s, FORWARD, 3000, host(), false);
  assert.equal(s.views.freelooking, false);
  frame(s, 6000);
  assert.equal(s.rig.yaw, 0, "the release, still running, brings it home");
  // A press and its release inside one frame are both (the release latch).
  const pulse = setup(90);
  input(pulse, FORWARD, 1000);
  frame(pulse, 1100);
  input(pulse, FORWARD, 1100, host(), false);
  assert.equal(pulse.views.freelooking, false);
  frame(pulse, 1500);
  assert.ok(pulse.rig.yaw > 0, `a fresh glide from where the click found it, not the first one's end: ${pulse.rig.yaw}`);
  frame(pulse, 4000);
  assert.equal(pulse.rig.yaw, 0);
  const stickyPulse = setup(90);
  input(stickyPulse, 0, 0);
  input(stickyPulse, 0, 0, host(), true);
  input(stickyPulse, FORWARD, 0);
  assert.equal(stickyPulse.views.gliding, false, "a sticky click inside one frame is sticky all the same");
});

test("a view switched under the button glides its distance and pitch; its yaw never happens (0x00603d30, 0x00604850)", () => {
  const s = setup(60, -10);
  input(s, RIGHT, 0);
  s.views.setView(4, s.rig, 0, { yawSpeed: 180, pitchSpeed: 45, ceiling: 50 });
  frame(s, 5000);
  near(s.rig.distance, 13.88, "the distance arrived");
  near(s.rig.pitch, -30 * DEG, "the pitch arrived");
  near(s.rig.yaw, 60 * DEG, "the yaw stayed under the button");
  input(s, 0, 5000, host(), false);
  frame(s, 9000);
  near(s.rig.yaw, 60 * DEG, "and the release dropped it (standing still: Smarter's Idle stops, nothing new)");
});

test("a sticky release (CameraOrSelectOrMoveStop(true)) keeps the follow off until a release without it", () => {
  const s = setup(90);
  input(s, FORWARD | LEFT, 0);
  input(s, FORWARD, 0, host(), true);
  input(s, FORWARD | CAMERA_INPUT_STRAFE_LEFT, 0);
  frame(s, 3000);
  near(s.rig.yaw, 90 * DEG, "sticky: no follow");
  input(s, FORWARD | CAMERA_INPUT_STRAFE_LEFT | LEFT, 3000);
  input(s, FORWARD | CAMERA_INPUT_STRAFE_LEFT, 3000, host(), false);
  frame(s, 6000);
  assert.equal(s.rig.yaw, 0, "a plain release lets it come home");
});

test("a view saved off its defaults has no follow unless cameraCustomViewSmoothing (0x005fff40, 0x005ff8e0)", () => {
  const s = setup(90);
  s.views.saveView(2, { yaw: 0, pitch: -15 * DEG, distance: 8 });
  input(s, FORWARD, 0);
  assert.equal(s.views.gliding, false);
  assert.equal(s.views.setCVar("cameraCustomViewSmoothing", "1"), true);
  input(s, 0, 0);
  input(s, FORWARD, 0);
  frame(s, 2000);
  assert.equal(s.rig.yaw, 0);
});

test("the tables are CVars: a Move delay waits before the glide starts", () => {
  const s = setup(90);
  assert.equal(s.views.cvar("cameraSmoothSmarterMoveDelay"), "0.0");
  assert.equal(s.views.cvar("camerasmoothsmartermovefactor"), "1.0", "names are case-blind");
  assert.equal(s.views.setCVar("cameraSmoothSmarterMoveDelay", 0.5), true);
  input(s, FORWARD, 1000);
  frame(s, 1400);
  near(s.rig.yaw, 90 * DEG, "still waiting");
  frame(s, 1750);
  near(s.rig.yaw, 90 * DEG * (1 - halfCosine(0.5)), "the glide runs from now + delay");
  assert.equal(s.views.setCVar("cameraPitchSmoothMax", "95"), false, "past ±89° the validator refuses (0x005fd6d0)");
  assert.equal(s.views.cvar("cameraPitchSmoothMax"), "30.0");
});

test("the mouse look is 0.2° a pixel at the defaults and scales with mouseSpeed and cameraYawMoveSpeed", () => {
  assert.equal(cameraLookPerPixel(100, 180), CAMERA_LOOK_SENSITIVITY);
  assert.ok(Math.abs(cameraLookPerPixel(50, 180) - CAMERA_LOOK_SENSITIVITY / 2) < 1e-15);
  assert.ok(Math.abs(cameraLookPerPixel(100, 270) - CAMERA_LOOK_SENSITIVITY * 1.5) < 1e-15);
  assert.ok(Math.abs(cameraLookPerPixel(150, 90) - CAMERA_LOOK_SENSITIVITY * 0.75) < 1e-15);
  assert.equal(cameraLookPerPixel(Number.NaN, 0), CAMERA_LOOK_SENSITIVITY, "a broken blob is the default");
});
