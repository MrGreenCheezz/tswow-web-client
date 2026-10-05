// Which jobs the persistent generator worker can run, and which worker each belongs to (10.20,
// mechanism М-A10-1).
//
// One table instead of a `switch` per family in `tools/asset-worker.mjs`, a copy in a preloader and
// another in the tests. Each entry names:
//
// - `family` — the worker it runs in, by job length: `texture` for the short ones (a picture, an
//   icon, an index, a text file: tens of milliseconds out of an open chain), `model` for models
//   (M2 9–25 ms, a city WMO up to 0.9 s), `tile` for the long processor-bound ones (a ground splat
//   or a visual tile, 0.65–1.3 s as a process). Inside a worker jobs run one at a time in the order
//   the gateway hands them over, so a long job in the same process as a short one would make the
//   short one wait; the gateway also keeps each worker's queue ordered by priority
//   (`src/gateway/AssetWorker.ts`).
// - `load` — the generator module, imported the first time a job of that kind arrives, so a worker
//   only ever loads what it has been given (the tile generators pull in `three`).
// - `run(module, job, archives)` — the publish call with the chain the worker holds open.
//
// `AssetWorkerJob` in `src/gateway/AssetWorker.ts` is the gateway's spelling of the same list;
// `tests/asset-jobs.test.mjs` keeps the two equal.

import { SourceMissing } from "./source-missing.mjs";

/** Map.dbc's directory for `map`, as the command-line generators resolve it. */
async function mapDirectory(map) {
  const [{ internalMapName }, { dbcDirectory }] = await Promise.all([
    import("./map-directory.mjs"), import("./paths.mjs"),
  ]);
  return internalMapName(dbcDirectory(), map);
}

/** The minimap translation table of one open chain: read once per chain, not once per map. */
const minimapIndexes = new WeakMap();

export const ASSET_JOBS = Object.freeze({
  texture: {
    family: "texture",
    load: () => import("./generate-texture.mjs"),
    run: (module, job, archives) => module.publishTexture(String(job.path).replaceAll("/", "\\"), archives),
  },
  "visual-model": {
    family: "model",
    load: () => import("./generate-visual-model.mjs"),
    run: (module, job, archives) => module.publishVisualModel(String(job.path), String(job.hash), archives),
  },
  "item-icon": {
    family: "texture",
    load: () => import("./generate-item-icon.mjs"),
    run: (module, job, archives) => module.publishItemIcon(Number(job.displayId), archives),
  },
  "spell-icon": {
    family: "texture",
    load: () => import("./generate-spell-icons.mjs"),
    run: (module, job, archives) => module.publishSpellIcon(Number(job.iconId), archives),
  },
  "creature-icon": {
    family: "texture",
    load: () => import("./generate-spell-icons.mjs"),
    run: (module, job, archives) => module.publishCreatureIcon(Number(job.familyId), archives),
  },
  "minimap-index": {
    family: "texture",
    load: async () => ({ ...(await import("./generate-minimap-index.mjs")), ...(await import("./minimap-index.mjs")) }),
    run: async (module, job, archives) => {
      const map = Number(job.map);
      const directory = await mapDirectory(map);
      // The command line's own words and kind of failure (a plain error, not "missing").
      if (!directory) throw new Error(`Map.dbc has no map ${map}`);
      let index = minimapIndexes.get(archives);
      if (!index) {
        index = await module.loadMinimapIndex(archives);
        minimapIndexes.set(archives, index);
      }
      return module.publishMinimapIndex(map, directory, index, archives);
    },
  },
  "zone-map": {
    family: "texture",
    load: () => import("./generate-worldmap-zone-map.mjs"),
    run: async (module, job, archives) => {
      const map = Number(job.map);
      const directory = await mapDirectory(map);
      // The command line throws this before its try, so it leaves as a crash and not as exit 3:
      // kept a plain error here so the route answers exactly as it did.
      if (!directory) throw new Error(`Map.dbc has no map ${map}`);
      return module.publishWorldMapZoneMap(map, directory, archives);
    },
  },
  liquid: {
    family: "texture",
    load: () => import("./generate-liquid-texture.mjs"),
    run: (module, job, archives) => module.publishLiquidTexture(String(job.liquidClass), archives),
  },
  // 05.10-A7b-8 (7.09 A): one LiquidType texture family's strip (`family/<slug>`), a new kind so an
  // older gateway's `liquid` jobs keep their exact bytes.
  "liquid-family": {
    family: "texture",
    load: () => import("./generate-liquid-texture.mjs"),
    run: (module, job, archives) => module.publishLiquidFamily(String(job.family), archives),
  },
  "client-file": {
    family: "texture",
    load: () => import("./generate-client-file.mjs"),
    run: (module, job, archives) => module.publishClientFile(String(job.path), archives),
  },
  "terrain-splat": {
    family: "tile",
    load: () => import("./generate-terrain-splat.mjs"),
    // 05.10-A7b-7: the splat generation the gateway serves; a job without one comes from an older gateway.
    run: (module, job, archives) => module.publishTerrainSplat(Number(job.map), Number(job.gridX), Number(job.gridY), archives,
      job.generation === undefined ? undefined : { generation: String(job.generation) }),
  },
  "visual-tile": {
    family: "tile",
    load: () => import("./generate-visual-tile.mjs"),
    // 05.10-A7b-1: the generation the gateway serves; a job without one comes from a gateway still on v4.
    run: (module, job, archives) => module.publishVisualTile(Number(job.map), Number(job.gridX), Number(job.gridY), archives,
      job.generation === undefined ? undefined : { generation: String(job.generation) }),
  },
  // 10.22: the models one published visual tile places, for the preloader (`tools/tile-models.mjs`).
  // Reads the tile file only — `archives: false` — and answers the list (`result: true`: the worker
  // sends what `run` returned back as `result`). Runs in the visual-tile worker (`AssetWorkers.ts`).
  "tile-models": {
    family: "tile",
    archives: false,
    result: true,
    load: () => import("./tile-models.mjs"),
    run: async (module, job) => (await module.publishTileModels(Number(job.map), Number(job.gridX), Number(job.gridY))) ?? null,
  },
  horizon: {
    family: "tile",
    load: () => import("./generate-horizon.mjs"),
    run: (module, job, archives) => module.publishHorizon(Number(job.map), archives),
  },
  // 05.10-A7b-7 (7.08): the horizon's colour, averaged out of the map's minimap bakes.
  "horizon-colour": {
    family: "tile",
    load: () => import("./generate-horizon-colour.mjs"),
    run: (module, job, archives) => module.publishHorizonColour(Number(job.map), archives),
  },
});

/** The families a worker can be started for. */
export const ASSET_FAMILIES = Object.freeze(["texture", "model", "tile"]);

/** The generator modules already loaded in this process, by kind. */
const loaded = new Map();

/** Runs one job against `archives`; an unknown kind is an error, not a silent no-op. */
export async function runAssetJob(job, archives) {
  const kind = job?.kind;
  const entry = Object.hasOwn(ASSET_JOBS, kind) ? ASSET_JOBS[kind] : undefined;
  if (!entry) throw new Error(`Unknown asset job ${String(kind)}`);
  let module = loaded.get(kind);
  if (!module) {
    module = await entry.load();
    loaded.set(kind, module);
  }
  return entry.run(module, job, archives);
}

/** The registry entry of a job, or undefined for an unknown kind. */
export function assetJobEntry(job) {
  const kind = job?.kind;
  return Object.hasOwn(ASSET_JOBS, kind) ? ASSET_JOBS[kind] : undefined;
}

/** Whether `error` is "the archives do not hold this" (the gateway's 404, not its 500). */
export function isSourceMissing(error) {
  return error instanceof SourceMissing;
}
