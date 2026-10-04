/**
 * М-A4-4: where the world layer finds a name for an id it has to print.
 *
 * `WorldClient` writes the texts that carry spell, zone, map and item ids, and it has no DBC client
 * of its own: those live in the browser. So the browser hands it synchronous lookups
 * (`WorldClient.worldNames`, filled when the world is entered), and every text falls back to a
 * neutral word — never to the number — when a lookup is missing or has not loaded yet. A miss is
 * not remembered here: the next text asks again, by which time the cache may have the answer.
 */
export interface WorldNameSources {
  spell?(id: number): string | undefined;
  area?(id: number): string | undefined;
  map?(id: number): string | undefined;
  dungeon?(id: number): string | undefined;
  item?(id: number): string | undefined;
  quest?(id: number): string | undefined;
  /** `ItemSubClass` words for an item class and a subclass mask, as a spell's equipment demand names them. */
  itemSubclass?(itemClass: number, subclassMask: number): string | undefined;
}

/** The single-id lookups, by the kind of thing they name. */
export type WorldNameKind = "spell" | "area" | "map" | "dungeon" | "item" | "quest";

/**
 * What a text says in place of a name it does not have. Words for the thing, not its id: «зона»,
 * not «зона 3905». These are this client's own words; the stock strings have none for "unknown".
 */
export const WORLD_NAME_FALLBACKS: Readonly<Record<WorldNameKind, string>> = {
  spell: "заклинание",
  area: "зона",
  map: "карта",
  dungeon: "подземелье",
  item: "предмет",
  quest: "задание",
};

/** A usable name from `source`, or `fallback`: an empty or blank answer is no answer. */
export function nameOr(source: ((id: number) => string | undefined) | undefined, id: number, fallback: string): string {
  const name = source?.(id);
  return typeof name === "string" && name.trim() !== "" ? name : fallback;
}

/** The browser's tables, as the browser has them: an area's name, and one class and subclass's word. */
export interface WorldNameTables {
  area?(id: number): string | undefined;
  itemSubclassName?(itemClass: number, subClass: number): string | undefined;
  /** 1.32: the single-id lookups, passed through as given (SpellMetadataClient, AreaClient's maps, …). */
  spell?(id: number): string | undefined;
  map?(id: number): string | undefined;
  dungeon?(id: number): string | undefined;
  item?(id: number): string | undefined;
  quest?(id: number): string | undefined;
}

/**
 * The lookups `WorldClient.worldNames` takes, over the browser's tables (EnterWorld.ts wires
 * AreaClient and ItemMetadataClient's `/dbc/item-subclasses`). A spell names its equipment demand by
 * a subclass *mask*; only a mask of exactly one subclass has a word of its own — for several (any
 * one-handed weapon) the refusal says the stock sentence that needs none.
 */
export function worldNameSources(tables: WorldNameTables): WorldNameSources {
  const sources: WorldNameSources = {
    area: (id) => tables.area?.(id),
    itemSubclass: (itemClass, subclassMask) => {
      const subClass = singleSubclass(subclassMask);
      return subClass === undefined ? undefined : tables.itemSubclassName?.(itemClass, subClass);
    },
  };
  // Only the tables actually given: an absent `spell` tells the world layer nobody names spells
  // yet, which it answers differently from a table that has not loaded a row (see WorldClient).
  for (const kind of ["spell", "map", "dungeon", "item", "quest"] as const) {
    if (tables[kind]) sources[kind] = (id) => tables[kind]?.(id);
  }
  return sources;
}

/** The one subclass a mask names, or undefined for none or several. The mask is an unsigned word. */
export function singleSubclass(mask: number): number | undefined {
  const bits = mask >>> 0;
  if (bits === 0 || (bits & (bits - 1)) !== 0) return undefined;
  return 31 - Math.clz32(bits);
}
