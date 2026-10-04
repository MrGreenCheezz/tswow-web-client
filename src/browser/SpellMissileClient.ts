import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";
import {
  SPELL_MISSILE_CATALOG_PATHNAME, SPELL_MISSILE_CATALOG_VERSION, spellMissileCatalogFrom, type SpellMissileCatalog,
} from "../world/SpellMissileDbc.js";

/**
 * 11.02-E: the missile tables in the page — SpellMissile.dbc and the SpellMissileID of each spell that
 * names one, from `GET /dbc/spell-missiles?v=1` (world/SpellMissileDbc.ts), all rows at once (≈6 KB).
 *
 * Asked lazily, from the gateway origin the page already knows (`game.gatewayOrigin`): the first time a
 * pet or vehicle bar arrives (`WorldClient` primes the solver on SMSG_PET_SPELLS) or a cast asks about a
 * spell. Until the tables land — and against a gateway without the route, which answers 404 — no spell is
 * a trajectory spell and every cast is the packet it was before slice E. `RetryingCatalogClient` keeps
 * the schedule: a 404 is asked once more after 15 s, then not again until the next `prime`.
 */

export const SPELL_MISSILE_ROUTE_PATH = `${SPELL_MISSILE_CATALOG_PATHNAME}?v=${SPELL_MISSILE_CATALOG_VERSION}`;

export class SpellMissileClient {
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<SpellMissileCatalog>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, SPELL_MISSILE_ROUTE_PATH, (data) => spellMissileCatalogFrom(data), options);
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  get catalog(): SpellMissileCatalog | undefined {
    return this.#catalog.value;
  }

  /** The first cycle; afterwards nothing new. */
  load(): Promise<void> {
    return this.#catalog.load();
  }

  /** A new cycle after `failed` (a gateway restarted since); nothing new while loading or loaded. */
  retry(): Promise<void> {
    return this.#catalog.retry();
  }

  stop(): void {
    this.#catalog.stop();
  }
}

let current: SpellMissileClient | undefined;

/** The page's client for this gateway origin (another origin is another client). */
export function spellMissileClient(origin: string, options: RetryingCatalogOptions = {}): SpellMissileClient {
  if (current?.origin !== origin) {
    current?.stop();
    current = new SpellMissileClient(origin, options);
  }
  return current;
}

/**
 * The tables of this origin, undefined until they land. `retry` starts a new cycle after a failed one
 * (a bar arriving); without it only the first cycle is ever started (a cast asking).
 */
export function spellMissiles(origin: string | undefined, retry = false): SpellMissileCatalog | undefined {
  if (origin === undefined) return undefined;
  const client = spellMissileClient(origin);
  if (client.catalog === undefined) void (retry ? client.retry() : client.load());
  return client.catalog;
}

/** Tests: forget the page's client. */
export function forgetSpellMissileClient(): void {
  current?.stop();
  current = undefined;
}
