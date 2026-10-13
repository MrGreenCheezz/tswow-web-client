import { readFile } from "node:fs/promises";
import type { CreatureMetadata } from "./CreatureMetadata.js";
import type { ItemMetadata } from "./ItemMetadata.js";
import type { SpellMetadata } from "./SpellMetadata.js";

/**
 * The GM console's search (`/data/gm-search`, `src/browser/ui/GmConsole.ts`): items, creatures,
 * spells, quests, `game_tele` points and game objects by name or id, out of the tables the gateway
 * already holds — `data/items.json`, `data/creatures.json`, Spell.dbc — and `data/gm-catalog.json`
 * (`tools/generate-gm-catalog.mjs`) for the three only the console needs.
 *
 * Read-only and per dataset: nothing here reaches the world server. The commands the console sends
 * are ordinary chat, and the server decides who may run them.
 */

export const GM_SEARCH_KINDS = ["item", "creature", "spell", "quest", "tele", "gameobject"] as const;
export type GmSearchKind = typeof GM_SEARCH_KINDS[number];

/** One answer row; `id` and `name` always, the rest by kind. */
export interface GmSearchRow {
  id: number;
  name: string;
  /** Items: quality; spells: rank text; creatures: subname; quests: level. */
  [field: string]: unknown;
}

export interface GmSearchResult {
  kind: GmSearchKind;
  total: number;
  rows: GmSearchRow[];
  /** The kind's source is not on disk (gm-catalog.json not generated), as opposed to no match. */
  missing?: boolean;
}

export const GM_SEARCH_MAX_LIMIT = 100;

interface Indexed {
  readonly id: number;
  /** `normalise(name)`, computed once per dataset. */
  readonly key: string;
  readonly row: GmSearchRow;
}

/** One list per kind, built once and searched many times. */
export type GmSearchIndex = Partial<Record<GmSearchKind, readonly Indexed[]>>;

/** Lower case, `ё` as `е`, runs of space as one: what a person types against what a table stores. */
export function normalise(text: string): string {
  return text.toLowerCase().replaceAll("ё", "е").replace(/\s+/g, " ").trim();
}

function indexed(rows: Iterable<GmSearchRow>): Indexed[] {
  const result: Indexed[] = [];
  for (const row of rows) result.push({ id: row.id, key: normalise(row.name), row });
  return result.sort((left, right) => left.id - right.id);
}

export function indexItems(items: ReadonlyMap<number, ItemMetadata>): Indexed[] {
  return indexed([...items.values()].map((item) => ({
    id: item.entry, name: item.name, quality: item.quality, iconId: item.iconId, displayId: item.displayId,
    inventoryType: item.inventoryType, stackable: item.stackable,
  })));
}

export function indexCreatures(creatures: ReadonlyMap<number, CreatureMetadata>): Indexed[] {
  return indexed([...creatures.values()].map((creature) => ({
    id: creature.entry, name: creature.name, subname: creature.subname,
    type: creature.type, family: creature.family, rank: creature.rank,
  })));
}

/** Server-linked aliases (`SERVER_LINKED_SPELL_ALIASES`) are copies under another id; both are real ids. */
export function indexSpells(spells: ReadonlyMap<number, SpellMetadata>): Indexed[] {
  return indexed([...spells.values()].map((spell) => ({
    id: spell.id, name: spell.name, rank: spell.rank, iconId: spell.iconId,
    passive: spell.passive, hidden: spell.hidden,
    description: clip(spell.description), auraDescription: clip(spell.auraDescription ?? ""),
  })));
}

function clip(text: string): string {
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

export interface GmCatalog {
  quests: GmSearchRow[];
  tele: GmSearchRow[];
  gameobject: GmSearchRow[];
}

/** `data/gm-catalog.json` as the generator writes it; a missing file is `undefined`, a bad one throws. */
export async function loadGmCatalog(path: string): Promise<GmCatalog | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseGmCatalog(JSON.parse(text));
}

export function parseGmCatalog(value: unknown): GmCatalog {
  const file = value as { version?: unknown; quests?: unknown; teleports?: unknown; gameobjects?: unknown };
  if (!file || typeof file !== "object" || file.version !== 1) throw new Error("GM catalog file is invalid");
  const rows = (list: unknown, width: number): unknown[][] => {
    if (!Array.isArray(list) || list.length > 500_000) throw new Error("GM catalog list is invalid");
    for (const row of list) {
      if (!Array.isArray(row) || row.length !== width || typeof row[1] !== "string"
        || !row.every((field, index) => index === 1 || typeof field === "number" && Number.isFinite(field))) {
        throw new Error("GM catalog row is invalid");
      }
    }
    return list as unknown[][];
  };
  return {
    quests: rows(file.quests, 4).map(([id, name, level, minLevel]) => ({
      id: id as number, name: name as string, level: level as number, minLevel: minLevel as number,
    })),
    tele: rows(file.teleports, 6).map(([id, name, map, x, y, z]) => ({
      id: id as number, name: name as string, map: map as number, x: x as number, y: y as number, z: z as number,
    })),
    gameobject: rows(file.gameobjects, 4).map(([id, name, type, displayId]) => ({
      id: id as number, name: name as string, type: type as number, displayId: displayId as number,
    })),
  };
}

export function indexGmCatalog(catalog: GmCatalog): GmSearchIndex {
  return { quest: indexed(catalog.quests), tele: indexed(catalog.tele), gameobject: indexed(catalog.gameobject) };
}

/**
 * How well `key` answers `query`: 0 the whole name, 1 its start, 2 the start of a word, 3 anywhere;
 * `undefined` when some word of the query is not in it. Every word must appear — «меч тьмы» finds
 * «Меч тьмы» and «Тёмный меч тьмы» but not «Меч».
 */
export function matchRank(key: string, query: string, words: readonly string[]): number | undefined {
  for (const word of words) if (!key.includes(word)) return undefined;
  if (key === query) return 0;
  if (key.startsWith(query)) return 1;
  if (key.startsWith(words[0]!) || key.includes(` ${words[0]}`)) return 2;
  return 3;
}

/**
 * The best `limit` rows of a list for a query, after `offset`. A query of digits is also an id:
 * that row comes first, ahead of the names that merely contain the digits. An empty query lists
 * nothing — the console never asks for a whole table.
 */
export function searchIndex(list: readonly Indexed[], rawQuery: string, limit: number, offset = 0): { total: number; rows: GmSearchRow[] } {
  const query = normalise(rawQuery);
  if (!query) return { total: 0, rows: [] };
  const words = query.split(" ");
  const asId = /^\d+$/.test(query) ? Number(query) : undefined;
  const matches: { rank: number; length: number; item: Indexed }[] = [];
  for (const item of list) {
    if (item.id === asId) {
      matches.push({ rank: -1, length: 0, item });
      continue;
    }
    const rank = matchRank(item.key, query, words);
    if (rank !== undefined) matches.push({ rank, length: item.key.length, item });
  }
  // Rank, then the shorter name (the plain item before its «… of the Bear» variants), then the id.
  matches.sort((left, right) => left.rank - right.rank || left.length - right.length || left.item.id - right.item.id);
  const from = Math.max(0, Math.trunc(offset));
  const count = Math.min(GM_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
  return { total: matches.length, rows: matches.slice(from, from + count).map((match) => match.item.row) };
}

export function isGmSearchKind(value: string | null): value is GmSearchKind {
  return value !== null && (GM_SEARCH_KINDS as readonly string[]).includes(value);
}
