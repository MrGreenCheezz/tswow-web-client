import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// R4.0b is intentionally offline-only. The pure async API under test is:
//
//   simplifyStaticM2({
//     modelPath, modelSha1, sourceStamp, model, targetTriangles, algorithmVersion,
//     kind: "m2", staticModel: true, exterior: true,
//     skinned: false, animated: false, particleEmitters: false,
//     ribbonEmitters: false, composite: false, legacy: false,
//   }) -> frozen profile or undefined on unsafe input.
//
// A returned profile carries fresh `positions`, `normals`, `uv0`, `uv1`, `indices`, `submeshes`,
// `batches`, and conservative `bounds`, plus `bytes` and a source/options-bound `profileId`.
// No renderer, streaming, cache, or resource lookup is part of this slice.
const lodImport = await import("../tools/m2-lod.mjs").catch((error) => ({ __error: error }));

const MODEL_PATH = "World\\Creature\\R4Hlod\\R4Hlod.m2";
const MODEL_SHA1 = "0123456789abcdef0123456789abcdef01234567";
const SOURCE_STAMP = Object.freeze({
  chain: "r4-test-chain",
  sources: [{ path: MODEL_PATH, size: 4096, mtimeMs: 1 }],
  files: [],
});
const ALGORITHM_VERSION = "r4.0b-test-v1";
// Locking the outer border of each 2x2 grid costs six triangles per partition; a global target of
// eight would therefore demand an unsafe collapse. Keep this fixture above that measured floor.
const TARGET_TRIANGLES = 12;

function api() {
  if (lodImport.__error) throw lodImport.__error;
  assert.equal(typeof lodImport.simplifyStaticM2, "function", "R4.0b simplifyStaticM2 export is required");
  return lodImport;
}

function gridMesh() {
  const positions = [];
  const normals = [];
  const uv0 = [];
  const uv1 = [];
  const indices = [];
  const submeshes = [];
  const batches = [];

  // Two adjacent 2x2 quad grids. They share the x=2 silhouette in world position but intentionally
  // keep different UVs/normals and geosets: a simplifier must never weld this authored seam.
  const appendGrid = (xOrigin, normalZ, uvOffset, geosetId, material, indexStart) => {
    const vertexStart = positions.length / 3;
    for (let y = 0; y <= 2; y++) {
      for (let x = 0; x <= 2; x++) {
        positions.push(xOrigin + x, y, 0);
        normals.push(0, 0, normalZ);
        uv0.push(uvOffset + x / 2, y / 2);
        uv1.push(x / 2, y / 2);
      }
    }
    const at = (x, y) => vertexStart + y * 3 + x;
    const local = [];
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        const a = at(x, y);
        const b = at(x + 1, y);
        const c = at(x, y + 1);
        const d = at(x + 1, y + 1);
        local.push(a, b, c, b, d, c);
      }
    }
    indices.push(...local);
    submeshes.push({
      geosetId,
      vertexStart,
      vertexCount: 9,
      indexStart,
      indexCount: local.length,
      centre: [xOrigin + 1, 1, 0],
      sortRadius: 2,
    });
    batches.push({
      submesh: submeshes.length - 1,
      priorityPlane: submeshes.length - 1,
      materialLayer: material,
      shaderId: material + 2,
      // R4.0b deliberately accepts only fully opaque static M2s. The partitions still differ by
      // shader/material/texture metadata, so this does not permit welding across authored seams.
      flags: 0,
      blendMode: 0,
      materialFlags: 0,
      textures: [material],
      uvSets: [material === 0 ? 0 : 1],
      colorIndex: 0xffff,
      textureWeight: -1,
      textureTransform: -1,
    });
  };

  appendGrid(0, 1, 0, 100, 0, 0);
  appendGrid(2, -1, 0.5, 200, 1, 24);
  return {
    version: 264,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uv0: new Float32Array(uv0),
    uv1: new Float32Array(uv1),
    boneIndices: new Uint8Array(positions.length / 3 * 4),
    boneWeights: new Uint8Array(positions.length / 3 * 4),
    indices: new Uint16Array(indices),
    submeshes,
    batches,
    textures: [
      { type: 0, filename: "World\\Texture\\Stone.blp" },
      { type: 0, filename: "World\\Texture\\Trim.blp" },
    ],
    bounds: { min: [0, 0, -1], max: [4, 2, 1], radius: 4.5 },
    unsupported: { globalLoops: 0, particleEmitters: 0, ribbonEmitters: 0, events: 0 },
  };
}

function cloneTyped(value) {
  return value === undefined ? undefined : new value.constructor(value);
}

function cloneModel(model) {
  return {
    ...model,
    positions: cloneTyped(model.positions),
    normals: cloneTyped(model.normals),
    uv0: cloneTyped(model.uv0),
    uv1: cloneTyped(model.uv1),
    boneIndices: cloneTyped(model.boneIndices),
    boneWeights: cloneTyped(model.boneWeights),
    indices: cloneTyped(model.indices),
    submeshes: model.submeshes.map((value) => ({ ...value, centre: [...value.centre] })),
    batches: model.batches.map((value) => ({
      ...value,
      textures: [...value.textures],
      uvSets: [...value.uvSets],
    })),
    textures: model.textures.map((value) => ({ ...value })),
    bounds: { min: [...model.bounds.min], max: [...model.bounds.max], radius: model.bounds.radius },
    unsupported: { ...model.unsupported },
  };
}

function baseOptions(overrides = {}) {
  return {
    modelPath: MODEL_PATH,
    modelSha1: MODEL_SHA1,
    sourceStamp: SOURCE_STAMP,
    model: gridMesh(),
    targetTriangles: TARGET_TRIANGLES,
    algorithmVersion: ALGORITHM_VERSION,
    kind: "m2",
    staticModel: true,
    exterior: true,
    interior: false,
    skinned: false,
    animated: false,
    particleEmitters: false,
    ribbonEmitters: false,
    composite: false,
    legacy: false,
    ...overrides,
  };
}

async function simplify(overrides = {}) {
  return api().simplifyStaticM2(baseOptions(overrides));
}

function outputArrays(profile) {
  for (const field of ["positions", "normals", "uv0", "uv1", "indices"]) {
    assert.ok(ArrayBuffer.isView(profile[field]), `profile.${field} must be a typed array`);
  }
  return profile;
}

function assertValidTopology(profile) {
  outputArrays(profile);
  assert.equal(profile.positions.length % 3, 0);
  assert.equal(profile.normals.length, profile.positions.length);
  assert.equal(profile.uv0.length, profile.positions.length / 3 * 2);
  assert.equal(profile.uv1.length, profile.positions.length / 3 * 2);
  assert.equal(profile.indices.length % 3, 0);
  const vertices = profile.positions.length / 3;
  const edgeUses = new Map();
  for (let triangle = 0; triangle < profile.indices.length; triangle += 3) {
    const a = profile.indices[triangle];
    const b = profile.indices[triangle + 1];
    const c = profile.indices[triangle + 2];
    assert.ok(Number.isInteger(a) && Number.isInteger(b) && Number.isInteger(c));
    assert.ok(a >= 0 && a < vertices && b >= 0 && b < vertices && c >= 0 && c < vertices);
    assert.notEqual(a, b, "degenerate triangle edge");
    assert.notEqual(b, c, "degenerate triangle edge");
    assert.notEqual(a, c, "degenerate triangle edge");
    const ax = profile.positions[a * 3];
    const ay = profile.positions[a * 3 + 1];
    const az = profile.positions[a * 3 + 2];
    const bx = profile.positions[b * 3];
    const by = profile.positions[b * 3 + 1];
    const bz = profile.positions[b * 3 + 2];
    const cx = profile.positions[c * 3];
    const cy = profile.positions[c * 3 + 1];
    const cz = profile.positions[c * 3 + 2];
    const crossX = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const crossY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const crossZ = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    assert.ok(Number.isFinite(crossX) && Number.isFinite(crossY) && Number.isFinite(crossZ));
    assert.ok(crossX * crossX + crossY * crossY + crossZ * crossZ > 1e-12, "zero-area triangle");
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const edge = from < to ? `${from}/${to}` : `${to}/${from}`;
      edgeUses.set(edge, (edgeUses.get(edge) ?? 0) + 1);
    }
  }
  for (const [edge, count] of edgeUses) assert.ok(count <= 2, `non-manifold edge ${edge}`);
  for (const value of profile.positions) assert.ok(Number.isFinite(value));
  for (const value of profile.normals) assert.ok(Number.isFinite(value));
  for (const value of profile.uv0) assert.ok(Number.isFinite(value));
  for (const value of profile.uv1) assert.ok(Number.isFinite(value));
}

function assertBatchMetadata(profile, input) {
  assert.equal(profile.submeshes.length, input.submeshes.length);
  assert.equal(profile.batches.length, input.batches.length);
  for (let index = 0; index < input.submeshes.length; index++) {
    const before = input.submeshes[index];
    const after = profile.submeshes[index];
    assert.equal(after.geosetId, before.geosetId);
    assert.ok(Number.isInteger(after.vertexStart) && after.vertexStart >= 0);
    assert.ok(Number.isInteger(after.vertexCount) && after.vertexCount > 0);
    assert.ok(after.vertexStart + after.vertexCount <= profile.positions.length / 3);
    assert.equal(after.indexStart % 3, 0);
    assert.equal(after.indexCount % 3, 0);
    assert.ok(after.indexCount > 0, "every authored batch remains represented");
    assert.ok(after.indexStart >= 0 && after.indexStart + after.indexCount <= profile.indices.length);
  }
  for (let index = 0; index < input.batches.length; index++) {
    const before = input.batches[index];
    const after = profile.batches[index];
    for (const field of ["submesh", "priorityPlane", "materialLayer", "shaderId", "flags", "blendMode",
      "materialFlags", "textures", "uvSets", "colorIndex", "textureWeight", "textureTransform"]) {
      assert.deepEqual(after[field], before[field], `batch ${index} ${field} metadata changed`);
    }
  }
}

function assertSeamsPreserved(profile) {
  const positions = new Map();
  for (let index = 0; index < profile.positions.length / 3; index++) {
    const key = [profile.positions[index * 3], profile.positions[index * 3 + 1], profile.positions[index * 3 + 2]].join("/");
    const signature = [
      profile.normals[index * 3], profile.normals[index * 3 + 1], profile.normals[index * 3 + 2],
      profile.uv0[index * 2], profile.uv0[index * 2 + 1],
      profile.uv1[index * 2], profile.uv1[index * 2 + 1],
    ].join("/");
    const signatures = positions.get(key) ?? new Set();
    signatures.add(signature);
    positions.set(key, signatures);
  }
  const seam = positions.get("2/0/0") ?? new Set();
  assert.ok(seam.size >= 2, "the authored UV/normal seam must remain split at the shared edge");
  assert.ok([...seam].some((value) => value.includes("/1/")));
  assert.ok([...seam].some((value) => value.includes("/-1/")));
}

function snapshot(model) {
  return {
    streams: ["positions", "normals", "uv0", "uv1", "boneIndices", "boneWeights", "indices"]
      .map((field) => [field, Array.from(model[field] ?? [])]),
    submeshes: structuredClone(model.submeshes),
    batches: structuredClone(model.batches),
    textures: structuredClone(model.textures),
    bounds: structuredClone(model.bounds),
  };
}

async function rejected(call, message) {
  if (lodImport.__error) throw lodImport.__error;
  try {
    assert.equal(await call(), undefined, message);
  } catch (error) {
    // A deliberate validation exception is also a fail-closed rejection.
    if (error?.name === "AssertionError") throw error;
  }
}

test("static M2 HLOD is deterministic, reduced, topology-valid, and preserves authored partitions", async () => {
  const options = baseOptions();
  const before = snapshot(options.model);
  const first = await api().simplifyStaticM2(options);
  const second = await api().simplifyStaticM2(baseOptions());
  assert.ok(first, "valid static exterior M2 must produce a low profile");
  assert.ok(second);
  assert.equal(Object.isFrozen(first), true);
  assertValidTopology(first);
  assertBatchMetadata(first, options.model);
  assertSeamsPreserved(first);
  assert.ok(first.indices.length / 3 > 0);
  assert.ok(first.indices.length / 3 <= TARGET_TRIANGLES);
  assert.ok(first.indices.length < options.model.indices.length, "target reduction must be meaningful");
  assert.equal(first.sourceTriangleCount, 16, "source triangle count must describe the unique submesh source ranges");
  assert.equal(first.uniqueSourceTriangleCount, 16, "unique source submesh triangles must not be confused with draw refs");
  assert.equal(first.sourceDrawTriangleCount, 16, "source draw triangles must count this fixture's one-to-one batches");
  assert.equal(first.drawTriangleCount, first.triangleCount, "output draw triangles must equal the profile triangle count here");
  assert.equal(first.drawTriangleCount,
    first.submeshes.reduce((sum, submesh) => sum + submesh.indexCount, 0) / 3,
    "output draw triangles must equal the sum of output batch ranges");
  assert.deepEqual(first.bounds, options.model.bounds, "HLOD bounds stay conservative for admission/culling");
  assert.notEqual(first.positions, options.model.positions);
  assert.notEqual(first.normals, options.model.normals);
  assert.notEqual(first.uv0, options.model.uv0);
  assert.notEqual(first.uv1, options.model.uv1);
  assert.notEqual(first.indices, options.model.indices);
  assert.notEqual(first.submeshes, options.model.submeshes);
  assert.notEqual(first.batches, options.model.batches);
  assert.notEqual(first.bounds, options.model.bounds);
  assert.deepEqual(snapshot(options.model), before, "source parsed M2 streams and metadata were mutated");
  assert.deepEqual([...first.bytes], [...second.bytes], "identical input/options must serialize byte-identically");
  assert.equal(first.profileId, second.profileId);
  assert.equal(first.modelSha1, MODEL_SHA1);
  assert.deepEqual(first.sourceStamp, SOURCE_STAMP);
});

test("simplifier identity includes source hash, exact stamp, target, and algorithm version", async () => {
  const base = await simplify();
  assert.ok(base);
  const changedHash = await simplify({ modelSha1: "fedcba9876543210fedcba9876543210fedcba98" });
  const changedStamp = await simplify({ sourceStamp: { ...SOURCE_STAMP, chain: "r4-other-chain" } });
  const changedTarget = await simplify({ targetTriangles: 14 });
  const changedVersion = await simplify({ algorithmVersion: "r4.0b-test-v2" });
  for (const variant of [changedHash, changedStamp, changedTarget, changedVersion]) {
    assert.ok(variant);
    assert.notEqual(variant.profileId, base.profileId, "cache/profile identity omitted a source or option dimension");
  }
});

test("malformed streams, topology, bounds, and impossible target fail closed", async () => {
  const malformed = [];
  const invalidIndex = cloneModel(gridMesh());
  invalidIndex.indices[0] = 999;
  malformed.push([invalidIndex, "invalid index"]);
  const invalidSubmesh = cloneModel(gridMesh());
  invalidSubmesh.submeshes[0].indexStart = 999;
  malformed.push([invalidSubmesh, "invalid submesh range"]);
  const invalidBatch = cloneModel(gridMesh());
  invalidBatch.batches[1].submesh = 99;
  malformed.push([invalidBatch, "invalid batch reference"]);
  const mismatched = cloneModel(gridMesh());
  mismatched.uv0 = new Float32Array(2);
  malformed.push([mismatched, "mismatched UV stream"]);
  const nonFinite = cloneModel(gridMesh());
  nonFinite.positions[0] = Number.NaN;
  malformed.push([nonFinite, "non-finite position"]);
  const degenerate = cloneModel(gridMesh());
  degenerate.indices[0] = degenerate.indices[1];
  malformed.push([degenerate, "degenerate triangle"]);
  const nonManifold = cloneModel(gridMesh());
  nonManifold.indices = new Uint16Array([...nonManifold.indices, ...nonManifold.indices.slice(24, 27)]);
  nonManifold.submeshes[1].indexCount += 3;
  malformed.push([nonManifold, "non-manifold edge"]);
  const invalidBounds = cloneModel(gridMesh());
  invalidBounds.bounds.max[0] = Number.NaN;
  malformed.push([invalidBounds, "invalid bounds"]);
  for (const [model, message] of malformed) {
    await rejected(() => simplify({ model }), `${message} must not produce an HLOD`);
  }
  await rejected(() => simplify({ targetTriangles: 1 }), "target below one triangle per batch must fail closed");
  await rejected(() => simplify({ targetTriangles: 0 }), "zero target must fail closed");
  await rejected(() => simplify({ targetTriangles: Number.NaN }), "NaN target must fail closed");
});

test("R4.0b rejects WVM9-losing metadata, dangling track refs, and non-conservative bounds", async () => {
  const tooManyTextureUnits = cloneModel(gridMesh());
  tooManyTextureUnits.textures.push({ type: 0, filename: "World\\Texture\\Third.blp" });
  tooManyTextureUnits.batches[0].textures = [0, 1, 2];
  tooManyTextureUnits.batches[0].uvSets = [0, 1, 0];
  await rejected(() => simplify({ model: tooManyTextureUnits }),
    "WVM9-incompatible third texture unit must fail closed");

  const danglingColour = cloneModel(gridMesh());
  danglingColour.colours = [];
  danglingColour.batches[0].colorIndex = 0;
  await rejected(() => simplify({ model: danglingColour }),
    "colorIndex into an empty colour table must fail closed");

  const danglingWeight = cloneModel(gridMesh());
  danglingWeight.textureWeights = [];
  danglingWeight.batches[0].textureWeight = 0;
  await rejected(() => simplify({ model: danglingWeight }),
    "textureWeight into an empty table must fail closed");

  const danglingTransform = cloneModel(gridMesh());
  danglingTransform.textureTransforms = [];
  danglingTransform.batches[0].textureTransform = 0;
  await rejected(() => simplify({ model: danglingTransform }),
    "textureTransform into an empty table must fail closed");

  const nonContainingBounds = cloneModel(gridMesh());
  nonContainingBounds.bounds = { min: [0, 0, 0], max: [0.1, 0.1, 0.1], radius: 0.1 };
  await rejected(() => simplify({ model: nonContainingBounds }),
    "bounds that do not contain referenced vertices must fail closed");

  const floatOverflowBounds = cloneModel(gridMesh());
  floatOverflowBounds.bounds.max[0] = 1e39;
  await rejected(() => simplify({ model: floatOverflowBounds }),
    "finite JS bounds outside Float32 range must fail closed");

  assert.ok(await simplify(), "sentinel color/weight/transform references remain valid");
});

test("skinned, animated, emitter, composite, legacy, non-M2, and non-exterior inputs are excluded", async () => {
  const exclusions = [
    ["kind", "wmo"],
    ["kind", "unknown"],
    ["staticModel", false],
    ["exterior", false],
    ["interior", true],
    ["skinned", true],
    ["animated", true],
    ["particleEmitters", true],
    ["ribbonEmitters", true],
    ["composite", true],
    ["legacy", true],
  ];
  for (const [field, value] of exclusions) {
    await rejected(() => simplify({ [field]: value }), `${field}=${String(value)} must be excluded`);
  }
  const weighted = cloneModel(gridMesh());
  weighted.boneWeights[0] = 255;
  await rejected(() => simplify({ model: weighted }), "non-zero bone weights must be excluded");
  const emitting = cloneModel(gridMesh());
  emitting.unsupported.particleEmitters = 1;
  await rejected(() => simplify({ model: emitting }), "parsed particle emitters must be excluded");
  const translucent = cloneModel(gridMesh());
  translucent.batches[1].blendMode = 1;
  await rejected(() => simplify({ model: translucent }), "non-opaque blend mode must be excluded");
});

test("source/resource access is not part of pure simplification", async () => {
  const options = baseOptions();
  for (const property of ["resource", "rawModel"]) {
    Object.defineProperty(options.model, property, {
      configurable: true,
      enumerable: true,
      get() { throw new Error(`unknown model field was enumerated: ${property}`); },
    });
  }
  Object.defineProperty(options, "archives", {
    configurable: true,
    get() { throw new Error("archive lookup is forbidden in offline simplification"); },
  });
  Object.defineProperty(options, "loadResource", {
    configurable: true,
    get() { throw new Error("resource lookup is forbidden in offline simplification"); },
  });
  const result = await api().simplifyStaticM2(options);
  assert.ok(result);
});

test("R4.0b stays offline while terrain streaming keeps its visible and dependency rings", async () => {
  const generator = await readFile(new URL("../tools/generate-visual-model.mjs", import.meta.url), "utf8");
  const terrain = await readFile(new URL("../src/browser/Terrain.ts", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(generator, /00\.skin/, "existing generator keeps the high/full profile");
  assert.doesNotMatch(generator, /01\.skin|02\.skin|simplifyStaticM2|m2-lod/i,
    "R4.0b must not wire generated HLOD into the model generator yet");
  assert.match(terrain, /ENVIRONMENT_RANGE\s*=\s*400/);
  const { TerrainStreamingWindow } = await import("../dist/code/browser/TerrainStreaming.js");
  const plan = new TerrainStreamingWindow().update(0, 0, 0, false);
  assert.equal(plan.visible.length, 9, "foreground terrain remains 3x3");
  assert.equal(plan.dependencies.length, 25, "CPU sampling retains a 5x5 dependency ring");
  assert.match(renderer, /terrainClient\?\.setActiveTiles\(map, plan\.dependencies\);/,
    "renderer pins the planned CPU dependencies");
  assert.match(renderer, /const grids = plan\.visible;/,
    "renderer draws only the visible ring");
  assert.doesNotMatch(renderer, /simplifyStaticM2|M2Hlod|m2-lod/i,
    "R4.0b must not wire runtime low-skin/HLOD selection");
});
