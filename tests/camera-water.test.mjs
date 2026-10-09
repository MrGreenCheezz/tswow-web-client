import assert from "node:assert/strict";
import test from "node:test";
import { CAMERA_DEFAULT_DISTANCE, CAMERA_DEFAULT_EYE_HEIGHT, CAMERA_DEFAULT_PITCH, CAMERA_DEFAULT_PIVOT_HEIGHT, createCamera } from "../dist/code/browser/SimpleScene.js";
import { advanceCameraFrame } from "../dist/code/browser/game/CameraRig.js";
import { CAMERA_WATER_CLEARANCE, cameraWaterArm, cameraWaterFloor, cameraWaterSurface } from "../dist/code/browser/game/CameraWater.js";
import { LIQUID_RECALL_YARDS } from "../dist/code/browser/game/Physics.js";
import { createFrameXmlSettingsCVar } from "../dist/code/browser/framexml/FrameXmlSettingsCVar.js";
import { FRAMEXML_OPTIONS_UNAVAILABLE } from "../dist/code/browser/framexml/FrameXmlOptions.js";
import { defaultSettings } from "../dist/code/browser/ui/SettingsModel.js";

// Lane L8 (WORK_PLAN 5.14 step D, 04.10): the stock cameraWaterCollision. Wow.exe 3.3.5a 12340 registers it at
// 0x005fe029 with "1" (global 0x00c249b4); 0x005fec50 adds liquid (0x20000) to the camera's collision mask, so its
// boom stops at the surface — above it while the subject is at the surface, under it while it dives (0x006049c0,
// 0x00605d60, clearance 0.2222 at 0x00a1ea24).

const FRAME = 1 / 60;

function rig(overrides = {}) {
  return {
    yaw: 0, pitch: CAMERA_DEFAULT_PITCH, distance: CAMERA_DEFAULT_DISTANCE, view: CAMERA_DEFAULT_DISTANCE,
    viewPitch: CAMERA_DEFAULT_PITCH, zoom: CAMERA_DEFAULT_DISTANCE,
    wallView: Number.POSITIVE_INFINITY, terrainView: Number.POSITIVE_INFINITY,
    pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT, eyeHeight: CAMERA_DEFAULT_EYE_HEIGHT,
    ...overrides,
  };
}

function cameraZ(state, player) {
  return createCamera(player, state.yaw, state.viewPitch, state.view, { pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT }).position.z;
}

test("over the water the surface is a floor 0.2222 up; under it the boom is cut 0.2222 short of it", () => {
  assert.equal(CAMERA_WATER_CLEARANCE, 0.2222222238779068);
  assert.equal(cameraWaterFloor(2, 0), CAMERA_WATER_CLEARANCE);
  assert.equal(cameraWaterFloor(0, 0), CAMERA_WATER_CLEARANCE, "a hinge on the surface is over it");
  assert.equal(cameraWaterFloor(-1, 0), Number.NEGATIVE_INFINITY, "a hinge under it has no water floor");
  assert.equal(cameraWaterFloor(2, undefined), Number.NEGATIVE_INFINITY);
  assert.equal(cameraWaterFloor(Number.NaN, 0), Number.NEGATIVE_INFINITY);
  // Under it, looking down (the camera swings up): stopped 0.2222 under the surface.
  assert.ok(Math.abs(cameraWaterArm(-3, -0.4, 0) - (3 - CAMERA_WATER_CLEARANCE) / Math.sin(0.4)) < 1e-12);
  assert.equal(cameraWaterArm(-3, 0.4, 0), Number.POSITIVE_INFINITY, "looking up under water: heads away");
  assert.equal(cameraWaterArm(-3, 0, 0), Number.POSITIVE_INFINITY);
  assert.equal(cameraWaterArm(-0.1, -0.5, 0), 0, "a hinge within the clearance has no room at all");
  assert.equal(cameraWaterArm(2, -0.5, 0), Number.POSITIVE_INFINITY, "over the water the floor answers, not the arm");
  assert.equal(cameraWaterArm(-3, -0.4, undefined), Number.POSITIVE_INFINITY);
  assert.equal(cameraWaterArm(-3, Number.NaN, 0), Number.POSITIVE_INFINITY);
});

test("a swimmer at the surface looking up keeps the camera over the water; without it the camera goes under", () => {
  // The hinge 0.6 yard over the surface at z = 0; the feet's floor is far below it.
  const player = { x: 0, y: 0, z: 0.6 - CAMERA_DEFAULT_PIVOT_HEIGHT, orientation: 0 };
  const dry = rig({ pitch: 0.5 });
  advanceCameraFrame(dry, player, CAMERA_DEFAULT_PIVOT_HEIGHT, {}, FRAME);
  assert.ok(cameraZ(dry, player) < 0, `without the water the camera is under it at ${cameraZ(dry, player)}`);

  const wet = rig({ pitch: 0.5 });
  advanceCameraFrame(wet, player, CAMERA_DEFAULT_PIVOT_HEIGHT, { waterZ: 0 }, FRAME);
  const z = cameraZ(wet, player);
  assert.ok(z >= CAMERA_WATER_CLEARANCE - 1e-9, `the camera stands at ${z}`);
  assert.ok(wet.viewPitch < dry.viewPitch, "the tilt gives way, as for every floor of this rig");
  assert.equal(wet.view, dry.view, "and the arm is kept");
  assert.equal(wet.distance, CAMERA_DEFAULT_DISTANCE, "the wheel's number is untouched");
  assert.equal(wet.pitch, 0.5, "and the drag's");
  // A flier over a lake is held over it too, though the feet's floor is not; and the boom is scanned at the tilt
  // the water leaves it, so the lake bed under the surface does not shorten it.
  const flier = rig({ pitch: 1.2 });
  const high = { x: 0, y: 0, z: 30, orientation: 0 };
  const bed = () => -2;
  advanceCameraFrame(flier, high, CAMERA_DEFAULT_PIVOT_HEIGHT, { allowUpwardOrbit: true, waterZ: 0, heightAt: bed }, FRAME);
  assert.ok(cameraZ(flier, high) >= CAMERA_WATER_CLEARANCE - 1e-9, `the flier's camera at ${cameraZ(flier, high)}`);
  const skimmer = rig({ pitch: 0.5 });
  advanceCameraFrame(skimmer, player, CAMERA_DEFAULT_PIVOT_HEIGHT, { allowUpwardOrbit: true, waterZ: 0, heightAt: bed }, FRAME);
  assert.equal(skimmer.view, CAMERA_DEFAULT_DISTANCE, "the bed under the water is not in the boom");
  assert.ok(cameraZ(skimmer, player) >= CAMERA_WATER_CLEARANCE - 1e-9);
  // The default look (down at the character) is not in the water's way.
  const looking = rig();
  advanceCameraFrame(looking, player, CAMERA_DEFAULT_PIVOT_HEIGHT, { waterZ: 0 }, FRAME);
  assert.equal(looking.view, CAMERA_DEFAULT_DISTANCE);
});

test("a diver keeps the camera under the surface; nothing changes where there is no water", () => {
  const player = { x: 0, y: 0, z: -3 - CAMERA_DEFAULT_PIVOT_HEIGHT, orientation: 0 };
  const dry = rig();
  advanceCameraFrame(dry, player, CAMERA_DEFAULT_PIVOT_HEIGHT, {}, FRAME);
  assert.ok(cameraZ(dry, player) > 0, "the default boom rises out of the water");
  const wet = rig();
  advanceCameraFrame(wet, player, CAMERA_DEFAULT_PIVOT_HEIGHT, { waterZ: 0 }, FRAME);
  assert.ok(cameraZ(wet, player) <= -CAMERA_WATER_CLEARANCE + 1e-9, `the camera stands at ${cameraZ(wet, player)}`);
  // The water's limit is a wall's: it comes back out on the recovery easing once the diver surfaces.
  const same = rig();
  advanceCameraFrame(same, player, CAMERA_DEFAULT_PIVOT_HEIGHT, { waterZ: undefined }, FRAME);
  assert.deepEqual(same, dry);
});

test("the surface is the feet's own answer, for this column only", () => {
  const liquid = { x: 10, y: 10, surface: { height: 4, type: 1 } };
  assert.equal(cameraWaterSurface(liquid, 10, 10), 4);
  assert.equal(cameraWaterSurface(liquid, 10 + LIQUID_RECALL_YARDS * 0.9, 10), 4);
  assert.equal(cameraWaterSurface(liquid, 10 + LIQUID_RECALL_YARDS * 1.1, 10), undefined);
  assert.equal(cameraWaterSurface({ x: 10, y: 10, surface: undefined }, 10, 10), undefined, "dry");
  assert.equal(cameraWaterSurface(undefined, 10, 10), undefined);
});

test("the stock Camera panel's WATER_COLLISION drives it: CVar cameraWaterCollision, \"1\" by default", () => {
  let values = defaultSettings();
  const writes = [];
  const cvars = createFrameXmlSettingsCVar({
    getSettings: () => values,
    setSetting: (id, value) => { writes.push([id, value]); values = { ...values, [id]: value }; },
  });
  assert.equal(cvars.get("cameraWaterCollision"), "1");
  assert.equal(cvars.getDefault("cameraWaterCollision"), "1");
  assert.equal(cvars.set("cameraWaterCollision", "0"), true);
  assert.deepEqual(writes, [["cameraWaterCollision", false]]);
  assert.equal(cvars.get("CAMERAWATERCOLLISION"), "0", "case-insensitive, as the client's");
  assert.equal(FRAMEXML_OPTIONS_UNAVAILABLE.has("InterfaceOptionsCameraPanelWaterCollision"), false);
  // The other three stay greyed out: this client does not do them (WORK_PLAN 5.14).
  for (const name of ["InterfaceOptionsCameraPanelFollowTerrain", "InterfaceOptionsCameraPanelHeadBob",
    "InterfaceOptionsCameraPanelSmartPivot"]) assert.ok(FRAMEXML_OPTIONS_UNAVAILABLE.has(name), name);
});
