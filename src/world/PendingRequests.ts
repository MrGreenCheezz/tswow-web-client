/**
 * Requests the client has sent and is waiting to hear back about (WORK_PLAN 5.21, М-A4-6).
 *
 * A request opens an entry with what it replaced (`snapshot`) and how long an answer may take;
 * the server's answer confirms it, a refusal rolls it back, and an entry past its deadline counts
 * as absent — `has` answers by the clock alone, so a caller polled once a frame needs no timer.
 * `expire` is the explicit sweep for callers that must act on a lapse (restore the snapshot).
 *
 * Only for requests the core actually answers. Where it sends nothing (leaving the Wintergrasp
 * queue, deleting or re-saving an equipment set) the state stays optimistic and says so in place.
 */
export class PendingRequests<K, S = undefined> {
  readonly #entries = new Map<K, { readonly snapshot: S; readonly expiresAt: number }>();

  /** Opens (or re-opens) `key`; `ttlMs` may be `Infinity` for an answer with no deadline. */
  begin(key: K, snapshot: S, ttlMs: number, now: number): void {
    this.#entries.set(key, { snapshot, expiresAt: now + ttlMs });
  }

  /** Whether `key` still waits at `now`; an entry past its deadline no longer does. */
  has(key: K, now: number): boolean {
    const entry = this.#entries.get(key);
    return entry !== undefined && now < entry.expiresAt;
  }

  /** The answer came: closes `key` and returns what it replaced. */
  confirm(key: K): S | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    return entry.snapshot;
  }

  /** The request was refused: closes `key` and returns the snapshot to restore. */
  rollback(key: K): S | undefined {
    return this.confirm(key);
  }

  /** Closes every entry past its deadline, handing each snapshot to `onExpire`. */
  expire(now: number, onExpire?: (key: K, snapshot: S) => void): void {
    for (const [key, entry] of this.#entries) {
      if (now < entry.expiresAt) continue;
      this.#entries.delete(key);
      onExpire?.(key, entry.snapshot);
    }
  }

  /** Forgets everything (a new world, a new set list). */
  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}
