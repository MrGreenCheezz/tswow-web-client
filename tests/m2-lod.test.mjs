import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// R4.0a contract under test (the implementation is intentionally not wired into the renderer):
//
//   inspectM2SkinProfile({ modelPath, profile, model, skin, sourceStamp })
//     -> immutable profile metadata, or undefined/throws on malformed input.
//   createM2LodDescriptor(profiles)
//     -> immutable { modelPath, modelSha1, sourceStamp, full, low?, profiles }.
//   selectM2LodProfile(descriptor, {
//     enabled, distance, fogFar, kind, staticModel, interior, skinned, animated,
//     particleEmitters, ribbonEmitters, composite, legacy,
//   }) -> the selected profile, or undefined when the opt-in policy cannot prove eligibility.
//
// Keeping the import dynamic lets the source-contract tests run while the new offline helper is
// absent. The focused run is expected to be RED until tools/m2-lod.mjs is implemented.
const lodImport = await import("../tools/m2-lod.mjs").catch((error) => ({ __error: error }));

const MODEL_PATH = "World\\Creature\\R4Demo\\R4Demo.m2";
const SOURCE_STAMP = Object.freeze({
  chain: "r4-test-chain",
  sources: [{ path: MODEL_PATH, size: 1234, mtimeMs: 1 }],
  files: [],
});
const MODEL_VERTEX_OFFSET = 512;
const MODEL_VERTEX_COUNT = 12;

function deepEqualStamp(actual, expected) {
  assert.deepEqual(actual, expected);
  return true;
}

function modelBuffer({ views = 3, vertexCount = MODEL_VERTEX_COUNT, particleEmitters = 0, bones = 0, marker = 0 } = {}) {
  const model = Buffer.alloc(MODEL_VERTEX_OFFSET + vertexCount * 48);
  model.write("MD20", 0, "ascii");
  model.writeUInt32LE(264, 4);
  model.writeUInt32LE(marker, 0x10);
  // The parser does not currently consume this slot, but R4.0a must validate it before accepting
  // 01.skin/02.skin: a sidecar profile is only valid when its view exists in the parent M2.
  model.writeUInt32LE(views, 0x44);
  model.writeUInt32LE(vertexCount, 0x3c);
  model.writeUInt32LE(MODEL_VERTEX_OFFSET, 0x40);
  model.writeUInt32LE(bones, 0x2c);
  model.writeUInt32LE(particleEmitters, 0x128);
  model.writeFloatLE(-4, 0xa0);
  model.writeFloatLE(-4, 0xa4);
  model.writeFloatLE(-4, 0xa8);
  model.writeFloatLE(4, 0xac);
  model.writeFloatLE(4, 0xb0);
  model.writeFloatLE(4, 0xb4);
  model.writeFloatLE(8, 0xb8);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const at = MODEL_VERTEX_OFFSET + vertex * 48;
    model.writeFloatLE(vertex % 4, at);
    model.writeFloatLE(Math.floor(vertex / 4), at + 4);
    model.writeFloatLE(0, at + 8);
    model.writeFloatLE(0, at + 20);
    model.writeFloatLE(0, at + 24);
    model.writeFloatLE(1, at + 28);
    model.writeFloatLE((vertex % 4) / 3, at + 32);
    model.writeFloatLE((Math.floor(vertex / 4) % 3) / 2, at + 36);
  }
  return model;
}

function skinBuffer({
  lookupCount = 12,
  triangleCount = 12,
  submeshIndexCount = triangleCount,
  lookup = [],
  triangles = [],
} = {}) {
  const lookupOffset = 48;
  const triangleOffset = lookupOffset + lookupCount * 2;
  const submeshOffset = triangleOffset + triangleCount * 2;
  const batchOffset = submeshOffset + 48;
  const skin = Buffer.alloc(batchOffset + 24);
  skin.write("SKIN", 0, "ascii");
  skin.writeUInt32LE(lookupCount, 0x04);
  skin.writeUInt32LE(lookupOffset, 0x08);
  skin.writeUInt32LE(triangleCount, 0x0c);
  skin.writeUInt32LE(triangleOffset, 0x10);
  skin.writeUInt32LE(1, 0x1c);
  skin.writeUInt32LE(submeshOffset, 0x20);
  skin.writeUInt32LE(1, 0x24);
  skin.writeUInt32LE(batchOffset, 0x28);
  for (let index = 0; index < lookupCount; index++) {
    skin.writeUInt16LE(lookup[index] ?? index, lookupOffset + index * 2);
  }
  for (let index = 0; index < triangleCount; index++) {
    skin.writeUInt16LE(triangles[index] ?? (index % Math.max(1, lookupCount)), triangleOffset + index * 2);
  }
  skin.writeUInt16LE(0, submeshOffset);
  skin.writeUInt16LE(0, submeshOffset + 2); // Level: high indexStart bits.
  skin.writeUInt16LE(0, submeshOffset + 4);
  skin.writeUInt16LE(lookupCount, submeshOffset + 6);
  skin.writeUInt16LE(0, submeshOffset + 8);
  skin.writeUInt16LE(submeshIndexCount, submeshOffset + 10);
  skin.writeFloatLE(0, submeshOffset + 20);
  skin.writeFloatLE(0, submeshOffset + 24);
  skin.writeFloatLE(0, submeshOffset + 28);
  skin.writeFloatLE(1, submeshOffset + 44);
  skin.writeUInt8(0, batchOffset);
  skin.writeUInt16LE(0, batchOffset + 4); // submesh
  skin.writeUInt16LE(1, batchOffset + 14); // one texture unit
  skin.writeUInt16LE(0, batchOffset + 16); // texture combo
  skin.writeUInt16LE(0xffff, batchOffset + 20);
  skin.writeUInt16LE(0xffff, batchOffset + 22);
  return skin;
}

function canonicalProfilePath(suffix) {
  return `${MODEL_PATH.slice(0, -3)}${String(suffix).padStart(2, "0")}.skin`;
}

function profileFixture(suffix, triangleCount, options = {}) {
  const model = modelBuffer(options);
  const skin = skinBuffer({
    lookupCount: options.lookupCount ?? 12,
    triangleCount,
    submeshIndexCount: options.submeshIndexCount,
    lookup: options.lookup,
    triangles: options.triangles,
  });
  return {
    model,
    skin,
    suffix,
    profilePath: canonicalProfilePath(suffix),
  };
}

function api() {
  if (lodImport.__error) throw lodImport.__error;
  for (const name of ["inspectM2SkinProfile", "createM2LodDescriptor", "selectM2LodProfile"]) {
    assert.equal(typeof lodImport[name], "function", `R4.0a export ${name} is required`);
  }
  return lodImport;
}

function inspect(fixture, extra = {}) {
  return api().inspectM2SkinProfile({
    modelPath: MODEL_PATH,
    profile: String(fixture.suffix).padStart(2, "0"),
    model: fixture.model,
    skin: fixture.skin,
    sourceStamp: SOURCE_STAMP,
    ...extra,
  });
}

function rejected(call, message) {
  if (lodImport.__error) throw lodImport.__error;
  try {
    const value = call();
    assert.equal(value, undefined, message);
  } catch {
    // Either undefined or a deliberate validation exception is a fail-closed rejection.
  }
}

function descriptor(profiles, extra = {}) {
  if (Object.keys(extra).length > 0) return api().createM2LodDescriptor(profiles, extra);
  return api().createM2LodDescriptor(profiles);
}

function select(value, context = {}) {
  return api().selectM2LodProfile(value, {
    distance: 300,
    fogFar: 1200,
    kind: "m2",
    enabled: true,
    staticModel: true,
    interior: false,
    skinned: false,
    animated: false,
    particleEmitters: false,
    ribbonEmitters: false,
    composite: false,
    legacy: false,
    ...context,
  });
}

test("canonical 00/01/02 profiles validate against the parent M2 view count", () => {
  const fixtures = [
    profileFixture(0, 36),
    profileFixture(1, 18),
    profileFixture(2, 9),
  ];
  const profiles = fixtures.map((fixture) => inspect(fixture));
  assert.deepEqual(profiles.map((profile) => profile.profilePath), fixtures.map((fixture) => fixture.profilePath));
  assert.deepEqual(profiles.map((profile) => profile.profile), ["00", "01", "02"]);
  assert.deepEqual(profiles.map((profile) => profile.triangleCount), [12, 6, 3]);
  assert.deepEqual(profiles.map((profile) => profile.sourceTriangleCount), [12, 6, 3]);
  assert.deepEqual(profiles.map((profile) => profile.indexCount), [36, 18, 9]);
  assert.ok(profiles.every((profile) => profile.vertexCount === 12));
  assert.ok(profiles.every((profile) => profile.modelPath === MODEL_PATH));
  assert.ok(profiles.every((profile) => deepEqualStamp(profile.sourceStamp, SOURCE_STAMP)));

  const oneView = profileFixture(1, 18, { views: 1 });
  rejected(() => inspect(oneView), "01.skin must not be accepted when parent M2 declares only one view");
  const twoViews = profileFixture(2, 9, { views: 2 });
  rejected(() => inspect(twoViews), "02.skin must not be accepted when parent M2 declares only two views");
});

test("drawn triangles come from authored batch/submesh ranges, not the shared raw index table", () => {
  const full = inspect(profileFixture(0, 36));
  const low = inspect(profileFixture(1, 36, { submeshIndexCount: 18 }));
  assert.equal(full.indexCount, 36);
  assert.equal(low.indexCount, 36, "the authored raw triangle table may be shared across views");
  assert.equal(full.sourceTriangleCount, 12);
  assert.equal(low.sourceTriangleCount, 12);
  assert.equal(full.triangleCount, 12);
  assert.equal(low.triangleCount, 6, "ModelBuild submits only the batch's submesh range");
  assert.equal(descriptor([full, low]).low, low);
});

test("SKIN structural limits, offsets, and index bounds fail closed", () => {
  const valid = profileFixture(0, 12);

  const badLookupCount = Buffer.from(valid.skin);
  badLookupCount.writeUInt32LE(1_000_001, 0x04);
  rejected(() => inspect({ ...valid, skin: badLookupCount }), "lookup count overflow must reject");

  const badTriangleCount = Buffer.from(valid.skin);
  badTriangleCount.writeUInt32LE(6_000_001, 0x0c);
  rejected(() => inspect({ ...valid, skin: badTriangleCount }), "triangle count overflow must reject");

  const nonTriangles = Buffer.from(valid.skin);
  nonTriangles.writeUInt32LE(4, 0x0c);
  rejected(() => inspect({ ...valid, skin: nonTriangles }), "triangle table length must be divisible by three");

  const badLookupOffset = Buffer.from(valid.skin);
  badLookupOffset.writeUInt32LE(badLookupOffset.length - 1, 0x08);
  rejected(() => inspect({ ...valid, skin: badLookupOffset }), "lookup offset outside SKIN must reject");

  const badTriangleIndex = profileFixture(0, 12, { triangles: [0, 1, 99], parse: false });
  rejected(() => inspect(badTriangleIndex), "triangle index outside the local lookup must reject");

  const badGlobalIndex = profileFixture(0, 12, { lookup: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99], parse: false });
  rejected(() => inspect(badGlobalIndex), "lookup vertex outside parent M2 must reject");

  const badSubmeshRange = Buffer.from(valid.skin);
  const submeshOffset = badSubmeshRange.readUInt32LE(0x20);
  badSubmeshRange.writeUInt16LE(11, submeshOffset + 8);
  badSubmeshRange.writeUInt16LE(6, submeshOffset + 10);
  rejected(() => inspect({ ...valid, skin: badSubmeshRange }), "submesh index range outside triangles must reject");

  const badBatchTable = Buffer.from(valid.skin);
  badBatchTable.writeUInt32LE(badBatchTable.length - 8, 0x28);
  rejected(() => inspect({ ...valid, skin: badBatchTable }), "batch table offset/stride overflow must reject");

  const noSubmeshes = Buffer.from(valid.skin);
  noSubmeshes.writeUInt32LE(0, 0x1c);
  rejected(() => inspect({ ...valid, skin: noSubmeshes }), "a profile with no submeshes must reject");

  const noBatches = Buffer.from(valid.skin);
  noBatches.writeUInt32LE(0, 0x24);
  rejected(() => inspect({ ...valid, skin: noBatches }), "a profile with no drawable batches must reject");
});

test("descriptor is immutable, source-bound, and proves strict full-vs-low reduction", () => {
  const fixtures = [profileFixture(0, 36), profileFixture(1, 18), profileFixture(2, 9)];
  const profiles = fixtures.map((fixture) => inspect(fixture));
  const lod = descriptor(profiles);
  assert.equal(Object.isFrozen(lod), true);
  assert.equal(Object.isFrozen(lod.profiles), true);
  assert.equal(Object.isFrozen(lod.sourceStamp), true);
  assert.equal(Object.isFrozen(lod.sourceStamp.sources), true);
  assert.deepEqual(lod.sourceStamp, SOURCE_STAMP);
  assert.equal(lod.modelPath, MODEL_PATH);
  assert.equal(lod.modelSha1, createHash("sha1").update(fixtures[0].model).digest("hex"));
  assert.equal(lod.profiles[0], profiles[0], "descriptor must preserve exact profile object identity");
  assert.equal(lod.full, profiles[0]);
  assert.equal(lod.low, profiles[1]);
  for (const profile of profiles) {
    assert.equal(profile.model, undefined, "profile metadata must not retain the source M2 bytes");
    assert.equal(profile.skin, undefined, "profile metadata must not retain the source SKIN bytes");
    assert.equal(profile.raw, undefined, "profile metadata must not retain a raw source wrapper");
  }
  assert.equal(lod.full.triangleCount, 12);
  assert.equal(lod.low.triangleCount, 6);
  assert.ok(lod.low.triangleCount < lod.full.triangleCount);
  assert.ok(lod.profiles.find((profile) => profile.profile === "02").triangleCount < lod.low.triangleCount);
  assert.throws(() => { lod.sourceStamp = "stale"; }, TypeError);

  const equalSize = profileFixture(1, 36);
  const equalDescriptor = descriptor([inspect(fixtures[0]), inspect(equalSize)]);
  assert.equal(equalDescriptor.low, undefined, "a non-reduced low profile must be ignored");
  const larger = profileFixture(1, 45);
  const largerDescriptor = descriptor([inspect(fixtures[0]), inspect(larger)]);
  assert.equal(largerDescriptor.low, undefined, "a larger low profile must be ignored");
  rejected(() => descriptor([inspect(fixtures[0]), inspect(profileFixture(1, 18, { marker: 1 }))]),
    "mismatched source identity must reject the descriptor");
});

test("pure opt-in policy uses strict near and mid boundaries", () => {
  const fixtures = [profileFixture(0, 36), profileFixture(1, 18), profileFixture(2, 9)];
  const lod = descriptor(fixtures.map((fixture) => inspect(fixture)));
  assert.equal(select(lod, { distance: 299.999 }).profile, "00", "near range remains full detail");
  assert.equal(select(lod, { distance: 300 }).profile, "01", "300 yards enters authored low range");
  assert.equal(select(lod, { distance: 599.999 }).profile, "01", "600-yard edge is not reached early");
  assert.equal(select(lod, { distance: 600 }), undefined, "600 yards is an exclusive mid-ring boundary");
  assert.equal(select(lod, { distance: 300, enabled: false }), undefined, "low skin is opt-in");
  assert.equal(select(lod, { distance: 300, fogFar: 299.999 }), undefined, "too-close fog disables mid LOD");
  assert.equal(select(lod, { distance: 300, fogFar: Number.NaN }), undefined, "unknown fog disables mid LOD");
  assert.equal(select(lod, { distance: 300, fogFar: undefined }), undefined, "missing fog disables mid LOD");
});

test("non-static or non-exterior categories fail closed without touching resources", () => {
  const fixtures = [profileFixture(0, 36), profileFixture(1, 18)];
  const lod = descriptor(fixtures.map((fixture) => inspect(fixture)));
  const rejectedContexts = [
    { kind: "wmo" },
    { interior: true },
    { staticModel: false },
    { skinned: true },
    { skinned: 1 },
    { animated: true },
    { animated: 1 },
    { particleEmitters: true },
    { particleEmitters: 1 },
    { ribbonEmitters: true },
    { composite: true },
    { composite: 1 },
    { kind: "legacy" },
    { legacy: 1 },
    { kind: "unknown" },
  ];
  for (const context of rejectedContexts) {
    assert.equal(select(lod, context), undefined, `ineligible context should return none: ${JSON.stringify(context)}`);
  }

  const resourcePoison = {
    kind: "m2",
    staticModel: true,
    interior: false,
    enabled: true,
  };
  for (const property of ["model", "texture", "resource", "wvm", "rendered", "object"]) {
    Object.defineProperty(resourcePoison, property, {
      configurable: true,
      get() { throw new Error(`resource lookup is forbidden: ${property}`); },
    });
  }
  assert.equal(select(lod, { object: resourcePoison, distance: 300 }).profile, "01",
    "selection must be pure and resource-independent");
});

test("offline audit names canonical authored profiles while generator remains 00-only", async () => {
  const audit = await readFile(new URL("../tools/audit-m2-lod.mjs", import.meta.url), "utf8");
  const generator = await readFile(new URL("../tools/generate-visual-model.mjs", import.meta.url), "utf8");
  assert.match(audit, /00\.skin/, "the offline audit must include the full authored profile");
  assert.match(audit, /01\.skin/, "the offline audit must include 01.skin");
  assert.match(audit, /02\.skin/, "the offline audit must include 02.skin");
  assert.match(generator, /00\.skin/, "R4.0a keeps the existing full-profile generator path");
  assert.doesNotMatch(generator, /01\.skin/, "R4.0a must not wire low skins into the generator yet");
  assert.doesNotMatch(generator, /02\.skin/, "R4.0a must not wire low skins into the generator yet");
});

test("R4.0a stays offline while terrain streaming retains its visible and dependency rings", async () => {
  const terrain = await readFile(new URL("../src/browser/Terrain.ts", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(terrain, /ENVIRONMENT_RANGE\s*=\s*400/);
  const { TerrainStreamingWindow } = await import("../dist/code/browser/TerrainStreaming.js");
  const plan = new TerrainStreamingWindow().update(0, 0, 0, false);
  assert.equal(plan.visible.length, 9, "foreground terrain remains 3x3");
  assert.equal(plan.dependencies.length, 25, "CPU sampling retains a 5x5 dependency ring");
  assert.match(renderer, /terrainClient\?\.setActiveTiles\(map, plan\.dependencies\);/,
    "renderer pins the planned CPU dependencies");
  assert.match(renderer, /const grids = plan\.visible;/,
    "renderer draws only the visible ring");
  assert.doesNotMatch(renderer, /selectM2LodProfile|createM2LodDescriptor|m2-lod/i,
    "R4.0a must not wire low-skin policy into runtime terrain/world streaming");
});
