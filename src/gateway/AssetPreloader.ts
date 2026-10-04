import { LANE_QUIET_MS, lanesQuiet, sourceMissing, type GenerationLane } from "./GenerationLane.js";

/**
 * Background publication of what the player will ask for next (10.22, mechanism М-A10-3).
 *
 * After `/visual/environment/<map>/<x>/<y>` the tile and its eight neighbours are walked: each
 * neighbour's visual tile is published if it is not yet, and every model the tiles place that has
 * no current artifact is published — all at `PRELOAD_PRIORITY`, so a real request always goes
 * first, and only when every generation lane has been idle for the quiet window, because a job
 * that has started cannot be interrupted (a city WMO is 0.3–0.9 s, Gundrak's ~2 s).
 *
 * The rules, each pinned by `tests/asset-preloader.test.mjs`:
 * - one background job at a time, and only when `lanesQuiet` (all lanes idle, no real job for
 *   `quietMs`);
 * - after a job, a pause of `duration × pace` — with the default pace of 1 the workers stand idle
 *   at least half the time, so the game on the same machine keeps its cores;
 * - at most `perMinute` jobs a minute and `perVisit` per visit (a visit ends with an idle stop);
 *   the newest tiles are walked first, and the queues are capped (oldest out);
 * - it stops when no tile has been served for `idleStopMs`, on `recycle()` (the archives changed)
 *   and on `close()`; three failures in a row pause it for `failurePauseMs`.
 *
 * What is "published" and how is the gateway's business: the callbacks below are the same
 * `generateOnce` keys the routes use, so a real request for a key the preloader is running joins
 * that run, and one for a key it queued is promoted (`GenerationLane.promote`).
 */
export interface AssetPreloaderOptions {
  /** Every generation lane of the gateway: background work starts only when all are quiet. */
  lanes: readonly GenerationLane[];
  /** The models a published tile places, or `undefined` when the tile is not published yet. */
  tileModels(map: number, gridX: number, gridY: number): Promise<readonly string[] | undefined>;
  /** Publishes one visual tile in the background. */
  publishTile(map: number, gridX: number, gridY: number): Promise<void>;
  /** Whether a model's artifact is on disk and current (no work then). */
  modelCurrent(path: string): Promise<boolean>;
  /** Publishes one model in the background. */
  publishModel(path: string): Promise<void>;
  /** Jobs per minute (default 120). */
  perMinute?: number;
  /** Jobs per visit, which ends when no tile was served for `idleStopMs` (default 600). */
  perVisit?: number;
  /** Pause after a job, as a multiple of its duration (default 1). */
  pace?: number;
  /** Stop when no tile was served for this long (default 60 s). */
  idleStopMs?: number;
  /** The quiet window (default `LANE_QUIET_MS`, 250 ms). */
  quietMs?: number;
  /** Pause after three failures in a row (default 60 s). */
  failurePauseMs?: number;
  /** How many tiles may wait to be walked, newest first (default 64: a view radius and its ring). */
  maxTiles?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** One line a minute while working; silent when omitted. */
  log?: (line: string) => void;
  logEveryMs?: number;
}

export interface AssetPreloaderStats {
  queuedTiles: number;
  queuedModels: number;
  /** Jobs run (tiles and models). */
  published: number;
  /** Models found current, so no job. */
  skipped: number;
  /** Queued work given up: a queue cap, the visit budget, an idle stop or a recycle. */
  dropped: number;
  /** Jobs whose source the client does not hold (a map edge, a model a tile names but nobody ships). */
  missing: number;
  failed: number;
  /** Total ms spent in jobs. */
  busyMs: number;
  running: boolean;
}

interface QueuedTile { readonly map: number; readonly gridX: number; readonly gridY: number; readonly key: string }
interface QueuedModel { readonly path: string; readonly tile: string }

const MINUTE = 60_000;
/** Bound on the "already queued once" memory; beyond it the memory starts over. */
const SEEN_LIMIT = 50_000;

export class AssetPreloader {
  readonly #options: AssetPreloaderOptions;
  readonly #now: () => number;
  readonly #perMinute: number;
  readonly #perVisit: number;
  readonly #pace: number;
  readonly #idleStopMs: number;
  readonly #quietMs: number;
  readonly #failurePauseMs: number;
  readonly #maxTiles: number;
  readonly #logEveryMs: number;
  #tiles: QueuedTile[] = [];
  #models: QueuedModel[] = [];
  /** Tiles walked or queued since the last recycle, by key. */
  readonly #seenTiles = new Set<string>();
  /** Models queued since the last recycle, lower case. */
  readonly #seenModels = new Set<string>();
  /** Start times of the jobs of the last minute. */
  readonly #starts: number[] = [];
  #visitJobs = 0;
  #lastNoteAt = Number.NEGATIVE_INFINITY;
  #pausedUntil = 0;
  #failuresInRow = 0;
  #running = false;
  #timer: unknown;
  #closed = false;
  #generation = 0;
  #lastLogAt: number;
  #loggedJobs = 0;
  readonly #stats = { published: 0, skipped: 0, dropped: 0, missing: 0, failed: 0, busyMs: 0 };

  constructor(options: AssetPreloaderOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#perMinute = Math.max(1, options.perMinute ?? 120);
    this.#perVisit = Math.max(1, options.perVisit ?? 600);
    this.#pace = Math.max(0, options.pace ?? 1);
    this.#idleStopMs = options.idleStopMs ?? MINUTE;
    this.#quietMs = options.quietMs ?? LANE_QUIET_MS;
    this.#failurePauseMs = options.failurePauseMs ?? MINUTE;
    this.#maxTiles = Math.max(1, options.maxTiles ?? 64);
    this.#logEveryMs = options.logEveryMs ?? MINUTE;
    this.#lastLogAt = this.#now();
  }

  /** A tile was served: walk it and its eight neighbours, nearest first. */
  noteTile(map: number, gridX: number, gridY: number): void {
    if (this.#closed) return;
    const now = this.#now();
    // A visit is the span between two idle stops. Where the player stands cannot be read off one
    // request — the browser asks for every tile of its view radius in a burst — so a request drops
    // nothing; the newest tiles go first and the queues are capped instead.
    if (now - this.#lastNoteAt >= this.#idleStopMs) this.#visitJobs = 0;
    this.#lastNoteAt = now;
    const fresh: QueuedTile[] = [];
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
      const x = gridX + dx;
      const y = gridY + dy;
      if (x < 0 || y < 0 || x > 63 || y > 63) continue;
      const key = `${map}/${x}/${y}`;
      if (this.#seenTiles.has(key)) continue;
      this.#seenTiles.add(key);
      fresh.push({ map, gridX: x, gridY: y, key });
    }
    this.#tiles = [...fresh, ...this.#tiles];
    while (this.#tiles.length > this.#maxTiles) {
      this.#seenTiles.delete(this.#tiles.pop()!.key);
      this.#stats.dropped++;
    }
    this.#wake(0);
  }

  /** The archives changed: everything queued was planned against the old ones. */
  recycle(): void {
    this.#generation++;
    this.#stats.dropped += this.#tiles.length + this.#models.length;
    this.#tiles = [];
    this.#models = [];
    this.#seenTiles.clear();
    this.#seenModels.clear();
    this.#cancelTimer();
  }

  close(): void {
    this.#closed = true;
    this.recycle();
  }

  stats(): AssetPreloaderStats {
    return {
      ...this.#stats, queuedTiles: this.#tiles.length, queuedModels: this.#models.length, running: this.#running,
    };
  }

  #dropModels(): void {
    for (const model of this.#models) {
      this.#seenModels.delete(model.path.toLowerCase());
      // The tile goes back to "not walked", so a return to it queues its models again.
      this.#seenTiles.delete(model.tile);
    }
    this.#stats.dropped += this.#models.length;
    this.#models = [];
  }

  #cancelTimer(): void {
    if (this.#timer === undefined) return;
    (this.#options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)))(this.#timer);
    this.#timer = undefined;
  }

  /** Runs `#step` after `ms`, unless a step is already scheduled or running. */
  #wake(ms: number): void {
    if (this.#closed || this.#running || this.#timer !== undefined) return;
    const run = (): void => {
      this.#timer = undefined;
      void this.#step();
    };
    if (this.#options.setTimer) {
      this.#timer = this.#options.setTimer(run, ms);
    } else {
      const handle = setTimeout(run, ms);
      handle.unref();
      this.#timer = handle;
    }
  }

  /** May a job start now? Otherwise, how long to wait before asking again. */
  #mayStart(now: number): number {
    if (now < this.#pausedUntil) return this.#pausedUntil - now;
    if (!lanesQuiet(this.#options.lanes, now, this.#quietMs)) return this.#quietMs;
    while (this.#starts.length > 0 && now - this.#starts[0]! >= MINUTE) this.#starts.shift();
    if (this.#starts.length >= this.#perMinute) return this.#starts[0]! + MINUTE - now;
    return 0;
  }

  async #step(): Promise<void> {
    if (this.#closed || this.#running) return;
    const generation = this.#generation;
    let now = this.#now();
    if (now - this.#lastNoteAt >= this.#idleStopMs) {
      // Nobody is walking anywhere: stop rather than warm the whole map.
      if (this.#tiles.length + this.#models.length > 0) this.#stats.dropped += this.#tiles.length + this.#models.length;
      this.#tiles = [];
      this.#models = [];
      this.#seenTiles.clear();
      this.#seenModels.clear();
      this.#report(now, true);
      return;
    }
    if (this.#visitJobs >= this.#perVisit) {
      this.#dropModels();
      this.#stats.dropped += this.#tiles.length;
      this.#tiles = [];
      return;
    }
    this.#running = true;
    let pauseMs = 0;
    try {
      // Models already current cost a stat each and no job; walk past them in one go.
      while (this.#models.length > 0) {
        const model = this.#models[0]!;
        if (!await this.#options.modelCurrent(model.path)) break;
        if (generation !== this.#generation) return;
        this.#models.shift();
        this.#stats.skipped++;
      }
      if (this.#models.length === 0 && this.#tiles.length === 0) return;
      now = this.#now();
      const wait = this.#mayStart(now);
      if (wait > 0) {
        pauseMs = wait;
        return;
      }
      if (this.#models.length > 0) {
        const model = this.#models.shift()!;
        pauseMs = await this.#job(() => this.#options.publishModel(model.path));
        return;
      }
      const tile = this.#tiles.shift()!;
      let models = await this.#options.tileModels(tile.map, tile.gridX, tile.gridY);
      if (generation !== this.#generation) return;
      if (models === undefined) {
        // Not published: that is the job, and its models are listed on the next step.
        pauseMs = await this.#job(() => this.#options.publishTile(tile.map, tile.gridX, tile.gridY));
        if (generation !== this.#generation) return;
        models = await this.#options.tileModels(tile.map, tile.gridX, tile.gridY).catch(() => undefined);
        if (generation !== this.#generation || models === undefined) return;
      }
      if (this.#seenModels.size >= SEEN_LIMIT) this.#seenModels.clear();
      for (const path of models) {
        const key = path.toLowerCase();
        if (this.#seenModels.has(key)) continue;
        this.#seenModels.add(key);
        this.#models.push({ path, tile: tile.key });
      }
      // Capped at a visit's budget, oldest out: what is that far back is least likely to be next.
      while (this.#models.length > this.#perVisit) {
        const dropped = this.#models.shift()!;
        this.#seenModels.delete(dropped.path.toLowerCase());
        this.#seenTiles.delete(dropped.tile);
        this.#stats.dropped++;
      }
    } catch {
      // A listing that failed (a model's own failure is counted in `#job`): try the rest later.
      this.#noteFailure();
      pauseMs = Math.max(pauseMs, this.#quietMs);
    } finally {
      this.#running = false;
      if (!this.#closed && generation === this.#generation && this.#tiles.length + this.#models.length > 0) {
        this.#wake(pauseMs);
      }
      this.#report(this.#now(), false);
    }
  }

  /** Runs one background job; answers the pause owed after it. */
  async #job(run: () => Promise<void>): Promise<number> {
    const started = this.#now();
    this.#starts.push(started);
    this.#visitJobs++;
    try {
      await run();
      this.#failuresInRow = 0;
      this.#stats.published++;
    } catch (error) {
      // "Not in the client" is an answer, not a fault: a tile at a map's edge has absent
      // neighbours, and tiles name models nobody ships. Counted as a failure, eight absent
      // neighbours paused the whole neighbourhood for a minute. The lane remembers it (five
      // minutes) for the real request; a fault is remembered only for real requests (`generateOnce`).
      if (sourceMissing(error)) {
        this.#stats.missing++;
      } else {
        this.#stats.failed++;
        this.#noteFailure();
      }
    }
    const duration = Math.max(0, this.#now() - started);
    this.#stats.busyMs += duration;
    this.#loggedJobs++;
    return Math.max(this.#quietMs, duration * this.#pace);
  }

  #noteFailure(): void {
    this.#failuresInRow++;
    if (this.#failuresInRow >= 3) {
      this.#failuresInRow = 0;
      this.#pausedUntil = this.#now() + this.#failurePauseMs;
    }
  }

  #report(now: number, force: boolean): void {
    const log = this.#options.log;
    if (!log || this.#loggedJobs === 0 || (!force && now - this.#lastLogAt < this.#logEveryMs)) return;
    this.#lastLogAt = now;
    this.#loggedJobs = 0;
    const s = this.stats();
    const jobs = s.published + s.missing + s.failed;
    const average = jobs > 0 ? Math.round(s.busyMs / jobs) : 0;
    log(`preload: ${s.queuedTiles} tiles and ${s.queuedModels} models queued, ${s.published} published `
      + `(average ${average} ms), ${s.skipped} already current, ${s.dropped} dropped, ${s.missing} not in the client, ${s.failed} failed`);
  }
}

/**
 * `ASSET_PRELOAD` and its two knobs, for `GatewayConfiguration.ts`.
 *
 * Off unless `ASSET_PRELOAD=1`: the owner plays on the machine that runs the gateway, and the
 * preloader's first live measurement (14.24) decides whether it may be on by default (owner
 * question 4 of line A10). `ASSET_PRELOAD_PER_MINUTE` (120) and `ASSET_PRELOAD_PACE` (1) bound it.
 * A value that does not parse is an error at startup, not a silent default.
 */
export function parsePreloadEnv(env: NodeJS.ProcessEnv): { perMinute: number; pace: number } | undefined {
  const enabled = (env["ASSET_PRELOAD"] ?? "").trim();
  if (enabled === "" || enabled === "0") return undefined;
  if (enabled !== "1") throw new Error(`ASSET_PRELOAD: expected 0 or 1, got "${enabled}"`);
  const number = (name: string, fallback: number, minimum: number, maximum: number): number => {
    const text = (env[name] ?? "").trim();
    if (text === "") return fallback;
    const value = Number(text);
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`${name}: expected a number from ${String(minimum)} to ${String(maximum)}, got "${text}"`);
    }
    return value;
  };
  return {
    perMinute: Math.floor(number("ASSET_PRELOAD_PER_MINUTE", 120, 1, 6000)),
    pace: number("ASSET_PRELOAD_PACE", 1, 0, 100),
  };
}
