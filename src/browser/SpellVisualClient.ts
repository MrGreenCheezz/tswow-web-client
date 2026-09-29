// What a spell looks like, asked for the way a renderer can ask.
//
// `SpellMetadataClient` next door is `await load(ids)`, which is right for a window that opens
// with a list of spells in its hand. A cast is not that: it arrives between frames, for a spell
// nobody has mentioned before, and the renderer that wants to draw it is halfway through a frame
// and cannot await anything. So this is shaped like `EnvironmentClient.model` instead — ask every
// frame, get `undefined` until the answer lands, and never ask the same question twice.
//
// Two things are asked for that way, not one. A spell is named by `SMSG_SPELL_GO`; a *kit* is
// named by `SMSG_PLAY_SPELL_VISUAL` and `SMSG_PLAY_SPELL_IMPACT`, which carry a `SpellVisualKit`
// id and no spell at all. Slice S3 gave the second one a route, and the decision made here is that
// it shares this file's engine rather than getting a copy of it: the two differ in the path they
// fetch and in what a valid answer looks like, and in nothing else — same 200-id cap, same
// one-request-per-microtask batching, same bounded retry ladder, same "an answer of nothing is
// still an answer" cache. A second class with its own copy of `#drain` would be ninety lines that
// have to be kept in step by hand, and the failure mode of them drifting is a queue that retries
// forever. The queues themselves stay separate, because the two routes answer different questions.

import type {
  SpellVisualKit, SpellVisualKitRecord, SpellVisualMetadata,
} from "../gateway/SpellVisual.js";

export type { SpellVisualKitRecord, SpellVisualMetadata };

/** The gateway takes at most this many ids at once, and says 400 above it. */
const BATCH = 200;

/**
 * A transient metadata failure backs off quickly, but is never made permanent. Once the ladder is
 * exhausted, later callers may retry at most once every thirty seconds for this client session.
 */
export const SPELL_VISUAL_RETRY_BACKOFF_MS = [2_000, 8_000, 30_000] as const;

/**
 * One id-keyed metadata route, polled from inside a frame.
 *
 * Everything specific to a route is a method a subclass supplies; everything about *when* to ask
 * and what to remember lives here once.
 */
abstract class BatchedMetadataClient<Entry extends { id: number }> {
  onStatus: ((message: string, error: boolean) => void) | undefined;
  /** Fired after a successful batch has populated the cache, including empty answers. */
  onLoaded: ((ids: readonly number[]) => void) | undefined;
  protected readonly baseUrl: string;
  /** null marks an id the gateway answered for and that has nothing at all behind it. */
  readonly #cache = new Map<number, Entry | null>();
  readonly #queue = new Set<number>();
  readonly #inFlight = new Set<number>();
  readonly #failures = new Map<number, { attempts: number; after: number }>();
  readonly #now: () => number;
  #draining = false;
  #drainScheduled = false;

  constructor(gatewayWebSocketUrl: string, now: () => number = Date.now) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.baseUrl = url.origin;
    this.#now = now;
  }

  /** The URL one batch of ids is fetched from. */
  protected abstract url(ids: readonly number[]): string;
  /** Whether one element of the gateway's array is the shape this route promises. */
  protected abstract accept(value: unknown): value is Entry;
  /** Whether an accepted entry carries anything, or is the gateway saying "nothing here". */
  protected abstract meaningful(entry: Entry): boolean;

  /**
   * The record if it has arrived, and a request for it if it has not.
   *
   * Safe to call every frame for the same id: the answer is remembered either way, including the
   * answer "this id has nothing", which is 17,000 of the client's spells and would otherwise be
   * seventeen thousand requests that never stop.
   */
  get(id: number): Entry | undefined {
    const known = this.#cache.get(id);
    if (known !== undefined) return known ?? undefined;
    if (this.#queue.has(id) || this.#inFlight.has(id)) return undefined;
    const failure = this.#failures.get(id);
    if (failure && this.#now() < failure.after) return undefined;
    this.#queue.add(id);
    this.#scheduleDrain();
    return undefined;
  }

  /** Whether anything is still outstanding, for the diagnostics line. */
  get pending(): number {
    return this.#queue.size + this.#inFlight.size;
  }

  /**
   * One request per turn of the event loop, however many casts happened in that frame.
   *
   * A pull of eight mobs opens with eight casts inside one tick; batching them costs one round
   * trip instead of eight, and the gateway builds its table once either way.
   */
  #scheduleDrain(): void {
    if (this.#drainScheduled) return;
    this.#drainScheduled = true;
    queueMicrotask(() => {
      this.#drainScheduled = false;
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.size > 0) {
        const batch = [...this.#queue].slice(0, BATCH);
        for (const id of batch) {
          this.#queue.delete(id);
          this.#inFlight.add(id);
        }
        try {
          const response = await fetch(this.url(batch));
          if (!response.ok) throw new Error(`Spell visual gateway returned ${response.status}`);
          const value: unknown = await response.json();
          if (!Array.isArray(value) || !value.every((entry) => this.accept(entry))) {
            throw new Error("Spell visual gateway returned invalid data");
          }
          const wanted = new Set(batch);
          for (const entry of value as Entry[]) {
            if (!wanted.has(entry.id)) continue;
            // A record with nothing in it is the gateway saying "this shows nothing", which is an
            // answer and is remembered as one.
            this.#cache.set(entry.id, this.meaningful(entry) ? entry : null);
          }
          // Anything a valid gateway answer omitted is remembered as nothing. A malformed answer
          // is rejected above and follows the bounded transient-failure ladder instead.
          for (const id of batch) if (!this.#cache.has(id)) this.#cache.set(id, null);
          for (const id of batch) this.#failures.delete(id);
          this.onLoaded?.(batch);
        } catch (error) {
          const now = this.#now();
          for (const id of batch) {
            const attempts = (this.#failures.get(id)?.attempts ?? 0) + 1;
            const wait = SPELL_VISUAL_RETRY_BACKOFF_MS[
              Math.min(attempts - 1, SPELL_VISUAL_RETRY_BACKOFF_MS.length - 1)
            ]!;
            this.#failures.set(id, {
              attempts,
              after: now + wait,
            });
          }
          this.onStatus?.(error instanceof Error ? error.message : String(error), true);
        } finally {
          for (const id of batch) this.#inFlight.delete(id);
        }
      }
    } finally {
      this.#draining = false;
    }
  }
}

export class SpellVisualClient extends BatchedMetadataClient<SpellVisualMetadata> {
  protected override url(ids: readonly number[]): string {
    // v=5 adds DBC model-attach transforms to visual kits, including patched Cone of Cold.
    // v=6 leaves a formerly cached HD-overlay answer behind when switching to classic.
    // v=7 carries `areaSize` on effect placements that author a non-identity AreaEffectSize.
    // Keeping the cache marker here prevents an older "no visual" response from turning
    // Auto Shot back into a generic cast after the gateway has been upgraded.
    return `${this.baseUrl}/dbc/spell-visuals?v=7&ids=${ids.join(",")}`;
  }

  protected override accept(value: unknown): value is SpellVisualMetadata {
    return isSpellVisual(value);
  }

  protected override meaningful(entry: SpellVisualMetadata): boolean {
    return hasAnything(entry);
  }
}

/**
 * The same engine, pointed at the route that answers by `SpellVisualKit` id.
 *
 * The kit inside an answer is byte-for-byte the record a phase of a spell's answer carries, so
 * `isKit` below is the validator both routes share rather than a second opinion about the same
 * shape.
 */
export class SpellVisualKitClient extends BatchedMetadataClient<SpellVisualKitRecord> {
  protected override url(ids: readonly number[]): string {
    return `${this.baseUrl}/dbc/spell-visual-kits?v=1&ids=${ids.join(",")}`;
  }

  protected override accept(value: unknown): value is SpellVisualKitRecord {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    if (typeof record["id"] !== "number" || !Number.isSafeInteger(record["id"])) return false;
    return record["kit"] === undefined || isKit(record["kit"]);
  }

  protected override meaningful(entry: SpellVisualKitRecord): boolean {
    return entry.kit !== undefined;
  }
}

function hasAnything(visual: SpellVisualMetadata): boolean {
  return Boolean(
    visual.autoRepeat ?? visual.precast ?? visual.cast ?? visual.impact ?? visual.state ?? visual.stateDone ?? visual.channel
      ?? visual.casterImpact ?? visual.targetImpact ?? visual.missileTargeting ?? visual.instantArea
      ?? visual.impactArea ?? visual.persistentArea ?? visual.missile
      ?? visual.missileSound ?? visual.animEventSound,
  );
}

/** One `SpellVisualKit`, wherever it arrives from: a phase of a spell, or the kit route. */
function isKit(value: unknown): value is SpellVisualKit {
  if (!value || typeof value !== "object") return false;
  const shape = value as Record<string, unknown>;
  if (typeof shape["startAnimation"] !== "number" || !Number.isFinite(shape["startAnimation"])
    || typeof shape["animation"] !== "number" || !Number.isFinite(shape["animation"])
    || typeof shape["sound"] !== "number" || !Number.isFinite(shape["sound"])) return false;
  return Array.isArray(shape["effects"]) && shape["effects"].every(isEffect);
}

function isSpellVisual(value: unknown): value is SpellVisualMetadata {
  if (!value || typeof value !== "object") return false;
  const visual = value as Record<string, unknown>;
  if (typeof visual["id"] !== "number" || !Number.isSafeInteger(visual["id"])) return false;
  if (visual["autoRepeat"] !== undefined && typeof visual["autoRepeat"] !== "boolean") return false;
  for (const phase of [
    "precast", "cast", "impact", "state", "stateDone", "channel", "casterImpact", "targetImpact",
    "missileTargeting", "instantArea", "impactArea", "persistentArea",
  ]) {
    const kit = visual[phase];
    if (kit === undefined) continue;
    if (!isKit(kit)) return false;
  }
  const missile = visual["missile"];
  if (missile !== undefined) {
    if (!missile || typeof missile !== "object") return false;
    const shape = missile as Record<string, unknown>;
    if (typeof shape["path"] !== "string" || typeof shape["scale"] !== "number"
      || !Number.isFinite(shape["scale"])) return false;
    if (typeof shape["attachment"] !== "number" || !Number.isFinite(shape["attachment"])
      || typeof shape["speed"] !== "number" || !Number.isFinite(shape["speed"])) return false;
    if (shape["sound"] !== undefined
      && (typeof shape["sound"] !== "number" || !Number.isFinite(shape["sound"]))) return false;
  }
  for (const field of ["missileSound", "animEventSound", "durationMs"]) {
    if (visual[field] !== undefined
      && (typeof visual[field] !== "number" || !Number.isFinite(visual[field]))) return false;
  }
  return true;
}

function isEffect(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const effect = value as Record<string, unknown>;
  if (typeof effect["path"] !== "string"
    || typeof effect["attachment"] !== "number"
    || !Number.isFinite(effect["attachment"])
    || typeof effect["scale"] !== "number"
    || !Number.isFinite(effect["scale"])) return false;
  // Optional, and rejected rather than ignored when malformed: a NaN here would reach a scale.
  if (effect["areaSize"] !== undefined
    && (typeof effect["areaSize"] !== "number" || !Number.isFinite(effect["areaSize"]))) return false;
  const transform = effect["transform"];
  if (transform === undefined) return true;
  if (!transform || typeof transform !== "object") return false;
  const shape = transform as Record<string, unknown>;
  return Array.isArray(shape["offset"]) && shape["offset"].length === 3
    && shape["offset"].every((value) => typeof value === "number" && Number.isFinite(value))
    && Array.isArray(shape["rotation"]) && shape["rotation"].length === 3
    && shape["rotation"].every((value) => typeof value === "number" && Number.isFinite(value));
}
