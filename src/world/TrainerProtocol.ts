import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: NPCPackets.cpp `TrainerList::Write`,
// `TrainerBuySucceeded::Write`, `TrainerBuyFailed::Write` and NPCHandler.cpp.
// Each spell entry is 38 bytes: 4 + 1 + 4 + 8 + 1 + 4 + 4 + 12.

/** `Usable` in TrainerListSpell: whether the player can learn the spell right now. */
export const TRAINER_SPELL_AVAILABLE = 0;
export const TRAINER_SPELL_UNAVAILABLE = 1;
export const TRAINER_SPELL_KNOWN = 2;

export interface TrainerSpell {
  spellId: number;
  usable: number;
  moneyCost: number;
  /** Compared against PLAYER_CHARACTER_POINTS by the original UI; unused for class trainers. */
  pointCost: [number, number];
  requiredLevel: number;
  requiredSkillLine: number;
  requiredSkillRank: number;
  /** Previous rank first, then up to two further prerequisites. */
  requiredAbilities: [number, number, number];
}

export interface TrainerList {
  guid: bigint;
  trainerType: number;
  greeting: string;
  spells: TrainerSpell[];
}

export function parseTrainerList(payload: Uint8Array): TrainerList {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const trainerType = reader.i32();
  const count = reader.i32();
  if (count < 0 || count > 0xffff) throw new RangeError(`Trainer list declares ${count} spells`);
  const spells: TrainerSpell[] = [];
  for (let entry = 0; entry < count; entry++) {
    spells.push({
      spellId: reader.i32(),
      usable: reader.u8(),
      moneyCost: reader.i32(),
      pointCost: [reader.i32(), reader.i32()],
      requiredLevel: reader.u8(),
      requiredSkillLine: reader.i32(),
      requiredSkillRank: reader.i32(),
      requiredAbilities: [reader.i32(), reader.i32(), reader.i32()],
    });
  }
  const greeting = reader.cString();
  reader.assertFinished();
  return { guid, trainerType, greeting, spells };
}

export interface TrainerBuyResult {
  guid: bigint;
  spellId: number;
  /** Only present on failure. */
  reason?: number | undefined;
}

export function parseTrainerBuySucceeded(payload: Uint8Array): TrainerBuyResult {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const spellId = reader.i32();
  reader.assertFinished();
  return { guid, spellId };
}

export function parseTrainerBuyFailed(payload: Uint8Array): TrainerBuyResult {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const spellId = reader.i32();
  const reason = reader.i32();
  reader.assertFinished();
  return { guid, spellId, reason };
}

export function buildTrainerList(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

export function buildTrainerBuySpell(guid: bigint, spellId: number): Uint8Array {
  return new PacketWriter().u64(guid).i32(spellId).toUint8Array();
}

export function trainerSpellStateText(usable: number): string {
  if (usable === TRAINER_SPELL_KNOWN) return "уже изучено";
  if (usable === TRAINER_SPELL_UNAVAILABLE) return "недоступно";
  return "";
}

/** `Trainer::FailReason`: Unavailable is zero and NotEnoughMoney is one. */
export function trainerBuyFailureText(reason: number | undefined): string {
  if (reason === 0) return "Заклинание недоступно";
  if (reason === 1) return "Не хватает денег";
  return `Обучение не удалось (код ${reason ?? "?"})`;
}
