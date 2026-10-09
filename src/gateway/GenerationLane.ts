/**
 * The gateway's generation lanes (10.20 slice 0, mechanism М-A10-3), moved out of `Gateway.ts`.
 *
 * Behaviour is what it was in `Gateway.ts`; what is new is bookkeeping for the preloader of 10.22:
 * a waiting job remembers its key so a real request can `promote` a background one, `laneStats`
 * counts requests, cold runs and time spent waiting and running, and `lanesQuiet` says when a
 * background job may start at all. `Gateway.ts` re-exports `SOURCE_MISSING_EXIT`, `sourceMissing`
 * and `texturePriority`, which tests and other modules import from there.
 */

/** How long a failed generation is remembered before the generator is given another chance. */
export const GENERATION_FAILURE_TTL_MS = 5 * 60_000;
/**
 * How long a failure that was *not* "the archives do not hold this" is remembered.
 *
 * A missing source stays missing for the five minutes above. A run that died — a crashed child, a
 * worker recycled under it, a rename a virus scanner held up — is this minute's problem, and the
 * browser answers it with Т6's retry ladder at 2 s, 8 s and 30 s. With the five-minute memory every
 * one of those retries was refused with the same 500, so one transient failure left the texture or
 * the building missing for the rest of the session (measured: the ladder gives up after ~40 s).
 * Long enough to fold the burst of requests that arrive together into the one refusal, short
 * enough that the first retry runs the generator again.
 */
export const GENERATION_RETRY_TTL_MS = 1_500;
/** Beyond this the expired half of the failure map is swept; it only ever holds broken keys. */
export const GENERATION_FAILURE_LIMIT = 4096;

/**
 * The priority of background work (10.22's preloader): below every real request.
 *
 * Real requests use 0, 1 and 2 (`texturePriority`; models 1), so anything at this priority only
 * runs when nobody is waiting — and only starts at all when `lanesQuiet` says so, because a job
 * that has started cannot be interrupted.
 */
export const PRELOAD_PRIORITY = -1;

/** How long after the last real job a background job may start (М-A10-3's "quiet window"). */
export const LANE_QUIET_MS = 250;

/**
 * The exit code a generator uses for "the archives do not hold this source".
 *
 * Every other way of failing — a child that crashed, a decoder that threw, a lane that refused —
 * is a fact about this minute rather than about the file, and the two have to leave this process
 * as different status codes. Т6 taught the browser to retry a 5xx on a backoff and to take a 404
 * as final; until this existed **every** way for `/texture` to fail answered 404, so a generator
 * child that died removed that layer — or, for a baked NPC whose only layer it was, the whole
 * unit — for the life of the tab, which is the very failure Т6 was written to end. Т7 sharpened
 * it: the first spelling the gateway offers is now one its own listing says is in the archives, so
 * a 404 on it is *more* likely to be a dead child than a missing file.
 *
 * Mirrored in `tools/generate-texture.mjs`, which is the end that chooses it; `npm test` pins the
 * two together, because a silent disagreement here reads to the browser as "no such file".
 */
export const SOURCE_MISSING_EXIT = 3;

/**
 * Whether a generator's rejection means the source is not in the client.
 *
 * The channel is the child's exit code, carried onto the rejection by whoever spawned it. The
 * message cannot be the channel: a child that crashes has no message at all, and one that throws
 * has whatever it last wrote to stderr.
 */
export function sourceMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { exitCode?: unknown }).exitCode === SOURCE_MISSING_EXIT;
}

/** What a lane has done since it was made (`laneStats`). Plain counters, no per-job allocation. */
export interface LaneStats {
  /** `generateOnce` calls that were not refused by the failure memory. */
  requests: number;
  /** Jobs that actually ran a generator at a real (non-preload) priority. */
  cold: number;
  /** Jobs that ran at `PRELOAD_PRIORITY` or below. */
  preloads: number;
  /** Total time real jobs spent queued before they started, in ms. */
  waitMs: number;
  /** Total time real jobs spent running, in ms. */
  runMs: number;
  /** When a real job last started or finished on this lane (`-Infinity` until one has). */
  lastRealAt: number;
}

interface WaitingJob {
  priority: number;
  readonly sequence: number;
  /** Absent for a `laneRun` that is not keyed (nothing can promote it). */
  readonly key: string | undefined;
  readonly queuedAt: number;
  start(): void;
}

/**
 * One family of generated assets: a serial lane so generators do not fight over the MPQ archives,
 * a per-key in-flight map so concurrent requests share one run, and a short-lived record of
 * failures.
 *
 * The lane runs one job at a time, highest priority first and in arrival order within a priority.
 * It used to be a plain promise chain, strictly first come first served, and the texture lane
 * carries everything from a unit's skin to the minimap's tiles: measured on the owner's session of
 * 2026-09-28, 241 baked NPC skins went through it behind 80 minimap tiles, 33 icons and 21 world-map
 * tiles, and every one of those NPCs stood as a capsule until its skin was published.
 */
export interface GenerationLane {
  running: boolean;
  sequence: number;
  readonly waiting: WaitingJob[];
  readonly jobs: Map<string, Promise<void>>;
  // Why it failed, and not only until when: a missing source is remembered for five minutes, and a
  // route that answered 404 for it has to go on answering 404 for the whole of that.
  // Otherwise the first request tells the browser the truth and the next one tells it to come back.
  readonly failures: Map<string, { until: number; missing: boolean }>;
  readonly stats: LaneStats;
  /** The lane's clock; injectable so a test can drive the quiet window. */
  readonly now: () => number;
}

export function generationLane(now: () => number = Date.now): GenerationLane {
  return {
    running: false, sequence: 0, waiting: [], jobs: new Map(), failures: new Map(), now,
    stats: { requests: 0, cold: 0, preloads: 0, waitMs: 0, runMs: 0, lastRealAt: Number.NEGATIVE_INFINITY },
  };
}

/** Starts the lane's best waiting job if nothing is running. */
export function pumpLane(lane: GenerationLane): void {
  if (lane.running || lane.waiting.length === 0) return;
  let best = 0;
  for (let index = 1; index < lane.waiting.length; index++) {
    const candidate = lane.waiting[index]!;
    const chosen = lane.waiting[best]!;
    if (candidate.priority > chosen.priority
      || (candidate.priority === chosen.priority && candidate.sequence < chosen.sequence)) best = index;
  }
  const [next] = lane.waiting.splice(best, 1);
  lane.running = true;
  next!.start();
}

/** Queues `run` on the lane; the promise settles with it. */
export function laneRun(
  lane: GenerationLane, run: () => Promise<void>, priority: number, key?: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const entry: WaitingJob = {
      priority,
      sequence: lane.sequence++,
      key,
      queuedAt: lane.now(),
      start: () => {
        // Read at start, not at queueing: `promote` may have raised it while it waited.
        const real = entry.priority > PRELOAD_PRIORITY;
        const startedAt = lane.now();
        if (real) {
          lane.stats.cold++;
          lane.stats.waitMs += Math.max(0, startedAt - entry.queuedAt);
          lane.stats.lastRealAt = startedAt;
        } else {
          lane.stats.preloads++;
        }
        void Promise.resolve()
          .then(run)
          .then(resolve, reject)
          .finally(() => {
            if (real) {
              const finishedAt = lane.now();
              lane.stats.runMs += Math.max(0, finishedAt - startedAt);
              lane.stats.lastRealAt = finishedAt;
            }
            lane.running = false;
            pumpLane(lane);
          });
      },
    };
    lane.waiting.push(entry);
    pumpLane(lane);
  });
}

/**
 * Raises a waiting job's priority (never lowers it). Returns whether a waiting job had that key.
 *
 * A job that is already running cannot be sped up and is not touched. A real request joining a
 * background job for the same key must call this — otherwise the player waits at the preloader's
 * priority behind every other preload.
 */
export function promote(lane: GenerationLane, key: string, priority: number): boolean {
  for (const entry of lane.waiting) {
    if (entry.key !== key) continue;
    if (priority > entry.priority) entry.priority = priority;
    return true;
  }
  return false;
}

/** A snapshot of the lane's counters plus what is queued now. */
export function laneStats(lane: GenerationLane): LaneStats & { running: boolean; waiting: number } {
  return { ...lane.stats, running: lane.running, waiting: lane.waiting.length };
}

/**
 * Whether background work may start: every lane idle (nothing running, nothing waiting) and no
 * real job seen on any of them for `quietMs`. All lanes, not one: a real request on a neighbour
 * lane shares the same workers and processor.
 */
export function lanesQuiet(lanes: readonly GenerationLane[], now: number, quietMs = LANE_QUIET_MS): boolean {
  for (const lane of lanes) {
    if (lane.running || lane.waiting.length > 0) return false;
    if (now - lane.stats.lastRealAt < quietMs) return false;
  }
  return true;
}

/**
 * How urgently a `/texture` path is wanted, for its lane.
 *
 * 2 — what makes a unit appear: character and item component layers, creature skins and the baked
 *     NPC faces; until they are published the unit is a capsule (`CharacterAtlas` waits for its
 *     layers).
 * 0 — interface art that is drawn in a corner or a window: minimap tiles, world-map art, icons.
 * 1 — everything else, the world's own model textures.
 */
export function texturePriority(path: string): number {
  const lower = path.replaceAll("/", "\\").toLowerCase();
  if (lower.startsWith("character\\") || lower.startsWith("item\\") || lower.startsWith("creature\\")
    || lower.startsWith("textures\\bakednpctextures\\")) return 2;
  if (lower.startsWith("textures\\minimap\\") || lower.startsWith("interface\\")) return 0;
  return 1;
}

/**
 * How urgently a `/visual/model` path is wanted, for its lane and its worker (10.20 slice 4).
 *
 * 2 — a character's or a creature's M2: until it is published the unit is a stand-in.
 * 1 — every other M2 (doodads, spell effects): 9–25 ms each out of an open chain.
 * 0 — a WMO: a city building takes 0.3–0.9 s, and nothing a player stands next to should wait for it.
 */
export function visualModelPriority(path: string): number {
  const lower = path.replaceAll("/", "\\").toLowerCase();
  if (lower.endsWith(".wmo")) return 0;
  if (lower.startsWith("character\\") || lower.startsWith("creature\\")) return 2;
  return 1;
}

/**
 * Runs the generator for one key at most once at a time, on the family's lane.
 *
 * Nothing writes a negative result to disk, so without the failure memory an asset the client
 * simply does not ship — or one the generator cannot parse — re-enters the lane on every request
 * from every player and starves the assets that would have succeeded. The TTL is there so a
 * generator fixed at runtime, or a dependency that came back, heals without a restart.
 *
 * A request for a key that is already queued joins that job and raises it to its own priority
 * (`promote`), so a real request never waits at a background job's priority.
 */
export async function generateOnce(
  lane: GenerationLane, key: string, run: () => Promise<void>, priority = 1,
): Promise<void> {
  const remembered = lane.failures.get(key);
  if (remembered && remembered.until > Date.now()) {
    // Refused, but refused with the same news the run itself gave. A source the client does not
    // hold does not start being held inside the five minutes, and the route above turns this into
    // the 404 it turned the original rejection into rather than into "try again".
    const refusal = new Error(`Generating ${key} failed recently`);
    if (remembered.missing) (refusal as Error & { exitCode?: number }).exitCode = SOURCE_MISSING_EXIT;
    throw refusal;
  }
  lane.failures.delete(key);
  lane.stats.requests++;
  let job = lane.jobs.get(key);
  if (!job) {
    const generation = laneRun(lane, run, priority, key);
    job = generation.finally(() => lane.jobs.delete(key));
    lane.jobs.set(key, job);
  } else {
    promote(lane, key, priority);
  }
  try {
    await job;
  } catch (error) {
    if (lane.failures.size >= GENERATION_FAILURE_LIMIT) {
      const now = Date.now();
      for (const [failed, failure] of lane.failures) if (failure.until <= now) lane.failures.delete(failed);
    }
    const missing = sourceMissing(error);
    // A background run (10.22) that failed for this minute's reasons is not remembered: the memory
    // exists to fold a burst of real requests into one refusal, and nobody was waiting on this one.
    // Kept, it would answer the player's own request inside the next 1.5 s with a 500 and the
    // browser's 2 s retry. A real request that joined the run records its own failure below.
    if (!missing && priority <= PRELOAD_PRIORITY) throw error;
    lane.failures.set(key, {
      until: Date.now() + (missing ? GENERATION_FAILURE_TTL_MS : GENERATION_RETRY_TTL_MS),
      missing,
    });
    throw error;
  }
}

/**
 * Whether this key's last run failed recently enough that `generateOnce` will refuse to run it.
 *
 * A caller that swallows the rejection needs to know which of the two it swallowed: the generator
 * having just run and failed, which is worth a line in the log, or the memory of a failure it
 * already reported, which is not — that one arrives once per request for the whole TTL.
 */
export function recentlyFailed(lane: GenerationLane, key: string): boolean {
  const failure = lane.failures.get(key);
  return failure !== undefined && failure.until > Date.now();
}
