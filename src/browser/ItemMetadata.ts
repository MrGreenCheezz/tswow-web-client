import type { ItemMetadata } from "../gateway/ItemMetadata.js";
import type { EventBus, WorldPacketEvents } from "../world/EventBus.js";
import type { ItemTemplate } from "../world/QueryCacheProtocol.js";
import { spellIconUrl } from "./ui/IconImage.js";

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
  /** Entries whose last request failed, and the time they may be asked for again. */
  readonly #retryAfter = new Map<number, number>();
  #world: ItemQuerySource | undefined;
  #changed: (() => void) | undefined;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
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
    this.#world = world;
    this.#changed = onChanged;
    world.events.on("QUERY_CACHE_CHANGED", (change) => {
      // `SMSG_CLIENTCACHE_VERSION` said the realm's data moved: everything may be asked again.
      if (change.kind === "cleared") {
        this.#requested.clear();
        this.#retryAfter.clear();
        return;
      }
      if (change.kind !== "item" || typeof change.id !== "number") return;
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

  async load(entries: readonly number[]): Promise<boolean> {
    const now = Date.now();
    const missing = [...new Set(entries)].filter((entry) =>
      entry > 0 && !this.#requested.has(entry) && (this.#retryAfter.get(entry) ?? 0) <= now);
    if (missing.length === 0) return false;
    for (const entry of missing) {
      this.#requested.add(entry);
      this.#retryAfter.delete(entry);
    }
    // Before the fetch, and for every entry rather than only for the ones the dump misses: the
    // wire is the newer of the two answers, and an unreachable gateway must not also cost the
    // names the world session could have given. `WorldClient.itemTemplate` remembers what it has
    // asked, so this is one `CMSG_ITEM_QUERY_SINGLE` per entry for the life of the session, even
    // across the five-second re-arm below.
    for (const entry of missing) this.#world?.itemTemplate(entry);
    try {
      // In chunks, because the route refuses more than two hundred entries with a 400 and the
      // whole batch would then be re-armed and asked for again five seconds later, for ever. A
      // busy channel with item links in it reaches two hundred without trying.
      for (let offset = 0; offset < missing.length; offset += ENTRIES_PER_REQUEST) {
        const chunk = missing.slice(offset, offset + ENTRIES_PER_REQUEST);
        const response = await fetch(`${this.#baseUrl}/data/items?entries=${chunk.join(",")}`);
        if (!response.ok) throw new Error(`Item metadata gateway returned ${response.status}`);
        const value: unknown = await response.json();
        if (!Array.isArray(value) || !value.every(isItemMetadata)) throw new Error("Item metadata gateway returned invalid data");
        for (const metadata of value) {
          this.#cache.set(metadata.entry, metadata);
          // The query went out before this fetch and may already have been answered; the wire is
          // the newer of the two and goes back on top. The caller repaints for the whole batch.
          this.#absorb(metadata.entry, false);
        }
      }
      return true;
    } catch (error) {
      // Rearmed so a failure is not permanent, but not before the cooldown: a player's visible
      // equipment is asked for once a frame, and re-arming immediately turned an unreachable
      // gateway into a request per frame — and, now that a unit is rebuilt when its equipment
      // changes, into a rebuilt character per frame as the list flapped between empty and full.
      const retryAt = Date.now() + RETRY_DELAY_MS;
      for (const entry of missing) {
        this.#requested.delete(entry);
        this.#retryAfter.set(entry, retryAt);
      }
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
    this.#cache.set(entry, {
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
    });
    if (repaint) this.#changed?.();
  }
}

/** Long enough that a gateway restart is not hammered, short enough to be unnoticed in play. */
const RETRY_DELAY_MS = 5_000;

/** What `GET /data/items` accepts in one request. */
const ENTRIES_PER_REQUEST = 200;

function isItemMetadata(value: unknown): value is ItemMetadata {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.entry === "number" && typeof item.name === "string" && typeof item.displayId === "number"
    && typeof item.quality === "number" && typeof item.inventoryType === "number" && typeof item.stackable === "number" && typeof item.iconId === "number";
}
