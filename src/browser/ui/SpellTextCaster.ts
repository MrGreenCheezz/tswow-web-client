import type { SpellMetadata } from "../../gateway/SpellMetadata.js";

/**
 * 3.43 (11.11): the caster side of Wow.exe 3.3.5a 12340's spell description numbers — the caster-level growth
 * and the player's spell modifiers — read in Ghidra 2026-11-11 (.runtime/re-2026-11-11/spelltext/).
 *
 * * **The level** (0x007ff070): the active player's vtable slot +0x13c over 5. For a player (0x006dc330) that slot
 *   is the value of the skill line the spell's SkillLineAbility row names for the player's race and class
 *   (0x00812410 with 0x00810320's masks; 0x006dc2c0: the value, plus its permanent bonus when the value is not 0,
 *   plus the signed temporary bonus, 0 below 0), capped at MaxLevel × 5 when MaxLevel > 0. A spell with no such row
 *   reads level 0 — no growth. A weapon-requiring spell is first swapped for a weapon skill's spell by the equipped
 *   weapons (0x006d4920, a table filled at run time): that one is not modelled, its level is unknown.
 * * **The value** (0x007ff770): EffectBasePoints + 1 and EffectBasePoints + EffectDieSides, each plus
 *   EffectRealPointsPerLevel × (level − BaseLevel, when BaseLevel > 0; not below 0), in the client's software floats.
 *   Unless the caller says the numbers are an aura's (0x0057abc0's last argument), the spell modifiers
 *   SPELLMOD_ALL_EFFECTS, SPELLMOD_EFFECT1/2/3, SPELLMOD_DAMAGE or SPELLMOD_DOT for the effects 0x007fd440 calls
 *   damage, and SPELLMOD_THREAT for the threat auras follow (0x007fdbe0). Then each is put on a 1/128 grid
 *   (×128, + 0.5, floor, ÷128) and, for the effects 0x007fd440 rounds, the minimum floored and the maximum raised.
 * * **A modifier** (0x007fd970): only for a spell of the player's own family (SpellClassSet = the class's,
 *   DAT_00d397b4) without SPELL_ATTR3_NO_CASTER_MODIFIERS; the flat and percent entries of SMSG_SET_FLAT/PCT_SPELL_MODIFIER
 *   whose family bit is in the spell's SpellClassMask are summed per op, the percent becomes 100 + the sum (not
 *   below 0), and an op with neither leaves the number alone. Integers: (v + flat) × pct / 100, truncated (0x007fdb50);
 *   floats: (v + flat) × pct × 0.01 (0x007fdba0, 0x007fdbe0).
 *
 * The client's software floats (0x0095d230 multiply, 0x0095d2f0 add) truncate where IEEE rounds; the grid above
 * absorbs that last-bit difference, so this uses `Math.fround`.
 */

/** `SpellModOp` (SharedDefines.h): the ops the description writer applies. */
export const SPELLMOD = {
  damage: 0, duration: 1, threat: 2, effect1: 3, charges: 4, range: 5, radius: 6, allEffects: 8, effect2: 12, cost: 14,
  jumpTargets: 17, chanceOfSuccess: 18, activationTime: 19, dot: 22, effect3: 23, valueMultiplier: 27,
} as const;

/** One SPELLMOD entry as `WorldClient.spellModifiers` keeps it (`effectIndex` is the family-mask bit). */
export interface SpellTextModifier {
  readonly effectIndex: number;
  readonly op: number;
  readonly value: number;
  readonly pct: boolean;
}

/** The columns this reads. All optional: an older gateway lacks the growth ones (no growth then, as before). */
export type SpellTextCasterRecord = Partial<Pick<SpellMetadata,
  "id" | "attributes" | "spellClassSet" | "spellClassMask" | "effects" | "effectAura" | "effectBasePoints"
  | "effectDieSides" | "effectRealPointsPerLevel" | "baseLevel" | "maxLevel" | "targets" | "equippedItemClass"
  | "equippedItemSubclass" | "effectSpellClassMask">>;

/** The active player as these rules see it. */
export interface SpellTextCaster {
  /** 0x007ff070: the level the spell's numbers grow by; undefined when this client cannot tell (see the module comment). */
  readonly level: (record: SpellTextCasterRecord) => number | undefined;
  /** DAT_00d397b4: ChrClasses.SpellClassSet of the player's class; undefined while not known (no modifiers then). */
  readonly family?: number | undefined;
  /** The player's SPELLMOD entries. */
  readonly modifiers?: () => Iterable<SpellTextModifier>;
  /** 0x007283a0 with 316: one of the player's auras is SPELL_AURA_PERIODIC_HASTE for this spell. */
  readonly periodicHaste?: (record: SpellTextCasterRecord) => boolean;
}

const ATTR3_NO_CASTER_MODIFIERS = 0x20000000;

/** 0x007fd970: the summed flat and the percent (100 + the sum, not below 0) for `op`, or undefined when none applies. */
export function spellTextModifierTotals(record: SpellTextCasterRecord, op: number, caster: SpellTextCaster | undefined):
  { readonly flat: number; readonly pct: number } | undefined {
  const family = caster?.family;
  if (!caster?.modifiers || family === undefined || !record.spellClassSet || record.spellClassSet !== family) return undefined;
  if (((record.attributes?.[3] ?? 0) & ATTR3_NO_CASTER_MODIFIERS) !== 0) return undefined;
  const mask = record.spellClassMask;
  if (!mask) return undefined;
  let flat = 0;
  let pct = 0;
  for (const modifier of caster.modifiers()) {
    if (modifier.op !== op) continue;
    const bit = modifier.effectIndex;
    if (!Number.isInteger(bit) || bit < 0 || bit >= 96) continue;
    if (((mask[bit >>> 5] ?? 0) & (1 << (bit & 31))) === 0) continue;
    if (modifier.pct) pct += modifier.value;
    else flat += modifier.value;
  }
  if (flat === 0 && pct === 0) return undefined;
  return { flat, pct: Math.max(0, 100 + pct) };
}

/** 3.43 (11.11): 0x005ee050 / 0x005ee0b0 — the smallest per-school value over the mask's schools (0 with none). */
export function smallestOverSchools(mask: number, read: (school: number) => number): number {
  let found = false;
  let value = 0;
  for (let school = 0; school < 7; school++) {
    if ((mask & (1 << school)) === 0) continue;
    const next = read(school);
    if (!found || next < value) { value = next; found = true; }
  }
  return value;
}

/** 0x007fdb50: an integer through `op`. */
export function spellTextModInt(record: SpellTextCasterRecord, value: number, op: number, caster: SpellTextCaster | undefined): number {
  const totals = spellTextModifierTotals(record, op, caster);
  return totals ? Math.trunc(((value + totals.flat) * totals.pct) / 100) : value;
}

const HUNDREDTH = Math.fround(0.01);

/** 0x007fdba0 and 0x007fdbe0: a float through `op`. */
export function spellTextModFloat(record: SpellTextCasterRecord, value: number, op: number, caster: SpellTextCaster | undefined): number {
  const totals = spellTextModifierTotals(record, op, caster);
  if (!totals) return value;
  return Math.fround(Math.fround(Math.fround(value + totals.flat) * totals.pct) * HUNDREDTH);
}

/** What 0x007fd440 says of an effect: whether the damage ops apply, as a DoT, and whether the result is rounded out. */
export interface SpellTextEffectKind {
  readonly damage: boolean;
  readonly dot: boolean;
  readonly round: boolean;
}

/** SPELL_EFFECT_* that 0x007fd440 calls damage or healing: school damage, leech, heal, the weapon ones, heal max health, mechanical, normalized. */
const DAMAGE_EFFECTS = new Set([2, 9, 10, 17, 31, 58, 67, 75, 121]);
/** The aura-applying effects (apply aura, persistent and the area auras), whose aura then decides. */
const AURA_EFFECTS = new Set([6, 27, 35, 65, 119, 128, 129, 143]);
/** Rounded, no damage ops: power drain, energize, power burn, and 146. */
const ROUNDED_EFFECTS = new Set([8, 30, 62, 146]);
/** Periodic damage, heal, obs mod health, leech, health funnel, damage percent: the DoT op. */
const DOT_AURAS = new Set([3, 8, 20, 53, 62, 89]);
/** Damage shield and proc trigger damage: the damage op. */
const DAMAGE_AURAS = new Set([15, 43]);
/** Obs mod power, periodic energize, mana funnel, mana leech, power burn: rounded only. */
const ROUNDED_AURAS = new Set([21, 24, 63, 64, 162]);

export function spellTextEffectKind(effect: number, aura: number): SpellTextEffectKind {
  if (DAMAGE_EFFECTS.has(effect)) return { damage: true, dot: false, round: true };
  if (ROUNDED_EFFECTS.has(effect)) return { damage: false, dot: false, round: true };
  if (AURA_EFFECTS.has(effect)) {
    if (DOT_AURAS.has(aura)) return { damage: true, dot: true, round: true };
    if (DAMAGE_AURAS.has(aura)) return { damage: true, dot: false, round: true };
    if (ROUNDED_AURAS.has(aura)) return { damage: false, dot: false, round: true };
  }
  return { damage: false, dot: false, round: false };
}

/** SPELL_AURA_MOD_THREAT, MOD_TOTAL_THREAT, MOD_CRITICAL_THREAT: SPELLMOD_THREAT too. */
const THREAT_AURAS = new Set([10, 103, 183]);
const EFFECT_OPS = [SPELLMOD.effect1, SPELLMOD.effect2, SPELLMOD.effect3] as const;

/** 0x007ff960…: ×128 (+7 to a non-zero exponent), + 0.5, floor, ÷128 — the value on a 1/128 grid. */
function grid(value: number): number {
  if (value === 0) return 0;
  return Math.fround(Math.floor(Math.fround(Math.fround(value * 128) + 0.5)) / 128);
}

/**
 * 0x007ff770: an effect's minimum and maximum. `level` is 0x0057abc0's level argument (an aura's caster level), 0 for
 * the caster's own (0x007ff070); `modified` false is an aura's tooltip (no spell modifiers). Undefined when the
 * value's columns are missing, or when it grows with a level this client cannot tell.
 */
export function spellTextEffectRange(record: SpellTextCasterRecord, effect: number, level: number,
  caster: SpellTextCaster | undefined, modified: boolean): { readonly min: number; readonly max: number } | undefined {
  const base = record.effectBasePoints?.[effect];
  const sides = record.effectDieSides?.[effect];
  if (base === undefined || sides === undefined) return undefined;
  const perLevel = Math.fround(record.effectRealPointsPerLevel?.[effect] ?? 0);
  let grown = level;
  if (grown === 0 && caster) {
    const own = caster.level(record);
    if (own === undefined && perLevel !== 0) return undefined;
    grown = own ?? 0;
  }
  const baseLevel = record.baseLevel ?? 0;
  if (baseLevel > 0) grown -= baseLevel;
  if (grown < 0) grown = 0;
  const growth = Math.fround(perLevel * grown);
  // MaxValue is BasePoints + DieSides as written: a DieSides of 0 makes it one below the minimum, as in the client.
  let min = Math.fround(Math.fround(base + 1) + growth);
  let max = Math.fround(Math.fround(base + sides) + growth);
  const kind = spellTextEffectKind(record.effects?.[effect] ?? 0, record.effectAura?.[effect] ?? 0);
  if (modified) {
    const ops: number[] = [SPELLMOD.allEffects, EFFECT_OPS[effect] ?? SPELLMOD.effect1];
    if (kind.damage) ops.push(kind.dot ? SPELLMOD.dot : SPELLMOD.damage);
    if (THREAT_AURAS.has(record.effectAura?.[effect] ?? 0)) ops.push(SPELLMOD.threat);
    for (const op of ops) {
      min = spellTextModFloat(record, min, op, caster);
      max = spellTextModFloat(record, max, op, caster);
    }
  }
  min = grid(min);
  max = grid(max);
  if (kind.round) {
    min = Math.floor(min);
    max = Math.ceil(max);
  }
  return { min, max };
}

/** One SkillLineAbility row as `/dbc/talents` serves it (TalentMetadata.SpellSkillAbilityInfo). */
export interface SpellTextSkillAbility {
  readonly skillLine: number;
  readonly raceMask: number;
  readonly classMask: number;
  readonly excludeRace: number;
  readonly excludeClass: number;
}

/** 0x00810320: a mask (inverted when its exclude word is set) of 0 or with the 1-based id's bit. */
function maskAdmits(mask: number, exclude: number, id: number): boolean {
  const effective = exclude !== 0 ? ~mask : mask;
  return effective === 0 || (effective & (1 << ((id - 1) & 31))) !== 0;
}

/** One of the player's skills as PLAYER_SKILL_INFO_1_1 holds it (Skills.ts readSkills). */
export interface SpellTextSkill {
  readonly skillId: number;
  readonly value: number;
  readonly temporaryBonus: number;
  readonly permanentBonus: number;
}

/** SPELL_EFFECT_WEAPON, TARGET_FLAG_ITEM, SPELL_ATTR2 0x8000000, ITEM_CLASS_WEAPON: 0x006d4920's conditions. */
const SPELL_EFFECT_WEAPON = 25;
const TARGET_FLAG_ITEM = 0x10;
const ATTR2_NO_WEAPON_SKILL_SWAP = 0x8000000;
const ITEM_CLASS_WEAPON = 2;

/**
 * 0x006dc330 over 5 (0x007ff070) for the active player of `race` and `class`: the level a spell's numbers grow by,
 * or undefined for a spell 0x006d4920 would swap for a weapon skill's (not modelled).
 */
export function spellTextPlayerSpellLevel(record: SpellTextCasterRecord, race: number, classId: number,
  abilities: readonly SpellTextSkillAbility[] | undefined, skills: readonly SpellTextSkill[]): number | undefined {
  if (((record.targets ?? 0) & TARGET_FLAG_ITEM) === 0 && ((record.attributes?.[2] ?? 0) & ATTR2_NO_WEAPON_SKILL_SWAP) === 0
    && record.effects?.[0] !== SPELL_EFFECT_WEAPON && record.equippedItemClass === ITEM_CLASS_WEAPON
    && (record.equippedItemSubclass ?? 0) !== 0) return undefined;
  const row = abilities?.find((ability) => maskAdmits(ability.raceMask, ability.excludeRace, race)
    && maskAdmits(ability.classMask, ability.excludeClass, classId));
  if (!row) return 0;
  const skill = skills.find((entry) => entry.skillId === row.skillLine);
  if (!skill) return 0;
  let value = skill.value === 0 ? 0 : skill.value + (skill.permanentBonus & 0xffff);
  value += skill.temporaryBonus;
  if (value < 0) value = 0;
  const maxLevel = record.maxLevel ?? 0;
  if (maxLevel > 0 && maxLevel * 5 <= value) value = maxLevel * 5;
  return Math.trunc(value / 5);
}

/** SPELL_AURA_PERIODIC_HASTE. */
const SPELL_AURA_PERIODIC_HASTE = 316;

/**
 * The 96-bit class mask of a modifier aura's effect `effect`, as the client reads it (0x007fde80: record +0x1e8,
 * +0x1f4, +0x200 — effect-major). `/dbc/spells?v=21` serves it the same way: `effectSpellClassMask[e]` is effect
 * `e`'s three words (WoWDBDefs' column A is effect 0's words; rows of an older key were transposed).
 */
export function spellTextEffectClassMask(record: SpellTextCasterRecord, effect: number): number[] | undefined {
  const words = record.effectSpellClassMask?.[effect];
  return words ? [0, 1, 2].map((word) => words[word] ?? 0) : undefined;
}

/** 0x007fdec0: the same family, and the aura effect's mask meets the spell's. */
export function spellTextAffectedBy(spell: SpellTextCasterRecord, aura: SpellTextCasterRecord, effect: number): boolean {
  if (spell.spellClassSet === undefined || spell.spellClassSet !== aura.spellClassSet) return false;
  const mask = spellTextEffectClassMask(aura, effect);
  const own = spell.spellClassMask;
  if (!mask || !own) return false;
  return mask.some((word, index) => (word & (own[index] ?? 0)) !== 0);
}

/**
 * 0x007283a0(316): one of `auras` (spell id and the slot's flags byte, AFLAG_EFF_INDEX_n in bits 0-2) has an active
 * SPELL_AURA_PERIODIC_HASTE effect that affects `spell`. An aura whose row `row` does not have is passed over.
 */
export function spellTextPeriodicHaste(spell: SpellTextCasterRecord,
  auras: Iterable<{ readonly spellId: number; readonly flags?: number }>,
  row: (id: number) => SpellTextCasterRecord | undefined): boolean {
  for (const aura of auras) {
    const record = row(aura.spellId);
    if (!record) continue;
    for (let effect = 0; effect < 3; effect++) {
      if (record.effectAura?.[effect] !== SPELL_AURA_PERIODIC_HASTE) continue;
      if (((aura.flags ?? 0) & (1 << effect)) === 0) continue;
      if (spellTextAffectedBy(spell, record, effect)) return true;
    }
  }
  return false;
}
