// Offline-only R4.1a proof for skinned M2 geometry variants.
//
// The caller supplies the already parsed M2, rig, animation sidecar identities and effects.  This
// module never opens an archive or follows an arbitrary resource field.  The resulting WVM9 keeps
// the authored vertex table and all semantic tables; only each authored submesh's index range is
// simplified.

import { createHash } from "node:crypto";
import { MeshoptSimplifier } from "meshoptimizer";
import { encodeWvm9 } from "./wvm.mjs";

const MAX_VERTICES = 1_000_000;
const MAX_INDICES = 6_000_000 * 3;
const MAX_TABLE_ENTRIES = 65_535;
const MAX_BONES = 1_024;
const MAX_CLIPS = 1_024;
const MAX_CHANNELS = 65_535;
const MAX_TRACKS = 255;
const MAX_KEYS = 65_535;
const MAX_EMITTERS = 65_535;
const MAX_SPLINE_POINTS = 4_095;
const TARGET_ERROR = 0.01;
// Position is supplied separately to meshoptimizer.  Normals, UVs and the complete skin tuple are
// all part of the attribute error so a collapse cannot silently cross an authored deformation or
// material seam.  The tuple is intentionally not compacted or welded after simplification.
const ATTRIBUTE_WEIGHTS = Object.freeze([
  1, 1, 1, 1, 1, 1, 1,
  4, 4, 4, 4, 4, 4, 4, 4,
]);
const LOCK_FLAGS = Object.freeze(["LockBorder"]);

function isTypedArray(value) {
  return ArrayBuffer.isView(value) && !(value instanceof DataView)
    && Number.isInteger(value.length);
}

function cloneTyped(value) {
  return new value.constructor(value);
}

function cloneValue(value) {
  if (isTypedArray(value)) return cloneTyped(value);
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value)) result[key] = cloneValue(value[key]);
  return result;
}

function freezeMetadata(value) {
  if (!value || typeof value !== "object" || isTypedArray(value)) return value;
  for (const child of Object.values(value)) freezeMetadata(child);
  return Object.freeze(value);
}

function canonicalJson(value, stack = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("identity contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error("identity is not JSON serialisable");
  if (stack.has(value)) throw new Error("identity is cyclic");
  stack.add(value);
  let result;
  if (Array.isArray(value) || isTypedArray(value)) {
    result = `[${Array.from(value, (entry) => canonicalJson(entry, stack)).join(",")}]`;
  } else {
    const keys = Object.keys(value).sort();
    result = `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], stack)}`).join(",")}}`;
  }
  stack.delete(value);
  return result;
}

function cloneStamp(value, label) {
  const encoded = canonicalJson(value);
  if (encoded === "undefined") throw new Error(`${label} is missing`);
  return freezeMetadata(cloneValue(JSON.parse(encoded)));
}

function canonicalAssetPath(value, extension) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return undefined;
  const path = value.replaceAll("/", "\\");
  if (path.includes("\0") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)
    || path.split("\\").some((part) => part === "." || part === "..")) return undefined;
  if (!/^[^\\]+(?:\\[^\\]+)*\.[a-z0-9]+$/i.test(path)) return undefined;
  return path.toLowerCase().endsWith(`.${extension}`) ? path.toLowerCase() : undefined;
}

function finiteF32(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} is not finite`);
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded)) throw new Error(`${label} is outside Float32 range`);
  return rounded;
}

function finiteVector(value, length, label) {
  if (!value || typeof value.length !== "number" || value.length !== length) {
    throw new Error(`${label} is invalid`);
  }
  return Array.from({ length }, (_, index) => finiteF32(value[index], `${label}[${index}]`));
}

function finiteStream(value, expectedLength, label) {
  if (!isTypedArray(value) || value.length !== expectedLength) throw new Error(`${label} stream is invalid`);
  const result = new Float32Array(expectedLength);
  for (let index = 0; index < expectedLength; index++) result[index] = finiteF32(value[index], `${label}[${index}]`);
  return result;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is invalid`);
  return value;
}

function validateBounds(value, label) {
  if (!value || typeof value !== "object") throw new Error(`${label} are required`);
  const min = finiteVector(value.min, 3, `${label}.min`);
  const max = finiteVector(value.max, 3, `${label}.max`);
  const radius = finiteF32(value.radius, `${label}.radius`);
  if (radius < 0 || min.some((entry, axis) => entry > max[axis])) throw new Error(`${label} are inverted`);
  return { min, max, radius };
}

function boundsContain(bounds, positions, indices, submeshes) {
  const scale = Math.max(1, ...bounds.min.map(Math.abs), ...bounds.max.map(Math.abs), Math.abs(bounds.radius));
  const epsilon = Math.max(1e-5, scale * 1e-6);
  for (const submesh of submeshes) {
    for (let at = submesh.indexStart; at < submesh.indexStart + submesh.indexCount; at++) {
      const index = indices[at];
      const x = positions[index * 3];
      const y = positions[index * 3 + 1];
      const z = positions[index * 3 + 2];
      if (x < bounds.min[0] - epsilon || y < bounds.min[1] - epsilon || z < bounds.min[2] - epsilon
        || x > bounds.max[0] + epsilon || y > bounds.max[1] + epsilon || z > bounds.max[2] + epsilon
        || Math.hypot(x, y, z) > bounds.radius + epsilon) {
        throw new Error("bounds do not conservatively contain the source geometry");
      }
    }
  }
}

function boundsContainBounds(outer, inner) {
  const scale = Math.max(1, ...outer.min.map(Math.abs), ...outer.max.map(Math.abs), Math.abs(outer.radius));
  const epsilon = Math.max(1e-5, scale * 1e-6);
  if (inner.min.some((value, axis) => value < outer.min[axis] - epsilon)
    || inner.max.some((value, axis) => value > outer.max[axis] + epsilon)
    || inner.radius > outer.radius + epsilon) {
    throw new Error("animationBounds do not contain source bounds");
  }
}

function validateTrack(track, components, globalCount, label) {
  if (!track || typeof track !== "object" || !Array.isArray(track.tracks)
    || track.tracks.length > MAX_TRACKS) throw new Error(`${label} is invalid`);
  const result = {
    interpolation: integer(track.interpolation, 0, 255, `${label}.interpolation`),
    globalSequence: integer(track.globalSequence ?? -1, -1, Math.min(127, Math.max(-1, globalCount - 1)), `${label}.globalSequence`),
    tracks: [],
  };
  for (const [index, source] of track.tracks.entries()) {
    if (!source || typeof source !== "object" || !isTypedArray(source.times)
      || !isTypedArray(source.values) || source.times.length === 0 || source.times.length > MAX_KEYS
      || source.values.length !== source.times.length * components) {
      throw new Error(`${label}.tracks[${index}] is invalid`);
    }
    const times = new Uint32Array(source.times.length);
    for (let key = 0; key < times.length; key++) {
      const time = integer(source.times[key], 0, 0xffff_ffff, `${label}.times[${key}]`);
      if (key > 0 && time < times[key - 1]) throw new Error(`${label}.times are not ordered`);
      times[key] = time;
    }
    const values = new Float32Array(source.values.length);
    for (let key = 0; key < values.length; key++) values[key] = finiteF32(source.values[key], `${label}.values[${key}]`);
    result.tracks.push({ sequence: integer(source.sequence, 0, 0xffff, `${label}.sequence`), times, values });
  }
  return result;
}

function copyTrack(track) {
  return {
    interpolation: track.interpolation,
    globalSequence: track.globalSequence,
    tracks: track.tracks.map((entry) => ({
      sequence: entry.sequence,
      times: new Uint32Array(entry.times),
      values: new Float32Array(entry.values),
    })),
  };
}

function copySkeleton(skeleton) {
  return {
    bones: skeleton.bones.map((bone) => ({ parent: bone.parent, flags: bone.flags, pivot: [...bone.pivot] })),
    clips: skeleton.clips.map((clip) => ({
      animationId: clip.animationId,
      duration: clip.duration,
      channels: clip.channels.map((channel) => ({
        bone: channel.bone,
        kind: channel.kind,
        interpolation: channel.interpolation,
        times: new Uint32Array(channel.times),
        values: channel.kind === 1 ? new Int16Array(channel.values) : new Float32Array(channel.values),
      })),
    })),
    missingAnimations: 0,
    attachments: skeleton.attachments.map((attachment) => ({
      id: attachment.id,
      bone: attachment.bone,
      position: [...attachment.position],
    })),
  };
}

function copyColour(colour) {
  return { rgb: copyTrack(colour.rgb), alpha: copyTrack(colour.alpha) };
}

function copyTransform(transform) {
  return {
    translation: copyTrack(transform.translation),
    rotation: copyTrack(transform.rotation),
    scaling: copyTrack(transform.scaling),
  };
}

function validateRamp(ramp, components, label) {
  if (!ramp || typeof ramp !== "object" || !isTypedArray(ramp.times) || !isTypedArray(ramp.values)
    || ramp.times.length > MAX_KEYS || ramp.values.length !== ramp.times.length * components) {
    throw new Error(`${label} is invalid`);
  }
  const times = new Float32Array(ramp.times.length);
  const values = new Float32Array(ramp.values.length);
  for (let index = 0; index < times.length; index++) {
    times[index] = finiteF32(ramp.times[index], `${label}.times[${index}]`);
    if (times[index] < 0 || times[index] > 1 || (index > 0 && times[index] < times[index - 1])) {
      throw new Error(`${label}.times are invalid`);
    }
  }
  for (let index = 0; index < values.length; index++) values[index] = finiteF32(ramp.values[index], `${label}.values[${index}]`);
  return { times, values };
}

function validateSkeleton(source, globalCount) {
  if (!source || typeof source !== "object" || !Array.isArray(source.bones)
    || source.bones.length === 0 || source.bones.length > MAX_BONES || !Array.isArray(source.clips)
    || source.clips.length === 0 || source.clips.length > MAX_CLIPS || source.missingAnimations !== 0) {
    throw new Error("skeleton is incomplete");
  }
  const bones = source.bones.map((bone, index) => {
    if (!bone || typeof bone !== "object") throw new Error(`bone ${index} is invalid`);
    return {
      parent: integer(bone.parent, -1, index - 1, `bone ${index}.parent`),
      flags: integer(bone.flags, 0, 0xffff, `bone ${index}.flags`),
      pivot: finiteVector(bone.pivot, 3, `bone ${index}.pivot`),
    };
  });
  const clips = source.clips.map((clip, clipIndex) => {
    if (!clip || typeof clip !== "object" || !Array.isArray(clip.channels)
      || clip.channels.length > MAX_CHANNELS) throw new Error(`clip ${clipIndex} is invalid`);
    const duration = integer(clip.duration, 0, 0xffff_ffff, `clip ${clipIndex}.duration`);
    const channels = clip.channels.map((channel, channelIndex) => {
      if (!channel || typeof channel !== "object") throw new Error("skeleton channel is invalid");
      const kind = integer(channel.kind, 0, 2, `clip ${clipIndex}.channel ${channelIndex}.kind`);
      const components = kind === 1 ? 4 : 3;
      if (!isTypedArray(channel.times) || !isTypedArray(channel.values)
        || channel.times.length === 0 || channel.times.length > MAX_KEYS
        || channel.values.length !== channel.times.length * components) {
        throw new Error("skeleton channel stream is invalid");
      }
      const times = new Uint32Array(channel.times.length);
      for (let key = 0; key < times.length; key++) {
        const time = integer(channel.times[key], 0, duration, "skeleton channel time");
        if (key > 0 && time < times[key - 1]) throw new Error("skeleton channel times are not ordered");
        times[key] = time;
      }
      const values = kind === 1 ? new Int16Array(channel.values.length) : new Float32Array(channel.values.length);
      for (let key = 0; key < values.length; key++) {
        if (kind === 1) values[key] = integer(channel.values[key], -0x8000, 0x7fff, "rotation value");
        else values[key] = finiteF32(channel.values[key], "skeleton channel value");
      }
      return {
        bone: integer(channel.bone, 0, bones.length - 1, `clip ${clipIndex}.channel ${channelIndex}.bone`),
        kind,
        interpolation: integer(channel.interpolation ?? 0, 0, 255, "skeleton channel interpolation"),
        times,
        values,
      };
    });
    const channelKeys = new Set(channels.map((channel) => `${channel.bone}:${channel.kind}`));
    if (channelKeys.size !== channels.length) throw new Error(`clip ${clipIndex} has duplicate bone channels`);
    return {
      animationId: integer(clip.animationId, 0, 0xffff, `clip ${clipIndex}.animationId`),
      duration,
      channels,
    };
  });
  const ids = new Set();
  for (const clip of clips) {
    if (ids.has(clip.animationId)) throw new Error("duplicate skeleton animation id");
    ids.add(clip.animationId);
  }
  if (!Array.isArray(source.attachments) || source.attachments.length > MAX_TABLE_ENTRIES) {
    throw new Error("skeleton attachments are invalid");
  }
  const attachments = source.attachments.map((attachment, index) => ({
    id: integer(attachment?.id, 0, 0xffff, `attachment ${index}.id`),
    bone: integer(attachment?.bone, 0, bones.length - 1, `attachment ${index}.bone`),
    position: finiteVector(attachment?.position, 3, `attachment ${index}.position`),
  }));
  return { bones, clips, missingAnimations: 0, attachments, globalCount };
}

function animationIds(value, clips) {
  const entries = value === undefined ? clips.map((clip) => clip.animationId) : value;
  if (!Array.isArray(entries) || entries.length > MAX_TABLE_ENTRIES) throw new Error("animations are invalid");
  const ids = [];
  const seen = new Set();
  for (const entry of entries) {
    const id = typeof entry === "number" ? entry : entry?.animationId;
    integer(id, 0, 0xffff, "animation id");
    if (seen.has(id)) throw new Error("duplicate animation id");
    seen.add(id);
    ids.push(id);
  }
  for (const clip of clips) if (!seen.has(clip.animationId)) throw new Error("clip is absent from animation ids");
  return ids;
}

function validateAnimationSources(value, animationIdsValue, clipIds = new Set()) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TABLE_ENTRIES) {
    throw new Error("animationSources are required");
  }
  const result = value.map((source, index) => {
    if (!source || typeof source !== "object" || typeof source.path !== "string"
      || !canonicalAssetPath(source.path, "anim") || typeof source.sha1 !== "string" || !/^[a-f0-9]{40}$/i.test(source.sha1)
      || source.stamp === undefined || !Array.isArray(source.animationIds) || source.animationIds.length === 0) {
      throw new Error(`animation source ${index} is invalid`);
    }
    const ids = source.animationIds.map((id) => integer(id, 0, 0xffff, "animation source id"));
    if (new Set(ids).size !== ids.length) throw new Error("duplicate animation source id");
    const stamp = cloneStamp(source.stamp, `animation source ${index}.stamp`);
    for (const id of ids) if (!animationIdsValue.includes(id)) throw new Error("sidecar animation is not declared");
    return { path: canonicalAssetPath(source.path, "anim"), sha1: source.sha1, stamp, animationIds: ids };
  });
  const covered = new Set(result.flatMap((source) => source.animationIds));
  for (const id of animationIdsValue) {
    if (!clipIds.has(id) && !covered.has(id)) throw new Error("animation sidecar coverage is incomplete");
  }
  return result;
}

function validateModel(model, skeleton, effects, animationBounds) {
  if (!model || typeof model !== "object") throw new Error("parsed M2 model is required");
  const vertexCount = model.positions?.length / 3;
  if (!Number.isInteger(vertexCount) || vertexCount === 0 || vertexCount > MAX_VERTICES) {
    throw new Error("M2 vertex table is invalid");
  }
  const positions = finiteStream(model.positions, vertexCount * 3, "positions");
  const normals = finiteStream(model.normals, vertexCount * 3, "normals");
  const uv0 = finiteStream(model.uv0, vertexCount * 2, "uv0");
  const uv1 = finiteStream(model.uv1, vertexCount * 2, "uv1");
  if (!isTypedArray(model.indices) || model.indices.length === 0 || model.indices.length % 3 !== 0
    || model.indices.length > MAX_INDICES) throw new Error("M2 index stream is invalid");
  const indices = new Uint32Array(model.indices.length);
  for (let index = 0; index < indices.length; index++) indices[index] = integer(model.indices[index], 0, vertexCount - 1, "M2 index");
  if (!isTypedArray(model.boneIndices) || !isTypedArray(model.boneWeights)
    || model.boneIndices.length !== vertexCount * 4 || model.boneWeights.length !== vertexCount * 4) {
    throw new Error("M2 skin streams are invalid");
  }
  const boneIndices = new Uint8Array(model.boneIndices.length);
  const boneWeights = new Uint8Array(model.boneWeights.length);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    let weightSum = 0;
    for (let slot = 0; slot < 4; slot++) {
      const at = vertex * 4 + slot;
      boneIndices[at] = integer(model.boneIndices[at], 0, skeleton.bones.length - 1, "bone index");
      boneWeights[at] = integer(model.boneWeights[at], 0, 255, "bone weight");
      weightSum += boneWeights[at];
    }
    if (weightSum !== 255) throw new Error("bone weight tuple must sum to 255");
  }
  if (!Array.isArray(model.submeshes) || model.submeshes.length === 0 || model.submeshes.length > MAX_TABLE_ENTRIES
    || !Array.isArray(model.batches) || model.batches.length === 0 || model.batches.length > MAX_TABLE_ENTRIES
    || !Array.isArray(model.textures) || model.textures.length > MAX_TABLE_ENTRIES) throw new Error("M2 tables are invalid");

  const submeshes = model.submeshes.map((source, submeshIndex) => {
    if (!source || typeof source !== "object") throw new Error("submesh is invalid");
    integer(source.geosetId, 0, 0xffff, "submesh geosetId");
    const vertexStart = integer(source.vertexStart, 0, vertexCount - 1, "submesh vertexStart");
    const vertexRange = integer(source.vertexCount, 3, vertexCount - vertexStart, "submesh vertexCount");
    const indexStart = integer(source.indexStart, 0, indices.length - 3, "submesh indexStart");
    const indexRange = integer(source.indexCount, 3, indices.length - indexStart, "submesh indexCount");
    if (indexStart % 3 !== 0 || indexRange % 3 !== 0) throw new Error("submesh index range is invalid");
    const centre = finiteVector(source.centre, 3, `submesh ${submeshIndex}.centre`);
    const sortRadius = finiteF32(source.sortRadius, `submesh ${submeshIndex}.sortRadius`);
    if (sortRadius < 0) throw new Error("submesh radius is invalid");
    const edges = new Map();
    for (let at = indexStart; at < indexStart + indexRange; at += 3) {
      const [a, b, c] = [indices[at], indices[at + 1], indices[at + 2]];
      if ([a, b, c].some((index) => index < vertexStart || index >= vertexStart + vertexRange)
        || a === b || b === c || a === c) throw new Error("submesh topology is invalid");
      const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
      const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
      const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
      const crossX = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const crossY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const crossZ = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (!(crossX * crossX + crossY * crossY + crossZ * crossZ > 1e-12)) throw new Error("submesh is degenerate");
      for (const [from, to] of [[a, b], [b, c], [c, a]]) {
        const edge = from < to ? `${from}/${to}` : `${to}/${from}`;
        const count = (edges.get(edge) ?? 0) + 1;
        if (count > 2) throw new Error("submesh is non-manifold");
        edges.set(edge, count);
      }
    }
    return {
      geosetId: source.geosetId,
      vertexStart,
      vertexCount: vertexRange,
      indexStart,
      indexCount: indexRange,
      centre,
      sortRadius,
    };
  });
  const ordered = submeshes.toSorted((left, right) => left.indexStart - right.indexStart);
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index].indexStart < ordered[index - 1].indexStart + ordered[index - 1].indexCount) throw new Error("submesh ranges overlap");
  }
  if (!Array.isArray(model.colours) || !Array.isArray(model.textureWeights) || !Array.isArray(model.textureTransforms)) {
    throw new Error("M2 material track tables are incomplete");
  }
  if (model.colours.length > MAX_TABLE_ENTRIES || model.textureWeights.length > MAX_TABLE_ENTRIES
    || model.textureTransforms.length > MAX_TABLE_ENTRIES) throw new Error("M2 material tables are too large");
  const sourceBounds = validateBounds(model.bounds, "M2 bounds");
  boundsContain(sourceBounds, positions, indices, submeshes);
  const bounds = validateBounds(animationBounds, "animationBounds");
  boundsContainBounds(bounds, sourceBounds);
  boundsContain(bounds, positions, indices, submeshes);

  const textures = model.textures.map((texture, index) => {
    if (!texture || typeof texture !== "object" || !Number.isInteger(texture.type) || texture.type < 0 || texture.type > 0xffff
      || !Number.isInteger(texture.flags) || texture.flags < 0 || texture.flags > 0xffff
      || typeof texture.filename !== "string" || Buffer.byteLength(texture.filename, "utf8") > 1000) {
      throw new Error(`texture ${index} is invalid`);
    }
    return { type: texture.type, flags: texture.flags, filename: texture.filename };
  });
  const colours = model.colours.map((colour, index) => ({
    rgb: validateTrack(colour?.rgb, 3, effects.globalSequences.length, `colour ${index}.rgb`),
    alpha: validateTrack(colour?.alpha, 1, effects.globalSequences.length, `colour ${index}.alpha`),
  }));
  const textureWeights = model.textureWeights.map((track, index) => validateTrack(track, 1, effects.globalSequences.length, `textureWeight ${index}`));
  const textureTransforms = model.textureTransforms.map((transform, index) => ({
    translation: validateTrack(transform?.translation, 3, effects.globalSequences.length, `textureTransform ${index}.translation`),
    rotation: validateTrack(transform?.rotation, 4, effects.globalSequences.length, `textureTransform ${index}.rotation`),
    scaling: validateTrack(transform?.scaling, 3, effects.globalSequences.length, `textureTransform ${index}.scaling`),
  }));
  const batches = model.batches.map((batch, index) => {
    if (!batch || typeof batch !== "object" || !Number.isInteger(batch.submesh) || batch.submesh < 0 || batch.submesh >= submeshes.length
      || !Number.isInteger(batch.blendMode) || batch.blendMode < 0 || batch.blendMode > 255
      || !Number.isInteger(batch.materialFlags) || batch.materialFlags < 0 || batch.materialFlags > 255
      || !Number.isInteger(batch.priorityPlane) || batch.priorityPlane < -128 || batch.priorityPlane > 127
      || !Number.isInteger(batch.materialLayer) || batch.materialLayer < 0 || batch.materialLayer > 255
      || !Number.isInteger(batch.shaderId) || batch.shaderId < 0 || batch.shaderId > 0xffff
      || !Number.isInteger(batch.flags) || batch.flags < 0 || batch.flags > 255
      || !Array.isArray(batch.textures) || batch.textures.length > 2 || !Array.isArray(batch.uvSets)
      || batch.uvSets.length !== batch.textures.length || !Number.isInteger(batch.colorIndex) || batch.colorIndex < 0 || batch.colorIndex > 0xffff
      || !Number.isInteger(batch.textureWeight) || batch.textureWeight < -1 || batch.textureWeight > 0x7fff
      || !Number.isInteger(batch.textureTransform) || batch.textureTransform < -1 || batch.textureTransform > 0x7fff) {
      throw new Error(`batch ${index} is invalid`);
    }
    for (let unit = 0; unit < batch.textures.length; unit++) {
      integer(batch.textures[unit], -1, textures.length - 1, "batch texture");
      integer(batch.uvSets[unit], 0, 1, "batch UV set");
    }
    if (batch.colorIndex !== 0xffff && batch.colorIndex >= colours.length) throw new Error("batch colour reference is invalid");
    if (batch.textureWeight !== -1 && batch.textureWeight >= textureWeights.length) throw new Error("batch weight reference is invalid");
    if (batch.textureTransform !== -1 && batch.textureTransform >= textureTransforms.length) throw new Error("batch transform reference is invalid");
    return {
      submesh: batch.submesh,
      priorityPlane: batch.priorityPlane,
      materialLayer: batch.materialLayer,
      shaderId: batch.shaderId,
      flags: batch.flags,
      blendMode: batch.blendMode,
      materialFlags: batch.materialFlags,
      textures: [...batch.textures],
      uvSets: [...batch.uvSets],
      colorIndex: batch.colorIndex,
      textureWeight: batch.textureWeight,
      textureTransform: batch.textureTransform,
    };
  });
  const unsupported = model.unsupported;
  if (!unsupported || typeof unsupported !== "object") throw new Error("M2 unsupported counts are required");
  const counts = {};
  for (const field of ["globalLoops", "particleEmitters", "ribbonEmitters", "events"]) counts[field] = integer(unsupported[field], 0, MAX_TABLE_ENTRIES, `unsupported.${field}`);
  if (counts.events !== 0 || counts.globalLoops !== effects.globalSequences.length
    || counts.particleEmitters !== effects.particleEmitters.length || counts.ribbonEmitters !== effects.ribbonEmitters.length) {
    throw new Error("parsed effect counts do not match the supplied round-trip effects");
  }
  const version = integer(model.version, 0, 0xffff_ffff, "M2 version");
  return {
    version, positions, normals, uv0, uv1, boneIndices, boneWeights, indices, submeshes, batches, textures,
    bounds, colours, textureWeights, textureTransforms, portraitCamera: validateCamera(model.portraitCamera),
    unsupported: counts,
    sourceTriangles: submeshes.reduce((sum, submesh) => sum + submesh.indexCount / 3, 0),
    sourceDrawTriangles: batches.reduce((sum, batch) => sum + submeshes[batch.submesh].indexCount / 3, 0),
  };
}

function validateEffects(effects) {
  if (!effects || typeof effects !== "object") throw new Error("effects are required");
  const globalSequences = effects.globalSequences === undefined ? new Uint32Array(0) : effects.globalSequences;
  if (!isTypedArray(globalSequences) || globalSequences.length > MAX_TABLE_ENTRIES) throw new Error("global sequences are invalid");
  const clonedGlobals = new Uint32Array(globalSequences.length);
  for (let index = 0; index < clonedGlobals.length; index++) clonedGlobals[index] = integer(globalSequences[index], 0, 0xffff_ffff, "global sequence");
  const particleEmitters = effects.particleEmitters === undefined ? [] : effects.particleEmitters;
  const ribbonEmitters = effects.ribbonEmitters === undefined ? [] : effects.ribbonEmitters;
  if (!Array.isArray(particleEmitters) || particleEmitters.length > MAX_EMITTERS
    || !Array.isArray(ribbonEmitters) || ribbonEmitters.length > MAX_EMITTERS) throw new Error("effect tables are invalid");
  // Emitters are intentionally not part of R4.1a: their bone/effect state has no safe HLOD runtime
  // admission yet.  A non-empty table therefore fails closed rather than being dropped by WVM9.
  if (particleEmitters.length !== 0 || ribbonEmitters.length !== 0) throw new Error("emitters are not supported by R4.1a");
  return { globalSequences: clonedGlobals, particleEmitters: [], ribbonEmitters: [] };
}

function validateCamera(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("portrait camera is invalid");
  const camera = {
    fov: finiteF32(value.fov, "portraitCamera.fov"),
    near: finiteF32(value.near, "portraitCamera.near"),
    far: finiteF32(value.far, "portraitCamera.far"),
    position: finiteVector(value.position, 3, "portraitCamera.position"),
    target: finiteVector(value.target, 3, "portraitCamera.target"),
  };
  if (camera.fov < 0.05 || camera.fov > 3.2 || camera.near < 0 || camera.far <= camera.near) {
    throw new Error("portrait camera range is invalid");
  }
  return camera;
}

function distributeTargets(submeshes, totalTarget) {
  const totalSource = submeshes.reduce((sum, submesh) => sum + submesh.indexCount / 3, 0);
  if (!Number.isInteger(totalTarget) || totalTarget < submeshes.length || totalTarget >= totalSource) return undefined;
  const targets = submeshes.map((submesh, index) => {
    const sourceTriangles = submesh.indexCount / 3;
    const ideal = sourceTriangles * totalTarget / totalSource;
    return { index, sourceTriangles, ideal, target: Math.max(1, Math.floor(ideal)) };
  });
  let assigned = targets.reduce((sum, entry) => sum + entry.target, 0);
  while (assigned < totalTarget) {
    const candidate = targets.filter((entry) => entry.target < entry.sourceTriangles)
      .sort((left, right) => (right.ideal - right.target) - (left.ideal - left.target) || left.index - right.index)[0];
    if (!candidate) return undefined;
    candidate.target++;
    assigned++;
  }
  while (assigned > totalTarget) {
    const candidate = targets.filter((entry) => entry.target > 1)
      .sort((left, right) => (right.target - right.ideal) - (left.target - left.ideal) || left.index - right.index)[0];
    if (!candidate) return undefined;
    candidate.target--;
    assigned--;
  }
  targets.sort((left, right) => left.index - right.index);
  return targets.map((entry) => entry.target);
}

function simplifySubmesh(model, submesh, targetTriangles) {
  const vertexStart = submesh.vertexStart;
  const vertexEnd = vertexStart + submesh.vertexCount;
  const localPositions = model.positions.slice(vertexStart * 3, vertexEnd * 3);
  const localIndices = new Uint32Array(submesh.indexCount);
  const vertexLock = new Uint8Array(submesh.vertexCount);
  const attributeCount = ATTRIBUTE_WEIGHTS.length;
  const attributes = new Float32Array(submesh.vertexCount * attributeCount);
  for (let vertex = 0; vertex < submesh.vertexCount; vertex++) {
    const sourceVertex = vertexStart + vertex;
    const at = vertex * attributeCount;
    attributes.set(model.normals.subarray(sourceVertex * 3, sourceVertex * 3 + 3), at);
    attributes.set(model.uv0.subarray(sourceVertex * 2, sourceVertex * 2 + 2), at + 3);
    attributes.set(model.uv1.subarray(sourceVertex * 2, sourceVertex * 2 + 2), at + 5);
    for (let slot = 0; slot < 4; slot++) {
      attributes[at + 7 + slot] = model.boneIndices[sourceVertex * 4 + slot];
      attributes[at + 11 + slot] = model.boneWeights[sourceVertex * 4 + slot];
    }
  }
  for (let index = 0; index < submesh.indexCount; index++) localIndices[index] = model.indices[submesh.indexStart + index] - vertexStart;
  const sameBoneSignature = (left, right) => {
    for (let slot = 0; slot < 4; slot++) {
      if (model.boneIndices[left * 4 + slot] !== model.boneIndices[right * 4 + slot]
        || model.boneWeights[left * 4 + slot] !== model.boneWeights[right * 4 + slot]) return false;
    }
    return true;
  };
  for (let at = 0; at < localIndices.length; at += 3) {
    const a = localIndices[at] + vertexStart;
    const b = localIndices[at + 1] + vertexStart;
    const c = localIndices[at + 2] + vertexStart;
    for (const [left, right] of [[a, b], [b, c], [c, a]]) {
      if (!sameBoneSignature(left, right)) {
        vertexLock[left - vertexStart] = 1;
        vertexLock[right - vertexStart] = 1;
      }
    }
  }
  const [rawResult, error] = MeshoptSimplifier.simplifyWithAttributes(
    localIndices, localPositions, 3, attributes, attributeCount, ATTRIBUTE_WEIGHTS, vertexLock,
    targetTriangles * 3, TARGET_ERROR, LOCK_FLAGS,
  );
  if (!Number.isFinite(error)) throw new Error("meshoptimizer returned an invalid error");
  const result = new Uint32Array(rawResult);
  if (result.length < 3 || result.length % 3 !== 0 || result.length > targetTriangles * 3) throw new Error("target was not reached");
  const global = new Uint32Array(result.length);
  for (let index = 0; index < result.length; index++) {
    if (result[index] >= submesh.vertexCount) throw new Error("simplified index escaped submesh");
    global[index] = result[index] + vertexStart;
  }
  return global;
}

function validateOutputTopology(indices, positions, submeshes) {
  for (const submesh of submeshes) {
    const edges = new Map();
    for (let at = submesh.indexStart; at < submesh.indexStart + submesh.indexCount; at += 3) {
      const [a, b, c] = [indices[at], indices[at + 1], indices[at + 2]];
      if (a < submesh.vertexStart || a >= submesh.vertexStart + submesh.vertexCount
        || b < submesh.vertexStart || b >= submesh.vertexStart + submesh.vertexCount
        || c < submesh.vertexStart || c >= submesh.vertexStart + submesh.vertexCount || a === b || b === c || a === c) {
        throw new Error("simplified topology is invalid");
      }
      const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
      const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
      const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
      const crossX = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const crossY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const crossZ = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (!(crossX * crossX + crossY * crossY + crossZ * crossZ > 1e-12)) throw new Error("simplified topology is degenerate");
      for (const [from, to] of [[a, b], [b, c], [c, a]]) {
        const edge = from < to ? `${from}/${to}` : `${to}/${from}`;
        const count = (edges.get(edge) ?? 0) + 1;
        if (count > 2) throw new Error("simplified topology is non-manifold");
        edges.set(edge, count);
      }
    }
  }
}

function validatePlacement(options) {
  const clear = (value) => value === undefined || value === false || value === 0;
  if (options.kind !== "m2" || options.exterior !== true || options.skinned !== true || options.animated !== true
    || !clear(options.interior) || !clear(options.composite) || !clear(options.legacy)
    || !clear(options.particleEmitters) || !clear(options.ribbonEmitters)) throw new Error("ineligible M2 placement");
}

/**
 * Build a deterministic, offline skinned M2 HLOD proof.  All source geometry, rig/material tracks
 * and supplied effects are caller-owned parsed data; this function never performs resource lookup.
 */
export async function simplifySkinnedM2(options = {}) {
  try {
    if (!options || typeof options !== "object") return undefined;
    validatePlacement(options);
    const modelPath = canonicalAssetPath(options.modelPath, "m2");
    if (!modelPath || typeof options.modelSha1 !== "string" || !/^[a-f0-9]{40}$/i.test(options.modelSha1)
      || typeof options.algorithmVersion !== "string" || options.algorithmVersion.length === 0) return undefined;
    const sourceStamp = cloneStamp(options.sourceStamp, "sourceStamp");
    const skeleton = validateSkeleton(options.skeleton, 0);
    const ids = animationIds(options.animations, skeleton.clips);
    const clipIds = new Set(skeleton.clips.map((clip) => clip.animationId));
    const sources = validateAnimationSources(options.animationSources, ids, clipIds);
    const effects = validateEffects(options.effects);
    const parsed = validateModel(options.model, skeleton, effects, options.animationBounds);
    if (parsed.unsupported.globalLoops !== effects.globalSequences.length
      || parsed.unsupported.particleEmitters !== effects.particleEmitters.length
      || parsed.unsupported.ribbonEmitters !== effects.ribbonEmitters.length) return undefined;
    // Material tracks may legally bind to global sequences; validateModel did this against the
    // supplied count. Re-check all explicit track tables after effects are known.
    const targets = distributeTargets(parsed.submeshes, options.targetTriangles);
    if (!targets || MeshoptSimplifier.supported === false) return undefined;
    await MeshoptSimplifier.ready;
    const simplified = parsed.submeshes.map((submesh, index) => simplifySubmesh(parsed, submesh, targets[index]));
    const totalIndices = simplified.reduce((sum, range) => sum + range.length, 0);
    if (totalIndices >= parsed.sourceTriangles * 3 || totalIndices / 3 > options.targetTriangles) return undefined;
    const outputIndices32 = new Uint32Array(totalIndices);
    const outputSubmeshes = [];
    let offset = 0;
    for (let index = 0; index < parsed.submeshes.length; index++) {
      const range = simplified[index];
      outputIndices32.set(range, offset);
      const source = parsed.submeshes[index];
      outputSubmeshes.push({
        geosetId: source.geosetId,
        vertexStart: source.vertexStart,
        vertexCount: source.vertexCount,
        indexStart: offset,
        indexCount: range.length,
        centre: [...source.centre],
        sortRadius: source.sortRadius,
      });
      offset += range.length;
    }
    validateOutputTopology(outputIndices32, parsed.positions, outputSubmeshes);
    const outputIndices = parsed.positions.length / 3 <= 65_535 ? new Uint16Array(outputIndices32) : outputIndices32;
    const outputModel = {
      version: parsed.version,
      positions: new Float32Array(parsed.positions),
      normals: new Float32Array(parsed.normals),
      uv0: new Float32Array(parsed.uv0),
      uv1: new Float32Array(parsed.uv1),
      boneIndices: new Uint8Array(parsed.boneIndices),
      boneWeights: new Uint8Array(parsed.boneWeights),
      indices: outputIndices,
      submeshes: outputSubmeshes,
      batches: parsed.batches.map((batch) => ({
        submesh: batch.submesh,
        priorityPlane: batch.priorityPlane,
        materialLayer: batch.materialLayer,
        shaderId: batch.shaderId,
        flags: batch.flags,
        blendMode: batch.blendMode,
        materialFlags: batch.materialFlags,
        textures: [...batch.textures],
        uvSets: [...batch.uvSets],
        colorIndex: batch.colorIndex,
        textureWeight: batch.textureWeight,
        textureTransform: batch.textureTransform,
      })),
      textures: parsed.textures.map((texture) => ({ type: texture.type, flags: texture.flags, filename: texture.filename })),
      bounds: { min: [...parsed.bounds.min], max: [...parsed.bounds.max], radius: parsed.bounds.radius },
      unsupported: { ...parsed.unsupported },
      colours: parsed.colours.map(copyColour),
      textureWeights: parsed.textureWeights.map(copyTrack),
      textureTransforms: parsed.textureTransforms.map(copyTransform),
    };
    if (parsed.portraitCamera !== undefined) {
      outputModel.portraitCamera = {
        fov: parsed.portraitCamera.fov,
        near: parsed.portraitCamera.near,
        far: parsed.portraitCamera.far,
        position: [...parsed.portraitCamera.position],
        target: [...parsed.portraitCamera.target],
      };
    }
    const outputSkeleton = copySkeleton(skeleton);
    const outputEffects = {
      globalSequences: new Uint32Array(effects.globalSequences),
      particleEmitters: [],
      ribbonEmitters: [],
    };
    const bytes = encodeWvm9(outputModel, outputSkeleton, ids, outputEffects);
    const identity = canonicalJson({
      modelPath,
      modelSha1: options.modelSha1,
      sourceStamp,
      animationSources: sources,
      algorithmVersion: options.algorithmVersion,
      targetTriangles: options.targetTriangles,
      sidecarIdentity: sources,
      targetError: TARGET_ERROR,
      attributeWeights: ATTRIBUTE_WEIGHTS,
      flags: LOCK_FLAGS,
    });
    const bytesSha1 = createHash("sha1").update(bytes).digest("hex");
    const profileId = `r4.1a-${createHash("sha1").update(identity).update(bytesSha1).digest("hex")}`;
    const profile = {
      profileId,
      modelPath,
      modelSha1: options.modelSha1,
      sourceStamp,
      algorithmVersion: options.algorithmVersion,
      targetTriangles: options.targetTriangles,
      version: outputModel.version,
      animationSources: sources,
      sidecarIdentity: canonicalJson(sources),
      animationBounds: { min: [...parsed.bounds.min], max: [...parsed.bounds.max], radius: parsed.bounds.radius },
      sourceTriangleCount: parsed.sourceTriangles,
      uniqueSourceTriangleCount: parsed.sourceTriangles,
      sourceDrawTriangleCount: parsed.sourceDrawTriangles,
      triangleCount: outputIndices.length / 3,
      drawTriangleCount: outputModel.batches.reduce((sum, batch) => sum + outputModel.submeshes[batch.submesh].indexCount / 3, 0),
      positions: outputModel.positions,
      normals: outputModel.normals,
      uv0: outputModel.uv0,
      uv1: outputModel.uv1,
      boneIndices: outputModel.boneIndices,
      boneWeights: outputModel.boneWeights,
      indices: outputModel.indices,
      submeshes: outputModel.submeshes,
      batches: outputModel.batches,
      textures: outputModel.textures,
      bounds: outputModel.bounds,
      unsupported: outputModel.unsupported,
      colours: outputModel.colours,
      textureWeights: outputModel.textureWeights,
      textureTransforms: outputModel.textureTransforms,
      portraitCamera: outputModel.portraitCamera === undefined ? undefined : {
        fov: outputModel.portraitCamera.fov,
        near: outputModel.portraitCamera.near,
        far: outputModel.portraitCamera.far,
        position: [...outputModel.portraitCamera.position],
        target: [...outputModel.portraitCamera.target],
      },
      skeleton: outputSkeleton,
      animations: [...ids],
      effects: outputEffects,
      bytes,
    };
    for (const field of ["sourceStamp", "animationSources", "animationBounds", "submeshes", "batches", "textures", "bounds",
      "unsupported", "colours", "textureWeights", "textureTransforms", "skeleton", "effects"]) freezeMetadata(profile[field]);
    return Object.freeze(profile);
  } catch {
    return undefined;
  }
}
