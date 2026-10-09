/**
 * Retry ladder for a request that failed (1.24, mechanism М-A7b-2).
 *
 * Before this, the terrain splat, the map's light table and the far horizon each wrote `null` on
 * any failure and never asked again: one gateway hiccup while crossing a zone left "noon" sky and a
 * 180–640 fog, or bare ground, for the life of the tab. The ladder waits 2 s, 8 s and 30 s after the
 * first three failures — the same steps as the texture backoff (`IMAGE_RETRY_BACKOFF_MS` in
 * `CharacterAtlas.ts`, which `Terrain.ts#deferGroup` also follows) — and gives up after the fourth.
 * A permanent absence (the gateway's 404: a map without a `.wdl`, a tile with nothing to paint) is
 * exhausted at once.
 *
 * Pure and three-free; the clock is injected so a test can walk half a minute in one line. A key
 * that has not failed costs one `Map` lookup on `waiting`/`ready`, so callers may ask every frame.
 */

/** The texture backoff's steps; `tests/retry-ladder.test.mjs` holds the two lists equal. */
export const RETRY_LADDER_STEPS_MS: readonly number[] = [2_000, 8_000, 30_000];

interface LadderEntry {
  attempts: number;
  /** When the key may be asked again; `Infinity` once the ladder has run out or the miss is final. */
  after: number;
}

export class RetryLadder<K> {
  readonly #steps: readonly number[];
  readonly #now: () => number;
  readonly #entries = new Map<K, LadderEntry>();

  constructor(steps: readonly number[] = RETRY_LADDER_STEPS_MS, now: () => number = () => performance.now()) {
    this.#steps = steps;
    this.#now = now;
  }

  /** Keys with a failure on record, waiting or exhausted. */
  get size(): number {
    return this.#entries.size;
  }

  /** Records a failure; `permanent` (a 404) is never asked again. */
  failed(key: K, permanent = false): void {
    const entry = this.#entries.get(key) ?? { attempts: 0, after: 0 };
    entry.attempts++;
    const step = this.#steps[entry.attempts - 1];
    entry.after = permanent || step === undefined || Number.isNaN(step)
      ? Infinity
      : this.#now() + step;
    this.#entries.set(key, entry);
  }

  /** Whether the key has a failure on record (so the caller must not ask unless `ready`). */
  waiting(key: K): boolean {
    return this.#entries.has(key);
  }

  /** Whether the key may be asked now: never failed, or its wait is over. Exhausted keys never are. */
  ready(key: K): boolean {
    const entry = this.#entries.get(key);
    return entry === undefined || (entry.after !== Infinity && this.#now() >= entry.after);
  }

  attempts(key: K): number {
    return this.#entries.get(key)?.attempts ?? 0;
  }

  exhausted(key: K): boolean {
    return this.#entries.get(key)?.after === Infinity;
  }

  /** 05.10-A7b-9 (7.18): keys waiting for a retry that will still be made. */
  retryingCount(): number {
    let count = 0;
    for (const entry of this.#entries.values()) if (entry.after !== Infinity) count++;
    return count;
  }

  exhaustedCount(): number {
    let count = 0;
    for (const entry of this.#entries.values()) if (entry.after === Infinity) count++;
    return count;
  }

  /** Forgets one key: a success, or a fresh start. */
  clear(key: K): void {
    this.#entries.delete(key);
  }

  /** Forgets every key outside `keep`, so tiles that left the active set start a new ladder on return. */
  retain(keep: ReadonlySet<K>): void {
    if (this.#entries.size === 0) return;
    for (const key of this.#entries.keys()) if (!keep.has(key)) this.#entries.delete(key);
  }

  reset(): void {
    this.#entries.clear();
  }
}
