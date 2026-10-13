import assert from "node:assert/strict";
import test from "node:test";
import { withCameraCVars } from "../dist/code/browser/framexml/FrameXmlCameraCVars.js";
import { CameraViews } from "../dist/code/browser/game/CameraViews.js";
import { CameraSaved } from "../dist/code/browser/game/CameraSaved.js";
import { CAMERA_ACCOUNT_CVARS, cameraCVarDefinition } from "../dist/code/browser/game/CameraCVars.js";

/*
 * 3.11 (13.10): GetCVar/GetCVarDefault/SetCVar of the camera's own CVars reach the camera (CameraViews, CameraSaved)
 * instead of the neutral map — Wow.exe 3.3.5a 12340 registers them at 0x005fd910 with validators 0x005fd630
 * (cameraView 0–7), 0x005fd680 (0–50 yd), 0x005fd6d0 (±89°), 0x005fd7b0 (0–360), 0x005fd750 (0.001–300).
 */

function memory() {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

function settingsAdapter() {
  const written = [];
  return {
    written,
    adapter: {
      get: (name) => (name === "cameraSmoothStyle" ? "4" : undefined),
      getDefault: (name) => (name === "cameraSmoothStyle" ? "4" : undefined),
      set: (name, value) => { written.push([name, value]); return name === "cameraSmoothStyle"; },
      range: (name) => (name === "cameraSmoothStyle" ? [0, 4] : undefined),
    },
  };
}

test("the registry is Wow.exe's: 24 view CVars, the index and blend, the follow's tunables and both tables", () => {
  assert.equal(CAMERA_ACCOUNT_CVARS.length, 24 + 2 + 9 + 70 + 30);
  assert.equal(cameraCVarDefinition("CAMERADISTANCEBARBER SHOP")?.defaultValue, "5.0");
  assert.equal(cameraCVarDefinition("cameraSmoothSmarterTrackDelay")?.defaultValue, "0.4");
  assert.equal(cameraCVarDefinition("cameraSmoothSmartFearFactor")?.defaultValue, "10.0");
  assert.equal(cameraCVarDefinition("cameraSmoothViewDataSmartPitchFactor")?.defaultValue, "0.0");
  assert.equal(cameraCVarDefinition("cameraSmoothViewDataAlwaysYawFactor")?.defaultValue, "1.0");
  assert.equal(cameraCVarDefinition("cameraSmoothSplineIdleFactor")?.defaultValue, "4.0");
  assert.equal(cameraCVarDefinition("cameraPitchSmoothMax")?.defaultValue, "30.0");
  assert.deepEqual(cameraCVarDefinition("cameraSmoothTimeMax")?.range, [0.001, 300]);
  assert.equal(cameraCVarDefinition("cameraSmoothStyle"), undefined, "the settings model's, as before");
});

test("the camera answers its names first; the settings the rest; a refused write is still the camera's", () => {
  const views = new CameraViews(memory());
  views.frame({ yaw: 0, pitch: 0, distance: 5 }, 0, {}, "Tester");
  const saved = new CameraSaved(null);
  const { adapter, written } = settingsAdapter();
  const cvars = withCameraCVars(adapter, [views, saved]);
  assert.equal(cvars.get("cameraView"), "2");
  assert.equal(cvars.getDefault("cameraYawC"), "0.0");
  assert.equal(cvars.get("cameraSmoothStyle"), "4", "settings-backed as before");
  assert.equal(cvars.set("cameraPitchD", "45"), true);
  assert.equal(cvars.get("cameraPitchD"), "45");
  assert.equal(cvars.set("cameraPitchD", "100"), true, "refused by 0x005fd6d0, but not the neutral map's");
  assert.equal(cvars.get("cameraPitchD"), "45", "the old value stands");
  assert.equal(cvars.set("cameraSmoothStyle", 2), true);
  assert.deepEqual(written, [["cameraSmoothStyle", 2]], "only the settings name reached the settings");
  assert.equal(cvars.get("cameraSavedDistance"), "5.55", "the character's pair, default view 2's");
  assert.equal(cvars.getDefault("cameraSavedPitch"), "10.0");
  assert.equal(cvars.get("somethingElse"), undefined);
  assert.equal(cvars.range("cameraSmoothStyle")?.[1], 4);
});

test("the character's cameraSavedDistance/Pitch read what the camera saved and write what the next load reads", () => {
  const storage = memory();
  const saved = new CameraSaved(storage);
  const rig = { distance: 7, pitch: -0.2 };
  saved.frame(rig, 0, {}, "Tester", "Realm", 5n, false);
  assert.equal(saved.cvar("cameraSavedDistance"), "5.55", "nothing saved yet");
  assert.equal(saved.setCVar("cameraSavedDistance", "12"), true);
  assert.equal(saved.cvar("CAMERASAVEDDISTANCE"), "12.000000");
  assert.equal(saved.cvar("cameraSavedPitch"), "10.000000", "the other half kept at its default");
  // The next load (another page, the same character) starts there (0x5ff3e0).
  const later = { distance: 0, pitch: 0 };
  new CameraSaved(storage).frame(later, 0, {}, "Tester", "Realm", 5n, false);
  assert.equal(later.distance, 12);
  // A world change saves the camera over it first (0x5ff320 at the config write), as the client's logout would.
  saved.frame(rig, 10, { another: true }, "Tester", "Realm", 5n, false);
  assert.equal(saved.cvar("cameraSavedDistance"), "5.550000", "the camera's own distance won at the save");
  assert.equal(saved.cvar("cameraFoo"), undefined);
  assert.equal(saved.setCVar("cameraFoo", 1), undefined);
});
