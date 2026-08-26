import { PacketReader } from "../protocol/PacketReader.js";

/**
 * The combat log the server writes as it resolves a spell.
 *
 * Every layout here was read out of the core's own senders rather than out of documentation, and
 * the comment on each parser names the function it mirrors, because these packets have no version
 * marker: a field in the wrong place decodes into a plausible number rather than into an error.
 *
 * Several of these packets end in a block this client has no use for yet — the per-effect body of
 * an execute log, the debug floats behind a damage log. Those parsers read the part they name and
 * stop; they do not call `assertFinished`, and that is deliberate rather than forgotten.
 */

/** `SPELL_HIT_TYPE_CRIT` on the hit info of a spell damage log. */
export const SPELL_HIT_TYPE_CRIT = 0x0002;

export interface SpellDamageLog {
  targetGuid: bigint;
  casterGuid: bigint;
  spellId: number;
  damage: number;
  overkill: number;
  schoolMask: number;
  absorbed: number;
  resisted: number;
  /** Set when the damage is a periodic tick rather than a direct hit. */
  periodic: boolean;
  blocked: number;
  hitInfo: number;
  critical: boolean;
}

/** Mirrors `Unit::SendSpellNonMeleeDamageLog`. */
export function parseSpellDamageLog(payload: Uint8Array): SpellDamageLog {
  const reader = new PacketReader(payload);
  const targetGuid = reader.packedGuid();
  const casterGuid = reader.packedGuid();
  const spellId = reader.u32();
  const damage = reader.u32();
  const overkill = reader.u32();
  const schoolMask = reader.u8();
  const absorbed = reader.u32();
  const resisted = reader.u32();
  const periodic = reader.u8() !== 0;
  reader.u8();
  const blocked = reader.u32();
  const hitInfo = reader.u32();
  return {
    targetGuid, casterGuid, spellId, damage, overkill, schoolMask, absorbed, resisted, periodic,
    blocked, hitInfo, critical: (hitInfo & SPELL_HIT_TYPE_CRIT) !== 0,
  };
}

export interface SpellHealLog {
  targetGuid: bigint;
  casterGuid: bigint;
  spellId: number;
  amount: number;
  /** The part of the heal that went into a full health bar. */
  overheal: number;
  absorbed: number;
  critical: boolean;
}

/** Mirrors `Unit::SendHealSpellLog`. */
export function parseSpellHealLog(payload: Uint8Array): SpellHealLog {
  const reader = new PacketReader(payload);
  const log: SpellHealLog = {
    targetGuid: reader.packedGuid(),
    casterGuid: reader.packedGuid(),
    spellId: reader.u32(),
    amount: reader.u32(),
    overheal: reader.u32(),
    absorbed: reader.u32(),
    critical: reader.u8() !== 0,
  };
  reader.u8();
  reader.assertFinished();
  return log;
}

export interface SpellEnergizeLog {
  targetGuid: bigint;
  casterGuid: bigint;
  spellId: number;
  powerType: number;
  amount: number;
}

/** Mirrors `Unit::SendEnergizeSpellLog`. */
export function parseSpellEnergizeLog(payload: Uint8Array): SpellEnergizeLog {
  const reader = new PacketReader(payload);
  const log = {
    targetGuid: reader.packedGuid(),
    casterGuid: reader.packedGuid(),
    spellId: reader.u32(),
    powerType: reader.u32(),
    amount: reader.u32() | 0,
  };
  reader.assertFinished();
  return log;
}

/** `AuraType`, the few the periodic log branches on. */
export const AURA_PERIODIC_DAMAGE = 3;
export const AURA_PERIODIC_HEAL = 8;
export const AURA_OBS_MOD_HEALTH = 20;
export const AURA_OBS_MOD_POWER = 21;
export const AURA_PERIODIC_ENERGIZE = 24;
export const AURA_PERIODIC_LEECH = 53;
export const AURA_PERIODIC_MANA_LEECH = 64;
export const AURA_PERIODIC_DAMAGE_PERCENT = 89;

export interface PeriodicAuraLog {
  targetGuid: bigint;
  casterGuid: bigint;
  spellId: number;
  auraType: number;
  amount: number;
  overAmount: number;
  schoolMask: number;
  absorbed: number;
  resisted: number;
  critical: boolean;
  /** Present for the energize and leech branches, which name the power they moved. */
  powerType: number | undefined;
}

/**
 * Mirrors `Unit::SendPeriodicAuraLog`. Which fields follow depends on the aura type, and the core
 * writes nothing at all after the type for one it does not know — a tick log for an unhandled
 * aura is a three-field packet, not a malformed one.
 */
export function parsePeriodicAuraLog(payload: Uint8Array): PeriodicAuraLog {
  const reader = new PacketReader(payload);
  const targetGuid = reader.packedGuid();
  const casterGuid = reader.packedGuid();
  const spellId = reader.u32();
  reader.u32();
  const auraType = reader.u32();
  const log: PeriodicAuraLog = {
    targetGuid, casterGuid, spellId, auraType,
    amount: 0, overAmount: 0, schoolMask: 0, absorbed: 0, resisted: 0, critical: false,
    powerType: undefined,
  };

  if (auraType === AURA_PERIODIC_DAMAGE || auraType === AURA_PERIODIC_DAMAGE_PERCENT) {
    log.amount = reader.u32();
    log.overAmount = reader.u32();
    log.schoolMask = reader.u32();
    log.absorbed = reader.u32();
    log.resisted = reader.u32();
    log.critical = reader.u8() !== 0;
  } else if (auraType === AURA_PERIODIC_HEAL || auraType === AURA_OBS_MOD_HEALTH) {
    log.amount = reader.u32();
    log.overAmount = reader.u32();
    log.absorbed = reader.u32();
    log.critical = reader.u8() !== 0;
  } else if (auraType === AURA_OBS_MOD_POWER || auraType === AURA_PERIODIC_ENERGIZE) {
    log.powerType = reader.u32();
    log.amount = reader.u32();
  } else if (auraType === AURA_PERIODIC_MANA_LEECH) {
    log.powerType = reader.u32();
    log.amount = reader.u32();
    reader.f32();
  }
  return log;
}

export interface SpellMissLog {
  spellId: number;
  casterGuid: bigint;
  targets: Array<{ guid: bigint; missInfo: number }>;
}

/** Mirrors `WorldObject::SendSpellMiss`, which writes full guids rather than packed ones. */
export function parseSpellMissLog(payload: Uint8Array): SpellMissLog {
  const reader = new PacketReader(payload);
  const spellId = reader.u32();
  const casterGuid = reader.u64();
  reader.u8();
  const count = reader.u32();
  if (count > 255) throw new RangeError(`Spell miss log names ${count} targets`);
  const targets: Array<{ guid: bigint; missInfo: number }> = [];
  for (let index = 0; index < count; index++) targets.push({ guid: reader.u64(), missInfo: reader.u8() });
  return { spellId, casterGuid, targets };
}

export interface SpellLogPair {
  casterGuid: bigint;
  targetGuid: bigint;
  spellId: number;
}

/**
 * `SMSG_PROCRESIST` and `SMSG_SPELLORDAMAGE_IMMUNE` are the same three fields with full guids:
 * who, at whom, with what. Mirrors `Unit::SendSpellDamageResist` and `SendSpellDamageImmune`.
 */
export function parseSpellLogPair(payload: Uint8Array): SpellLogPair {
  const reader = new PacketReader(payload);
  return { casterGuid: reader.u64(), targetGuid: reader.u64(), spellId: reader.u32() };
}

/** Mirrors the `SMSG_SPELLINSTAKILLLOG` in `SpellEffects.cpp`: killer, victim, spell. */
export function parseInstantKillLog(payload: Uint8Array): SpellLogPair {
  const reader = new PacketReader(payload);
  const log = { casterGuid: reader.u64(), targetGuid: reader.u64(), spellId: reader.u32() };
  reader.assertFinished();
  return log;
}

export interface DamageShieldLog {
  targetGuid: bigint;
  casterGuid: bigint;
  spellId: number;
  damage: number;
  overkill: number;
  schoolMask: number;
}

/** Mirrors the damage-shield block in `Unit::DealMeleeDamage`. Full guids, not packed. */
export function parseDamageShieldLog(payload: Uint8Array): DamageShieldLog {
  const reader = new PacketReader(payload);
  const log = {
    targetGuid: reader.u64(),
    casterGuid: reader.u64(),
    spellId: reader.u32(),
    damage: reader.u32(),
    overkill: reader.u32(),
    schoolMask: reader.u32(),
  };
  reader.assertFinished();
  return log;
}

export interface DispelLog {
  targetGuid: bigint;
  casterGuid: bigint;
  spellId: number;
  /** Each dispelled aura, and whether it was cleansed rather than stripped. */
  dispelled: Array<{ spellId: number; cleansed: boolean }>;
}

/** Mirrors the success branch of the dispel effect. `SMSG_SPELLSTEALLOG` has the same shape. */
export function parseDispelLog(payload: Uint8Array): DispelLog {
  const reader = new PacketReader(payload);
  const targetGuid = reader.packedGuid();
  const casterGuid = reader.packedGuid();
  const spellId = reader.u32();
  reader.u8();
  const count = reader.u32();
  if (count > 255) throw new RangeError(`Dispel log names ${count} auras`);
  const dispelled: Array<{ spellId: number; cleansed: boolean }> = [];
  for (let index = 0; index < count; index++) dispelled.push({ spellId: reader.u32(), cleansed: reader.u8() !== 0 });
  return { targetGuid, casterGuid, spellId, dispelled };
}

export interface ExecuteLog {
  casterGuid: bigint;
  spellId: number;
}

/**
 * Mirrors `Spell::SendLogExecute`, of which only the header is read: what follows is one block per
 * spell effect, in a shape that depends on the effect, and nothing in this client acts on it yet.
 */
export function parseExecuteLog(payload: Uint8Array): ExecuteLog {
  const reader = new PacketReader(payload);
  return { casterGuid: reader.packedGuid(), spellId: reader.u32() };
}

/** Mirrors `Unit::SendPlaySpellVisual` and `SendPlaySpellImpact`: a guid and a SpellVisualKit id. */
export function parseSpellVisualKit(payload: Uint8Array): { guid: bigint; kitId: number } {
  const reader = new PacketReader(payload);
  const kit = { guid: reader.u64(), kitId: reader.u32() };
  reader.assertFinished();
  return kit;
}

/** Mirrors `WorldSession::HandleMirrorImageDataRequest`'s reply: how a mirror image is dressed. */
export interface MirrorImageData {
  guid: bigint;
  displayId: number;
  race: number;
  gender: number;
  classId: number;
  skin: number;
  face: number;
  hair: number;
  hairColour: number;
  facialHair: number;
  guildId: number;
  equipmentDisplayIds: number[];
}

export function parseMirrorImageData(payload: Uint8Array): MirrorImageData {
  const reader = new PacketReader(payload);
  const data: MirrorImageData = {
    guid: reader.u64(),
    displayId: reader.u32(),
    race: reader.u8(),
    gender: reader.u8(),
    classId: reader.u8(),
    skin: reader.u8(),
    face: reader.u8(),
    hair: reader.u8(),
    hairColour: reader.u8(),
    facialHair: reader.u8(),
    guildId: reader.u32(),
    equipmentDisplayIds: [],
  };
  // Eleven visible slots follow, and a creature's reply stops after the guild id.
  while (reader.remaining >= 4) data.equipmentDisplayIds.push(reader.u32());
  return data;
}

export interface EnchantmentLog {
  targetGuid: bigint;
  casterGuid: bigint;
  itemId: number;
  enchantId: number;
}

/** Mirrors `WorldSession::SendEnchantmentLog`. */
export function parseEnchantmentLog(payload: Uint8Array): EnchantmentLog {
  const reader = new PacketReader(payload);
  const log = {
    targetGuid: reader.packedGuid(),
    casterGuid: reader.packedGuid(),
    itemId: reader.u32(),
    enchantId: reader.u32(),
  };
  reader.assertFinished();
  return log;
}
