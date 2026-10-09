import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { AssetWorker, type AssetWorkerJob } from "./AssetWorker.js";

/**
 * The persistent generator workers of one gateway, by family (10.20, М-A10-1).
 *
 * `tools/asset-jobs.mjs` says which family a job belongs to; this side decides which families get a
 * worker at all (`ASSET_WORKERS`) and keeps one `AssetWorker` per worker. A family without one goes
 * back to the one-process-per-miss generator, which is what `run` answering `undefined` tells the
 * caller.
 *
 * - `ASSET_WORKERS=0` — none: every miss is a process of its own, as before the workers existed.
 * - unset, empty or `1` — every family.
 * - a list (`texture,model`) — only those.
 *
 * The `tile` family is the one exception to "one worker per family": its jobs (a ground splat, a
 * visual tile, a horizon) took 0.65–1.3 s each as processes and ran beside each other, one process
 * per family lane. A single tile worker would queue a nearby tile's splat behind its own visual
 * tile, so each tile job kind gets a worker of its own and the three keep running side by side —
 * what is removed is the process start and the chain opening, not the parallelism.
 */
export type AssetFamily = "texture" | "model" | "tile";

export const ASSET_FAMILIES: readonly AssetFamily[] = ["texture", "model", "tile"];

/** The family of each job kind; `tests/asset-jobs.test.mjs` checks it against `tools/asset-jobs.mjs`. */
export const ASSET_JOB_FAMILY: Readonly<Record<AssetWorkerJob["kind"], AssetFamily>> = {
  texture: "texture",
  "visual-model": "model",
  "item-icon": "texture",
  "spell-icon": "texture",
  "creature-icon": "texture",
  "minimap-index": "texture",
  "zone-map": "texture",
  liquid: "texture",
  "liquid-family": "texture", // 05.10-A7b-8
  "client-file": "texture",
  "terrain-splat": "tile",
  "visual-tile": "tile",
  horizon: "tile",
  "horizon-colour": "tile", // 05.10-A7b-7
  "tile-models": "tile",
};

/** Which families `ASSET_WORKERS` turns on. Unknown names are an error, not a silent "none". */
export function parseAssetWorkers(value: string | undefined): ReadonlySet<AssetFamily> {
  const text = (value ?? "").trim();
  if (text === "0") return new Set();
  if (text === "" || text === "1") return new Set(ASSET_FAMILIES);
  const families = new Set<AssetFamily>();
  for (const name of text.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean)) {
    if (!(ASSET_FAMILIES as readonly string[]).includes(name)) {
      throw new Error(`ASSET_WORKERS: unknown family "${name}" (expected 0, 1 or a list of ${ASSET_FAMILIES.join(", ")})`);
    }
    families.add(name as AssetFamily);
  }
  return families;
}

export interface AssetWorkers {
  /** Whether jobs of this kind go to a worker. */
  handles(kind: AssetWorkerJob["kind"]): boolean;
  /**
   * Publishes through the job's worker, or answers `undefined` when its family has none (the caller
   * then runs the one-shot generator).
   */
  run(job: AssetWorkerJob, priority?: number): Promise<unknown> | undefined;
  /** The client's archives changed: every worker reopens its chain on its next job. */
  recycle(): void;
  close(): void;
}

export interface AssetWorkersOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  track?: (child: ChildProcess) => ChildProcess;
  /** Defaults to `tools/asset-worker.mjs` under `cwd`. */
  script?: string;
  /** Overrides `env.ASSET_WORKERS`. */
  families?: ReadonlySet<AssetFamily>;
  /** For tests: forwarded to every `AssetWorker`. */
  idleMs?: number;
}

/** Which worker process a job kind runs in: its family, or for the tile family one per kind. */
export function assetWorkerSlot(kind: AssetWorkerJob["kind"]): string {
  // The preloader's tile-models list reads one file and no archive: it rides the visual-tile
  // worker (10.22) rather than starting a fourth tile process for a few milliseconds of work.
  if (kind === "tile-models") return "tile:visual-tile";
  // 05.10-A7b-7 (7.08): once per map, beside the `.wdl` it colours — the horizon worker, not a fifth.
  if (kind === "horizon-colour") return "tile:horizon";
  const family = ASSET_JOB_FAMILY[kind];
  return family === "tile" ? `tile:${kind}` : family;
}

export function createAssetWorkers(options: AssetWorkersOptions): AssetWorkers {
  const families = options.families ?? parseAssetWorkers(options.env["ASSET_WORKERS"]);
  const script = options.script ?? resolve(options.cwd, "tools/asset-worker.mjs");
  const workers = new Map<string, AssetWorker>();
  let closed = false;
  const workerFor = (job: AssetWorkerJob): AssetWorker => {
    const name = assetWorkerSlot(job.kind);
    let worker = workers.get(name);
    if (!worker) {
      worker = new AssetWorker({
        script, cwd: options.cwd, env: options.env, label: name,
        ...(options.track ? { track: options.track } : {}),
        ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
      });
      workers.set(name, worker);
    }
    return worker;
  };
  return {
    handles: (kind) => !closed && families.has(ASSET_JOB_FAMILY[kind]),
    run(job, priority = 0) {
      if (closed || !families.has(ASSET_JOB_FAMILY[job.kind])) return undefined;
      return workerFor(job).run(job, priority);
    },
    recycle() {
      for (const worker of workers.values()) worker.recycle();
    },
    close() {
      closed = true;
      for (const worker of workers.values()) worker.close();
      workers.clear();
    },
  };
}
