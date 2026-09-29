/** Browser projection of the gateway's `LFGDungeons` catalog. Queue eligibility stays server-owned. */
export interface LfgDungeon {
  readonly id: number;
  readonly name: string;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly type: number;
  readonly difficulty: number;
  readonly expansion: number;
  readonly description: string;
  /** DBC `TextureFilename` (may be empty): banner key for `UI-LFG-BACKGROUND-<name>`. */
  readonly texture: string;
  readonly mapId: number;
  /**
   * Catalog version 2 (a gateway restarted on the current code). A version-1 gateway omits them,
   * and `lfgStockCatalog` then answers undefined so the native finder keeps the route.
   */
  readonly targetLevel?: number;
  readonly targetLevelMin?: number;
  readonly targetLevelMax?: number;
  readonly groupId?: number;
  readonly flags?: number;
  readonly faction?: number;
  readonly orderIndex?: number;
  readonly maxPlayers?: number;
}

export type LfgDungeonCatalog = readonly LfgDungeon[];

/** One `LFGDungeonGroup` header of the stock specific-dungeon list. */
export interface LfgDungeonGroupRow {
  readonly id: number;
  readonly name: string;
  readonly orderIndex: number;
  readonly parentGroupId: number;
  readonly typeId: number;
}

/**
 * The `/dbc/lfg-dungeons` shape this client asks for. Sent as `?v=`; the route ignores the query,
 * so an older gateway still answers, and the body's own `version` says which shape arrived.
 */
export const LFG_DUNGEON_CATALOG_VERSION = 2;

const LFG_DUNGEON_CATALOG_TIMEOUT_MS = 5_000;
const MAX_DUNGEON_ID = 0x00ffffff;

function validRow(value: unknown): value is LfgDungeon {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<LfgDungeon>;
  return Number.isInteger(row.id) && (row.id ?? 0) > 0 && (row.id ?? 0) <= MAX_DUNGEON_ID
    && typeof row.name === "string"
    && Number.isInteger(row.minLevel) && Number.isInteger(row.maxLevel)
    && Number.isInteger(row.type) && (row.type ?? -1) >= 0 && (row.type ?? 256) <= 0xff
    && Number.isInteger(row.difficulty) && Number.isInteger(row.expansion)
    && typeof row.description === "string"
    && (row.texture === undefined || typeof row.texture === "string")
    && (row.mapId === undefined || Number.isInteger(row.mapId))
    && ([row.targetLevel, row.targetLevelMin, row.targetLevelMax, row.groupId, row.flags,
      row.faction, row.orderIndex, row.maxPlayers].every((field) => field === undefined || Number.isInteger(field)));
}

function validGroup(value: unknown): value is LfgDungeonGroupRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<LfgDungeonGroupRow>;
  return Number.isInteger(row.id) && (row.id ?? 0) > 0 && typeof row.name === "string"
    && Number.isInteger(row.orderIndex) && Number.isInteger(row.parentGroupId) && Number.isInteger(row.typeId);
}

/** Version-2 group headers; an absent or malformed list is "no headers" (a version-1 body). */
function validateGroups(value: unknown): readonly LfgDungeonGroupRow[] {
  const raw = (value as { groups?: unknown } | undefined)?.groups;
  if (!Array.isArray(raw)) return Object.freeze([]);
  const seen = new Set<number>();
  const groups: LfgDungeonGroupRow[] = [];
  for (const row of raw) {
    if (!validGroup(row) || seen.has(row.id)) return Object.freeze([]);
    seen.add(row.id);
    groups.push(Object.freeze({ id: row.id, name: row.name, orderIndex: row.orderIndex,
      parentGroupId: row.parentGroupId, typeId: row.typeId }));
  }
  return Object.freeze(groups);
}

/** The catalog plus its headers, only when both carry what the stock LFD list reads. */
export interface LfgStockCatalog {
  readonly dungeons: LfgDungeonCatalog;
  readonly groups: readonly LfgDungeonGroupRow[];
}

/**
 * Whether a loaded catalog can drive stock `LFDParentFrame`: every row carries the version-2
 * fields and the group table is non-empty. `LFGDungeonList_Setup` (LFGFrame.lua:375-386) reads the
 * catalog once per session, so a partial one would leave the stock list empty until a reload.
 */
export function lfgStockCatalog(
  dungeons: LfgDungeonCatalog | undefined,
  groups: readonly LfgDungeonGroupRow[] | undefined,
): LfgStockCatalog | undefined {
  if (!dungeons || dungeons.length === 0 || !groups || groups.length === 0) return undefined;
  const complete = dungeons.every((row) => [row.targetLevel, row.targetLevelMin, row.targetLevelMax,
    row.groupId, row.flags, row.faction, row.orderIndex, row.maxPlayers].every(Number.isInteger));
  return complete ? { dungeons, groups } : undefined;
}

function validateCatalog(value: unknown): LfgDungeonCatalog {
  const raw = (value as { dungeons?: unknown } | undefined)?.dungeons;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("malformed lfg dungeon catalog");
  const seen = new Set<number>();
  const catalog = raw.map((row) => {
    if (!validRow(row)) throw new Error("malformed lfg dungeon row");
    if (seen.has(row.id)) throw new Error(`duplicate lfg dungeon row ${row.id}`);
    seen.add(row.id);
    // Older gateways predate `texture`/`mapId`: default rather than reject.
    const typed = row as Partial<LfgDungeon> & Pick<LfgDungeon, "id" | "name" | "minLevel" | "maxLevel" | "type" | "difficulty" | "expansion" | "description">;
    return Object.freeze({
      ...typed,
      texture: typed.texture ?? "",
      mapId: typed.mapId ?? 0,
    });
  });
  return Object.freeze(catalog);
}

/** `TYPEID_HEROIC_DIFFICULTY` in the stock LFDFrame.lua. */
export const LFG_HEROIC_TYPE_ID = 5;

/** Whether the stock list shows the heroic badge beside this dungeon. */
export function lfgDungeonHeroic(dungeon: Pick<LfgDungeon, "type" | "difficulty">): boolean {
  return dungeon.difficulty > 0 || dungeon.type === LFG_HEROIC_TYPE_ID;
}

/**
 * Banner art for a dungeon: `Interface\LFGFrame\UI-LFG-BACKGROUND-<TextureFilename>`.
 * The stock proposal dialog falls back to Deadmines and then to the random-dungeon art;
 * callers replicate that fallback chain.
 */
export function lfgDungeonBackgroundPath(texture: string | undefined): string | undefined {
  const name = (texture ?? "").trim();
  if (!name) return undefined;
  if (/[^a-z0-9_]/i.test(name)) return undefined;
  return `Interface\\LFGFrame\\UI-LFG-BACKGROUND-${name}.blp`;
}

/**
 * Wire entry for `CMSG_LFG_JOIN`: `id + (type << 24)`.
 *
 * `HandleLfgJoinOpcode` masks the slot with `0x00FFFFFF` before the DBC lookup, so a plain id
 * and its entry form select the same dungeon. Sending the entry keeps the queue type explicit
 * instead of collapsing everything to type 0.
 */
export function lfgDungeonEntry(dungeon: Pick<LfgDungeon, "id" | "type">): number {
  return (dungeon.id & MAX_DUNGEON_ID) | ((dungeon.type & 0xff) << 24);
}

/** TrinityCore's specific dungeon queue accepts normal and heroic rows. */
export function isSpecificLfgDungeon(dungeon: Pick<LfgDungeon, "type">): boolean {
  return dungeon.type === 1 || dungeon.type === LFG_HEROIC_TYPE_ID;
}

/** Maps checked specific dungeon ids to wire entries in catalog order. */
export function lfgEntriesForSelection(catalog: LfgDungeonCatalog, selected: ReadonlySet<number>): number[] {
  const entries: number[] = [];
  for (const dungeon of catalog) {
    if (isSpecificLfgDungeon(dungeon) && selected.has(dungeon.id)) entries.push(lfgDungeonEntry(dungeon));
  }
  return entries;
}

/** `LFGDungeons.ExpansionLevel`: the three client eras the dataset can hold. */
const EXPANSION_NAMES: Readonly<Record<number, string>> = {
  0: "Классика",
  1: "The Burning Crusade",
  2: "Wrath of the Lich King",
};

export function lfgExpansionName(expansion: number): string {
  return EXPANSION_NAMES[expansion] ?? `Дополнение ${expansion}`;
}

/**
 * What the specific-dungeon pane is filtered by: the search text, one expansion (or all), a
 * heroic-only switch, a "fits my level" switch and the row order. The buttons act on the result.
 */
export interface LfgDungeonFilter {
  readonly query: string;
  readonly expansion: number | "all";
  readonly heroicOnly: boolean;
  readonly levelOnly: boolean;
  readonly playerLevel: number | undefined;
  readonly sort: "name" | "level";
}

/** The catalog rows the filter keeps, in its order. Name is the stable tiebreak for both sorts. */
export function filterLfgDungeons(catalog: LfgDungeonCatalog, filter: LfgDungeonFilter): LfgDungeon[] {
  const query = filter.query.trim().toLowerCase();
  const rows = catalog.filter((dungeon) => {
    if (!isSpecificLfgDungeon(dungeon)) return false;
    if (filter.expansion !== "all" && dungeon.expansion !== filter.expansion) return false;
    if (filter.heroicOnly && !lfgDungeonHeroic(dungeon)) return false;
    if (filter.levelOnly && filter.playerLevel !== undefined
      && ((dungeon.minLevel > 0 && filter.playerLevel < dungeon.minLevel)
        || (dungeon.maxLevel > 0 && filter.playerLevel > dungeon.maxLevel))) return false;
    if (query && !dungeon.name.toLowerCase().includes(query) && !String(dungeon.id).includes(query)) return false;
    return true;
  });
  rows.sort((left, right) => filter.sort === "level"
    ? (left.minLevel - right.minLevel) || left.name.localeCompare(right.name) || left.id - right.id
    : left.name.localeCompare(right.name) || left.id - right.id);
  return rows;
}

export interface LfgDungeonGroup {
  readonly expansion: number;
  readonly name: string;
  readonly dungeons: LfgDungeon[];
}

/** The filtered rows under expansion headers, in era order; a single era stays ungrouped. */
export function groupLfgDungeons(rows: readonly LfgDungeon[]): LfgDungeonGroup[] {
  const groups = new Map<number, LfgDungeon[]>();
  for (const dungeon of rows) {
    const list = groups.get(dungeon.expansion) ?? [];
    list.push(dungeon);
    groups.set(dungeon.expansion, list);
  }
  return [...groups.entries()].sort(([left], [right]) => left - right)
    .map(([expansion, dungeons]) => ({ expansion, name: lfgExpansionName(expansion), dungeons }));
}

/** Checks or clears every visible row at once, which is the whole point of "select visible". */
export function setVisibleLfgSelection(
  selection: Set<number>, visible: readonly LfgDungeon[], selected: boolean,
): void {
  for (const dungeon of visible) {
    if (selected) selection.add(dungeon.id);
    else selection.delete(dungeon.id);
  }
}

/** Legacy manual input: comma-separated ids, kept as a fallback when the catalog is unreachable. */
export function parseManualDungeonIds(value: string): number[] {
  const ids: number[] = [];
  for (const part of value.split(",")) {
    const id = Number(part.trim());
    if (Number.isInteger(id) && id > 0 && id <= 0xffffffff) ids.push(id);
  }
  return [...new Set(ids)];
}

/**
 * Fetches and retains the LFG dungeon catalog. The gateway's cache headers provide the HTTP
 * cache; this instance keeps later UI reads synchronous after the one asynchronous load.
 */
export class LfgDungeonClient {
  readonly #url: string;
  #catalog: LfgDungeonCatalog | undefined;
  #groups: readonly LfgDungeonGroupRow[] = Object.freeze([]);
  #pending: Promise<LfgDungeonCatalog | undefined> | undefined;
  #failed = false;
  onStatus: ((message: string, error: boolean) => void) | undefined;
  onLoaded: (() => void) | undefined;

  constructor(gatewayOrigin: string) {
    const url = new URL("/dbc/lfg-dungeons", gatewayOrigin);
    url.searchParams.set("v", String(LFG_DUNGEON_CATALOG_VERSION));
    this.#url = url.href;
  }

  get ready(): boolean {
    return this.#catalog !== undefined;
  }

  get catalog(): LfgDungeonCatalog | undefined {
    return this.#catalog;
  }

  /** `LFGDungeonGroup` headers from a version-2 gateway; empty before load or from version 1. */
  get groups(): readonly LfgDungeonGroupRow[] {
    return this.#groups;
  }

  /** The catalog in the shape stock LFD needs, or undefined (not loaded, or a version-1 body). */
  get stock(): LfgStockCatalog | undefined {
    return lfgStockCatalog(this.#catalog, this.#groups);
  }

  load(): Promise<LfgDungeonCatalog | undefined> {
    if (this.#catalog !== undefined) return Promise.resolve(this.#catalog);
    if (this.#pending) return this.#pending;
    if (this.#failed) return Promise.resolve(undefined);
    this.#pending = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LFG_DUNGEON_CATALOG_TIMEOUT_MS);
      try {
        // Revalidated, never served from freshness: the gateway sends a content ETag, so an unchanged
        // dataset costs a 304 while a body cached from the previous catalog shape is not reused.
        const response = await fetch(this.#url, { signal: controller.signal, cache: "no-cache" });
        if (!response.ok) throw new Error(`LFG gateway returned ${response.status}`);
        const body: unknown = await response.json();
        const catalog = validateCatalog(body);
        this.#groups = validateGroups(body);
        this.#catalog = catalog;
        this.onLoaded?.();
        return catalog;
      } catch (error) {
        this.#failed = true;
        this.onStatus?.(`подземелья: ${error instanceof Error ? error.message : String(error)}`, true);
        return undefined;
      } finally {
        clearTimeout(timeout);
        this.#pending = undefined;
      }
    })();
    return this.#pending;
  }
}
