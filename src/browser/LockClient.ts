import { spellForLock, type LockCase, type LockData } from "../world/LockRules.js";

export type { LockData };

/**
 * Both lock tables, fetched once for the session.
 *
 * Small enough to hold whole — 388 locks and the 222 spells that open them — and the matching has
 * to happen where the spellbook is, so there is nothing to ask the gateway per object. Without it
 * a chest, an ore vein and a herb cannot be opened at all: they are not in the server's use
 * switch, and the spell it will accept is the one it computed from exactly this data.
 */
export class LockClient {
  readonly #baseUrl: string;
  #data: LockData | undefined;
  #pending: Promise<void> | undefined;
  onStatus: ((message: string, error: boolean) => void) | undefined;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  /** Starts the one fetch this needs. Safe to call repeatedly; only the first does anything. */
  load(): void {
    if (this.#data || this.#pending) return;
    this.#pending = (async () => {
      try {
        const response = await fetch(`${this.#baseUrl}/dbc/locks`);
        if (!response.ok) throw new Error(`Lock gateway returned ${response.status}`);
        const value = await response.json() as LockData;
        if (!value.locks || !Array.isArray(value.openers)) throw new Error("malformed lock data");
        this.#data = value;
      } catch (error) {
        // Left unfetched rather than retried every frame; nothing lockable can be opened until a
        // reconnection, and saying so once beats a request per rock.
        this.onStatus?.(`замки: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    })();
  }

  get ready(): boolean {
    return this.#data !== undefined;
  }

  /**
   * A lock's own cases, for callers that want to know what kind of lock it is rather than how to
   * open it. The tracking menu reads these: a skill case's `index` is the `LockType`, which is
   * herbalism at 2 and mining at 3, and that is exactly what a tracking spell's misc value carries.
   */
  casesOf(lockId: number): readonly LockCase[] {
    return this.#data?.locks[lockId] ?? [];
  }

  /** The spell that opens this lock for a player who knows these, or 0 when nothing does. */
  spellFor(lockId: number, known: Iterable<number>): number {
    if (!this.#data || lockId <= 0) return 0;
    return spellForLock(this.#data, lockId, known);
  }
}
