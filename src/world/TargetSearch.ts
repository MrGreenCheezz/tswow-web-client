import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { REACTION_FRIENDLY } from "./FactionRules.js";
import { isWorldObjectDead, type WorldObjectState, type WorldPosition } from "./WorldState.js";

/*
 * Who the player may swing at, and what Tab (TargetNearestEnemy) picks, as Wow.exe 3.3.5a (12340)
 * does it. Notes and decompiles: .runtime/re-2026-10-01/a9-combat/ (e1–e5).
 *
 * Tab — TargetNearestEnemy 0x525ad0 calls 0x524fc0(reverse, mode 1):
 * * candidates (0x524440): every unit but the mover that passes the mode filter (0x518e40), measured
 *   from the mover (the vehicle or charmed body, 0x6dd060, else the player). A unit within ±30° of
 *   the mover's facing counts up to 41 yards (distance² ≤ 1681), any other only within 10 yards
 *   (≤ 100). CreatureType.dbc rows with flag 1 (critter 8, non-combat pet 12, gas cloud 13 on this
 *   dataset) never enter. The camera is not consulted.
 * * order (qsort with 0x5131d0): the ±30° cone first, then distance. No tie-break there; ours adds
 *   the guid so equal distances keep one order.
 * * cycle: the sorted list is kept while presses come less than 3 s apart, the mode stays and the
 *   selection is not cleared; a press steps from the entry that is still selected, wrapping at the
 *   end — and a wrap rebuilds the list once it is older than 1 s. A press after the selection moved
 *   elsewhere re-picks the entry it stands on. Each pick re-checks the filter; when nothing in the
 *   list still passes, the list is dropped and the selection stays.
 * * mode 1 filter (0x518e40): CanAttack (0x729740, `isAttackableUnit`), not dead, no
 *   UNIT_DYNFLAG_DEAD (feigned deaths stay out), stand state not UNIT_STAND_STATE_DEAD.
 */

/** Half the cone that reaches far (0.5236 rad at 0x00a02d20). */
export const TAB_FRONT_HALF_ARC = Math.PI / 6;
/** Distance² limit inside the cone (1681.0 at 0x009fe7f8), i.e. 41 yards. */
export const TAB_FRONT_RANGE_SQUARED = 1681;
/** Distance² limit outside it (100.0 at 0x009fe7fc), i.e. 10 yards. */
export const TAB_NEAR_RANGE_SQUARED = 100;
/** The list outlives presses this far apart (0x524fc0: `last + 3000 <= now` rebuilds). */
export const TAB_LIST_LIFETIME_MS = 3000;
/** A wrap past the end rebuilds a list older than this (0x524fc0: `built + 1000 <= now`). */
export const TAB_WRAP_REBUILD_MS = 1000;
/**
 * CreatureType.dbc ids whose flags carry bit 1 ("not a Tab target"): Critter 8, Non-combat Pet 12,
 * Gas Cloud 13 — read from the dataset's CreatureType.dbc; 0x524440 tests `flags & 1`.
 */
const TAB_IGNORED_CREATURE_TYPES = new Set([8, 12, 13]);

/** L2 1.10: 0x524440's creature-type net, which every TargetNearest* mode shares with Tab. */
export function isTabIgnoredCreatureType(creatureType: number | undefined): boolean {
  return creatureType !== undefined && TAB_IGNORED_CREATURE_TYPES.has(creatureType);
}

const UNIT_FLAG_NON_ATTACKABLE = 0x00000002;
const UNIT_FLAG_PLAYER_CONTROLLED = 0x00000008;
const UNIT_FLAG_NOT_ATTACKABLE_1 = 0x00000080;
const UNIT_FLAG_IMMUNE_TO_PC = 0x00000100;
const UNIT_FLAG_IMMUNE_TO_NPC = 0x00000200;
const UNIT_FLAG_NON_ATTACKABLE_2 = 0x00010000;
const UNIT_FLAG_ON_TAXI = 0x00100000;
const UNIT_FLAG_UNINTERACTIBLE = 0x02000000;
/** The target-side flags CanAttack (0x729740) refuses outright, UnitDefines.h:136-160. */
const UNIT_FLAGS_NEVER_ATTACKABLE = UNIT_FLAG_NON_ATTACKABLE | UNIT_FLAG_NOT_ATTACKABLE_1
  | UNIT_FLAG_NON_ATTACKABLE_2 | UNIT_FLAG_ON_TAXI | UNIT_FLAG_UNINTERACTIBLE;
/** `UNIT_FIELD_BYTES_2` byte 1, UnitDefines.h:108-112. */
const UNIT_BYTE2_FLAG_PVP = 0x01;
const UNIT_BYTE2_FLAG_UNK1 = 0x02;
const UNIT_BYTE2_FLAG_FFA_PVP = 0x04;
const UNIT_BYTE2_FLAG_SANCTUARY = 0x08;
/** PLAYER_FLAGS, Player.h:358 and :373. */
const PLAYER_FLAGS_GHOST = 0x00000010;
const PLAYER_FLAGS_UBER = 0x00080000;
/** SharedDefines.h:3129. */
const UNIT_DYNFLAG_DEAD = 0x0020;
/** UnitDefines.h:41. */
const UNIT_STAND_STATE_DEAD = 7;

const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
const BYTES_1 = UPDATE_FIELDS.UNIT_FIELD_BYTES_1.offset;
const BYTES_2 = UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset;
const DYNAMIC_FLAGS = UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset;
const PLAYER_FLAGS = UPDATE_FIELDS.PLAYER_FLAGS.offset;
const DUEL_ARBITER = UPDATE_FIELDS.PLAYER_DUEL_ARBITER.offset;
const SUMMONED_BY = UPDATE_FIELDS.UNIT_FIELD_SUMMONEDBY.offset;
const CHARMED_BY = UPDATE_FIELDS.UNIT_FIELD_CHARMEDBY.offset;

function isUnit(object: WorldObjectState): boolean {
  return object.typeId === 3 || object.typeId === 4;
}

/** A player, or a unit a player summoned or charmed (0x718b70's "owning player" exists). */
function ownedByPlayer(object: WorldObjectState): boolean {
  if (object.typeId === 4) return true;
  return (object.fields.get(SUMMONED_BY) ?? 0) !== 0 || (object.fields.get(SUMMONED_BY + 1) ?? 0) !== 0
    || (object.fields.get(CHARMED_BY) ?? 0) !== 0 || (object.fields.get(CHARMED_BY + 1) ?? 0) !== 0;
}

function pvpByte(object: WorldObjectState): number {
  return ((object.fields.get(BYTES_2) ?? 0) >>> 8) & 0xff;
}

/** Two players in the same duel (PLAYER_DUEL_ARBITER, both words equal and non-zero). */
function sameDuel(self: WorldObjectState, other: WorldObjectState): boolean {
  if (self.typeId !== 4 || other.typeId !== 4) return false;
  const low = self.fields.get(DUEL_ARBITER) ?? 0;
  const high = self.fields.get(DUEL_ARBITER + 1) ?? 0;
  if (low === 0 && high === 0) return false;
  return low === (other.fields.get(DUEL_ARBITER) ?? 0) && high === (other.fields.get(DUEL_ARBITER + 1) ?? 0);
}

/**
 * Whether `self` may swing at `object`: Wow.exe's CanAttack (0x729740) over what this client has,
 * plus "alive" (the server refuses a dead victim in `Unit::Attack`, Unit.cpp:5930).
 *
 * `reaction` is `object` seen from `self` (REACTION_* of FactionRules.ts, forced reactions already
 * applied); the faction table lives in the browser, so the caller supplies it.
 *
 * Refused: a dead or non-unit object; target flags NON_ATTACKABLE, NOT_ATTACKABLE_1,
 * NON_ATTACKABLE_2, ON_TAXI, UNINTERACTIBLE; a ghost player; a self with PLAYER_FLAGS_UBER;
 * IMMUNE_TO_PC/IMMUNE_TO_NPC against the other side's PLAYER_CONTROLLED; a friendly unit. Between
 * two player-owned units: a duel partner always; otherwise a target without the PvP bit only when
 * both are FFA, and only if either carries byte-2 flag 0x02; sanctuary (0x08) on either side never.
 * A player-controlled self against an NPC: never a sanctuary target, else any non-friendly one —
 * neutral (yellow) creatures included.
 *
 * Not modelled: the vehicle-passenger rule (UNIT_FIELD_FLAGS_2 0x10000 with VehicleSeat flag
 * 0x20000000), a self able to see ghosts, and the client's second "friendly" test (0x715df0).
 */
export function isAttackableUnit(
  self: WorldObjectState | undefined,
  object: WorldObjectState,
  reaction: number,
): boolean {
  if (!isUnit(object) || isWorldObjectDead(object) || object === self) return false;
  const targetFlags = object.fields.get(FLAGS) ?? 0;
  if ((targetFlags & UNIT_FLAGS_NEVER_ATTACKABLE) !== 0) return false;
  if (object.typeId === 4 && ((object.fields.get(PLAYER_FLAGS) ?? 0) & PLAYER_FLAGS_GHOST) !== 0) return false;
  if (!self) return reaction !== REACTION_FRIENDLY;
  if (self.typeId === 4 && ((self.fields.get(PLAYER_FLAGS) ?? 0) & PLAYER_FLAGS_UBER) !== 0) return false;
  const selfFlags = self.fields.get(FLAGS) ?? 0;
  const selfControlled = (selfFlags & UNIT_FLAG_PLAYER_CONTROLLED) !== 0;
  const targetControlled = (targetFlags & UNIT_FLAG_PLAYER_CONTROLLED) !== 0;
  if ((targetFlags & (selfControlled ? UNIT_FLAG_IMMUNE_TO_PC : UNIT_FLAG_IMMUNE_TO_NPC)) !== 0) return false;
  if ((selfFlags & (targetControlled ? UNIT_FLAG_IMMUNE_TO_PC : UNIT_FLAG_IMMUNE_TO_NPC)) !== 0) return false;
  const friendly = reaction === REACTION_FRIENDLY;
  const selfPvp = pvpByte(self);
  const targetPvp = pvpByte(object);
  if (selfControlled && targetControlled) {
    if (friendly) return false;
    if (ownedByPlayer(self) && ownedByPlayer(object)) {
      if (sameDuel(self, object)) return true;
      if ((targetPvp & UNIT_BYTE2_FLAG_PVP) === 0) {
        if ((selfPvp & UNIT_BYTE2_FLAG_FFA_PVP) !== 0 && (targetPvp & UNIT_BYTE2_FLAG_FFA_PVP) !== 0) return true;
        if ((selfPvp & UNIT_BYTE2_FLAG_UNK1) === 0 && (targetPvp & UNIT_BYTE2_FLAG_UNK1) === 0) return false;
      }
    }
    return (selfPvp & UNIT_BYTE2_FLAG_SANCTUARY) === 0 && (targetPvp & UNIT_BYTE2_FLAG_SANCTUARY) === 0;
  }
  if (!selfControlled && !targetControlled) return !friendly;
  if (selfControlled && (targetPvp & UNIT_BYTE2_FLAG_SANCTUARY) !== 0) return false;
  if (targetControlled && (selfPvp & UNIT_BYTE2_FLAG_SANCTUARY) !== 0) return false;
  return !friendly;
}

/**
 * TargetNearestEnemy's filter (0x518e40 mode 1): attackable, and not lying dead by any of the three
 * signs the client reads — health, UNIT_DYNFLAG_DEAD, or the dead stand state. `creatureType` is
 * the template's CreatureType.dbc id when known; a critter, a companion pet or a gas cloud is never
 * a Tab target.
 */
export function isTabEnemy(
  self: WorldObjectState | undefined,
  object: WorldObjectState,
  reaction: number,
  creatureType?: number,
): boolean {
  if (!isAttackableUnit(self, object, reaction)) return false;
  if (((object.fields.get(DYNAMIC_FLAGS) ?? 0) & UNIT_DYNFLAG_DEAD) !== 0) return false;
  if (((object.fields.get(BYTES_1) ?? 0) & 0xff) === UNIT_STAND_STATE_DEAD) return false;
  return creatureType === undefined || !TAB_IGNORED_CREATURE_TYPES.has(creatureType);
}

export interface TargetCandidate {
  guid: bigint;
  /** Squared 3D distance from the mover, as 0x524440 keeps it. */
  distanceSquared: number;
  /** Inside the ±30° cone of the mover's facing; sorted before everything outside it. */
  ahead: boolean;
}

function compareCandidates(a: TargetCandidate, b: TargetCandidate): number {
  if (a.ahead !== b.ahead) return a.ahead ? -1 : 1;
  if (a.distanceSquared !== b.distanceSquared) return a.distanceSquared - b.distanceSquared;
  return a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0;
}

const TWO_PI = Math.PI * 2;

/**
 * Fills `out` with the Tab candidates around `origin` (the mover, facing `origin.orientation`) and
 * sorts it; returns the count, which is also `out.length`. Entry objects already in `out` are
 * reused, so a rebuild in a crowd allocates only when the list grows.
 */
export function collectTabCandidates(
  objects: Iterable<WorldObjectState>,
  origin: WorldPosition,
  originGuid: bigint | undefined,
  accept: (object: WorldObjectState) => boolean,
  out: TargetCandidate[],
): number {
  let count = 0;
  const facing = origin.orientation;
  for (const object of objects) {
    if (object.guid === originGuid || !isUnit(object)) continue;
    const position = object.position;
    if (!position) continue;
    const dx = position.x - origin.x;
    const dy = position.y - origin.y;
    const dz = position.z - origin.z;
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    // Cheapest test first: nothing past 41 yards can enter, whatever its bearing.
    if (distanceSquared > TAB_FRONT_RANGE_SQUARED) continue;
    let ahead = false;
    if (dx !== 0 || dy !== 0) {
      let delta = (Math.atan2(dy, dx) - facing) % TWO_PI;
      if (delta < 0) delta += TWO_PI;
      ahead = delta < TAB_FRONT_HALF_ARC || delta > TWO_PI - TAB_FRONT_HALF_ARC;
    }
    if (!ahead && distanceSquared > TAB_NEAR_RANGE_SQUARED) continue;
    if (!accept(object)) continue;
    const entry = out[count];
    if (entry) {
      entry.guid = object.guid;
      entry.distanceSquared = distanceSquared;
      entry.ahead = ahead;
    } else {
      out.push({ guid: object.guid, distanceSquared, ahead });
    }
    count++;
  }
  out.length = count;
  out.sort(compareCandidates);
  return count;
}

/** The same candidates as a fresh array, for callers off the hot path and for tests. */
export function enemiesAround(
  objects: Iterable<WorldObjectState>,
  origin: WorldPosition,
  originGuid: bigint | undefined,
  accept: (object: WorldObjectState) => boolean,
): TargetCandidate[] {
  const out: TargetCandidate[] = [];
  collectTabCandidates(objects, origin, originGuid, accept, out);
  return out;
}

/** Where a {@link TabCycle} gets its list from and how it re-checks an entry before picking it. */
export interface TabSource {
  /** Fills and sorts `out` (see {@link collectTabCandidates}); returns the count. */
  collect(out: TargetCandidate[]): number;
  /** The entry still exists and still passes the filter. */
  valid(guid: bigint): boolean;
}

/**
 * The state 0x524fc0 keeps between presses (list 0x00bd0c04/count 0x00bd0c00, index 0x00bd08c8,
 * built 0x00bd08cc, last press 0x00bd08d0). A press costs a lookup and a filter check; the list is
 * rebuilt at most once per press.
 */
export class TabCycle {
  readonly #list: TargetCandidate[] = [];
  #count = 0;
  #index = 0;
  #builtAt = 0;
  #pressedAt = 0;

  /** The selection was cleared (0x524bf0 with guid 0 zeroes the build time): rebuild next press. */
  invalidate(): void {
    this.#builtAt = 0;
  }

  /** The entries of the current list, in order (tests and diagnostics). */
  get list(): readonly TargetCandidate[] {
    return this.#list.slice(0, this.#count);
  }

  /** One press. Returns the guid to select, or undefined when nothing qualifies. */
  next(now: number, current: bigint | undefined, reverse: boolean, source: TabSource): bigint | undefined {
    const stamp = now > 0 ? now : 1;
    // At most two passes: the second only follows a stale wrap, right after a fresh rebuild, and a
    // list built in this very press cannot be stale.
    for (let pass = 0; pass < 2; pass++) {
      if (this.#builtAt === 0 || this.#pressedAt === 0 || now >= this.#pressedAt + TAB_LIST_LIFETIME_MS
        || this.#count === 0) {
        this.#index = 0;
        this.#pressedAt = 0;
        this.#builtAt = 0;
        this.#count = source.collect(this.#list);
        if (this.#count === 0) return undefined;
        this.#builtAt = stamp;
      } else if (current !== undefined && this.#list[this.#index]!.guid === current) {
        if (!reverse) {
          this.#index++;
          if (this.#index >= this.#count) {
            this.#index = 0;
            if (now >= this.#builtAt + TAB_WRAP_REBUILD_MS) {
              this.#builtAt = 0;
              continue;
            }
          }
        } else {
          this.#index = this.#index === 0 ? this.#count - 1 : this.#index - 1;
        }
      }
      this.#pressedAt = stamp;
      let at = this.#index;
      for (;;) {
        const guid = this.#list[at]!.guid;
        if (source.valid(guid)) {
          this.#index = at;
          return guid;
        }
        at++;
        if (at >= this.#count) {
          at = 0;
          if (now >= this.#builtAt + TAB_WRAP_REBUILD_MS) break;
        }
        if (at === this.#index) {
          // Nothing in the list passes any more (0x522220(0)): drop it, keep the selection.
          this.#count = 0;
          this.#list.length = 0;
          return undefined;
        }
      }
      this.#builtAt = 0;
    }
    return undefined;
  }
}
