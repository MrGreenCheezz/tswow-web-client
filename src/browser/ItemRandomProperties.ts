/**
 * Plan item 3.12 (06.11): an item's random property or suffix, as Wow.exe 3.3.5a (12340) reads it (Ghidra
 * read-only, 06.11; .runtime/re-2026-11-06/312). A positive id is an ItemRandomProperties row, a negative one an
 * ItemRandomSuffix row (by its absolute value).
 *
 * - The name (0x00706d70): a property's own suffix when it has one, else the bare name for an id of 0 or more;
 *   a suffix's name — empty for a row not there — and ITEM_SUFFIX_TEMPLATE joins the two.
 * - A link's enchantments (0x0062799e): the row's five go to slots 7-11; an item object has them in its fields.
 * - A suffix enchantment's amount (0x00707650): AllocationPct of slot − 7 × 0.0001f × the suffix factor, in
 *   float, cut toward zero; a property's is 0. The factor is the link's own number; an item object's is
 *   RandPropPoints' (0x007075a0) by item level, quality (2 Good, 3 Superior, 4 Epic) and the slot column
 *   0x00707500 gives its inventory type.
 * - The enchantment's line (0x00577260): its name with `$i` the amount; a `$` before anything else stays.
 * - The stat table (0x0061fa20): each of a suffix's enchantments gives every effect the suffix amount
 *   (0x0061f980), a property's its own (EffectPointsMin + EffectPointsMax) / 2 (0x0061f940).
 *
 * Here the column reads the item record's inventory type where Wow.exe reads Item.dbc's; the two are the same
 * row of the same dataset.
 */

import type { ItemEnchantmentEffect } from "../gateway/ItemEnchantments.js";

/** The rows the rules read; a missing one reads as Wow.exe's missing record. */
export interface ItemRandomTables {
  property(id: number): { readonly name: string; readonly enchantments: readonly number[] } | undefined;
  suffix(id: number): {
    readonly name: string; readonly enchantments: readonly number[]; readonly allocation: readonly number[];
  } | undefined;
  points(level: number): {
    readonly epic: readonly number[]; readonly rare: readonly number[]; readonly uncommon: readonly number[];
  } | undefined;
  enchantment(id: number): { readonly name: string; readonly effects?: readonly ItemEnchantmentEffect[] } | undefined;
}

/** The tables over the enchantment client's maps (ItemEnchantments.ts); undefined while they are not loaded. */
export function itemRandomTables(client: {
  readonly randomReady: boolean;
  readonly randomProperties: ReadonlyMap<number, { readonly name: string; readonly enchantments: readonly number[] }>;
  readonly randomSuffixes: ReadonlyMap<number, {
    readonly name: string; readonly enchantments: readonly number[]; readonly allocation: readonly number[];
  }>;
  readonly randPropPoints: ReadonlyMap<number, {
    readonly epic: readonly number[]; readonly rare: readonly number[]; readonly uncommon: readonly number[];
  }>;
  readonly enchantments: ReadonlyMap<number, { readonly name: string; readonly effects?: readonly ItemEnchantmentEffect[] }>;
} | undefined): ItemRandomTables | undefined {
  if (!client?.randomReady) return undefined;
  return {
    property: (id) => client.randomProperties.get(id),
    suffix: (id) => client.randomSuffixes.get(id),
    points: (level) => client.randPropPoints.get(level),
    enchantment: (id) => client.enchantments.get(id),
  };
}

/**
 * A link's random property (its seventh number after the entry) and suffix factor (the eighth):
 * `item:entry:enchant:gem1:gem2:gem3:gem4:random:factor:level`; zeros when absent.
 */
export function itemLinkRandom(link: string | undefined): { readonly id: number; readonly factor: number } {
  const fields = itemLinkFields(link);
  return { id: fields[5]!, factor: fields[6]! };
}

/**
 * 06.11 (3.12): a link's eight numbers after the entry — enchant, the four gems, random property,
 * suffix factor, level — each 0 when absent.
 */
export function itemLinkFields(link: string | undefined): number[] {
  const match = typeof link === "string" ? /(?:^|\|H)item:-?\d+((?::-?\d*)*)/.exec(link) : null;
  const fields = match?.[1]?.split(":").slice(1) ?? [];
  return Array.from({ length: 8 }, (_, index) => {
    const value = Number(fields[index] ?? 0);
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  });
}

/** The first random property slot (PROP_ENCHANTMENT_SLOT_0). */
export const ITEM_RANDOM_FIRST_SLOT = 7;

/** 0x00706d70: the item's name with its random suffix, through ITEM_SUFFIX_TEMPLATE ("%s %s"). */
export function itemRandomDisplayName(name: string, randomId: number, tables: ItemRandomTables,
  suffixTemplate: string | undefined): string {
  let suffix: string;
  const property = randomId >= 1 ? tables.property(randomId) : undefined;
  if (property?.name) suffix = property.name;
  else if (randomId >= 0) return name;
  else suffix = tables.suffix(-randomId)?.name ?? "";
  if (suffixTemplate === undefined) return `${name} ${suffix}`;
  let next = 0;
  const parts = [name, suffix];
  return suffixTemplate.replace(/%s/g, () => parts[next++] ?? "");
}

/** 0x0062799e: a link's slots 7..11 — the five enchantments of its property or suffix row, else none. */
export function itemRandomEnchantSlots(randomId: number, tables: ItemRandomTables): number[] {
  const row = randomId > 0 ? tables.property(randomId) : randomId < 0 ? tables.suffix(-randomId) : undefined;
  return [0, 1, 2, 3, 4].map((index) => row?.enchantments[index] ?? 0);
}

const SUFFIX_FACTOR_SCALE = Math.fround(0.0001);

/** 0x00707650: the amount slot `slot`'s enchantment takes from a suffix and its factor; 0 otherwise. */
export function itemRandomEnchantAmount(slot: number, randomId: number, factor: number, tables: ItemRandomTables): number {
  const row = randomId < 0 ? tables.suffix(-randomId) : undefined;
  const index = slot - ITEM_RANDOM_FIRST_SLOT;
  if (!row || index < 0 || index >= 5) return 0;
  return Math.trunc(Math.fround(Math.fround(row.allocation[index] ?? 0) * SUFFIX_FACTOR_SCALE * Math.fround(factor)));
}

/** 0x0070757c: inventory type 0..28 → the RandPropPoints column (-1 none), through 0x00707500's switch. */
const SUFFIX_COLUMNS: readonly number[] = [
  -1, 0, 2, 1, 0, 0, 1, 0, 1, 2, 1, 2, 1, 3, 2, 4, 2, 0, -1, -1, 0, 3, 3, 2, -1, 4, 4, -1, -1,
];

/** 0x007075a0: an item object's suffix factor by its record's level, quality and inventory type. */
export function itemSuffixFactor(record: { readonly itemLevel: number; readonly quality: number; readonly inventoryType: number },
  tables: ItemRandomTables): number {
  const column = SUFFIX_COLUMNS[record.inventoryType] ?? -1;
  const row = column < 0 ? undefined : tables.points(record.itemLevel);
  if (!row) return 0;
  const block = record.quality === 2 ? row.uncommon : record.quality === 3 ? row.rare : record.quality === 4 ? row.epic : undefined;
  return block?.[column] ?? 0;
}

/** 0x00577260: an enchantment's name with `$i` the amount. */
export function itemEnchantText(name: string, amount: number): string {
  return name.replace(/\$i/g, String(amount));
}

/** One effect a random enchantment gives the stat table: the effect type, its argument and the amount. */
export interface ItemRandomStatEffect {
  readonly type: number;
  readonly arg: number;
  readonly amount: number;
}

/**
 * 0x0061fa20: the effects a random property or suffix gives the stat table, in order. A row the tables do not
 * have gives nothing, as a missing record does; whether the tables are loaded at all is the caller's question.
 */
export function itemRandomStatEffects(randomId: number, factor: number, tables: ItemRandomTables): ItemRandomStatEffect[] {
  const effects: ItemRandomStatEffect[] = [];
  if (randomId < 0) {
    const row = tables.suffix(-randomId);
    for (let index = 0; index < 5; index += 1) {
      const enchantment = row ? tables.enchantment(row.enchantments[index] ?? 0) : undefined;
      if (!enchantment) continue;
      const amount = itemRandomEnchantAmount(ITEM_RANDOM_FIRST_SLOT + index, randomId, factor, tables);
      for (const [type, , , arg] of enchantment.effects ?? []) if (type !== 0) effects.push({ type, arg, amount });
    }
    return effects;
  }
  const row = randomId > 0 ? tables.property(randomId) : undefined;
  for (const id of row?.enchantments ?? []) {
    for (const [type, min, max, arg] of tables.enchantment(id)?.effects ?? []) {
      if (type !== 0) effects.push({ type, arg, amount: Math.trunc((min + max) / 2) });
    }
  }
  return effects;
}
