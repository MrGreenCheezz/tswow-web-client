import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { WorldObjectState } from "./WorldState.js";

/*
 * The player's target history — last target, last enemy, last friend — as Wow.exe 3.3.5a (12340)
 * keeps it (WORK_PLAN 1.10/3.11, lane L2). Notes: .runtime/re-2026-10-04/l2-targeting/ (g1–g4) and
 * .runtime/re-2026-10-01/a9-combat/e1.c (0x524bf0).
 *
 * Three guids beside the selection (0x00bd07b0): last target 0x00bd07b8, last enemy 0x00bd07c0, last
 * friend 0x00bd07c8.
 * * SetTarget 0x524bf0 with a unit: last target = the selection it replaces, whatever that was —
 *   nothing included — and then, judged once, at that moment, the new unit: an enemy (0x729a70:
 *   alive and CanAttack) becomes the last enemy, else one the player can assist (0x7293d0 without
 *   ignoring immunities) the last friend.
 * * A clear the player asks for — SetTarget(0), ClearTarget 0x525fc0, a click on bare ground
 *   0x527360/0x5278c0, TargetLastTarget with nothing remembered 0x525d70 — makes the selection it
 *   drops the last target.
 * * A clear the realm asks for does not: SMSG_CLEAR_TARGET (0x756800 case 0x3bf) calls 0x5241b0
 *   directly, which only lets go of the selection.
 * * 0x524350 forgets a guid in all three slots (and lets go of it if selected, without recording
 *   it). It runs when a unit leaves the client (0x734fd0, the unit's removal, also for every
 *   neighbour on SMSG_NEW_WORLD), on SMSG_BREAK_TARGET (0x526530 case 0x152) and when a unit turns
 *   UNIT_FLAG_NOT_SELECTABLE (0x73c330). On the first two a unit of the player's own group — the
 *   player, the player's charm or summon, a party or raid member or such a member's charm, summon
 *   or pet (0x512a30 = 0x52d310 || 0x573200) — is kept, unless it is dueling the player (0x71f5c0).
 * * Leaving the world (0x528c30: SMSG_NEW_WORLD, logout) clears all three.
 *
 * Not modelled: the dueling exception to the group rule for a unit leaving the client (its fields
 * are gone when this client retires it, so it is kept); the NOT_SELECTABLE edge (no field-change
 * hook in the world client). L2-review: SMSG_BREAK_TARGET names a unit still in sight, and there the
 * duel is read ({@link duelsPlayer}); a group unit the client does not know is kept, as 0x526530 does.
 */

/** What the player's new selection was judged to be when it was made. */
export type TargetHistoryKind = "enemy" | "friend" | undefined;

/**
 * The judge of a new selection. The faction table lives in the browser, so the browser registers
 * one (game/TargetJudge.ts); without it a selection the world client's own CanAttack accepts is an
 * enemy and nothing is a friend.
 */
export type TargetHistoryJudge = (object: WorldObjectState) => TargetHistoryKind;

let registeredJudge: TargetHistoryJudge | undefined;

/** Installs (or, with undefined, removes) the browser's judge. */
export function setTargetHistoryJudge(judge: TargetHistoryJudge | undefined): void {
  registeredJudge = judge;
}

/** The kind of a new selection: the registered judge's answer, else `canAttack`'s. */
export function targetHistoryKind(object: WorldObjectState, canAttack: (object: WorldObjectState) => boolean): TargetHistoryKind {
  if (registeredJudge) return registeredJudge(object);
  return canAttack(object) ? "enemy" : undefined;
}

/** What the group rule reads of the world client: the player, the group and its members' pets. */
export interface TargetHistoryWorld {
  readonly state: { readonly selfGuid: bigint | undefined; readonly objects: ReadonlyMap<bigint, WorldObjectState> };
  readonly group?: { readonly members: readonly { readonly guid: bigint }[] } | undefined;
  readonly partyStats?: ReadonlyMap<bigint, { readonly petGuid?: bigint | undefined }> | undefined;
}

const CHARM = UPDATE_FIELDS.UNIT_FIELD_CHARM.offset;
const SUMMON = UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset;

function guidField(object: WorldObjectState, at: number): bigint | undefined {
  const low = object.fields.get(at) ?? 0;
  const high = object.fields.get(at + 1) ?? 0;
  return low === 0 && high === 0 ? undefined : (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
}

/** 0x52d310's reading of a unit's own unit: its UNIT_FIELD_CHARM, else its UNIT_FIELD_SUMMON. */
function charmOrSummon(object: WorldObjectState | undefined): bigint | undefined {
  if (!object) return undefined;
  return guidField(object, CHARM) ?? guidField(object, SUMMON);
}

const NO_MEMBERS: readonly { readonly guid: bigint }[] = [];

/**
 * 0x512a30: the guid is the player, the player's charm or summon, a group member, or a member's
 * charm, summon or (out of sight) the pet the party stats name.
 */
export function isOwnGroupGuid(world: TargetHistoryWorld, guid: bigint): boolean {
  const self = world.state.selfGuid;
  if (self === undefined) return false;
  if (guid === self) return true;
  if (charmOrSummon(world.state.objects.get(self)) === guid) return true;
  for (const member of world.group?.members ?? NO_MEMBERS) {
    if (member.guid === guid) return true;
    const object = world.state.objects.get(member.guid);
    const own = object ? charmOrSummon(object) : world.partyStats?.get(member.guid)?.petGuid;
    if (own !== undefined && own !== 0n && own === guid) return true;
  }
  return false;
}

// ---- L2-review: the duel exception (0x71f5c0) where the departing unit is still known ----

const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
const CHARMED_BY = UPDATE_FIELDS.UNIT_FIELD_CHARMEDBY.offset;
const CREATED_BY = UPDATE_FIELDS.UNIT_FIELD_CREATEDBY.offset;
const DUEL_ARBITER = UPDATE_FIELDS.PLAYER_DUEL_ARBITER.offset;
const DUEL_TEAM = UPDATE_FIELDS.PLAYER_DUEL_TEAM.offset;
const UNIT_FLAG_PLAYER_CONTROLLED = 0x8;
const TYPEID_PLAYER = 4;

/**
 * 0x718b70 as 0x71f5c0 uses it: the player behind a unit — the unit itself when it is a player, else
 * its charmer or creator, one step further for a charmed creation; undefined when that is no player
 * the client knows.
 */
function playerBehind(objects: ReadonlyMap<bigint, WorldObjectState>, unit: WorldObjectState): WorldObjectState | undefined {
  let current = unit;
  for (let step = 0; step < 2; step++) {
    if (current.typeId === TYPEID_PLAYER) return current;
    const master = guidField(current, CHARMED_BY) ?? guidField(current, CREATED_BY);
    const next = master === undefined ? undefined : objects.get(master);
    if (!next) return undefined;
    current = next;
  }
  return current.typeId === TYPEID_PLAYER ? current : undefined;
}

/**
 * 0x71f5c0 for a unit the client still knows and the player: both player-controlled, and their
 * players in one duel (the same PLAYER_DUEL_ARBITER) on different, non-zero PLAYER_DUEL_TEAMs. An
 * unknown unit — one already retired — is never dueling here. The branch 0x71f5c0 takes when one of
 * the two has no player behind it (a global read at 0x00c22b60) is not modelled: no duel.
 */
export function duelsPlayer(world: TargetHistoryWorld, guid: bigint): boolean {
  const objects = world.state.objects;
  const self = world.state.selfGuid === undefined ? undefined : objects.get(world.state.selfGuid);
  const unit = objects.get(guid);
  if (!self || !unit) return false;
  if (((self.fields.get(FLAGS) ?? 0) & UNIT_FLAG_PLAYER_CONTROLLED) === 0
    || ((unit.fields.get(FLAGS) ?? 0) & UNIT_FLAG_PLAYER_CONTROLLED) === 0) return false;
  const mine = playerBehind(objects, self);
  const theirs = playerBehind(objects, unit);
  if (!mine || !theirs) return false;
  const myTeam = mine.fields.get(DUEL_TEAM) ?? 0;
  const theirTeam = theirs.fields.get(DUEL_TEAM) ?? 0;
  return myTeam !== 0 && theirTeam !== 0 && myTeam !== theirTeam
    && (mine.fields.get(DUEL_ARBITER) ?? 0) === (theirs.fields.get(DUEL_ARBITER) ?? 0)
    && (mine.fields.get(DUEL_ARBITER + 1) ?? 0) === (theirs.fields.get(DUEL_ARBITER + 1) ?? 0);
}

export class TargetHistory {
  /** 0x00bd07b8. */
  lastTarget: bigint | undefined = undefined;
  /** 0x00bd07c0. */
  lastEnemy: bigint | undefined = undefined;
  /** 0x00bd07c8. */
  lastFriend: bigint | undefined = undefined;

  /**
   * The selection moved from `previous` to `next` at the player's (or the interface's) request:
   * 0x524bf0 with a unit, or one of the clears that remember what they drop. `kind` is the new
   * unit judged at this moment; a clear has none.
   */
  selected(previous: bigint | undefined, next: bigint | undefined, kind: TargetHistoryKind): void {
    if (next === undefined) {
      if (previous !== undefined) this.lastTarget = previous;
      return;
    }
    this.lastTarget = previous;
    if (kind === "enemy") this.lastEnemy = next;
    else if (kind === "friend") this.lastFriend = next;
  }

  /**
   * 0x524350 for a unit that left the client or broke its targeting (SMSG_BREAK_TARGET): forgotten
   * in every slot, unless it belongs to the player's group. Three comparisons for any other guid.
   */
  unitLeft(guid: bigint, world: TargetHistoryWorld): void {
    if (guid !== this.lastTarget && guid !== this.lastEnemy && guid !== this.lastFriend) return;
    if (isOwnGroupGuid(world, guid) && !duelsPlayer(world, guid)) return; // L2-review: `&& !duelsPlayer`
    this.forget(guid);
  }

  /** The guid in no slot any more. */
  forget(guid: bigint): void {
    if (this.lastTarget === guid) this.lastTarget = undefined;
    if (this.lastEnemy === guid) this.lastEnemy = undefined;
    if (this.lastFriend === guid) this.lastFriend = undefined;
  }

  /** 0x528c30: leaving the world clears all three. */
  reset(): void {
    this.lastTarget = undefined;
    this.lastEnemy = undefined;
    this.lastFriend = undefined;
  }
}
