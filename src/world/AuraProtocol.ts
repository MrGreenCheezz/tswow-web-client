import { PacketReader } from "../protocol/PacketReader.js";

export const AURA_FLAGS = {
  caster: 0x08,
  positive: 0x10,
  duration: 0x20,
  negative: 0x80,
} as const;

export interface AuraInfo {
  slot: number;
  spellId: number;
  flags: number;
  casterLevel: number;
  applications: number;
  casterGuid?: bigint;
  maxDuration?: number;
  duration?: number;
}

export interface ActiveAura extends AuraInfo {
  expiresAt?: number;
}

export interface AuraUpdate {
  guid: bigint;
  replaceAll: boolean;
  slots: Array<{ slot: number; aura?: AuraInfo }>;
}

export function parseAuraUpdate(payload: Uint8Array, replaceAll: boolean): AuraUpdate {
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  const slots: AuraUpdate["slots"] = [];
  while (reader.remaining > 0) {
    const slot = reader.u8();
    const spellId = reader.u32();
    if (spellId === 0) {
      slots.push({ slot });
      continue;
    }
    const flags = reader.u8();
    const aura: AuraInfo = {
      slot,
      spellId,
      flags,
      casterLevel: reader.u8(),
      applications: reader.u8(),
    };
    if ((flags & AURA_FLAGS.caster) === 0) aura.casterGuid = reader.packedGuid();
    if ((flags & AURA_FLAGS.duration) !== 0) {
      aura.maxDuration = reader.u32();
      aura.duration = reader.u32();
    }
    slots.push({ slot, aura });
  }
  return { guid, replaceAll, slots };
}

export function applyAuraUpdate(current: ReadonlyMap<number, ActiveAura> | undefined, update: AuraUpdate, now: number): Map<number, ActiveAura> {
  const result = update.replaceAll ? new Map<number, ActiveAura>() : new Map(current);
  for (const change of update.slots) {
    if (!change.aura) result.delete(change.slot);
    else result.set(change.slot, {
      ...change.aura,
      ...(change.aura.duration === undefined ? {} : { expiresAt: now + change.aura.duration }),
    });
  }
  return result;
}
