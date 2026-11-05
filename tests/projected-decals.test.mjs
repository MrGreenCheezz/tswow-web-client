// 05.11 (6.45): the batches Wow.exe projects onto the ground, against what the stand showed and what its 0x008292A0 and 0x007E36E0 compute.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import {
  BATCH_FLAG_PROJECTED, DECAL_BOX_GROWTH, decalHeightFade, meshFacets, planarMapping, sectionVertices, terrainFacets,
} from "../dist/code/browser/ProjectedDecals.js";
import { TERRAIN_GRID_SIZE } from "../dist/code/browser/Terrain.js";

const near = (a, b, what, within = 1e-6) => assert.ok(Math.abs(a - b) < within, `${what}: ${a} against ${b}`);

test("a section's vertices are its distinct ones, ascending", () => {
  assert.deepEqual([...sectionVertices([9, 9, 5, 7, 5, 8, 1, 2], 2, 4)], [5, 7, 8]);
  assert.equal(BATCH_FLAG_PROJECTED, 4);
});

test("three vertices give the plane that turns a place into the texture's u and v", () => {
  const out = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 };
  // A quad of 10 yards turned 30 degrees, u along one side and v along the other.
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  const at = (u, v) => [10 * u * c - 10 * v * s + 3, 10 * u * s + 10 * v * c - 7, u, v];
  assert.equal(planarMapping([...at(0, 0), ...at(1, 0), ...at(0, 1)], out), true);
  for (const [u, v] of [[0.25, 0.5], [1, 1], [0, 0.75]]) {
    const [x, y] = at(u, v);
    near(out.a * x + out.b * y + out.c, u, "u");
    near(out.d * x + out.e * y + out.f, v, "v");
  }
  assert.equal(planarMapping([0, 0, 0, 0, 1, 1, 1, 0, 2, 2, 0, 1], out), false, "three in a line draw nothing");
});

test("the height fade is the 64 by 8 texture 0x007E36E0 fills", () => {
  // t = i / (N − 1) · 12: rising to 2 at half a unit a step, one to 10, falling after.
  const texture = (i) => {
    const t = (i / 63) * 12;
    if (t < 2) return t * 0.5;
    if (t < 10) return 1;
    return Math.max(0, (12 - t) * 0.5);
  };
  for (let i = 0; i < 64; i++) near(decalHeightFade(i / 63), texture(i), `texel ${i}`, 1e-9);
  assert.equal(decalHeightFade(-1), 0);
  assert.equal(decalHeightFade(2), 0);
  assert.equal(DECAL_BOX_GROWTH, 2);
  near(decalHeightFade(1 / 6), 1, "two thirds of a yard in, on a flat decal's box of four yards");
});

/** The terrain of a tilted plane, with one cell's hole if asked. */
const plane = (a, b, c, hole = () => false) => ({ height: (x, y) => a * x + b * y + c, isHole: hole });
const collect = () => { const list = []; return { list, sink: (...v) => list.push(v) }; };

test("the terrain under a box comes as whole cells of four triangles on the terrain's own grid", () => {
  const cell = TERRAIN_GRID_SIZE / 128;
  // Well inside one cell: x and y between two grid lines.
  const x0 = TERRAIN_GRID_SIZE * (32 - 100 / 128), y0 = TERRAIN_GRID_SIZE * (32 - 200 / 128);
  const box = { minX: x0 - cell * 0.6, maxX: x0 - cell * 0.4, minY: y0 - cell * 0.6, maxY: y0 - cell * 0.4, minZ: -50, maxZ: 50 };
  const { list, sink } = collect();
  terrainFacets(box, plane(0, 0, 1), sink);
  assert.equal(list.length, 4);
  for (const [ax, ay, az] of list) {
    near(ax, x0 - cell / 2, "the cell's centre x", 1e-6);
    near(ay, y0 - cell / 2, "the cell's centre y", 1e-6);
    near(az, 1, "its height");
  }
  // Straddling a grid line takes both cells whole.
  const { list: two, sink: both } = collect();
  terrainFacets({ ...box, minX: x0 - cell * 0.1, maxX: x0 + cell * 0.1 }, plane(0, 0, 1), both);
  assert.equal(two.length, 8);
  // The slope is in the heights.
  const { list: tilted, sink: on } = collect();
  terrainFacets(box, plane(0.5, 0, -x0 * 0.5), on);
  for (const [ax, ay, az, bx, by, bz, cx, cy, cz] of tilted) {
    near(az, (ax - x0) * 0.5, "a", 1e-5);
    near(bz, (bx - x0) * 0.5, "b", 1e-5);
    near(cz, (cx - x0) * 0.5, "c", 1e-5);
    assert.ok(ay && by && cy);
  }
});

test("what is out of the box's height, a hole, or not resident is left out", () => {
  const cell = TERRAIN_GRID_SIZE / 128;
  const x0 = TERRAIN_GRID_SIZE * (32 - 100 / 128), y0 = TERRAIN_GRID_SIZE * (32 - 200 / 128);
  const box = { minX: x0 - cell * 0.6, maxX: x0 - cell * 0.4, minY: y0 - cell * 0.6, maxY: y0 - cell * 0.4, minZ: 10, maxZ: 14 };
  for (const [what, terrain] of [
    ["under the box", plane(0, 0, 5)],
    ["over the box", plane(0, 0, 20)],
    ["a hole", plane(0, 0, 12, () => true)],
    ["not resident", { height: () => undefined, isHole: () => false }],
  ]) {
    const { list, sink } = collect();
    terrainFacets(box, terrain, sink);
    assert.equal(list.length, 0, what);
  }
});

test("a placed mesh gives the triangles touching the box, whole, in world axes", () => {
  // Two triangles of a floor at model height 0, far apart; the placement lifts it 5 and shifts it 100 along world x.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
    0, 0, 0, 2, 0, 0, 0, 0, 2,
    40, 0, 0, 42, 0, 0, 40, 0, 2,
  ]), 3));
  geometry.setIndex([0, 1, 2, 3, 4, 5]);
  const mesh = new THREE.Mesh(geometry);
  mesh.position.set(100, 5, 0);
  const { list, sink } = collect();
  meshFacets({ minX: 99, maxX: 101, minY: -1, maxY: 1, minZ: 3, maxZ: 7 }, mesh, sink);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], [100, -0, 5, 102, -0, 5, 100, -2, 5]);
  const { list: none, sink: nothing } = collect();
  meshFacets({ minX: 99, maxX: 101, minY: -1, maxY: 1, minZ: 8, maxZ: 12 }, mesh, nothing);
  assert.equal(none.length, 0, "over its height");
});

test("the batch leaves the mesh only for a world scene, and the artifact and the names carry it", () => {
  const build = readFileSync(new URL("../src/browser/ModelBuild.ts", import.meta.url), "utf8");
  assert.match(build, /options\.projectedAsDecals === true \? ordered\.filter\(\(\{ batch \}\) => batch\.projected === true\)/);
  // Its bones must be posed though no group of the geometry draws them: Flamestrike's ring stood at the world's origin.
  assert.match(build, /geometry\.userData\["projectedSections"\]/);
  assert.match(readFileSync(new URL("../src/browser/AnimatedModel.ts", import.meta.url), "utf8"), /\[\.\.\.geometry\.groups, \.\.\.projected\]/);
  const encoder = readFileSync(new URL("../tools/wvm.mjs", import.meta.url), "utf8");
  assert.match(encoder, /block\.writeUInt16LE\(\(batch\.flags \?\? 0\) & 0xff, offset \+ 2\)/);
  const renderer = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.ok((renderer.match(/#projectedDecals\.track\(/g) ?? []).length >= 6, "every kind of rig told");
  assert.match(renderer, /this\.#updateProjectedDecals\(map, terrainClient, now\)/);
});
