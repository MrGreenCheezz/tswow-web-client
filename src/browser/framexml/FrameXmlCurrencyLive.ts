/**
 * The live half of the currency C API (FrameXmlCurrency.ts): the player's replicated fields, the items
 * in the currency-token slots, and the gateway's `/dbc/currencies` catalog.
 *
 * Kept apart from LiveWorldSeam so the seam only constructs, attaches and ticks the model.
 */
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { readField } from "../../world/Fields.js";
import type { WorldObjectState, WorldState } from "../../world/WorldState.js";
import { SELF, type WorldStore } from "../../world/WorldStore.js";
import { fieldGuid, inventoryWatch, type InventoryWatch } from "../Inventory.js";
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
  /** P1-17: the world's store, whose field edges move the currency revision. */
  readonly store?: () => WorldStore | undefined;
  /**
   * P1-17: a monotonic number that moves whenever anything `itemInfo`, `itemTexture` or
   * `world().itemTemplates` answers for an item may have changed. `ItemMetadataClient.revision` alone
   * is not that: the live `itemInfo` falls back to `WorldClient.itemTemplates`, which has no revision
   * (its edge is the QUERY_CACHE_CHANGED event). The live mount therefore passes none.
   */
  readonly itemRevision?: () => number;
  /**
   * P1-17: without `itemRevision` (the live mount), names and icons are re-read on a 60 ms boundary of
   * this clock (ms), so the revision moves every 60 ms and the list is rebuilt at most that often.
   */
  readonly monotonic?: () => number;
}

/** Without an item revision, the item cache is re-read on the seam's own poll boundary. */
const CURRENCY_ITEM_POLL_MS = 60;

/**
 * P1-17 (UI-7): the revision behind the live currency model — a monotonic sum that moves whenever
 * an input of `frameXmlCurrencySnapshot` or of the item reads may have changed:
 *
 * * its own count: the 64 words of PLAYER_FIELD_CURRENCYTOKEN_SLOT_1, the 2 of
 *   PLAYER_FIELD_KNOWN_CURRENCIES, PLAYER_FIELD_HONOR_CURRENCY and PLAYER_FIELD_ARENA_CURRENCY, a new
 *   store, world state or player object;
 * * the store's inventory watch (Inventory.ts): every field of every item object, its arrival and
 *   removal — the token stacks and entries;
 * * the item cache: `itemRevision`, or else the 60 ms boundary of `monotonic`.
 *
 * Undefined — rebuild on every read, the old behaviour — while detached, without a store, with a store
 * double that lacks the primitives (`fieldRange`, `object`, `events`), with a store that no longer
 * observes its state or one that is not the world's, and with neither item clock.
 * Changes arrive with `WorldStore.flush`, once a frame, as the inventory's do.
 */
export class CurrencyRevision {
  readonly #host: FrameXmlCurrencyLiveHost;
  #own = 0;
  #attached = false;
  #store: WorldStore | undefined;
  #watch: InventoryWatch | undefined;
  readonly #stops: (() => void)[] = [];
  #state: WorldState | undefined;
  #player: WorldObjectState | undefined;
  #inventoryBase = 0;
  #inventoryLast = Number.NEGATIVE_INFINITY;
  #itemsBase = 0;
  #itemsLast = Number.NEGATIVE_INFINITY;

  constructor(host: FrameXmlCurrencyLiveHost) {
    this.#host = host;
  }

  /** Subscriptions are taken on the first read after this, against the store of that moment. */
  attach(): void {
    this.#attached = true;
    this.#own += 1;
  }

  detach(): void {
    this.#attached = false;
    this.#release();
    this.#store = undefined;
  }

  /** How many store subscriptions are held now (tests). */
  get subscriptions(): number {
    return this.#stops.length;
  }

  revision(): number | undefined {
    if (!this.#attached) return undefined;
    const store = this.#host.store?.();
    if (store !== this.#store) {
      this.#release();
      this.#store = store;
      this.#own += 1;
      if (store) this.#subscribe(store);
    }
    const watch = this.#watch;
    if (!store || !watch || store.state.observer !== store) return undefined;
    const state = this.#host.world()?.state;
    if (state !== store.state) return undefined;
    const self = state.selfGuid;
    const player = self === undefined ? undefined : state.objects.get(self);
    if (state !== this.#state || player !== this.#player) {
      this.#state = state;
      this.#player = player;
      this.#own += 1;
    }
    const items = this.#host.itemRevision?.()
      ?? (this.#host.monotonic ? Math.floor(this.#host.monotonic() / CURRENCY_ITEM_POLL_MS) : undefined);
    if (items === undefined || !Number.isFinite(items)) return undefined;
    // Each term only grows, so the sum moves whenever one does. A term that went back (a new store's
    // watch, a replaced item cache) is lifted past its last value, so it reads as a change too.
    let inventory = watch.revision + this.#inventoryBase;
    if (inventory < this.#inventoryLast) {
      this.#inventoryBase += this.#inventoryLast - inventory + 1;
      inventory = this.#inventoryLast + 1;
    }
    this.#inventoryLast = inventory;
    let cache = items + this.#itemsBase;
    if (cache < this.#itemsLast) {
      this.#itemsBase += this.#itemsLast - cache + 1;
      cache = this.#itemsLast + 1;
    }
    this.#itemsLast = cache;
    return this.#own + inventory + cache;
  }

  #subscribe(store: WorldStore): void {
    const primitives = store as Partial<Pick<WorldStore, "field" | "fieldRange" | "object" | "events" | "state">>;
    if (typeof primitives.fieldRange !== "function" || typeof primitives.field !== "function"
      || typeof primitives.object !== "function" || !primitives.events || !primitives.state) return;
    const bump = (): void => { this.#own += 1; };
    this.#stops.push(store.fieldRange(SELF, "PLAYER_FIELD_CURRENCYTOKEN_SLOT_1", bump));
    this.#stops.push(store.fieldRange(SELF, "PLAYER_FIELD_KNOWN_CURRENCIES", bump));
    this.#stops.push(store.field(SELF, "PLAYER_FIELD_HONOR_CURRENCY", bump));
    this.#stops.push(store.field(SELF, "PLAYER_FIELD_ARENA_CURRENCY", bump));
    this.#watch = inventoryWatch(store);
  }

  #release(): void {
    for (const stop of this.#stops.splice(0)) stop();
    // The inventory watch belongs to its store (Inventory.ts `inventoryWatch`), not to this revision.
    this.#watch = undefined;
    this.#state = undefined;
    this.#player = undefined;
  }
}

/** The live model. Its catalog arrives later, from the world mount (FrameXmlTokenOwner.ts). */
export function createLiveFrameXmlCurrency(host: FrameXmlCurrencyLiveHost): FrameXmlCurrencyModel {
  const revision = new CurrencyRevision(host);
  return new FrameXmlCurrencyModel({
    revision: () => revision.revision(),
    attach: () => revision.attach(),
    detach: () => revision.detach(),
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
