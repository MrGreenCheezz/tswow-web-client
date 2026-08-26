import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: NPCHandler.cpp — `SendStablePet`,
// `SendPetStableResult`, and the four handlers a client drives (`HandleRequestStabledPets`,
// `HandleStablePet`, `HandleUnstablePet`, `HandleStableSwapPet`, `HandleBuyStableSlot`).

/** `MAX_PET_STABLES` in PetDefines.h. */
export const MAX_PET_STABLES = 4;

/** The two values the list uses; both are literals in the builder, not fields of the pet. */
export const STABLED_PET_ACTIVE = 1;
export const STABLED_PET_STABLED = 2;

/** The local `StableResultCode` in NPCHandler.cpp. Only these six are reachable. */
export const STABLE_ERR_MONEY = 0x01;
export const STABLE_ERR_STABLE = 0x06;
export const STABLE_SUCCESS_STABLE = 0x08;
export const STABLE_SUCCESS_UNSTABLE = 0x09;
export const STABLE_SUCCESS_BUY_SLOT = 0x0a;
export const STABLE_ERR_EXOTIC = 0x0c;

export interface StabledPet {
  /**
   * The pet's own number, and the only thing that identifies it: the slot it sits in is not on the
   * wire, and empty slots are skipped, so position says nothing.
   */
  petNumber: number;
  creatureId: number;
  /** Widened from a byte, so it can never exceed 255 however wide the field looks. */
  level: number;
  name: string;
  /** `STABLED_PET_ACTIVE` for the one that is out, `STABLED_PET_STABLED` for the rest. */
  flags: number;
}

export interface StableList {
  /** The stable master — including from gossip — or the player's own guid under the open-stable aura. */
  npcGuid: bigint;
  /** How many slots the player has bought. A pet can still be listed past this many. */
  stableSlots: number;
  pets: StabledPet[];
}

/**
 * The count comes before the slot total — two adjacent bytes that are easy to read the wrong way
 * round, and both are small numbers, so swapping them looks plausible.
 *
 * At most one entry is marked active, and it comes first; the stabled ones follow in slot order
 * with the empty slots skipped, which is why a slot index cannot be recovered from the position.
 */
export function parseStableList(payload: Uint8Array): StableList {
  const reader = new PacketReader(payload);
  const npcGuid = reader.u64();
  const count = reader.u8();
  const stableSlots = reader.u8();
  const pets: StabledPet[] = [];
  for (let index = 0; index < count; index++) {
    pets.push({
      petNumber: reader.u32(),
      creatureId: reader.u32(),
      level: reader.u32(),
      name: reader.cString(),
      flags: reader.u8(),
    });
  }
  reader.assertFinished();
  return { npcGuid, stableSlots, pets };
}

/**
 * One byte, and it names neither the pet nor the slot — it has to be matched against whatever the
 * client asked for last. Nor does success bring a fresh list: the roster must be asked for again.
 */
export function parseStableResult(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const result = reader.u8();
  reader.assertFinished();
  return result;
}

/** The request and the answer share one opcode; the client's half is just the stable master. */
export function buildStableListQuery(npcGuid: bigint): Uint8Array {
  return new PacketWriter().u64(npcGuid).toUint8Array();
}

/** Nothing names the pet: the server stables whichever one is out and picks the slot itself. */
export function buildStablePet(npcGuid: bigint): Uint8Array {
  return new PacketWriter().u64(npcGuid).toUint8Array();
}

/**
 * The number is the pet's own, not the slot it sits in. Substituting a slot index is not
 * self-correcting: pet numbers are handed out from a counter starting at one, so 1, 2 and 3 are
 * real pets on any realm, and the server would unstable the wrong one without complaining.
 */
export function buildUnstablePet(npcGuid: bigint, petNumber: number): Uint8Array {
  return new PacketWriter().u64(npcGuid).u32(petNumber).toUint8Array();
}

/** Same shape as unstabling, and the server answers both with the same success code. */
export function buildStableSwapPet(npcGuid: bigint, petNumber: number): Uint8Array {
  return new PacketWriter().u64(npcGuid).u32(petNumber).toUint8Array();
}

export function buildBuyStableSlot(npcGuid: bigint): Uint8Array {
  return new PacketWriter().u64(npcGuid).toUint8Array();
}

const STABLE_RESULTS: Record<number, string> = {
  0x01: "Не хватает денег",
  0x06: "Не удалось",
  0x08: "Питомец отправлен в стойло",
  0x09: "Питомец призван из стойла",
  0x0a: "Ячейка стойла куплена",
  0x0c: "Экзотическими питомцами вы управлять не можете",
};

export function stableResultText(result: number): string {
  return STABLE_RESULTS[result] ?? `Стойло: код ${result}`;
}

export const isStableSuccess = (result: number): boolean =>
  result === STABLE_SUCCESS_STABLE || result === STABLE_SUCCESS_UNSTABLE || result === STABLE_SUCCESS_BUY_SLOT;
