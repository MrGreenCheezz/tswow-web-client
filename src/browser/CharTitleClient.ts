/**
 * The character-title catalog (`/dbc/char-titles`, gateway/CharTitleMetadata.ts), fetched once.
 *
 * Held whole, as the emote and faction tables are: 142 short rows, wanted the moment the character
 * sheet opens or a name line asks `UnitPVPName`. The fetch starts when the stock world mounts and
 * never from inside a C-API read; until it lands — or when the gateway has no such route, which a
 * gateway process older than this file answers 404 — every title value is nil and the name line
 * is the bare name. A failed fetch is not retried: nothing else in the client depends on it.
 */

/** gateway/CharTitleMetadata.ts `CHAR_TITLES_VERSION`; tests/framexml-titles.test.mjs pins the two together. */
export const CHAR_TITLE_ROUTE_VERSION = 1;
export const CHAR_TITLE_ROUTE_PATH = `/dbc/char-titles?v=${CHAR_TITLE_ROUTE_VERSION}`;

export interface CharTitleRow {
  readonly id: number;
  /** The bit in PLAYER__FIELD_KNOWN_TITLES and the value of PLAYER_CHOSEN_TITLE. */
  readonly maskId: number;
  /** With its `%s` player-name placeholder. */
  readonly name: string;
  /** The declined female form; empty where the language has none. */
  readonly nameFemale: string;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Validate a route answer; undefined when its shape is not the route's. */
export function charTitleRows(data: unknown, version = CHAR_TITLE_ROUTE_VERSION): readonly CharTitleRow[] | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as { version?: unknown; titles?: unknown };
  if (value.version !== version || !Array.isArray(value.titles)) return undefined;
  const rows: CharTitleRow[] = [];
  for (const row of value.titles as readonly Partial<CharTitleRow>[]) {
    if (!row || !positiveInteger(row.id) || !positiveInteger(row.maskId) || typeof row.name !== "string") continue;
    rows.push(Object.freeze({
      id: row.id, maskId: row.maskId, name: row.name,
      nameFemale: typeof row.nameFemale === "string" ? row.nameFemale : "",
    }));
  }
  return Object.freeze(rows);
}

export class CharTitleClient {
  readonly #origin: string;
  readonly #fetch: typeof globalThis.fetch;
  #rows: readonly CharTitleRow[] | undefined;
  #pending: Promise<void> | undefined;
  /** Called once, when the rows land, so the picker can be redrawn from names instead of nils. */
  onLoaded: ((rows: readonly CharTitleRow[]) => void) | undefined;

  constructor(gatewayOrigin: string, fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)) {
    this.#origin = gatewayOrigin;
    this.#fetch = fetcher;
  }

  /** The one fetch this needs; only the first call does anything. Never rejects. */
  load(): Promise<void> {
    if (this.#rows) return Promise.resolve();
    this.#pending ??= (async () => {
      try {
        const response = await this.#fetch(new URL(CHAR_TITLE_ROUTE_PATH, this.#origin).href);
        const rows = response.ok ? charTitleRows(await response.json() as unknown) : undefined;
        if (rows) {
          this.#rows = rows;
          this.onLoaded?.(rows);
        }
      } catch {
        // No catalog: the picker stays hidden and UnitPVPName is the bare name.
      } finally {
        this.#pending = undefined;
      }
    })();
    return this.#pending;
  }

  get rows(): readonly CharTitleRow[] | undefined {
    return this.#rows;
  }
}
