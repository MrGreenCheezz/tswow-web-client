import type { ItemMetadata, ItemSubclassName } from "../gateway/ItemMetadata.js";
import type { EventBus, Unsubscribe, WorldPacketEvents } from "../world/EventBus.js";
import type { ItemTemplate } from "../world/QueryCacheProtocol.js";
import { spellIconUrl } from "./ui/IconImage.js";
import type { BenchmarkAsyncReadinessStats } from "./RenderBenchmarkReadiness.js";

export type { ItemMetadata };

/** What this client needs of the world; `CreatureQuerySource` carries the reasoning. */
export interface ItemQuerySource {
  itemTemplate(entry: number): ItemTemplate | undefined;
  readonly events: Pick<EventBus<WorldPacketEvents>, "on">;
}

export class ItemMetadataClient {
  readonly #baseUrl: string;
  readonly #cache = new Map<number, ItemMetadata>();
  readonly #requested = new Set<number>();
  readonly #httpPending = new Set<number>();
  readonly #wirePending = new Set<number>();
  /** Entries whose last request failed, and the time they may be asked for again. */
  readonly #failures = new Map<number, { attempts: number; after: number }>();
  #world: ItemQuerySource | undefined;
  #changed: (() => void) | undefined;
  #attachedUnsubscribe: Unsubscribe | undefined;
  readonly #abort = new AbortController();
  #disposed = false;
  #pending = 0;
  #success = 0;
  #error = 0;
  #generation = 0;
  readonly #now: () => number;
  /** `ItemSubClass.dbc` by `class:subclass`, once `/dbc/item-subclasses` has answered. */
  #subclasses: ReadonlyMap<string, ItemSubclassName> | undefined;
  #subclassesPending = false;
  #subclassFailures = 0;
  #subclassesRetryAt = 0;

  /** Immutable current ownership; unresolved world queries remain pending after HTTP settles. */
  get stats(): Readonly<BenchmarkAsyncReadinessStats> {
    const pending = new Set<number>([...this.#httpPending, ...this.#wirePending]);
    for (const [entry, failure] of this.#failures) {
      if (failure.after !== Infinity && !this.#httpPending.has(entry)) pending.add(entry);
    }
    return Object.freeze({
      pending: pending.size,
      success: this.#success,
      error: [...this.#failures.values()].filter((failure) => failure.after === Infinity).length,
      generation: this.#generation,
    });
  }

  get generation(): number {
    return this.#generation;
  }

  get revision(): number {
    return this.#generation;
  }

  constructor(gatewayWebSocketUrl: string, now: () => number = Date.now) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
    this.#now = now;
  }

  /**
   * Puts the world behind the dump: every entry asked about is also asked of the server.
   *
   * `data/items.json` is `item_template` as it stood when `npm run assets:items` last ran — 38,609
   * rows here, written at 14:32 on 23 August — and an item added after that is not in the file and
   * has no row for the route to hand back instead, the same as a creature's; `CreatureMetadata`
   * carries the measurement. The query answers from `item_template` at run time and carries the
   * display id, so the icon follows through `/item-icon/<displayInfoId>` even though the answer has
   * no `SpellIcon` id in it at all: 22,489 of the dump's 38,609 rows already have `iconId` 0 and go
   * that way today.
   */
  attach(world: ItemQuerySource, onChanged: () => void): void {
    if (this.#disposed) return;
    this.#world = world;
    this.#changed = onChanged;
    // Reattaching this instance replaces its subscription; dispose retires a whole character.
    this.#attachedUnsubscribe?.();
    this.#attachedUnsubscribe = world.events.on("QUERY_CACHE_CHANGED", (change) => {
      // `SMSG_CLIENTCACHE_VERSION` said the realm's data moved: everything may be asked again.
      if (change.kind === "cleared") {
        this.#requested.clear();
        this.#wirePending.clear();
        this.#failures.clear();
        return;
      }
      if (change.kind !== "item" || typeof change.id !== "number") return;
      this.#wirePending.delete(change.id);
      this.#absorb(change.id);
    });
  }

  get(entry: number): ItemMetadata | undefined {
    return this.#cache.get(entry);
  }

  iconUrl(item: ItemMetadata): string {
    // The row's own `SpellIcon` when it has one — 16,120 of 38,609 items do — and the display's
    // picture otherwise. Both are gateway routes now, so an item a module adds shows its icon
    // whichever of the two it names it by.
    return spellIconUrl(item.iconId, this.#baseUrl) ?? this.displayIconUrl(item.displayId);
  }

  displayIconUrl(displayId: number): string {
    return `${this.#baseUrl}/item-icon/${displayId}`;
  }

  /**
   * The word the stock item tooltip prints right of the slot — «Топор», «Латы», «Ткань» — for an
   * item's class and subclass: `ItemSubClass.DisplayName_lang`, unless the row's `DisplayFlags`
   * bit 0 says the client leaves it off (every ring, neck and trinket is armour «Разное» with that
   * bit; the reading is the dataset's pattern, see `ItemSubclassName`).
   *
   * Synchronous, because a Lua tooltip setter cannot wait: the first call asks
   * `/dbc/item-subclasses` and answers undefined, which is today's slot-only row, and a later
   * redraw has the word. A gateway process that predates the route answers 404, and the ask is
   * repeated no sooner than {@link ITEM_SUBCLASS_RETRY_MS} says — on demand, never on a timer — so
   * a restarted gateway is picked up by the next tooltip after the wait.
   */
  tooltipSubclassName(itemClass: number, subClass: number): string | undefined {
    const table = this.#subclasses;
    if (!table) {
      this.#loadSubclasses();
      return undefined;
    }
    const row = table.get(`${itemClass}:${subClass}`);
    return row && (row.displayFlags & 1) === 0 && row.name ? row.name : undefined;
  }

  #loadSubclasses(): void {
    if (this.#disposed || this.#subclassesPending || this.#now() < this.#subclassesRetryAt) return;
    this.#subclassesPending = true;
    void (async () => {
      try {
        const response = await fetch(`${this.#baseUrl}/dbc/item-subclasses?v=1`, { signal: this.#abort.signal });
        if (!response.ok) throw new Error(`Item subclass gateway returned ${response.status}`);
        const value: unknown = await response.json();
        if (!Array.isArray(value) || !value.every(isItemSubclassName)) {
          throw new Error("Item subclass gateway returned invalid data");
        }
        if (this.#disposed) return;
        this.#subclasses = new Map(value.map((row) => [`${row.itemClass}:${row.subClass}`, row]));
      } catch {
        if (this.#disposed) return;
        this.#subclassFailures += 1;
        const wait = ITEM_SUBCLASS_RETRY_MS[Math.min(this.#subclassFailures, ITEM_SUBCLASS_RETRY_MS.length) - 1]!;
        this.#subclassesRetryAt = this.#now() + wait;
      } finally {
        this.#subclassesPending = false;
      }
    })();
  }

  /** Release subscriptions and pending batches when the owning character leaves the world. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#attachedUnsubscribe?.();
    this.#attachedUnsubscribe = undefined;
    this.#world = undefined;
    this.#changed = undefined;
    this.#abort.abort();
    this.#cache.clear();
    this.#requested.clear();
    this.#httpPending.clear();
    this.#wirePending.clear();
    this.#failures.clear();
    this.#pending = 0;
    this.#generation++;
  }

  async load(entries: readonly number[]): Promise<boolean> {
    if (this.#disposed) return false;
    const now = this.#now();
    const missing = [...new Set(entries)].filter((entry) =>
      entry > 0 && !this.#requested.has(entry)
      && (this.#failures.get(entry)?.after ?? 0) <= now);
    if (missing.length === 0) return false;
    for (const entry of missing) {
      this.#requested.add(entry);
      this.#httpPending.add(entry);
      this.#failures.delete(entry);
    }
    this.#pending++;
    let settled = false;
    const settle = (success: boolean): void => {
      if (settled || this.#disposed) return;
      settled = true;
      this.#pending--;
      for (const entry of missing) this.#httpPending.delete(entry);
      this.#generation++;
      if (success) this.#success++;
      else this.#error++;
    };
    // Before the fetch, and for every entry rather than only for the ones the dump misses: the
    // wire is the newer of the two answers, and an unreachable gateway must not also cost the
    // names the world session could have given. `WorldClient.itemTemplate` remembers what it has
    // asked, so this is one `CMSG_ITEM_QUERY_SINGLE` per entry for the life of the session, even
    // across the five-second re-arm below.
    try {
      for (const entry of missing) {
        const template = this.#world?.itemTemplate(entry);
        if (this.#world && !template) this.#wirePending.add(entry);
        else this.#absorb(entry, false);
      }
    } catch (error) {
      for (const entry of missing) {
        this.#requested.delete(entry);
        this.#httpPending.delete(entry);
      }
      settle(false);
      throw error;
    }
    try {
      // In chunks, because the route refuses more than two hundred entries with a 400 and the
      // whole batch would then be re-armed and asked for again five seconds later, for ever. A
      // busy channel with item links in it reaches two hundred without trying.
      for (let offset = 0; offset < missing.length; offset += ENTRIES_PER_REQUEST) {
        const chunk = missing.slice(offset, offset + ENTRIES_PER_REQUEST);
        const response = await fetch(`${this.#baseUrl}/data/items?entries=${chunk.join(",")}`,
          { signal: this.#abort.signal });
        if (this.#disposed) return false;
        if (!response.ok) throw new Error(`Item metadata gateway returned ${response.status}`);
        const value: unknown = await response.json();
        if (this.#disposed) return false;
        if (!Array.isArray(value) || !value.every(isItemMetadata)) throw new Error("Item metadata gateway returned invalid data");
        for (const metadata of value) {
          const previous = this.#cache.get(metadata.entry);
          this.#cache.set(metadata.entry, metadata);
          if (!sameItemMetadata(previous, metadata)) this.#generation++;
          // The query went out before this fetch and may already have been answered; the wire is
          // the newer of the two and goes back on top. The caller repaints for the whole batch.
          this.#absorb(metadata.entry, false);
        }
      }
      settle(true);
      return true;
    } catch (error) {
      // Abort is expected for a retired owner; failures of the live owner retain their contract.
      if (this.#disposed) return false;
      // Rearmed so a failure is not permanent, but not before the cooldown: a player's visible
      // equipment is asked for once a frame, and re-arming immediately turned an unreachable
      // gateway into a request per frame — and, now that a unit is rebuilt when its equipment
      // changes, into a rebuilt character per frame as the list flapped between empty and full.
      for (const entry of missing) {
        this.#requested.delete(entry);
        this.#httpPending.delete(entry);
        const attempts = (this.#failures.get(entry)?.attempts ?? 0) + 1;
        const wait = ITEM_METADATA_RETRY_MS[attempts - 1];
        this.#failures.set(entry, {
          attempts,
          after: wait === undefined ? Infinity : this.#now() + wait,
        });
      }
      settle(false);
      throw error;
    }
  }

  /**
   * Puts one query answer over the dump's row, or in place of it.
   *
   * Eight fields, and they are the ones the answer can be newer about: the name, and the four a
   * tooltip and a paper doll are drawn from, plus the three `ItemMetadata` documents for Н1б.
   * `iconId` is not among them because the answer has none — it is a `SpellIcon` id and the wire
   * carries a display id — so a dump row keeps its icon and an entry the dump never had falls
   * through to `/item-icon/<displayInfoId>`, which is where 22,489 of the 38,609 dumped rows go
   * anyway. `stackable` is taken from the answer only when there is no dumped row to take it from,
   * for the same reason as the creature's type: the two come out of one table and agree.
   */
  #absorb(entry: number, repaint = true): void {
    const template = this.#world?.itemTemplate(entry);
    if (!template?.found) return;
    const known = this.#cache.get(entry);
    const next = {
      entry,
      name: template.name,
      displayId: template.displayInfoId,
      quality: template.quality,
      inventoryType: template.inventoryType,
      stackable: known?.stackable ?? template.stackable,
      iconId: known?.iconId ?? 0,
      itemClass: template.itemClass,
      subClass: template.subClass,
      soundOverrideSubclass: template.soundOverrideSubclass,
      material: template.material,
    };
    if (!sameItemMetadata(known, next)) {
      this.#cache.set(entry, next);
      this.#generation++;
    }
    if (repaint) this.#changed?.();
  }
}

/** Long enough that a gateway restart is not hammered, short enough to be unnoticed in play. */
const ITEM_METADATA_RETRY_MS: readonly number[] = [5_000, 15_000, 30_000];

/** What `GET /data/items` accepts in one request. */
const ENTRIES_PER_REQUEST = 200;

/**
 * Waits between asks of `/dbc/item-subclasses` after a failure; the last repeats. A minute at the
 * end because the likeliest failure is a gateway process older than the route, which only a
 * restart fixes, and the ask is one small request made only while tooltips are being drawn.
 */
const ITEM_SUBCLASS_RETRY_MS: readonly number[] = [5_000, 15_000, 60_000];

function isItemSubclassName(value: unknown): value is ItemSubclassName {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Number.isInteger(row.itemClass) && Number.isInteger(row.subClass)
    && typeof row.name === "string" && typeof row.verboseName === "string"
    && Number.isInteger(row.displayFlags);
}

function isItemMetadata(value: unknown): value is ItemMetadata {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.entry === "number" && typeof item.name === "string" && typeof item.displayId === "number"
    && typeof item.quality === "number" && typeof item.inventoryType === "number" && typeof item.stackable === "number" && typeof item.iconId === "number";
}

function sameItemMetadata(left: ItemMetadata | undefined, right: ItemMetadata): boolean {
  return left?.entry === right.entry && left.name === right.name && left.displayId === right.displayId
    && left.quality === right.quality && left.inventoryType === right.inventoryType
    && left.stackable === right.stackable && left.iconId === right.iconId
    && left.itemClass === right.itemClass && left.subClass === right.subClass
    && left.soundOverrideSubclass === right.soundOverrideSubclass && left.material === right.material;
}
