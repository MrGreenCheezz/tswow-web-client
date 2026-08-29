// Read-only direct-MDDF placement inventory for R4.0c.
//
// A direct ADT MDDF record is an exterior terrain placement in the visual-tile contract.  This
// scanner deliberately does not inspect M2 bones, animation tracks, particles, or ribbons: its
// `staticModel: true` means only that the placement is static metadata (position/rotation/scale),
// not that the referenced model is safe for static geometry simplification.  R4.0b owns that
// second, model-content eligibility decision.

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseAdtPlacements } from "./adt-placements.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";

function canonicalPath(value) {
  if (typeof value !== "string") return undefined;
  const path = value.replaceAll("/", "\\").replace(/^\\+/, "").toLowerCase();
  return path.length > 0 ? path : undefined;
}

function normalisePrefix(value) {
  const path = canonicalPath(value ?? "World\\Maps\\");
  if (!path) return "";
  return path.endsWith("\\") ? path : `${path}\\`;
}

function displayPrefix(value) {
  const path = String(value ?? "World\\Maps\\").replaceAll("/", "\\");
  return path.length === 0 || path.endsWith("\\") ? path : `${path}\\`;
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

function mapNameOf(path, prefix) {
  const remainder = path.slice(prefix.length);
  const separator = remainder.indexOf("\\");
  return separator < 0 ? remainder : remainder.slice(0, separator);
}

function selectedMaps(mapNames) {
  if (mapNames === undefined || mapNames === null) return undefined;
  const values = Array.isArray(mapNames) ? mapNames : [mapNames];
  const result = new Set(values.map(canonicalPath).filter(Boolean));
  return result.size > 0 ? result : undefined;
}

function addModel(models, modelPath, tilePath) {
  let model = models.get(modelPath);
  if (!model) {
    model = {
      modelPath,
      kind: "m2",
      exterior: true,
      interior: false,
      // Static placement metadata, not static model-content eligibility. See module comment.
      staticModel: true,
      staticPlacement: true,
      source: "adt-mddf",
      directPlacementCount: 0,
      tileCount: 0,
      listedM2: false,
      listed00Skin: false,
      _lastTile: undefined,
    };
    models.set(modelPath, model);
  }
  model.directPlacementCount++;
  if (model._lastTile !== tilePath) {
    model.tileCount++;
    model._lastTile = tilePath;
  }
}

function finaliseModel(model, listed) {
  const listedM2 = listed.has(model.modelPath);
  const listed00Skin = listed.has(profilePath(model.modelPath));
  return {
    modelPath: model.modelPath,
    kind: model.kind,
    exterior: model.exterior,
    interior: model.interior,
    staticModel: model.staticModel,
    staticPlacement: model.staticPlacement,
    source: model.source,
    directPlacementCount: model.directPlacementCount,
    placementCount: model.directPlacementCount,
    tileCount: model.tileCount,
    listedM2,
    listed00Skin,
    failReasons: [
      ...(listedM2 ? [] : ["missingM2"]),
      ...(listed00Skin ? [] : ["missing00Skin"]),
    ],
  };
}

function diagnosticCounts({ readMissing, parseErrors, models }) {
  let missingM2 = 0;
  let missing00Skin = 0;
  for (const model of models) {
    if (!model.listedM2) missingM2++;
    if (!model.listed00Skin) missing00Skin++;
  }
  return {
    readMissing,
    parseErrorCount: parseErrors,
    missingM2,
    missing00Skin,
  };
}

/**
 * Scan direct terrain M2 placements in listed ADTs.
 *
 * `archives` is borrowed and never closed.  The scanner calls `list("")` exactly once because
 * StormLib archive search masks are not reliably case-insensitive for a non-empty prefix; filtering
 * is done after canonicalisation.  `mapNames` is an optional case-insensitive map-directory filter.
 */
export async function scanAdtM2Placements({
  archives: injectedArchives,
  prefix: requestedPrefix = "World\\Maps\\",
  mapNames,
} = {}) {
  const archives = injectedArchives
    ? await (typeof injectedArchives === "function" ? injectedArchives() : injectedArchives)
    : await clientArchives(clientDirectory());
  if (!archives || typeof archives.list !== "function" || typeof archives.read !== "function") {
    throw new TypeError("archives must provide list(prefix) and read(path)");
  }
  const prefix = normalisePrefix(requestedPrefix);
  const listedPaths = new Map();
  for (const value of await archives.list("")) {
    const canonical = canonicalPath(value);
    if (canonical) {
      const display = String(value).replaceAll("/", "\\");
      const previous = listedPaths.get(canonical);
      // Choose aliases by value, not listing order, so injected archives and merged MPQs have a
      // stable read path even when they expose the same canonical path with different spelling.
      if (previous === undefined || display < previous) listedPaths.set(canonical, display);
    }
  }
  const listed = new Set(listedPaths.keys());
  const maps = selectedMaps(mapNames);
  const adtPaths = [...listed]
    .filter((path) => path.startsWith(prefix) && path.endsWith(".adt"))
    .filter((path) => maps === undefined || maps.has(mapNameOf(path, prefix)))
    .sort();
  const models = new Map();
  const tilesWithM2 = new Set();
  const parseErrors = [];
  let readMissing = 0;
  let directM2Placements = 0;
  for (const adtPath of adtPaths) {
    const readPath = listedPaths.get(adtPath) ?? adtPath;
    const data = await archives.read(readPath);
    if (!data) {
      readMissing++;
      continue;
    }
    let objects;
    try {
      objects = parseAdtPlacements(data);
    } catch (error) {
      parseErrors.push({ path: adtPath, error: serialiseError(error) });
      continue;
    }
    let hasDirectM2 = false;
    for (const object of objects) {
      // MODF WMO roots are intentionally ignored. Their MODD children are interior and belong to
      // a separate expansion pass, exactly as generate-visual-tile.mjs handles them.
      if (object.kind !== "m2") continue;
      const modelPath = canonicalPath(object.name);
      if (!modelPath || !modelPath.endsWith(".m2")) continue;
      directM2Placements++;
      hasDirectM2 = true;
      addModel(models, modelPath, adtPath);
    }
    if (hasDirectM2) tilesWithM2.add(adtPath);
  }
  const modelEntries = [...models.values()]
    .sort((left, right) => left.modelPath < right.modelPath ? -1 : left.modelPath > right.modelPath ? 1 : 0)
    .map((model) => finaliseModel(model, listed));
  const modelPaths = modelEntries.map((model) => model.modelPath);
  const modelPathDigest = sha1(modelPaths.join("\n"));
  const populationDigest = sha1(modelEntries.map((model) => [
    model.modelPath,
    model.directPlacementCount,
    model.tileCount,
    model.listedM2 ? 1 : 0,
    model.listed00Skin ? 1 : 0,
  ].join("\t")).join("\n"));
  const tileDigest = sha1(adtPaths.join("\n"));
  const counts = {
    adtTiles: adtPaths.length,
    tilesWithDirectM2: tilesWithM2.size,
    directM2Placements,
    distinctDirectM2: modelEntries.length,
    listedM2: modelEntries.filter((model) => model.listedM2).length,
    listed00Skin: modelEntries.filter((model) => model.listed00Skin).length,
    placementReadyAssets: modelEntries.filter((model) => model.listedM2 && model.listed00Skin).length,
  };
  const diagnostics = diagnosticCounts({
    readMissing,
    parseErrors: parseErrors.length,
    models: modelEntries,
  });
  return {
    schemaVersion: "r4.0c/1",
    prefix,
    requestedPrefix: displayPrefix(requestedPrefix),
    mapNames: maps ? [...maps].sort() : undefined,
    population: {
      adtPaths: adtPaths.length,
      modelPaths: modelPaths.length,
      populationDigest,
      modelPathDigest,
      tileDigest,
      selectionDigest: populationDigest,
      selectedModelPaths: modelPaths,
    },
    populationDigest,
    digest: populationDigest,
    modelPathDigest,
    selectedModelPaths: modelPaths,
    placements: modelEntries,
    models: modelEntries,
    counts,
    diagnostics: {
      ...diagnostics,
      parseErrors,
    },
  };
}

function parseArguments(argv) {
  const options = { client: undefined, prefix: "World\\Maps\\", mapNames: [], json: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--client") options.client = argv[++index];
    else if (argument === "--prefix") options.prefix = argv[++index] ?? options.prefix;
    else if (argument === "--map") options.mapNames.push(argv[++index] ?? "");
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
  }
  if (options.mapNames.length === 0) delete options.mapNames;
  return options;
}

function humanSummary(summary) {
  const { counts, diagnostics } = summary;
  return [
    "ADT direct-MDDF exterior M2 placement audit (read-only)",
    `scope: ${summary.prefix || "<all>"}`,
    `tiles: ${counts.adtTiles}, with direct M2: ${counts.tilesWithDirectM2}`,
    `direct placements: ${counts.directM2Placements}, distinct M2: ${counts.distinctDirectM2}`,
    `listed M2/00.skin: ${counts.listedM2}/${counts.listed00Skin}`,
    `diagnostics: missing reads ${diagnostics.readMissing}, parse errors ${diagnostics.parseErrorCount}, missing assets ${diagnostics.missingM2}/${diagnostics.missing00Skin}`,
    `population digest: ${summary.populationDigest}`,
  ].join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node tools/audit-adt-m2-placements.mjs [--client <client-dir>] [--prefix <asset-prefix>] [--map <map-directory>] [--json]");
    return;
  }
  const summary = await scanAdtM2Placements({
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
    console.error(`ADT placement audit failed: ${serialiseError(error)}`);
    process.exitCode = 1;
  }
}
