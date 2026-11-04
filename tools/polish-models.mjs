#!/usr/bin/env node
// 04.11 (7.62): refined copies of M2 models.
//
//   node tools/polish-models.mjs --all [--limit N]
//       every world doodad and creature, published under its refined name into VISUAL_MODEL_DIR (default
//       data/visual-models), ahead of the gateway's first request; a copy already there is left as it is.
//   node tools/polish-models.mjs --out <dir> --steps smooth,relief,ao --model "World\...\Barrel01.m2" --tile 0/48-32
//       a trial: one pass or another into a folder of their own, under the plain names, which
//       `bench/lookdev.mjs --model-variants <dir>` answers `/visual/model` from.
//
// `<dir>/report.json` says what happened to each model. Below normal priority: the owner may be playing here.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { constants, setPriority } from "node:os";
import "./env.mjs";
import { displaceByHeight, smoothModel, submeshKinds } from "./model-polish.mjs";
import { bakeForPath, submeshHeightMap } from "./model-refine.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, repositoryRoot } from "./paths.mjs";
import { isRefinedModelPath, refinedModelHash, visualModelHash } from "./visual-model-key.mjs";

const args = process.argv.slice(2);
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const values = (name) => args.flatMap((arg, index) => (arg === name ? [args[index + 1]] : []));

const all = args.includes("--all");
const out = resolve(repositoryRoot, value("--out", all ? process.env.VISUAL_MODEL_DIR ?? "data/visual-models" : ".runtime/model-polish/pilot"));
const steps = new Set(value("--steps", "smooth,ao").split(","));
// `--relief-gain 0.4` scales the depth; `--relief-only rock,cliff` keeps relief to paths holding one of those words.
const reliefGain = Number(value("--relief-gain", 1));
const reliefOnly = value("--relief-only")?.toLowerCase().split(",");
const limit = Number(value("--limit", Infinity));
process.env.VISUAL_MODEL_DIR = out;
mkdirSync(out, { recursive: true });
try {
  setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  // Not allowed here: it runs at the normal priority.
}

const { publishVisualModel } = await import("./generate-visual-model.mjs");
const archives = await clientArchives(clientDirectory());

const paths = new Map();
const addPath = (path) => {
  const key = path.replaceAll("/", "\\").toLowerCase();
  if (!paths.has(key)) paths.set(key, path.replaceAll("/", "\\"));
};
for (const path of values("--model")) addPath(path);
for (const tile of values("--tile")) {
  const [map, cell] = tile.split("/");
  const names = JSON.parse(readFileSync(join(repositoryRoot, "data", "visual-tiles", map, `${cell}.models.json`), "utf8"));
  for (const name of names) if (/\.m2$/i.test(name)) addPath(name);
}
if (all) {
  for (const prefix of ["world\\", "creature\\"]) {
    for (const path of await archives.list(prefix)) if (isRefinedModelPath(path)) addPath(path);
  }
}
if (paths.size === 0) throw new Error("Nothing to do: --all, --model <path> or --tile <map>/<x>-<y>");

/** A trial's passes, each one asked for by name. */
function trial(row) {
  return (model, modelPath) => {
    row.trianglesBefore = model.indices.length / 3;
    row.verticesBefore = model.positions.length / 3;
    row.solidSubmeshes = [...submeshKinds(model)].filter((kind) => kind === 2).length;
    row.submeshes = model.submeshes.length;
    let current = model;
    if (steps.has("smooth")) current = smoothModel(current);
    row.trianglesSmooth = current.indices.length / 3;
    if (steps.has("relief") && (!reliefOnly || reliefOnly.some((word) => modelPath.toLowerCase().includes(word)))) {
      const smoothed = current;
      current = displaceByHeight(smoothed, (submesh) => submeshHeightMap(smoothed, submesh), { gain: reliefGain });
      row.displacedVertices = current.displacedVertices ?? 0;
    }
    if (steps.has("ao")) {
      current = bakeForPath(current, modelPath);
      row.ao = current.aoStats;
    }
    row.trianglesAfter = current.indices.length / 3;
    row.verticesAfter = current.positions.length / 3;
    return current;
  };
}

const rows = [];
let failed = 0;
let skipped = 0;
const started = Date.now();
const chosen = [...paths.values()].sort().slice(0, limit);
for (const [index, path] of chosen.entries()) {
  const hash = all ? refinedModelHash(path) : visualModelHash(path);
  const file = join(out, `${hash}.bin`);
  // A copy with a stamp is left as it is: the gateway compares the stamp and builds a stale one again by itself.
  if (all && existsSync(file) && existsSync(`${file}.src`)) {
    skipped++;
    continue;
  }
  const row = { path };
  const at = Date.now();
  try {
    await publishVisualModel(path, hash, archives, all ? {} : { transformModel: trial(row) });
    row.ms = Date.now() - at;
    row.bytes = statSync(file).size;
  } catch (error) {
    failed++;
    row.error = error instanceof Error ? error.message : String(error);
  }
  rows.push(row);
  if (all && (index + 1) % 500 === 0) console.error(`${index + 1}/${chosen.length}, ${Math.round((Date.now() - started) / 1000)} s`);
}
const sum = (name) => rows.reduce((total, row) => total + (row[name] ?? 0), 0);
const summary = {
  steps: all ? ["refined"] : [...steps], models: rows.length, skipped, failed, seconds: Math.round((Date.now() - started) / 1000),
  trianglesBefore: sum("trianglesBefore"), trianglesAfter: sum("trianglesAfter"),
  verticesBefore: sum("verticesBefore"), verticesAfter: sum("verticesAfter"), bytes: sum("bytes"),
};
writeFileSync(join(all ? resolve(repositoryRoot, ".runtime") : out, all ? "refined-models-report.json" : "report.json"), JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary));
archives.close();
process.exit(failed > 0 ? 1 : 0);
