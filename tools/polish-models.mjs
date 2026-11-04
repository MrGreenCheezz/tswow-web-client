#!/usr/bin/env node
// 04.11 (the owner's pilot): publishes refined copies of M2 models beside each other, for stills and for numbers.
//
//   node tools/polish-models.mjs --out .runtime/model-polish/smooth --steps smooth,ao --model "World\...\Barrel01.m2"
//   node tools/polish-models.mjs --out .runtime/model-polish/full --steps smooth,relief,ao --tile 0/48-32
//
// Writes `<out>/<visualModelHash(path)>.bin` (what `bench/lookdev.mjs --model-variants <out>` answers
// `/visual/model` from) and `<out>/report.json`. Steps run in the order smooth, relief, ao whatever the spelling:
// occlusion is the last, so it sees the surface that is finally drawn. Nothing the gateway serves is touched but the
// shared texture cache, which publishing a model fills as it always does. `--tile <map>/<x>-<y>` takes every M2 a
// visual tile places.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { constants, setPriority } from "node:os";
import "./env.mjs";
import { bakeVertexAo, displaceByHeight, smoothModel, submeshKinds } from "./model-polish.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, repositoryRoot } from "./paths.mjs";
import { isUnitModelPath, visualModelHash } from "./visual-model-key.mjs";

const args = process.argv.slice(2);
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const values = (name) => args.flatMap((arg, index) => (arg === name ? [args[index + 1]] : []));

const out = resolve(value("--out", ".runtime/model-polish/pilot"));
const steps = new Set(value("--steps", "smooth,ao").split(","));
// `--relief-gain 0.4` scales the depth; `--relief-only rock,cliff` keeps relief to paths holding one of those words.
const reliefGain = Number(value("--relief-gain", 1));
const reliefOnly = value("--relief-only")?.toLowerCase().split(",");
process.env.VISUAL_MODEL_DIR = out;
mkdirSync(out, { recursive: true });
try {
  setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  // Not allowed here: it runs at the normal priority.
}

const { publishVisualModel } = await import("./generate-visual-model.mjs");
const { textureId } = await import("./generate-texture.mjs");

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
if (paths.size === 0) throw new Error("Nothing to do: --model <path> or --tile <map>/<x>-<y>");

const neuralDirectory = resolve(process.env.NEURAL_RELIEF_DIR ?? join(repositoryRoot, ".runtime", "neural-relief"), "content");
const textureDirectory = resolve(repositoryRoot, process.env.TEXTURE_DIR ?? "data/textures");
const heightCache = new Map();

/** The DeepBump map of a texture: by the SHA-1 of the PNG `/texture` serves, as the gateway finds it. */
function heightMapOf(texturePath, flags) {
  const key = texturePath.toLowerCase();
  if (!heightCache.has(key)) {
    let map;
    const png = join(textureDirectory, `${textureId(texturePath)}.png`);
    if (existsSync(png)) {
      const digest = createHash("sha1").update(readFileSync(png)).digest("hex");
      const file = join(neuralDirectory, `${digest}.bin`);
      if (existsSync(file)) {
        const bytes = readFileSync(file);
        if (bytes.toString("latin1", 0, 4) === "NRH1") {
          const width = bytes.readUInt16LE(4);
          const height = bytes.readUInt16LE(6);
          const data = new Int16Array(width * height);
          for (let at = 0; at < data.length; at++) data[at] = bytes.readInt16LE(8 + at * 2);
          map = { width, height, data };
        }
      }
    }
    heightCache.set(key, map);
  }
  const map = heightCache.get(key);
  return map && { ...map, wrapX: (flags & 1) !== 0, wrapY: (flags & 2) !== 0 };
}

const archives = await clientArchives(clientDirectory());
const rows = [];
let failed = 0;
const started = Date.now();
for (const path of [...paths.values()].sort()) {
  const hash = visualModelHash(path);
  const row = { path };
  const at = Date.now();
  try {
    await publishVisualModel(path, hash, archives, {
      transformModel: (model, modelPath) => {
        row.trianglesBefore = model.indices.length / 3;
        row.verticesBefore = model.positions.length / 3;
        row.solidSubmeshes = [...submeshKinds(model)].filter((kind) => kind === 2).length;
        row.submeshes = model.submeshes.length;
        let current = model;
        if (steps.has("smooth")) current = smoothModel(current);
        row.trianglesSmooth = current.indices.length / 3;
        if (steps.has("relief") && (!reliefOnly || reliefOnly.some((word) => modelPath.toLowerCase().includes(word)))) {
          current = displaceByHeight(current, (submesh) => {
            for (const batch of current.batches) {
              if (batch.submesh !== submesh) continue;
              const slot = current.textures[batch.textures[0]];
              if (slot?.type === 0 && slot.filename) {
                const map = heightMapOf(slot.filename, slot.flags);
                if (map) return map;
              }
            }
            return undefined;
          }, { gain: reliefGain });
          row.displacedVertices = current.displacedVertices ?? 0;
        }
        if (steps.has("ao")) {
          // A unit's geosets are chosen per appearance: only what it always wears may darken it.
          const unit = isUnitModelPath(modelPath);
          current = bakeVertexAo(current, {
            ground: !unit,
            occluder: unit ? (submesh) => submesh.geosetId === 0 || submesh.geosetId % 100 === 1 : undefined,
          });
          row.ao = current.aoStats;
        }
        row.trianglesAfter = current.indices.length / 3;
        row.verticesAfter = current.positions.length / 3;
        return current;
      },
    });
    row.ms = Date.now() - at;
    row.bytes = statSync(join(out, `${hash}.bin`)).size;
  } catch (error) {
    failed++;
    row.error = error instanceof Error ? error.message : String(error);
  }
  rows.push(row);
}
const sum = (name) => rows.reduce((total, row) => total + (row[name] ?? 0), 0);
const summary = {
  steps: [...steps], models: rows.length, failed, seconds: Math.round((Date.now() - started) / 1000),
  trianglesBefore: sum("trianglesBefore"), trianglesAfter: sum("trianglesAfter"),
  verticesBefore: sum("verticesBefore"), verticesAfter: sum("verticesAfter"), bytes: sum("bytes"),
};
writeFileSync(join(out, "report.json"), JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary));
archives.close();
process.exit(failed > 0 ? 1 : 0);
