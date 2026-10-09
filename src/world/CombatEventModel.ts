/**
 * Plan item 3.01, mechanism M8 slice C «normaliser»: packet facts → combat log entries, the shape
 * Wow.exe 3.3.5a 12340 keeps (read-only Ghidra, .runtime/re-2026-10-02/a2-m8/).
 *
 * The original's entry (UnitCombatLog_C.cpp) is a record with a timestamp, a subevent index into the
 * 50-name table at 0x00adb758 (ENVIRONMENTAL_DAMAGE … UNIT_DISSIPATES, `COMBAT_LOG_SUBEVENTS` below),
 * the two guids, names and flags, a spell id and a suffix-flag word (+0x54) that tells 0x0074e290
 * which values follow the spell (`CombatLogSuffix`). This module fills that record from the facts
 * this client's packet parsers already produce, and nothing here allocates per fact: the caller hands
 * in an entry (a pooled object) through `CombatEntrySink`.
 *
 * Mapping, by the handlers that create entries in Wow.exe:
 * - melee (0x007512b0): victim state 1 or 5 with damage → SWING_DAMAGE (damage block: amount,
 *   overkill, the first sub-damage's school, the summed resists and absorbs, blocked; hit info 0x200
 *   critical, 0x10000 glancing, 0x20000 crushing); else hit info 0x10 MISS, 0x20 ABSORB (summed
 *   absorbs), 0x80 RESIST (summed resists), victim state 2 DODGE, 3 PARRY, 5 BLOCK (blocked),
 *   6 EVADE, 7 IMMUNE, 8 DEFLECT → SWING_MISSED; any other state writes nothing.
 * - spell damage (0x00751c40): a spell with ATTR0 0x80|0x100 (hidden, hidden in combat log) writes
 *   nothing; damage → SPELL_DAMAGE / RANGE_DAMAGE (ATTR3 0x8000) / SPELL_PERIODIC_DAMAGE, critical
 *   from hit info 0x2; no damage → ABSORB, else BLOCK, else RESIST as SPELL_MISSED / RANGE_MISSED /
 *   SPELL_PERIODIC_MISSED with the amount.
 * - heal (0x00750860): SPELL_HEAL / SPELL_PERIODIC_HEAL: amount, overheal, absorbed, critical.
 * - energize (0x00750a90) and drain/leech (0x00750b60): amounts divided by the power's display
 *   factor (0x007fde00: rage and runic power 10); the drain's extra amount nil when 0.
 * - environmental (0x00751150): ENVIRONMENTAL_DAMAGE, the type by name (0x00ad671c: FATIGUE,
 *   DROWNING, FALLING, LAVA, SLIME, FIRE), school `1 << 0x00a2d394[type]`, no overkill or block.
 * - procresist (0x00750d40): SPELL_MISSED RESIST with an amount of 0. Damage shield (0x00752c90):
 *   DAMAGE_SHIELD with the damage block and no resist/block/absorb.
 * - a miss's amount (0x0074d980): only RESIST (2), BLOCK (5) and ABSORB (10) carry one.
 */

/** The subevent table at 0x00adb758, in its order: the index is the entry's subevent. */
export const COMBAT_LOG_SUBEVENTS = Object.freeze([
  "ENVIRONMENTAL_DAMAGE", "SWING_DAMAGE", "SWING_MISSED", "RANGE_DAMAGE", "RANGE_MISSED",
  "SPELL_CAST_START", "SPELL_CAST_SUCCESS", "SPELL_CAST_FAILED", "SPELL_MISSED", "SPELL_DAMAGE",
  "SPELL_HEAL", "SPELL_ENERGIZE", "SPELL_DRAIN", "SPELL_LEECH", "SPELL_INSTAKILL",
  "SPELL_SUMMON", "SPELL_CREATE", "SPELL_INTERRUPT", "SPELL_EXTRA_ATTACKS", "SPELL_DURABILITY_DAMAGE",
  "SPELL_DURABILITY_DAMAGE_ALL", "SPELL_AURA_APPLIED", "SPELL_AURA_APPLIED_DOSE", "SPELL_AURA_REMOVED_DOSE",
  "SPELL_AURA_REMOVED", "SPELL_AURA_REFRESH", "SPELL_DISPEL", "SPELL_STOLEN", "SPELL_AURA_BROKEN",
  "SPELL_AURA_BROKEN_SPELL", "DAMAGE_AURA_BROKEN", "ENCHANT_APPLIED", "ENCHANT_REMOVED",
  "SPELL_PERIODIC_MISSED", "SPELL_PERIODIC_DAMAGE", "SPELL_PERIODIC_HEAL", "SPELL_PERIODIC_ENERGIZE",
  "SPELL_PERIODIC_DRAIN", "SPELL_PERIODIC_LEECH", "SPELL_DISPEL_FAILED", "DAMAGE_SHIELD",
  "DAMAGE_SHIELD_MISSED", "DAMAGE_SPLIT", "PARTY_KILL", "UNIT_DIED", "UNIT_DESTROYED", "SPELL_RESURRECT",
  "SPELL_BUILDING_DAMAGE", "SPELL_BUILDING_HEAL", "UNIT_DISSIPATES",
] as const);

export type CombatLogSubevent = typeof COMBAT_LOG_SUBEVENTS[number];

/** Subevent indices (the table above). */
export const CL = Object.freeze({
  ENVIRONMENTAL_DAMAGE: 0, SWING_DAMAGE: 1, SWING_MISSED: 2, RANGE_DAMAGE: 3, RANGE_MISSED: 4,
  SPELL_CAST_START: 5, SPELL_CAST_SUCCESS: 6, SPELL_CAST_FAILED: 7, SPELL_MISSED: 8, SPELL_DAMAGE: 9,
  SPELL_HEAL: 10, SPELL_ENERGIZE: 11, SPELL_DRAIN: 12, SPELL_LEECH: 13, SPELL_INSTAKILL: 14,
  SPELL_SUMMON: 15, SPELL_CREATE: 16, SPELL_INTERRUPT: 17, SPELL_EXTRA_ATTACKS: 18,
  SPELL_DURABILITY_DAMAGE: 19, SPELL_DURABILITY_DAMAGE_ALL: 20, SPELL_AURA_APPLIED: 21,
  SPELL_AURA_APPLIED_DOSE: 22, SPELL_AURA_REMOVED_DOSE: 23, SPELL_AURA_REMOVED: 24, SPELL_AURA_REFRESH: 25,
  SPELL_DISPEL: 26, SPELL_STOLEN: 27, ENCHANT_APPLIED: 31, SPELL_PERIODIC_MISSED: 33,
  SPELL_PERIODIC_DAMAGE: 34, SPELL_PERIODIC_HEAL: 35, SPELL_PERIODIC_ENERGIZE: 36, SPELL_PERIODIC_DRAIN: 37,
  SPELL_PERIODIC_LEECH: 38, SPELL_DISPEL_FAILED: 39, DAMAGE_SHIELD: 40, PARTY_KILL: 43, UNIT_DIED: 44,
  SPELL_RESURRECT: 46,
});

/** The suffix word (+0x54): which values 0x0074e290 pushes after the spell, in its order. */
export const CombatLogSuffix = Object.freeze({
  /** number (n0): extra attacks. */
  NUMBER: 0x1,
  /** string (s0): SPELL_CAST_FAILED's reason. */
  STRING: 0x2,
  /** missType name (n0 indexes COMBAT_LOG_MISS_TYPES). */
  MISS: 0x4,
  /** environmental type name (n0 indexes COMBAT_LOG_ENVIRONMENT_TYPES). */
  ENVIRONMENT: 0x8,
  /** amount n1, overkill n2, school n3, resisted n5, blocked n6, absorbed n4 (each nil if 0), crit bits. */
  DAMAGE: 0x10,
  /** amount n0, overhealing n1, absorbed n2, critical (bits & 1). */
  HEAL: 0x20,
  /** amount n0, powerType n1. */
  ENERGIZE: 0x40,
  /** amount n0, powerType n1, extraAmount n2 (nil if 0). */
  DRAIN: 0x80,
  /** extra spell id (n0), name and school. */
  EXTRA_SPELL: 0x100,
  /** item id (n0) and item name (s1). */
  ITEM: 0x200,
  /** BUFF/DEBUFF (bits & 1 = debuff). */
  AURA_TYPE: 0x400,
  /** amount (n2): an aura's stack count. */
  DOSE: 0x800,
  /** string (s0) before the item: ENCHANT_APPLIED's name. */
  NAME: 0x1000,
  /** a miss's amount: ABSORB (n4), RESIST (n5), BLOCK (n6). */
  MISS_ABSORB: 0x2000,
  MISS_RESIST: 0x4000,
  MISS_BLOCK: 0x8000,
});

/** 0x00adbfac: SpellMissInfo → missType (IMMUNE twice: 7 and 8). */
export const COMBAT_LOG_MISS_TYPES = Object.freeze([
  "NONE", "MISS", "RESIST", "DODGE", "PARRY", "BLOCK", "EVADE", "IMMUNE", "IMMUNE", "DEFLECT", "ABSORB", "REFLECT",
]);

/** 0x00ad671c: EnviromentalDamage → name. The seventh word of that table is "None". */
export const COMBAT_LOG_ENVIRONMENT_TYPES = Object.freeze(["FATIGUE", "DROWNING", "FALLING", "LAVA", "SLIME", "FIRE", "None"]);

/** 0x00a2d394: the school index of each environmental type. */
const ENVIRONMENT_SCHOOLS = [0, 0, 0, 2, 3, 2, 5, 5];

/**
 * One combat log entry. Pooled: the sink owns the objects and the normaliser only writes fields.
 * The slots follow 0x0074e290's offsets loosely: n0 = +0x58, n1 = +0x5c, n2 = +0x60, n3 = +0x64,
 * n4 = +0x68, n5 = +0x6c, n6 = +0x70, bits = +0x74.
 */
export interface CombatLogEntry {
  time: number;
  event: number;
  source: bigint;
  dest: bigint;
  spellId: number;
  suffix: number;
  n0: number;
  n1: number;
  n2: number;
  n3: number;
  n4: number;
  n5: number;
  n6: number;
  bits: number;
  s0: string;
  s1: string;
  /** Names and flags; the live layer fills them. */
  sourceName: string | undefined;
  sourceFlags: number;
  destName: string | undefined;
  destFlags: number;
}

export function createCombatLogEntry(): CombatLogEntry {
  return {
    time: 0, event: 0, source: 0n, dest: 0n, spellId: 0, suffix: 0,
    n0: 0, n1: 0, n2: 0, n3: 0, n4: 0, n5: 0, n6: 0, bits: 0, s0: "", s1: "",
    sourceName: undefined, sourceFlags: 0, destName: undefined, destFlags: 0,
  };
}

/** Where entries go: `begin` hands out a cleared entry, `commit` keeps it (and may fire it). */
export interface CombatEntrySink {
  begin(event: number, source: bigint, dest: bigint, spellId: number): CombatLogEntry;
  commit(entry: CombatLogEntry): void;
}

/** What the normaliser needs from spell metadata: only the attribute words. */
export interface CombatSpellFacts {
  /** `attributes[0]` and `attributes[3]`; undefined when the row is not known (yet). */
  attributes(spellId: number): readonly number[] | undefined;
}

const SPELL_ATTR0_HIDDEN = 0x80 | 0x100;
const SPELL_ATTR3_RANGED = 0x8000;
const HITINFO_SPELL_CRIT = 0x2;

/** 0x007fde00: rage and runic power are kept in tenths. */
export function combatLogPowerDivisor(powerType: number): number {
  return powerType === 1 || powerType === 6 ? 10 : 1;
}

function hiddenInLog(spells: CombatSpellFacts, spellId: number): boolean {
  const attributes = spells.attributes(spellId);
  return attributes !== undefined && ((attributes[0] ?? 0) & SPELL_ATTR0_HIDDEN) !== 0;
}

function ranged(spells: CombatSpellFacts, spellId: number): boolean {
  return ((spells.attributes(spellId)?.[3] ?? 0) & SPELL_ATTR3_RANGED) !== 0;
}

function damage(entry: CombatLogEntry, amount: number, overkill: number, school: number,
  resisted: number, blocked: number, absorbed: number, bits: number): void {
  entry.suffix |= CombatLogSuffix.DAMAGE;
  entry.n1 = amount;
  entry.n2 = overkill;
  entry.n3 = school;
  entry.n4 = absorbed;
  entry.n5 = resisted;
  entry.n6 = blocked;
  entry.bits = bits;
}

/** A miss with 0x0074d980's amount rule. */
function miss(entry: CombatLogEntry, missType: number, amount: number): void {
  entry.suffix |= CombatLogSuffix.MISS;
  entry.n0 = missType;
  if (missType === 2) { entry.suffix |= CombatLogSuffix.MISS_RESIST; entry.n5 = amount; }
  else if (missType === 5) { entry.suffix |= CombatLogSuffix.MISS_BLOCK; entry.n6 = amount; }
  else if (missType === 10) { entry.suffix |= CombatLogSuffix.MISS_ABSORB; entry.n4 = amount; }
}

export interface MeleeFact {
  hitInfo: number; attacker: bigint; victim: bigint; damage: number; overkill: number;
  victimState: number; blocked: number;
  damages: readonly { schoolMask: number; absorbed: number; resisted: number }[];
}

/** 0x007512b0. */
export function meleeEntries(fact: MeleeFact, sink: CombatEntrySink): void {
  let absorbed = 0;
  let resisted = 0;
  for (const part of fact.damages) { absorbed += part.absorbed; resisted += part.resisted; }
  const state = fact.victimState;
  if ((state === 1 || state === 5) && fact.damage !== 0) {
    const entry = sink.begin(CL.SWING_DAMAGE, fact.attacker, fact.victim, 0);
    damage(entry, fact.damage, fact.overkill, fact.damages[0]?.schoolMask ?? 1, resisted, fact.blocked, absorbed,
      ((fact.hitInfo >>> 9) & 1) | (((fact.hitInfo >>> 16) & 1) << 1) | (((fact.hitInfo >>> 17) & 1) << 2));
    sink.commit(entry);
    return;
  }
  let missType: number;
  let amount = 0;
  if ((fact.hitInfo & 0x10) !== 0) missType = 1;
  else if ((fact.hitInfo & 0x20) !== 0) { missType = 10; amount = absorbed; }
  else if ((fact.hitInfo & 0x80) !== 0) { missType = 2; amount = resisted; }
  else if (state === 2) missType = 3;
  else if (state === 3) missType = 4;
  else if (state === 5) { missType = 5; amount = fact.blocked; }
  else if (state === 6) missType = 6;
  else if (state === 7) missType = 7;
  else if (state === 8) missType = 9;
  else return;
  const entry = sink.begin(CL.SWING_MISSED, fact.attacker, fact.victim, 0);
  miss(entry, missType, amount);
  sink.commit(entry);
}

export interface SpellDamageFact {
  casterGuid: bigint; targetGuid: bigint; spellId: number; damage: number; overkill: number;
  schoolMask: number; absorbed: number; resisted: number; blocked: number; critical: boolean; periodic: boolean;
}

/** 0x00751c40 (also the periodic damage aura types 3 and 89). */
export function spellDamageEntries(fact: SpellDamageFact, spells: CombatSpellFacts, sink: CombatEntrySink): void {
  if (hiddenInLog(spells, fact.spellId)) return;
  const isRanged = ranged(spells, fact.spellId);
  if (fact.damage !== 0) {
    const event = fact.periodic ? CL.SPELL_PERIODIC_DAMAGE : isRanged ? CL.RANGE_DAMAGE : CL.SPELL_DAMAGE;
    const entry = sink.begin(event, fact.casterGuid, fact.targetGuid, fact.spellId);
    damage(entry, fact.damage, fact.overkill, fact.schoolMask, fact.resisted, fact.blocked, fact.absorbed,
      fact.critical ? 1 : 0);
    sink.commit(entry);
    return;
  }
  let missType: number;
  let amount: number;
  if (fact.absorbed !== 0) { missType = 10; amount = fact.absorbed; }
  else if (fact.blocked !== 0) { missType = 5; amount = fact.blocked; }
  else if (fact.resisted !== 0) { missType = 2; amount = fact.resisted; }
  else return;
  const event = fact.periodic ? CL.SPELL_PERIODIC_MISSED : isRanged ? CL.RANGE_MISSED : CL.SPELL_MISSED;
  const entry = sink.begin(event, fact.casterGuid, fact.targetGuid, fact.spellId);
  miss(entry, missType, amount);
  sink.commit(entry);
}

/** SPELL_MISSED / RANGE_MISSED for a miss decided at cast or landing (no amount; RESIST 0 for procresist). */
export function spellMissEntries(caster: bigint, target: bigint, spellId: number, missType: number,
  spells: CombatSpellFacts, sink: CombatEntrySink, withZeroAmount = false): void {
  if (hiddenInLog(spells, spellId)) return;
  const entry = sink.begin(ranged(spells, spellId) ? CL.RANGE_MISSED : CL.SPELL_MISSED, caster, target, spellId);
  if (withZeroAmount) miss(entry, missType, 0);
  else { entry.suffix |= CombatLogSuffix.MISS; entry.n0 = missType; }
  sink.commit(entry);
}

export function healEntries(caster: bigint, target: bigint, spellId: number, amount: number, overheal: number,
  absorbed: number, critical: boolean, periodic: boolean, sink: CombatEntrySink): void {
  const entry = sink.begin(periodic ? CL.SPELL_PERIODIC_HEAL : CL.SPELL_HEAL, caster, target, spellId);
  entry.suffix |= CombatLogSuffix.HEAL;
  entry.n0 = amount;
  entry.n1 = overheal;
  entry.n2 = absorbed;
  entry.bits = critical ? 1 : 0;
  sink.commit(entry);
}

export function energizeEntries(caster: bigint, target: bigint, spellId: number, amount: number, powerType: number,
  periodic: boolean, sink: CombatEntrySink): void {
  const entry = sink.begin(periodic ? CL.SPELL_PERIODIC_ENERGIZE : CL.SPELL_ENERGIZE, caster, target, spellId);
  entry.suffix |= CombatLogSuffix.ENERGIZE;
  entry.n0 = Math.trunc(amount / combatLogPowerDivisor(powerType));
  entry.n1 = powerType;
  sink.commit(entry);
}

/**
 * SPELL_DRAIN/SPELL_LEECH and the periodic pair: a drain whose multiplier gives the caster nothing is
 * a drain, one that gives is a leech, its extra amount the given part [гип.: the handler's subevent is
 * chosen by its caller, which was not read].
 */
export function drainEntries(caster: bigint, target: bigint, spellId: number, amount: number, powerType: number,
  multiplier: number, periodic: boolean, sink: CombatEntrySink): void {
  const leech = multiplier > 0;
  const event = periodic ? (leech ? CL.SPELL_PERIODIC_LEECH : CL.SPELL_PERIODIC_DRAIN) : (leech ? CL.SPELL_LEECH : CL.SPELL_DRAIN);
  const divisor = combatLogPowerDivisor(powerType);
  const entry = sink.begin(event, caster, target, spellId);
  entry.suffix |= CombatLogSuffix.DRAIN;
  entry.n0 = Math.trunc(amount / divisor);
  entry.n1 = powerType;
  entry.n2 = leech ? Math.trunc(Math.floor(amount * multiplier) / divisor) : 0;
  sink.commit(entry);
}

export interface PeriodicFact {
  targetGuid: bigint; casterGuid: bigint; spellId: number; auraType: number; amount: number; overAmount: number;
  schoolMask: number; absorbed: number; resisted: number; critical: boolean; powerType: number | undefined;
  gainMultiplier?: number;
}

/** SMSG_PERIODICAURALOG by its aura type (Unit::SendPeriodicAuraLog, Unit.cpp:5636-5667). */
export function periodicEntries(fact: PeriodicFact, spells: CombatSpellFacts, sink: CombatEntrySink): void {
  switch (fact.auraType) {
    case 3: case 89:
      spellDamageEntries({
        casterGuid: fact.casterGuid, targetGuid: fact.targetGuid, spellId: fact.spellId, damage: fact.amount,
        overkill: fact.overAmount, schoolMask: fact.schoolMask, absorbed: fact.absorbed, resisted: fact.resisted,
        blocked: 0, critical: fact.critical, periodic: true,
      }, spells, sink);
      return;
    case 8: case 20:
      healEntries(fact.casterGuid, fact.targetGuid, fact.spellId, fact.amount, fact.overAmount, fact.absorbed,
        fact.critical, true, sink);
      return;
    case 21: case 24:
      energizeEntries(fact.casterGuid, fact.targetGuid, fact.spellId, fact.amount, fact.powerType ?? 0, true, sink);
      return;
    case 64:
      drainEntries(fact.casterGuid, fact.targetGuid, fact.spellId, fact.amount, fact.powerType ?? 0,
        fact.gainMultiplier ?? 0, true, sink);
      return;
    default:
  }
}

/** 0x00751150: ENVIRONMENTAL_DAMAGE, no source. */
export function environmentalEntries(victim: bigint, type: number, amount: number, resisted: number, absorbed: number,
  sink: CombatEntrySink): void {
  const entry = sink.begin(CL.ENVIRONMENTAL_DAMAGE, 0n, victim, 0);
  entry.suffix |= CombatLogSuffix.ENVIRONMENT;
  entry.n0 = type;
  damage(entry, amount, 0, 1 << (ENVIRONMENT_SCHOOLS[type] ?? 0), resisted, 0, absorbed, 0);
  sink.commit(entry);
}

/** 0x00752c90: DAMAGE_SHIELD — the damage block without resist, block or absorb. */
export function damageShieldEntries(caster: bigint, target: bigint, spellId: number, amount: number, overkill: number,
  school: number, spells: CombatSpellFacts, sink: CombatEntrySink): void {
  if (hiddenInLog(spells, spellId)) return;
  const entry = sink.begin(CL.DAMAGE_SHIELD, caster, target, spellId);
  damage(entry, amount, overkill, school, 0, 0, 0, 0);
  sink.commit(entry);
}

/** An entry with the spell prefix alone (cast start/success, instakill, summon, create, resurrect…). */
export function spellOnlyEntry(event: number, source: bigint, dest: bigint, spellId: number, sink: CombatEntrySink): void {
  sink.commit(sink.begin(event, source, dest, spellId));
}

/** SPELL_INTERRUPT, SPELL_DISPEL_FAILED: the extra spell. SPELL_DISPEL/_STOLEN also the aura type. */
export function extraSpellEntry(event: number, source: bigint, dest: bigint, spellId: number, extraSpellId: number,
  auraType: "BUFF" | "DEBUFF" | undefined, sink: CombatEntrySink): void {
  const entry = sink.begin(event, source, dest, spellId);
  entry.suffix |= CombatLogSuffix.EXTRA_SPELL;
  entry.n0 = extraSpellId;
  if (auraType !== undefined) {
    entry.suffix |= CombatLogSuffix.AURA_TYPE;
    entry.bits = auraType === "DEBUFF" ? 1 : 0;
  }
  sink.commit(entry);
}

/** The aura edges: APPLIED/REMOVED/REFRESH carry the type; the DOSE pair also the stack count. */
export function auraEntry(event: number, source: bigint, dest: bigint, spellId: number, debuff: boolean,
  stacks: number | undefined, sink: CombatEntrySink): void {
  const entry = sink.begin(event, source, dest, spellId);
  entry.suffix |= CombatLogSuffix.AURA_TYPE;
  entry.bits = debuff ? 1 : 0;
  if (stacks !== undefined) { entry.suffix |= CombatLogSuffix.DOSE; entry.n2 = stacks; }
  sink.commit(entry);
}

/** SPELL_EXTRA_ATTACKS: the count. */
export function extraAttacksEntry(source: bigint, dest: bigint, spellId: number, count: number, sink: CombatEntrySink): void {
  const entry = sink.begin(CL.SPELL_EXTRA_ATTACKS, source, dest, spellId);
  entry.suffix |= CombatLogSuffix.NUMBER;
  entry.n0 = count;
  sink.commit(entry);
}

/** SPELL_CAST_FAILED: the reason, as text. */
export function castFailedEntry(source: bigint, spellId: number, reason: string, sink: CombatEntrySink): void {
  const entry = sink.begin(CL.SPELL_CAST_FAILED, source, 0n, spellId);
  entry.suffix |= CombatLogSuffix.STRING;
  entry.s0 = reason;
  sink.commit(entry);
}

/** ENCHANT_APPLIED: the enchantment's name, the item id and its name; no spell. */
export function enchantEntry(source: bigint, dest: bigint, name: string, itemId: number, itemName: string,
  sink: CombatEntrySink): void {
  const entry = sink.begin(CL.ENCHANT_APPLIED, source, dest, 0);
  entry.suffix |= CombatLogSuffix.NAME | CombatLogSuffix.ITEM;
  entry.s0 = name;
  entry.n0 = itemId;
  entry.s1 = itemName;
  sink.commit(entry);
}

/** The execute log's effects (Spell.cpp:4755-4820) as entries. */
export function executeEntries(caster: bigint, spellId: number,
  effects: readonly { effect: number; records: readonly { target: bigint; value: number; extra: number; multiplier: number }[] }[],
  spells: CombatSpellFacts, sink: CombatEntrySink): void {
  if (hiddenInLog(spells, spellId)) return;
  for (const block of effects) {
    for (const record of block.records) {
      switch (block.effect) {
        case 8: case 62:
          drainEntries(caster, record.target, spellId, record.value, record.extra,
            block.effect === 8 ? record.multiplier : 0, false, sink);
          break;
        case 19:
          extraAttacksEntry(caster, record.target, spellId, record.value, sink);
          break;
        case 68:
          extraSpellEntry(CL.SPELL_INTERRUPT, caster, record.target, spellId, record.value, undefined, sink);
          break;
        case 111: case 115:
          spellOnlyEntry(record.value === -1 ? CL.SPELL_DURABILITY_DAMAGE_ALL : CL.SPELL_DURABILITY_DAMAGE,
            caster, record.target, spellId, sink);
          break;
        case 24: case 157:
          spellOnlyEntry(CL.SPELL_CREATE, caster, 0n, spellId, sink);
          break;
        case 28: case 50: case 56: case 76: case 83: case 104: case 105: case 106: case 107:
          spellOnlyEntry(CL.SPELL_SUMMON, caster, record.target, spellId, sink);
          break;
        case 18: case 113:
          spellOnlyEntry(CL.SPELL_RESURRECT, caster, record.target, spellId, sink);
          break;
        default:
      }
    }
  }
}
