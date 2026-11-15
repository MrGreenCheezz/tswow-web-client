import assert from "node:assert/strict";
import test from "node:test";
import { CollisionMesh, CollisionWorld } from "../dist/code/browser/game/Collision.js";
import { CAMERA_DEFAULT_EYE_HEIGHT } from "../dist/code/browser/SimpleScene.js";
import { CAMERA_CLIP_REARM, CAMERA_NEAR_SWEEP_SCALE, cameraClipEase, nearPlaneHalfHeight } from "../dist/code/browser/game/CameraClip.js";
import { advanceCameraFrame } from "../dist/code/browser/game/CameraRig.js";
import {
  CAMERA_WATER_CLEARANCE, cameraLiquidGated, cameraLiquidSurface, cameraWaterBand, cameraWaterReach,
} from "../dist/code/browser/game/CameraWater.js";
import { LIQUID_UNKNOWN } from "../dist/code/browser/game/Physics.js";

// 5.14 / 5.33 (15.11), Wow.exe 3.3.5a 12340 (notes .runtime/re-2026-11-11/camera/c2.c, re-2026-10-11/glue-1110/s533-1.txt):
// 0x006061d0 keeps the camera out of ±0.2222 about any liquid's surface after it is placed, with cameraWaterCollision off
// too; the boom swept with liquid solid stops at a building's water as at a lake's; and the ground is one more thing in
// the one sweep 0x00605d60 casts (mask 0x100171), in at once and let go over the walls' two seconds.

const FRAME = 1 / 60;
const HINGE = 1.5;
const near = (actual, expected, message, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${message}: ${actual} against ${expected}`);

/** A level camera five yards behind a character facing +x at the origin: it stands at (−5, 0, 1.5). */
function rig(overrides = {}) {
  return {
    yaw: 0, pitch: 0, distance: 5, view: 5, viewPitch: 0, zoom: 5,
    wallView: Number.POSITIVE_INFINITY, terrainView: Number.POSITIVE_INFINITY,
    pivotHeight: HINGE, eyeHeight: CAMERA_DEFAULT_EYE_HEIGHT,
    ...overrides,
  };
}
const player = { x: 0, y: 0, z: 0, orientation: 0 };
/** A pool behind the character, its surface at `surface`, answered for every point over or in it. */
const pool = (surface) => (x) => (x < -1 ? surface : undefined);

test("the band: a camera within 0.2222 of a surface goes to 0.2222 from it on its own side (0x006061d0)", () => {
  near(cameraWaterBand(1.5, 1.4), 1.4 + CAMERA_WATER_CLEARANCE, "0.1 over: up");
  near(cameraWaterBand(1.5, 1.6), 1.6 - CAMERA_WATER_CLEARANCE, "0.1 under: down");
  near(cameraWaterBand(1.5, 1.5), 1.5 - CAMERA_WATER_CLEARANCE, "on it: under, as `camera ≤ hit` takes it");
  assert.equal(cameraWaterBand(1.5, 1.2), 1.5, "0.3 over: out of reach of the segment");
  assert.equal(cameraWaterBand(1.5, undefined), 1.5, "no water");
  assert.equal(cameraWaterBand(1.5, Number.NaN), 1.5);
});

test("the camera's own frame keeps it out of the band, the view's direction kept (the hinge moves with it)", () => {
  const dry = rig();
  advanceCameraFrame(dry, player, HINGE, {}, FRAME);
  assert.equal(dry.viewPivotHeight, HINGE, "without water the hinge is the model's");
  const over = rig();
  advanceCameraFrame(over, player, HINGE, { liquidAt: pool(1.4) }, FRAME);
  near(over.viewPivotHeight, 1.4 + CAMERA_WATER_CLEARANCE, "0.1 over the surface: lifted to 0.2222 over it");
  assert.equal(over.view, 5, "the arm is kept");
  assert.equal(over.viewPitch, 0, "and the tilt");
  const under = rig();
  advanceCameraFrame(under, player, HINGE, { liquidAt: pool(1.6) }, FRAME);
  near(under.viewPivotHeight, 1.6 - CAMERA_WATER_CLEARANCE, "0.1 under: lowered to 0.2222 under it");
  const clear = rig();
  advanceCameraFrame(clear, player, HINGE, { liquidAt: pool(1.0) }, FRAME);
  assert.equal(clear.viewPivotHeight, HINGE, "half a yard off the surface: nothing to do");
  // cameraWaterCollision has no say in it: the band is kept with the CVar off (`waterCollision` false or absent).
  const off = rig();
  advanceCameraFrame(off, player, HINGE, { liquidAt: pool(1.4), waterCollision: false }, FRAME);
  near(off.viewPivotHeight, 1.4 + CAMERA_WATER_CLEARANCE, "with the CVar off");
});

test("a move the near plane cannot make is dropped, and the camera stands where the sweep stopped", () => {
  // A ceiling behind the character just over the near plane's quad at the camera's own height, under it once lifted.
  const top = HINGE + nearPlaneHalfHeight() * CAMERA_NEAR_SWEEP_SCALE;
  const lid = top + 0.06;
  const world = new CollisionWorld();
  world.set(1, new CollisionMesh(Float32Array.of(-1, -20, lid, -30, -20, lid, -30, 20, lid, -1, -20, lid, -30, 20, lid, -1, 20, lid)));
  const free = rig();
  advanceCameraFrame(free, player, HINGE, { collision: world }, FRAME);
  assert.equal(free.view, 5, "the lid is out of the unmoved quad's way");
  const lifted = rig();
  advanceCameraFrame(lifted, player, HINGE, { collision: world, liquidAt: pool(1.4) }, FRAME);
  assert.equal(lifted.viewPivotHeight, HINGE, "the lift is dropped");
  assert.ok(lifted.view < 5 && lifted.view > 0.5, `and the camera comes in on its own boom: ${lifted.view}`);
});

test("water along the boom stops it 0.2222 short, asked with each point's height (a building's pool too)", () => {
  // Head 2 yards up, the boom falling to (−10, 0, −3); a pool over x < −4 with its surface at 0.
  const head = { x: 0, y: 0, z: 2 };
  const tail = { x: -10, y: 0, z: -3 };
  const reach = cameraWaterReach(head, tail, (x) => (x < -4 ? 0 : undefined));
  near(reach, 0.4, "stopped at the pool's edge, where the boom is already within 0.2222 of it", 0.01);
  const lake = cameraWaterReach(head, tail, () => 0);
  near(lake, (2 - CAMERA_WATER_CLEARANCE) / 5, "open water: 0.2222 over the surface", 0.01);
  // A room's pool answers only for points in the room (the z the question carries): the boom passing over its roof
  // is not stopped.
  const roofed = cameraWaterReach(head, { x: -10, y: 0, z: 2 }, (x, y, z) => (z < 1 ? 0 : undefined));
  assert.equal(roofed, 1);
  assert.equal(cameraWaterReach(head, tail, () => 2.1), 1, "a hinge already in the band is the wet column's rule");
  assert.equal(cameraWaterReach(head, tail, () => undefined), 1);
});

test("through the frame: the boom stops at water away from the character under cameraWaterCollision only", () => {
  // Looking up from over a lake (a flier: no floor at the feet), the camera swings down behind the character.
  const looking = { pitch: 0.4, viewPitch: 0.4 };
  const wet = rig(looking);
  advanceCameraFrame(wet, player, HINGE, { allowUpwardOrbit: true, liquidAt: () => 0, waterCollision: true }, FRAME);
  assert.ok(wet.view < 4, `the boom is stopped over the water: ${wet.view}`);
  const off = rig(looking);
  advanceCameraFrame(off, player, HINGE, { allowUpwardOrbit: true, liquidAt: () => 0, waterCollision: false }, FRAME);
  assert.equal(off.view, 5, "with the CVar off the boom goes under");
});

test("the map's surface is the physics' answer, an unanswered tile none (cameraLiquidSurface)", () => {
  const probe = (answer) => ({ liquid: () => answer });
  assert.equal(cameraLiquidSurface(probe({ height: 3, type: 1 }), 0, 0, 0), 3);
  assert.equal(cameraLiquidSurface(probe(undefined), 0, 0, 0), undefined);
  assert.equal(cameraLiquidSurface(probe(LIQUID_UNKNOWN), 0, 0, 0), undefined);
  assert.equal(cameraLiquidSurface(undefined, 0, 0, 0), undefined);
});

test("the gate asks the probe only where a surface could be within the camera's reach (cameraLiquidGated)", () => {
  let asked = 0;
  const probe = { liquid: () => { asked++; return { height: 5, type: 1 }; } };
  const terrain = (liquid, ground = 0) => ({ heightAt: () => ground, liquidAt: () => liquid });
  const building = (over) => ({ liquidGroupOver: () => over });
  assert.equal(cameraLiquidGated(probe, terrain(undefined), building(false), 0, 0, 0, 5), undefined, "no water of either kind");
  assert.equal(asked, 0, "and no floor walk");
  assert.equal(cameraLiquidGated(probe, terrain({ height: 5 }), building(false), 0, 0, 0, 5), 5, "the map's");
  assert.equal(cameraLiquidGated(probe, terrain(undefined), building(true), 0, 0, 0, 5), 5, "a building's");
  assert.equal(asked, 2);
  assert.equal(cameraLiquidGated(probe, terrain({ height: 4 }), building(false), 0, 0, 0, 5), undefined,
    "a map surface a yard under the point is of no interest to the band or the boom");
  assert.equal(cameraLiquidGated(probe, terrain({ height: 5 }, 10), building(false), 0, 0, 0, 12), undefined,
    "map water under the ground is never the probe's");
  assert.equal(cameraLiquidGated(probe, undefined, undefined, 0, 0, 0, 5), undefined);
  assert.equal(asked, 2);
});

test("5.33: the ground takes the camera at once and lets it go over the walls' two seconds (one sweep in Wow.exe)", () => {
  const camera = rig();
  // Ground three yards high behind x = −2: the level boom meets it two yards out.
  let ground = (x) => (x < -2 ? 3 : 0);
  const world = { heightAt: (x) => ground(x) };
  advanceCameraFrame(camera, player, HINGE, world, FRAME);
  assert.ok(camera.view < 2.1, `in on the first frame: ${camera.view} (it was eased in over 0.18 s)`);
  assert.equal(camera.terrainView, Number.POSITIVE_INFINITY, "the ground's own ease is not used");
  const from = camera.wallFrom;
  assert.ok(from !== undefined, "the walls' ease restarted");
  near(from - camera.view, CAMERA_CLIP_REARM, "from 0.1111 past the hold", 0.02);
  ground = () => 0;
  let seconds = 0;
  for (let frame = 0; frame < 60; frame++) {
    advanceCameraFrame(camera, player, HINGE, world, FRAME);
    seconds += FRAME;
  }
  near(camera.view, cameraClipEase(from, 5, seconds), "a second later it is halfway out on the half cosine", 1e-6);
  for (let frame = 0; frame < 61; frame++) advanceCameraFrame(camera, player, HINGE, world, FRAME);
  assert.equal(camera.view, 5, "out after two seconds");
  assert.equal(camera.wallView, Number.POSITIVE_INFINITY);
});
