import type { VendorCost, VendorCostCatalog } from "../gateway/VendorCostMetadata.js";

export type { VendorCost };

/** The client-side ItemExtendedCost snapshot used by the stock MerchantFrame C API. */
export class VendorCostClient {
  readonly #baseUrl: string;
  readonly #costs = new Map<number, VendorCost>();
  #pending: Promise<void> | undefined;
  #loaded = false;
  onLoaded: (() => void) | undefined;
  onStatus: ((message: string, error: boolean) => void) | undefined;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  /** Load once outside synchronous FrameXML reads; unknown costs remain unknown on failure. */
  load(): void {
    if (this.#loaded || this.#pending) return;
    this.#pending = (async () => {
      try {
        // The gateway invalidates its in-process DBC index on a dataset change. Bypass the
        // browser's one-hour HTTP cache so a reconnect or retry reaches that current index.
        const response = await fetch(`${this.#baseUrl}/dbc/vendor-costs?v=1`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Vendor cost gateway returned ${response.status}`);
        const catalog = await response.json() as VendorCostCatalog;
        if (!catalog || typeof catalog.costs !== "object" || catalog.costs === null) {
          throw new Error("malformed vendor cost catalog");
        }
        const costs = new Map<number, VendorCost>();
        for (const [key, cost] of Object.entries(catalog.costs)) {
          const id = Number(key);
          if (!Number.isSafeInteger(id) || id <= 0 || !cost || !Array.isArray(cost.items)
            || cost.items.length > 5 || ![cost.honor, cost.arena, cost.arenaBracket, cost.rating]
              .every((value) => Number.isSafeInteger(value) && value >= 0)
            || !cost.items.every((item) => Number.isSafeInteger(item.entry) && item.entry > 0
              && Number.isSafeInteger(item.count) && item.count > 0)) {
            throw new Error(`malformed vendor cost row ${key}`);
          }
          costs.set(id, cost);
        }
        this.#costs.clear();
        for (const [id, cost] of costs) this.#costs.set(id, cost);
        this.#loaded = true;
        this.onLoaded?.();
      } catch (error) {
        this.onStatus?.(`цены торговца: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    })();
    const pending = this.#pending;
    void pending.finally(() => {
      // A failed first request may retry when the vendor opens again. A successful load remains
      // cached for this world session through #loaded.
      if (this.#pending === pending) this.#pending = undefined;
    });
  }

  get ready(): boolean { return this.#loaded; }

  /** Synchronous and cache-only, as required by GetMerchantItemCostInfo/Item. */
  get(id: number): VendorCost | undefined { return this.#costs.get(id); }
}
