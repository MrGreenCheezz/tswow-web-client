/**
 * The 3.3.5a currency C API behind stock Blizzard_TokenUI (CharacterFrame's «Валюта», tab 5) and the
 * backpack's token strip, and the two events MainMenuBar.lua answers by loading that add-on.
 *
 * What a currency is, settled against TrinityCore (tswow/cores/TrinityCore): an item. CurrencyTypes.dbc
 * names the item, its CurrencyCategory heading and its bit in the player's PLAYER_FIELD_KNOWN_CURRENCIES
 * (`SetFlag64(PLAYER_FIELD_KNOWN_CURRENCIES, 1LL << (BitIndex-1))`, Player::AddKnownCurrency,
 * Player.cpp:26092). The bit is set when a token lands in one of the 32 currency-token slots
 * (CURRENCYTOKEN_SLOT_START 118 .. END 150, Player.h:623-624; Player.cpp:12383-12385) and for honor and
 * arena points when their totals become non-zero (SetHonorPoints/SetArenaPoints, Player.cpp:7128-7145,
 * items 43308/43307, Player.h:820-821). The amount of an ordinary token is the stack in those slots,
 * which reach this client as PLAYER_FIELD_CURRENCYTOKEN_SLOT_1 guids; honor and arena points are the
 * player's own PLAYER_FIELD_HONOR_CURRENCY and PLAYER_FIELD_ARENA_CURRENCY.
 *
 * The stock Lua this answers (Blizzard_TokenUI.lua, MainMenuBar.lua:193-236, TokenFrame XML popup):
 *
 * * `GetCurrencyListSize()` and `GetCurrencyListInfo(index)` → `name, isHeader, isExpanded, isUnused,
 *   isWatched, count, extraCurrencyType, icon, itemID` (Blizzard_TokenUI.lua:63-68). extraCurrencyType
 *   is 1 for arena and 2 for honor points (:99-110), 0 otherwise (MainMenuBar.lua:200-203 compares it).
 * * `ExpandCurrencyList(index, 0|1)` for a heading (:251-257).
 * * `SetCurrencyUnused(index, 0|1)` and `SetCurrencyBackpack(index, 0|1)` from the popup's two check
 *   boxes and the TOKENWATCHTOGGLE click (Blizzard_TokenUI.xml:328-378, .lua:260-273).
 * * `GetBackpackCurrencyInfo(i)` → `name, count, extraCurrencyType, icon, itemID` (.lua:180).
 *   `GetNumWatchedTokens`, `BackpackTokenFrame_Update` and the three-token cap (`MAX_WATCHED_TOKENS`)
 *   are the add-on's own Lua, not C.
 * * KNOWN_CURRENCY_TYPES_UPDATE and CURRENCY_DISPLAY_UPDATE (MainMenuBar.lua:176-177).
 *
 * The two per-currency choices have no packet here: TrinityCore 3.3.5 defines no currency-flags opcode
 * (Opcodes.h has none; 0x4B8 is `CMSG_UNUSED5` → Handle_NULL) and stores nothing but the known bits
 * (Player.cpp:17739/19856). So «unused», «show on backpack» and a collapsed heading are this session's
 * view state, as the client keeps them; they are never sent and do not survive a reload.
 *
 * Nothing is guessed. A currency whose CurrencyTypes row names a heading CurrencyCategory.dbc does not
 * have (the dataset has two: categories 24 and 2089878896) is not listed, since it has no heading to
 * list it under; a name or icon not yet in the item cache is nil until it arrives, and its arrival is a
 * CURRENCY_DISPLAY_UPDATE. The list order is the tables' record order (CurrencyCatalog.ts).
 *
 * Events are held until `release()`: the stock answer to either event is `TokenFrame_LoadUI()` followed
 * at once by `TokenFrame_Update()` (MainMenuBar.lua:224-235), which only exists once Blizzard_TokenUI
 * has loaded, and this host's LoadAddOn cannot load synchronously (FrameXmlAddonRuntime.ts). The token
 * owner (FrameXmlTokenOwner.ts) loads the add-on when `onDemand` says there is something to show, and
 * releases the events after its gate.
 */

/** `CurrencyCategory.dbc`: id, flags and the localized heading. */
export interface FrameXmlCurrencyCategory {
  readonly id: number;
  readonly flags: number;
  readonly name: string;
}

/** `CurrencyTypes.dbc`: the token item, its heading and its PLAYER_FIELD_KNOWN_CURRENCIES bit. */
export interface FrameXmlCurrencyType {
  readonly id: number;
  readonly itemId: number;
  readonly categoryId: number;
  readonly bitIndex: number;
}

/** The gateway's `/dbc/currencies` answer (src/gateway/CurrencyCatalog.ts). */
export interface FrameXmlCurrencyCatalog {
  readonly version: number;
  readonly categories: readonly FrameXmlCurrencyCategory[];
  readonly types: readonly FrameXmlCurrencyType[];
}

export const FRAMEXML_CURRENCY_CATALOG_VERSION = 1;

/** `ITEM_ARENA_POINTS_ID` and `ITEM_HONOR_POINTS_ID` (Player.h:820-821). */
export const FRAMEXML_CURRENCY_ARENA_ITEM = 43307;
export const FRAMEXML_CURRENCY_HONOR_ITEM = 43308;

/** The player facts the list is built from; see the module doc for each one's field. */
export interface FrameXmlCurrencySnapshot {
  /** PLAYER_FIELD_KNOWN_CURRENCIES. */
  readonly knownMask: bigint;
  /** PLAYER_FIELD_HONOR_CURRENCY and PLAYER_FIELD_ARENA_CURRENCY. */
  readonly honor: number;
  readonly arena: number;
  /** Item entry → total stack held in the currency-token slots. */
  readonly held: ReadonlyMap<number, number>;
}

/** Cache-only item facts; a C-API read never fetches. */
export interface FrameXmlCurrencyItem {
  readonly name?: string | undefined;
  readonly texture?: string | undefined;
}

/** A catalog that is fetched once, the first time the player knows any currency. */
export interface FrameXmlCurrencyCatalogSource {
  readonly current: FrameXmlCurrencyCatalog | undefined;
  /** Start the one fetch; `onReady` when the catalog has arrived. Never rejects. */
  load(onReady: () => void): void;
}

export interface FrameXmlCurrencySource {
  /** A catalog the source already holds (the canned fixture); otherwise `catalogSource` answers. */
  catalog?(): FrameXmlCurrencyCatalog | undefined;
  /** The player's facts, or undefined while the player's own object is absent. */
  snapshot(): FrameXmlCurrencySnapshot | undefined;
  item(entry: number): FrameXmlCurrencyItem | undefined;
  /** Start loading item names/icons outside a C-API read; `onChanged` when some arrived. */
  prefetch?(entries: readonly number[], onChanged: () => void): void;
}

export interface FrameXmlCurrencyPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/** One displayed row, heading or currency. */
export interface FrameXmlCurrencyRow {
  readonly header: boolean;
  readonly categoryId: number;
  readonly name: string | undefined;
  readonly expanded: boolean;
  /** Currency rows only. */
  readonly type?: FrameXmlCurrencyType;
  readonly unused: boolean;
  readonly watched: boolean;
  readonly count: number;
  readonly extraCurrencyType: number;
  readonly icon: string | undefined;
}

/**
 * The heading SetCurrencyUnused moves a currency under. CurrencyCategory carries no name for the
 * role, only Flags; on the dataset exactly one row has any flag set — «Неактивно» (id 3, flags 3), the
 * unused heading — so that is the rule. A table with no flagged row has no unused heading, and
 * SetCurrencyUnused then changes nothing.
 */
export function frameXmlUnusedCurrencyCategory(catalog: FrameXmlCurrencyCatalog): number | undefined {
  return catalog.categories.find((category) => category.flags !== 0)?.id;
}

function extraCurrencyTypeOf(itemId: number): number {
  return itemId === FRAMEXML_CURRENCY_ARENA_ITEM ? 1 : itemId === FRAMEXML_CURRENCY_HONOR_ITEM ? 2 : 0;
}

function known(snapshot: FrameXmlCurrencySnapshot, type: FrameXmlCurrencyType): boolean {
  if (!Number.isInteger(type.bitIndex) || type.bitIndex < 1 || type.bitIndex > 64) return false;
  return (snapshot.knownMask & (1n << BigInt(type.bitIndex - 1))) !== 0n;
}

/** Lua's 0/1 flags as the stock callers pass them; nil and false are off. */
function flagOf(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "number") return value !== 0;
  return value === true || value === "1";
}

const NOTHING: readonly unknown[] = Object.freeze([]);

export class FrameXmlCurrencyModel {
  readonly #source: FrameXmlCurrencySource;
  /** Session view state, keyed by CurrencyTypes id and CurrencyCategory id (module doc). */
  readonly #unused = new Set<number>();
  readonly #watched = new Set<number>();
  readonly #collapsed = new Set<number>();
  #pump: FrameXmlCurrencyPump | undefined;
  #released = false;
  #knownSignature: string | undefined;
  #displaySignature: string | undefined;
  readonly #prefetched = new Set<number>();
  /** Set when a prefetch reports new item names, so the next tick repaints. */
  #itemsChanged = false;
  /** The owner's hook: there is something to show, so Blizzard_TokenUI should load. */
  onDemand: (() => void) | undefined;
  /** The gateway's `/dbc/currencies`, handed over by the world mount (FrameXmlTokenOwner.ts). */
  catalogSource: FrameXmlCurrencyCatalogSource | undefined;

  constructor(source: FrameXmlCurrencySource) {
    this.#source = source;
  }

  #catalog(): FrameXmlCurrencyCatalog | undefined {
    return this.#source.catalog?.() ?? this.catalogSource?.current;
  }

  get released(): boolean { return this.#released; }

  attach(pump: FrameXmlCurrencyPump): void {
    this.#pump = pump;
    this.#knownSignature = undefined;
    this.#displaySignature = undefined;
  }

  detach(): void {
    this.#pump = undefined;
  }

  /**
   * Every currency the player knows, in list order, with its heading; collapse is not applied.
   * Empty while the catalog or the player is missing.
   */
  #currencies(): { readonly category: FrameXmlCurrencyCategory; readonly rows: FrameXmlCurrencyRow[] }[] {
    const catalog = this.#catalog();
    const snapshot = catalog ? this.#source.snapshot() : undefined;
    if (!catalog || !snapshot) return [];
    const unusedCategory = frameXmlUnusedCurrencyCategory(catalog);
    const sections = catalog.categories.map((category) => ({ category, rows: [] as FrameXmlCurrencyRow[] }));
    const byId = new Map(sections.map((section) => [section.category.id, section]));
    for (const type of catalog.types) {
      if (!known(snapshot, type)) continue;
      const unused = unusedCategory !== undefined && this.#unused.has(type.id);
      const section = byId.get(unused ? unusedCategory : type.categoryId);
      if (!section) continue;
      const extraCurrencyType = extraCurrencyTypeOf(type.itemId);
      const count = extraCurrencyType === 1 ? snapshot.arena
        : extraCurrencyType === 2 ? snapshot.honor
          : snapshot.held.get(type.itemId) ?? 0;
      const item = this.#source.item(type.itemId);
      section.rows.push({
        header: false,
        categoryId: section.category.id,
        name: item?.name || undefined,
        expanded: false,
        type,
        unused: unused || type.categoryId === unusedCategory,
        watched: this.#watched.has(type.id),
        count,
        extraCurrencyType,
        icon: item?.texture || undefined,
      });
    }
    return sections.filter((section) => section.rows.length > 0);
  }

  /** The rows GetCurrencyListInfo indexes: headings, and the currencies of expanded headings. */
  rows(): readonly FrameXmlCurrencyRow[] {
    const rows: FrameXmlCurrencyRow[] = [];
    for (const { category, rows: currencies } of this.#currencies()) {
      const expanded = !this.#collapsed.has(category.id);
      rows.push({
        header: true, categoryId: category.id, name: category.name || undefined, expanded,
        unused: false, watched: false, count: 0, extraCurrencyType: 0, icon: undefined,
      });
      if (expanded) rows.push(...currencies);
    }
    return rows;
  }

  #row(index: unknown): FrameXmlCurrencyRow | undefined {
    const value = Number(index);
    if (!Number.isInteger(value) || value < 1) return undefined;
    return this.rows()[value - 1];
  }

  /** True when a currency is known: the add-on has something to show. */
  hasCurrencies(): boolean {
    return this.#currencies().length > 0;
  }

  listSize(): number {
    return this.rows().length;
  }

  /**
   * `GetCurrencyListInfo(index)`. A heading answers its name, isHeader and isExpanded, with
   * isUnused/isWatched false; its count, type, icon and item are nil — no stock caller reads them
   * for a heading (Blizzard_TokenUI.lua:75-92, MainMenuBar.lua:200-203 tests `not isHeader` first).
   */
  listInfo(index: unknown): readonly unknown[] {
    const row = this.#row(index);
    if (!row) return NOTHING;
    if (row.header) return [row.name, true, row.expanded, false, false];
    return [row.name, false, false, row.unused, row.watched, row.count, row.extraCurrencyType, row.icon,
      row.type?.itemId];
  }

  /** `ExpandCurrencyList(index, expand)`: a heading only; a currency row is inert. */
  expand(index: unknown, expand: unknown): void {
    const row = this.#row(index);
    if (!row?.header) return;
    if (flagOf(expand)) this.#collapsed.delete(row.categoryId);
    else this.#collapsed.add(row.categoryId);
  }

  /** `SetCurrencyUnused(index, flag)`: moves the currency under the unused heading and back. */
  setUnused(index: unknown, flag: unknown): void {
    const row = this.#row(index);
    const catalog = this.#catalog();
    if (!row?.type || !catalog || frameXmlUnusedCurrencyCategory(catalog) === undefined) return;
    if (flagOf(flag)) this.#unused.add(row.type.id);
    else this.#unused.delete(row.type.id);
  }

  /**
   * `SetCurrencyBackpack(index, flag)`. The three-token cap is stock Lua's (GetNumWatchedTokens
   * against MAX_WATCHED_TOKENS before every call, Blizzard_TokenUI.lua:267, .xml:364), not C's.
   */
  setBackpack(index: unknown, flag: unknown): void {
    const row = this.#row(index);
    if (!row?.type) return;
    if (flagOf(flag)) this.#watched.add(row.type.id);
    else this.#watched.delete(row.type.id);
  }

  /**
   * `GetBackpackCurrencyInfo(i)`: the i-th watched currency, in list order whatever the headings'
   * collapse — the choice is a per-currency flag, so list order is the only order it has.
   */
  backpackInfo(index: unknown): readonly unknown[] {
    const value = Number(index);
    if (!Number.isInteger(value) || value < 1) return NOTHING;
    const watched = this.#currencies().flatMap((section) => section.rows).filter((row) => row.watched);
    const row = watched[value - 1];
    if (!row) return NOTHING;
    return [row.name, row.count, row.extraCurrencyType, row.icon, row.type?.itemId];
  }

  /**
   * Start the events: the first KNOWN_CURRENCY_TYPES_UPDATE goes out now, and from here each tick
   * reports changes. Called by the token owner once Blizzard_TokenUI passed its gate.
   */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#knownSignature = undefined;
    this.#displaySignature = undefined;
    this.tick();
  }

  /**
   * Per frame: prefetch missing item names, ask for the add-on while held, and once released fire
   * KNOWN_CURRENCY_TYPES_UPDATE when the known set changes and CURRENCY_DISPLAY_UPDATE when an
   * amount, name or icon does.
   */
  tick(): void {
    // The catalog is fetched the first time the player knows a currency, never for one who knows none.
    if (!this.#catalog() && this.catalogSource && (this.#source.snapshot()?.knownMask ?? 0n) !== 0n) {
      this.catalogSource.load(() => {});
    }
    const sections = this.#currencies();
    const rows = sections.flatMap((section) => section.rows);
    this.#prefetchMissing(rows);
    if (!this.#released) {
      if (rows.length > 0) this.onDemand?.();
      return;
    }
    const pump = this.#pump;
    if (!pump) return;
    // The known set, not its order: moving a currency under the unused heading is not a new type.
    const knownSignature = rows.map((row) => row.type?.id ?? 0).sort((left, right) => left - right).join(",");
    const displaySignature = rows.map((row) => `${row.count}:${row.name ?? ""}:${row.icon ?? ""}`).join("|");
    const itemsChanged = this.#itemsChanged;
    this.#itemsChanged = false;
    if (knownSignature !== this.#knownSignature) {
      this.#knownSignature = knownSignature;
      this.#displaySignature = displaySignature;
      pump.fire("KNOWN_CURRENCY_TYPES_UPDATE");
    } else if (displaySignature !== this.#displaySignature || itemsChanged) {
      this.#displaySignature = displaySignature;
      pump.fire("CURRENCY_DISPLAY_UPDATE");
    }
  }

  #prefetchMissing(rows: readonly FrameXmlCurrencyRow[]): void {
    const prefetch = this.#source.prefetch;
    if (!prefetch) return;
    const missing: number[] = [];
    for (const row of rows) {
      const entry = row.type?.itemId;
      if (entry === undefined || this.#prefetched.has(entry)) continue;
      if (row.name !== undefined && row.icon !== undefined) continue;
      this.#prefetched.add(entry);
      missing.push(entry);
    }
    if (missing.length > 0) prefetch.call(this.#source, missing, () => { this.#itemsChanged = true; });
  }
}

export type FrameXmlCurrencyBinding = (
  seam: { readonly currency?: FrameXmlCurrencyModel | undefined },
  args: readonly unknown[],
) => readonly unknown[];

/** The C API. Without a model (a seam that has none) the list is empty, as for a new character. */
export const FRAMEXML_CURRENCY_BINDINGS: Readonly<Record<string, FrameXmlCurrencyBinding>> = Object.freeze({
  GetCurrencyListSize: (seam) => [seam.currency?.listSize() ?? 0],
  GetCurrencyListInfo: (seam, args) => seam.currency?.listInfo(args[0]) ?? NOTHING,
  ExpandCurrencyList: (seam, args) => { seam.currency?.expand(args[0], args[1]); return NOTHING; },
  SetCurrencyUnused: (seam, args) => { seam.currency?.setUnused(args[0], args[1]); return NOTHING; },
  SetCurrencyBackpack: (seam, args) => { seam.currency?.setBackpack(args[0], args[1]); return NOTHING; },
  GetBackpackCurrencyInfo: (seam, args) => seam.currency?.backpackInfo(args[0]) ?? NOTHING,
});

/** Parse the gateway's answer; anything malformed is refused whole rather than half-used. */
export function parseFrameXmlCurrencyCatalog(value: unknown): FrameXmlCurrencyCatalog | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { version?: unknown; categories?: unknown; types?: unknown };
  if (raw.version !== FRAMEXML_CURRENCY_CATALOG_VERSION || !Array.isArray(raw.categories) || !Array.isArray(raw.types)) {
    return undefined;
  }
  const whole = (item: unknown): item is number => typeof item === "number" && Number.isInteger(item) && item >= 0;
  const categories: FrameXmlCurrencyCategory[] = [];
  for (const row of raw.categories as unknown[]) {
    const category = row as Partial<FrameXmlCurrencyCategory> | null;
    if (!category || !whole(category.id) || !whole(category.flags) || typeof category.name !== "string") return undefined;
    categories.push(Object.freeze({ id: category.id, flags: category.flags, name: category.name }));
  }
  const types: FrameXmlCurrencyType[] = [];
  for (const row of raw.types as unknown[]) {
    const type = row as Partial<FrameXmlCurrencyType> | null;
    if (!type || !whole(type.id) || !whole(type.itemId) || !whole(type.categoryId) || !whole(type.bitIndex)) return undefined;
    types.push(Object.freeze({ id: type.id, itemId: type.itemId, categoryId: type.categoryId, bitIndex: type.bitIndex }));
  }
  return Object.freeze({
    version: FRAMEXML_CURRENCY_CATALOG_VERSION,
    categories: Object.freeze(categories),
    types: Object.freeze(types),
  });
}
