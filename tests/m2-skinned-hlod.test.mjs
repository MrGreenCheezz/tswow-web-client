import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { encodeWvm9 } from "../tools/wvm.mjs";
import { decodeWvm9 } from "../dist/code/browser/Wvm.js";

// R4.1 is deliberately offline-only. The proposed first broadened geometry slice is:
//
//   simplifySkinnedM2({
//     modelPath, modelSha1, sourceStamp, model, skeleton, animations,
//     animationSources, animationBounds, effects, targetTriangles, algorithmVersion,
//     kind: "m2", exterior: true, interior: false, skinned: true, animated: true,
//     particleEmitters: false, ribbonEmitters: false, composite: false, legacy: false,
//   }) -> an immutable profile or undefined on any untrusted input.
//
// `model` and `skeleton` use the parse-side shapes from tools/m2.mjs. A profile owns fresh streams,
// preserves the complete rig/material contract, and carries a deterministic WVM9 `bytes` artifact.
// `animationSources` are already-resolved sidecar identities; this test never opens an archive.
const lodImport = await import("../tools/m2-skinned-lod.mjs").catch((error) => ({ __error: error }));

const MODEL_PATH = "World\\Creature\\R4Skinned\\R4Skinned.m2";
const MODEL_SHA1 = "0123456789abcdef0123456789abcdef01234567";
const ANIMATION_PATH = "World\\Creature\\R4Skinned\\R4Skinned-0004-00.anim";
const ANIMATION_SHA1 = "fedcba9876543210fedcba9876543210fedcba98";
const ALGORITHM_VERSION = "r4.1-skinned-test-v1";
const TARGET_TRIANGLES = 48;
const SOURCE_STAMP = Object.freeze({
  chain: "r4.1-model-chain",
  sources: [{ path: MODEL_PATH, size: 8192, mtimeMs: 1 }],
  files: [],
});
const ANIMATION_SOURCES = Object.freeze([{
  path: ANIMATION_PATH,
  sha1: ANIMATION_SHA1,
  stamp: Object.freeze({ size: 2048, mtimeMs: 2 }),
  animationIds: Object.freeze([4]),
}]);
const ANIMATION_BOUNDS = Object.freeze({
  min: Object.freeze([-1, -1, -1]),
  max: Object.freeze([12, 6, 2]),
  radius: 20,
});

function api() {
  if (lodImport.__error) throw lodImport.__error;
  assert.equal(typeof lodImport.simplifySkinnedM2, "function",
    "R4.1 simplifySkinnedM2 export is required");
  return lodImport;
}

function typed(value) {
  return ArrayBuffer.isView(value) ? new value.constructor(value) : value;
}

function cloneValue(value) {
  if (ArrayBuffer.isView(value)) return new value.constructor(value);
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = cloneValue(child);
    return result;
  }
  return value;
}

function track(components, globalSequence = -1, offset = 0) {
  const values = components === 4
    ? new Float32Array([0, 0, 0, 1, 0, 0, 0.70710677, 0.70710677])
    : components === 3
      ? new Float32Array([offset, 0.5, 1, offset + 0.1, 0.6, 0.9])
      : new Float32Array([1, 0.75]);
  return {
    interpolation: 1,
    globalSequence,
    tracks: [{
      sequence: 0,
      times: new Uint32Array([0, 1000]),
      values,
    }],
  };
}

function appendGrid(model, originX, geosetId, material, boneMode) {
  const vertexStart = model.positions.length / 3;
  const indexStart = model.indices.length;
  for (let y = 0; y <= 4; y++) {
    for (let x = 0; x <= 4; x++) {
      model.positions.push(originX + x, y, 0);
      model.normals.push(0, 0, boneMode === 0 ? 1 : -1);
      model.uv0.push(x / 4 + (boneMode === 0 ? 0 : 0.25), y / 4);
      model.uv1.push(x / 4, y / 4);
      if (boneMode === 0) {
        model.boneIndices.push(0, 0, 0, 0);
        model.boneWeights.push(255, 0, 0, 0);
      } else {
        // Every vertex in this partition is a blended influence. The simplifier must preserve
        // this exact tuple rather than treating bone indices as ordinary geometry attributes.
        model.boneIndices.push(0, 1, 0, 0);
        model.boneWeights.push(128, 127, 0, 0);
      }
    }
  }
  const at = (x, y) => vertexStart + y * 5 + x;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const a = at(x, y);
      const b = at(x + 1, y);
      const c = at(x, y + 1);
      const d = at(x + 1, y + 1);
      model.indices.push(a, b, c, b, d, c);
    }
  }
  const indexCount = model.indices.length - indexStart;
  const submesh = model.submeshes.length;
  model.submeshes.push({
    geosetId,
    vertexStart,
    vertexCount: 25,
    indexStart,
    indexCount,
    centre: [originX + 2, 2, 0],
    sortRadius: 4,
  });
  model.batches.push({
    submesh,
    priorityPlane: submesh,
    materialLayer: material,
    shaderId: 10 + material,
    flags: 0,
    blendMode: 0,
    materialFlags: 0,
    textures: [material * 2, material * 2 + 1],
    uvSets: [0, 1],
    colorIndex: material,
    textureWeight: material,
    textureTransform: material,
  });
}

function modelFixture() {
  const model = {
    version: 264,
    positions: [],
    normals: [],
    uv0: [],
    uv1: [],
    boneIndices: [],
    boneWeights: [],
    indices: [],
    submeshes: [],
    batches: [],
    textures: [
      { type: 0, filename: "World\\Texture\\SkinnedA.blp", flags: 1 },
      { type: 0, filename: "World\\Texture\\SkinnedA2.blp", flags: 2 },
      { type: 0, filename: "World\\Texture\\SkinnedB.blp", flags: 1 },
      { type: 0, filename: "World\\Texture\\SkinnedB2.blp", flags: 2 },
    ],
    bounds: cloneValue(ANIMATION_BOUNDS),
    // A global sequence is a valid material/track feature, not a particle emitter.
    unsupported: { globalLoops: 1, particleEmitters: 0, ribbonEmitters: 0, events: 0 },
    colours: [
      { rgb: track(3, 0, 0.1), alpha: track(1, -1) },
      { rgb: track(3, -1, 0.2), alpha: track(1, 0) },
    ],
    textureWeights: [track(1, -1), track(1, 0, 0.2)],
    textureTransforms: [
      { translation: track(3), rotation: track(4), scaling: track(3, -1, 1) },
      { translation: track(3, 0, 0.3), rotation: track(4, -1), scaling: track(3, 0, 1.1) },
    ],
  };
  appendGrid(model, 0, 100, 0, 0);
  appendGrid(model, 5, 200, 1, 1);
  model.positions = new Float32Array(model.positions);
  model.normals = new Float32Array(model.normals);
  model.uv0 = new Float32Array(model.uv0);
  model.uv1 = new Float32Array(model.uv1);
  model.boneIndices = new Uint8Array(model.boneIndices);
  model.boneWeights = new Uint8Array(model.boneWeights);
  model.indices = new Uint16Array(model.indices);
  return model;
}

function clip(animationId, bone, kind, values, offset = 0) {
  return {
    animationId,
    duration: 1000,
    channels: [{
      bone,
      kind,
      interpolation: 1,
      times: new Uint32Array([0, 1000]),
      values: typed(values),
      ...(offset === 0 ? {} : { offset }),
    }],
  };
}

function skeletonFixture() {
  return {
    bones: [
      { parent: -1, flags: 0x200, pivot: [0, 0, 0] },
      { parent: 0, flags: 0, pivot: [2, 0, 0] },
    ],
    clips: [
      clip(0, 0, 0, new Float32Array([0, 0, 0, 0.25, 0, 0])),
      clip(4, 1, 1, new Int16Array([0, 0, 0, 32767, 0, 0, 16384, 28378])),
    ],
    missingAnimations: 0,
    attachments: [{ id: 1, bone: 1, position: [2, 0, 0] }],
  };
}

function baseOptions(overrides = {}) {
  return {
    modelPath: MODEL_PATH,
    modelSha1: MODEL_SHA1,
    sourceStamp: SOURCE_STAMP,
    model: modelFixture(),
    skeleton: skeletonFixture(),
    animations: [0, 4],
    animationSources: cloneValue(ANIMATION_SOURCES),
    animationBounds: cloneValue(ANIMATION_BOUNDS),
    effects: { globalSequences: new Uint32Array([2000]), particleEmitters: [], ribbonEmitters: [] },
    targetTriangles: TARGET_TRIANGLES,
    algorithmVersion: ALGORITHM_VERSION,
    kind: "m2",
    staticModel: false,
    exterior: true,
    interior: false,
    skinned: true,
    animated: true,
    particleEmitters: false,
    ribbonEmitters: false,
    composite: false,
    legacy: false,
    ...overrides,
  };
}

async function simplify(overrides = {}) {
  return api().simplifySkinnedM2(baseOptions(overrides));
}

function arrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function skeletonSignature(value) {
  assert.ok(value && Array.isArray(value.bones), "profile must preserve parse-side skeleton");
  return {
    bones: value.bones.map((bone) => ({ parent: bone.parent, flags: bone.flags, pivot: [...bone.pivot] })),
    clips: value.clips.map((entry) => ({
      animationId: entry.animationId,
      duration: entry.duration,
      channels: entry.channels.map((channel) => ({
        bone: channel.bone,
        kind: channel.kind,
        times: [...channel.times],
        values: [...channel.values],
      })),
    })),
    missingAnimations: value.missingAnimations,
    attachments: value.attachments.map((entry) => ({ ...entry, position: [...entry.position] })),
  };
}

function assertTopology(profile, source) {
  assert.ok(profile.indices.length % 3 === 0);
  assert.ok(profile.indices.length < source.indices.length, "geometry reduction must be meaningful");
  assert.equal(profile.submeshes.length, source.submeshes.length);
  for (let submeshIndex = 0; submeshIndex < profile.submeshes.length; submeshIndex++) {
    const submesh = profile.submeshes[submeshIndex];
    const sourceSubmesh = source.submeshes[submeshIndex];
    assert.ok(submesh.indexCount < sourceSubmesh.indexCount,
      `submesh ${submeshIndex} must be reduced independently`);
    assert.equal(submesh.indexCount % 3, 0);
    assert.ok(submesh.indexStart >= 0 && submesh.indexStart + submesh.indexCount <= profile.indices.length);
    for (let at = submesh.indexStart; at < submesh.indexStart + submesh.indexCount; at++) {
      const index = profile.indices[at];
      assert.ok(Number.isInteger(index) && index >= submesh.vertexStart
        && index < submesh.vertexStart + submesh.vertexCount);
    }
    const edges = new Map();
    for (let at = submesh.indexStart; at < submesh.indexStart + submesh.indexCount; at += 3) {
      const [a, b, c] = [profile.indices[at], profile.indices[at + 1], profile.indices[at + 2]];
      assert.notEqual(a, b);
      assert.notEqual(b, c);
      assert.notEqual(a, c);
      for (const [from, to] of [[a, b], [b, c], [c, a]]) {
        const edge = from < to ? `${from}/${to}` : `${to}/${from}`;
        edges.set(edge, (edges.get(edge) ?? 0) + 1);
      }
    }
    for (const count of edges.values()) assert.ok(count <= 2, "simplified mesh must remain manifold");
  }
}

function edgeKey(from, to) {
  return from < to ? `${from}/${to}` : `${to}/${from}`;
}

function skinSignature(model, vertex) {
  const start = vertex * 4;
  return `${model.boneIndices[start]}/${model.boneIndices[start + 1]}/${model.boneIndices[start + 2]}/${model.boneIndices[start + 3]}:`
    + `${model.boneWeights[start]}/${model.boneWeights[start + 1]}/${model.boneWeights[start + 2]}/${model.boneWeights[start + 3]}`;
}

function collectEdges(indices, indexStart, indexCount, output, predicate = () => true) {
  for (let at = indexStart; at < indexStart + indexCount; at += 3) {
    const triangle = [indices[at], indices[at + 1], indices[at + 2]];
    for (const [from, to] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
      if (predicate(from, to)) output.add(edgeKey(from, to));
    }
  }
}

function seamModelFixture() {
  const model = modelFixture();
  const first = model.submeshes[0];
  // Collapse the fixture to one authored geoset and make the x=1/x=2 grid boundary
  // cross from rigid to blended bone signatures. The simplifier must preserve that seam
  // or reject the artifact rather than silently changing skin semantics.
  model.positions = model.positions.slice(0, 25 * 3);
  model.normals = model.normals.slice(0, 25 * 3);
  model.uv0 = model.uv0.slice(0, 25 * 2);
  model.uv1 = model.uv1.slice(0, 25 * 2);
  model.boneIndices = model.boneIndices.slice(0, 25 * 4);
  model.boneWeights = model.boneWeights.slice(0, 25 * 4);
  model.indices = model.indices.slice(0, first.indexStart + first.indexCount);
  model.submeshes = [{ ...first }];
  model.batches = [{ ...model.batches[0] }];
  for (let y = 0; y <= 4; y++) {
    for (let x = 2; x <= 4; x++) {
      const at = (y * 5 + x) * 4;
      model.boneIndices.set([0, 1, 0, 0], at);
      model.boneWeights.set([128, 127, 0, 0], at);
    }
  }
  return model;
}

test("skinned HLOD reduces each partition while preserving rig, tracks, and source streams", async () => {
  const options = baseOptions();
  const source = options.model;
  const before = cloneValue(source);
  const first = await api().simplifySkinnedM2(options);
  const second = await simplify();
  assert.ok(first, "trusted skinned M2 must produce a low profile");
  assert.ok(second);
  assert.equal(Object.isFrozen(first), true);
  assertTopology(first, source);
  assert.deepEqual([...first.boneIndices], [...source.boneIndices]);
  assert.deepEqual([...first.boneWeights], [...source.boneWeights]);
  assert.notEqual(first.boneIndices, source.boneIndices);
  assert.notEqual(first.boneWeights, source.boneWeights);
  assert.deepEqual(skeletonSignature(first.skeleton), skeletonSignature(options.skeleton));
  assert.deepEqual(first.batches, source.batches);
  assert.deepEqual(first.textures, source.textures);
  assert.deepEqual(first.colours, source.colours);
  assert.deepEqual(first.textureWeights, source.textureWeights);
  assert.deepEqual(first.textureTransforms, source.textureTransforms);
  assert.equal(first.sourceTriangleCount, 64);
  assert.equal(first.sourceDrawTriangleCount, 64);
  assert.equal(first.drawTriangleCount,
    first.batches.reduce((sum, batch) => sum + first.submeshes[batch.submesh].indexCount, 0) / 3);
  assert.deepEqual(first.bounds, options.animationBounds, "animated bounds remain conservative");
  assert.deepEqual(source, before, "input model and metadata must not be mutated");
  for (const field of ["positions", "normals", "uv0", "uv1", "indices", "submeshes", "batches", "textures"]) {
    assert.notEqual(first[field], source[field], `${field} must not alias the source`);
  }
  assert.notEqual(first.skeleton, options.skeleton, "skeleton metadata must not alias the input");
  assert.notEqual(first.skeleton.bones, options.skeleton.bones, "bone metadata must not alias the input");
  assert.notEqual(first.skeleton.clips, options.skeleton.clips, "clip metadata must not alias the input");
  assert.notEqual(first.skeleton.attachments, options.skeleton.attachments,
    "attachment metadata must not alias the input");
  assert.notEqual(first.effects, options.effects, "effects metadata must not alias the input");
  assert.notEqual(first.effects.globalSequences, options.effects.globalSequences,
    "effect typed tables must not alias the input");
  assert.notEqual(first.animationSources, options.animationSources,
    "animation source metadata must not alias the input");
  assert.notEqual(first.animationSources[0], options.animationSources[0],
    "animation source entries must not alias the input");
  assert.deepEqual([...first.bytes], [...second.bytes], "same inputs must produce byte-identical WVM9");
  assert.equal(first.profileId, second.profileId);
});

test("skinned HLOD preserves authored cross-influence seam edges or fails closed", async () => {
  const source = seamModelFixture();
  const sourceSubmesh = source.submeshes[0];
  const authoredSeams = new Set();
  collectEdges(source.indices, sourceSubmesh.indexStart, sourceSubmesh.indexCount, authoredSeams,
    (from, to) => skinSignature(source, from) !== skinSignature(source, to));
  assert.ok(authoredSeams.size > 0, "fixture must contain an internal bone-influence seam");

  const profile = await simplify({ model: source, targetTriangles: 12 });
  if (profile === undefined) return;
  const outputEdges = new Set();
  const outputSubmesh = profile.submeshes[0];
  collectEdges(profile.indices, outputSubmesh.indexStart, outputSubmesh.indexCount, outputEdges);
  for (const seam of authoredSeams) {
    assert.ok(outputEdges.has(seam), `simplification must retain authored seam edge ${seam}`);
  }
});

test("WVM9 round-trip retains skinned semantics and animated material tracks", async () => {
  const options = baseOptions();
  const profile = await simplify();
  assert.ok(profile);
  const decoded = decodeWvm9(arrayBuffer(profile.bytes));
  assert.equal(decoded.skeleton.parents.length, options.skeleton.bones.length);
  assert.deepEqual([...decoded.skeleton.parents], options.skeleton.bones.map((bone) => bone.parent));
  assert.deepEqual([...decoded.skeleton.flags], options.skeleton.bones.map((bone) => bone.flags & 0xffff));
  assert.deepEqual([...decoded.skeleton.pivots], options.skeleton.bones.flatMap((bone) => bone.pivot));
  assert.deepEqual(decoded.skeleton.clips.map((clip) => clip.animationId), [0, 4]);
  assert.deepEqual(decoded.skeleton.animations, [0, 4]);
  // WVM9 deliberately omits the parse-side SKIN batch `flags` byte; the browser contract contains
  // every field below.  The profile itself preserves `flags` (covered by the first test), while the
  // byte round-trip must be compared against the actual wire shape instead of an impossible superset.
  assert.deepEqual(decoded.batches, profile.batches.map(({ flags: _flags, ...wire }) => wire));
  assert.deepEqual(decoded.textures, profile.textures.map((texture) => ({
    type: texture.type,
    flags: texture.flags,
    path: texture.filename,
  })));
  assert.deepEqual([...decoded.globalSequences], [2000]);
  assert.equal(decoded.colours.length, options.model.colours.length);
  assert.equal(decoded.textureWeights.length, options.model.textureWeights.length);
  assert.equal(decoded.textureTransforms.length, options.model.textureTransforms.length);
  assert.equal(decoded.boneWeights[0], 1, "WVM9 decoder exposes normalised bone weights");
  assert.equal(profile.bytes[0], "W".charCodeAt(0));
  assert.equal(profile.bytes[1], "V".charCodeAt(0));
});

test("profile identity includes model, sidecar, target, source stamp, and algorithm version", async () => {
  const base = await simplify();
  assert.ok(base);
  const changed = [
    await simplify({ modelSha1: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    await simplify({ sourceStamp: { ...SOURCE_STAMP, chain: "other-model-chain" } }),
    await simplify({ animationSources: [{ ...ANIMATION_SOURCES[0], sha1: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }] }),
    await simplify({ targetTriangles: TARGET_TRIANGLES + 4 }),
    await simplify({ algorithmVersion: `${ALGORITHM_VERSION}-next` }),
  ];
  assert.ok(changed.every(Boolean));
  for (const profile of changed) assert.notEqual(profile.profileId, base.profileId);
});

test("missing or non-conservative animation trust falls back without producing a low artifact", async () => {
  assert.equal(await simplify({ animationBounds: undefined }), undefined, "missing animated bounds");
  assert.equal(await simplify({ animationBounds: { min: [0, 0, 0], max: [1, 1, 1], radius: 1 } }), undefined,
    "animated bounds that do not contain the source geometry");
  assert.equal(await simplify({ animationBounds: { min: [0, 0, 0], max: [12, 6, 2], radius: 20 } }), undefined,
    "animated bounds that omit the negative extent");
  assert.equal(await simplify({ animationSources: [], skeleton: { ...skeletonFixture(), missingAnimations: 1 } }), undefined,
    "missing sidecar animation source");
  assert.equal(await simplify({ sourceStamp: undefined }), undefined, "missing model source stamp");
});

test("malformed skin, hierarchy, tracks, WVM tables, and effect semantics fail closed", async () => {
  const badWeights = modelFixture();
  badWeights.boneWeights[0] = 254;
  assert.equal(await simplify({ model: badWeights }), undefined, "weight tuple must sum to 255");

  const badIndex = modelFixture();
  badIndex.boneIndices[0] = 2;
  assert.equal(await simplify({ model: badIndex }), undefined, "bone index outside skeleton");

  const cyclic = skeletonFixture();
  cyclic.bones[0].parent = 1;
  assert.equal(await simplify({ skeleton: cyclic }), undefined, "cyclic hierarchy");

  const malformedTrack = modelFixture();
  malformedTrack.colours[0].rgb.tracks[0].values = new Float32Array([1]);
  assert.equal(await simplify({ model: malformedTrack }), undefined, "track time/value mismatch");

  const tooManyTextureUnits = modelFixture();
  tooManyTextureUnits.batches[0].textures = [0, 1, 2];
  tooManyTextureUnits.batches[0].uvSets = [0, 1, 0];
  assert.equal(await simplify({ model: tooManyTextureUnits }), undefined,
    "WVM9 supports at most two texture units per batch");

  for (const attachment of [
    { id: 65_536, bone: 1, position: [2, 0, 0] },
    { id: 1, bone: 2, position: [2, 0, 0] },
    { id: -1, bone: 1, position: [2, 0, 0] },
  ]) {
    const badAttachment = skeletonFixture();
    badAttachment.attachments = [attachment];
    assert.equal(await simplify({ skeleton: badAttachment }), undefined,
      "out-of-range attachment id/bone must not be silently filtered by WVM9");
  }

  const badAnimationId = skeletonFixture();
  badAnimationId.clips[1].animationId = 65_536;
  assert.equal(await simplify({ skeleton: badAnimationId }), undefined,
    "animation IDs outside uint16 must fail closed");
  assert.equal(await simplify({ animations: [0] }), undefined,
    "available animation IDs must include every encoded clip");
  assert.equal(await simplify({ animations: [0, 4, 65_536] }), undefined,
    "available animation IDs outside uint16 must not be truncated");

  const badGlobalSequence = modelFixture();
  badGlobalSequence.colours[0].rgb.globalSequence = 1;
  assert.equal(await simplify({ model: badGlobalSequence }), undefined,
    "track globalSequence must name an existing global sequence");
  const clampedGlobalSequence = modelFixture();
  clampedGlobalSequence.colours[0].rgb.globalSequence = 128;
  assert.equal(await simplify({ model: clampedGlobalSequence }), undefined,
    "track globalSequence outside WVM9 signed-byte range must fail closed");
  assert.equal(await simplify({
    effects: { globalSequences: new Uint32Array(65_536), particleEmitters: [], ribbonEmitters: [] },
  }), undefined, "global sequence table overflow must not be silently sliced");

  const badChannel = skeletonFixture();
  badChannel.clips[0].channels[0].values = new Float32Array([0, 0, 0]);
  assert.equal(await simplify({ skeleton: badChannel }), undefined,
    "animation channel values must match key/component count");
  const tooManyTrackKeys = modelFixture();
  tooManyTrackKeys.colours[0].rgb.tracks[0] = {
    sequence: 0,
    times: new Uint32Array(65_536),
    values: new Float32Array(65_536 * 3),
  };
  assert.equal(await simplify({ model: tooManyTrackKeys }), undefined,
    "WVM9 track key count overflow must not wrap uint16");
  const tooManyChannelKeys = skeletonFixture();
  tooManyChannelKeys.clips[0].channels[0] = {
    bone: 0,
    kind: 0,
    interpolation: 1,
    times: new Uint32Array(65_536),
    values: new Float32Array(65_536 * 3),
  };
  assert.equal(await simplify({ skeleton: tooManyChannelKeys }), undefined,
    "animation channel key count overflow must fail closed");

  for (const field of ["colours", "textureWeights", "textureTransforms"]) {
    const oversized = modelFixture();
    const table = new Array(65_536);
    table[0] = cloneValue(oversized[field][0]);
    table[1] = cloneValue(oversized[field][1]);
    oversized[field] = table;
    assert.equal(await simplify({ model: oversized }), undefined,
      `${field} table overflow must not be silently encoded`);
  }

  const tooManyTracks = modelFixture();
  tooManyTracks.colours[0].rgb.tracks = Array.from({ length: 256 }, (_, sequence) => ({
    sequence,
    times: new Uint32Array([0]),
    values: new Float32Array([1, 1, 1]),
  }));
  assert.equal(await simplify({ model: tooManyTracks }), undefined, "WVM9 track sub-count overflow");

  const tooManyTextures = modelFixture();
  tooManyTextures.textures = Array.from({ length: 65_536 }, () => ({ type: 0, filename: "" }));
  assert.equal(await simplify({ model: tooManyTextures }), undefined, "WVM9 texture table overflow");

  for (const field of ["particleEmitters", "ribbonEmitters", "composite", "legacy"]) {
    assert.equal(await simplify({ [field]: true }), undefined, `${field} semantics must remain excluded`);
  }
  const emitted = modelFixture();
  emitted.unsupported.particleEmitters = 1;
  assert.equal(await simplify({ model: emitted }), undefined, "parsed emitter count must exclude the low artifact");

  for (const field of ["particleEmitters", "ribbonEmitters", "composite", "legacy"]) {
    assert.equal(await simplify({ [field]: 1 }), undefined,
      `numeric truthy ${field} must not bypass exclusion`);
  }
  assert.equal(await simplify({ skinned: undefined }), undefined,
    "missing skinned eligibility must fail closed");
  assert.equal(await simplify({ animated: undefined }), undefined,
    "missing animated eligibility must fail closed");

  const zeroSum = modelFixture();
  zeroSum.boneWeights.fill(0, 0, 4);
  assert.equal(await simplify({ model: zeroSum }), undefined,
    "zero-sum skin tuple must fail closed");

  const invalidGeoset = modelFixture();
  invalidGeoset.submeshes[0].geosetId = Number.NaN;
  assert.equal(await simplify({ model: invalidGeoset }), undefined,
    "invalid geoset identity must fail closed");
  const invalidSortRadius = modelFixture();
  invalidSortRadius.submeshes[0].sortRadius = Number.POSITIVE_INFINITY;
  assert.equal(await simplify({ model: invalidSortRadius }), undefined,
    "non-finite sort radius must fail closed");

  const duplicateChannel = skeletonFixture();
  duplicateChannel.clips[0].channels.push(cloneValue(duplicateChannel.clips[0].channels[0]));
  assert.equal(await simplify({ skeleton: duplicateChannel }), undefined,
    "duplicate bone/channel tracks must fail closed");
});

test("pure simplification never reads arbitrary resource, archive, or raw-model getters", async () => {
  const options = baseOptions();
  for (const property of ["resource", "rawModel", "archiveEntry"]) {
    Object.defineProperty(options.model, property, {
      configurable: true,
      enumerable: true,
      get() { throw new Error(`forbidden model getter: ${property}`); },
    });
  }
  for (const property of ["archive", "loadResource", "client"]) {
    Object.defineProperty(options, property, {
      configurable: true,
      enumerable: true,
      get() { throw new Error(`forbidden option getter: ${property}`); },
    });
  }
  const profile = await api().simplifySkinnedM2(options);
  assert.ok(profile);
  assert.equal(profile.model, undefined);
  assert.equal(profile.rawModel, undefined);
});

test("nested parsed records are allowlisted without reading enumerable unknown getters", async () => {
  const options = baseOptions();
  Object.defineProperty(options.model.submeshes[0], "unknownSubmeshField", {
    enumerable: true,
    get() { throw new Error("forbidden submesh getter"); },
  });
  Object.defineProperty(options.model.batches[0], "unknownBatchField", {
    enumerable: true,
    get() { throw new Error("forbidden batch getter"); },
  });
  Object.defineProperty(options.animationSources[0], "unknownSourceField", {
    enumerable: true,
    get() { throw new Error("forbidden animation source getter"); },
  });

  const profile = await api().simplifySkinnedM2(options);
  assert.ok(profile, "valid parsed data must not be rejected because of ignored fields");
  assert.equal(Object.hasOwn(profile.submeshes[0], "unknownSubmeshField"), false);
  assert.equal(Object.hasOwn(profile.batches[0], "unknownBatchField"), false);
  assert.equal(Object.hasOwn(profile.animationSources[0], "unknownSourceField"), false);
});

test("R4.1 remains offline and does not wire runtime ranges or the generator", async () => {
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const terrain = await readFile(new URL("../src/browser/Terrain.ts", import.meta.url), "utf8");
  const generator = await readFile(new URL("../tools/generate-visual-model.mjs", import.meta.url), "utf8");
  for (const source of [renderer, terrain, generator]) {
    assert.doesNotMatch(source, /simplifySkinnedM2|m2-skinned-lod/i,
      "R4.1 low geometry must not be runtime/generator-wired yet");
  }
  assert.match(terrain, /ENVIRONMENT_RANGE\s*=\s*400/);
  const { TerrainStreamingWindow } = await import("../dist/code/browser/TerrainStreaming.js");
  const window = new TerrainStreamingWindow();
  assert.equal(window.update(0, 0, 0).visible.length, 9, "near terrain ring remains 3x3");
  assert.equal(window.update(0, 0, 0, false).visible.length, 9, "formal capture keeps the same ring");
  assert.equal(createHash("sha1").update(MODEL_PATH).digest().length, 20);
});
