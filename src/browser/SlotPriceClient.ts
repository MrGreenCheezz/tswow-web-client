import type { SlotPriceCatalog } from "../gateway/SlotPrices.js";

export type { SlotPriceCatalog };

/**
 * Bank bag and stable slot prices, fetched once for the session.
 *
 * Both tables are `{row id: copper}` and tiny; the lookups are `bought+1` for the next bank
 * slot (`BankHandler.cpp`) and `MaxStabledPets+1` for the next stable slot (`NPCHandler.cpp`).
 * A missing row answers `undefined` so the window falls back to "the server names the price"
 * rather than printing a wrong one.
 */
export class SlotPriceClient {
  readonly #baseUrl: string;
  #bank = new Map<number, number>();
  #stable = new Map<number, number>();
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
        const response = await fetch(`${this.#baseUrl}/dbc/slot-prices?v=1`);
        if (!response.ok) throw new Error(`Slot price gateway returned ${response.status}`);
        const value = await response.json() as SlotPriceCatalog;
        if (typeof value.bank !== "object" || typeof value.stable !== "object") {
          throw new Error("malformed slot price data");
        }
        for (const [id, cost] of Object.entries(value.bank)) {
          if (Number.isInteger(cost) && cost >= 0) this.#bank.set(Number(id), cost);
        }
        for (const [id, cost] of Object.entries(value.stable)) {
          if (Number.isInteger(cost) && cost >= 0) this.#stable.set(Number(id), cost);
        }
        this.#loaded = true;
        this.onLoaded?.();
      } catch (error) {
        // Left unfetched rather than retried: without it the windows say the server names the
        // price, which is what they said before this slice.
        this.onStatus?.(`цены ячеек: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    })();
  }

  get ready(): boolean {
    return this.#loaded;
  }

  /** Copper for the next bank bag slot (`bought` already owned), or undefined. */
  bankSlotPrice(bought: number): number | undefined {
    return this.#bank.get(bought + 1);
  }

  /** Copper for the next stable slot (`slots` already owned), or undefined. */
  stableSlotPrice(slots: number): number | undefined {
    return this.#stable.get(slots + 1);
  }
}
