import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const { auditM2RigEligibility } = await import("../tools/audit-m2-rig-eligibility.mjs");

const PREFIX = "World\\Creature\\R4Rig";
const MODEL_A = `${PREFIX}\\SameBone.m2`;
const MODEL_B = `${PREFIX}\\RigidMulti.m2`;
const MODEL_C = `${PREFIX}\\MultiInfluence.m2`;
const MODEL_D = `${PREFIX}\\AllZero.m2`;
const MODEL_E = `${PREFIX}\\Invalid.m2`;
const MODEL_F = `${PREFIX}\\DynamicMaterial.m2`;
const MODEL_G = `${PREFIX}\\Attachment.m2`;
const MODEL_H = `${PREFIX}\\MissingSkin.m2`;
const MODEL_I = `${PREFIX}\\DifferentConstants.m2`;
const MODEL_J = `${PREFIX}\\MissingKind.m2`;
const MODEL_K = `${PREFIX}\\BadWeightSum.m2`;
const MODEL_L = `${PREFIX}\\BadBoneIndex.m2`;
const MODEL_M = `${PREFIX}\\MalformedUnsupported.m2`;

function constantChannel(bone, kind, value = 0) {
  return { bone, kind, times: Uint32Array.from([0]), values: Float32Array.from([value]) };
}

function fullPose(bones, clipCount = 1) {
  return {
    bones: bones.map(() => ({})),
    clips: Array.from({ length: clipCount }, () => ({
      channels: bones.flatMap((bone) => [0, 1, 2].map((kind) => constantChannel(bone, kind))),
    })),
    attachments: [],
  };
}

function baseParsed({ weights, indices, batches, colours = [], textureWeights = [], textureTransforms = [], unsupported } = {}) {
  return {
    boneWeights: Uint8Array.from(weights),
    boneIndices: Uint8Array.from(indices),
    batches: batches ?? [{ blendMode: 0, colorIndex: 0xffff, textureWeight: -1, textureTransform: -1 }],
    colours,
    textureWeights,
    textureTransforms,
    unsupported: unsupported ?? { particleEmitters: 0, ribbonEmitters: 0, events: 0, globalLoops: 0 },
  };
}

const records = new Map([
  [MODEL_A, {
    parsed: baseParsed({ weights: [255, 0, 0, 0, 255, 0, 0, 0], indices: [0, 0, 0, 0, 0, 0, 0, 0] }),
    skeleton: fullPose([0]),
  }],
  [MODEL_B, {
    parsed: baseParsed({ weights: [255, 0, 0, 0, 255, 0, 0, 0], indices: [0, 0, 0, 0, 1, 0, 0, 0] }),
    skeleton: {
      bones: [{}, {}],
      clips: [{ channels: [
        { bone: 0, kind: 0, times: Uint32Array.from([0, 1]), values: Float32Array.from([0, 1]) },
        constantChannel(0, 1), constantChannel(0, 2),
        constantChannel(1, 0), constantChannel(1, 1), constantChannel(1, 2),
      ] }],
      attachments: [],
    },
  }],
  [MODEL_C, {
    parsed: baseParsed({ weights: [128, 127, 0, 0], indices: [0, 1, 0, 0] }),
  }],
  [MODEL_D, {
    parsed: baseParsed({ weights: [0, 0, 0, 0], indices: [0, 0, 0, 0] }),
    skeleton: { clips: [], attachments: [] },
  }],
  [MODEL_E, { parseError: "malformed M2" }],
  [MODEL_F, {
    parsed: baseParsed({
      weights: [255, 0, 0, 0], indices: [0, 0, 0, 0],
      batches: [{ blendMode: 2, colorIndex: 0, textureWeight: 0, textureTransform: -1 }],
      colours: [{ rgb: { static: true }, alpha: { static: true } }],
      textureWeights: [{ times: Uint32Array.from([0, 1]), values: Float32Array.from([0, 1]) }],
    }),
    skeleton: fullPose([0]),
  }],
  [MODEL_G, {
    parsed: baseParsed({ weights: [255, 0, 0, 0], indices: [0, 0, 0, 0] }),
    skeleton: { ...fullPose([0]), attachments: [{ id: 1 }] },
  }],
  [MODEL_H, {
    parsed: baseParsed({ weights: [255, 0, 0, 0], indices: [0, 0, 0, 0] }),
    skeleton: fullPose([0]),
  }],
  [MODEL_I, {
    parsed: baseParsed({ weights: [255, 0, 0, 0], indices: [0, 0, 0, 0] }),
    skeleton: {
      bones: [{}],
      clips: [
        { channels: [constantChannel(0, 0, 0), constantChannel(0, 1), constantChannel(0, 2)] },
        { channels: [constantChannel(0, 0, 1), constantChannel(0, 1), constantChannel(0, 2)] },
      ],
      attachments: [],
    },
  }],
  [MODEL_J, {
    parsed: baseParsed({ weights: [255, 0, 0, 0], indices: [0, 0, 0, 0] }),
    skeleton: {
      bones: [{}],
      clips: [
        { channels: [constantChannel(0, 0), constantChannel(0, 1), constantChannel(0, 2)] },
        { channels: [constantChannel(0, 0), constantChannel(0, 1)] },
      ],
      attachments: [],
    },
  }],
  [MODEL_K, {
    parsed: baseParsed({ weights: [200, 0, 0, 0], indices: [0, 0, 0, 0] }),
    skeleton: fullPose([0]),
  }],
  [MODEL_L, {
    parsed: baseParsed({ weights: [255, 0, 0, 0], indices: [1, 0, 0, 0] }),
    skeleton: fullPose([0]),
  }],
  [MODEL_M, {
    parsed: baseParsed({
      weights: [255, 0, 0, 0], indices: [0, 0, 0, 0],
      unsupported: { particleEmitters: "1", ribbonEmitters: 0, events: 0, globalLoops: 0 },
    }),
    skeleton: fullPose([0]),
  }],
]);

const skinPath = (modelPath) => `${modelPath.slice(0, -3)}00.skin`;
const adtRecords = new Map([
  ["world\\maps\\r4rig\\a.adt", { placements: [
    { kind: "m2", name: MODEL_A }, { kind: "m2", name: MODEL_A },
    { kind: "m2", name: MODEL_B }, { kind: "m2", name: MODEL_C },
    { kind: "wmo", name: "World\\Generic\\House.wmo" },
  ] }],
  ["world\\maps\\r4rig\\b.adt", { placements: [
    { kind: "m2", name: MODEL_A }, { kind: "m2", name: MODEL_D },
    { kind: "m2", name: MODEL_E }, { kind: "m2", name: MODEL_F },
    { kind: "m2", name: MODEL_G }, { kind: "m2", name: MODEL_H },
    { kind: "m2", name: MODEL_I }, { kind: "m2", name: MODEL_J },
    { kind: "m2", name: MODEL_K }, { kind: "m2", name: MODEL_L },
    { kind: "m2", name: MODEL_M },
  ] }],
]);

function makeArchives(reverse = false) {
  const paths = [
    "World/Maps/R4Rig/a.adt", "WORLD\\MAPS\\R4RIG\\b.adt",
    ...[MODEL_A, MODEL_B, MODEL_C, MODEL_D, MODEL_E, MODEL_F, MODEL_G, MODEL_H,
      MODEL_I, MODEL_J, MODEL_K, MODEL_L, MODEL_M],
    ...[MODEL_A, MODEL_B, MODEL_C, MODEL_D, MODEL_E, MODEL_F, MODEL_G, MODEL_I,
      MODEL_J, MODEL_K, MODEL_L, MODEL_M].map(skinPath),
    "World\\Maps\\R4Rig\\readme.txt",
  ];
  const calls = [];
  let closed = false;
  const key = (path) => String(path).replaceAll("/", "\\").toLowerCase();
  const listedKeys = new Set(paths.map(key));
  const recordFor = (path) => [...records.entries()]
    .find(([modelPath]) => key(modelPath) === path)?.[1];
  return {
    calls,
    get closed() { return closed; },
    async list(prefix) {
      calls.push(["list", prefix]);
      return reverse ? [...paths].reverse() : paths;
    },
    async read(path) {
      calls.push(["read", path]);
      const canonical = key(path);
      if (adtRecords.has(canonical)) return adtRecords.get(canonical);
      if (canonical.endsWith(".m2")) {
        const record = recordFor(canonical);
        return record?.parseError ? { parseError: true } : record;
      }
      if (canonical.endsWith("00.skin") && listedKeys.has(canonical)) {
        return recordFor(`${canonical.slice(0, -7)}.m2`) ? { skin: true } : undefined;
      }
      return undefined;
    },
    close() { closed = true; },
  };
}

function parsers() {
  return {
    parseAdtPlacements: (data) => data.placements,
    parseM2: (data) => {
      if (data.parseError) throw new Error("malformed M2");
      return data.parsed;
    },
    m2Animations: () => [],
    parseM2Skeleton: (data) => data.skeleton,
  };
}

async function run(reverse = false, sampleCount = 100) {
  return auditM2RigEligibility({
    archives: makeArchives(reverse),
    parsers: parsers(),
    prefix: "World/Maps/",
    sampleCount,
    seed: "r4.0c-world-v1",
  });
}

test("classifies distinct direct ADT M2 models and fail-closes rigid eligibility", async () => {
  const result = await run();
  assert.equal(result.population.modelPaths, 13);
  assert.equal(result.models.length, 13);
  assert.deepEqual(result.aggregate.bonePatterns, {
    "all-zero": 1,
    "invalid": 4,
    "multi-influence": 1,
    "rigid-multi-bone": 1,
    "rigid-same-bone": 6,
  });
  assert.equal(result.aggregate.strictlyRigidBakeEligible, 2,
    "fully proven same-bone and all-zero geometry are eligible");
  const same = result.models.find((row) => row.modelPath === MODEL_A.toLowerCase());
  const varying = result.models.find((row) => row.modelPath === MODEL_B.toLowerCase());
  const dynamic = result.models.find((row) => row.modelPath === MODEL_F.toLowerCase());
  const attachment = result.models.find((row) => row.modelPath === MODEL_G.toLowerCase());
  const invalid = result.models.find((row) => row.modelPath === MODEL_E.toLowerCase());
  const different = result.models.find((row) => row.modelPath === MODEL_I.toLowerCase());
  const missingKind = result.models.find((row) => row.modelPath === MODEL_J.toLowerCase());
  const badSum = result.models.find((row) => row.modelPath === MODEL_K.toLowerCase());
  const badBone = result.models.find((row) => row.modelPath === MODEL_L.toLowerCase());
  const malformedUnsupported = result.models.find((row) => row.modelPath === MODEL_M.toLowerCase());
  assert.equal(same.channelProof, "constant");
  assert.equal(same.strictlyRigidBakeEligible, true);
  assert.equal(varying.channelProof, "mixed");
  assert.ok(varying.strictFailReasons.includes("channel:mixed"));
  assert.equal(dynamic.materialTracks, "varying");
  assert.ok(dynamic.strictFailReasons.includes("dynamicMaterialTracks"));
  assert.equal(attachment.attachmentCount, 1);
  assert.ok(attachment.strictFailReasons.includes("attachments"));
  assert.equal(invalid.bonePattern, "invalid");
  assert.ok(invalid.strictFailReasons.includes("invalid"));
  assert.equal(different.channelProof, "mixed");
  assert.ok(different.strictFailReasons.includes("channel:mixed"));
  assert.equal(missingKind.channelProof, "mixed");
  assert.ok(missingKind.strictFailReasons.includes("channel:mixed"));
  assert.equal(badSum.bonePattern, "invalid");
  assert.ok(badSum.weightInvalidReasons.includes("weightSum"));
  assert.ok(badSum.strictFailReasons.includes("weightSum"));
  assert.equal(badBone.boneIndexProof, "invalid");
  assert.deepEqual(badBone.invalidBoneIndices, [1]);
  assert.ok(badBone.strictFailReasons.includes("boneIndexOutOfRange"));
  assert.equal(malformedUnsupported.unsupportedMalformed, true);
  assert.ok(malformedUnsupported.strictFailReasons.includes("invalidUnsupportedCounts"));
  assert.equal(result.aggregate.unsupportedMalformed, 1);
  assert.equal(result.aggregate.channelProofs.undecodable, 1,
    "the multi-influence model has referenced bones but no decodable skeleton");
});

test("sample ordering and digest are independent of archive listing order", async () => {
  const forward = await run(false, 4);
  const reverse = await run(true, 4);
  assert.deepEqual(reverse.selectedModelPaths, forward.selectedModelPaths);
  assert.equal(reverse.populationDigest, forward.populationDigest);
  assert.equal(reverse.selectionDigest, forward.selectionDigest);
  assert.deepEqual(reverse.models, forward.models);
});

test("uses one empty-prefix listing, aggregates no instances, and never closes archives", async () => {
  const archives = makeArchives();
  const result = await auditM2RigEligibility({
    archives,
    parsers: parsers(),
    prefix: "World/Maps/",
    sampleCount: 2,
  });
  assert.deepEqual(archives.calls[0], ["list", ""]);
  assert.equal(archives.calls.filter(([kind]) => kind === "list").length, 1);
  assert.equal("placements" in result, false);
  assert.equal(archives.closed, false);
  assert.equal(result.population.directM2Placements, 15);
});

test("source stays offline and parser seams remain injectable", async () => {
  const source = await readFile(new URL("../tools/audit-m2-rig-eligibility.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /WorldRenderer3D|RenderAdmission|EnvironmentClient|BuiltModelCache|ResourceCache/);
  assert.match(source, /options\.parsers/);
  assert.match(source, /strictlyRigidBakeEligible/);
});
