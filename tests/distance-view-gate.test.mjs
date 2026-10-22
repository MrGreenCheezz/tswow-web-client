// 22.10 (7.39 review): the skyline's 1,100 yards and the wider footprint only while the enhanced
// fog stretch shows them; the faithful levels keep 750 and the 810-yard footprint.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import { environmentShellRange, environmentStreamRange } from "../dist/code/browser/SceneryReach.js";
import { ENVIRONMENT_FAR_RANGE, ENVIRONMENT_SHELL_RANGE, ENVIRONMENT_STREAM_RANGE } from "../dist/code/browser/Terrain.js";
import { WmoRangeTable } from "../dist/code/browser/WmoGroupRange.js";
import { environmentDrawRange, environmentRankInRange, wmoShellRange } from "../dist/code/browser/WorldRenderer3D.js";
import { pageEnvironmentRange } from "../dist/code/browser/game/PageEnvironmentRange.js";

const keep = {
  id: "keep", kind: "wmo", name: "World\\wmo\\keep.wmo", x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
  bounds: { minX: -100, minY: -100, minZ: 0, maxX: 100, maxY: 100, maxZ: 40 },
};

test("the shells' leash follows the lighting path", () => {
  assert.equal(environmentShellRange(0), 750, "classic");
  assert.equal(environmentShellRange(3), 750, "comparison level");
  assert.equal(environmentShellRange(1), ENVIRONMENT_SHELL_RANGE);
  assert.equal(environmentShellRange(2), ENVIRONMENT_SHELL_RANGE);
  assert.equal(environmentDrawRange(keep), 750, "the default is the faithful leash");
  assert.equal(environmentDrawRange(keep, 1.5, environmentShellRange(0)), 750);
  assert.equal(environmentDrawRange(keep, 1.5, environmentShellRange(2)), 1100);
  const far = { ...keep, x: 900, bounds: { minX: 800, minY: -100, minZ: 0, maxX: 1000, maxY: 100, maxZ: 40 } };
  assert.equal(environmentRankInRange([far], { x: 0, y: 0 }, 1.5).candidates.length, 0, "faithful: 800 yards is past 750");
  assert.equal(environmentRankInRange([far], { x: 0, y: 0 }, 1.5, 1100).candidates.length, 1, "enhanced: inside 1,100");
});

test("the footprint is the faithful 810 yards unless a longer leash is in force", () => {
  assert.equal(ENVIRONMENT_STREAM_RANGE, 810);
  assert.equal(environmentStreamRange(environmentShellRange(0), 1), ENVIRONMENT_STREAM_RANGE);
  assert.equal(environmentStreamRange(environmentShellRange(3), 1.5), ENVIRONMENT_STREAM_RANGE);
  assert.equal(environmentStreamRange(environmentShellRange(2), 1.5), 1160);
  assert.equal(environmentStreamRange(environmentShellRange(0), 2), 1060, "the object-distance step widens it on any path");
  assert.equal(pageEnvironmentRange(undefined), ENVIRONMENT_STREAM_RANGE);
  assert.equal(pageEnvironmentRange({ environmentStreamRange: 1160 }), 1160, "the in-page renderer's own band");
  assert.equal(pageEnvironmentRange({ renderWorker: {}, environmentStreamRange: 1160 }), 64, "a worker streams its own");
});

test("a WMO range table's skyline groups are capped per path, and refill when the path changes", () => {
  const groups = [{ triangleCount: 10, exterior: true, indoor: false }];
  const box = new THREE.Box3(new THREE.Vector3(800, 0, -100), new THREE.Vector3(1000, 100, 100));
  const table = new WmoRangeTable({ groups }, [box], 60, (b) => wmoShellRange(b, ENVIRONMENT_SHELL_RANGE));
  assert.deepEqual([...table.select(0, 0)], [0], "uncapped: 800 yards is inside 1,100");
  table.setShellCap(ENVIRONMENT_FAR_RANGE);
  assert.deepEqual([...table.select(0, 0)], [], "capped at 750 on the faithful levels");
  table.setShellCap(ENVIRONMENT_SHELL_RANGE);
  assert.deepEqual([...table.select(0, 0)], [0]);
  assert.deepEqual([...table.select(0, 0, 50)], [], "a transport's override is not capped, nor raised");
});

test("the renderer asks the path for both, and reselects when the path changes", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /queryCached\(\s+player\.x, player\.y, this\.environmentStreamRange,/);
  assert.match(source, /environmentRankInRange\(pool, player, this\.#environmentDetail, this\.environmentShellRange\)/);
  assert.match(source, /placed\.ranges\.setShellCap\?\.\(this\.environmentShellRange\)/);
  assert.match(source, /ranges\.setShellCap\(this\.environmentShellRange\)/, "the open-air table too");
  assert.match(source, /if \(this\.environmentShellRange !== oldShellRange\) this\.#environmentCandidatesAt = undefined;/);
  for (const file of ["RenderWorkerSession.ts", "bench/Harness.ts", "bench/BenchRender.worker.ts"]) {
    const text = await readFile(new URL(`../src/browser/${file}`, import.meta.url), "utf8");
    assert.match(text, /\.environmentStreamRange\)/, `${file} streams the renderer's band`);
  }
});
