import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layout follows the active TrinityCore source: QueryHandler.cpp `SendNameQueryOpcode`
// and `HandleNameQueryOpcode`. Chat carries only GUIDs, so names come from here.

/** `MAX_DECLINED_NAME_CASES`: genitive, dative, accusative, instrumental, prepositional. */
export const DECLINED_NAME_CASES = 5;

export interface PlayerName {
  guid: bigint;
  known: boolean;
  name: string;
  realm: string;
  race: number;
  gender: number;
  classId: number;
  /**
   * The five Russian cases of the name, when the player filled them in at creation.
   *
   * Empty for almost everyone, and that is fine — it is what the original client falls back on
   * too. It matters for one thing only: an emote sentence reads «машет рукой |3-2(%s)», and a
   * name left in the nominative there is the difference between «машет рукой Ивану» and «Иван».
   */
  declined: string[];
}

/** What a name answer says about the character besides the name. */
export interface PlayerNameDetails {
  readonly race: number;
  readonly gender: number;
  readonly classId: number;
}

/** The response leads with a packed GUID and stops right after it when the name is unknown. */
export function parseNameQueryResponse(payload: Uint8Array): PlayerName {
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  const known = reader.u8() === 0;
  if (!known) return { guid, known, name: "", realm: "", race: 0, gender: 0, classId: 0, declined: [] };
  const name = reader.cString();
  const realm = reader.cString();
  const race = reader.u8();
  const gender = reader.u8();
  const classId = reader.u8();
  const declined: string[] = [];
  // A flag byte, then five strings when it is set. Older captures of this packet end here, so the
  // remaining length is checked rather than assumed.
  if (reader.remaining > 0 && reader.u8() === 1) {
    for (let index = 0; index < DECLINED_NAME_CASES && reader.remaining > 0; index++) {
      declined.push(reader.cString());
    }
  }
  return { guid, known, name, realm, race, gender, classId, declined };
}

export function buildNameQuery(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

/**
 * Remembers the names the server has sent and which GUIDs are already being asked about, so a
 * busy chat channel does not fire the same query on every line.
 */
export class NameCache {
  readonly #names = new Map<bigint, string>();
  readonly #declined = new Map<bigint, readonly string[]>();
  readonly #pending = new Set<bigint>();
  /** Race, gender and class from the same answer: the client's name cache keeps them beside the name. */
  readonly #details = new Map<bigint, PlayerNameDetails>();

  get(guid: bigint): string | undefined {
    return this.#names.get(guid);
  }

  /** The race, gender and class the name answer carried; undefined until it arrived. */
  details(guid: bigint): PlayerNameDetails | undefined {
    return this.#details.get(guid);
  }

  /** The five cases of a name, for the emote sentences that ask for one. */
  declined(guid: bigint): readonly string[] | undefined {
    return this.#declined.get(guid);
  }

  /** A query for this GUID is out and unanswered. */
  isPending(guid: bigint): boolean {
    return this.#pending.has(guid);
  }

  /** True when the caller should send a query for this GUID. */
  shouldQuery(guid: bigint): boolean {
    if (guid === 0n || this.#names.has(guid) || this.#pending.has(guid)) return false;
    this.#pending.add(guid);
    return true;
  }

  accept(entry: PlayerName): boolean {
    this.#pending.delete(entry.guid);
    if (!entry.known || !entry.name) return false;
    this.#names.set(entry.guid, entry.name);
    if (entry.declined.length > 0) this.#declined.set(entry.guid, entry.declined);
    this.#details.set(entry.guid, { race: entry.race, gender: entry.gender, classId: entry.classId });
    return true;
  }

  /**
   * Forgets one answer (`SMSG_INVALIDATE_PLAYER`, 5.22: a rename). True when a name was held, so
   * the caller knows there is something to ask again for.
   */
  invalidate(guid: bigint): boolean {
    const held = this.#names.delete(guid);
    this.#declined.delete(guid);
    this.#details.delete(guid);
    return held;
  }

  clear(): void {
    this.#names.clear();
    this.#declined.clear();
    this.#details.clear();
    this.#pending.clear();
  }
}
