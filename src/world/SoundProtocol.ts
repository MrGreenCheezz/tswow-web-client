import { PacketReader } from "../protocol/PacketReader.js";

// Layouts follow the active TrinityCore source: MiscPackets.cpp — `PlaySound::Write`,
// `PlayMusic::Write`, `PlayObjectSound::Write`.
//
// Audio itself is deliberately out of scope for this phase of the plan: what these three opcodes
// need is to be *read*, so the packets stop landing in the unhandled log and so the sound kit ids
// are already on hand when there is something to play them with. A `SoundEntries.dbc` id names one
// or more files inside the archives; nothing here opens them.

export interface SoundRequest {
  /** A `SoundEntries.dbc` row. */
  soundKitId: number;
  /**
   * Which unit or object the sound belongs to. Zero for the two that are not positional, which is
   * the whole difference between them: an object sound follows its source around the world, a
   * plain sound plays at the listener and music replaces the zone's track until something else
   * changes it.
   */
  sourceGuid: bigint;
  /** True for `SMSG_PLAY_MUSIC`: it loops and it overrides the zone, where a sound plays once. */
  music: boolean;
}

/** `SMSG_PLAY_SOUND` and `SMSG_PLAY_MUSIC`: one word, and the opcode is the difference. */
export function parsePlaySound(payload: Uint8Array, music = false): SoundRequest {
  const reader = new PacketReader(payload);
  const soundKitId = reader.u32();
  reader.assertFinished();
  return { soundKitId, sourceGuid: 0n, music };
}

/**
 * `SMSG_PLAY_OBJECT_SOUND`: the kit comes **first** and the guid second.
 *
 * That is the reverse of nearly every other packet that carries both, and the two are adjacent —
 * so reading the guid first consumes the kit id as the guid's low half and the packet still ends
 * exactly where it should, with no error and a wrong answer.
 */
export function parsePlayObjectSound(payload: Uint8Array): SoundRequest {
  const reader = new PacketReader(payload);
  const soundKitId = reader.u32();
  const sourceGuid = reader.u64();
  reader.assertFinished();
  return { soundKitId, sourceGuid, music: false };
}
