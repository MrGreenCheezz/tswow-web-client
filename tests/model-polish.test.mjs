import assert from "node:assert/strict";
import test from "node:test";
import { AO_NORMAL_FLOOR, bakeVertexAo, displaceByHeight, smoothModel, submeshKinds } from "../tools/model-polish.mjs";
import { encodeWvm9, WVM9_NORMALS_CARRY_AO } from "../tools/wvm.mjs";
import { decodeWvm9 } from "../dist/code/browser/Wvm.js";
import { MODEL_AO_NORMAL_FLOOR } from "../dist/code/browser/ModelVertexAo.js";

/** A model from vertex records `[x, y, z, nx, ny, nz, u, v]` and triangles, one opaque lit submesh by default. */
function meshOf(vertices, triangles, { batch = {}, extraSubmesh } = {}) {
  const count = vertices.length;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uv0 = new Float32Array(count * 2);
  const boneWeights = new Uint8Array(count * 4);
  vertices.forEach((v, index) => {
    positions.set(v.slice(0, 3), index * 3);
    normals.set(v.slice(3, 6), index * 3);
    uv0.set(v.slice(6, 8), index * 2);
    boneWeights[index * 4] = 255;
  });
  const indices = Uint32Array.from(triangles.flat());
  const submeshes = [{ geosetId: 0, indexStart: 0, indexCount: extraSubmesh ? extraSubmesh.start : indices.length }];
  const batches = [{ submesh: 0, blendMode: 0, materialFlags: 0, textures: [0], uvSets: [0], textureTransform: -1, ...batch }];
  if (extraSubmesh) {
    submeshes.push({ geosetId: 0, indexStart: extraSubmesh.start, indexCount: indices.length - extraSubmesh.start });
    batches.push({ submesh: 1, blendMode: extraSubmesh.blendMode, materialFlags: 0, textures: [0], uvSets: [0], textureTransform: -1 });
  }
  return { positions, normals, uv0, uv1: new Float32Array(count * 2), boneIndices: new Uint8Array(count * 4), boneWeights,
    indices, submeshes, batches, textures: [{ type: 0, flags: 0, filename: "t.blp" }],
    bounds: { min: [-1, -1, -1], max: [1, 1, 1], radius: 2 } };
}

const unit = (x, y, z) => {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
};

/** A six-sided cap of the unit sphere, with the sphere's own normals: 40° from the pole to the rim. */
function dome() {
  const corners = [];
  for (let side = 0; side < 6; side++) {
    const angle = (side * Math.PI) / 3;
    corners.push([Math.sin(0.7) * Math.cos(angle), Math.sin(0.7) * Math.sin(angle), Math.cos(0.7)]);
  }
  corners.push([0, 0, 1]);
  const vertices = corners.map(([x, y, z]) => [x, y, z, x, y, z, (x + 1) / 2, (y + 1) / 2]);
  return meshOf(vertices, [0, 1, 2, 3, 4, 5].map((side) => [side, (side + 1) % 6, 6]));
}

/** Every new point sits on one place per edge: no two copies of a welded edge's midpoint may differ. */
function assertNoCracks(model) {
  // An edge used by exactly one triangle on one side and split on the other is a T-junction: the corner of one
  // triangle lying inside another's edge. Count a welded edge's uses; a closed surface has each edge twice.
  const key = (vertex) => [0, 1, 2].map((axis) => Math.round(model.positions[vertex * 3 + axis] * 1024)).join();
  const uses = new Map();
  for (let at = 0; at < model.indices.length; at += 3) {
    for (let side = 0; side < 3; side++) {
      const a = key(model.indices[at + side]);
      const b = key(model.indices[at + (side + 1) % 3]);
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      uses.set(edge, (uses.get(edge) ?? 0) + 1);
    }
  }
  return uses;
}

test("a curved surface is rounded towards the curve its normals describe, and old vertices stay", () => {
  const before = dome();
  const after = smoothModel(before, { levels: 1, minEdge: 0, minSag: 0 });
  assert.equal(after.indices.length / 3, 24, "each of the six faces splits into four");
  for (let index = 0; index < before.positions.length; index++) assert.equal(after.positions[index], before.positions[index]);
  // A chord over 40° has its midpoint at radius cos 20° = 0.94; the sphere it stands for is at 1.
  const first = before.positions.length / 3;
  for (let vertex = first; vertex < after.positions.length / 3; vertex++) {
    const radius = Math.hypot(after.positions[vertex * 3], after.positions[vertex * 3 + 1], after.positions[vertex * 3 + 2]);
    assert.ok(radius > 0.985 && radius < 1.015, `a midpoint rose to ${radius}`);
  }
  // Bounds never shrink, and every submesh still covers its whole range.
  assert.ok(after.bounds.radius >= before.bounds.radius);
  assert.equal(after.submeshes[0].indexCount, after.indices.length);
});

test("a flat surface and a hard edge are left as authored", () => {
  // A quad with one normal: nothing curves.
  const flat = meshOf([
    [0, 0, 0, 0, 0, 1, 0, 0], [1, 0, 0, 0, 0, 1, 1, 0], [1, 1, 0, 0, 0, 1, 1, 1], [0, 1, 0, 0, 0, 1, 0, 1],
  ], [[0, 1, 2], [0, 2, 3]]);
  assert.equal(smoothModel(flat).indices.length, flat.indices.length);
  // A crate's edge: the same positions twice, two normals. Bent normals inward on the other two edges would curve
  // them, so the shared edge alone is what is being asked about.
  const crate = meshOf([
    [0, 0, 0, 0, 0.5, 0.87, 0, 0], [1, 0, 0, 0, 0.5, 0.87, 1, 0], [0.5, 1, 0, 0, 0, 1, 0, 1],
    [0, 0, 0, 0, -0.87, 0.5, 0, 0], [1, 0, 0, 0, -0.87, 0.5, 1, 0], [0.5, 0, -1, 0, -1, 0, 0, 1],
  ], [[0, 1, 2], [4, 3, 5]]);
  const smoothed = smoothModel(crate, { levels: 1, minEdge: 0, minSag: 0 });
  const onEdge = [];
  for (let vertex = 6; vertex < smoothed.positions.length / 3; vertex++) {
    if (Math.abs(smoothed.positions[vertex * 3 + 1]) < 1e-6 && Math.abs(smoothed.positions[vertex * 3 + 2]) < 1e-6) onEdge.push(vertex);
  }
  assert.deepEqual(onEdge, [], "the hard edge got a vertex");
});

test("an authored hard edge stays crisp even where the fold is gentle", () => {
  // One edge, its vertices doubled for two normals that differ by 13°: the author's crease over a shallow fold. Each
  // side curves along the edge by every other rule, so only the two normals say to leave it alone.
  const side = (sign) => [
    [-1, 0, 0, ...unit(-0.25, sign * 0.12, 1), 0, 0], [1, 0, 0, ...unit(0.25, sign * 0.12, 1), 1, 0],
    [0, sign * 2, 0.3, ...unit(0, sign * 0.1, 1), 0.5, 1],
    [-2, sign * 1.5, 0.7, ...unit(-0.3, sign * 0.1, 1), 0, 1], [2, sign * 1.5, 0.7, ...unit(0.3, sign * 0.1, 1), 1, 1],
  ];
  const crease = meshOf([...side(1), ...side(-1)], [[0, 1, 2], [0, 2, 3], [1, 4, 2], [6, 5, 7], [5, 8, 7], [6, 7, 9]]);
  const after = smoothModel(crease, { levels: 1, minEdge: 0, minSag: 0 });
  assert.ok(after.indices.length > crease.indices.length, "the rest of the surface did round");
  for (let vertex = 10; vertex < after.positions.length / 3; vertex++) {
    const onCrease = Math.abs(after.positions[vertex * 3]) < 0.5 && Math.abs(after.positions[vertex * 3 + 1]) < 0.3;
    assert.ok(!onCrease, "the crease took a point");
  }
});

test("a soft-shaded box is not inflated into a pillow", () => {
  // Corner normals 70° apart: an edge the author shaded smooth over a right angle.
  const a = unit(1, 1, 1);
  const b = unit(-1, 1, 1);
  const box = meshOf([[1, 1, 1, ...a, 0, 0], [-1, 1, 1, ...b, 1, 0], [0, 1, 3, 0, 0.3, 0.95, 0, 1]], [[0, 1, 2]]);
  const before = box.indices.length;
  const after = smoothModel(box, { levels: 1, minEdge: 0, minSag: 0 });
  const first = box.positions.length / 3;
  for (let vertex = first; vertex < after.positions.length / 3; vertex++) {
    const onEdge = Math.abs(after.positions[vertex * 3 + 2] - 1) < 0.2 && Math.abs(after.positions[vertex * 3]) < 0.2;
    assert.ok(!onEdge, `a vertex landed on the box's edge: ${after.positions.slice(vertex * 3, vertex * 3 + 3)}`);
  }
  assert.ok(after.indices.length >= before);
});

test("a square post shaded smooth does not swell along its length", () => {
  // LAMPPOST's upright: four long sides, each corner's normal averaged with the end caps. The two ends of a long
  // edge are only 70–90° apart at the top and bottom, and nearly parallel in plan: what made a coffin of it.
  const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  const vertices = [];
  for (const z of [0, 8]) for (const [x, y] of corners) vertices.push([x * 0.2, y * 0.2, z, ...unit(x, y, z === 0 ? -0.4 : 0.4), 0, z / 8]);
  const triangles = [];
  for (let side = 0; side < 4; side++) {
    const next = (side + 1) % 4;
    triangles.push([side, next, side + 4], [next, next + 4, side + 4]);
  }
  const post = meshOf(vertices, triangles);
  assert.equal(smoothModel(post, { levels: 2, minEdge: 0, minSag: 0 }).indices.length, post.indices.length);
});

test("a flat face whose corners lean is no curve, whichever way they lean", () => {
  // One flat quad: its normals leaning outward as if it were a pillow, inward as if it were a dish.
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const sign of [1, -1]) {
    const canvas = meshOf(corners.map(([x, y]) => [x, y, 0, ...unit(sign * x * 0.3, sign * y * 0.3, 1), (x + 1) / 2, (y + 1) / 2]), [[0, 1, 2], [0, 2, 3]]);
    const after = smoothModel(canvas, { levels: 2, minEdge: 0, minSag: 0 });
    assert.equal(after.indices.length, canvas.indices.length, `a flat face leaning ${sign} has no curve to follow`);
  }
});

test("a normal far off its own faces is no tangent, even on a soft edge", () => {
  // A ridge between two faces folded by 40°: soft by every other rule. One end's normal leans 43° off both faces.
  const fold = 0.36;
  const left = unit(-fold, 0, 1);
  const ridge = meshOf([
    [-1, 8, 0, ...left, 0, 1], [0, 8, fold, 0, 0.62, 0.78, 0.5, 1], [1, 8, 0, fold / 1.06, 0, 0.94, 1, 1],
    [-1, 0, 0, ...left, 0, 0], [0, 0, fold, 0, 0, 1, 0.5, 0], [1, 0, 0, fold / 1.06, 0, 0.94, 1, 0],
  ], [[3, 4, 1], [3, 1, 0], [4, 5, 2], [4, 2, 1]]);
  const after = smoothModel(ridge, { levels: 1, minEdge: 0, minSag: 0 });
  for (let vertex = 6; vertex < after.positions.length / 3; vertex++) {
    const onRidge = Math.abs(after.positions[vertex * 3]) < 0.6 && Math.abs(after.positions[vertex * 3 + 1] - 4) < 0.6;
    assert.ok(!onRidge, "the ridge took a point from a normal that does not describe it");
  }
});

test("two faces folded past a corner meet at a corner, however its normals are shaded", () => {
  // A five-sided post: each vertex normal within 41° of its faces and only 40° from the other end of its edge, so
  // nothing but the 72° fold says that this long edge must not bow out.
  const ring = [0, 1, 2, 3, 4].map((side) => (side * 2 * Math.PI) / 5);
  const vertices = [];
  for (const [z, lean] of [[0, -0.36], [8, 0.36]]) {
    for (const angle of ring) vertices.push([Math.cos(angle), Math.sin(angle), z, ...unit(Math.cos(angle), Math.sin(angle), lean), 0, z / 8]);
  }
  const triangles = [];
  for (let side = 0; side < 5; side++) {
    const next = (side + 1) % 5;
    triangles.push([side, next, side + 5], [next, next + 5, side + 5]);
  }
  const post = meshOf(vertices, triangles);
  assert.equal(smoothModel(post, { levels: 1, minEdge: 0, minSag: 0 }).indices.length, post.indices.length);
});

test("a panel set into a frame does not sink: an edge that would curve inward stays", () => {
  // STORMWINDPAINTING: a flat canvas at z = 0 with a raised frame round it, the normals averaged over the crease
  // leaning inward at the canvas's corners. Before this every point of the canvas stayed at or above the wall's plane
  // only by luck of the fan; the frame's faces make the fan not flat.
  const inner = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const vertices = inner.map(([x, y]) => [x, y, 0, ...unit(-x * 0.25, -y * 0.25, 1), 0, 0]);
  for (const [x, y] of inner) vertices.push([x * 1.15, y * 1.15, 0.15, ...unit(x * 0.2, y * 0.2, 1), 1, 1]);
  const triangles = [[0, 1, 2], [0, 2, 3]];
  for (let side = 0; side < 4; side++) {
    const next = (side + 1) % 4;
    triangles.push([side, side + 4, next + 4], [side, next + 4, next]);
  }
  const panel = meshOf(vertices, triangles);
  const after = smoothModel(panel, { levels: 2, minEdge: 0, minSag: 0 });
  for (let vertex = 0; vertex < after.positions.length / 3; vertex++) {
    assert.ok(after.positions[vertex * 3 + 2] > -1e-6, `a point sank to ${after.positions[vertex * 3 + 2]}`);
  }
});

test("a UV seam does not open: both sides of a welded edge get the same point", () => {
  // Two triangles over one edge, its vertices doubled for the UVs, the normals curving across.
  const left = unit(-0.3, 0, 1);
  const right = unit(0.3, 0, 1);
  const seam = meshOf([
    [-1, -1, 0, ...left, 0, 0], [-1, 1, 0, ...left, 0, 1], [0, 0, 0.2, 0, 0, 1, 0.5, 0.5],
    [-1, 1, 0, ...left, 0.9, 0.9], [-1, -1, 0, ...left, 0.9, 0.1], [-2, 0, 0.1, ...unit(-0.6, 0, 1), 0.2, 0.2],
  ], [[0, 2, 1], [3, 5, 4]]);
  const after = smoothModel(seam, { levels: 1, minEdge: 0, minSag: 0, sag: 0 });
  const uses = assertNoCracks(after);
  // Every interior edge of the two fans is used twice, whatever split it: no single-use edge along x = -1.
  for (const [edge, count] of uses) {
    const [a, b] = edge.split("|").map((point) => point.split(",").map(Number));
    if (a[0] === -1024 && b[0] === -1024) assert.equal(count, 2, `edge ${edge} is open`);
  }
  void right;
});

test("anything not solid keeps its triangles, and its neighbour does not split the shared edge", () => {
  // The cap: three faces opaque, three blended, on the same vertices.
  const source = dome();
  const model = { ...source,
    submeshes: [{ geosetId: 0, indexStart: 0, indexCount: 9 }, { geosetId: 0, indexStart: 9, indexCount: 9 }],
    batches: [source.batches[0], { ...source.batches[0], submesh: 1, blendMode: 2 }] };
  assert.deepEqual([...submeshKinds(model)], [2, 0]);
  const after = smoothModel(model, { levels: 1, minEdge: 0, minSag: 0 });
  assert.ok(after.submeshes[0].indexCount > 9, "the solid side did round");
  assert.equal(after.submeshes[1].indexCount, 9, "the blended side is untouched");
  // No edge of the blended side has a corner of the solid side lying inside it: each is used as it was.
  const uses = assertNoCracks(after);
  const key = (vertex) => [0, 1, 2].map((axis) => Math.round(after.positions[vertex * 3 + axis] * 1024)).join();
  const at = after.submeshes[1].indexStart;
  const edge = (a, b) => (key(a) < key(b) ? `${key(a)}|${key(b)}` : `${key(b)}|${key(a)}`);
  // The two spokes where solid meets blended, vertices 3–6 and 0–6: both sides still use the whole edge.
  assert.equal(uses.get(edge(after.indices[at], after.indices[at + 2])), 2);
  assert.equal(uses.get(edge(after.indices[at + 7], after.indices[at + 8])), 2);
});

test("new skin weights keep the file's byte sum and the strongest influences", () => {
  const model = dome();
  model.boneWeights.fill(0);
  model.boneIndices.fill(0);
  const set = (vertex, entries) => entries.forEach(([bone, weight], slot) => {
    model.boneIndices[vertex * 4 + slot] = bone;
    model.boneWeights[vertex * 4 + slot] = weight;
  });
  set(0, [[1, 100], [2, 80], [3, 50], [4, 25]]);
  set(1, [[5, 200], [6, 55]]);
  for (const vertex of [2, 3, 4, 5, 6]) set(vertex, [[7, 255]]);
  const after = smoothModel(model, { levels: 1, minEdge: 0, minSag: 0 });
  for (let vertex = 0; vertex < after.positions.length / 3; vertex++) {
    const sum = after.boneWeights.subarray(vertex * 4, vertex * 4 + 4).reduce((total, weight) => total + weight, 0);
    assert.equal(sum, 255, `vertex ${vertex}`);
  }
  // The midpoint of 0 and 1 has six candidates and keeps four, the heaviest being bone 5.
  let found = false;
  for (let vertex = 7; vertex < after.positions.length / 3; vertex++) {
    const bones = [...after.boneIndices.subarray(vertex * 4, vertex * 4 + 4)];
    if (bones[0] === 5) {
      found = true;
      assert.ok(bones.includes(1) && bones.includes(2), `kept ${bones}`);
    }
  }
  assert.ok(found);
});

test("occlusion: a floor under a wall is darker than the floor in the open, and it travels in the normal's length", () => {
  // A wide floor with a wall standing near one of its vertices.
  const floor = meshOf([
    [-4, -4, 0, 0, 0, 1, 0, 0], [4, -4, 0, 0, 0, 1, 1, 0], [4, 4, 0, 0, 0, 1, 1, 1], [-4, 4, 0, 0, 0, 1, 0, 1],
    [0, 0, 0, 0, 0, 1, 0.5, 0.5], [3.9, 0, 0, 0, 0, 1, 1, 0.5],
    [4, -2, 0, -1, 0, 0, 0, 0], [4, 2, 0, -1, 0, 0, 1, 0], [4, 2, 4, -1, 0, 0, 1, 1], [4, -2, 4, -1, 0, 0, 0, 1],
  ], [[0, 1, 5], [1, 2, 5], [2, 3, 5], [3, 0, 5], [6, 7, 8], [6, 8, 9]]);
  const baked = bakeVertexAo(floor, { reach: 0.8, maxReach: 8, ground: false });
  const length = (vertex) => Math.hypot(baked.normals[vertex * 3], baked.normals[vertex * 3 + 1], baked.normals[vertex * 3 + 2]);
  const ao = (vertex) => (length(vertex) - AO_NORMAL_FLOOR) / (1 - AO_NORMAL_FLOOR);
  assert.ok(baked.normalsCarryAo);
  assert.ok(ao(5) < ao(0) - 0.15, `beside the wall ${ao(5)}, in the open ${ao(0)}`);
  assert.ok(ao(0) > 0.8, `the far corner reads ${ao(0)}`);
  // Direction is untouched: only the length changed.
  const n = [baked.normals[15] / length(5), baked.normals[16] / length(5), baked.normals[17] / length(5)];
  assert.deepEqual(n.map((value) => Math.round(value * 1000) / 1000), [0, 0, 1]);
});

test("occlusion: the ground counts only for what stands on it", () => {
  const post = (z0) => meshOf([
    [1, 0, z0, 1, 0, 0, 0, 0], [0, 1, z0, 0, 1, 0, 1, 0], [-1, 0, z0, -1, 0, 0, 0, 1],
    [1, 0, z0 + 4, 1, 0, 0, 0, 0], [0, 1, z0 + 4, 0, 1, 0, 1, 0], [-1, 0, z0 + 4, -1, 0, 0, 0, 1],
  ], [[0, 1, 4], [0, 4, 3], [1, 2, 5], [1, 5, 4]]);
  const standing = bakeVertexAo(post(0.05), { ground: true });
  const open = bakeVertexAo(post(0.05), { ground: false });
  const lengthAt = (model, vertex) => Math.hypot(model.normals[vertex * 3], model.normals[vertex * 3 + 1], model.normals[vertex * 3 + 2]);
  assert.ok(lengthAt(standing, 0) < lengthAt(open, 0) - 0.02, "the foot is shaded by the ground");
  // Within the rays' reach of the plane z = 0, but standing on nothing: a lamp on a bracket.
  const hanging = bakeVertexAo(post(2.5), { ground: true });
  const hangingOpen = bakeVertexAo(post(2.5), { ground: false });
  assert.equal(lengthAt(hanging, 0), lengthAt(hangingOpen, 0), "a lamp in the air has no ground under it");
});

test("relief: a height map moves the surface, copies of a point move together, an unmapped neighbour pins it", () => {
  // A 256-texel map whose left half is high: a step in the middle of a two-yard square.
  const data = new Int16Array(64 * 64);
  for (let row = 0; row < 64; row++) for (let column = 0; column < 64; column++) data[row * 64 + column] = column < 32 ? 2560 : -2560;
  const square = meshOf([
    [0, 0, 0, 0, 0, 1, 0, 0], [2, 0, 0, 0, 0, 1, 1, 0], [2, 2, 0, 0, 0, 1, 1, 1], [0, 2, 0, 0, 0, 1, 0, 1],
  ], [[0, 1, 2], [0, 2, 3]]);
  const map = { width: 64, height: 64, data, wrapX: false, wrapY: false };
  const after = displaceByHeight(square, () => map, { levels: 3, texels: 4, minEdge: 0, maxDepth: 1, budget: 1e6 });
  assert.ok(after.indices.length > square.indices.length, "the mesh was refined to the map");
  let up = 0;
  let down = 0;
  for (let vertex = 0; vertex < after.positions.length / 3; vertex++) {
    const z = after.positions[vertex * 3 + 2];
    if (z > 0.01) up++;
    if (z < -0.01) down++;
    if (after.positions[vertex * 3] < 0.7 && after.positions[vertex * 3 + 2] < -0.01) assert.fail("a high texel went down");
  }
  assert.ok(up > 0 && down > 0, `${up} up, ${down} down`);

  const pinned = meshOf([
    [0, 0, 0, 0, 0, 1, 0, 0], [2, 0, 0, 0, 0, 1, 0.2, 0], [0, 2, 0, 0, 0, 1, 0, 0.2], [2, 2, 0, 0, 0, 1, 0.2, 0.2],
  ], [[0, 1, 2], [1, 3, 2]], { extraSubmesh: { start: 3, blendMode: 0 } });
  const moved = displaceByHeight(pinned, (submesh) => (submesh === 0 ? map : undefined), { levels: 0, maxDepth: 1 });
  // Vertices 1 and 2 are shared with the unmapped triangle: they may not move, or the two would part.
  assert.equal(moved.positions[1 * 3 + 2], 0);
  assert.equal(moved.positions[2 * 3 + 2], 0);
  assert.notEqual(moved.positions[0 * 3 + 2], 0);
});

test("the flag travels through the artifact, and the page's floor is the bake's", () => {
  assert.equal(MODEL_AO_NORMAL_FLOOR, AO_NORMAL_FLOOR);
  const encoded = (model) => {
    const bytes = encodeWvm9(model, undefined, [], undefined, {});
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  };
  const plain = dome();
  assert.equal(decodeWvm9(encoded(plain)).normalsCarryAo, undefined);
  assert.equal(new Uint8Array(encoded(plain))[13] & WVM9_NORMALS_CARRY_AO, 0);
  const baked = bakeVertexAo(smoothModel(dome(), { levels: 1, minEdge: 0, minSag: 0 }));
  const decoded = decodeWvm9(encoded(baked));
  assert.equal(decoded.normalsCarryAo, true);
  assert.equal(decoded.indices.length, baked.indices.length);
  assert.equal(decoded.positions.length, baked.positions.length);
});
