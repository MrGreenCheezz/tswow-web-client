/**
 * Plan item 3.12 (04.10, L4): the stat difference a shopping tooltip draws under the equipped item
 * — «Если вы замените этот предмет, произойдут следующие изменения характеристик:» and one row per
 * changed stat — as Wow.exe 3.3.5a 12340 builds it (read-only Ghidra, 2026-10-04, described here in
 * this file's own words):
 *
 * * `SetHyperlinkCompareItem` (0x00631850) draws it only when it was handed the anchor tooltip; the
 *   difference (0x00631590) is the hovered item's table less the equipped item's (0x0061dbc0), and
 *   nothing is drawn when either item's record is not in the cache.
 * * One item's table (0x0061f4c0, a record; 0x006206d0 an item object): 75 slots — slot 0 the DPS
 *   (float), slot 1 + i stat index i. Stats of type t add to index 11 + t (0x0061b990); type 38
 *   (attack power) also adds to melee (8) and ranged (9) attack power, type 39 to ranged only;
 *   armour and the six resistances are indices 0-6; each socket adds one per colour bit to 69-72
 *   (meta, red, yellow, blue; 0x0061b930); the shield's block value is 60; the DPS is Σ (min + max)
 *   · 0.5 / (delay · 0.001) over both damage rows, in float (0x0061f410).
 * * The merges (0x0061ba90 → 0x0061b9e0), run on each table and again on the difference: feral
 *   attack power equal to melee drops to 0; then a combined stat is added into its parts and shown
 *   as itself only when the parts end equal (the parts are then cleared), else it is cleared —
 *   spell power 56 ← 53, 52; hit 42 ← 27-29; crit 43 ← 30-32; hit taken 44 ← 33-35; crit taken
 *   45 ← 36-38; haste 47 ← 39-41; POWER_REGEN0 61 ← mana regeneration 54; attack power 7 ← 8, 9.
 * * The rows (0x0062d930): the DPS when |Δ| > FLT_EPSILON as `%s%c%.1f%s %s` — green `|cff00ff00`
 *   and `+` above zero, red `|cffff2020` and `-` otherwise, `|r`, ITEM_MOD_DAMAGE_PER_SECOND_SHORT;
 *   then indices 0-68 except 49 and 50 (the attack-power stat types, shown through 7-9), and last
 *   the four sockets with their icon, each non-zero one as `%s%c%d%s %s` (0x00623810), on a white
 *   row. Before the first row: a blank gold row and ITEM_DELTA_DESCRIPTION, gold, wrapped
 *   (0x006237c0). Labels (0x0061bb20): RESISTANCE<i>_NAME, ITEM_MOD_<type>_SHORT, ITEM_MOD_*
 *   ATTACK_POWER_SHORT, ITEM_MOD_BLOCK_VALUE_SHORT, ITEM_MOD_POWER_REGEN<n>_SHORT,
 *   ITEM_MOD_HEALTH_REGEN_SHORT, EMPTY_SOCKET_<COLOUR>.
 *
 * Not here, for want of data: the stat auras of the item's spells (0x0061f350 → 0x0061b5e0), a
 * random property or suffix (0x0061fa20), heirloom scaling (0x0061f550) and a druid's feral attack
 * power (0x0061a8f0): the table is the item template's own stats.
 */
import type { FrameXmlColor } from "../ui/framexml_compat/FrameXmlTypes.js";

/** What one item contributes: an ItemTemplate satisfies it. */
export interface GameTooltipStatSource {
  readonly stats: readonly { readonly type: number; readonly value: number }[];
  readonly resistances: readonly number[];
  readonly block: number;
  readonly damage: readonly { readonly min: number; readonly max: number }[];
  readonly delay: number;
  readonly sockets: readonly { readonly color: number }[];
}

/** Slot 0 the DPS, slot 1 + i stat index i, the last slot the client's flag word (always 0 here). */
export const GAME_TOOLTIP_STAT_SLOTS = 0x4b;

/** One row of the difference, in the shape GlueTooltipExtras writes. */
export interface GameTooltipStatDeltaRow {
  readonly text: string;
  readonly color: FrameXmlColor;
  readonly wrap?: boolean;
}

const GOLD: FrameXmlColor = Object.freeze({ r: 1, g: 210 / 255, b: 0, a: 1 });
const WHITE: FrameXmlColor = Object.freeze({ r: 1, g: 1, b: 1, a: 1 });
const GREEN = "|cff00ff00";
const RED = "|cffff2020";
/** FLT_EPSILON (0x009ea624). */
const DPS_EPSILON = 1.1920928955078125e-7;

const STAT_TYPE_BASE = 11;
const ATTACK_POWER = 7;
const MELEE_ATTACK_POWER = 8;
const RANGED_ATTACK_POWER = 9;
const FERAL_ATTACK_POWER = 10;
const ITEM_MOD_ATTACK_POWER = 38;
const ITEM_MOD_RANGED_ATTACK_POWER = 39;
const BLOCK_VALUE = 60;
const SOCKET_FIRST = 69;
const SOCKET_COLORS = ["Meta", "Red", "Yellow", "Blue"] as const;
/** The highest stat type the table has a slot for (11 + 61 = 72). */
const MAX_STAT_TYPE = 61;

/** The stat type names of the client's table at 0x00ad65e8 (+0x2c), types 0-48; "" has no name. */
const STAT_TYPE_NAMES: readonly string[] = [
  "MANA", "HEALTH", "", "AGILITY", "STRENGTH", "INTELLECT", "SPIRIT", "STAMINA", "", "", "", "",
  "DEFENSE_SKILL_RATING", "DODGE_RATING", "PARRY_RATING", "BLOCK_RATING", "HIT_MELEE_RATING",
  "HIT_RANGED_RATING", "HIT_SPELL_RATING", "CRIT_MELEE_RATING", "CRIT_RANGED_RATING", "CRIT_SPELL_RATING",
  "HIT_TAKEN_MELEE_RATING", "HIT_TAKEN_RANGED_RATING", "HIT_TAKEN_SPELL_RATING", "CRIT_TAKEN_MELEE_RATING",
  "CRIT_TAKEN_RANGED_RATING", "CRIT_TAKEN_SPELL_RATING", "HASTE_MELEE_RATING", "HASTE_RANGED_RATING",
  "HASTE_SPELL_RATING", "HIT_RATING", "CRIT_RATING", "HIT_TAKEN_RATING", "CRIT_TAKEN_RATING",
  "RESILIENCE_RATING", "HASTE_RATING", "EXPERTISE_RATING", "ATTACK_POWER", "RANGED_ATTACK_POWER", "",
  "SPELL_HEALING_DONE", "SPELL_DAMAGE_DONE", "MANA_REGENERATION", "ARMOR_PENETRATION_RATING",
  "SPELL_POWER", "HEALTH_REGEN", "SPELL_PENETRATION", "BLOCK_VALUE",
];

/** 0x0061ba90's merges: the combined stat and its parts, in the client's order. */
const MERGES: readonly (readonly [number, readonly number[]])[] = [
  [56, [53, 52]], [42, [27, 28, 29]], [43, [30, 31, 32]], [44, [33, 34, 35]], [45, [36, 37, 38]],
  [47, [39, 40, 41]], [61, [54]], [ATTACK_POWER, [MELEE_ATTACK_POWER, RANGED_ATTACK_POWER]],
];

/** 0x0061b9e0 with its last argument 1. */
function spread(table: number[], combined: number, parts: readonly number[]): void {
  const value = table[1 + combined]!;
  let equal = true;
  let previous = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const slot = 1 + parts[index]!;
    table[slot] = table[slot]! + value;
    equal = equal && (index === 0 || table[slot] === previous);
    previous = table[slot]!;
  }
  if (!equal) {
    table[1 + combined] = 0;
    return;
  }
  table[1 + combined] = table[1 + parts[0]!]!;
  for (const part of parts) table[1 + part] = 0;
}

/** 0x0061ba90. */
function merge(table: number[]): void {
  if (table[1 + MELEE_ATTACK_POWER] === table[1 + FERAL_ATTACK_POWER]) table[1 + FERAL_ATTACK_POWER] = 0;
  for (const [combined, parts] of MERGES) spread(table, combined, parts);
}

/** One item's table (0x0061f4c0 without the spell auras, then 0x0061ba90). */
export function gameTooltipItemStats(item: GameTooltipStatSource): number[] {
  const table = new Array<number>(GAME_TOOLTIP_STAT_SLOTS).fill(0);
  for (const { type, value } of item.stats) {
    if (!Number.isInteger(type) || type < 0 || type > MAX_STAT_TYPE) continue;
    table[1 + STAT_TYPE_BASE + type] = table[1 + STAT_TYPE_BASE + type]! + value;
    if (type === ITEM_MOD_ATTACK_POWER) table[1 + MELEE_ATTACK_POWER] = table[1 + MELEE_ATTACK_POWER]! + value;
    if (type === ITEM_MOD_ATTACK_POWER || type === ITEM_MOD_RANGED_ATTACK_POWER) {
      table[1 + RANGED_ATTACK_POWER] = table[1 + RANGED_ATTACK_POWER]! + value;
    }
  }
  for (let school = 0; school < 7; school += 1) table[1 + school] = table[1 + school]! + (item.resistances[school] ?? 0);
  for (const socket of item.sockets.slice(0, 3)) {
    for (let bit = 0; bit < 4; bit += 1) {
      if ((socket.color & (1 << bit)) !== 0) table[1 + SOCKET_FIRST + bit] = table[1 + SOCKET_FIRST + bit]! + 1;
    }
  }
  table[1 + BLOCK_VALUE] = table[1 + BLOCK_VALUE]! + item.block;
  // 0x0061f410 in float: (max + min) · 0.5 / (delay · 0.001), each damage row on its own.
  const f = Math.fround;
  const seconds = f(f(item.delay) * f(0.001));
  let dps = 0;
  for (const damage of item.damage.slice(0, 2)) dps = f(f(f(f(damage.max) + f(damage.min)) * 0.5) / seconds + dps);
  table[0] = dps;
  merge(table);
  return table;
}

/**
 * L4-review (04.10): the random property (or, negative, suffix) id a chat link carries — its seventh
 * number after the entry (`item:entry:enchant:gem1:gem2:gem3:gem4:random:seed:level`); 0 without one.
 */
export function gameTooltipLinkRandomProperty(link: string | undefined): number {
  if (typeof link !== "string") return 0;
  const match = /(?:^|\|H)item:-?\d+((?::-?\d*)*)/.exec(link);
  const value = Number(match?.[1]?.split(":")[6] ?? 0);
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

/**
 * L4-review (04.10): whether the template alone is the table Wow.exe builds for this item. A record
 * with a ScalingStatValue (+0xbc) is built from ScalingStatDistribution at a level instead (0x006265c0
 * / 0x006206d0 → 0x0061f550: its template stats, sockets and block are not read), and an instance with
 * a random property or suffix adds that property's enchantments (→ 0x0061fa20). Neither is served
 * here, so such an item gets no difference rather than a wrong one from its bare template.
 */
export function gameTooltipStatTableKnown(item: { readonly scalingStatValue?: number }, link: string | undefined): boolean {
  return (item.scalingStatValue ?? 0) === 0 && gameTooltipLinkRandomProperty(link) === 0;
}

/** 0x0061dbc0: hovered − equipped, merged again. */
export function gameTooltipStatDelta(hovered: readonly number[], worn: readonly number[]): number[] {
  const delta = new Array<number>(GAME_TOOLTIP_STAT_SLOTS).fill(0);
  delta[0] = Math.fround((hovered[0] ?? 0) - (worn[0] ?? 0));
  for (let slot = 1; slot < GAME_TOOLTIP_STAT_SLOTS - 1; slot += 1) delta[slot] = (hovered[slot] ?? 0) - (worn[slot] ?? 0);
  merge(delta);
  return delta;
}

/** 0x0061bb20's GlobalStrings key for stat index `index` (0-68); undefined past them. */
function statKey(index: number): string | undefined {
  if (index < 7) return `RESISTANCE${index}_NAME`;
  if (index === ATTACK_POWER) return "ITEM_MOD_ATTACK_POWER_SHORT";
  if (index === MELEE_ATTACK_POWER) return "ITEM_MOD_MELEE_ATTACK_POWER_SHORT";
  if (index === RANGED_ATTACK_POWER) return "ITEM_MOD_RANGED_ATTACK_POWER_SHORT";
  if (index === FERAL_ATTACK_POWER) return "ITEM_MOD_FERAL_ATTACK_POWER_SHORT";
  if (index < 60) {
    const name = STAT_TYPE_NAMES[index - STAT_TYPE_BASE] ?? "";
    return name ? `ITEM_MOD_${name}_SHORT` : "_SHORT";
  }
  if (index === BLOCK_VALUE) return "ITEM_MOD_BLOCK_VALUE_SHORT";
  if (index < 68) return `ITEM_MOD_POWER_REGEN${index - 61}_SHORT`;
  if (index === 68) return "ITEM_MOD_HEALTH_REGEN_SHORT";
  return undefined;
}

/** The rows 0x0062d930 writes for a difference; none when nothing changed. */
export function gameTooltipStatDeltaRows(
  delta: readonly number[], globalString: (key: string) => string | undefined,
): GameTooltipStatDeltaRow[] {
  const rows: GameTooltipStatDeltaRow[] = [];
  const label = (key: string): string => globalString(key) ?? "";
  const header = (): void => {
    if (rows.length > 0) return;
    rows.push({ text: " ", color: GOLD });
    rows.push({ text: label("ITEM_DELTA_DESCRIPTION"), color: GOLD, wrap: true });
  };
  const change = (value: number, text: string): void => {
    if (value === 0 || !Number.isFinite(value)) return;
    header();
    rows.push({ text: `${value > 0 ? GREEN : RED}${value > 0 ? "+" : "-"}${Math.abs(value)}|r ${text}`, color: WHITE });
  };
  const dps = delta[0] ?? 0;
  // A NaN (two items without a weapon delay) fails the comparison and writes nothing, as in x87.
  if (Math.abs(dps) > DPS_EPSILON) {
    header();
    const up = dps > 0;
    rows.push({
      text: `${up ? GREEN : RED}${up ? "+" : "-"}${Math.abs(dps).toFixed(1)}|r ${label("ITEM_MOD_DAMAGE_PER_SECOND_SHORT")}`,
      color: WHITE,
    });
  }
  for (let index = 0; index < SOCKET_FIRST; index += 1) {
    if (index === STAT_TYPE_BASE + ITEM_MOD_ATTACK_POWER || index === STAT_TYPE_BASE + ITEM_MOD_RANGED_ATTACK_POWER) continue;
    const value = delta[1 + index] ?? 0;
    if (value !== 0) change(value, label(statKey(index)!));
  }
  SOCKET_COLORS.forEach((colour, offset) => {
    const value = delta[1 + SOCKET_FIRST + offset] ?? 0;
    if (value === 0) return;
    change(value, `|TInterface\\ItemSocketingFrame\\UI-EmptySocket-${colour}.blp:12|t  ${label(`EMPTY_SOCKET_${colour.toUpperCase()}`)}`);
  });
  return rows;
}
