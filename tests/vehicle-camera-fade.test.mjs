// 11.02 (26.10): the camera fading a vehicle as it closes in (Wow.exe 0x00606f90's loop): a vehicle with Flags 0x80000
// fades between CameraFadeDistScalarMax and …Min times its model's radius, measured from the camera to the model; a
// seated unit stands for its vehicle; without the flag, the model or a catalog the plain subject fade is unchanged.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { cameraSubjectOpacity } from "../dist/code/browser/game/CameraClip.js";
import { cameraChainFade } from "../dist/code/browser/VehicleCameraFade.js";

const VEHICLE = 0xf150_7d9a_0000_0042n;
const RIDER = 0x0000_0000_0000_0007n;
const FADING = 1;
const PLAIN = 2;

const catalog = {
  vehicle: (id) => ({
    [FADING]: { id, flags: 0x8_0000, cameraFadeDistScalarMin: 1, cameraFadeDistScalarMax: 3 },
    [PLAIN]: { id, flags: 0, cameraFadeDistScalarMin: 1, cameraFadeDistScalarMax: 3 },
  })[id],
};

function world(vehicleId, seated = false) {
  return new Map([
    [VEHICLE, { guid: VEHICLE, vehicleId }],
    [RIDER, { guid: RIDER, ...(seated ? { transport: { guid: VEHICLE, seat: 0 } } : {}) }],
  ]);
}

// The model at the origin, radius 5: whole past 15 yards (+ the 0.1 near distance), gone inside 5.
const model = (guid) => (guid === VEHICLE ? { x: 0, y: 0, z: 0, radius: 5 } : undefined);
const cameraAt = (x, view = 6) => ({ x, y: 0, z: 0, view, pitch: 0, pivotHeight: 1.6 });

test("a driver's camera fades its fading vehicle by the vehicle's band, from the camera to the model", () => {
  const faded = [];
  const objects = world(FADING);
  assert.equal(cameraChainFade(VEHICLE, objects, catalog, model, cameraAt(20), faded), 1, "past Max × radius: whole");
  assert.deepEqual(faded, [VEHICLE]);
  assert.equal(cameraChainFade(VEHICLE, objects, catalog, model, cameraAt(4), faded), 0, "inside Min × radius: gone");
  const half = cameraChainFade(VEHICLE, objects, catalog, model, cameraAt(10.1), faded);
  assert.ok(Math.abs(half - 0.5) <= 1 / 255, `halfway through the band: the half cosine (${half})`);
});

test("a passenger stands for its vehicle, and both are given the answer", () => {
  const faded = [];
  const value = cameraChainFade(RIDER, world(FADING, true), catalog, model, cameraAt(4), faded);
  assert.equal(value, 0);
  assert.deepEqual(faded, [RIDER, VEHICLE]);
});

test("without the flag, the model or a catalog the plain fade on the drawn arm is unchanged", () => {
  const plain = cameraSubjectOpacity(0.5, 0, 1.6);
  assert.ok(plain > 0 && plain < 1);
  const faded = [];
  assert.equal(cameraChainFade(VEHICLE, world(PLAIN), catalog, model, cameraAt(4, 0.5), faded), plain, "no flag");
  assert.equal(cameraChainFade(VEHICLE, world(FADING), catalog, () => undefined, cameraAt(4, 0.5), faded), plain, "no model");
  assert.equal(cameraChainFade(RIDER, world(FADING, true), undefined, model, cameraAt(4, 0.5), faded), plain, "no catalog");
  assert.deepEqual(faded, [RIDER]);
});

test("the renderer draws the whole chain at the answer, with the camera it has just placed", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /this\.#updateCamera\([^\n]*\);\n[^\n]*\n\s+if \(!this\.#firstPerson\) this\.#vehicleCameraFade\(/);
  assert.match(source, /this\.#subjectFadeGuids\.includes\(object\.guid\) \? this\.#subjectFade : 1/);
});
