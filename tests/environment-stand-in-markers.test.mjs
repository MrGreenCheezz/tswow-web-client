// 05.10-A7b-9 (7.18): diagnostics-only boxes where an environment model will never come.
import assert from "node:assert/strict";
import test from "node:test";
import {
  ENVIRONMENT_STAND_IN_MARKER_PIN_SIZE, EnvironmentStandInMarkers, environmentStandInMarkerBox,
} from "../dist/code/browser/EnvironmentStandInMarkers.js";

const placement = (id, extra = {}) => ({
  id, kind: "wmo", name: `World\\Building${id}.wmo`, x: 10, y: 20, z: 5,
  rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1, ...extra,
});

test("the box covers the MODF extents in scene space, or a small cube at the pin", () => {
  const boxed = environmentStandInMarkerBox(placement(1, {
    bounds: { minX: 0, maxX: 40, minY: 100, maxY: 130, minZ: -2, maxZ: 18 },
  }));
  assert.deepEqual(boxed, { x: 20, y: 8, z: -115, width: 40, height: 20, depth: 30 });
  const pinned = environmentStandInMarkerBox(placement(2));
  const size = ENVIRONMENT_STAND_IN_MARKER_PIN_SIZE;
  assert.deepEqual(pinned, { x: 10, y: 5 + size / 2, z: -20, width: size, height: size, depth: size });
});

test("markers appear only under a live lease and leave with the placement or the lease", () => {
  const markers = new EnvironmentStandInMarkers();
  const a = placement(1);
  const b = placement(2);
  // No lease: ordinary play draws nothing.
  assert.equal(markers.beginFrame(0), false);
  markers.mark(a, "missing");
  markers.endFrame();
  assert.equal(markers.size, 0);
  assert.equal(markers.group.children.length, 0);

  markers.showUntil(1_000);
  assert.equal(markers.beginFrame(10), true);
  markers.mark(a, "missing");
  markers.mark(b, "hull");
  markers.endFrame();
  assert.equal(markers.size, 2);
  assert.equal(markers.group.children.length, 2);
  const line = markers.group.children[0];
  assert.equal(line.position.z, -20);
  // The same placement next frame reuses its box; one no longer marked loses it.
  markers.beginFrame(20);
  markers.mark(a, "failed");
  markers.endFrame();
  assert.equal(markers.size, 1);
  assert.equal(markers.group.children[0] === line, true, "the box is kept, not rebuilt");
  assert.equal(line.material.color.getHex(), 0xd22aff, "the colour follows the reason");
  // The lease ran out: everything goes, even with marks still asked for.
  markers.beginFrame(2_000);
  markers.mark(a, "failed");
  markers.endFrame();
  assert.equal(markers.size, 0);
  assert.equal(markers.group.children.length, 0);
  markers.dispose();
});

// 05.10 review A7b-9: `showStandIns` is also reached with the window hidden — the world client's
// `onUnhandledOpcodesChanged`/`onPacketErrorsChanged`, the login and the module load all call
// `showUnhandledOpcodes`, which calls it. A lease taken there drew wireframe boxes in ordinary
// play for a second and a half each time. Only an open window may renew it.
test("only an open diagnostics window renews the marker lease", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/browser/ui/Diagnostics.ts", import.meta.url), "utf8");
  const calls = [...source.matchAll(/^.*showEnvironmentStandInMarkers\(.*$/gm)].map((match) => match[0]);
  assert.equal(calls.length, 1, "one lease renewal");
  assert.match(calls[0], /^\s*if \(!diagnosticsWindow\.hidden\) game\.renderer\?\.showEnvironmentStandInMarkers\(/);
});
