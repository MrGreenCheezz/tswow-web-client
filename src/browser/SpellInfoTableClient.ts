import { withMetadataGeneration } from "./GatewayGeneration.js";
import { SPELL_INFO_TABLE_PATH, SPELL_INFO_TABLE_VERSION, SpellInfoTable, type SpellInfoRow } from "../world/SpellInfoTable.js";

/**
 * 3.43 (15.11, names10): the browser half of `/dbc/spell-info` (gateway/SpellInfoTableRoute.ts, world/SpellInfoTable.ts):
 * every spell's compact row, so the by-id spell globals answer for any spell from the interface's first Lua line, as
 * Wow.exe's do with Spell.dbc in memory.
 *
 * - `start()` asks once, at the start of a world entry (EnterWorld.ts, beside the loading screen): the table is fetched
 *   while the realm login, the terrain and the interface corpus load. A page keeps the table it has: a second entry
 *   in the same page costs nothing, and a new page's ask is answered from the browser's HTTP cache (immutable under the
 *   gateway's `mg=`, else a 304 by the bytes' tag).
 * - `ready(cap)` is what the interface mount waits for before its first Lua line (EnterWorld.ts): the table, a final
 *   answer without it, or `cap` milliseconds — after which the mount goes on and every by-id answer is what it was
 *   before (the cached `/dbc/spells` rows only) until the table lands.
 * - A gateway older than the route answers 404: no table, the old behaviour, asked again at the next entry. Any other
 *   failure is the same.
 */

export type SpellInfoTableState = "idle" | "loading" | "ready" | "absent";

/** How long the interface mount waits for the table (measured cold on a loopback gateway: see names10's report). */
export const SPELL_INFO_TABLE_WAIT_MS = 5_000;

export class SpellInfoTableClient {
  readonly origin: string;
  readonly #fetch: typeof globalThis.fetch;
  #state: SpellInfoTableState = "idle";
  #table: SpellInfoTable | undefined;
  #pending: Promise<void> | undefined;

  constructor(origin: string, fetcher: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init)) {
    this.origin = origin;
    this.#fetch = fetcher;
  }

  get state(): SpellInfoTableState {
    return this.#state;
  }

  get table(): SpellInfoTable | undefined {
    return this.#table;
  }

  /** The spell's compact row; undefined until the table lands, or for an id the dataset has no row for. */
  row(id: number): SpellInfoRow | undefined {
    return this.#table?.row(id);
  }

  /** Asks for the table unless it is here or on its way (a failed ask is asked again). */
  start(): Promise<void> {
    if (this.#state === "ready") return Promise.resolve();
    if (this.#pending) return this.#pending;
    this.#state = "loading";
    const pending = this.#load().then((table) => {
      this.#table = table;
      this.#state = table ? "ready" : "absent";
    }, () => {
      this.#state = "absent";
    }).finally(() => {
      if (this.#pending === pending) this.#pending = undefined;
    });
    this.#pending = pending;
    return pending;
  }

  async #load(): Promise<SpellInfoTable | undefined> {
    const url = withMetadataGeneration(`${this.origin}${SPELL_INFO_TABLE_PATH}?v=${SPELL_INFO_TABLE_VERSION}`);
    const response = await this.#fetch(url);
    if (!response.ok) return undefined;
    return SpellInfoTable.decode(await response.arrayBuffer());
  }

  /** Resolves when the table is here, the gateway has answered without it, or after `cap` ms; true when it is here. */
  async ready(cap = SPELL_INFO_TABLE_WAIT_MS): Promise<boolean> {
    const pending = this.start();
    if (this.#state !== "loading") return this.#state === "ready";
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pending, new Promise<void>((resolve) => { timer = setTimeout(resolve, cap); })]);
    if (timer !== undefined) clearTimeout(timer);
    return this.#table !== undefined;
  }
}

let current: SpellInfoTableClient | undefined;

/** The http(s) origin of a gateway URL (`ws://…`, `wss://…` or an http origin). */
function httpOrigin(gateway: string): string | undefined {
  try {
    const url = new URL(gateway);
    url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
    return url.origin;
  } catch {
    return undefined;
  }
}

/** The page's one table for this gateway (a WebSocket URL or an origin); undefined without one. */
export function spellInfoTableClient(gateway: string | undefined): SpellInfoTableClient | undefined {
  const origin = gateway === undefined ? undefined : httpOrigin(gateway);
  if (!origin) return undefined;
  if (current?.origin !== origin) current = new SpellInfoTableClient(origin);
  return current;
}

/** The table of the page's current gateway, if it has landed (no ask is started here). */
export function loadedSpellInfoRow(gateway: string | undefined, id: number): SpellInfoRow | undefined {
  const origin = gateway === undefined ? undefined : httpOrigin(gateway);
  return origin !== undefined && current?.origin === origin ? current.row(id) : undefined;
}

/** For tests. */
export function resetSpellInfoTableClient(): void {
  current = undefined;
}
