// Read-only R4.1 classification of distinct direct ADT M2 placements.
//
// This is an evidence collector, not a runtime admission path.  A direct MDDF placement is
// exterior placement metadata; `strictlyRigidBakeEligible` additionally requires proof that the
// referenced geometry is rigid and that every referenced bone/material track is safe to freeze.
// Missing or undecodable evidence is intentionally not treated as static.

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseAdtPlacements as defaultParseAdtPlacements } from "./adt-placements.mjs";
import {
  BLEND_MODES,
  m2Animations as defaultM2Animations,
  parseM2 as defaultParseM2,
  parseM2Skeleton as defaultParseM2Skeleton,
} from "./m2.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";

const DEFAULT_PREFIX = "World\\Maps\\";
const DEFAULT_SEED = "r4.0c-world-v1";
const DEFAULT_SAMPLE_COUNT = 512;

function canonicalPath(value) {
  if (typeof value !== "string") return undefined;
  const path = value.replaceAll("/", "\\").replace(/^\\+/, "").toLowerCase();
  return path.length > 0 ? path : undefined;
}

function canonicalPrefix(value) {
  const path = canonicalPath(value ?? DEFAULT_PREFIX);
  if (!path) return "";
  return path.endsWith("\\") ? path : `${path}\\`;
}

function displayPrefix(value) {
  const path = String(value ?? DEFAULT_PREFIX).replaceAll("/", "\\");
  return path.length === 0 || path.endsWith("\\") ? path : `${path}\\`;
}

function mapNameOf(path, prefix) {
  const remainder = path.slice(prefix.length);
  const separator = remainder.indexOf("\\");
  return separator < 0 ? remainder : remainder.slice(0, separator);
}

function mapSet(value) {
  if (value === undefined || value === null) return undefined;
  const values = Array.isArray(value) || value instanceof Set ? [...value] : [value];
  const result = new Set(values.map(canonicalPath).filter(Boolean));
  return result.size > 0 ? result : undefined;
}

function sha1(value) {
  return createHash("sha1").update(value).digest("hex");
}

function serialiseError(error) {
  return error instanceof Error ? error.message : String(error);
}

function profilePath(modelPath) {
  return `${modelPath.slice(0, -3)}00.skin`;
}

function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalCandidates(value) {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) || value instanceof Set ? [...value] : [value];
  return [...new Set(values.map(canonicalPath).filter(Boolean))].sort(comparePath);
}

function finiteInteger(value, fallback) {
  if (value === Infinity) return Infinity;
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError("sampleCount must be a non-negative integer");
  }
  return number;
}

function increment(map, key, amount = 1) {
  map[key] = (map[key] ?? 0) + amount;
}

function emptyStatusCounts() {
  return { missing: 0, constant: 0, varying: 0, undecodable: 0 };
}

function emptyUnsupported() {
  return {
    particleEmitters: 0,
    ribbonEmitters: 0,
    events: 0,
    globalLoops: 0,
  };
}

function emptyTableInfo() {
  return {
    present: false,
    batchReferences: 0,
    validReferences: 0,
    invalidReferences: 0,
  };
}

function isView(value) {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function trackState(track) {
  if (!track || typeof track !== "object") return "unknown";
  if (track.varying === true || track.dynamic === true) return "varying";
  if (track.constant === true || track.static === true) return "constant";
  const times = track.times;
  const values = track.values;
  if (!isView(times) || !isView(values) || times.length === 0) return "unknown";
  const components = values.length / times.length;
  if (!Number.isInteger(components) || components <= 0) return "unknown";
  for (let key = 0; key < times.length; key++) {
    for (let component = 0; component < components; component++) {
      const value = values[key * components + component];
      if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
      if (key > 0 && value !== values[component]) return "varying";
    }
  }
  return "constant";
}

function collectTrackStates(value, states, seen = new Set()) {
  if (value === null || value === undefined || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (value.varying === true || value.dynamic === true || value.constant === true || value.static === true
    || "times" in value || "values" in value) {
    states.push(trackState(value));
    return;
  }
  if (isView(value)) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectTrackStates(entry, states, seen);
    return;
  }
  for (const entry of Object.values(value)) collectTrackStates(entry, states, seen);
}

function materialTrackStatus(parsed) {
  const tables = [parsed.colours, parsed.colors, parsed.textureWeights, parsed.textureTransforms];
  const present = tables.some((table) => Array.isArray(table) && table.length > 0);
  if (!present) return "none";
  const states = [];
  for (const table of tables) {
    if (Array.isArray(table)) for (const entry of table) collectTrackStates(entry, states);
  }
  if (states.length === 0 || states.includes("unknown")) return "unknown";
  return states.includes("varying") ? "varying" : "constant";
}

function readUnsupported(parsed) {
  if (!parsed) return { counts: emptyUnsupported(), malformed: false };
  const source = parsed?.unsupported ?? {};
  const result = emptyUnsupported();
  let malformed = !parsed.unsupported || typeof parsed.unsupported !== "object";
  for (const key of Object.keys(result)) {
    const value = source[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
      malformed = true;
      result[key] = 0;
    } else {
      result[key] = value;
    }
  }
  return { counts: result, malformed };
}

function classifyWeights(parsed) {
  const weights = parsed?.boneWeights;
  const indices = parsed?.boneIndices;
  if (!(weights instanceof Uint8Array) || !(indices instanceof Uint8Array)
    || weights.length !== indices.length || weights.length % 4 !== 0) {
    return {
      pattern: "invalid", vertexCount: 0, referencedBones: new Set(), influenceCounts: {},
      invalidReasons: ["invalidWeightTable"],
    };
  }
  const vertexCount = weights.length / 4;
  const referencedBones = new Set();
  const influenceCounts = {};
  const invalidReasons = new Set();
  let allZero = true;
  let rigid = true;
  let anyMulti = false;
  let zeroWeightVertices = 0;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    let influences = 0;
    let sum = 0;
    for (let slot = 0; slot < 4; slot++) {
      const at = vertex * 4 + slot;
      const weight = weights[at];
      const bone = indices[at];
      if (!Number.isInteger(weight) || weight < 0 || weight > 255
        || !Number.isInteger(bone) || bone < 0 || bone > 255) {
        invalidReasons.add("invalidWeightTable");
      }
      sum += weight;
      if (weight === 0) continue;
      allZero = false;
      influences++;
      referencedBones.add(bone);
    }
    if (sum !== 0 && sum !== 255) invalidReasons.add("weightSum");
    if (sum === 0) zeroWeightVertices++;
    increment(influenceCounts, String(influences));
    if (influences !== 1) rigid = false;
    if (influences > 1) anyMulti = true;
  }
  if (!allZero && zeroWeightVertices > 0) invalidReasons.add("zeroWeightVertex");
  let pattern = "invalid";
  if (invalidReasons.size === 0) {
    if (allZero) pattern = "all-zero";
    else if (anyMulti) pattern = "multi-influence";
    else if (referencedBones.size === 1) pattern = "rigid-same-bone";
    else if (rigid) pattern = "rigid-multi-bone";
  }
  return { pattern, vertexCount, referencedBones, influenceCounts, invalidReasons: [...invalidReasons].sort(comparePath) };
}

function validateWeightBones(referencedBones, skeleton) {
  if (referencedBones.size === 0) return { proof: "not-applicable", invalid: [] };
  if (!skeleton || !Array.isArray(skeleton.bones)) return { proof: "undecodable", invalid: [] };
  const invalid = [...referencedBones].filter((bone) => !Number.isInteger(bone)
    || bone < 0 || bone >= skeleton.bones.length).sort((left, right) => left - right);
  return { proof: invalid.length > 0 ? "invalid" : "valid", invalid };
}

function constantValues(channel) {
  const times = channel?.times;
  const values = channel?.values;
  if (!isView(times) || !isView(values) || times.length === 0) return undefined;
  const components = values.length / times.length;
  if (!Number.isInteger(components) || components <= 0) return undefined;
  const first = [...values.slice(0, components)];
  if (first.some((value) => typeof value !== "number" || !Number.isFinite(value))) return undefined;
  for (let key = 1; key < times.length; key++) {
    for (let component = 0; component < components; component++) {
      if (values[key * components + component] !== first[component]) return undefined;
    }
  }
  return first;
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function channelClassification(referencedBones, skeleton, externalMissing, skeletonError) {
  const statusCounts = emptyStatusCounts();
  if (referencedBones.size === 0) {
    return { proof: "not-applicable", statusCounts, statuses: [] };
  }
  if (externalMissing || skeletonError || !skeleton || !Array.isArray(skeleton.clips)) {
    statusCounts.undecodable = referencedBones.size;
    return { proof: "undecodable", statusCounts, statuses: [...referencedBones].map(() => "undecodable") };
  }
  if (skeleton.clips.length === 0) {
    statusCounts.missing = referencedBones.size;
    return { proof: "missing", statusCounts, statuses: [...referencedBones].map(() => "missing") };
  }
  const statuses = [...referencedBones].sort((left, right) => left - right).map((bone) => {
    const boneStatuses = [];
    for (const kind of [0, 1, 2]) {
      const channels = skeleton.clips.map((clip) => Array.isArray(clip?.channels)
        ? clip.channels.filter((channel) => channel?.bone === bone && channel?.kind === kind) : []);
      if (channels.some((entries) => entries.length === 0)) {
        boneStatuses.push("missing");
        continue;
      }
      if (channels.some((entries) => entries.length !== 1)) {
        boneStatuses.push("undecodable");
        continue;
      }
      const values = [];
      let status = "constant";
      for (const entries of channels) {
        const channel = entries[0];
        const state = trackState(channel);
        if (state === "unknown") {
          status = "undecodable";
          break;
        }
        if (state === "varying") {
          status = "varying";
          continue;
        }
        const constant = constantValues(channel);
        if (!constant) {
          status = "undecodable";
          break;
        }
        values.push(constant);
      }
      if (status === "constant") {
        const baseline = values[0];
        if (values.some((value) => !sameValues(value, baseline))) status = "mixed";
        // Compare the same bone/kind pose across every clip, not just each track in isolation.
        for (let clip = 1; clip < channels.length && status === "constant"; clip++) {
          const current = constantValues(channels[clip][0]);
          if (!current || !sameValues(current, baseline)) status = "mixed";
        }
      }
      boneStatuses.push(status);
    }
    if (boneStatuses.includes("undecodable")) return "undecodable";
    if (boneStatuses.includes("varying")) return boneStatuses.some((status) => status !== "varying") ? "mixed" : "varying";
    if (boneStatuses.includes("mixed")) return "mixed";
    if (boneStatuses.includes("missing")) return boneStatuses.some((status) => status !== "missing") ? "mixed" : "missing";
    return "constant";
  });
  for (const status of statuses) increment(statusCounts, status);
  const distinct = new Set(statuses);
  const proof = distinct.size > 1 ? "mixed" : statuses[0];
  return { proof, statusCounts, statuses };
}

function tableInfo(parsed, field, reference) {
  const table = parsed?.[field];
  const result = emptyTableInfo();
  result.present = Array.isArray(table) && table.length > 0;
  for (const batch of Array.isArray(parsed?.batches) ? parsed.batches : []) {
    const index = reference(batch);
    if (!Number.isInteger(index) || index < 0) continue;
    result.batchReferences++;
    if (index < (Array.isArray(table) ? table.length : 0)) result.validReferences++;
    else result.invalidReferences++;
  }
  return result;
}

function tableSummary(parsed) {
  return {
    colours: tableInfo(parsed, "colours", (batch) => batch.colorIndex === 0xffff ? -1 : batch.colorIndex),
    textureWeights: tableInfo(parsed, "textureWeights", (batch) => batch.textureWeight),
    textureTransforms: tableInfo(parsed, "textureTransforms", (batch) => batch.textureTransform),
  };
}

function blendSummary(parsed) {
  const result = {};
  const modes = new Set();
  for (const batch of Array.isArray(parsed?.batches) ? parsed.batches : []) {
    const numeric = Number(batch?.blendMode);
    const mode = Number.isInteger(numeric) && BLEND_MODES[numeric] ? BLEND_MODES[numeric] : `unknown:${batch?.blendMode}`;
    increment(result, mode);
    modes.add(mode);
  }
  return { batches: result, modes: [...modes].sort(comparePath) };
}

function strictReasons({ listedM2, listed00Skin, parsed, pattern, vertexCount, referencedBones,
  channelProof, materialProof, tables, unsupported, unsupportedMalformed, attachmentCount,
  attachmentProof, boneIndexProof, invalidBoneIndices, weightInvalidReasons, parseError }) {
  const reasons = [];
  if (!listedM2) reasons.push("missingM2");
  if (!listed00Skin) reasons.push("missing00Skin");
  if (parseError) reasons.push("invalid");
  if (!["all-zero", "rigid-same-bone", "rigid-multi-bone"].includes(pattern)) {
    reasons.push(`bonePattern:${pattern}`);
  }
  if (vertexCount === 0 || !Array.isArray(parsed?.batches) || parsed.batches.length === 0) reasons.push("zeroGeometry");
  if (referencedBones.size > 0 && channelProof !== "constant") reasons.push(`channel:${channelProof}`);
  for (const reason of weightInvalidReasons) reasons.push(reason);
  if (invalidBoneIndices.length > 0) reasons.push("boneIndexOutOfRange");
  if (referencedBones.size > 0 && boneIndexProof !== "valid") reasons.push(`boneIndices:${boneIndexProof}`);
  if (materialProof === "varying") reasons.push("dynamicMaterialTracks");
  if (materialProof === "unknown") reasons.push("unknownMaterialTracks");
  if (Object.values(tables).some((table) => table.invalidReferences > 0)) reasons.push("invalidMaterialReferences");
  if (attachmentProof === "unknown") reasons.push("unknownAttachments");
  if (attachmentCount > 0) reasons.push("attachments");
  if (unsupportedMalformed) reasons.push("invalidUnsupportedCounts");
  for (const [key, count] of Object.entries(unsupported)) if (count > 0) reasons.push(key);
  return [...new Set(reasons)].sort(comparePath);
}

function addAggregateBlend(target, row) {
  for (const [mode, count] of Object.entries(row.blend.batches)) {
    if (!target[mode]) target[mode] = { batches: 0, models: 0 };
    target[mode].batches += count;
  }
  for (const mode of row.blend.modes) {
    if (!target[mode]) target[mode] = { batches: 0, models: 0 };
    target[mode].models++;
  }
}

function addAggregateTables(target, row) {
  for (const [name, info] of Object.entries(row.tables)) {
    if (!target[name]) target[name] = { models: 0, batchReferences: 0, validReferences: 0, invalidReferences: 0 };
    if (info.present) target[name].models++;
    target[name].batchReferences += info.batchReferences;
    target[name].validReferences += info.validReferences;
    target[name].invalidReferences += info.invalidReferences;
  }
}

function addAggregateUnsupported(target, unsupported) {
  for (const [key, count] of Object.entries(unsupported)) {
    target[key] = (target[key] ?? 0) + count;
  }
}

/**
 * Classify distinct direct ADT M2 placements for an offline R4.1 eligibility audit.
 *
 * `archives` is borrowed and never closed.  `parsers` (or the corresponding direct options) may
 * inject parseAdtPlacements, parseM2, m2Animations, and parseM2Skeleton for deterministic tests.
 * The scanner keeps aggregate model rows only; it never returns the individual MDDF instances.
 */
export async function auditM2RigEligibility(options = {}) {
  const requestedPrefix = displayPrefix(options.prefix ?? DEFAULT_PREFIX);
  const prefix = canonicalPrefix(requestedPrefix);
  const maps = mapSet(options.mapNames);
  const parsers = options.parsers ?? {};
  const parseAdtPlacements = options.parseAdtPlacements ?? parsers.parseAdtPlacements ?? defaultParseAdtPlacements;
  const parseM2 = options.parseM2 ?? parsers.parseM2 ?? defaultParseM2;
  const m2Animations = options.m2Animations ?? parsers.m2Animations ?? defaultM2Animations;
  const parseM2Skeleton = options.parseM2Skeleton ?? parsers.parseM2Skeleton ?? defaultParseM2Skeleton;
  const archivesValue = options.archives;
  const archives = archivesValue
    ? await (typeof archivesValue === "function" ? archivesValue() : archivesValue)
    : await clientArchives(clientDirectory());
  if (!archives || typeof archives.list !== "function" || typeof archives.read !== "function") {
    throw new TypeError("archives must provide list(prefix) and read(path)");
  }
  const seed = String(options.seed ?? DEFAULT_SEED);
  const sampleCount = finiteInteger(options.sampleCount, DEFAULT_SAMPLE_COUNT);
  const listedPaths = new Map();
  for (const value of await archives.list("")) {
    const canonical = canonicalPath(value);
    if (!canonical) continue;
    const display = String(value).replaceAll("/", "\\");
    const previous = listedPaths.get(canonical);
    if (previous === undefined || display < previous) listedPaths.set(canonical, display);
  }
  const listed = new Set(listedPaths.keys());
  const adtPaths = [...listed]
    .filter((path) => path.startsWith(prefix) && path.endsWith(".adt"))
    .filter((path) => maps === undefined || maps.has(mapNameOf(path, prefix)))
    .sort(comparePath);
  const models = new Map();
  const diagnostics = {
    adtReadMissing: 0,
    adtReadErrors: [],
    adtParseErrors: [],
    modelReadMissing: 0,
    modelReadErrors: [],
    skinReadMissing: 0,
    skinReadErrors: [],
  };
  for (const adtPath of adtPaths) {
    const readPath = listedPaths.get(adtPath) ?? adtPath;
    let data;
    try {
      data = await archives.read(readPath);
    } catch (error) {
      diagnostics.adtReadErrors.push({ path: adtPath, error: serialiseError(error) });
      continue;
    }
    if (!data) {
      diagnostics.adtReadMissing++;
      continue;
    }
    let objects;
    try {
      objects = parseAdtPlacements(data);
    } catch (error) {
      diagnostics.adtParseErrors.push({ path: adtPath, error: serialiseError(error) });
      continue;
    }
    for (const object of objects ?? []) {
      if (object?.kind !== "m2") continue;
      const modelPath = canonicalPath(object.name ?? object.modelPath);
      if (!modelPath || !modelPath.endsWith(".m2")) continue;
      let row = models.get(modelPath);
      if (!row) {
        row = { modelPath, directPlacementCount: 0, tileCount: 0, _tiles: new Set() };
        models.set(modelPath, row);
      }
      row.directPlacementCount++;
      row._tiles.add(adtPath);
    }
  }
  const populationRows = [...models.values()].sort((left, right) => comparePath(left.modelPath));
  for (const row of populationRows) row.tileCount = row._tiles.size;
  const populationPaths = populationRows.map((row) => row.modelPath);
  const populationModelDigest = sha1(populationPaths.join("\n"));
  const populationDigest = sha1(populationRows.map((row) => [
    row.modelPath,
    row.directPlacementCount,
    row.tileCount,
    listed.has(row.modelPath) ? 1 : 0,
    listed.has(profilePath(row.modelPath)) ? 1 : 0,
  ].join("\t")).join("\n"));
  const ranked = populationPaths.map((path) => ({ path, hash: sha1(`${seed}\0${path}`) }))
    .sort((left, right) => comparePath(left.hash, right.hash) || comparePath(left.path, right.path));
  const selectedCanonicalPaths = sampleCount === Infinity
    ? populationPaths : ranked.slice(0, sampleCount).map((entry) => entry.path);
  // Keep the public selection canonical, exactly as R4.0c does; aliases are only for archive reads.
  const selectedPaths = selectedCanonicalPaths;
  const selectedDigest = sha1(selectedCanonicalPaths.join("\n"));
  const rowByPath = new Map(populationRows.map((row) => [row.modelPath, row]));
  const rows = [];
  const animationCache = new Map();
  const aggregate = {
    bonePatterns: {},
    channelProofs: {},
    materialTracks: {},
    blendModes: {},
    tables: {
      colours: { models: 0, batchReferences: 0, validReferences: 0, invalidReferences: 0 },
      textureWeights: { models: 0, batchReferences: 0, validReferences: 0, invalidReferences: 0 },
      textureTransforms: { models: 0, batchReferences: 0, validReferences: 0, invalidReferences: 0 },
    },
    unsupported: emptyUnsupported(),
    unsupportedModels: emptyUnsupported(),
    unsupportedMalformed: 0,
    strictFailReasons: {},
    strictlyRigidBakeEligible: 0,
  };
  for (const modelPath of selectedCanonicalPaths) {
    const populationRow = rowByPath.get(modelPath);
    const listedM2 = listed.has(modelPath);
    const skinCanonical = profilePath(modelPath);
    const listed00Skin = listed.has(skinCanonical);
    const readModelPath = listedPaths.get(modelPath) ?? modelPath;
    const readSkinPath = listedPaths.get(skinCanonical) ?? skinCanonical;
    let modelData;
    let skinData;
    let parseError;
    if (listedM2) {
      try {
        modelData = await archives.read(readModelPath);
      } catch (error) {
        diagnostics.modelReadErrors.push({ path: modelPath, error: serialiseError(error) });
      }
    }
    if (!modelData) diagnostics.modelReadMissing++;
    if (listed00Skin) {
      try {
        skinData = await archives.read(readSkinPath);
      } catch (error) {
        diagnostics.skinReadErrors.push({ path: skinCanonical, error: serialiseError(error) });
      }
    }
    if (!skinData) diagnostics.skinReadMissing++;
    let parsed;
    if (modelData && skinData) {
      try {
        parsed = parseM2(modelData, skinData);
      } catch (error) {
        parseError = serialiseError(error);
      }
    }
    const weights = classifyWeights(parsed);
    const unsupportedResult = readUnsupported(parsed);
    const unsupported = unsupportedResult.counts;
    const unsupportedMalformed = unsupportedResult.malformed;
    const tables = tableSummary(parsed ?? {});
    const blend = blendSummary(parsed ?? {});
    let skeleton;
    let skeletonError = Boolean(parseError);
    let externalMissing = false;
    if (parsed && modelData) {
      let animations = [];
      try {
        animations = m2Animations(modelData) ?? [];
      } catch {
        skeletonError = true;
      }
      const animationFiles = new Map();
      for (const animation of animations) {
        if (animation?.external === undefined) continue;
        const animationPath = `${modelPath.slice(0, -3)}${animation.external}.anim`;
        let animationData;
        if (animationCache.has(animationPath)) animationData = animationCache.get(animationPath);
        else {
          try {
            animationData = listed.has(animationPath) ? await archives.read(listedPaths.get(animationPath) ?? animationPath) : undefined;
          } catch {
            animationData = undefined;
          }
          animationCache.set(animationPath, animationData);
        }
        if (!animationData) externalMissing = true;
        else animationFiles.set(animation.external, animationData);
      }
      try {
        skeleton = parseM2Skeleton(modelData, { animations: animationFiles });
      } catch {
        skeletonError = true;
      }
      if (Number(skeleton?.missingAnimations ?? 0) > 0) externalMissing = true;
    }
    const boneValidation = validateWeightBones(weights.referencedBones, skeleton);
    const bonePattern = boneValidation.proof === "invalid" ? "invalid" : weights.pattern;
    const channels = channelClassification(weights.referencedBones, skeleton, externalMissing, skeletonError);
    const attachmentCount = Array.isArray(skeleton?.attachments) ? skeleton.attachments.length : 0;
    const attachmentProof = skeleton && Array.isArray(skeleton.attachments) ? "known" : "unknown";
    const materialProof = materialTrackStatus(parsed ?? {});
    const strictFailReasons = strictReasons({
      listedM2,
      listed00Skin,
      parsed,
      pattern: bonePattern,
      vertexCount: weights.vertexCount,
      referencedBones: weights.referencedBones,
      channelProof: channels.proof,
      materialProof,
      tables,
      unsupported,
      unsupportedMalformed,
      attachmentCount,
      attachmentProof,
      boneIndexProof: boneValidation.proof,
      invalidBoneIndices: boneValidation.invalid,
      weightInvalidReasons: weights.invalidReasons,
      parseError: parseError || !parsed,
    });
    const strictlyRigidBakeEligible = strictFailReasons.length === 0;
    const row = {
      modelPath,
      directPlacementCount: populationRow.directPlacementCount,
      placementCount: populationRow.directPlacementCount,
      tileCount: populationRow.tileCount,
      listedM2,
      listed00Skin,
      bonePattern,
      vertexCount: weights.vertexCount,
      influenceCounts: weights.influenceCounts,
      referencedBoneCount: weights.referencedBones.size,
      boneIndexProof: boneValidation.proof,
      invalidBoneIndices: boneValidation.invalid,
      weightInvalidReasons: weights.invalidReasons,
      channelProof: channels.proof,
      channelStatusCounts: channels.statusCounts,
      materialTracks: materialProof,
      blend,
      tables,
      unsupported,
      unsupportedMalformed,
      attachmentCount,
      attachmentProof,
      strictlyRigidBakeEligible,
      strictFailReasons,
    };
    if (parseError) row.parseError = parseError;
    rows.push(row);
    increment(aggregate.bonePatterns, bonePattern);
    increment(aggregate.channelProofs, channels.proof);
    increment(aggregate.materialTracks, materialProof);
    addAggregateBlend(aggregate.blendModes, row);
    addAggregateTables(aggregate.tables, row);
    addAggregateUnsupported(aggregate.unsupported, unsupported);
    if (unsupportedMalformed) increment(aggregate, "unsupportedMalformed");
    for (const [key, count] of Object.entries(unsupported)) {
      if (count > 0) aggregate.unsupportedModels[key]++;
    }
    if (strictlyRigidBakeEligible) aggregate.strictlyRigidBakeEligible++;
    for (const reason of strictFailReasons) increment(aggregate.strictFailReasons, reason);
  }
  for (const collection of [
    diagnostics.adtReadErrors,
    diagnostics.adtParseErrors,
    diagnostics.modelReadErrors,
    diagnostics.skinReadErrors,
  ]) collection.sort((left, right) => comparePath(left.path, right.path) || comparePath(left.error, right.error));
  return {
    schemaVersion: "r4.1/1",
    prefix,
    requestedPrefix,
    mapNames: maps ? [...maps].sort(comparePath) : undefined,
    seed,
    sampleCount,
    populationDigest,
    populationModelDigest,
    selectionDigest: selectedDigest,
    selectedModelPaths: selectedPaths,
    population: {
      adtPaths: adtPaths.length,
      modelPaths: populationPaths.length,
      directM2Placements: populationRows.reduce((sum, row) => sum + row.directPlacementCount, 0),
      populationDigest,
      modelPathDigest: populationModelDigest,
      selectionDigest: selectedDigest,
      selectedModelPaths: selectedPaths,
    },
    counts: {
      adtTiles: adtPaths.length,
      populationModels: populationRows.length,
      selectedModels: rows.length,
      strictlyRigidBakeEligible: aggregate.strictlyRigidBakeEligible,
      bonePatterns: aggregate.bonePatterns,
      channelProofs: aggregate.channelProofs,
      materialTracks: aggregate.materialTracks,
    },
    aggregate,
    models: rows,
    diagnostics,
  };
}

function parseArguments(argv) {
  const options = { client: undefined, prefix: DEFAULT_PREFIX, mapNames: [], sampleCount: DEFAULT_SAMPLE_COUNT,
    seed: DEFAULT_SEED, json: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--client") options.client = argv[++index];
    else if (argument === "--prefix") options.prefix = argv[++index] ?? options.prefix;
    else if (argument === "--map") options.mapNames.push(argv[++index] ?? "");
    else if (argument === "--sample") options.sampleCount = argv[++index] ?? options.sampleCount;
    else if (argument === "--seed") options.seed = argv[++index] ?? options.seed;
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
  }
  if (options.mapNames.length === 0) delete options.mapNames;
  return options;
}

function humanSummary(summary) {
  const patterns = Object.entries(summary.aggregate.bonePatterns).sort((left, right) => comparePath(left[0], right[0]))
    .map(([key, value]) => `${key}=${value}`).join(", ");
  const channels = Object.entries(summary.aggregate.channelProofs).sort((left, right) => comparePath(left[0], right[0]))
    .map(([key, value]) => `${key}=${value}`).join(", ");
  return [
    "M2 rigid-bake eligibility audit (read-only)",
    `population: ${summary.population.modelPaths} direct models, selected ${summary.models.length}/${summary.sampleCount}`,
    `bone patterns: ${patterns}`,
    `channel proof: ${channels}`,
    `strictly rigid-bake eligible: ${summary.aggregate.strictlyRigidBakeEligible}`,
    `population digest: ${summary.populationDigest}`,
    `selection digest: ${summary.selectionDigest}`,
  ].join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node tools/audit-m2-rig-eligibility.mjs [--client <client-dir>] [--prefix <asset-prefix>] [--map <map-directory>] [--sample <count>] [--seed <seed>] [--json]");
    return;
  }
  const summary = await auditM2RigEligibility({
    ...options,
    archives: options.client ? await clientArchives(resolve(options.client)) : undefined,
  });
  console.log(options.json ? JSON.stringify(summary) : humanSummary(summary));
}

const entry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (entry) {
  try {
    await main();
  } catch (error) {
    console.error(`M2 rig eligibility audit failed: ${serialiseError(error)}`);
    process.exitCode = 1;
  }
}
