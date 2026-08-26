import { PacketReader } from "../protocol/PacketReader.js";

/**
 * Who a creature is angry at, and how angry.
 *
 * The core sends the whole list every time it changes, sorted, with the threat value multiplied by
 * a hundred — `ThreatManager::SendThreatListToClients` writes `uint32(ref->GetThreat() * 100)`, so
 * the number on the wire is hundredths and dividing it back is the client's job.
 */

export interface ThreatEntry {
  guid: bigint;
  /** Raw hundredths, as sent. Divide by 100 for the number the original interface shows. */
  threat: number;
}

export interface ThreatUpdate {
  /** The creature whose list this is. */
  guid: bigint;
  /** Set only by `SMSG_HIGHEST_THREAT_UPDATE`: who just took the top of the list. */
  highestGuid: bigint | undefined;
  entries: ThreatEntry[];
}

/** Mirrors `ThreatManager::SendThreatListToClients` for both of the opcodes it can send. */
export function parseThreatUpdate(payload: Uint8Array, withHighest: boolean): ThreatUpdate {
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  const highestGuid = withHighest ? reader.packedGuid() : undefined;
  const count = reader.u32();
  if (count > 1000) throw new RangeError(`Threat list names ${count} units`);
  const entries: ThreatEntry[] = [];
  for (let index = 0; index < count; index++) entries.push({ guid: reader.packedGuid(), threat: reader.u32() });
  reader.assertFinished();
  return { guid, highestGuid, entries };
}

export interface ThreatRemove {
  guid: bigint;
  victimGuid: bigint;
}

/** Mirrors `ThreatManager::SendRemoveToClients`. */
export function parseThreatRemove(payload: Uint8Array): ThreatRemove {
  const reader = new PacketReader(payload);
  const removal = { guid: reader.packedGuid(), victimGuid: reader.packedGuid() };
  reader.assertFinished();
  return removal;
}

/** Mirrors `ThreatManager::SendClearAllThreatToClients`: this creature is angry at nobody. */
export function parseThreatClear(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  reader.assertFinished();
  return guid;
}

/**
 * Threat tables, as the client last heard them. Kept by creature guid, because the interface asks
 * the question the other way round — "how close am I to pulling this off the tank" — and that is
 * one lookup in the list of whichever creature is being fought.
 */
export class ThreatTables {
  readonly #tables = new Map<bigint, ThreatUpdate>();

  apply(update: ThreatUpdate): void {
    const existing = this.#tables.get(update.guid);
    // A highest-threat packet carries the same list, so the newer one simply replaces it; keeping
    // the previous highest when the new packet does not name one would show a stale tank.
    this.#tables.set(update.guid, {
      ...update,
      highestGuid: update.highestGuid ?? (update.entries.length === existing?.entries.length ? existing?.highestGuid : undefined),
    });
  }

  remove(removal: ThreatRemove): void {
    const table = this.#tables.get(removal.guid);
    if (!table) return;
    table.entries = table.entries.filter((entry) => entry.guid !== removal.victimGuid);
    if (table.highestGuid === removal.victimGuid) table.highestGuid = undefined;
  }

  clear(guid: bigint): void {
    this.#tables.delete(guid);
  }

  forget(): void {
    this.#tables.clear();
  }

  get(guid: bigint): ThreatUpdate | undefined {
    return this.#tables.get(guid);
  }

  /** What share of the creature's top threat one unit holds, 0 to 1, or undefined if unknown. */
  share(creatureGuid: bigint, unitGuid: bigint): number | undefined {
    const table = this.#tables.get(creatureGuid);
    if (!table || table.entries.length === 0) return undefined;
    const mine = table.entries.find((entry) => entry.guid === unitGuid)?.threat;
    if (mine === undefined) return undefined;
    const top = Math.max(...table.entries.map((entry) => entry.threat));
    return top <= 0 ? 0 : mine / top;
  }
}
