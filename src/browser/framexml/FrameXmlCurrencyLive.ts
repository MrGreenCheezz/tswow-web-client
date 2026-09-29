/**
 * The live half of the currency C API (FrameXmlCurrency.ts): the player's replicated fields, the items
 * in the currency-token slots, and the gateway's `/dbc/currencies` catalog.
 *
 * Kept apart from LiveWorldSeam so the seam only constructs, attaches and ticks the model.
 */
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { readField } from "../../world/Fields.js";
import type { WorldObjectState, WorldState } from "../../world/WorldState.js";
import { fieldGuid } from "../Inventory.js";
import {
  FRAMEXML_CURRENCY_CATALOG_VERSION,
  FrameXmlCurrencyModel,
  parseFrameXmlCurrencyCatalog,
  type FrameXmlCurrencyCatalog,
  type FrameXmlCurrencyCatalogSource,
  type FrameXmlCurrencySnapshot,
} from "./FrameXmlCurrency.js";

/** `CURRENCYTOKEN_SLOT_END - CURRENCYTOKEN_SLOT_START` (Player.h:623-624): 32 guid pairs. */
export const FRAMEXML_CURRENCY_TOKEN_SLOTS = 32;

/**
 * The player's currency facts, or undefined while their own object is absent.
 *
 * A field this client never received reads as 0: an object's create block carries only the non-zero
 * words, so an absent PLAYER_FIELD_HONOR_CURRENCY on a present player *is* zero. A token slot whose
 * item object has not arrived yet contributes nothing — its entry is on that object, so it cannot be
 * attributed to any currency until it arrives. A present item without ITEM_FIELD_STACK_COUNT is one,
 * as Inventory.ts `stackCount` reads it.
 */
export function frameXmlCurrencySnapshot(state: WorldState | undefined): FrameXmlCurrencySnapshot | undefined {
  const self = state?.selfGuid;
  const player: WorldObjectState | undefined = self === undefined ? undefined : state?.objects.get(self);
  if (!state || !player) return undefined;
  const held = new Map<number, number>();
  const first = UPDATE_FIELDS.PLAYER_FIELD_CURRENCYTOKEN_SLOT_1.offset;
  for (let index = 0; index < FRAMEXML_CURRENCY_TOKEN_SLOTS; index++) {
    const guid = fieldGuid(player, first + index * 2);
    if (guid === 0n) continue;
    const item = state.objects.get(guid);
    const entry = item ? readField(item, "OBJECT_FIELD_ENTRY") : undefined;
    if (!item || entry === undefined || entry <= 0) continue;
    const count = readField(item, "ITEM_FIELD_STACK_COUNT") ?? 1;
    held.set(entry, (held.get(entry) ?? 0) + (count >>> 0));
  }
  return {
    knownMask: readField(player, "PLAYER_FIELD_KNOWN_CURRENCIES") ?? 0n,
    honor: (readField(player, "PLAYER_FIELD_HONOR_CURRENCY") ?? 0) >>> 0,
    arena: (readField(player, "PLAYER_FIELD_ARENA_CURRENCY") ?? 0) >>> 0,
    held,
  };
}

/**
 * `/dbc/currencies?v=1`, fetched once. A gateway built before the route answers 404: the catalog then
 * stays absent, the list stays empty and the currency tab stays hidden, as for a character with none.
 * A failed fetch is not retried in this mount.
 */
export class FrameXmlCurrencyCatalogClient implements FrameXmlCurrencyCatalogSource {
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  #current: FrameXmlCurrencyCatalog | undefined;
  #pending: Promise<FrameXmlCurrencyCatalog | undefined> | undefined;

  constructor(gatewayOrigin: string, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.#origin = gatewayOrigin.replace(/\/+$/, "");
    this.#fetch = fetcher;
  }

  get current(): FrameXmlCurrencyCatalog | undefined { return this.#current; }

  load(onReady: () => void): void {
    if (this.#pending) return;
    const url = new URL("/dbc/currencies", this.#origin);
    url.searchParams.set("v", String(FRAMEXML_CURRENCY_CATALOG_VERSION));
    this.#pending = this.#fetch(url.href, { headers: { accept: "application/json" } })
      .then(async (response) => (response.ok ? parseFrameXmlCurrencyCatalog(await response.json()) : undefined))
      .then((catalog) => {
        if (!catalog) {
          console.warn("[FrameXML currency] /dbc/currencies is unavailable; the currency tab stays hidden");
          return undefined;
        }
        this.#current = catalog;
        onReady();
        return catalog;
      })
      .catch((error: unknown) => {
        console.warn(`[FrameXML currency] /dbc/currencies failed: ${String(error)}`);
        return undefined;
      });
  }

  /** The one fetch's outcome; undefined at once when none was started. */
  settled(): Promise<FrameXmlCurrencyCatalog | undefined> {
    return this.#pending ?? Promise.resolve(undefined);
  }
}

/** What LiveWorldSeam's context offers the model; every read is cache-only. */
export interface FrameXmlCurrencyLiveHost {
  readonly world: () => { readonly state: WorldState; readonly itemTemplates?: ReadonlyMap<number, { readonly name?: string }> } | undefined;
  readonly itemInfo?: (entry: number) => { readonly name: string; readonly texture?: string } | undefined;
  readonly itemTexture?: (entry: number) => string | undefined;
  readonly prefetchQuestMetadata?: (itemIds: readonly number[], spellIds: readonly number[], onChanged: () => void) => void;
}

/** The live model. Its catalog arrives later, from the world mount (FrameXmlTokenOwner.ts). */
export function createLiveFrameXmlCurrency(host: FrameXmlCurrencyLiveHost): FrameXmlCurrencyModel {
  return new FrameXmlCurrencyModel({
    snapshot: () => {
      const state = host.world()?.state;
      return state && typeof state.objects?.get === "function" ? frameXmlCurrencySnapshot(state) : undefined;
    },
    item: (entry) => {
      const info = host.itemInfo?.(entry);
      const templates = host.world()?.itemTemplates;
      const name = info?.name ?? (templates instanceof Map ? templates.get(entry)?.name : undefined);
      const texture = host.itemTexture?.(entry) ?? info?.texture;
      return { name, texture };
    },
    ...(host.prefetchQuestMetadata ? {
      prefetch: (entries: readonly number[], onChanged: () => void) => host.prefetchQuestMetadata?.(entries, [], onChanged),
    } : {}),
  });
}
