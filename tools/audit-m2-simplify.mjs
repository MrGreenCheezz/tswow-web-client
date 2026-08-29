// Read-only corpus audit for a future static-M2 simplifier.
//
// This file deliberately has no renderer or browser imports.  The only optional comparison
// implementation is an injected pure `simplify` function (or the offline m2-lod adapter loaded
// lazily by defaultSimplify).  Archive chains are borrowed and never closed here.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";
import {
  m2Animations,
  parseM2,
  parseM2Skeleton,
} from "./m2.mjs";
import { sourceStamp as collectSourceStamp } from "./source-stamp.mjs";

const SKIN_HEADER_SIZE = 48;
const SKIN_LOOKUP = 0x04;
const SKIN_TRIANGLES = 0x0c;
const SKIN_SUBMESHES = 0x1c;
const SKIN_BATCHES = 0x24;
const SKIN_SUBMESH_SIZE = 48;
const SKIN_BATCH_SIZE = 24;
const MODEL_VERTEX_HEADER = 0x3c;
const MODEL_BONES = 0x2c;
const MODEL_SEQUENCES = 0x1c;
const MAX_LOOKUP = 1_000_000;
const MAX_TRIANGLES = 6_000_000;
const MAX_TABLE_ENTRIES = 1_000_000;
const STATIC_VERTEX_BYTES = 40;

const FAIL_ORDER = [
  "missing00Skin",
  "badM2",
  "badSkin",
  "zeroGeometry",
  "skinnedGeometry",
  "placementUnknown",
  "placementInterior",
  "placementKindUnknown",
  "placementDynamic",
  "unsupportedWmo",
  "particleEmitters",
  "ribbonEmitters",
  "globalSequences",
  "events",
  "externalAnimation",
  "missingAnimationData",
  "animationUnknown",
  "varyingBoneChannels",
  "gameObjectAnimation",
  "attachments",
  "materialUnsupported",
  "countOverflow",
  "sourceChanged",
  "simplifierUnavailable",
  "simplifierError",
  "batchOrderChanged",
  "materialBoundaryChanged",
  "boundsChanged",
  "invalidSimplifiedGeometry",
  "simplifierNoReduction",
];
const FAIL_RANK = new Map(FAIL_ORDER.map((reason, index) => [reason, index]));

function canonicalPath(value) {
  if (typeof value !== "string") return undefined;
  const path = value.replaceAll("/", "\\").replace(/^\\+/, "").toLowerCase();
  return path.length > 0 ? path : undefined;
}

function canonicalPrefix(value) {
  const path = canonicalPath(value ?? "World\\");
  if (!path) return "";
  return path.endsWith("\\") ? path : `${path}\\`;
}

function canonicalCandidatePaths(value) {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) || value instanceof Set ? [...value] : [value];
  return [...new Set(values.map(canonicalPath).filter(Boolean))].sort();
}

function listingPrefix(value) {
  const path = String(value ?? "World\\").replaceAll("/", "\\").replace(/^\\+/, "");
  return path.length === 0 || path.endsWith("\\") ? path : `${path}\\`;
}

function profilePath(modelPath) {
  return `${modelPath.slice(0, -3)}00.skin`;
}

function archiveKey(path) {
  return canonicalPath(path) ?? "";
}

function serialiseError(error) {
  return error instanceof Error ? error.message : String(error);
}

function failReasons(reasons) {
  return [...new Set(reasons)].sort((left, right) => {
    const rank = (FAIL_RANK.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (FAIL_RANK.get(right) ?? Number.MAX_SAFE_INTEGER);
    return rank || left.localeCompare(right);
  });
}

function sha1(value) {
  return createHash("sha1").update(value).digest("hex");
}

function stableJson(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (ArrayBuffer.isView(value)) return JSON.stringify([...value]);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function digest(value) {
  return sha1(stableJson(value));
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function readU32(buffer, offset, label) {
  if (!Buffer.isBuffer(buffer) || offset < 0 || offset + 4 > buffer.length) {
    throw new Error(`${label} is outside the file`);
  }
  return buffer.readUInt32LE(offset);
}

function checkedArray(buffer, offset, stride, maximum, label, minimum = SKIN_HEADER_SIZE) {
  const count = readU32(buffer, offset, `${label} count`);
  const at = readU32(buffer, offset + 4, `${label} offset`);
  if (count > maximum || at < minimum || at + count * stride > buffer.length) {
    throw new Error(`${label} table is invalid`);
  }
  return { count, offset: at };
}

function validateSkinStructure(skin) {
  if (!Buffer.isBuffer(skin) || skin.length < SKIN_HEADER_SIZE
    || skin.subarray(0, 4).toString("ascii") !== "SKIN") {
    throw new Error("M2 profile is not a SKIN file");
  }
  const lookup = checkedArray(skin, SKIN_LOOKUP, 2, MAX_LOOKUP, "SKIN lookup");
  const triangles = checkedArray(skin, SKIN_TRIANGLES, 2, MAX_TRIANGLES, "SKIN triangle");
  if (triangles.count % 3 !== 0) throw new Error("SKIN triangle table is not a triangle list");
  const submeshes = checkedArray(skin, SKIN_SUBMESHES, SKIN_SUBMESH_SIZE,
    MAX_TABLE_ENTRIES, "SKIN submesh");
  const batches = checkedArray(skin, SKIN_BATCHES, SKIN_BATCH_SIZE,
    MAX_TABLE_ENTRIES, "SKIN batch");
  if (submeshes.count === 0 || batches.count === 0) {
    throw new Error("SKIN profile has no drawable submesh batches");
  }
  const submeshRanges = [];
  for (let index = 0; index < submeshes.count; index++) {
    const at = submeshes.offset + index * SKIN_SUBMESH_SIZE;
    const level = skin.readUInt16LE(at + 2);
    const vertexStart = skin.readUInt16LE(at + 4) + level * 0x10000;
    const vertexCount = skin.readUInt16LE(at + 6);
    const indexStart = skin.readUInt16LE(at + 8) + level * 0x10000;
    const indexCount = skin.readUInt16LE(at + 10);
    if (indexCount % 3 !== 0 || vertexStart + vertexCount > lookup.count
      || indexStart + indexCount > triangles.count) {
      throw new Error("SKIN submesh range is outside profile tables");
    }
    submeshRanges.push({ vertexStart, vertexCount, indexStart, indexCount });
  }
  const batchSubmeshes = [];
  for (let index = 0; index < batches.count; index++) {
    const at = batches.offset + index * SKIN_BATCH_SIZE;
    const submesh = skin.readUInt16LE(at + 4);
    if (submesh >= submeshRanges.length) throw new Error("SKIN batch references invalid submesh");
    batchSubmeshes.push(submesh);
  }
  return { lookup, triangles, submeshRanges, batchSubmeshes };
}

function modelHeaderCount(model, offset, label) {
  return readU32(model, offset, label);
}

function normalisePlacementMap(placements) {
  if (!placements) return undefined;
  const map = new Map();
  const add = (value, fallbackPath) => {
    if (!value || typeof value !== "object") return;
    const modelPath = canonicalPath(value.modelPath ?? value.path ?? fallbackPath);
    if (!modelPath) return;
    const current = map.get(modelPath) ?? [];
    current.push(value);
    map.set(modelPath, current);
  };
  if (placements && !Array.isArray(placements) && !(placements instanceof Map)
    && Array.isArray(placements.models)) {
    placements = placements.models;
  }
  if (placements instanceof Map) {
    for (const [path, value] of placements) {
      if (Array.isArray(value)) value.forEach((entry) => add(entry, path));
      else add(value, path);
    }
  } else if (Array.isArray(placements)) {
    placements.forEach((entry) => add(entry));
  } else if (typeof placements === "object") {
    for (const [path, value] of Object.entries(placements)) {
      if (Array.isArray(value)) value.forEach((entry) => add(entry, path));
      else add(value, path);
    }
  }
  return map;
}

function placementStatus(path, placementMap) {
  if (!placementMap) {
    return { known: false, reasons: ["placementUnknown"] };
  }
  const entries = placementMap.get(path);
  if (!entries || entries.length === 0) {
    return { known: false, reasons: ["placementUnknown"] };
  }
  const reasons = [];
  for (const entry of entries) {
    const kind = String(entry.kind ?? entry.type ?? "").toLowerCase();
    if (kind !== "m2" && kind !== "model") reasons.push(kind === "wmo" ? "unsupportedWmo" : "placementKindUnknown");
    const exterior = entry.exterior === true;
    if (!exterior) reasons.push("placementUnknown");
    if (entry.interior === true || (entry.interior === undefined && !exterior)) reasons.push("placementInterior");
    const staticEvidence = entry.staticModel === true || entry.static === true;
    const dynamicEvidence = entry.staticModel === false || entry.static === false || entry.dynamic === true;
    if (!staticEvidence && !dynamicEvidence) reasons.push("placementUnknown");
    if (dynamicEvidence) {
      reasons.push("placementDynamic");
    }
  }
  return { known: reasons.length === 0, reasons };
}

function referencedBounds(positions, referencedIndices) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let radius = 0;
  for (const index of referencedIndices) {
    const at = index * 3;
    if (at + 2 >= positions.length) throw new Error("geometry references an invalid position");
    const point = [positions[at], positions[at + 1], positions[at + 2]];
    if (!point.every(finiteNumber)) throw new Error("geometry contains non-finite positions");
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
    radius = Math.max(radius, Math.hypot(...point));
  }
  if (referencedIndices.size === 0) return undefined;
  return { min, max, radius };
}

function arrayIndexValue(indices, index) {
  const value = indices[index];
  if (!Number.isInteger(value) || value < 0) throw new Error("geometry contains an invalid index");
  return value;
}

function metricsForParsed(parsed, skin, label, validatedSkin, artifactBytes) {
  if (!parsed || typeof parsed !== "object" || !parsed.positions || !parsed.indices
    || !Array.isArray(parsed.submeshes) || !Array.isArray(parsed.batches)) {
    throw new Error(`${label} has no parseable geometry`);
  }
  const positions = parsed.positions;
  const indices = parsed.indices;
  if (!ArrayBuffer.isView(positions) || positions.length % 3 !== 0 || !ArrayBuffer.isView(indices)) {
    throw new Error(`${label} has invalid geometry arrays`);
  }
  const skinInfo = validatedSkin ?? (skin ? validateSkinStructure(skin) : undefined);
  const submeshes = parsed.submeshes;
  const batches = parsed.batches;
  if (skinInfo && batches.length !== skinInfo.batchSubmeshes.length) {
    throw new Error(`${label} batch count differs from SKIN`);
  }
  const getSubmesh = (batch, batchIndex) => {
    const submeshIndex = Number.isInteger(batch.submesh)
      ? batch.submesh : skinInfo?.batchSubmeshes[batchIndex];
    if (!Number.isInteger(submeshIndex) || !submeshes[submeshIndex]) {
      throw new Error(`${label} batch references an invalid submesh`);
    }
    return { index: submeshIndex, value: submeshes[submeshIndex] };
  };
  const uniqueSubmeshes = new Set();
  const uniqueLocalVertices = new Set();
  const uniqueGlobalVertices = new Set();
  let drawnIndexCount = 0;
  const batchDescriptors = [];
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const selected = getSubmesh(batch, batchIndex);
    const submesh = selected.value;
    const indexStart = Number.isInteger(submesh.indexStart) ? submesh.indexStart : 0;
    const indexCount = Number.isInteger(submesh.indexCount) ? submesh.indexCount : 0;
    if (indexCount <= 0 || indexCount % 3 !== 0 || indexStart < 0
      || indexStart + indexCount > indices.length) {
      throw new Error(`${label} batch submesh range is invalid`);
    }
    drawnIndexCount += indexCount;
    uniqueSubmeshes.add(selected.index);
    const descriptor = {
      ordinal: batchIndex,
      submesh: selected.index,
      priorityPlane: batch.priorityPlane ?? 0,
      materialLayer: batch.materialLayer ?? 0,
      shaderId: batch.shaderId ?? 0,
      flags: batch.flags ?? 0,
      blendMode: batch.blendMode ?? 0,
      materialFlags: batch.materialFlags ?? 0,
      textures: batch.textures ?? [],
      uvSets: batch.uvSets ?? [],
      colorIndex: batch.colorIndex ?? 0,
      textureWeight: batch.textureWeight ?? null,
      textureTransform: batch.textureTransform ?? null,
    };
    batchDescriptors.push(descriptor);
    for (let offset = 0; offset < indexCount; offset++) {
      const local = arrayIndexValue(indices, indexStart + offset);
      if (local >= positions.length / 3) throw new Error(`${label} index is outside positions`);
      uniqueLocalVertices.add(local);
      if (skinInfo && local >= skinInfo.lookup.count) {
        throw new Error(`${label} index is outside SKIN lookup`);
      }
    }
  }
  // The `lookup` marker above only keeps this loop independent of the source skin.  Resolve the
  // actual parent-global IDs in a second pass; for parsed output without a skin, local IDs are the
  // only honest identity available.
  uniqueGlobalVertices.clear();
  const lookupValues = skinInfo ? new Uint32Array(skinInfo.lookup.count) : undefined;
  if (skinInfo) {
    for (let index = 0; index < skinInfo.lookup.count; index++) {
      lookupValues[index] = skin.readUInt16LE(skinInfo.lookup.offset + index * 2);
    }
  }
  const uniqueIndexRanges = new Set();
  let uniqueDrawIndexCount = 0;
  for (const submeshIndex of uniqueSubmeshes) {
    const submesh = submeshes[submeshIndex];
    const indexStart = Number.isInteger(submesh.indexStart) ? submesh.indexStart : 0;
    const indexCount = Number.isInteger(submesh.indexCount) ? submesh.indexCount : 0;
    uniqueDrawIndexCount += indexCount;
    uniqueIndexRanges.add(`${indexStart}:${indexCount}`);
    for (let offset = 0; offset < indexCount; offset++) {
      const local = arrayIndexValue(indices, indexStart + offset);
      if (lookupValues && local >= lookupValues.length) {
        throw new Error(`${label} index is outside SKIN lookup`);
      }
      uniqueGlobalVertices.add(lookupValues ? lookupValues[local] : local);
    }
  }
  const bounds = referencedBounds(positions, uniqueLocalVertices);
  if (!bounds || drawnIndexCount === 0) throw new Error(`${label} has no drawable geometry`);
  const indexBytes = indices instanceof Uint32Array ? 4 : 2;
  const vertexAttributeBytes = positions.length / 3 * STATIC_VERTEX_BYTES;
  const geometryPayloadBytes = vertexAttributeBytes + indices.byteLength;
  const uploadedBytes = Number.isInteger(artifactBytes?.byteLength)
    ? artifactBytes.byteLength : geometryPayloadBytes;
  const uniqueGeometryBytes = uniqueGlobalVertices.size * STATIC_VERTEX_BYTES
    + uniqueDrawIndexCount * indexBytes;
  const batchDigest = digest(batchDescriptors);
  const materialDigest = digest(batchDescriptors.map((batch) => ({
    blendMode: batch.blendMode,
    materialFlags: batch.materialFlags,
    textures: batch.textures,
    uvSets: batch.uvSets,
    colorIndex: batch.colorIndex,
    textureWeight: batch.textureWeight,
    textureTransform: batch.textureTransform,
  })));
  const orderDigest = digest(batchDescriptors.map((batch) => ({
    ordinal: batch.ordinal,
    submesh: batch.submesh,
    priorityPlane: batch.priorityPlane,
    materialLayer: batch.materialLayer,
    shaderId: batch.shaderId,
  })));
  return {
    vertexCount: positions.length / 3,
    indexCount: indices.length,
    drawnIndexCount,
    drawnTriangles: drawnIndexCount / 3,
    drawCalls: batches.length,
    uniqueSubmeshCount: uniqueSubmeshes.size,
    uniqueDrawIndexCount,
    uniqueDrawnTriangles: uniqueDrawIndexCount / 3,
    uniqueReferencedVertexCount: uniqueGlobalVertices.size,
    referencedVertexCount: uniqueGlobalVertices.size,
    indexType: indexBytes === 4 ? "uint32" : "uint16",
    indexBytes,
    drawnIndexBytes: drawnIndexCount * indexBytes,
    vertexAttributeBytes,
    uniqueGeometryBytes,
    geometryPayloadBytes,
    uploadedWvmBytes: uploadedBytes,
    wvmBytes: uploadedBytes,
    bounds,
    batchDescriptors,
    batchDigest,
    materialDigest,
    orderDigest,
    // The raw parsed index list can include unreferenced/gap triangles. Keep that diagnostic
    // explicit; sourceTriangleCount is the unique source geometry actually represented by ranges.
    sourceTriangleCount: uniqueDrawIndexCount / 3,
    rawSourceTriangleCount: indices.length / 3,
    uniqueIndexRangeCount: uniqueIndexRanges.size,
  };
}

function syntheticMetrics(profile, label) {
  if (!profile || typeof profile !== "object" || !Array.isArray(profile.batches)) {
    throw new Error(`${label} has no batch summary`);
  }
  let batchDrawnTriangles = 0;
  const uniqueGeometry = new Map();
  for (const [ordinal, batch] of profile.batches.entries()) {
    if (!batch || typeof batch !== "object" || !finiteNumber(batch.triangles)
      || batch.triangles < 0 || !Number.isInteger(batch.triangles)) {
      throw new Error(`${label} batch ${ordinal} has invalid triangle count`);
    }
    batchDrawnTriangles += batch.triangles;
    const geometryId = String(batch.geometryId ?? `ordinal:${ordinal}`);
    if (!uniqueGeometry.has(geometryId)) uniqueGeometry.set(geometryId, batch.triangles);
  }
  const bytes = profile.bytes;
  const wvmBytes = bytes?.byteLength ?? bytes?.length;
  if (!Number.isInteger(wvmBytes) || wvmBytes < 0) throw new Error(`${label} has invalid WVM bytes`);
  return {
    batchDrawnTriangles,
    uniqueGeometryTriangles: [...uniqueGeometry.values()].reduce((sum, value) => sum + value, 0),
    wvmBytes,
  };
}

function syntheticCompare(full, low) {
  if (!low) return undefined;
  const fullBatches = Array.isArray(full.batches) ? full.batches : [];
  const lowBatches = Array.isArray(low.batches) ? low.batches : [];
  const batchMaterialOrderPreserved = fullBatches.length === lowBatches.length
    && fullBatches.every((batch, index) => {
      const candidate = lowBatches[index];
      return candidate && candidate.geometryId === batch.geometryId
        && candidate.material === batch.material && candidate.order === batch.order;
    });
  const boundsPreserved = stableJson(full.bounds) === stableJson(low.bounds);
  const fullMetrics = syntheticMetrics(full, "full");
  const lowMetrics = syntheticMetrics(low, "low");
  return {
    batchMaterialOrderPreserved,
    boundsPreserved,
    batchDrawnTriangleDelta: fullMetrics.batchDrawnTriangles - lowMetrics.batchDrawnTriangles,
    uniqueGeometryTriangleDelta: fullMetrics.uniqueGeometryTriangles - lowMetrics.uniqueGeometryTriangles,
    wvmByteDelta: fullMetrics.wvmBytes - lowMetrics.wvmBytes,
  };
}

function syntheticEntryFromSummary({ modelPath, skinPath, canonicalModelPath, placement,
  sourceStampValue, summary, simplify, model, profilePaths }) {
  return (async () => {
    const entry = {
      modelPath,
      skinPath,
      eligibility: "excluded",
      failReasons: [...placement.reasons],
      placement,
      sourceStamp: sourceStampValue,
      synthetic: true,
    };
    if (summary?.status === "invalid") {
      entry.diagnosticFailReasons = Array.isArray(summary.failReasons) ? [...summary.failReasons] : [];
      entry.failReasons.push(...entry.diagnosticFailReasons);
      entry.failReasons = failReasons(entry.failReasons);
      return entry;
    }
    entry.failReasons = failReasons(entry.failReasons);
    entry.eligibility = entry.failReasons.length === 0 ? "eligible" : "excluded";
    if (entry.eligibility !== "eligible") return entry;
    const input = Object.freeze({
      modelPath,
      model,
      profilePaths,
      sourceStamp: sourceStampValue,
    });
    let result = summary;
    if (typeof simplify === "function") result = await simplify(input);
    const full = result?.full;
    if (!full) {
      entry.failReasons.push("simplifierUnavailable");
      entry.failReasons = failReasons(entry.failReasons);
      return entry;
    }
    try {
      entry.metrics = { full: syntheticMetrics(full, "full") };
      if (result.low) entry.metrics.low = syntheticMetrics(result.low, "low");
      entry.compare = syntheticCompare(full, result.low);
      if (!entry.compare) entry.failReasons.push("simplifierUnavailable");
      else {
        if (!entry.compare.batchMaterialOrderPreserved) entry.failReasons.push("batchOrderChanged");
        if (!entry.compare.boundsPreserved) entry.failReasons.push("boundsChanged");
        if (entry.compare.batchDrawnTriangleDelta <= 0 && entry.compare.wvmByteDelta <= 0) {
          entry.failReasons.push("simplifierNoReduction");
        }
      }
    } catch (error) {
      entry.failReasons.push("simplifierError");
      entry.error = serialiseError(error);
    }
    entry.failReasons = failReasons(entry.failReasons);
    return entry;
  })();
}

function compareBounds(source, simplified, epsilon = 1e-5) {
  if (!source || !simplified) return false;
  for (let axis = 0; axis < 3; axis++) {
    if (simplified.min[axis] > source.min[axis] + epsilon
      || simplified.max[axis] < source.max[axis] - epsilon) return false;
  }
  return simplified.radius + epsilon >= source.radius;
}

function compareMetrics(baseline, simplified) {
  const failures = [];
  if (baseline.batchDigest !== simplified.batchDigest) failures.push("batchOrderChanged");
  if (baseline.materialDigest !== simplified.materialDigest) failures.push("materialBoundaryChanged");
  if (baseline.orderDigest !== simplified.orderDigest) failures.push("batchOrderChanged");
  if (!compareBounds(baseline.bounds, simplified.bounds)) failures.push("boundsChanged");
  const delta = (key) => simplified[key] - baseline[key];
  return {
    drawnTriangles: { baseline: baseline.drawnTriangles, simplified: simplified.drawnTriangles,
      saved: baseline.drawnTriangles - simplified.drawnTriangles,
      percent: baseline.drawnTriangles > 0 ? (baseline.drawnTriangles - simplified.drawnTriangles)
        * 100 / baseline.drawnTriangles : 0 },
    uniqueReferencedVertices: { baseline: baseline.uniqueReferencedVertexCount,
      simplified: simplified.uniqueReferencedVertexCount,
      saved: baseline.uniqueReferencedVertexCount - simplified.uniqueReferencedVertexCount,
      percent: baseline.uniqueReferencedVertexCount > 0
        ? (baseline.uniqueReferencedVertexCount - simplified.uniqueReferencedVertexCount) * 100
          / baseline.uniqueReferencedVertexCount : 0 },
    drawnIndexBytes: { baseline: baseline.drawnIndexBytes, simplified: simplified.drawnIndexBytes,
      saved: baseline.drawnIndexBytes - simplified.drawnIndexBytes,
      percent: baseline.drawnIndexBytes > 0 ? (baseline.drawnIndexBytes - simplified.drawnIndexBytes)
        * 100 / baseline.drawnIndexBytes : 0 },
    uniqueGeometryBytes: { baseline: baseline.uniqueGeometryBytes,
      simplified: simplified.uniqueGeometryBytes,
      saved: baseline.uniqueGeometryBytes - simplified.uniqueGeometryBytes,
      percent: baseline.uniqueGeometryBytes > 0
        ? (baseline.uniqueGeometryBytes - simplified.uniqueGeometryBytes) * 100
          / baseline.uniqueGeometryBytes : 0 },
    uploadedWvmBytes: { baseline: baseline.uploadedWvmBytes, simplified: simplified.uploadedWvmBytes,
      saved: baseline.uploadedWvmBytes - simplified.uploadedWvmBytes,
      percent: baseline.uploadedWvmBytes > 0
        ? (baseline.uploadedWvmBytes - simplified.uploadedWvmBytes) * 100
          / baseline.uploadedWvmBytes : 0 },
    drawCalls: { baseline: baseline.drawCalls, simplified: simplified.drawCalls,
      delta: delta("drawCalls") },
    failures: failReasons(failures),
  };
}

function varyingTrack(channel) {
  if (!channel || !channel.values || !ArrayBuffer.isView(channel.values)) return true;
  const components = channel.values.length / Math.max(1, channel.times?.length ?? 1);
  if (!Number.isInteger(components) || components <= 0) return true;
  for (const value of channel.values) if (!finiteNumber(value)) return true;
  for (let key = 1; key < (channel.times?.length ?? 0); key++) {
    for (let component = 0; component < components; component++) {
      if (channel.values[key * components + component] !== channel.values[component]) return true;
    }
  }
  return false;
}

async function resolveExternalAnimations(archives, modelPath, model) {
  const files = new Map();
  const paths = [];
  const missing = [];
  let animations;
  try {
    animations = m2Animations(model);
  } catch (error) {
    return { files, paths, missing, animations: [], error };
  }
  for (const animation of animations) {
    if (animation.external === undefined || files.has(animation.external)) continue;
    const path = `${modelPath.slice(0, -3)}${animation.external}.anim`;
    const data = await archives.read(path);
    if (!data) missing.push(path);
    else {
      files.set(animation.external, data);
      paths.push(path);
    }
  }
  return { files, paths, missing, animations };
}

function animationEligibility(model, external, gameObjectAnimationIds) {
  const reasons = [];
  const bones = modelHeaderCount(model, MODEL_BONES, "M2 bones");
  const sequences = modelHeaderCount(model, MODEL_SEQUENCES, "M2 sequences");
  if (external.error) reasons.push("animationUnknown");
  if (external.missing.length > 0) reasons.push("missingAnimationData");
  if (external.animations.some((entry) => entry.external !== undefined)) reasons.push("externalAnimation");
  if (gameObjectAnimationIds && external.animations.some((entry) => gameObjectAnimationIds.has(entry.animationId))) {
    reasons.push("gameObjectAnimation");
  }
  if (bones === 0 && sequences === 0) return { reasons, bones, sequences, skeleton: undefined };
  if (sequences === 0) return { reasons, bones, sequences, skeleton: undefined, staticPoseWithBones: bones > 0 };
  let skeleton;
  try {
    skeleton = parseM2Skeleton(model, { animations: external.files });
  } catch {
    reasons.push("animationUnknown");
  }
  if (!skeleton) {
    reasons.push("animationUnknown");
  } else {
    if (skeleton.missingAnimations > 0) reasons.push("missingAnimationData");
    if (skeleton.attachments?.length > 0) reasons.push("attachments");
    if (skeleton.clips.some((clip) => clip.channels.some(varyingTrack))) reasons.push("varyingBoneChannels");
  }
  return { reasons, bones, sequences, skeleton };
}

async function defaultSimplify(input) {
  // Kept lazy so source-only tests can run without loading meshoptimizer.  The implementation lives
  // in m2-lod.mjs; this adapter supplies the parsed-model contract and deterministic target that it
  // requires, while retaining the raw buffers for injected adapters.
  try {
    const module = await import("./m2-lod.mjs");
    const simplify = module.simplifyStaticM2;
    if (typeof simplify !== "function") return undefined;
    const model = input.parsed ?? parseM2(input.model, input.skin);
    const sourceTriangles = model.submeshes.reduce((sum, submesh) => sum + submesh.indexCount / 3, 0);
    const targetTriangles = input.targetTriangles ?? Math.max(
      model.submeshes.length, Math.floor(sourceTriangles * 0.7));
    if (targetTriangles >= sourceTriangles) return undefined;
    return simplify({
      model,
      modelPath: input.modelPath,
      modelSha1: sha1(input.model),
      sourceStamp: input.sourceStamp,
      algorithmVersion: "r4.0b-corpus-v1",
      targetTriangles,
      kind: "m2",
      staticModel: true,
      interior: false,
      exterior: true,
      skinned: false,
      animated: false,
      particleEmitters: false,
      ribbonEmitters: false,
      composite: false,
      legacy: false,
    });
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return undefined;
    throw error;
  }
}

async function sourceStampOrFallback(archives, paths) {
  const chain = typeof archives.chainDigest === "function" ? archives.chainDigest() : undefined;
  if (typeof archives.sourceOf !== "function") return { chain, sources: [], files: [] };
  try {
    return await collectSourceStamp(archives, { paths });
  } catch {
    return { chain, sources: [], files: [] };
  }
}

function unwrapSimplified(value) {
  if (!value) return undefined;
  if (value.model && value.skin) return { parsed: parseM2(value.model, value.skin), skin: value.skin, bytes: value.bytes };
  if (value.modelBytes && value.skinBytes) {
    return { parsed: parseM2(value.modelBytes, value.skinBytes), skin: value.skinBytes, bytes: value.bytes };
  }
  if (value.parsed) return { parsed: value.parsed, skin: value.skin, bytes: value.bytes };
  if (value.model?.positions && value.model?.indices && value.model?.submeshes && value.model?.batches) {
    return { parsed: value.model, skin: value.skin, bytes: value.bytes };
  }
  if (value.positions && value.indices && value.submeshes && value.batches) {
    return { parsed: value, skin: value.skin, bytes: value.bytes };
  }
  throw new Error("simplifier returned no model/skin or parseable geometry");
}

function sourceModelInput(model, skin, modelPath, stamp, parsed) {
  return Object.freeze({ model, skin, parsed, modelPath, sourceStamp: stamp });
}

async function inspectEntry(archives, modelPath, placementMap, gameObjectAnimationIds, simplify,
  { readModelPath = modelPath, readSkinPath = profilePath(modelPath), sourceStampValue, profilePaths } = {}) {
  const skinPath = profilePath(modelPath);
  const entry = { modelPath, skinPath, eligibility: "excluded", failReasons: [] };
  const placement = placementStatus(canonicalPath(modelPath), placementMap);
  entry.placement = placement;
  entry.failReasons.push(...placement.reasons);
  const model = await archives.read(readModelPath);
  const skin = await archives.read(readSkinPath);
  if (!skin) entry.failReasons.push("missing00Skin");
  if (!model) entry.failReasons.push("badM2");
  if (!model || !skin) {
    entry.failReasons = failReasons(entry.failReasons);
    return entry;
  }
  if (model && typeof model === "object" && !Buffer.isBuffer(model) && model.summary) {
    return syntheticEntryFromSummary({
      modelPath,
      skinPath,
      canonicalModelPath: canonicalPath(modelPath),
      placement,
      sourceStampValue: sourceStampValue ?? { chain: undefined, sources: [], files: [] },
      summary: model.summary,
      simplify,
      model: model.model ?? model,
      profilePaths,
    });
  }
  const modelHeaderValid = Buffer.isBuffer(model) && model.length >= 4
    && model.subarray(0, 4).toString("ascii") === "MD20";
  const skinHeaderValid = Buffer.isBuffer(skin) && skin.length >= SKIN_HEADER_SIZE
    && skin.subarray(0, 4).toString("ascii") === "SKIN";
  if (!modelHeaderValid) entry.failReasons.push("badM2");
  if (!skinHeaderValid) entry.failReasons.push("badSkin");
  if (!modelHeaderValid || !skinHeaderValid) {
    entry.failReasons = failReasons(entry.failReasons);
    return entry;
  }
  const stamp = sourceStampValue ?? await sourceStampOrFallback(archives, [readModelPath, readSkinPath]);
  entry.sourceStamp = stamp;
  let parsed;
  let skinInfo;
  try {
    skinInfo = validateSkinStructure(skin);
    parsed = parseM2(model, skin);
    let baselineBytes;
    try {
      const { encodeWvm9 } = await import("./wvm.mjs");
      baselineBytes = encodeWvm9(parsed, undefined);
    } catch {
      // A structurally readable but effect-bearing model may not be encodable as static WVM. The
      // eligibility pass below will exclude it; keep the geometry metrics available for diagnosis.
    }
    entry.baseline = metricsForParsed(parsed, skin, "baseline", skinInfo, baselineBytes);
    if (entry.baseline.drawnTriangles <= 0) entry.failReasons.push("zeroGeometry");
  } catch (error) {
    const message = serialiseError(error);
    const badModel = /Not an MD20|M2 (parent|vertex|header)|model is not/i.test(message);
    entry.failReasons.push(badModel ? "badM2" : (/count|table|range|overflow/i.test(message)
      ? "countOverflow" : "badSkin"));
    entry.error = message;
    entry.failReasons = failReasons(entry.failReasons);
    return entry;
  }
  if (parsed.unsupported.particleEmitters > 0) entry.failReasons.push("particleEmitters");
  if (parsed.unsupported.ribbonEmitters > 0) entry.failReasons.push("ribbonEmitters");
  if (parsed.unsupported.globalLoops > 0) entry.failReasons.push("globalSequences");
  if (parsed.unsupported.events > 0) entry.failReasons.push("events");
  if (ArrayBuffer.isView(parsed.boneWeights)
    && parsed.boneWeights.some((weight) => weight !== 0)) {
    entry.failReasons.push("skinnedGeometry");
  }
  for (const field of ["colours", "textureWeights", "textureTransforms"]) {
    if (Array.isArray(parsed[field]) && parsed[field].length > 0) entry.failReasons.push("materialUnsupported");
  }
  if (parsed.batches.some((batch) => batch.blendMode !== 0)) entry.failReasons.push("materialUnsupported");
  let external;
  try {
    external = await resolveExternalAnimations(archives, readModelPath, model);
    const animation = animationEligibility(model, external, gameObjectAnimationIds);
    entry.animation = {
      bones: animation.bones,
      sequences: animation.sequences,
      externalAnimationCount: external.paths.length,
      missingAnimationPaths: external.missing,
      staticPoseWithBones: animation.staticPoseWithBones === true,
    };
    entry.failReasons.push(...animation.reasons);
  } catch (error) {
    entry.failReasons.push("animationUnknown");
    entry.animationError = serialiseError(error);
  }
  entry.failReasons = failReasons(entry.failReasons);
  const eligible = entry.failReasons.length === 0;
  entry.eligibility = eligible ? "eligible" : "excluded";
  if (!eligible) return entry;
  if (!simplify) {
    entry.comparison = { status: "unavailable" };
    entry.failReasons.push("simplifierUnavailable");
    entry.failReasons = failReasons(entry.failReasons);
    return entry;
  }
  try {
    const simplifiedValue = await simplify(sourceModelInput(model, skin, modelPath, stamp, parsed));
    if (simplifiedValue === undefined) {
      entry.comparison = { status: "unavailable" };
      entry.failReasons.push("simplifierUnavailable");
    } else {
      const simplified = unwrapSimplified(simplifiedValue);
      entry.simplified = metricsForParsed(simplified.parsed, simplified.skin, "simplified", undefined,
        simplified.bytes);
      entry.deltas = compareMetrics(entry.baseline, entry.simplified);
      entry.comparison = { status: "complete" };
      entry.invariants = {
        batchOrderPreserved: !entry.deltas.failures.includes("batchOrderChanged"),
        materialBoundariesPreserved: !entry.deltas.failures.includes("materialBoundaryChanged"),
        boundsContainSource: !entry.deltas.failures.includes("boundsChanged"),
      };
      entry.failReasons.push(...entry.deltas.failures);
      if (entry.simplified.drawnTriangles >= entry.baseline.drawnTriangles
        && entry.simplified.uploadedWvmBytes >= entry.baseline.uploadedWvmBytes) {
        entry.failReasons.push("simplifierNoReduction");
      }
    }
  } catch (error) {
    entry.comparison = { status: "error" };
    const message = serialiseError(error);
    entry.failReasons.push(/geometry|parseable|SKIN|M2|index|position|batch/i.test(message)
      ? "invalidSimplifiedGeometry" : "simplifierError");
    entry.simplifierError = message;
  }
  entry.failReasons = failReasons(entry.failReasons);
  return entry;
}

function quantile(values, fraction) {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.floor((ordered.length - 1) * fraction)));
  return ordered[index];
}

function aggregate(entries) {
  const compared = entries.filter((entry) => entry.deltas && entry.failReasons
    .every((reason) => !["batchOrderChanged", "materialBoundaryChanged", "boundsChanged", "simplifierError"]
      .includes(reason)));
  const reductions = (key) => compared.map((entry) => entry.deltas[key].percent);
  const weighted = (key, baselineKey = key) => {
    let source = 0;
    let saved = 0;
    for (const entry of compared) {
      const baseline = entry.deltas[key].baseline;
      const simplified = entry.deltas[key].simplified;
      source += baseline;
      saved += baseline - simplified;
    }
    return source > 0 ? saved * 100 / source : undefined;
  };
  return {
    comparedCount: compared.length,
    drawnTriangles: { weightedPercent: weighted("drawnTriangles"), medianPercent: quantile(reductions("drawnTriangles"), 0.5), p10Percent: quantile(reductions("drawnTriangles"), 0.1) },
    uniqueReferencedVertices: { weightedPercent: weighted("uniqueReferencedVertices"), medianPercent: quantile(reductions("uniqueReferencedVertices"), 0.5), p10Percent: quantile(reductions("uniqueReferencedVertices"), 0.1) },
    drawnIndexBytes: { weightedPercent: weighted("drawnIndexBytes"), medianPercent: quantile(reductions("drawnIndexBytes"), 0.5), p10Percent: quantile(reductions("drawnIndexBytes"), 0.1) },
    uploadedWvmBytes: { weightedPercent: weighted("uploadedWvmBytes"), medianPercent: quantile(reductions("uploadedWvmBytes"), 0.5), p10Percent: quantile(reductions("uploadedWvmBytes"), 0.1) },
    uniqueGeometryBytes: { weightedPercent: weighted("uniqueGeometryBytes"), medianPercent: quantile(reductions("uniqueGeometryBytes"), 0.5), p10Percent: quantile(reductions("uniqueGeometryBytes"), 0.1) },
  };
}

function runtimeDecision({ placementMap, eligibleCount, selectedEligibleCount, comparedCount, aggregate: summary, entries }) {
  if (!placementMap || eligibleCount === 0 || selectedEligibleCount === 0 || comparedCount === 0) {
    return "insufficient-data";
  }
  if (summary.drawnTriangles.medianPercent === undefined) return "insufficient-data";
  if (entries.some((entry) => entry.deltas?.failures?.some((reason) => [
    "batchOrderChanged", "materialBoundaryChanged", "boundsChanged", "invalidSimplifiedGeometry",
  ].includes(reason)))) return "stop";
  if (summary.drawnTriangles.medianPercent < 30 || summary.drawnTriangles.p10Percent < 15
    || summary.uniqueReferencedVertices.medianPercent < 25
    || summary.uploadedWvmBytes.medianPercent < 20) return "stop";
  return "continue";
}

/**
 * Audit a deterministic, placement-aware corpus for a future static M2 simplifier.
 *
 * `archives` may be an already-open archive chain (or a promise/function yielding one).  The
 * chain is borrowed, never closed.  `simplify`/`simplifier` receives `{ model, skin, parsed,
 * modelPath, sourceStamp }` and may return `{ model, skin }`, `{ modelBytes, skinBytes }`, a
 * parsed M2, a `{ full, low }` geometry summary, or undefined while the reducer is unavailable.
 */
export async function auditM2Simplification(options = {}) {
  const requestedPrefix = listingPrefix(options.prefix ?? "World\\");
  const prefix = canonicalPrefix(requestedPrefix);
  const archivesValue = options.archives;
  const archives = archivesValue
    ? await (typeof archivesValue === "function" ? archivesValue() : archivesValue)
    : await clientArchives(clientDirectory());
  if (!archives || typeof archives.list !== "function" || typeof archives.read !== "function") {
    throw new TypeError("archives must provide list(prefix) and read(path)");
  }
  const seed = String(options.seed ?? options.populationSeed ?? "r4.0b-v1");
  const requestedSampleCount = options.sampleCount ?? options.populationLimit;
  const sampleCount = requestedSampleCount === undefined ? Infinity : Number(requestedSampleCount);
  if (!(sampleCount === Infinity || (Number.isInteger(sampleCount) && sampleCount >= 0))) {
    throw new TypeError("sampleCount must be a non-negative integer");
  }
  const listedPaths = new Map();
  for (const listedPath of await archives.list(requestedPrefix)) {
    const canonical = archiveKey(listedPath);
    if (canonical && !listedPaths.has(canonical)) {
      listedPaths.set(canonical, String(listedPath).replaceAll("/", "\\"));
    }
  }
  const listed = new Set(listedPaths.keys());
  const listedModels = [...listed]
    .filter((path) => path.endsWith(".m2"))
    .sort();
  const listedPopulationPaths = listedModels.filter((path) => listed.has(profilePath(path)));
  const requestedCandidatePaths = canonicalCandidatePaths(options.candidateModelPaths);
  const candidateSet = requestedCandidatePaths === undefined
    ? undefined : new Set(requestedCandidatePaths);
  const listedPopulationSet = candidateSet === undefined ? undefined : new Set(listedPopulationPaths);
  const matchedCandidatePaths = candidateSet === undefined
    ? undefined : listedPopulationPaths.filter((path) => candidateSet.has(path));
  const missingCandidatePaths = candidateSet === undefined
    ? undefined : requestedCandidatePaths.filter((path) => !listedPopulationSet.has(path));
  const populationPaths = matchedCandidatePaths ?? listedPopulationPaths;
  const candidateReport = candidateSet === undefined ? undefined : {
    requestedCount: requestedCandidatePaths.length,
    matchedCount: matchedCandidatePaths.length,
    missingCount: missingCandidatePaths.length,
    digest: sha1(requestedCandidatePaths.join("\n")),
  };
  const populationDigest = sha1(populationPaths.join("\n"));
  const ranked = populationPaths.map((path) => ({ path, hash: sha1(`${seed}\0${path}`) }))
    .sort((left, right) => left.hash.localeCompare(right.hash) || left.path.localeCompare(right.path));
  const selectedCanonicalPaths = (sampleCount === Infinity
    ? populationPaths
    : ranked.slice(0, sampleCount).map((entry) => entry.path));
  const selectedPaths = selectedCanonicalPaths.map((path) => listedPaths.get(path) ?? path);
  const placementMap = normalisePlacementMap(options.placements);
  const gameObjectAnimationIds = options.gameObjectAnimationIds === undefined
    ? undefined
    : new Set((Array.isArray(options.gameObjectAnimationIds)
      || options.gameObjectAnimationIds instanceof Set
      ? [...options.gameObjectAnimationIds] : [options.gameObjectAnimationIds])
      .map(Number).filter(Number.isInteger));
  const simplify = options.simplify ?? options.simplifier ?? defaultSimplify;
  const entries = [];
  for (const modelPath of selectedPaths) {
    const canonical = canonicalPath(modelPath);
    const skinCanonical = profilePath(canonical);
    const readSkinPath = listedPaths.get(skinCanonical) ?? profilePath(modelPath);
    const profilePaths = ["00", "01", "02"].map((profile) => {
      const canonicalProfile = `${canonical.slice(0, -3)}${profile}.skin`;
      return listedPaths.get(canonicalProfile) ?? `${modelPath.slice(0, -3)}${profile}.skin`;
    });
    entries.push(await inspectEntry(archives, modelPath, placementMap, gameObjectAnimationIds, simplify, {
      readModelPath: listedPaths.get(canonical) ?? modelPath,
      readSkinPath,
      sourceStampValue: options.sourceStamp,
      profilePaths,
    }));
  }
  const exteriorEligible = entries.filter((entry) => entry.eligibility === "eligible");
  const selectedEligibleCount = exteriorEligible.length;
  const placementUnknown = entries.filter((entry) => entry.placement?.reasons?.includes("placementUnknown")).length;
  const reportFailReasons = [...new Set(entries.flatMap((entry) => entry.diagnosticFailReasons ?? []))]
    .sort((left, right) => left.localeCompare(right));
  const population = {
    listedM2Count: listedModels.length,
    listedWith00SkinCount: populationPaths.length,
    selectedCount: selectedPaths.length,
    selectedEligibleCount,
    selectedPaths,
    selectedModelPaths: selectedPaths,
    populationDigest,
    selectionDigest: sha1(selectedCanonicalPaths.join("\n")),
    ...(candidateReport ? { candidateModelPaths: candidateReport } : {}),
  };
  const aggregateSummary = aggregate(entries);
  const decision = runtimeDecision({
    placementMap: placementMap && placementMap.size > 0 ? placementMap : undefined,
    eligibleCount: selectedEligibleCount,
    selectedEligibleCount,
    comparedCount: aggregateSummary.comparedCount,
    aggregate: aggregateSummary,
    entries,
  });
  return {
    schemaVersion: "r4.0b/1",
    prefix,
    seed,
    placementEvidence: placementMap && placementMap.size > 0 ? "provided" : "absent",
    placementUnknown,
    exteriorEligible: placementMap && placementMap.size > 0 ? selectedEligibleCount : 0,
    runtimeDecision: placementMap && placementMap.size > 0 ? decision : "insufficient-data",
    selectedModelPaths: selectedPaths,
    populationDigest,
    failReasons: reportFailReasons,
    population,
    aggregate: aggregateSummary,
    entries,
  };
}

function parseArguments(argv) {
  const options = {
    json: false, prefix: "World\\", sampleCount: undefined, seed: undefined,
    client: undefined, placements: undefined,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--prefix") options.prefix = argv[++index] ?? options.prefix;
    else if (argument === "--sample") options.sampleCount = argv[++index];
    else if (argument === "--seed") options.seed = argv[++index];
    else if (argument === "--client") options.client = argv[++index];
    else if (argument === "--placements") options.placements = argv[++index];
    else if (argument === "--help" || argument === "-h") options.help = true;
  }
  if (options.sampleCount !== undefined) options.sampleCount = Number(options.sampleCount);
  return options;
}

function humanSummary(summary) {
  const lines = [
    "Static M2 simplification corpus audit (read-only)",
    `scope: ${summary.prefix || "<all>"}, seed: ${summary.seed}`,
    `population: ${summary.population.listedM2Count} listed M2, ${summary.population.listedWith00SkinCount} with 00.skin, ${summary.population.selectedCount} selected`,
    `placement evidence: ${summary.placementEvidence}; exterior eligible: ${summary.exteriorEligible}`,
    `runtime decision: ${summary.runtimeDecision}`,
    `population digest: ${summary.population.populationDigest}`,
  ];
  const aggregate = summary.aggregate;
  if (aggregate.comparedCount > 0) {
    lines.push(`compared: ${aggregate.comparedCount}; triangles median/p10 ${aggregate.drawnTriangles.medianPercent?.toFixed(2)}%/${aggregate.drawnTriangles.p10Percent?.toFixed(2)}%; `
      + `vertices median ${aggregate.uniqueReferencedVertices.medianPercent?.toFixed(2)}%; WVM bytes median ${aggregate.uploadedWvmBytes.medianPercent?.toFixed(2)}%`);
  } else {
    lines.push("compared: 0 (no eligible simplifier output)");
  }
  const reasonCounts = new Map();
  for (const entry of summary.entries) {
    for (const reason of entry.failReasons ?? []) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  if (reasonCounts.size > 0) {
    lines.push(`fail reasons: ${[...reasonCounts.entries()].sort((a, b) => (FAIL_RANK.get(a[0]) ?? 999) - (FAIL_RANK.get(b[0]) ?? 999))
      .map(([reason, count]) => `${reason}=${count}`).join(", ")}`);
  }
  return lines.join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node tools/audit-m2-simplify.mjs [--client <client-dir>] [--prefix <asset-prefix>] [--sample <count>] [--seed <seed>] [--placements <manifest.json>] [--json]");
    return;
  }
  const placements = options.placements
    ? JSON.parse(await readFile(resolve(options.placements), "utf8")) : undefined;
  const summary = await auditM2Simplification({
    ...options,
    placements,
    archives: options.client ? await clientArchives(resolve(options.client)) : undefined,
  });
  console.log(options.json ? JSON.stringify(summary) : humanSummary(summary));
}

const entry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (entry) {
  try {
    await main();
  } catch (error) {
    console.error(`M2 simplification audit failed: ${serialiseError(error)}`);
    process.exitCode = 1;
  }
}
