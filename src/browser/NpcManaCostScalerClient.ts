import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";

/**
 * 3.43 (15.11): gtNPCManaCostScaler (`/dbc/npc-mana-cost-scaler`, gateway/NpcManaCostScalerMetadata.ts), the table
 * Wow.exe 0x008012f0 scales a non-player unit's cost by (ui/SpellTextCost.ts step 6). Until it lands — or from a gateway
 * older than the route, which answers 404 while the catalog client retries — such a cost stays unknown, as before.
 */

/** gateway/NpcManaCostScalerMetadata.ts `NPC_MANA_COST_SCALER_VERSION`; tests/spell-text-cost.test.mjs pins the two. */
export const NPC_MANA_COST_SCALER_ROUTE_VERSION = 1;
export const NPC_MANA_COST_SCALER_ROUTE_PATH = `/dbc/npc-mana-cost-scaler?v=${NPC_MANA_COST_SCALER_ROUTE_VERSION}`;

/** Validate a route answer: the scaler of level `index + 1`; undefined when its shape is not the route's. */
export function npcManaCostScalerFrom(data: unknown, version = NPC_MANA_COST_SCALER_ROUTE_VERSION): readonly number[] | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as Record<string, unknown>;
  const scaler = value.scaler;
  if (value.version !== version || !Array.isArray(scaler) || scaler.length === 0 || scaler.length > 8192) return undefined;
  if (!scaler.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return undefined;
  return Object.freeze([...scaler as number[]]);
}

export class NpcManaCostScalerClient {
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<readonly number[]>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, NPC_MANA_COST_SCALER_ROUTE_PATH,
      (data) => npcManaCostScalerFrom(data), options);
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  /** The table; undefined until it lands. Starts the first cycle, never restarts one that gave up. */
  table(): readonly number[] | undefined {
    const table = this.#catalog.value;
    if (!table) void this.#catalog.load();
    return table;
  }
}

let current: NpcManaCostScalerClient | undefined;

/** The page's one table for this gateway origin. */
export function npcManaCostScalerClient(gatewayOrigin: string | undefined): NpcManaCostScalerClient | undefined {
  if (!gatewayOrigin) return undefined;
  if (current?.origin !== gatewayOrigin) current = new NpcManaCostScalerClient(gatewayOrigin);
  return current;
}
