/**
 * Plan item 3.12 (06.11): a heirloom's numbers, as Wow.exe 3.3.5a (12340) scales them (Ghidra read-only, 06.11;
 * .runtime/re-2026-11-06/312). A record with a ScalingStatValue (a flag word) takes its stats, armour, damage
 * and spell power from its ScalingStatDistribution row and the ScalingStatValues row of a level, not from its
 * template.
 *
 * - The level (0x0061e740): the unit's — the player's, or the one SetInventoryItem names — at least the record's
 *   RequiredLevel and at most the distribution's Maxlevel when there is one; at least 1. ScalingStatValues is
 *   read at row level − 1 in file order.
 * - The multiplier (0x0061a650), flags & 0x4001f: 0x1, 0x2, 0x4 and 0x10 the row's ssdMultiplier[0..3], 0x8 its
 *   ssdMultiplier2, 0x40000 its ssdMultiplier3; any other value none. A stat is Bonus × multiplier / 10000, cut.
 * - The armour (0x0061a6b0), flags & 0xf801e0: 0x20..0x100 armorMod[0..3], 0x80000 the column after the
 *   multipliers, 0x100000..0x800000 armorMod2[0..3].
 * - The damage (0x0061a830), flags & 0x7e00: 0x200..0x4000 dpsMod[0..5], per second DPS × (1 − v) to DPS × (1 + v),
 *   v 0.2f for 0x400 and 0x1000 (two-handed), else 0.3f, in float.
 * - Spell power, flags & 0x8000: the row's spellPower.
 *
 * Not read: the level a link carries — 0x0061e740 may take one from the tooltip's own data, which was not traced.
 */

import type { ScalingStatDistributionInfo } from "../gateway/ItemEnchantments.js";

/** The rows the rules read; a missing one reads as Wow.exe's missing record. */
export interface ItemScalingTables {
  distribution(id: number): Pick<ScalingStatDistributionInfo, "stats" | "bonuses" | "maxLevel"> | undefined;
  /** ScalingStatValues row `level − 1` of the file: 24 words. */
  values(level: number): readonly number[] | undefined;
}

/** The tables over the enchantment client's (ItemEnchantments.ts); undefined while they are not loaded. */
export function itemScalingTables(client: {
  readonly scalingReady: boolean;
  readonly scalingDistributions: ReadonlyMap<number, Pick<ScalingStatDistributionInfo, "stats" | "bonuses" | "maxLevel">>;
  readonly scalingValues: readonly (readonly number[])[];
} | undefined): ItemScalingTables | undefined {
  if (!client?.scalingReady) return undefined;
  return {
    distribution: (id) => client.scalingDistributions.get(id),
    values: (level) => (level >= 1 ? client.scalingValues[level - 1] : undefined),
  };
}

/** 0x0061e740: the level a heirloom is drawn at. */
export function itemScalingLevel(requiredLevel: number, maxLevel: number | undefined, level: number): number {
  let result = level;
  if (maxLevel !== undefined) {
    const floor = Math.max(requiredLevel, level);
    result = floor < maxLevel ? floor : maxLevel;
  }
  return Math.max(1, result);
}

/** 0x0061a650. */
export function itemScalingMultiplier(row: readonly number[] | undefined, flags: number): number {
  if (!row) return 0;
  switch (flags & 0x4001f) {
    case 0x1: return row[2] ?? 0;
    case 0x2: return row[3] ?? 0;
    case 0x4: return row[4] ?? 0;
    case 0x8: return row[17] ?? 0;
    case 0x10: return row[5] ?? 0;
    case 0x40000: return row[18] ?? 0;
    default: return 0;
  }
}

/** 0x0061a6b0. */
export function itemScalingArmor(row: readonly number[] | undefined, flags: number): number {
  if (!row) return 0;
  const column = ({
    0x20: 6, 0x40: 7, 0x80: 8, 0x100: 9, 0x80000: 19, 0x100000: 20, 0x200000: 21, 0x400000: 22, 0x800000: 23,
  } as Record<number, number>)[flags & 0xf801e0];
  return column === undefined ? 0 : row[column] ?? 0;
}

const TWO_HAND_SPREAD = Math.fround(0.2);
const ONE_HAND_SPREAD = Math.fround(0.3);

/** 0x0061a830: a hit's damage per second, low and high, in float. */
export function itemScalingDps(row: readonly number[] | undefined, flags: number): { readonly min: number; readonly max: number } {
  const masked = flags & 0x7e00;
  const column = ({ 0x200: 10, 0x400: 11, 0x800: 12, 0x1000: 13, 0x2000: 14, 0x4000: 15 } as Record<number, number>)[masked];
  const dps = Math.fround(column === undefined || !row ? 0 : row[column] ?? 0);
  const spread = masked === 0x400 || masked === 0x1000 ? TWO_HAND_SPREAD : ONE_HAND_SPREAD;
  return { min: Math.fround(dps - dps * spread), max: Math.fround((spread + 1) * dps) };
}

/** A heirloom at a level: its flags, rows and multiplier. */
export interface ItemScaling {
  readonly flags: number;
  readonly level: number;
  readonly distribution: Pick<ScalingStatDistributionInfo, "stats" | "bonuses" | "maxLevel"> | undefined;
  readonly row: readonly number[] | undefined;
  readonly multiplier: number;
}

/** The record's scaling at the unit's `level`; undefined for a record that does not scale (ScalingStatValue 0). */
export function itemScaling(record: {
  readonly scalingStatDistribution: number; readonly scalingStatValue: number; readonly requiredLevel: number;
}, level: number, tables: ItemScalingTables): ItemScaling | undefined {
  const flags = record.scalingStatValue >>> 0;
  if (flags === 0) return undefined;
  const distribution = tables.distribution(record.scalingStatDistribution);
  const at = itemScalingLevel(record.requiredLevel, distribution?.maxLevel, level);
  const row = tables.values(at);
  return { flags, level: at, distribution, row, multiplier: itemScalingMultiplier(row, flags) };
}

/** The distribution's stats at the multiplier, in its order: Bonus × multiplier / 10000, cut toward zero. */
export function itemScaledStats(scaling: ItemScaling): { readonly type: number; readonly value: number }[] {
  const distribution = scaling.distribution;
  if (!distribution) return [];
  return distribution.stats.map((type, index) => ({
    type, value: Math.trunc(((distribution.bonuses[index] ?? 0) * scaling.multiplier) / 10000),
  }));
}
