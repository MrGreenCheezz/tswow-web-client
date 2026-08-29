// Small, offline-only metadata layer for authored M2 skin profiles.
//
// R4.0a deliberately does not change the WVM wire format or runtime model route. R4.0b adds an
// offline-only geometry variant below; raw M2 and SKIN buffers still never escape this module.

import { createHash } from "node:crypto";
import { MeshoptSimplifier } from "meshoptimizer";
import { encodeWvm9 } from "./wvm.mjs";

const MD20 = "MD20";
const SKIN = "SKIN";
const MODEL_HEADER_SIZE = 0x48;
const MODEL_VERTEX_HEADER = 0x3c;
const MODEL_VIEW_COUNT = 0x44;
const MODEL_VERTEX_SIZE = 48;
const SKIN_HEADER_SIZE = 0x2c;
const SKIN_LOOKUP = 0x04;
const SKIN_TRIANGLES = 0x0c;
const SKIN_SUBMESHES = 0x1c;
const SKIN_BATCHES = 0x24;
const SKIN_SUBMESH_SIZE = 48;
const SKIN_BATCH_SIZE = 24;
const MAX_VERTICES = 1_000_000;
const MAX_LOOKUP = 1_000_000;
const MAX_TRIANGLES = 6_000_000;
const MAX_TABLE_ENTRIES = 1_000_000;

const FULL_PROFILE_ID = "00";
const FIRST_LOW_PROFILE_ID = "01";
const MID_DISTANCE_START = 300;
const MID_DISTANCE_END = 600;

function asBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`${label} must be a Buffer or Uint8Array`);
}

function readU32(buffer, offset, label) {
  if (offset < 0 || offset + 4 > buffer.length) throw new Error(`${label} is outside the buffer`);
  return buffer.readUInt32LE(offset);
}

function readU16(buffer, offset, label) {
  if (offset < 0 || offset + 2 > buffer.length) throw new Error(`${label} is outside the buffer`);
  return buffer.readUInt16LE(offset);
}

function readF32(buffer, offset, label) {
  if (offset < 0 || offset + 4 > buffer.length) throw new Error(`${label} is outside the buffer`);
  const value = buffer.readFloatLE(offset);
  if (!Number.isFinite(value)) throw new Error(`${label} is not finite`);
  return value;
}

function checkedArray(buffer, offset, stride, maxCount, label, minimumOffset = 0) {
  const count = readU32(buffer, offset, `${label} count`);
  const at = readU32(buffer, offset + 4, `${label} offset`);
  if (count > maxCount || at < minimumOffset || at > buffer.length || count > Math.floor((buffer.length - at) / stride)) {
    throw new Error(`${label} table is invalid`);
  }
  return { count, offset: at };
}

function normaliseAssetPath(value, extension) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return undefined;
  const path = value.replaceAll("/", "\\");
  if (path.includes("\0") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)
    || path.split("\\").some((part) => part === "." || part === "..")) return undefined;
  if (!/^[^\\]+(?:\\[^\\]+)*\.[a-z0-9]+$/i.test(path)) return undefined;
  if (!path.toLowerCase().endsWith(`.${extension}`)) return undefined;
  return path;
}

function canonicalModelPath(value) {
  return normaliseAssetPath(value, "m2");
}

function profileId(value) {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 99) return undefined;
    return String(value).padStart(2, "0");
  }
  if (typeof value !== "string") return undefined;
  if (/^\d$/.test(value)) return `0${value}`;
  if (/^\d{2}$/.test(value)) return value;
  return undefined;
}

function canonicalProfilePath(modelPath, id) {
  return `${modelPath.slice(0, -3)}${id}.skin`;
}

function sourceStampKey(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.length > 0 ? `s:${value}` : undefined;
  if (typeof value !== "object") return undefined;
  try {
    return `j:${canonicalJson(value)}`;
  } catch {
    return undefined;
  }
}

/** Canonical JSON for source identity; object property order must not affect an artifact key. */
function canonicalJson(value, stack = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("source stamp contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error("source stamp is not JSON serialisable");
  if (stack.has(value)) throw new Error("source stamp is cyclic");
  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((entry) => canonicalJson(entry, stack)).join(",")}]`;
  } else {
    const keys = Object.keys(value).sort();
    result = `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], stack)}`).join(",")}}`;
  }
  stack.delete(value);
  return result;
}

function cloneStamp(value) {
  if (value === null || typeof value !== "object") return value;
  // Stamps are normally small plain JSON objects.  Clone the serialisable value so a caller cannot
  // mutate a frozen profile's source identity through a nested stamp object.
  const clone = JSON.parse(canonicalJson(value));
  const freeze = (entry) => {
    if (entry && typeof entry === "object") {
      for (const child of Object.values(entry)) freeze(child);
      Object.freeze(entry);
    }
    return entry;
  };
  return freeze(clone);
}

function sameStamp(left, right) {
  return sourceStampKey(left) !== undefined && sourceStampKey(left) === sourceStampKey(right);
}

function validateModel(model) {
  const data = asBuffer(model, "model");
  if (data.length < MODEL_HEADER_SIZE || data.subarray(0, 4).toString("ascii") !== MD20) {
    throw new Error("M2 parent is not an MD20 model");
  }
  const views = readU32(data, MODEL_VIEW_COUNT, "M2 view count");
  const vertices = checkedArray(data, MODEL_VERTEX_HEADER, MODEL_VERTEX_SIZE, MAX_VERTICES,
    "M2 vertex", MODEL_HEADER_SIZE);
  return { data, views, vertices };
}

function inspectSkin(modelInfo, skin) {
  const data = asBuffer(skin, "skin");
  if (data.length < SKIN_HEADER_SIZE || data.subarray(0, 4).toString("ascii") !== SKIN) {
    throw new Error("M2 profile is not a SKIN file");
  }
  const lookup = checkedArray(data, SKIN_LOOKUP, 2, MAX_LOOKUP, "SKIN lookup", SKIN_HEADER_SIZE);
  const triangles = checkedArray(data, SKIN_TRIANGLES, 2, MAX_TRIANGLES, "SKIN triangle", SKIN_HEADER_SIZE);
  if (triangles.count % 3 !== 0) throw new Error("SKIN triangle table is not a triangle list");

  const modelVertices = modelInfo.vertices.count;
  for (let index = 0; index < lookup.count; index++) {
    if (readU16(data, lookup.offset + index * 2, "SKIN lookup entry") >= modelVertices) {
      throw new Error("SKIN lookup references a vertex outside the parent M2");
    }
  }
  for (let index = 0; index < triangles.count; index++) {
    if (readU16(data, triangles.offset + index * 2, "SKIN triangle entry") >= lookup.count) {
      throw new Error("SKIN triangle references an invalid lookup vertex");
    }
  }

  const submeshes = checkedArray(data, SKIN_SUBMESHES, SKIN_SUBMESH_SIZE, MAX_TABLE_ENTRIES,
    "SKIN submesh", SKIN_HEADER_SIZE);
  const batches = checkedArray(data, SKIN_BATCHES, SKIN_BATCH_SIZE, MAX_TABLE_ENTRIES,
    "SKIN batch", SKIN_HEADER_SIZE);
  if (submeshes.count === 0 || batches.count === 0) {
    throw new Error("SKIN profile has no drawable submesh batches");
  }
  const submeshIndexCounts = new Uint32Array(submeshes.count);
  for (let index = 0; index < submeshes.count; index++) {
    const at = submeshes.offset + index * SKIN_SUBMESH_SIZE;
    const level = readU16(data, at + 2, "SKIN submesh level");
    const vertexStart = readU16(data, at + 4, "SKIN vertex start") + level * 0x10000;
    const vertexCount = readU16(data, at + 6, "SKIN vertex count");
    const indexStart = readU16(data, at + 8, "SKIN index start") + level * 0x10000;
    const indexCount = readU16(data, at + 10, "SKIN index count");
    if (indexCount % 3 !== 0
      || vertexStart + vertexCount > lookup.count || indexStart + indexCount > triangles.count) {
      throw new Error("SKIN submesh range is outside the profile tables");
    }
    submeshIndexCounts[index] = indexCount;
    readF32(data, at + 20, "SKIN submesh centre X");
    readF32(data, at + 24, "SKIN submesh centre Y");
    readF32(data, at + 28, "SKIN submesh centre Z");
    readF32(data, at + 44, "SKIN submesh sort radius");
  }
  let drawIndexCount = 0;
  const drawnSubmeshes = new Set();
  for (let index = 0; index < batches.count; index++) {
    const at = batches.offset + index * SKIN_BATCH_SIZE;
    const submesh = readU16(data, at + 4, "SKIN batch submesh");
    if (submesh >= submeshes.count) {
      throw new Error("SKIN batch references an invalid submesh");
    }
    drawIndexCount += submeshIndexCounts[submesh];
    drawnSubmeshes.add(submesh);
  }
  const uniqueDrawIndexCount = [...drawnSubmeshes]
    .reduce((total, submesh) => total + submeshIndexCounts[submesh], 0);

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let radius = 0;
  for (let index = 0; index < lookup.count; index++) {
    const vertex = readU16(data, lookup.offset + index * 2, "SKIN lookup entry");
    const at = modelInfo.vertices.offset + vertex * MODEL_VERTEX_SIZE;
    const x = readF32(modelInfo.data, at, "M2 vertex X");
    const y = readF32(modelInfo.data, at + 4, "M2 vertex Y");
    const z = readF32(modelInfo.data, at + 8, "M2 vertex Z");
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
    radius = Math.max(radius, Math.hypot(x, y, z));
  }
  if (lookup.count === 0 || triangles.count === 0 || drawIndexCount === 0 || !Number.isFinite(radius)) {
    throw new Error("SKIN profile has no finite drawable bounds");
  }
  return {
    vertexCount: lookup.count,
    indexCount: triangles.count,
    sourceTriangleCount: triangles.count / 3,
    drawIndexCount,
    triangleCount: drawIndexCount / 3,
    uniqueDrawIndexCount,
    uniqueTriangleCount: uniqueDrawIndexCount / 3,
    bounds: Object.freeze({
      min: Object.freeze([minX, minY, minZ]),
      max: Object.freeze([maxX, maxY, maxZ]),
      radius,
    }),
  };
}

function inspectArguments(first, second, third) {
  if (first && typeof first === "object" && second === undefined && third === undefined
    && ("model" in first || "skin" in first)) {
    const options = first;
    return {
      model: options.model,
      skin: options.skin,
      modelPath: options.modelPath,
      profile: options.profile,
      profilePath: options.profilePath,
      sourceIdentity: options.sourceIdentity ?? options.modelSha1,
      sourceStamp: options.sourceStamp,
    };
  }
  const options = third ?? {};
  return {
    model: first,
    skin: second,
    modelPath: options.modelPath,
    profile: options.profile,
    profilePath: options.profilePath,
    sourceIdentity: options.sourceIdentity ?? options.modelSha1,
    sourceStamp: options.sourceStamp,
  };
}

/**
 * Inspect one authored M2 skin without retaining either source buffer.
 *
 * The source model and profile are preconditions of the returned metadata: callers must keep
 * their bytes and source stamp unchanged while using a descriptor.  A profile is accepted only
 * when its canonical NN.skin view exists in the parent MD20's declared view count.
 */
export function inspectM2SkinProfile(first, second, third) {
  const options = inspectArguments(first, second, third);
  const modelPath = canonicalModelPath(options.modelPath);
  if (!modelPath) throw new Error("modelPath must be a canonical .m2 asset path");
  const modelInfo = validateModel(options.model);
  const stampKey = sourceStampKey(options.sourceStamp);
  if (stampKey === undefined) throw new Error("sourceStamp must be a non-empty serialisable value");
  if (options.sourceIdentity !== undefined
    && (typeof options.sourceIdentity !== "string" || options.sourceIdentity.length === 0)) {
    throw new Error("sourceIdentity must be a non-empty string");
  }

  let id = profileId(options.profile);
  const suppliedPath = options.profilePath === undefined ? undefined : normaliseAssetPath(options.profilePath, "skin");
  if (options.profilePath !== undefined && !suppliedPath) {
    throw new Error("profilePath must be a canonical .skin asset path");
  }
  if (suppliedPath) {
    const base = modelPath.slice(0, -3);
    const match = new RegExp(`^${escapeRegExp(base)}(\\d{2})\\.skin$`, "i").exec(suppliedPath);
    if (!match) throw new Error("profilePath is not the canonical profile of modelPath");
    if (id !== undefined && id !== match[1]) throw new Error("profile and profilePath disagree");
    id = match[1];
  }
  if (id === undefined) id = FULL_PROFILE_ID;
  const profilePath = canonicalProfilePath(modelPath, id);
  if (modelInfo.views <= Number(id)) {
    throw new Error("M2 does not declare the requested skin view");
  }
  const inspected = inspectSkin(modelInfo, options.skin);
  const modelSha1 = createHash("sha1").update(modelInfo.data).digest("hex");
  const result = {
    modelPath,
    profile: id,
    profileId: id,
    profilePath,
    sourceIdentity: options.sourceIdentity ?? modelSha1,
    modelSha1,
    sourceStamp: cloneStamp(options.sourceStamp),
    declaredViews: modelInfo.views,
    ...inspected,
  };
  return Object.freeze(result);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function profileIsValid(profile, modelPath, sourceIdentity, modelSha1, sourceStamp) {
  if (!profile || typeof profile !== "object") return false;
  if (profile.modelPath !== modelPath || !/^\d{2}$/.test(profile.profileId)
    || profile.profilePath !== canonicalProfilePath(modelPath, profile.profileId)) return false;
  if (sourceIdentity !== undefined && profile.sourceIdentity !== sourceIdentity
    && profile.modelSha1 !== sourceIdentity) return false;
  if (modelSha1 !== undefined && profile.modelSha1 !== modelSha1) return false;
  if (!sameStamp(profile.sourceStamp, sourceStamp)) return false;
  return Number.isInteger(profile.vertexCount) && profile.vertexCount > 0
    && Number.isInteger(profile.indexCount) && profile.indexCount > 0
    && Number.isInteger(profile.sourceTriangleCount) && profile.sourceTriangleCount > 0
    && profile.indexCount === profile.sourceTriangleCount * 3
    && Number.isInteger(profile.drawIndexCount) && profile.drawIndexCount > 0
    && Number.isInteger(profile.triangleCount) && profile.triangleCount > 0
    && profile.drawIndexCount === profile.triangleCount * 3
    && profile.bounds && Array.isArray(profile.bounds.min) && Array.isArray(profile.bounds.max)
    && profile.bounds.min.length === 3 && profile.bounds.max.length === 3
    && profile.modelSha1 && typeof profile.modelSha1 === "string"
    && [...profile.bounds.min, ...profile.bounds.max, profile.bounds.radius].every(Number.isFinite);
}

/** Build an immutable, source-bound descriptor while preserving the exact profile object refs. */
export function createM2LodDescriptor(input = {}) {
  if (!input || (typeof input !== "object" && !Array.isArray(input))) {
    throw new TypeError("descriptor input is required");
  }
  const options = Array.isArray(input) ? arguments[1] ?? {} : input;
  const sourceProfiles = Array.isArray(input) ? input : input.profiles;
  if (!Array.isArray(sourceProfiles) || sourceProfiles.length === 0) {
    throw new Error("at least one M2 skin profile is required");
  }
  const firstProfile = sourceProfiles[0];
  const modelPath = canonicalModelPath(options.modelPath ?? firstProfile?.modelPath);
  if (!modelPath) throw new Error("modelPath must be a canonical .m2 asset path");
  const modelInfo = options.model === undefined ? undefined : validateModel(options.model);
  const computedModelSha1 = modelInfo ? createHash("sha1").update(modelInfo.data).digest("hex") : undefined;
  const modelSha1 = options.modelSha1 ?? computedModelSha1 ?? firstProfile?.modelSha1;
  const sourceIdentity = options.sourceIdentity ?? firstProfile?.sourceIdentity ?? modelSha1;
  if (sourceIdentity !== undefined
    && (typeof sourceIdentity !== "string" || sourceIdentity.length === 0)) {
    throw new Error("sourceIdentity/modelSha1 must be a non-empty string");
  }
  if (modelSha1 !== undefined && (typeof modelSha1 !== "string" || modelSha1.length === 0)) {
    throw new Error("modelSha1 must be a non-empty string");
  }
  if (computedModelSha1 !== undefined && modelSha1 !== computedModelSha1) {
    throw new Error("modelSha1 does not match the supplied M2");
  }
  const sourceStamp = options.sourceStamp ?? firstProfile?.sourceStamp;
  const stampKey = sourceStampKey(sourceStamp);
  if (stampKey === undefined) throw new Error("sourceStamp must be a non-empty serialisable value");
  if (options.modelSha1 !== undefined && options.sourceIdentity !== undefined
    && options.modelSha1 !== options.sourceIdentity) {
    throw new Error("sourceIdentity and modelSha1 disagree");
  }

  const profiles = [...sourceProfiles];
  const seen = new Set();
  for (const profile of profiles) {
    if (!profileIsValid(profile, modelPath, sourceIdentity, modelSha1, sourceStamp)) {
      throw new Error("profile is not source-bound or structurally valid");
    }
    if (seen.has(profile.profileId)) throw new Error("duplicate M2 skin profile");
    seen.add(profile.profileId);
  }
  const full = profiles.find((profile) => profile.profileId === FULL_PROFILE_ID);
  if (!full) throw new Error("descriptor requires the canonical 00.skin profile");
  const lowCandidates = profiles
    .filter((profile) => profile.profileId !== FULL_PROFILE_ID)
    .filter((profile) => profile.triangleCount < full.triangleCount)
    .sort((left, right) => left.profileId.localeCompare(right.profileId));
  // 01 is the authored mid ring.  Keep it when present; 02 remains in `profiles` for a future
  // farther tier.  If 01 is unavailable, the first canonical reduced profile is the fallback.
  const low = lowCandidates.find((profile) => profile.profileId === FIRST_LOW_PROFILE_ID)
    ?? lowCandidates[0];
  const descriptor = {
    modelPath,
    modelSha1,
    sourceIdentity,
    sourceStamp: cloneStamp(sourceStamp),
    full,
    profiles: Object.freeze(profiles),
  };
  if (low) descriptor.low = low;
  return Object.freeze(descriptor);
}

function contextValue(context, primary, alias) {
  if (context[primary] !== undefined) return context[primary];
  return alias ? context[alias] : undefined;
}

function positiveCount(value) {
  return value === true || (typeof value === "number" && value !== 0);
}

/**
 * Pure, resource-free policy for the R4.0a authored profiles.
 * Near objects remain full detail; only an explicitly enabled static exterior M2 may use 01.skin
 * in the [300, 600) mid ring, and only while the finite fog horizon reaches beyond it.
 */
export function selectM2LodProfile(descriptor, context = {}) {
  if (!descriptor || typeof descriptor !== "object" || !descriptor.full) return undefined;
  const distance = context.distance;
  if (!Number.isFinite(distance) || distance < 0) return undefined;
  const kind = typeof context.kind === "string" ? context.kind.toLowerCase() : undefined;
  if (kind !== "m2") return undefined;
  if (positiveCount(context.skinned) || positiveCount(context.animated)
    || positiveCount(context.emitters) || positiveCount(context.particleEmitters)
    || positiveCount(context.ribbonEmitters) || positiveCount(context.composite)
    || positiveCount(context.legacy)) {
    return undefined;
  }
  const staticModel = contextValue(context, "staticModel", "static");
  if (staticModel !== true) return undefined;
  if (context.interior === true || context.exterior === false) return undefined;
  if (distance < MID_DISTANCE_START) return descriptor.full;
  if (distance >= MID_DISTANCE_END) return undefined;
  if (context.exterior !== true && context.interior !== false) return undefined;
  const enabled = contextValue(context, "enabled", "optIn");
  if (enabled !== true) return undefined;
  if (!Number.isFinite(context.fogFar) || context.fogFar <= distance) return undefined;
  return descriptor.low;
}

const STATIC_LOD_TARGET_ERROR = 0.01;
const STATIC_LOD_ATTRIBUTE_WEIGHTS = [1, 1, 1, 1, 1, 1, 1];

function isTypedArray(value) {
  return ArrayBuffer.isView(value) && !(value instanceof DataView)
    && Number.isInteger(value.length);
}

function cloneTypedArray(value) {
  return new value.constructor(value);
}

function cloneMetadata(value) {
  if (Array.isArray(value)) return value.map(cloneMetadata);
  if (isTypedArray(value)) return cloneTypedArray(value);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) result[key] = cloneMetadata(child);
  return result;
}

// Typed arrays cannot be frozen when they contain elements. Freeze all plain metadata around
// them, while keeping the fresh numeric streams usable by Three.js and the WVM encoder.
function freezeMetadata(value) {
  if (!value || typeof value !== "object" || ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) freezeMetadata(child);
  return Object.freeze(value);
}

function staticFlagIsClear(value) {
  return value === undefined || value === false || value === 0;
}

function finiteStream(value, expectedLength, label) {
  if (!isTypedArray(value) || value.length !== expectedLength) throw new Error(`${label} stream is invalid`);
  const copy = new Float32Array(expectedLength);
  for (let index = 0; index < expectedLength; index++) {
    const number = value[index];
    if (typeof number !== "number" || !Number.isFinite(number)) throw new Error(`${label} is not finite`);
    copy[index] = number;
    if (!Number.isFinite(copy[index])) throw new Error(`${label} is outside Float32 range`);
  }
  return copy;
}

function finiteVector(value, length, label) {
  if (!value || typeof value.length !== "number" || value.length !== length) {
    throw new Error(`${label} is invalid`);
  }
  const copy = new Array(length);
  for (let index = 0; index < length; index++) {
    if (typeof value[index] !== "number" || !Number.isFinite(value[index])) {
      throw new Error(`${label} is not finite`);
    }
    copy[index] = value[index];
  }
  return copy;
}

function validateBounds(bounds) {
  if (!bounds || typeof bounds !== "object") throw new Error("M2 bounds are required");
  const min = finiteVector(bounds.min, 3, "M2 bounds min").map((value) => Math.fround(value));
  const max = finiteVector(bounds.max, 3, "M2 bounds max").map((value) => Math.fround(value));
  const radius = Math.fround(bounds.radius);
  if (![...min, ...max, radius].every(Number.isFinite)) throw new Error("M2 bounds do not survive Float32 encoding");
  if (min.some((value, axis) => value > max[axis])) throw new Error("M2 bounds are inverted");
  if (typeof bounds.radius !== "number" || !Number.isFinite(bounds.radius) || radius < 0) {
    throw new Error("M2 bounds radius is invalid");
  }
  return { min, max, radius };
}

function validateBoundsContainment(bounds, positions, indices, submeshes) {
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
        throw new Error("M2 bounds do not conservatively contain referenced vertices");
      }
    }
  }
}

function validateStaticModel(options) {
  if (!options || typeof options !== "object") return undefined;
  const modelPath = canonicalModelPath(options.modelPath);
  if (!modelPath || options.kind !== "m2" || options.staticModel !== true || options.exterior !== true
    || options.interior === true) return undefined;
  if (!staticFlagIsClear(options.skinned) || !staticFlagIsClear(options.animated)
    || !staticFlagIsClear(options.particleEmitters) || !staticFlagIsClear(options.ribbonEmitters)
    || !staticFlagIsClear(options.composite) || !staticFlagIsClear(options.legacy)) return undefined;
  if (typeof options.modelSha1 !== "string" || options.modelSha1.length === 0
    || typeof options.algorithmVersion !== "string" || options.algorithmVersion.length === 0
    || !Number.isInteger(options.targetTriangles) || options.targetTriangles < 1) return undefined;
  const stampKey = sourceStampKey(options.sourceStamp);
  if (stampKey === undefined) return undefined;

  const model = options.model;
  if (!model || typeof model !== "object" || !isTypedArray(model.positions)) return undefined;
  const vertexCount = model.positions.length / 3;
  if (!Number.isInteger(vertexCount) || vertexCount < 3 || vertexCount > MAX_VERTICES) return undefined;
  if (!Array.isArray(model.submeshes) || model.submeshes.length === 0
    || model.submeshes.length > MAX_TABLE_ENTRIES
    || !Array.isArray(model.batches) || model.batches.length === 0
    || model.batches.length > MAX_TABLE_ENTRIES
    || !Array.isArray(model.textures) || model.textures.length > 65_535) return undefined;

  const positions = finiteStream(model.positions, vertexCount * 3, "M2 positions");
  const normals = finiteStream(model.normals, vertexCount * 3, "M2 normals");
  const uv0 = finiteStream(model.uv0, vertexCount * 2, "M2 uv0");
  const uv1 = finiteStream(model.uv1, vertexCount * 2, "M2 uv1");
  if (!isTypedArray(model.indices) || model.indices.length === 0 || model.indices.length % 3 !== 0
    || model.indices.length > MAX_TRIANGLES * 3) return undefined;
  const indices = new Uint32Array(model.indices.length);
  for (let index = 0; index < model.indices.length; index++) {
    const value = model.indices[index];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= vertexCount) {
      throw new Error("M2 index stream is invalid");
    }
    indices[index] = value;
  }
  if (!isTypedArray(model.boneIndices) || !isTypedArray(model.boneWeights)
    || model.boneIndices.length !== vertexCount * 4 || model.boneWeights.length !== vertexCount * 4) {
    throw new Error("static M2 bone streams are invalid");
  }
  const boneIndices = cloneTypedArray(model.boneIndices);
  const boneWeights = cloneTypedArray(model.boneWeights);
  for (let index = 0; index < boneWeights.length; index++) {
    if (typeof boneWeights[index] !== "number" || boneWeights[index] !== 0) {
      throw new Error("static M2 has non-zero bone weights");
    }
    if (typeof boneIndices[index] !== "number" || !Number.isInteger(boneIndices[index])
      || boneIndices[index] < 0 || boneIndices[index] > 255) {
      throw new Error("static M2 bone indices are invalid");
    }
  }

  const unsupported = model.unsupported;
  if (!unsupported || typeof unsupported !== "object") throw new Error("M2 unsupported counts are missing");
  for (const field of ["globalLoops", "particleEmitters", "ribbonEmitters", "events"]) {
    if (!Number.isInteger(unsupported[field]) || unsupported[field] !== 0) {
      throw new Error(`static M2 has ${field}`);
    }
  }
  if (model.skeleton !== undefined && model.skeleton !== null) throw new Error("static M2 has a skeleton");
  for (const field of ["colours", "textureWeights", "textureTransforms"]) {
    if (model[field] !== undefined && (!Array.isArray(model[field]) || model[field].length !== 0)) {
      throw new Error(`static M2 has animated ${field}`);
    }
  }
  const bounds = validateBounds(model.bounds);
  const version = model.version === undefined ? 0 : model.version;
  if (!Number.isInteger(version) || version < 0 || version > 0xffff_ffff) {
    throw new Error("M2 model version is invalid");
  }
  for (const texture of model.textures) {
    if (!texture || typeof texture !== "object") throw new Error("M2 texture metadata is invalid");
    if (texture.type !== undefined && (!Number.isInteger(texture.type) || texture.type < 0 || texture.type > 65_535)) {
      throw new Error("M2 texture type is invalid");
    }
    if (texture.flags !== undefined && (!Number.isInteger(texture.flags) || texture.flags < 0 || texture.flags > 65_535)) {
      throw new Error("M2 texture flags are invalid");
    }
    if (texture.filename !== undefined && (typeof texture.filename !== "string"
      || Buffer.byteLength(texture.filename, "utf8") > 1000)) throw new Error("M2 texture path is invalid");
  }

  const submeshes = model.submeshes.map((source, submeshIndex) => {
    if (!source || typeof source !== "object") throw new Error(`M2 submesh ${submeshIndex} is invalid`);
    const vertexStart = source.vertexStart;
    const vertexCountInSubmesh = source.vertexCount;
    const indexStart = source.indexStart;
    const indexCount = source.indexCount;
    if (!Number.isInteger(source.geosetId) || source.geosetId < 0 || source.geosetId > 65_535
      || !Number.isInteger(vertexStart) || vertexStart < 0
      || !Number.isInteger(vertexCountInSubmesh) || vertexCountInSubmesh < 3
      || vertexStart + vertexCountInSubmesh > vertexCount
      || !Number.isInteger(indexStart) || indexStart < 0 || indexStart % 3 !== 0
      || !Number.isInteger(indexCount) || indexCount < 3 || indexCount % 3 !== 0
      || indexStart + indexCount > indices.length) throw new Error(`M2 submesh ${submeshIndex} range is invalid`);
    finiteVector(source.centre, 3, `M2 submesh ${submeshIndex} centre`);
    if (typeof source.sortRadius !== "number" || !Number.isFinite(source.sortRadius) || source.sortRadius < 0) {
      throw new Error(`M2 submesh ${submeshIndex} radius is invalid`);
    }
    const edges = new Map();
    for (let at = indexStart; at < indexStart + indexCount; at += 3) {
      const a = indices[at];
      const b = indices[at + 1];
      const c = indices[at + 2];
      if (a < vertexStart || a >= vertexStart + vertexCountInSubmesh
        || b < vertexStart || b >= vertexStart + vertexCountInSubmesh
        || c < vertexStart || c >= vertexStart + vertexCountInSubmesh) {
        throw new Error(`M2 submesh ${submeshIndex} index escapes its vertex range`);
      }
      const ax = positions[a * 3];
      const ay = positions[a * 3 + 1];
      const az = positions[a * 3 + 2];
      const bx = positions[b * 3];
      const by = positions[b * 3 + 1];
      const bz = positions[b * 3 + 2];
      const cx = positions[c * 3];
      const cy = positions[c * 3 + 1];
      const cz = positions[c * 3 + 2];
      const crossX = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const crossY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const crossZ = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (!(crossX * crossX + crossY * crossY + crossZ * crossZ > 1e-12)) {
        throw new Error(`M2 submesh ${submeshIndex} has a degenerate triangle`);
      }
      for (const [from, to] of [[a, b], [b, c], [c, a]]) {
        const edge = from < to ? `${from}/${to}` : `${to}/${from}`;
        const count = (edges.get(edge) ?? 0) + 1;
        if (count > 2) throw new Error(`M2 submesh ${submeshIndex} is non-manifold`);
        edges.set(edge, count);
      }
    }
    return { source, vertexStart, vertexCount: vertexCountInSubmesh, indexStart, indexCount };
  });
  const orderedRanges = submeshes
    .map((submesh, index) => ({ index, start: submesh.indexStart, end: submesh.indexStart + submesh.indexCount }))
    .sort((left, right) => left.start - right.start || left.index - right.index);
  for (let index = 1; index < orderedRanges.length; index++) {
    if (orderedRanges[index].start < orderedRanges[index - 1].end) throw new Error("M2 submesh index ranges overlap");
  }
  validateBoundsContainment(bounds, positions, indices, submeshes);

  for (const [batchIndex, batch] of model.batches.entries()) {
    if (!batch || typeof batch !== "object" || !Number.isInteger(batch.submesh)
      || batch.submesh < 0 || batch.submesh >= submeshes.length || batch.blendMode !== 0
      || !Number.isInteger(batch.priorityPlane) || batch.priorityPlane < -128 || batch.priorityPlane > 127
      || !Number.isInteger(batch.materialLayer) || batch.materialLayer < 0 || batch.materialLayer > 255
      || !Number.isInteger(batch.shaderId) || batch.shaderId < 0 || batch.shaderId > 65_535
      || !Number.isInteger(batch.flags) || batch.flags < 0 || batch.flags > 255
      || !Number.isInteger(batch.materialFlags) || batch.materialFlags < 0 || batch.materialFlags > 255
      || !Array.isArray(batch.textures) || batch.textures.length > 2
      || !Array.isArray(batch.uvSets) || batch.uvSets.length !== batch.textures.length
      || !Number.isInteger(batch.colorIndex) || batch.colorIndex < 0 || batch.colorIndex > 65_535
      || batch.colorIndex !== 0xffff
      || !Number.isInteger(batch.textureWeight) || batch.textureWeight < -1 || batch.textureWeight > 32_767
      || batch.textureWeight !== -1
      || !Number.isInteger(batch.textureTransform) || batch.textureTransform < -1 || batch.textureTransform > 32_767) {
      throw new Error(`M2 batch ${batchIndex} metadata is invalid`);
    }
    if (batch.textureTransform !== -1) throw new Error(`M2 batch ${batchIndex} has a texture transform track`);
    for (let unit = 0; unit < batch.textures.length; unit++) {
      const texture = batch.textures[unit];
      if (!Number.isInteger(texture) || texture < -1 || texture >= model.textures.length
        || (batch.uvSets[unit] !== 0 && batch.uvSets[unit] !== 1)) {
        throw new Error(`M2 batch ${batchIndex} texture metadata is invalid`);
      }
    }
  }
  const sourceTriangles = submeshes.reduce((sum, submesh) => sum + submesh.indexCount / 3, 0);
  const sourceDrawTriangles = model.batches.reduce(
    (sum, batch) => sum + submeshes[batch.submesh].indexCount / 3, 0,
  );
  return {
    modelPath,
    modelSha1: options.modelSha1,
    sourceStamp: cloneStamp(options.sourceStamp),
    stampKey,
    algorithmVersion: options.algorithmVersion,
    targetTriangles: options.targetTriangles,
    version,
    model,
    positions,
    normals,
    uv0,
    uv1,
    boneIndices,
    boneWeights,
    indices,
    bounds,
    submeshes,
    batches: model.batches,
    sourceTriangles,
    sourceDrawTriangles,
  };
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
    const candidate = targets
      .filter((entry) => entry.target < entry.sourceTriangles)
      .sort((left, right) => (right.ideal - right.target) - (left.ideal - left.target) || left.index - right.index)[0];
    if (!candidate) return undefined;
    candidate.target++;
    assigned++;
  }
  while (assigned > totalTarget) {
    const candidate = targets
      .filter((entry) => entry.target > 1)
      .sort((left, right) => (right.target - right.ideal) - (left.target - left.ideal) || left.index - right.index)[0];
    if (!candidate) return undefined;
    candidate.target--;
    assigned--;
  }
  targets.sort((left, right) => left.index - right.index);
  return targets.map((entry) => entry.target);
}

function simplifySubmesh(model, submesh, targetTriangles) {
  const localPositions = model.positions.slice(submesh.vertexStart * 3,
    (submesh.vertexStart + submesh.vertexCount) * 3);
  const localNormals = model.normals.slice(submesh.vertexStart * 3,
    (submesh.vertexStart + submesh.vertexCount) * 3);
  const localUv0 = model.uv0.slice(submesh.vertexStart * 2,
    (submesh.vertexStart + submesh.vertexCount) * 2);
  const localUv1 = model.uv1.slice(submesh.vertexStart * 2,
    (submesh.vertexStart + submesh.vertexCount) * 2);
  const localIndices = new Uint32Array(submesh.indexCount);
  const attributes = new Float32Array(submesh.vertexCount * 7);
  for (let vertex = 0; vertex < submesh.vertexCount; vertex++) {
    attributes[vertex * 7] = localNormals[vertex * 3];
    attributes[vertex * 7 + 1] = localNormals[vertex * 3 + 1];
    attributes[vertex * 7 + 2] = localNormals[vertex * 3 + 2];
    attributes[vertex * 7 + 3] = localUv0[vertex * 2];
    attributes[vertex * 7 + 4] = localUv0[vertex * 2 + 1];
    attributes[vertex * 7 + 5] = localUv1[vertex * 2];
    attributes[vertex * 7 + 6] = localUv1[vertex * 2 + 1];
  }
  for (let index = 0; index < submesh.indexCount; index++) {
    localIndices[index] = model.indices[submesh.indexStart + index] - submesh.vertexStart;
  }
  const targetIndexCount = targetTriangles * 3;
  const [rawResult, error] = MeshoptSimplifier.simplifyWithAttributes(
    localIndices,
    localPositions,
    3,
    attributes,
    7,
    STATIC_LOD_ATTRIBUTE_WEIGHTS,
    null,
    targetIndexCount,
    STATIC_LOD_TARGET_ERROR,
    ["LockBorder"],
  );
  if (!Number.isFinite(error)) throw new Error("meshoptimizer returned an invalid error");
  const result = new Uint32Array(rawResult);
  if (result.length < 3 || result.length % 3 !== 0 || result.length > targetIndexCount) {
    throw new Error("meshoptimizer did not reach the requested target");
  }
  const global = new Uint32Array(result.length);
  for (let index = 0; index < result.length; index++) {
    const local = result[index];
    if (local >= submesh.vertexCount) throw new Error("meshoptimizer returned an invalid index");
    global[index] = local + submesh.vertexStart;
  }
  return global;
}

function validateOutputTopology(indices, positions, submeshes) {
  for (let submeshIndex = 0; submeshIndex < submeshes.length; submeshIndex++) {
    const submesh = submeshes[submeshIndex];
    if (submesh.indexCount < 3 || submesh.indexCount % 3 !== 0
      || submesh.indexStart < 0 || submesh.indexStart + submesh.indexCount > indices.length) {
      throw new Error(`simplified submesh ${submeshIndex} range is invalid`);
    }
    const edges = new Map();
    for (let at = submesh.indexStart; at < submesh.indexStart + submesh.indexCount; at += 3) {
      const a = indices[at];
      const b = indices[at + 1];
      const c = indices[at + 2];
      if (a < submesh.vertexStart || a >= submesh.vertexStart + submesh.vertexCount
        || b < submesh.vertexStart || b >= submesh.vertexStart + submesh.vertexCount
        || c < submesh.vertexStart || c >= submesh.vertexStart + submesh.vertexCount
        || a === b || b === c || a === c) throw new Error("simplified topology is invalid");
      const ax = positions[a * 3];
      const ay = positions[a * 3 + 1];
      const az = positions[a * 3 + 2];
      const bx = positions[b * 3];
      const by = positions[b * 3 + 1];
      const bz = positions[b * 3 + 2];
      const cx = positions[c * 3];
      const cy = positions[c * 3 + 1];
      const cz = positions[c * 3 + 2];
      const crossX = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const crossY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const crossZ = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (!(crossX * crossX + crossY * crossY + crossZ * crossZ > 1e-12)) {
        throw new Error("simplified topology contains a zero-area triangle");
      }
      for (const [from, to] of [[a, b], [b, c], [c, a]]) {
        const edge = from < to ? `${from}/${to}` : `${to}/${from}`;
        const count = (edges.get(edge) ?? 0) + 1;
        if (count > 2) throw new Error("simplified topology is non-manifold");
        edges.set(edge, count);
      }
    }
  }
}

/**
 * Produce a deterministic, offline static M2 geometry variant.
 *
 * This function intentionally accepts an already parsed model and never performs resource lookup.
 * The returned WVM9 artifact is fail-closed: unsafe metadata, dynamic features, malformed
 * topology, or a target that LockBorder cannot reach yields `undefined`.
 */
export async function simplifyStaticM2(options = {}) {
  try {
    const input = validateStaticModel(options);
    if (!input) return undefined;
    const targets = distributeTargets(input.submeshes, input.targetTriangles);
    if (!targets || input.targetTriangles >= input.sourceTriangles) return undefined;
    if (MeshoptSimplifier.supported === false) return undefined;
    await MeshoptSimplifier.ready;

    const simplifiedRanges = input.submeshes.map((submesh, index) =>
      simplifySubmesh(input.model, submesh, targets[index]));
    const totalIndices = simplifiedRanges.reduce((sum, range) => sum + range.length, 0);
    if (totalIndices >= input.sourceTriangles * 3 || totalIndices / 3 > input.targetTriangles) return undefined;
    const outputIndices32 = new Uint32Array(totalIndices);
    const outputSubmeshes = [];
    let offset = 0;
    for (let index = 0; index < input.submeshes.length; index++) {
      const source = input.submeshes[index].source;
      const range = simplifiedRanges[index];
      outputIndices32.set(range, offset);
      outputSubmeshes.push({
        ...cloneMetadata(source),
        indexStart: offset,
        indexCount: range.length,
      });
      offset += range.length;
    }
    validateOutputTopology(outputIndices32, input.positions, outputSubmeshes);
    const outputIndices = input.positions.length / 3 <= 65_535
      ? new Uint16Array(outputIndices32)
      : outputIndices32;
    const outputModel = {
      version: input.version,
      positions: new Float32Array(input.positions),
      normals: new Float32Array(input.normals),
      uv0: new Float32Array(input.uv0),
      uv1: new Float32Array(input.uv1),
      boneIndices: cloneTypedArray(input.boneIndices),
      boneWeights: cloneTypedArray(input.boneWeights),
      indices: outputIndices,
      submeshes: outputSubmeshes,
      batches: input.batches.map(cloneMetadata),
      textures: input.model.textures.map(cloneMetadata),
      bounds: cloneMetadata(input.bounds),
      unsupported: cloneMetadata(input.model.unsupported),
      // Dynamic tracks are an eligibility failure above; explicit empty arrays make the output
      // model independent of arbitrary enumerable properties on the caller's parsed object.
      colours: [],
      textureWeights: [],
      textureTransforms: [],
    };
    const bytes = encodeWvm9(outputModel, undefined);
    const identity = canonicalJson({
      algorithmVersion: input.algorithmVersion,
      modelPath: input.modelPath,
      modelSha1: input.modelSha1,
      sourceStamp: input.stampKey,
      targetTriangles: input.targetTriangles,
      targetError: STATIC_LOD_TARGET_ERROR,
      attributeWeights: STATIC_LOD_ATTRIBUTE_WEIGHTS,
      flags: ["LockBorder"],
      eligibility: {
        kind: "m2",
        staticModel: true,
        exterior: true,
        interior: options.interior === true,
        skinned: false,
        animated: false,
        particleEmitters: false,
        ribbonEmitters: false,
        composite: false,
        legacy: false,
      },
    });
    const profileId = `r4b-${createHash("sha1").update(identity).digest("hex")}`;
    const profile = {
      profileId,
      modelPath: input.modelPath,
      modelSha1: input.modelSha1,
      sourceStamp: input.sourceStamp,
      algorithmVersion: input.algorithmVersion,
      targetTriangles: input.targetTriangles,
      sourceTriangleCount: input.sourceTriangles,
      uniqueSourceTriangleCount: input.sourceTriangles,
      sourceDrawTriangleCount: input.sourceDrawTriangles,
      triangleCount: outputIndices.length / 3,
      drawTriangleCount: outputModel.batches.reduce(
        (sum, batch) => sum + outputModel.submeshes[batch.submesh].indexCount / 3, 0,
      ),
      version: outputModel.version,
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
      bytes,
    };
    freezeMetadata(profile.sourceStamp);
    freezeMetadata(profile.submeshes);
    freezeMetadata(profile.batches);
    freezeMetadata(profile.textures);
    freezeMetadata(profile.bounds);
    freezeMetadata(profile.unsupported);
    freezeMetadata(profile.colours);
    freezeMetadata(profile.textureWeights);
    freezeMetadata(profile.textureTransforms);
    return Object.freeze(profile);
  } catch {
    return undefined;
  }
}
