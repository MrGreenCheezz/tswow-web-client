import type { BarberStyle, BarberStyleCatalog } from "../gateway/BarberMetadata.js";

export type { BarberStyle, BarberStyleCatalog };

/**
 * BarberShopStyle rows, fetched once for the session.
 *
 * `CMSG_ALTER_APPEARANCE` carries row ids, not style values, and the server answers a row
 * that is not this race and sex with silence — so offering every row would turn most clicks
 * into nothing at all. The whole table is smaller than one texture, hence one fetch.
 */
export class BarberClient {
  readonly #baseUrl: string;
  #styles: BarberStyle[] = [];
  #loaded = false;
  #pending: Promise<void> | undefined;
  onStatus: ((message: string, error: boolean) => void) | undefined;
  onLoaded: (() => void) | undefined;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  /** Starts the one fetch this needs. Safe to call repeatedly; only the first does anything. */
  load(): void {
    if (this.#loaded || this.#pending) return;
    this.#pending = (async () => {
      try {
        const response = await fetch(`${this.#baseUrl}/dbc/barber-styles?v=1`);
        if (!response.ok) throw new Error(`Barber gateway returned ${response.status}`);
        const value = await response.json() as BarberStyleCatalog;
        if (!Array.isArray(value.styles)) throw new Error("malformed barber data");
        this.#styles = value.styles.filter((style) =>
          Number.isInteger(style.id) && style.id > 0 && Number.isInteger(style.data) && style.data >= 0);
        this.#loaded = true;
        this.onLoaded?.();
      } catch (error) {
        // Left unfetched rather than retried: without it the barber window says so and stays
        // shut, which is what it was before this slice.
        this.onStatus?.(`парикмахерская: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    })();
  }

  get ready(): boolean {
    return this.#loaded;
  }

  /** Rows of one type for this race and sex, in `Data` order — the only rows the server takes. */
  stylesFor(type: number, race: number, sex: number): BarberStyle[] {
    return this.#styles.filter((style) => style.type === type && style.race === race && style.sex === sex);
  }
}
