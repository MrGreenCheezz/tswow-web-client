import { openDbcFile } from "./Dbc.js";

/**
 * Where the client keeps its ground-cover models. The table stores a bare filename — 0 of the 567
 * distinct names in `GroundEffectDoodad` carries a directory separator — and the extension it
 * stores is the client's `.mdl`/`.mdx` rather than the `.m2` that is on disk.
 */
const GROUND_DOODAD_DIRECTORY = "World\\NoDXT\\Detail\\";

/** One `GroundEffectTexture` row, as the browser needs it. */
export interface GroundEffect {
  /** How many doodads a growing cell gets. See the density note in `src/browser/GroundCover.ts`. */
  density: number;
  /**
   * `TerrainType.ID`: what a footstep on this ground sounds like.
   *
   * Nothing draws it. It is here because it is the field footstep sounds were waiting on — the
   * chain `CreatureSoundData.SoundFootstepID → FootstepTerrainLookup → TerrainType` was resolvable
   * offline and the terrain under the foot was not, because it lives here and the tile never
   * published the layer's effect id. It does now, so publishing this costs ten bytes a row and
   * saves that slice a second route.
   */
  terrain: number;
  /** Model index into `models` and the weight it is drawn in; empty slots are dropped. */
  doodads: Array<[model: number, weight: number]>;
}

export interface GroundEffectTable {
  /** Every model any published row names, as a full archive path. */
  models: string[];
  effects: Record<number, GroundEffect>;
}

/**
 * The rows that grow something, and the models they name.
 *
 * `GroundEffectTexture` is 24,981 rows on this dataset and only **892 of them (3.6%) carry a
 * doodad at all** — the other 24,089 are pure footstep-terrain mappings — so the published table
 * is the 892, at 74,295 bytes of JSON once the 485 model names are shared instead of repeated.
 * The browser asks for it once a session.
 *
 * Read out of `dbcDirectory()` and not out of the archives, which is the rule every other table
 * the gateway serves follows: a module that adds a ground effect writes the dataset, and
 * `check-shadowed-tables.mjs` is what warns when a patch archive shadows a built table.
 */
export async function loadGroundEffects(dbcDirectory: string): Promise<GroundEffectTable> {
  const textures = await openDbcFile(dbcDirectory, "GroundEffectTexture");
  const doodads = await openDbcFile(dbcDirectory, "GroundEffectDoodad");

  const paths = new Map<number, string>();
  for (const row of doodads.rows()) {
    const name = doodads.string(row, "Doodadpath");
    if (!name) continue;
    paths.set(doodads.id(row), `${GROUND_DOODAD_DIRECTORY}${name.replace(/\.(mdl|mdx)$/i, ".m2")}`);
  }

  const models: string[] = [];
  const modelIndex = new Map<string, number>();
  const effects: Record<number, GroundEffect> = {};
  for (const row of textures.rows()) {
    const id = textures.id(row);
    if (id <= 0) continue;
    const slots: Array<[number, number]> = [];
    for (let slot = 0; slot < 4; slot++) {
      const doodad = textures.int(row, "DoodadID", slot);
      if (doodad <= 0) continue;
      const path = paths.get(doodad);
      if (!path) continue;
      let index = modelIndex.get(path);
      if (index === undefined) {
        index = models.length;
        models.push(path);
        modelIndex.set(path, index);
      }
      slots.push([index, textures.int(row, "DoodadWeight", slot)]);
    }
    if (slots.length === 0) continue;
    effects[id] = { density: textures.int(row, "Density"), terrain: textures.int(row, "Sound"), doodads: slots };
  }
  return { models, effects };
}
