import assert from "node:assert/strict";
import test from "node:test";
import { fullBodyCameraSpec, m2ToScene, portraitCameraSpec } from "../dist/code/browser/PortraitCamera.js";
import {
  effectiveDevicePixelRatio, portraitCanvasBackingPixels,
} from "../dist/code/browser/PortraitCanvas.js";

const humanMale = {
  fov: 45 * Math.PI / 180,
  near: 0.222222,
  far: 27.777779,
  position: [0.633485, -0.387865, 1.886737],
  target: [0.062668, 0.034265, 1.863569],
};

test("WVM8 HumanMale portrait camera uses the M2-to-scene transform and model scale", () => {
  const resolved = portraitCameraSpec({
    camera: humanMale,
    bounds: { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 2.127], radius: 1.1 },
    scale: 1.25,
  });
  assert.ok(Math.abs(resolved.fov - 45) < 1e-12);
  assert.deepEqual(resolved.position.map((value) => Number(value.toFixed(6))), [0.791856, 2.358421, 0.484831]);
  assert.deepEqual(resolved.target.map((value) => Number(value.toFixed(6))), [0.078335, 2.329461, -0.042831]);
  assert.ok(Math.abs(resolved.near - 0.2777775) < 1e-7);
  assert.ok(Math.abs(resolved.far - 34.72222375) < 1e-6);
  assert.deepEqual(m2ToScene([1, 2, 3]), [1, 3, -2]);
});

test("models without type-0 camera get a deterministic bounds/attachment fallback", () => {
  const input = {
    bounds: { min: [-1, -0.5, 0], max: [1, 0.5, 2], radius: 1.2 },
    attachments: [
      { id: 5, bone: 0, position: [0, 0, 1.7] },
      { id: 11, bone: 0, position: [0, 0, 1.9] },
    ],
  };
  const first = portraitCameraSpec(input);
  const second = portraitCameraSpec(input);
  assert.deepEqual(first, second);
  assert.equal(first.fov, 35);
  assert.ok(first.far > first.near);
  assert.ok(first.position[0] > first.target[0]);
  assert.ok(Math.abs(first.target[1] - 1.8) < 1e-12);
});

test("fallback camera prefers visible mesh bounds over an oversized WVM header", () => {
  const meshBounds = { min: [-1, -0.5, 0], max: [1, 0.5, 2] };
  const headerBounds = { min: [-100, -100, -100], max: [100, 100, 100], radius: 200 };
  const fromVisibleMesh = portraitCameraSpec({ bounds: headerBounds, visibleBounds: meshBounds });
  const fromMeshAsLastResort = portraitCameraSpec({
    bounds: { ...meshBounds, radius: 1 },
  });
  assert.deepEqual(fromVisibleMesh, fromMeshAsLastResort);
});

test("full-body camera ignores an authored bust camera and frames visible bounds", () => {
  const bounds = { min: [-1, -0.5, -2], max: [1, 0.5, 6], radius: 1.2 };
  const bust = portraitCameraSpec({
    bounds,
    camera: { fov: Math.PI / 4, near: 0.1, far: 20, position: [0, 0, 0.4], target: [0, 0, 0.4] },
  });
  const body = fullBodyCameraSpec({
    bounds,
    visibleBounds: bounds,
    attachments: [
      { id: 5, bone: 0, position: [0, 0, 1.9] },
      { id: 11, bone: 0, position: [0, 0, 2.0] },
    ],
  });
  assert.equal(body.fov, 35);
  assert.notDeepEqual(body.position, bust.position);
  assert.deepEqual(body.target, m2ToScene([0, 0, 2]));
  assert.equal(body.position[1], body.target[1], "the optical axis is centered on visible top/bottom");
  const distance = (camera) => Math.hypot(
    camera.position[0] - camera.target[0],
    camera.position[1] - camera.target[1],
    camera.position[2] - camera.target[2],
  );
  const uncenteredFallback = portraitCameraSpec({ bounds, visibleBounds: bounds });
  assert.equal(distance(body), distance(uncenteredFallback), "full-body centering preserves camera distance");
});

test("portrait backing pixels use DPR without consulting hidden layout", () => {
  assert.equal(effectiveDevicePixelRatio(undefined), 1);
  assert.equal(effectiveDevicePixelRatio(0), 1);
  assert.equal(effectiveDevicePixelRatio(2), 2);
  assert.equal(portraitCanvasBackingPixels(58, 2), 116);
  assert.equal(portraitCanvasBackingPixels(42, 1.5), 63);
  assert.equal(portraitCanvasBackingPixels(58, Number.NaN), 58);
});
