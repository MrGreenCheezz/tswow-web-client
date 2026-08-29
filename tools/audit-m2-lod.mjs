// Read-only inventory of authored M2 skin profiles.
//
// This intentionally stops at source inspection.  It does not publish WVM variants, alter the
// existing 00.skin generator, or write a report to disk.  `archives.list()` is the source of the
// candidate set: asking `has()` for every implied name would turn this diagnostic into a large
// archive fan-out and would miss the distinction between a listed profile and a malformed read.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";
import { sourceStamp } from "./source-stamp.mjs";
import { inspectM2SkinProfile } from "./m2-lod.mjs";

const PROFILE_IDS = ["00", "01", "02"];

function profilePath(modelPath, profile) {
  return `${modelPath.slice(0, -3)}${profile}.skin`;
}

function archiveKey(path) {
  return String(path).replaceAll("/", "\\").toLowerCase();
}

function emptyCounters() {
  return { listed: 0, available: 0, missing: 0, invalid: 0 };
}

function reductionCounters() {
  return {
    compared: 0,
    reduced: 0,
    notReduced: 0,
    fullTriangles: 0,
    profileTriangles: 0,
    savedTriangles: 0,
    weightedPercent: undefined,
    medianPercent: undefined,
    minPercent: Infinity,
    maxPercent: -Infinity,
    percentages: [],
    fullVertices: 0,
    profileVertices: 0,
    savedVertices: 0,
    weightedVertexPercent: undefined,
    medianVertexPercent: undefined,
    minVertexPercent: Infinity,
    maxVertexPercent: -Infinity,
    vertexPercentages: [],
  };
}

function serialiseError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function inspectListedProfile(archives, modelPath, profileId, model, listed, stamp) {
  const path = profilePath(modelPath, profileId);
  const result = { profile: profileId, profilePath: path };
  if (!listed.has(archiveKey(path))) {
    result.status = "missing";
    return result;
  }
  result.status = "listed";
  try {
    const skin = await archives.read(path);
    if (!skin) throw new Error("profile is listed but cannot be read");
    const inspected = inspectM2SkinProfile({
      modelPath,
      profile: profileId,
      model,
      skin,
      sourceStamp: stamp,
    });
    result.status = "valid";
    result.vertexCount = inspected.vertexCount;
    result.indexCount = inspected.indexCount;
    result.sourceTriangleCount = inspected.sourceTriangleCount;
    result.drawIndexCount = inspected.drawIndexCount;
    result.triangleCount = inspected.triangleCount;
    result.uniqueTriangleCount = inspected.uniqueTriangleCount;
    return result;
  } catch (error) {
    result.status = "invalid";
    result.error = serialiseError(error);
    return result;
  }
}

/**
 * Inventory real 00.skin/01.skin/02.skin paths visible through an already-open archive chain.
 * The returned object contains only JSON data and no archive, model, or skin buffers.
 */
export async function auditM2Lod({ archives, prefix = "" } = {}) {
  const chain = archives ?? await clientArchives(clientDirectory());
  // `clientArchives()` returns a process-wide shared chain. Do not close it here: the exported
  // audit may run beside another diagnostic in the same process, and closing the shared handle
  // would poison every later reader. The standalone CLI exits after printing its report.
  const listed = new Set([...await chain.list(prefix)].map(archiveKey));
    const modelPaths = [...listed]
      .filter((path) => path.endsWith(".m2"))
      .sort();
    const candidateModelPaths = modelPaths.filter((modelPath) => PROFILE_IDS
      .some((profile) => profile !== "00" && listed.has(archiveKey(profilePath(modelPath, profile)))));
    const counters = Object.fromEntries(PROFILE_IDS.map((profile) => [profile, emptyCounters()]));
    const reductions = {
      "01": reductionCounters(),
      "02": reductionCounters(),
    };
    const entries = [];
    let modelReadErrors = 0;

    for (const modelPath of candidateModelPaths) {
      const model = await chain.read(modelPath);
      if (!model) {
        modelReadErrors++;
        entries.push({ modelPath, status: "model-unreadable" });
        continue;
      }
      const stampPaths = [modelPath, ...PROFILE_IDS
        .filter((profile) => listed.has(archiveKey(profilePath(modelPath, profile))))
        .map((profile) => profilePath(modelPath, profile))];
      const stamp = await sourceStamp(chain, { paths: stampPaths });
      const profiles = [];
      for (const profile of PROFILE_IDS) {
        const inspected = await inspectListedProfile(chain, modelPath, profile, model, listed, stamp);
        profiles.push(inspected);
        counters[profile].listed += inspected.status !== "missing" ? 1 : 0;
        counters[profile].available += inspected.status === "valid" ? 1 : 0;
        counters[profile].missing += inspected.status === "missing" ? 1 : 0;
        counters[profile].invalid += inspected.status === "invalid" ? 1 : 0;
      }
      const full = profiles.find((profile) => profile.profile === "00" && profile.status === "valid");
      for (const profile of profiles.filter((candidate) => candidate.profile !== "00")) {
        if (!full || profile.status !== "valid") continue;
        const reduction = reductions[profile.profile];
        reduction.compared++;
        reduction.fullTriangles += full.triangleCount;
        reduction.profileTriangles += profile.triangleCount;
        const saved = full.triangleCount - profile.triangleCount;
        reduction.savedTriangles += saved;
        const percent = full.triangleCount > 0 ? saved * 100 / full.triangleCount : 0;
        reduction.percentages.push(percent);
        reduction.minPercent = Math.min(reduction.minPercent, percent);
        reduction.maxPercent = Math.max(reduction.maxPercent, percent);
        reduction.fullVertices += full.vertexCount;
        reduction.profileVertices += profile.vertexCount;
        const savedVertices = full.vertexCount - profile.vertexCount;
        reduction.savedVertices += savedVertices;
        const vertexPercent = full.vertexCount > 0 ? savedVertices * 100 / full.vertexCount : 0;
        reduction.vertexPercentages.push(vertexPercent);
        reduction.minVertexPercent = Math.min(reduction.minVertexPercent, vertexPercent);
        reduction.maxVertexPercent = Math.max(reduction.maxVertexPercent, vertexPercent);
        if (profile.triangleCount < full.triangleCount) reduction.reduced++;
        else reduction.notReduced++;
      }
      entries.push({ modelPath, profiles, fullTriangles: full?.triangleCount });
    }

    for (const reduction of Object.values(reductions)) {
      reduction.weightedPercent = reduction.fullTriangles > 0
        ? reduction.savedTriangles * 100 / reduction.fullTriangles : 0;
      reduction.medianPercent = median(reduction.percentages);
      reduction.weightedVertexPercent = reduction.fullVertices > 0
        ? reduction.savedVertices * 100 / reduction.fullVertices : 0;
      reduction.medianVertexPercent = median(reduction.vertexPercentages);
      delete reduction.percentages;
      delete reduction.vertexPercentages;
      if (reduction.compared === 0) {
        reduction.minPercent = undefined;
        reduction.maxPercent = undefined;
        reduction.minVertexPercent = undefined;
        reduction.maxVertexPercent = undefined;
      }
    }

  return {
    prefix: prefix.replaceAll("/", "\\"),
    totalModelCount: modelPaths.length,
    candidateModelCount: candidateModelPaths.length,
    // `modelCount` is retained as a compatibility alias for early R4 audit consumers.
    modelCount: modelPaths.length,
    modelReadErrors,
    profiles: counters,
    reduction: reductions,
    entries,
  };
}

function median(values) {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function humanSummary(summary) {
  const lines = [
    "M2 authored skin audit (read-only)",
    `models: ${summary.totalModelCount}, candidates: ${summary.candidateModelCount} (unreadable: ${summary.modelReadErrors})`,
  ];
  for (const profile of PROFILE_IDS) {
    const count = summary.profiles[profile];
    lines.push(`${profile}.skin: listed ${count.listed}, valid ${count.available}, `
      + `missing ${count.missing}, invalid ${count.invalid}`);
  }
  for (const profile of ["01", "02"]) {
    const reduction = summary.reduction[profile];
    const weighted = reduction.weightedPercent === undefined ? "n/a" : `${reduction.weightedPercent.toFixed(2)}%`;
    const medianValue = reduction.medianPercent === undefined ? "n/a" : `${reduction.medianPercent.toFixed(2)}%`;
    const weightedVertices = reduction.weightedVertexPercent === undefined
      ? "n/a" : `${reduction.weightedVertexPercent.toFixed(2)}%`;
    const medianVertices = reduction.medianVertexPercent === undefined
      ? "n/a" : `${reduction.medianVertexPercent.toFixed(2)}%`;
    lines.push(`${profile}.skin reduction vs 00: compared ${reduction.compared}, `
      + `strictly reduced ${reduction.reduced}, not reduced ${reduction.notReduced}, `
      + `saved ${reduction.savedTriangles} / ${reduction.fullTriangles} drawn triangles (${weighted}), median ${medianValue}; `
      + `vertices ${reduction.savedVertices} / ${reduction.fullVertices} (${weightedVertices}), median ${medianVertices}`);
  }
  return lines.join("\n");
}

function parseArguments(argv) {
  const options = { json: false, prefix: "", client: undefined };
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--prefix") options.prefix = argv[++index] ?? "";
    else if (argument === "--client") options.client = argv[++index];
    else if (argument === "--help" || argument === "-h") options.help = true;
    else positional.push(argument);
  }
  if (!options.prefix && positional.length > 0) options.prefix = positional[0];
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node tools/audit-m2-lod.mjs [--json] [--prefix <asset-prefix>] [--client <client-dir>]");
    return;
  }
  const summary = await auditM2Lod({
    prefix: options.prefix,
    archives: options.client ? await clientArchives(resolve(options.client)) : undefined,
  });
  console.log(options.json ? JSON.stringify(summary) : humanSummary(summary));
}

const entry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (entry) {
  try {
    await main();
  } catch (error) {
    console.error(`M2 authored skin audit failed: ${serialiseError(error)}`);
    process.exitCode = 1;
  }
}
