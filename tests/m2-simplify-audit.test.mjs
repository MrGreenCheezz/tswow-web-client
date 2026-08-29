import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// R4.0b audit contract. Everything is injected so this test never opens F:\\Circle or any other
// real client archive:
//
//   auditM2Simplification({
//     archives: { list, read, sourceOf, chainDigest, close },
//     placements, simplifier, prefix, populationLimit, populationSeed,
//   }) -> { selectedModelPaths, populationDigest, entries, placementUnknown,
//            exteriorEligible, runtimeDecision, failReasons }.
//
// `simplifier({ modelPath, model, profilePaths, sourceStamp })` returns `{ full, low }`, where each
// side has `batches: [{ geometryId, material, order, triangles }]`, `bounds`, and WVM `bytes`.
// The audit owns neither the source buffers nor the injected archive and must remain read-only.
const auditImport = await import("../tools/audit-m2-simplify.mjs").catch((error) => ({ __error: error }));

const PREFIX = "World\\Creature\\R4Audit";
const MODEL_A = `${PREFIX}\\Alpha.m2`;
const MODEL_B = `${PREFIX}\\Bravo.m2`;
const MODEL_BAD = `${PREFIX}\\Broken.m2`;
const MODEL_PATHS = [MODEL_A, MODEL_B, MODEL_BAD];
const STAMP = Object.freeze({ chain: "audit-chain", sources: [], files: [] });

function auditApi() {
  if (auditImport.__error) throw auditImport.__error;
  assert.equal(typeof auditImport.auditM2Simplification, "function",
    "auditM2Simplification export is required");
  return auditImport.auditM2Simplification;
}

const bounds = Object.freeze({
  min: Object.freeze([0, 0, -1]),
  max: Object.freeze([4, 2, 1]),
  radius: 4.5,
});

function summary({ reduced = true } = {}) {
  return {
    full: {
      // geom-a is deliberately referenced by two draw batches. Batch metrics count both draws;
      // unique-geometry metrics must count geom-a once.
      batches: [
        { geometryId: "geom-a", material: "stone", order: 0, triangles: 4 },
        { geometryId: "geom-a", material: "stone", order: 1, triangles: 4 },
        { geometryId: "geom-b", material: "trim", order: 2, triangles: 2 },
      ],
      bounds,
      bytes: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    },
    low: reduced ? {
      batches: [
        { geometryId: "geom-a", material: "stone", order: 0, triangles: 2 },
        { geometryId: "geom-a", material: "stone", order: 1, triangles: 2 },
        { geometryId: "geom-b", material: "trim", order: 2, triangles: 1 },
      ],
      bounds,
      bytes: Uint8Array.from([9, 8, 7, 6]),
    } : undefined,
  };
}

const records = new Map([
  [MODEL_A, { path: MODEL_A, modelSha1: "sha-alpha", model: { id: "alpha" }, summary: summary() }],
  [MODEL_B, { path: MODEL_B, modelSha1: "sha-bravo", model: { id: "bravo" }, summary: summary() }],
  [MODEL_BAD, { path: MODEL_BAD, modelSha1: "sha-broken", model: { id: "broken" }, summary: {
    status: "invalid",
    failReasons: ["zeta-topology", "alpha-bounds", "batch-order"],
  } }],
]);

for (const modelPath of MODEL_PATHS) {
  for (const profile of ["00", "01", "02"]) {
    records.set(`${modelPath.slice(0, -3)}${profile}.skin`, {
      path: `${modelPath.slice(0, -3)}${profile}.skin`,
      modelPath,
      profile,
    });
  }
}

function makeArchives(order) {
  let closed = false;
  const calls = [];
  return {
    calls,
    get closed() { return closed; },
    async list(prefix = "") {
      calls.push(["list", prefix]);
      return order.filter((path) => path.startsWith(prefix));
    },
    async read(path) {
      calls.push(["read", path]);
      return records.get(path);
    },
    async sourceOf(path) {
      calls.push(["sourceOf", path]);
      return { path, size: path.length, mtimeMs: 1 };
    },
    chainDigest() {
      calls.push(["chainDigest"]);
      return STAMP.chain;
    },
    close() {
      closed = true;
    },
  };
}

function archiveListing(reverse = false) {
  const paths = [];
  for (const modelPath of MODEL_PATHS) {
    paths.push(modelPath);
    for (const profile of ["00", "01", "02"]) paths.push(`${modelPath.slice(0, -3)}${profile}.skin`);
  }
  return reverse ? paths.reverse() : paths;
}

function makeSimplifier() {
  const calls = [];
  return {
    calls,
    async simplify(options) {
      const modelPath = options.modelPath ?? options.model?.path;
      calls.push(modelPath);
      const record = records.get(modelPath);
      if (!record) throw new Error(`unknown model ${modelPath}`);
      return record.summary;
    },
  };
}

function placements() {
  return [
    { modelPath: MODEL_A, kind: "m2", exterior: true, staticModel: true },
    { modelPath: MODEL_B, kind: "m2", exterior: false, interior: true, staticModel: true },
  ];
}

async function run({ reverse = false, withPlacements = true, populationLimit = 2,
  placementRows = withPlacements ? placements() : [], prefix = PREFIX,
  candidateModelPaths } = {}) {
  const archives = makeArchives(archiveListing(reverse));
  const simplifier = makeSimplifier();
  const result = await auditApi()({
    archives,
    placements: placementRows,
    simplifier: simplifier.simplify,
    prefix,
    populationLimit,
    populationSeed: "r4-test-population",
    ...(candidateModelPaths === undefined ? {} : { candidateModelPaths }),
    sourceStamp: STAMP,
  });
  return { result, archives, simplifier };
}

function skinnedM2Fixture() {
  const model = Buffer.alloc(0x300);
  model.write("MD20", 0, "ascii");
  // One bone and no sequence: parseM2 still preserves the non-zero vertex weight, while the
  // existing animation-only eligibility pass incorrectly treats this as a static pose.
  model.writeUInt32LE(1, 0x2c);
  model.writeUInt32LE(0x230, 0x30);
  model.writeUInt32LE(3, 0x3c);
  model.writeUInt32LE(0x150, 0x40);
  model.writeUInt32LE(1, 0x50);
  model.writeUInt32LE(0x210, 0x54);
  model.writeUInt32LE(1, 0x70);
  model.writeUInt32LE(0x220, 0x74);
  // All optional tables remain empty and have valid zero-count descriptors.
  for (const offset of [0x14, 0x1c, 0x48, 0x58, 0x60, 0x80, 0x88, 0x90, 0x98,
    0xf0, 0x100, 0x110, 0x120, 0x128]) {
    model.writeUInt32LE(0, offset);
    model.writeUInt32LE(0, offset + 4);
  }
  const vertices = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  for (let index = 0; index < vertices.length; index++) {
    const at = 0x150 + index * 48;
    for (let axis = 0; axis < 3; axis++) model.writeFloatLE(vertices[index][axis], at + axis * 4);
    model.writeUInt8(index === 0 ? 255 : 0, at + 12);
    model.writeUInt8(0, at + 16);
    model.writeFloatLE(0, at + 20);
    model.writeFloatLE(0, at + 24);
    model.writeFloatLE(1, at + 28);
    model.writeFloatLE(vertices[index][0], at + 32);
    model.writeFloatLE(vertices[index][1], at + 36);
    model.writeFloatLE(vertices[index][0], at + 40);
    model.writeFloatLE(vertices[index][1], at + 44);
  }
  model.writeUInt32LE(0, 0x210);
  model.writeUInt32LE(0, 0x214);
  model.writeUInt32LE(0, 0x218);
  model.writeUInt32LE(0, 0x21c);
  model.writeUInt32LE(0, 0x220);
  model.writeUInt32LE(0, 0x224);
  for (const [offset, value] of [[0xa0, 0], [0xa4, 0], [0xa8, 0], [0xac, 1], [0xb0, 1],
    [0xb4, 0], [0xb8, 2]]) model.writeFloatLE(value, offset);

  const skin = Buffer.alloc(160);
  skin.write("SKIN", 0, "ascii");
  skin.writeUInt32LE(3, 4);
  skin.writeUInt32LE(48, 8);
  skin.writeUInt32LE(3, 12);
  skin.writeUInt32LE(54, 16);
  skin.writeUInt32LE(1, 28);
  skin.writeUInt32LE(64, 32);
  skin.writeUInt32LE(1, 36);
  skin.writeUInt32LE(112, 40);
  for (let index = 0; index < 3; index++) {
    skin.writeUInt16LE(index, 48 + index * 2);
    skin.writeUInt16LE(index, 54 + index * 2);
  }
  skin.writeUInt16LE(0, 64);
  skin.writeUInt16LE(0, 66);
  skin.writeUInt16LE(0, 68);
  skin.writeUInt16LE(3, 70);
  skin.writeUInt16LE(0, 72);
  skin.writeUInt16LE(3, 74);
  skin.writeFloatLE(1 / 3, 84);
  skin.writeFloatLE(1 / 3, 88);
  skin.writeFloatLE(0, 92);
  skin.writeFloatLE(1, 108);
  skin.writeUInt8(0, 112);
  skin.writeInt8(0, 113);
  skin.writeUInt16LE(0, 114);
  skin.writeUInt16LE(0, 116);
  skin.writeUInt16LE(0, 122);
  skin.writeUInt16LE(1, 126);
  skin.writeUInt16LE(0xffff, 128);
  skin.writeUInt16LE(0, 130);
  skin.writeUInt16LE(0xffff, 134);
  return { model, skin };
}

function makeSkinnedArchives() {
  const { model, skin } = skinnedM2Fixture();
  const modelPath = `${PREFIX}\\Rigged.m2`;
  const skinPath = `${PREFIX}\\Rigged00.skin`;
  const calls = [];
  return {
    calls,
    async list(prefix) {
      calls.push(["list", prefix]);
      return [modelPath, skinPath].filter((path) => path.startsWith(prefix));
    },
    async read(path) {
      calls.push(["read", path]);
      if (path === modelPath) return model;
      if (path === skinPath) return skin;
      return undefined;
    },
  };
}

test("listing order cannot change hash-selected paths or population digest", async () => {
  const forward = await run();
  const reverse = await run({ reverse: true });
  assert.deepEqual(reverse.result.selectedModelPaths, forward.result.selectedModelPaths);
  assert.equal(reverse.result.populationDigest, forward.result.populationDigest);
  assert.equal(forward.archives.closed, false, "audit must not close an injected shared archive");
  assert.equal(reverse.archives.closed, false, "audit must not close an injected shared archive");
});

test("candidateModelPaths restricts the listed M2+00.skin population before hash sampling", async () => {
  const candidates = [MODEL_B.toUpperCase(), `${PREFIX}\\Missing.m2`];
  const forward = await run({ candidateModelPaths: candidates, populationLimit: 1 });
  const reverse = await run({ reverse: true, candidateModelPaths: candidates, populationLimit: 1 });
  assert.deepEqual(forward.result.selectedModelPaths, [MODEL_B]);
  assert.equal(forward.result.population.listedWith00SkinCount, 1);
  assert.equal(forward.result.population.selectedCount, 1);
  assert.deepEqual(reverse.result.selectedModelPaths, forward.result.selectedModelPaths);
  assert.equal(reverse.result.populationDigest, forward.result.populationDigest);
  assert.equal(forward.result.selectedModelPaths.includes(`${PREFIX}\\Missing.m2`), false,
    "unlisted candidate paths must be ignored or reported, never sampled");
});

test("no placements are reported as unknown and cannot become exterior-eligible", async () => {
  const { result } = await run({ withPlacements: false, populationLimit: MODEL_PATHS.length });
  assert.equal(result.placementUnknown, MODEL_PATHS.length);
  assert.equal(result.exteriorEligible, 0);
  assert.equal(result.runtimeDecision, "insufficient-data");
});

test("dynamic M2 placement is excluded with a stable placementDynamic reason", async () => {
  const { result } = await run({
    populationLimit: MODEL_PATHS.length,
    placementRows: [{ modelPath: MODEL_A, kind: "m2", exterior: true, staticModel: false }],
  });
  const entry = result.entries.find((candidate) => candidate.modelPath === MODEL_A);
  assert.ok(entry);
  assert.equal(entry.eligibility, "excluded");
  assert.ok(entry.failReasons.includes("placementDynamic"));
});

test("M2 without explicit exterior=true is not eligible even when interior=false", async () => {
  const { result } = await run({
    populationLimit: MODEL_PATHS.length,
    placementRows: [{ modelPath: MODEL_A, kind: "m2", interior: false, staticModel: true }],
  });
  const entry = result.entries.find((candidate) => candidate.modelPath === MODEL_A);
  assert.ok(entry);
  assert.notEqual(entry.eligibility, "eligible");
  assert.ok(!entry.placement.known || entry.placement.reasons.length > 0,
    "missing explicit exterior evidence must not be treated as an exterior placement");
});

test("unknown, dynamic, and non-exterior placements never invoke the simplifier", async () => {
  const cases = [
    {
      label: "unknown",
      placement: { modelPath: MODEL_A, kind: "unknown", exterior: true, staticModel: true },
    },
    {
      label: "dynamic",
      placement: { modelPath: MODEL_A, kind: "m2", exterior: true, staticModel: false },
    },
    {
      label: "non-exterior",
      placement: { modelPath: MODEL_A, kind: "m2", exterior: false, interior: false, staticModel: true },
    },
  ];

  for (const { label, placement } of cases) {
    const { result, simplifier } = await run({
      populationLimit: MODEL_PATHS.length,
      placementRows: [placement],
    });
    const entry = result.entries.find((candidate) => candidate.modelPath === MODEL_A);
    assert.ok(entry, `${label} placement should produce an audit entry`);
    assert.equal(entry.eligibility, "excluded", `${label} placement must be excluded`);
    assert.equal(simplifier.calls.includes(MODEL_A), false,
      `${label} placement must not invoke the injected simplifier`);
  }
});

test("leading slash prefixes are normalized before archive listing", async () => {
  for (const prefix of [`/${PREFIX}`, `\\${PREFIX}`]) {
    const { result, archives } = await run({ prefix, populationLimit: MODEL_PATHS.length });
    assert.equal(archives.calls[0][0], "list");
    assert.equal(archives.calls[0][1], `${PREFIX}\\`);
    assert.equal(result.population.listedWith00SkinCount, MODEL_PATHS.length);
  }
});

test("parsed non-zero bone weights are stable skinnedGeometry and never reach the simplifier", async () => {
  const archives = makeSkinnedArchives();
  let simplifyCalls = 0;
  const modelPath = `${PREFIX}\\Rigged.m2`;
  const result = await auditApi()({
    archives,
    placements: [{ modelPath, kind: "m2", exterior: true, staticModel: true }],
    simplify: async () => {
      simplifyCalls++;
      throw new Error("skinned geometry must be excluded before simplification");
    },
    prefix: PREFIX,
    populationLimit: 1,
    populationSeed: "r4-skinned-test",
    sourceStamp: STAMP,
  });
  const entry = result.entries[0];
  assert.equal(entry.modelPath, modelPath);
  assert.equal(entry.eligibility, "excluded");
  assert.ok(entry.failReasons.includes("skinnedGeometry"));
  assert.equal(simplifyCalls, 0, "non-zero parsed bone weights must short-circuit before simplifier");
  assert.equal(entry.baseline.rawSourceTriangleCount, entry.baseline.sourceTriangleCount,
    "raw source triangles need an explicit metric name");
});

test("batch-drawn and unique-geometry metrics are exact, and compare checks preservation/deltas", async () => {
  const { result } = await run({ populationLimit: MODEL_PATHS.length });
  const entry = result.entries.find((candidate) => candidate.modelPath === MODEL_A);
  assert.ok(entry, "the hash-selected population must contain Alpha for this fixed seed");
  assert.deepEqual(entry.metrics.full, {
    batchDrawnTriangles: 10,
    uniqueGeometryTriangles: 6,
    wvmBytes: 8,
  });
  assert.deepEqual(entry.metrics.low, {
    batchDrawnTriangles: 5,
    uniqueGeometryTriangles: 3,
    wvmBytes: 4,
  });
  assert.deepEqual(entry.compare, {
    batchMaterialOrderPreserved: true,
    boundsPreserved: true,
    batchDrawnTriangleDelta: 5,
    uniqueGeometryTriangleDelta: 3,
    wvmByteDelta: 4,
  });
});

test("failure reasons are stable-sorted independently of archive listing order", async () => {
  const forward = await run({ populationLimit: MODEL_PATHS.length });
  const reverse = await run({ reverse: true, populationLimit: MODEL_PATHS.length });
  assert.deepEqual(forward.result.failReasons, ["alpha-bounds", "batch-order", "zeta-topology"]);
  assert.deepEqual(reverse.result.failReasons, forward.result.failReasons);
});

test("audit source stays offline and does not import runtime renderer/cache or close archives", async () => {
  const source = await readFile(new URL("../tools/audit-m2-simplify.mjs", import.meta.url), "utf8");
  assert.match(source, /export\s+async\s+function\s+auditM2Simplification/);
  assert.doesNotMatch(source, /from ["'][^"']*(WorldRenderer3D|RenderAdmission|EnvironmentClient|BuiltModelCache|ResourceCache)/,
    "audit must not depend on runtime renderer/admission/cache");
  assert.doesNotMatch(source, /(?:archives|chain)\s*\.\s*close\s*\(/,
    "audit must leave its injected/shared archive open");
});
