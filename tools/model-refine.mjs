// 04.11 (7.62): what a refined copy of a model is, the one recipe `generate-visual-model.mjs` publishes under a refined
// name (tools/visual-model-key.mjs) and `tools/polish-models.mjs` builds. The passes themselves are tools/model-polish.mjs.
//
// - Rounder silhouettes on everything but what is dense already.
// - Relief on stone alone: on a barrel the iron band wobbles even at gain 0.4 (docs/implementation/model-polish.ru.md).
// - Baked occlusion last, so it sees the surface that is finally drawn. A unit's geosets are chosen per appearance, so
//   only what it always wears may darken it, and no ground: it does not stand still on one.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { textureId } from "./generate-texture.mjs";
import { bakeVertexAo, displaceByHeight, smoothModel } from "./model-polish.mjs";
import { repositoryRoot } from "./paths.mjs";
import { isUnitModelPath } from "./visual-model-key.mjs";

/** Past this a model has the triangles a curve needs: the HD creatures of the patches go up to 21,766. */
export const SMOOTH_TRIANGLE_LIMIT = 8000;

/** A rock, a cliff or a boulder by its path; not a rocket, a crock or Brockton. */
export function isStoneModelPath(modelPath) {
  return /^world[\\/]/i.test(modelPath) && /(?<![bc])rock(?!et)|cliff|boulder/i.test(modelPath);
}

const maps = new Map();

/** The DeepBump map of a texture, by the SHA-1 of the PNG `/texture` serves, as the gateway finds it; or nothing. */
function heightMapOf(slot) {
  const key = slot.filename.toLowerCase();
  if (!maps.has(key)) {
    let map;
    const directory = resolve(repositoryRoot, process.env.TEXTURE_DIR ?? "data/textures");
    const png = join(directory, `${textureId(slot.filename)}.png`);
    if (existsSync(png)) {
      const digest = createHash("sha1").update(readFileSync(png)).digest("hex");
      const file = join(resolve(repositoryRoot, process.env.NEURAL_RELIEF_DIR ?? ".runtime/neural-relief"), "content", `${digest}.bin`);
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
    maps.set(key, map);
  }
  const map = maps.get(key);
  return map && { ...map, wrapX: (slot.flags & 1) !== 0, wrapY: (slot.flags & 2) !== 0 };
}

/** The height map of a submesh: its first batch whose own texture has one. */
export function submeshHeightMap(model, submesh) {
  for (const batch of model.batches) {
    if (batch.submesh !== submesh) continue;
    const slot = model.textures[batch.textures[0]];
    if (slot?.type === 0 && slot.filename) {
      const map = heightMapOf(slot);
      if (map) return map;
    }
  }
  return undefined;
}

/** The occlusion pass as a unit or a doodad takes it. */
export function bakeForPath(model, modelPath) {
  const unit = isUnitModelPath(modelPath);
  return bakeVertexAo(model, {
    ground: !unit,
    occluder: unit ? (submesh) => submesh.geosetId === 0 || submesh.geosetId % 100 === 1 : undefined,
  });
}

/** The refined copy of one parsed model. A model with nothing to draw is handed back as it came. */
export function refineModel(model, modelPath) {
  if (model.indices.length === 0) return model;
  let current = model.indices.length / 3 > SMOOTH_TRIANGLE_LIMIT ? model : smoothModel(model);
  if (isStoneModelPath(modelPath)) {
    const smoothed = current;
    current = displaceByHeight(smoothed, (submesh) => submeshHeightMap(smoothed, submesh));
  }
  return bakeForPath(current, modelPath);
}
