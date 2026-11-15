import type { SpellMetadata } from "../../gateway/SpellMetadata.js";
import { SPELLMOD, smallestOverSchools, spellTextModInt, spellTextModifierTotals, type SpellTextCaster,
  type SpellTextCasterRecord } from "./SpellTextCaster.js";
import { spellTextFloat, spellTextInt, type SpellTextPlayer } from "./SpellTextPlayer.js";
import { spellTextRoundEven } from "./SpellTextWowRules.js";

/**
 * 3.43 (15.11): a spell's power cost as Wow.exe 3.3.5a 12340 works it out for a unit — 0x008012f0 — and its
 * per-second part, 0x007ff100 (Ghidra 2026-11-15, .runtime/re-2026-11-15/spelltext5/r1.c, r2.c). One function in the
 * original feeds all four places a cost shows: the description's `$c` (0x00579e50) and `${…}`'s cost (0x005782d0), the
 * tooltip's cost row (0x006238a0), GetSpellInfo's fourth value (0x00540a30) and Spell_C_HaveSpellPower (0x008017e0),
 * the «not enough mana» tint. This module is that function; the callers divide by the power's display scale.
 *
 * 0x008012f0(spell, unit), in order:
 * 1. ManaCost (+0xa8) + ManaCostPerLevel (+0xac) × (the unit's level for the spell − BaseLevel (+0x98)). The level is
 *    the unit's vtable +0x13c over 5 — for the active player its skill line for the spell (0x006dc330,
 *    SpellTextCaster.ts), for another unit UNIT_FIELD_LEVEL capped at MaxLevel (0x0071aa70). No clamp at 0 here.
 * 2. + ManaCostPct (+0x230) × the base power of PowerType (0x0071b770) / 100, truncated.
 * 3. AttributesEx4 0x400 (SPELL_ATTR4_SPELL_VS_EXTEND_COST, «Отравляющий укол») and the unit is the active player
 *    (0x004cee50): + a weapon speed / 100, unsigned — the CombatRoundTime (+0x18) of the player's SpellShapeshiftForm
 *    row when it has one (0x0071af70: UNIT_FIELD_BYTES_2 byte 3); else the hand's item (EQUIPMENT_SLOT_MAINHAND, or
 *    OFFHAND with SPELL_ATTR3_REQ_OFFHAND 0x1000000): 2000 for an empty slot, an unusable item (0x006d71a0) or a
 *    disarmed hand (0x00718fc0), else the item template's Delay (+0xf4, 0x0067ca30).
 * 4. (cost + the smallest UNIT_FIELD_POWER_COST_MODIFIER over the SchoolMask) × the smallest multiplier step
 *    (0x005ee050, 0x005ee0b0), stored to a float and rounded to nearest-even.
 * 5. SPELLMOD_COST: (v + flat) × pct / 100 (0x007fd970).
 * 6. A unit that is not a player with SPELL_ATTR0 0x80000 and a SpellLevel: × gtNPCManaCostScaler(unit level) /
 *    gtNPCManaCostScaler(SpellLevel) (0x007f6990 with table 6, row = level − 1), when both are above 0 — served since
 *    15.11 as `/dbc/npc-mana-cost-scaler` (npcScaledCost; the unit is then a pet, SpellTextPetCost.ts).
 * 7. A player with an effect 97 (SPELL_EFFECT_CAST_BUTTON, «Зов Стихий»): + the cost of every spell on the action
 *    buttons MiscValue … MiscValue + MiscValueB − 1 of the multi-cast bar (0-based 132 on; MiscValue < 12, the run
 *    within 12) whose row has SPELL_ATTR7_SUMMON_PLAYER_TOTEM, each by this same function (0x005a8c30 per button).
 * 8. Not below 0. Without a unit the function answers 0xffffffff.
 *
 * 0x007ff100: ManaPerSecond (+0xb0) + ManaPerSecondPerLevel (+0xb4) × (level − BaseLevel); above 0, SPELLMOD_COST's
 * percent alone (pct × v / 100). 0 without a unit.
 *
 * Undefined is «this client cannot tell yet» (a column an older gateway lacks, a row not yet fetched, a template not
 * cached): a caller then keeps what it showed before — the marker as written, the gate open.
 */

/** The columns 0x008012f0 and 0x007ff100 read. */
export type SpellCostRecord = Partial<Pick<SpellMetadata,
  "powerType" | "powerCost" | "powerCostPercent" | "manaCostPerLevel" | "manaPerSecond" | "manaPerSecondPerLevel"
  | "schoolMask" | "effectMiscValue" | "effectMiscValueB" | "spellLevel" | "shapeshiftCombatRoundTime">> & SpellTextCasterRecord;

/** The item in an equipment slot as 0x008012f0's weapon branch reads it. */
export interface SpellCostInventoryItem {
  /** ITEM_FIELD_FLAGS, ITEM_FIELD_DURABILITY and ITEM_FIELD_MAXDURABILITY (0x006d71a0: +0x3c, +0xd8, +0xdc). */
  readonly flags: number;
  readonly durability: number;
  readonly maxDurability: number;
  /** The template's Delay in ms; undefined while the template is not cached. */
  readonly delay: number | undefined;
}

/** The unit a cost is worked out for. */
export interface SpellCostUnit {
  /** The unit's update-field words (Fields.readSlot). */
  readonly player: SpellTextPlayer;
  /** The level for the spell (vtable +0x13c over 5) and the SPELLMOD entries; absent: level unknown, no modifiers. */
  readonly caster?: SpellTextCaster | undefined;
  /** TYPEMASK_PLAYER on the unit's OBJECT_FIELD_TYPE. */
  readonly isPlayer: boolean;
  /** 0x004cee50: the unit is the active player. */
  readonly isActivePlayer: boolean;
  /** A form's CombatRoundTime (0: none); undefined: the form's row is not known. */
  readonly formRoundTime?: (form: number) => number | undefined;
  /** The item in an equipment slot; null: the slot is empty; undefined: not known. */
  readonly inventoryItem?: (equipSlot: number) => SpellCostInventoryItem | null | undefined;
  /** What a 0-based action button holds when it is a spell (0x005a8c30); 0 for none. Undefined: not known. */
  readonly actionSpell?: (slot: number) => number | undefined;
  /** Another spell's row: undefined when there is none, "pending" while it is on its way. */
  readonly row?: (id: number) => SpellCostRecord | undefined | "pending";
  /**
   * 3.43 (15.11): gtNPCManaCostScaler by row (level − 1; NpcManaCostScalerClient.ts) for step 6 — undefined for a row
   * outside the table. Absent: the table has not landed, and a cost step 6 scales is unknown.
   */
  readonly npcCostScaler?: ((row: number) => number | undefined) | undefined;
}

const ATTR0_LEVEL_DAMAGE_CALCULATION = 0x80000;
const ATTR3_REQ_OFFHAND = 0x1000000;
const ATTR4_SPELL_VS_EXTEND_COST = 0x400;
const ATTR7_SUMMON_PLAYER_TOTEM = 0x20;
const SPELL_EFFECT_CAST_BUTTON = 97;
/** The multi-cast bar's first action button, 0-based (0x008012f0 adds 0x84). */
const MULTI_CAST_FIRST_SLOT = 132;
const POWER_MANA = 0;
/** 0x00718fc0: UNIT_FLAG_DISARMED in UNIT_FIELD_FLAGS, UNIT_FLAG2_DISARM_OFFHAND in UNIT_FIELD_FLAGS_2. */
const UNIT_FLAG_DISARMED = 0x200000;
const UNIT_FLAG2_DISARM_OFFHAND = 0x80;
const EQUIPMENT_SLOT_MAINHAND = 15;
const ITEM_CLASS_WEAPON = 2;
/** 0x008012f0: the speed taken for an empty, unusable or disarmed hand. */
const DEFAULT_WEAPON_SPEED = 2000;

/** The level-dependent part's level: vtable +0x13c over 5. */
function costLevel(record: SpellCostRecord, unit: SpellCostUnit): number | undefined {
  return unit.caster ? unit.caster.level(record) : undefined;
}

/** The weapon class in an attack hand (0 main, 1 off) as vtable +0x12c reads it, from the visible item entry. */
function handWeaponClass(player: SpellTextPlayer, hand: number): number | undefined {
  const entry = Math.abs(spellTextInt(player, "PLAYER_VISIBLE_ITEM_1_ENTRYID", (EQUIPMENT_SLOT_MAINHAND + hand) * 2));
  return entry > 0 ? player.item?.(entry)?.itemClass : undefined;
}

/** 0x00718fc0: whether the hand (0 main, 1 off) is disarmed. */
export function spellCostHandDisarmed(player: SpellTextPlayer, hand: number): boolean {
  const flags = spellTextInt(player, "UNIT_FIELD_FLAGS") >>> 0;
  if ((flags & UNIT_FLAG_DISARMED) !== 0) {
    const main = handWeaponClass(player, 0) === ITEM_CLASS_WEAPON;
    if (hand === 0) return main;
    if (!main && handWeaponClass(player, 1) === ITEM_CLASS_WEAPON) return true;
  }
  return hand === 1 && ((spellTextInt(player, "UNIT_FIELD_FLAGS_2") >>> 0) & UNIT_FLAG2_DISARM_OFFHAND) !== 0;
}

/** 0x006d71a0: an item the weapon branch takes the speed of — not worn down to 0 durability, and not flag 0x10. */
export function spellCostItemUsable(item: SpellCostInventoryItem): boolean {
  return ((item.flags & 0x8) !== 0 || item.maxDurability === 0 || item.durability !== 0) && (item.flags & 0x10) === 0;
}

/** 0x008012f0's weapon branch: the speed in ms, or undefined when this client cannot tell. */
export function spellCostWeaponSpeed(record: SpellCostRecord, unit: SpellCostUnit): number | undefined {
  // 0x0071af70: the form byte of UNIT_FIELD_BYTES_2; its SpellShapeshiftForm row's CombatRoundTime wins when not 0.
  const form = (spellTextInt(unit.player, "UNIT_FIELD_BYTES_2") >>> 24) & 0xff;
  if (form !== 0) {
    const roundTime = unit.formRoundTime?.(form);
    if (roundTime === undefined) return undefined;
    if (roundTime !== 0) return roundTime >>> 0;
  }
  const hand = ((record.attributes?.[3] ?? 0) & ATTR3_REQ_OFFHAND) !== 0 ? 1 : 0;
  const item = unit.inventoryItem?.(EQUIPMENT_SLOT_MAINHAND + hand);
  if (item === undefined) return undefined;
  if (item === null || !spellCostItemUsable(item) || spellCostHandDisarmed(unit.player, hand)) return DEFAULT_WEAPON_SPEED;
  return item.delay === undefined ? undefined : item.delay >>> 0;
}

/** 0x008012f0 for `unit` (see the module comment); undefined when a fact is missing. */
export function spellPowerCostFor(record: SpellCostRecord, unit: SpellCostUnit | undefined, depth = 0): number | undefined {
  if (!unit) return 0xffffffff;
  if (record.powerCost === undefined || record.powerCostPercent === undefined) return undefined;
  const player = unit.player;
  let cost = record.powerCost;
  const perLevel = record.manaCostPerLevel ?? 0;
  if (perLevel !== 0) {
    const level = costLevel(record, unit);
    if (level === undefined) return undefined;
    cost += (level - (record.baseLevel ?? 0)) * perLevel;
  }
  if (record.powerCostPercent !== 0) {
    const base = player.basePower?.(record.powerType ?? POWER_MANA);
    if (base === undefined) return undefined;
    cost += Math.trunc((base * record.powerCostPercent) / 100);
  }
  if (((record.attributes?.[4] ?? 0) & ATTR4_SPELL_VS_EXTEND_COST) !== 0 && unit.isActivePlayer) {
    const speed = spellCostWeaponSpeed(record, unit);
    if (speed === undefined) return undefined;
    cost += Math.trunc(speed / 100);
  }
  const schools = record.schoolMask ?? 0;
  const modifier = smallestOverSchools(schools, (school) => spellTextInt(player, "UNIT_FIELD_POWER_COST_MODIFIER", school));
  const multiplier = smallestOverSchools(schools, (school) => spellTextFloat(player, "UNIT_FIELD_POWER_COST_MULTIPLIER", school));
  cost = spellTextRoundEven(Math.fround(Math.fround(cost + modifier) * (multiplier + 1)));
  cost = spellTextModInt(record, cost, SPELLMOD.cost, unit.caster);
  if (!unit.isPlayer && ((record.attributes?.[0] ?? 0) & ATTR0_LEVEL_DAMAGE_CALCULATION) !== 0 && (record.spellLevel ?? 0) !== 0) {
    const scaled = npcScaledCost(cost, record.spellLevel ?? 0, unit);
    if (scaled === undefined) return undefined;
    cost = scaled;
  }
  if (unit.isPlayer && depth === 0) {
    const totems = totemCost(record, unit);
    if (totems === undefined) return undefined;
    cost += totems;
  }
  return cost < 1 ? 0 : cost;
}

/**
 * 3.43 (15.11), step 6: gtNPCManaCostScaler(UNIT_FIELD_LEVEL − 1) / gtNPCManaCostScaler(SpellLevel − 1) × the cost,
 * through a float and rounded to nearest-even — only when both rows are above 0, else the cost stays. Undefined while
 * the table has not landed or a row is outside it (what 0x007f6990 answers there is not established).
 */
function npcScaledCost(cost: number, spellLevel: number, unit: SpellCostUnit): number | undefined {
  const table = unit.npcCostScaler;
  if (!table) return undefined;
  const spellRatio = table(spellLevel - 1);
  const unitRatio = table(spellTextInt(unit.player, "UNIT_FIELD_LEVEL") - 1);
  if (spellRatio === undefined || unitRatio === undefined) return undefined;
  const below = Math.fround(spellRatio);
  if (!(below > 0) || !(unitRatio > 0)) return cost;
  return spellTextRoundEven(Math.fround((unitRatio / below) * cost));
}

/** Step 7: the costs of the totems on the buttons each CAST_BUTTON effect names. */
function totemCost(record: SpellCostRecord, unit: SpellCostUnit): number | undefined {
  let sum = 0;
  for (let effect = 0; effect < 3; effect++) {
    if (record.effects?.[effect] !== SPELL_EFFECT_CAST_BUTTON) continue;
    const start = record.effectMiscValue?.[effect];
    const count = record.effectMiscValueB?.[effect];
    if (start === undefined || count === undefined) return undefined;
    if ((start >>> 0) >= 12 || (count >>> 0) + (start >>> 0) >= 13 || count <= 0) continue;
    for (let index = 0; index < count; index++) {
      const id = unit.actionSpell?.(MULTI_CAST_FIRST_SLOT + start + index);
      if (id === undefined) return undefined;
      if (id === 0 || (id & 0xf0000000) !== 0) continue;
      const row = unit.row?.(id);
      if (row === "pending") return undefined;
      if (!row || ((row.attributes?.[7] ?? 0) & ATTR7_SUMMON_PLAYER_TOTEM) === 0) continue;
      // 0x008012f0 calls itself for the totem; the depth only stops a (modded) totem that names buttons itself.
      const one = spellPowerCostFor(row, unit, 1);
      if (one === undefined) return undefined;
      sum += one;
    }
  }
  return sum;
}

/** 0x007ff100 for `unit`: the per-second cost; undefined when a fact is missing. */
export function spellPowerPerSecondFor(record: SpellCostRecord, unit: SpellCostUnit | undefined): number | undefined {
  if (!unit) return 0;
  if (record.manaPerSecond === undefined) return undefined;
  let value = record.manaPerSecond;
  const perLevel = record.manaPerSecondPerLevel ?? 0;
  if (perLevel !== 0) {
    const level = costLevel(record, unit);
    if (level === undefined) return undefined;
    value += (level - (record.baseLevel ?? 0)) * perLevel;
  }
  if (value <= 0) return value;
  const totals = spellTextModifierTotals(record, SPELLMOD.cost, unit.caster);
  return totals ? Math.trunc((totals.pct * value) / 100) : value;
}
