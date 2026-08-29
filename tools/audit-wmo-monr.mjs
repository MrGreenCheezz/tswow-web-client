// Read-only audit of authored WMO group normals.
//
// WMO roots are intentionally out of scope here.  A group file is a top-level MOGP chunk whose
// payload starts with the 68-byte group header and then contains nested MOVT, MONR and MOVI chunks.
// This scanner reads only those four pieces, keeps no decoded geometry, and never closes a borrowed
// archive.  `validGroups` is deliberately strict: the geometry and index table must be sound and
// MONR must be an exact finite normal table.  `geometryValidGroups` remains available so a missing
// normal table is visible as a fidelity gap rather than silently erasing the group from the corpus.

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";

const DEFAULT_PREFIX = "World\\wmo\\";
const MOGP_HEADER_SIZE = 68;
const VECTOR_STRIDE = 12;
const NORMAL_UNIT_EPSILON = 1e-3;
const NORMAL_EQUAL_EPSILON = 1e-5;
const GROUP_SUFFIX = /_\d{3}\.wmo$/;

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

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha1(value) {
  return createHash("sha1").update(value).digest("hex");
}

function serialiseError(error) {
  return error instanceof Error ? error.message : String(error);
}

function tagAt(data, offset) {
  return [...data.subarray(offset, offset + 4)].reverse()
    .map((value) => String.fromCharCode(value)).join("");
}

/** Parse a little-endian WoW chunk stream, protecting only chunks that affect this audit. */
function chunkMap(data, label, protectedTags = new Set()) {
  if (!data || typeof data.length !== "number" || typeof data.subarray !== "function"
    || typeof data.readUInt32LE !== "function") {
    throw new TypeError(`${label} is not a readable byte buffer`);
  }
  const result = new Map();
  for (let offset = 0; offset < data.length;) {
    if (data.length - offset < 8) throw new Error(`${label} has a truncated chunk header`);
    const tag = tagAt(data, offset);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > data.length) throw new Error(`${label} has a truncated ${tag} chunk`);
    if (result.has(tag) && protectedTags.has(tag)) throw new Error(`${label} has duplicate ${tag} chunk`);
    // Optional chunks such as MOTV may legitimately repeat for additional UV sets. The audit does
    // not inspect them, so retaining the first payload keeps parsing bounded without weakening the
    // duplicate checks on MOGP/MOVT/MONR/MOVI.
    if (!result.has(tag)) result.set(tag, data.subarray(start, end));
    offset = end;
  }
  return result;
}

function finitePositionStats(data, vertexCount) {
  let nonFinite = 0;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const offset = vertex * VECTOR_STRIDE;
    for (let axis = 0; axis < 3; axis++) {
      if (!Number.isFinite(data.readFloatLE(offset + axis * 4))) nonFinite++;
    }
  }
  return { nonFinite };
}

function normalKey(data, vertex) {
  const offset = vertex * VECTOR_STRIDE;
  return [data.readFloatLE(offset), data.readFloatLE(offset + 4), data.readFloatLE(offset + 8)];
}

function positionKey(data, vertex) {
  const offset = vertex * VECTOR_STRIDE;
  const values = [data.readFloatLE(offset), data.readFloatLE(offset + 4), data.readFloatLE(offset + 8)];
  // -0 and +0 denote the same authored position for hard-edge evidence.
  return values.map((value) => (value === 0 ? 0 : value)).join("\u0000");
}

function normalsEqual(left, right) {
  return left.every((value, index) => Math.abs(value - right[index]) <= NORMAL_EQUAL_EPSILON);
}

function normalStats(positions, normals, vertexCount) {
  let normalized = 0;
  let nonUnit = 0;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const normal = normalKey(normals, vertex);
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    if (Math.abs(length - 1) <= NORMAL_UNIT_EPSILON) normalized++;
    else nonUnit++;
  }

  const positionsByKey = new Map();
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const key = positionKey(positions, vertex);
    const vertices = positionsByKey.get(key);
    if (vertices) vertices.push(vertex);
    else positionsByKey.set(key, [vertex]);
  }
  let duplicatePositionClusters = 0;
  let duplicatePositionVertices = 0;
  let divergentNormalClusters = 0;
  let divergentNormalVertices = 0;
  for (const vertices of positionsByKey.values()) {
    if (vertices.length < 2) continue;
    duplicatePositionClusters++;
    duplicatePositionVertices += vertices.length;
    const distinctNormals = [];
    for (const vertex of vertices) {
      const normal = normalKey(normals, vertex);
      if (!distinctNormals.some((known) => normalsEqual(known, normal))) distinctNormals.push(normal);
    }
    if (distinctNormals.length > 1) {
      divergentNormalClusters++;
      divergentNormalVertices += vertices.length;
    }
  }
  return {
    normalized,
    nonUnit,
    duplicatePositionGroups: duplicatePositionClusters > 0 ? 1 : 0,
    duplicatePositionClusters,
    duplicatePositionVertices,
    divergentNormalGroups: divergentNormalClusters > 0 ? 1 : 0,
    divergentNormalClusters,
    divergentNormalVertices,
  };
}

function parseGroup(data, path) {
  const top = chunkMap(data, path, new Set(["MOGP"]));
  const mogp = top.get("MOGP");
  if (!mogp || mogp.length < MOGP_HEADER_SIZE) throw new Error("missing or short MOGP");
  const nested = chunkMap(mogp.subarray(MOGP_HEADER_SIZE), `${path}/MOGP`,
    new Set(["MOVT", "MONR", "MOVI"]));
  const positions = nested.get("MOVT");
  const normals = nested.get("MONR");
  const indices = nested.get("MOVI");
  let vertexCount = 0;
  let geometryValid = true;
  let nonFinitePositions = 0;
  let indexCount = 0;
  if (!positions || positions.length % VECTOR_STRIDE !== 0) geometryValid = false;
  else {
    vertexCount = positions.length / VECTOR_STRIDE;
    nonFinitePositions = finitePositionStats(positions, vertexCount).nonFinite;
    if (nonFinitePositions > 0) geometryValid = false;
  }
  if (!indices || indices.length % 6 !== 0) geometryValid = false;
  else {
    indexCount = indices.length / 2;
    if (vertexCount === 0) geometryValid = false;
    else {
      for (let offset = 0; offset < indices.length; offset += 2) {
        if (indices.readUInt16LE(offset) >= vertexCount) {
          geometryValid = false;
          break;
        }
      }
    }
  }

  let monrStatus = "missing";
  let normalsStats = {
    normalized: 0,
    nonUnit: 0,
    duplicatePositionGroups: 0,
    duplicatePositionClusters: 0,
    duplicatePositionVertices: 0,
    divergentNormalGroups: 0,
    divergentNormalClusters: 0,
    divergentNormalVertices: 0,
  };
  if (normals) {
    if (!positions || positions.length % VECTOR_STRIDE !== 0 || normals.length !== vertexCount * VECTOR_STRIDE) {
      monrStatus = "malformed";
    } else {
      let nonFiniteNormals = 0;
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        const normal = normalKey(normals, vertex);
        for (const value of normal) if (!Number.isFinite(value)) nonFiniteNormals++;
      }
      if (nonFiniteNormals > 0) monrStatus = "nonfinite";
      else {
        monrStatus = "exact";
        if (nonFinitePositions === 0) normalsStats = normalStats(positions, normals, vertexCount);
      }
    }
  }
  return {
    vertexCount,
    indexCount,
    geometryValid,
    monrStatus,
    nonFinitePositions,
    ...normalsStats,
    valid: geometryValid && monrStatus === "exact",
  };
}

function groupDigest(rows) {
  return sha1(rows.map((row) => [
    row.path,
    row.read ? 1 : 0,
    row.valid ? 1 : 0,
    row.geometryValid ? 1 : 0,
    row.vertexCount,
    row.indexCount,
    row.monrStatus,
    row.normalized,
    row.nonUnit,
    row.duplicatePositionGroups,
    row.duplicatePositionClusters,
    row.duplicatePositionVertices,
    row.divergentNormalGroups,
    row.divergentNormalClusters,
    row.divergentNormalVertices,
    row.nonFinitePositions,
    row.error ?? "",
  ].join("\t")).join("\n"));
}

/**
 * Audit nested MOGP/MOVT/MONR/MOVI in WMO group files.
 *
 * `archives` is borrowed and never closed.  The archive is listed once with an empty prefix, then
 * canonical `*_###.wmo` paths under `prefix` are selected and sorted locally.
 */
export async function auditWmoMonr({
  archives: injectedArchives,
  prefix: requestedPrefix = DEFAULT_PREFIX,
} = {}) {
  const archives = injectedArchives
    ? await (typeof injectedArchives === "function" ? injectedArchives() : injectedArchives)
    : clientArchives(clientDirectory());
  if (!archives || typeof archives.list !== "function" || typeof archives.read !== "function") {
    throw new TypeError("archives must provide list(prefix) and read(path)");
  }
  const prefix = canonicalPrefix(requestedPrefix);
  const listedPaths = new Map();
  for (const value of await archives.list("")) {
    const canonical = canonicalPath(value);
    if (!canonical) continue;
    const display = String(value).replaceAll("/", "\\");
    const previous = listedPaths.get(canonical);
    if (previous === undefined || display < previous) listedPaths.set(canonical, display);
  }
  const groupPaths = [...listedPaths.keys()]
    .filter((path) => path.startsWith(prefix) && GROUP_SUFFIX.test(path))
    .sort(compare);
  const rows = [];
  const parseErrors = [];
  let readMissing = 0;
  for (const path of groupPaths) {
    const readPath = listedPaths.get(path) ?? path;
    let data;
    try {
      data = await archives.read(readPath);
    } catch (error) {
      parseErrors.push({ path, error: serialiseError(error) });
    }
    if (!data) {
      readMissing++;
      rows.push({
        path, read: false, valid: false, geometryValid: false, vertexCount: 0, indexCount: 0,
        monrStatus: "unread", normalized: 0, nonUnit: 0, duplicatePositionGroups: 0,
        duplicatePositionClusters: 0, duplicatePositionVertices: 0, divergentNormalGroups: 0,
        divergentNormalClusters: 0, divergentNormalVertices: 0,
        nonFinitePositions: 0,
      });
      continue;
    }
    try {
      rows.push({ path, read: true, ...parseGroup(data, path) });
    } catch (error) {
      const message = serialiseError(error);
      parseErrors.push({ path, error: message });
      rows.push({
        path, read: true, valid: false, geometryValid: false, vertexCount: 0, indexCount: 0,
        monrStatus: "parse-error", normalized: 0, nonUnit: 0, duplicatePositionGroups: 0,
        duplicatePositionClusters: 0, duplicatePositionVertices: 0, divergentNormalGroups: 0,
        divergentNormalClusters: 0, divergentNormalVertices: 0,
        nonFinitePositions: 0, error: message,
      });
    }
  }
  parseErrors.sort((left, right) => compare(left.path, right.path) || compare(left.error, right.error));
  const aggregate = {
    listedGroups: groupPaths.length,
    readGroups: rows.filter((row) => row.read).length,
    validGroups: rows.filter((row) => row.valid).length,
    geometryValidGroups: rows.filter((row) => row.geometryValid).length,
    vertexTotal: rows.reduce((sum, row) => sum + row.vertexCount, 0),
    indexTotal: rows.reduce((sum, row) => sum + row.indexCount, 0),
    monrMissing: rows.filter((row) => row.monrStatus === "missing").length,
    monrExact: rows.filter((row) => row.monrStatus === "exact").length,
    monrMalformed: rows.filter((row) => row.monrStatus === "malformed").length,
    monrNonfinite: rows.filter((row) => row.monrStatus === "nonfinite").length,
    monrParseError: rows.filter((row) => row.monrStatus === "parse-error").length,
    monrUnread: rows.filter((row) => row.monrStatus === "unread").length,
    normalizedNormals: rows.reduce((sum, row) => sum + row.normalized, 0),
    nonUnitNormals: rows.reduce((sum, row) => sum + row.nonUnit, 0),
    duplicatePositionGroups: rows.reduce((sum, row) => sum + row.duplicatePositionGroups, 0),
    duplicatePositionClusters: rows.reduce((sum, row) => sum + row.duplicatePositionClusters, 0),
    duplicatePositionVertices: rows.reduce((sum, row) => sum + row.duplicatePositionVertices, 0),
    divergentNormalGroups: rows.reduce((sum, row) => sum + row.divergentNormalGroups, 0),
    divergentNormalClusters: rows.reduce((sum, row) => sum + row.divergentNormalClusters, 0),
    divergentNormalVertices: rows.reduce((sum, row) => sum + row.divergentNormalVertices, 0),
  };
  const digest = groupDigest(rows);
  return {
    schemaVersion: "r5.1/1",
    prefix,
    requestedPrefix: displayPrefix(requestedPrefix),
    digest,
    populationDigest: digest,
    counts: aggregate,
    aggregate,
    groups: rows,
    diagnostics: { readMissing, parseErrorCount: parseErrors.length, parseErrors },
  };
}

function parseArguments(argv) {
  const options = { client: undefined, prefix: DEFAULT_PREFIX, json: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--client") options.client = argv[++index];
    else if (argument === "--prefix") options.prefix = argv[++index] ?? options.prefix;
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
  }
  return options;
}

function humanSummary(summary) {
  const { counts, diagnostics } = summary;
  return [
    "WMO MONR group audit (read-only)",
    `scope: ${summary.prefix || "<all>"}`,
    `groups: listed ${counts.listedGroups}, read ${counts.readGroups}, geometry-valid ${counts.geometryValidGroups}, strict-valid ${counts.validGroups}`,
    `vertices/indices: ${counts.vertexTotal}/${counts.indexTotal}`,
    `MONR: missing ${counts.monrMissing}, exact ${counts.monrExact}, malformed ${counts.monrMalformed}, nonfinite ${counts.monrNonfinite}, parse-error ${counts.monrParseError}, unread ${counts.monrUnread}`,
    `normals: normalized ${counts.normalizedNormals}, non-unit ${counts.nonUnitNormals}`,
    `hard-edge evidence: duplicate-position groups ${counts.duplicatePositionGroups}, divergent-normal groups ${counts.divergentNormalGroups}`,
    `diagnostics: missing reads ${diagnostics.readMissing}, parse errors ${diagnostics.parseErrorCount}`,
    `digest: ${summary.digest}`,
  ].join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node tools/audit-wmo-monr.mjs [--client <client-dir>] [--prefix <asset-prefix>] [--json]");
    return;
  }
  const summary = await auditWmoMonr({
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
    console.error(`WMO MONR audit failed: ${serialiseError(error)}`);
    process.exitCode = 1;
  }
}
