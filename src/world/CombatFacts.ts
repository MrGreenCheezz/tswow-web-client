/**
 * Plan item 3.01 (mechanism M8, slice D «sources»): the combat facts the packet bus did not carry.
 *
 * Most of the combat log already rides `UNIT_COMBAT` (melee, spell damage, heal, energize, periodic,
 * miss, damage shield, immune, resist — world/UnitCombat.ts), the cast edges (`SPELL_CAST_START`,
 * `SPELL_GO`, `SPELL_CAST_RESULT`), `AURA_CHANGED` and `PARTY_KILL`. What was parsed and thrown away,
 * or only worded, is published here as `COMBAT_FACT`: the environmental damage log, the execute log's
 * effect records, the enchantment log, the instant kill, dispel/steal and the failed dispel.
 *
 * Packet shapes are the core's writers: `Spell::SendLogExecute` (Spell.cpp:4721-4753) with one block
 * per effect — `u32 effect, u32 count` (`InitEffectExecuteData`, :8273-8287), then `count` records
 * whose shape the effect decides (:4755-4820); `SMSG_DISPEL_FAILED` (SpellEffects.cpp:2636-2647):
 * full caster and victim guids, the dispel spell, then each aura that stayed.
 */

import { PacketReader } from "../protocol/PacketReader.js";
import type { EnvironmentalDamage } from "./CombatProtocol.js";
import type { DispelLog, EnchantmentLog, SpellLogPair } from "./SpellLogProtocol.js";

/** One record of an `SMSG_SPELLLOGEXECUTE` effect block. */
export interface ExecuteLogRecord {
  /** The unit or object the record names; 0n for the item-only records (create, feed). */
  readonly target: bigint;
  /** Power taken (8, 62), extra attacks (19), the interrupted spell (68), an item entry (24, 101, 157, 111). */
  readonly value: number;
  /** The power type (8, 62) or the durability slot (111, 115). */
  readonly extra: number;
  /** The drain's gain multiplier (8, 62); 0 otherwise. */
  readonly multiplier: number;
}

export interface ExecuteLogEffect {
  readonly effect: number;
  readonly records: readonly ExecuteLogRecord[];
}

export interface ExecuteLogDetail {
  readonly casterGuid: bigint;
  readonly spellId: number;
  readonly effects: readonly ExecuteLogEffect[];
}

/** `SpellEffects` whose execute record is a packed guid alone (summons, resurrections, open lock, dismiss). */
const GUID_RECORD_EFFECTS = new Set([18, 28, 33, 50, 56, 76, 83, 89, 102, 104, 105, 106, 107, 113]);
/** Records of a packed guid and one word: extra attacks (19) and the interrupted spell (68). */
const GUID_WORD_EFFECTS = new Set([19, 68]);
/** Records of one word: the created or destroyed item (24, 101, 157). */
const WORD_RECORD_EFFECTS = new Set([24, 101, 157]);
/** POWER_DRAIN and POWER_BURN: guid, taken, power type, gain multiplier. */
const POWER_EFFECTS = new Set([8, 62]);
/** DURABILITY_DAMAGE and _PCT: guid, item entry (-1 for all), slot. */
const DURABILITY_EFFECTS = new Set([111, 115]);
/** A block has at most this many records; anything larger is a misread packet. */
const MAX_EXECUTE_RECORDS = 512;

/**
 * The whole `SMSG_SPELLLOGEXECUTE`. An effect whose record shape is not one the core writes ends the
 * read there — the blocks after it cannot be found — and keeps what came before.
 */
export function parseExecuteLogDetail(payload: Uint8Array): ExecuteLogDetail {
  const reader = new PacketReader(payload);
  const casterGuid = reader.packedGuid();
  const spellId = reader.u32();
  const effects: ExecuteLogEffect[] = [];
  if (reader.remaining < 4) return { casterGuid, spellId, effects };
  const effectCount = reader.u32();
  try {
    for (let index = 0; index < effectCount && index < 3; index++) {
      const effect = reader.u32();
      const count = reader.u32();
      if (count > MAX_EXECUTE_RECORDS) break;
      const records: ExecuteLogRecord[] = [];
      if (POWER_EFFECTS.has(effect)) {
        for (let n = 0; n < count; n++) {
          const target = reader.packedGuid();
          const value = reader.u32();
          const extra = reader.u32();
          records.push({ target, value, extra, multiplier: reader.f32() });
        }
      } else if (GUID_WORD_EFFECTS.has(effect)) {
        for (let n = 0; n < count; n++) records.push({ target: reader.packedGuid(), value: reader.u32(), extra: 0, multiplier: 0 });
      } else if (DURABILITY_EFFECTS.has(effect)) {
        for (let n = 0; n < count; n++) {
          const target = reader.packedGuid();
          const value = reader.u32() | 0;
          records.push({ target, value, extra: reader.u32() | 0, multiplier: 0 });
        }
      } else if (WORD_RECORD_EFFECTS.has(effect)) {
        for (let n = 0; n < count; n++) records.push({ target: 0n, value: reader.u32(), extra: 0, multiplier: 0 });
      } else if (GUID_RECORD_EFFECTS.has(effect)) {
        for (let n = 0; n < count; n++) records.push({ target: reader.packedGuid(), value: 0, extra: 0, multiplier: 0 });
      } else {
        break;
      }
      effects.push({ effect, records });
    }
  } catch {
    // A short packet keeps the blocks already read.
  }
  return { casterGuid, spellId, effects };
}

export interface DispelFailedLog {
  readonly casterGuid: bigint;
  readonly targetGuid: bigint;
  readonly spellId: number;
  readonly failed: readonly number[];
}

/** `SMSG_DISPEL_FAILED` (SpellEffects.cpp:2636-2647 and :5355): full guids, then the auras that stayed. */
export function parseDispelFailed(payload: Uint8Array): DispelFailedLog {
  const reader = new PacketReader(payload);
  const casterGuid = reader.u64();
  const targetGuid = reader.u64();
  const spellId = reader.u32();
  const failed: number[] = [];
  while (reader.remaining >= 4 && failed.length < 64) failed.push(reader.u32());
  return { casterGuid, targetGuid, spellId, failed };
}

/** What `COMBAT_FACT` carries. */
export type CombatFact =
  | { readonly source: "environmental"; readonly log: EnvironmentalDamage }
  | { readonly source: "execute"; readonly log: ExecuteLogDetail }
  | { readonly source: "enchant"; readonly log: EnchantmentLog }
  | { readonly source: "instakill"; readonly log: SpellLogPair }
  | { readonly source: "dispel"; readonly log: DispelLog; readonly stolen: boolean }
  | { readonly source: "dispelFailed"; readonly log: DispelFailedLog }
  | { readonly source: "died"; readonly guid: bigint };
