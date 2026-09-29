/**
 * The enemy arena team as the 3.3.5 client knows it: the `arena1`…`arena5` and `arenapet1`…
 * `arenapet5` unit tokens, `GetNumArenaOpponents` and the ARENA_OPPONENT_UPDATE / UNIT_PET / unit
 * field / cast events stock Blizzard_ArenaUI (FrameXmlArenaLod.ts) listens for.
 *
 * What the server sends, and therefore all this reads (TrinityCore 3.3.5, tswow/cores/TrinityCore):
 *
 * * No list. Build 12340 has no opponent-list packet (Opcodes.h names no ARENA_OPPONENT opcode);
 *   `MSG_PVP_LOG_DATA` would carry the other team's GUIDs, but `HandlePVPLogDataOpcode` refuses it
 *   inside an arena until the match ends (BattleGroundHandler.cpp:322-324), and
 *   `MSG_BATTLEGROUND_PLAYER_POSITIONS` carries flag carriers only and writes 0 positions
 *   (BattleGroundHandler.cpp:289-311). So an opponent is a unit the client has been sent.
 * * `SMSG_BATTLEFIELD_STATUS` with the arena marker and STATUS_IN_PROGRESS is the one statement that
 *   the player stands in a running arena (the same test game/Encounters.ts `inArena` makes).
 * * Which team a player object is on: `PLAYER_BYTES_3` byte 3, `PLAYER_BYTES_3_OFFSET_ARENA_FACTION`
 *   (Player.h:409), written by `Player::SetBGTeam` as `team == ALLIANCE ? 1 : 0` (Player.cpp:22764-
 *   22767) when the player ports in (BattleGroundHandler.cpp:484), and PUBLIC, so every visible
 *   player carries it (UpdateFieldFlags.cpp:319). An enemy is a visible player whose byte differs
 *   from the player's own — not «hostile» by faction template, which two Horde teams would fail.
 *   A word the create block left out is zero, as for every update field.
 * * Pets: the owner's `UNIT_FIELD_SUMMON`, or a visible creature's `UNIT_FIELD_SUMMONEDBY` naming
 *   an opponent (both PUBLIC).
 * * Health, power and casts: the ordinary update fields and SMSG_SPELL_START/…, which the server sends
 *   for every unit in sight.
 *
 * Slots are handed out in the order opponents come into sight (several at once by GUID, so the order
 * does not depend on Map iteration) and are kept for the match: an opponent who leaves sight
 * (stealth, `SMSG_DESTROY_OBJECT`) stays `arenaN` with ARENA_OPPONENT_UPDATE(«unseen»), and the GUID,
 * class and name the client saw stay answerable — which is what ArenaEnemyFrame_OnLoad relies on
 * («some of the information to remain», Blizzard_ArenaUI.lua:133-136). UnitExists is false then.
 * Leaving the match clears every slot with «cleared».
 *
 * Not emitted: «destroyed». `SMSG_ARENA_UNIT_DESTROYED` precedes every `DestroyForPlayer` in an
 * arena (Object.cpp:245-258) — a player leaving the world and a single-object visibility loss alike
 * (Player.cpp:22968-22977), while the grid's visibility pass sends a plain out-of-range block
 * (Player.cpp:23055-23066) — and WorldClient keeps nothing of it. So the packet cannot tell the
 * client's «destroyed» from «unseen»; every loss of sight is «unseen». Stock treats «destroyed» as
 * «seen» anyway (Blizzard_ArenaUI.lua:190, :271).
 */
import { readField, unit as unitField } from "../../world/Fields.js";
import { STATUS_IN_PROGRESS } from "../../world/PvpProtocol.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import {
  FRAMEXML_POWER_EVENTS,
  FRAMEXML_POWER_MAX_EVENTS,
  FRAMEXML_SEAM_EVENTS,
  type FrameXmlCastingInfo,
  type FrameXmlChannelInfo,
  type FrameXmlSeamPump,
} from "./FrameXmlWorldSeam.js";

/** `MAX_ARENA_ENEMIES` (Blizzard_ArenaUI.lua:1). */
export const FRAMEXML_ARENA_OPPONENTS = 5;

/** The event stock ArenaEnemyFrame_OnEvent and ArenaEnemyPetFrame_OnEvent read (Blizzard_ArenaUI.lua:189, :270). */
export const FRAMEXML_ARENA_OPPONENT_UPDATE = "ARENA_OPPONENT_UPDATE";

const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;

/** What the model reads of one queue slot (world/PvpProtocol.ts `BattlefieldStatus`). */
interface ArenaQueue {
  readonly queueSlot?: number;
  readonly status: number;
  readonly isArena: boolean;
  readonly cleared?: boolean;
  readonly clientInstanceId?: number;
  readonly mapId?: number;
  readonly arenaType?: number;
}

interface ArenaCast {
  readonly spellId: number;
  readonly startedAt: number;
  readonly duration: number;
  readonly channel: boolean;
  readonly castCount?: number;
}

type Unsubscribe = () => void;

/** The part of WorldClient the model reads; every read is of what the server already sent. */
export interface FrameXmlArenaWorld {
  readonly state: {
    readonly selfGuid?: bigint | undefined;
    readonly objects: { get(guid: bigint): WorldObjectState | undefined; values(): Iterable<WorldObjectState> };
  };
  readonly battlefieldQueues?: { values(): Iterable<ArenaQueue> };
  readonly names?: { get(guid: bigint): string | undefined };
  readonly casts?: { get(guid: bigint): ArenaCast | undefined };
  readonly events?: {
    on(name: "SPELL_CAST_START", listener: (payload: { casterGuid: bigint; spellId: number; channel: boolean }) => void): Unsubscribe;
    on(name: "SPELL_CAST_STOP", listener: (payload: {
      casterGuid: bigint; spellId: number; interrupted: boolean; reason?: string | undefined;
    }) => void): Unsubscribe;
    on(name: "SPELL_CAST_DELAYED", listener: (payload: { casterGuid: bigint }) => void): Unsubscribe;
    on(name: "SPELL_CHANNEL_UPDATE", listener: (payload: { casterGuid: bigint }) => void): Unsubscribe;
  };
}

export interface FrameXmlArenaHost {
  readonly world: () => FrameXmlArenaWorld | undefined;
  /** Spell name, rank and icon, as the rest of the seam resolves them. */
  readonly spell?: (spellId: number) => { readonly name?: string; readonly rank?: string; readonly iconPath?: string } | undefined;
  /** The clock `WorldClient.casts[].startedAt` is on (performance.now()). */
  readonly monotonic?: () => number;
}

/** Health, max health, power type, power, max power — what UnitFrame reads, compared per tick. */
type Stats = readonly [number | undefined, number | undefined, number | undefined, number | undefined, number | undefined];

interface Slot {
  readonly guid: bigint;
  seen: boolean;
  classId: number | undefined;
  name: string | undefined;
  stats: Stats | undefined;
  pet: bigint | undefined;
  petSeen: boolean;
  petStats: Stats | undefined;
}

interface CastIdentity { readonly spellId: number; readonly channel: boolean; readonly castID: number | undefined }

function arenaFaction(object: WorldObjectState): number {
  return ((readField(object, "PLAYER_BYTES_3") ?? 0) >>> 24) & 0xff;
}

function nonZero(guid: bigint | undefined): bigint | undefined {
  return guid === undefined || guid === 0n ? undefined : guid;
}

function statsOf(object: WorldObjectState): Stats {
  return [unitField.health(object), unitField.maxHealth(object), unitField.powerType(object),
    unitField.power(object), unitField.maxPower(object)];
}

/** `arena<n>` → [n, false], `arenapet<n>` → [n, true]; anything else undefined. */
export function frameXmlArenaToken(unit: string): readonly [index: number, pet: boolean] | undefined {
  const match = /^arena(pet)?([1-5])$/.exec(unit.toLowerCase());
  return match ? [Number(match[2]), match[1] !== undefined] : undefined;
}

export class FrameXmlArenaOpponents {
  readonly #host: FrameXmlArenaHost;
  #pump: FrameXmlSeamPump | undefined;
  #unsubscribe: Unsubscribe[] = [];
  /** The running match's queue identity, or undefined outside one. */
  #match: string | undefined;
  #slots: Slot[] = [];
  readonly #casts = new Map<bigint, CastIdentity>();
  /** Told when a running arena match begins (the lazy owner's fallback trigger, FrameXmlArenaLod.ts). */
  onEnter: (() => void) | undefined;

  constructor(host: FrameXmlArenaHost) {
    this.#host = host;
  }

  attach(pump: FrameXmlSeamPump): void {
    this.detach();
    this.#pump = pump;
    const events = this.#host.world()?.events;
    if (!events || typeof events.on !== "function") return;
    this.#unsubscribe.push(events.on("SPELL_CAST_START", (event) => this.#castStart(event.casterGuid, event.spellId, event.channel)));
    this.#unsubscribe.push(events.on("SPELL_CAST_STOP", (event) => this.#castStop(event.casterGuid, event.spellId, event.interrupted, event.reason)));
    this.#unsubscribe.push(events.on("SPELL_CAST_DELAYED", (event) => {
      const unit = this.#castUnit(event.casterGuid);
      const cast = this.#casts.get(event.casterGuid);
      if (unit && cast && !cast.channel) this.#fire(FRAMEXML_SEAM_EVENTS.castDelayed, unit, ...this.#castIdentity(cast));
    }));
    this.#unsubscribe.push(events.on("SPELL_CHANNEL_UPDATE", (event) => {
      const unit = this.#castUnit(event.casterGuid);
      if (unit) this.#fire(FRAMEXML_SEAM_EVENTS.channelUpdate, unit);
    }));
  }

  detach(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) {
      try { unsubscribe(); } catch { /* a world already gone */ }
    }
    this.#pump = undefined;
  }

  /** Whether SMSG_BATTLEFIELD_STATUS says a running arena match: `IsInInstance`'s «arena». */
  inArena(): boolean {
    return this.#matchKey() !== undefined;
  }

  /** `GetNumArenaOpponents()`: the opponents seen so far this match. */
  count(): number {
    return this.#slots.length;
  }

  /** The GUID behind an arena token, seen or not (UnitGUID). */
  guid(unit: string): bigint | undefined {
    const token = frameXmlArenaToken(unit);
    const slot = token ? this.#slots[token[0] - 1] : undefined;
    if (!slot || !token) return undefined;
    return token[1] ? slot.pet : slot.guid;
  }

  /** The object behind an arena token while it is in sight: what UnitExists/UnitHealth… read. */
  object(unit: string): WorldObjectState | undefined {
    const guid = this.guid(unit);
    return guid === undefined ? undefined : this.#host.world()?.state.objects.get(guid);
  }

  /** The class id last seen on `arenaN` (its pet has none to remember). */
  classId(unit: string): number | undefined {
    const token = frameXmlArenaToken(unit);
    return token && !token[1] ? this.#slots[token[0] - 1]?.classId : undefined;
  }

  /** The name last seen on `arenaN`. */
  name(unit: string): string | undefined {
    const token = frameXmlArenaToken(unit);
    return token && !token[1] ? this.#slots[token[0] - 1]?.name : undefined;
  }

  /** `arenaN`/`arenapetN` for a GUID in a slot; undefined for anyone else. */
  unitFor(guid: bigint): string | undefined {
    for (let index = 0; index < this.#slots.length; index += 1) {
      const slot = this.#slots[index]!;
      if (slot.guid === guid) return `arena${index + 1}`;
      if (slot.pet === guid) return `arenapet${index + 1}`;
    }
    return undefined;
  }

  /** `UnitCastingInfo`/`UnitChannelInfo` for an opponent in sight, in LiveWorldSeam's tuple shape. */
  castInfo(unit: string, channel: boolean): FrameXmlCastingInfo | FrameXmlChannelInfo | undefined {
    const token = frameXmlArenaToken(unit);
    if (!token || token[1]) return undefined;
    const slot = this.#slots[token[0] - 1];
    const pump = this.#pump;
    const world = this.#host.world();
    if (!slot?.seen || !pump || !world) return undefined;
    const cast = world.casts?.get(slot.guid);
    if (!cast || cast.channel !== channel) return undefined;
    const metadata = this.#host.spell?.(cast.spellId);
    const name = metadata?.name ?? `Заклинание ${cast.spellId}`;
    const rank = metadata?.rank ?? "";
    const texture = metadata?.iconPath ?? "";
    const monotonic = this.#host.monotonic?.() ?? cast.startedAt;
    const startMs = pump.now() * 1000 - (monotonic - cast.startedAt);
    const endMs = startMs + cast.duration;
    return channel
      ? [name, rank, name, texture, startMs, endMs, false, false]
      : [name, rank, name, texture, startMs, endMs, false, cast.castCount, false];
  }

  /**
   * Re-announce what is known, for a frame set that has just loaded: UNIT_PET and «seen»/«unseen»
   * for every slot, as the events would have reached it had it been there.
   */
  replay(): void {
    this.#slots.forEach((slot, index) => {
      const unit = `arena${index + 1}`;
      this.#fire(FRAMEXML_ARENA_OPPONENT_UPDATE, unit, slot.seen ? "seen" : "unseen");
      if (slot.pet !== undefined) {
        this.#fire(FRAMEXML_SEAM_EVENTS.petChanged, unit);
        this.#fire(FRAMEXML_ARENA_OPPONENT_UPDATE, `arenapet${index + 1}`, slot.petSeen ? "seen" : "unseen");
      }
    });
  }

  /** One reconcile against the world; cheap outside an arena (the two queue slots). */
  tick(): void {
    const key = this.#matchKey();
    if (key !== this.#match) {
      const entered = key !== undefined;
      if (this.#match !== undefined) this.#clear();
      this.#match = key;
      if (entered) {
        try { this.onEnter?.(); } catch (error) { console.warn(`[FrameXML arena] ${String(error)}`); }
      }
    }
    if (key === undefined) return;
    const world = this.#host.world();
    const selfGuid = world?.state.selfGuid;
    const self = selfGuid === undefined ? undefined : world?.state.objects.get(selfGuid);
    if (!world || !self) return;
    const faction = arenaFaction(self);
    const known = new Set<bigint>();
    for (const slot of this.#slots) known.add(slot.guid);
    const fresh: bigint[] = [];
    const summonedBy = new Map<bigint, bigint>();
    for (const object of world.state.objects.values()) {
      if (object.typeId === TYPEID_UNIT) {
        const owner = nonZero(readField(object, "UNIT_FIELD_SUMMONEDBY"));
        if (owner !== undefined) summonedBy.set(owner, object.guid);
        continue;
      }
      if (object.typeId !== TYPEID_PLAYER || object.guid === selfGuid || known.has(object.guid)) continue;
      if (arenaFaction(object) !== faction) fresh.push(object.guid);
    }
    fresh.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const guid of fresh) {
      if (this.#slots.length >= FRAMEXML_ARENA_OPPONENTS) break;
      this.#slots.push({
        guid, seen: false, classId: undefined, name: undefined, stats: undefined,
        pet: undefined, petSeen: false, petStats: undefined,
      });
    }
    this.#slots.forEach((slot, index) => this.#reconcileSlot(world, slot, index + 1, summonedBy));
  }

  #reconcileSlot(world: FrameXmlArenaWorld, slot: Slot, id: number, summonedBy: ReadonlyMap<bigint, bigint>): void {
    const unit = `arena${id}`;
    const object = world.state.objects.get(slot.guid);
    if (object) {
      slot.classId = unitField.classId(object) ?? slot.classId;
      const name = world.names?.get(slot.guid);
      if (name && name !== slot.name) {
        const announce = slot.seen;
        slot.name = name;
        if (announce) this.#fire(FRAMEXML_SEAM_EVENTS.unitName, unit);
      }
    }
    if (!!object !== slot.seen) {
      slot.seen = !!object;
      slot.stats = object ? statsOf(object) : undefined;
      this.#fire(FRAMEXML_ARENA_OPPONENT_UPDATE, unit, slot.seen ? "seen" : "unseen");
    } else if (object) {
      slot.stats = this.#announceStats(unit, slot.stats, statsOf(object));
    }
    // The pet: the owner's UNIT_FIELD_SUMMON while the owner is in sight, else the last one known,
    // else a creature in sight that names the owner as its summoner.
    const summon = object ? nonZero(readField(object, "UNIT_FIELD_SUMMON")) : slot.pet;
    const pet = summon ?? summonedBy.get(slot.guid);
    const petUnit = `arenapet${id}`;
    if (pet !== slot.pet) {
      slot.pet = pet;
      slot.petSeen = false;
      slot.petStats = undefined;
      this.#fire(FRAMEXML_SEAM_EVENTS.petChanged, unit);
    }
    const petObject = pet === undefined ? undefined : world.state.objects.get(pet);
    if (!!petObject !== slot.petSeen) {
      slot.petSeen = !!petObject;
      slot.petStats = petObject ? statsOf(petObject) : undefined;
      if (pet !== undefined) this.#fire(FRAMEXML_ARENA_OPPONENT_UPDATE, petUnit, slot.petSeen ? "seen" : "unseen");
    } else if (petObject) {
      slot.petStats = this.#announceStats(petUnit, slot.petStats, statsOf(petObject));
    }
  }

  /** The UNIT_* edges UnitFrame registers (UnitFrame.lua:199-342), one per field that moved. */
  #announceStats(unit: string, before: Stats | undefined, now: Stats): Stats {
    if (!before) return now;
    const [health, maxHealth, powerType, power, maxPower] = now;
    if (health !== before[0]) this.#fire(FRAMEXML_SEAM_EVENTS.health, unit);
    if (maxHealth !== before[1]) this.#fire(FRAMEXML_SEAM_EVENTS.maxHealth, unit);
    if (powerType !== before[2]) this.#fire(FRAMEXML_SEAM_EVENTS.unitDisplayPower, unit);
    else {
      if (power !== before[3]) this.#fire(FRAMEXML_POWER_EVENTS[powerType ?? 0] ?? "UNIT_MANA", unit);
      if (maxPower !== before[4]) this.#fire(FRAMEXML_POWER_MAX_EVENTS[powerType ?? 0] ?? "UNIT_MAXMANA", unit);
    }
    return now;
  }

  #clear(): void {
    const slots = this.#slots;
    this.#slots = [];
    this.#casts.clear();
    slots.forEach((slot, index) => {
      this.#fire(FRAMEXML_ARENA_OPPONENT_UPDATE, `arena${index + 1}`, "cleared");
      if (slot.pet !== undefined) this.#fire(FRAMEXML_ARENA_OPPONENT_UPDATE, `arenapet${index + 1}`, "cleared");
    });
  }

  #matchKey(): string | undefined {
    const queues = this.#host.world()?.battlefieldQueues;
    if (!queues || typeof queues.values !== "function") return undefined;
    for (const queued of queues.values()) {
      if (queued.isArena && queued.status === STATUS_IN_PROGRESS && queued.cleared !== true) {
        return `${queued.queueSlot ?? 0}:${queued.clientInstanceId ?? 0}:${queued.mapId ?? 0}:${queued.arenaType ?? 0}`;
      }
    }
    return undefined;
  }

  /** Only an opponent in sight casts on its frame; its pet has no cast bar. */
  #castUnit(guid: bigint): string | undefined {
    const index = this.#slots.findIndex((slot) => slot.guid === guid);
    return index >= 0 && this.#slots[index]!.seen ? `arena${index + 1}` : undefined;
  }

  #castIdentity(cast: CastIdentity): readonly [string, string, number | undefined] {
    const metadata = this.#host.spell?.(cast.spellId);
    return [metadata?.name ?? `Заклинание ${cast.spellId}`, metadata?.rank ?? "", cast.castID];
  }

  #castStart(guid: bigint, spellId: number, channel: boolean): void {
    const unit = this.#castUnit(guid);
    if (!unit) return;
    const cast = this.#host.world()?.casts?.get(guid);
    const identity: CastIdentity = { spellId: cast?.spellId ?? spellId, channel, castID: cast?.castCount };
    this.#casts.set(guid, identity);
    if (channel) this.#fire(FRAMEXML_SEAM_EVENTS.channelStart, unit);
    else this.#fire(FRAMEXML_SEAM_EVENTS.castStart, unit, ...this.#castIdentity(identity));
  }

  /** WorldClient deletes the cast before STOP, so the identity kept at START answers it. */
  #castStop(guid: bigint, spellId: number, interrupted: boolean, reason: string | undefined): void {
    const identity = this.#casts.get(guid);
    this.#casts.delete(guid);
    const unit = this.#castUnit(guid);
    if (!unit) return;
    const effective = identity ?? { spellId, channel: false, castID: undefined };
    if (effective.channel) {
      this.#fire(FRAMEXML_SEAM_EVENTS.channelStop, unit);
      return;
    }
    const why = reason ?? (interrupted ? "interrupted" : "success");
    this.#fire(why === "failed" ? FRAMEXML_SEAM_EVENTS.castFailed
      : why === "interrupted" ? FRAMEXML_SEAM_EVENTS.castInterrupted : FRAMEXML_SEAM_EVENTS.castStop,
    unit, ...this.#castIdentity(effective));
  }

  #fire(event: string, ...args: readonly unknown[]): void {
    this.#pump?.fire(event, ...args);
  }
}
