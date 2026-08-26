import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

export interface AttackPair {
  attacker: bigint;
  victim: bigint;
}

export interface AttackStop extends AttackPair {
  victimDied: boolean;
}

export function buildCombatGuid(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

export function parseAttackStart(payload: Uint8Array): AttackPair {
  const reader = new PacketReader(payload);
  const result = { attacker: reader.u64(), victim: reader.u64() };
  reader.assertFinished();
  return result;
}

export function parseAttackStop(payload: Uint8Array): AttackStop {
  const reader = new PacketReader(payload);
  const result = {
    attacker: reader.packedGuid(),
    victim: reader.packedGuid(),
    victimDied: reader.u32() !== 0,
  };
  reader.assertFinished();
  return result;
}

export function parseHealthUpdate(payload: Uint8Array): { guid: bigint; health: number } {
  const reader = new PacketReader(payload);
  const result = { guid: reader.packedGuid(), health: reader.u32() };
  reader.assertFinished();
  return result;
}

/**
 * `HitInfo`, the word that opens every melee swing.
 *
 * Only four of these change the packet's shape; the rest say how to draw the result. Two of the
 * four are never set anywhere in the core this client talks to — `HITINFO_UNK1`, which would add
 * a 52-byte debug block, and `HITINFO_RAGE_GAIN`, which would add a word the server hardcodes to
 * zero — but both are honoured, because a packet that grew a field would otherwise be read as
 * gibberish rather than rejected.
 */
export const HITINFO_DEBUG_BLOCK = 0x00000001;
export const HITINFO_AFFECTS_VICTIM = 0x00000002;
export const HITINFO_OFFHAND = 0x00000004;
export const HITINFO_MISS = 0x00000010;
export const HITINFO_FULL_ABSORB = 0x00000020;
export const HITINFO_PARTIAL_ABSORB = 0x00000040;
export const HITINFO_FULL_RESIST = 0x00000080;
export const HITINFO_PARTIAL_RESIST = 0x00000100;
export const HITINFO_CRITICAL = 0x00000200;
export const HITINFO_BLOCK = 0x00002000;
export const HITINFO_GLANCING = 0x00010000;
export const HITINFO_CRUSHING = 0x00020000;
export const HITINFO_RAGE_GAIN = 0x00800000;

/** `VictimState`: what the target did about the swing. */
export const VICTIMSTATE_INTACT = 0;
export const VICTIMSTATE_HIT = 1;
export const VICTIMSTATE_DODGE = 2;
export const VICTIMSTATE_PARRY = 3;
export const VICTIMSTATE_INTERRUPT = 4;
export const VICTIMSTATE_BLOCKS = 5;
export const VICTIMSTATE_EVADES = 6;
export const VICTIMSTATE_IMMUNE = 7;
export const VICTIMSTATE_DEFLECTS = 8;

/** One school's share of a swing. A swing has one of these, or two when the weapon has two. */
export interface SubDamage {
  /** A mask of `1 << school`, not a school number. Melee is almost always 0x01, physical. */
  schoolMask: number;
  damage: number;
  absorbed: number;
  resisted: number;
}

export interface AttackerState {
  hitInfo: number;
  attacker: bigint;
  victim: bigint;
  /** Both sub-damages added together — the number to put on the screen. */
  damage: number;
  /** How much of that was more than the victim had left. Zero unless this was the killing blow. */
  overkill: number;
  victimState: number;
  blocked: number;
  damages: SubDamage[];
}

/**
 * One melee swing, as the server broadcasts it to everyone who can see it.
 *
 * This is the only packet that says a melee attack happened at all: health arriving through an
 * update block says the number changed, not who did it or whether it was a crit, a dodge or a
 * parry. Everything a swing produces is in here — attacker, victim, the total, the per-school
 * breakdown, absorb, resist, block and the victim's reaction.
 *
 * The sub-damage array is written as three separate loops over the same count, not as an array of
 * structs: every school and amount first, then every absorb, then every resist — and the last two
 * loops are present or absent as whole blocks. Reading it as one interleaved struct would work by
 * accident on a one-school swing and silently mis-parse a two-school one.
 */
export function parseAttackerStateUpdate(payload: Uint8Array): AttackerState {
  const reader = new PacketReader(payload);
  const hitInfo = reader.u32();
  const attacker = reader.packedGuid();
  const victim = reader.packedGuid();
  const damage = reader.u32();
  const overkill = reader.u32();
  const count = reader.u8();
  if (count < 1 || count > 2) throw new Error(`melee swing claims ${count} damage schools`);

  const damages: SubDamage[] = [];
  for (let index = 0; index < count; index++) {
    const schoolMask = reader.u32();
    // The amount twice: once as a float and once as an integer, both the same value.
    reader.f32();
    damages.push({ schoolMask, damage: reader.u32(), absorbed: 0, resisted: 0 });
  }
  if ((hitInfo & (HITINFO_FULL_ABSORB | HITINFO_PARTIAL_ABSORB)) !== 0) {
    for (const entry of damages) entry.absorbed = reader.u32();
  }
  if ((hitInfo & (HITINFO_FULL_RESIST | HITINFO_PARTIAL_RESIST)) !== 0) {
    for (const entry of damages) entry.resisted = reader.u32();
  }

  const victimState = reader.u8();
  reader.u32();  // attacker state, hardcoded zero
  reader.u32();  // melee spell id, hardcoded zero
  const blocked = (hitInfo & HITINFO_BLOCK) !== 0 ? reader.u32() : 0;
  if ((hitInfo & HITINFO_RAGE_GAIN) !== 0) reader.u32();
  if ((hitInfo & HITINFO_DEBUG_BLOCK) !== 0) reader.bytes(52);

  reader.assertFinished();
  return { hitInfo, attacker, victim, damage, overkill, victimState, blocked, damages };
}

/** `SheathState`: nothing drawn, the melee weapons out, or the ranged one. */
export const SHEATH_UNARMED = 0;
export const SHEATH_MELEE = 1;
export const SHEATH_RANGED = 2;

/**
 * Draws or puts away a weapon.
 *
 * The renderer hangs a weapon off a hand only while it is drawn, and the state it reads comes from
 * the server — so without this nobody ever holds anything. The server drops the packet without a
 * word if the value is not 0, 1 or 2.
 */
export function buildSetSheathed(state: number): Uint8Array {
  const clamped = state === SHEATH_MELEE || state === SHEATH_RANGED ? state : SHEATH_UNARMED;
  return new PacketWriter().u32(clamped).toUint8Array();
}

export interface ExperienceGain {
  /** Zero when the experience did not come from killing anything. */
  victim: bigint;
  total: number;
  /** The kill's own share, before group and rested bonuses. Equals `total` for a solo kill. */
  base: number;
  restedBonus: boolean;
}

/**
 * Experience, and where it came from.
 *
 * Variable length: a kill carries the base amount and a group rate after the type byte, and
 * anything else — a quest, a discovery — stops there. The type byte says which, and the guid
 * agrees with it, so either can be trusted.
 */
export function parseExperienceGain(payload: Uint8Array): ExperienceGain {
  const reader = new PacketReader(payload);
  const victim = reader.u64();
  const total = reader.u32();
  const fromKill = reader.u8() === 0;
  let base = total;
  if (fromKill) {
    base = reader.u32();
    reader.f32();  // group bonus rate, hardcoded 1.0 by this core
  }
  const restedBonus = reader.u8() !== 0;
  reader.assertFinished();
  return { victim, total, base, restedBonus };
}

/** `EnviromentalDamage`: drowning, falling, lava, slime, fire. */
export interface EnvironmentalDamage {
  victim: bigint;
  type: number;
  damage: number;
  resisted: number;
  absorbed: number;
}

export function parseEnvironmentalDamage(payload: Uint8Array): EnvironmentalDamage {
  const reader = new PacketReader(payload);
  // The wire order is amount, resisted, absorbed — which is not the order the server's own header
  // declares the members in. The writer is what counts.
  const result = {
    victim: reader.u64(),
    type: reader.u8(),
    damage: reader.u32(),
    resisted: reader.u32(),
    absorbed: reader.u32(),
  };
  reader.assertFinished();
  return result;
}

/**
 * Whether a melee swing would connect, computed here rather than waited for.
 *
 * The server tells you a swing failed exactly once and never tells you it would work again — the
 * only "you are fine now" signal it sends is the next swing landing. So the client has to know the
 * rule itself, and it can: the reach of both parties is already published in their update fields.
 *
 * Range is both reaches plus a constant, floored at five yards, measured in three dimensions.
 */
export function withinMeleeRange(attackerReach: number, victimReach: number, distance: number): boolean {
  const reach = Math.max(NOMINAL_MELEE_RANGE, attackerReach + victimReach + MELEE_RANGE_BONUS);
  return distance <= reach;
}

/** The arc a swing can land in: 120 degrees, so 60 either side of where the attacker faces. */
export function facingTarget(orientation: number, dx: number, dy: number): boolean {
  const toTarget = Math.atan2(dy, dx);
  let difference = toTarget - orientation;
  while (difference > Math.PI) difference -= Math.PI * 2;
  while (difference < -Math.PI) difference += Math.PI * 2;
  return Math.abs(difference) <= MELEE_ARC / 2;
}

const NOMINAL_MELEE_RANGE = 5;
const MELEE_RANGE_BONUS = 4 / 3;
const MELEE_ARC = (2 * Math.PI) / 3;
