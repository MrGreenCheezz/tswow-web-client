/**
 * 11.10: which way a unit the client does not move itself is drawn facing.
 *
 * The owner's report of the live check: «enemies do not look toward the one they attack». The core
 * turns a creature to its victim only in its own head: `ChaseMovementGenerator` ends a chase with
 * `Unit::SetInFront` (ChaseMovementGenerator.cpp:142, :156), which is `SetOrientation` and sends
 * nothing (Unit.cpp:14477-14481), and `Unit::Attack` only sets UNIT_FIELD_TARGET (Unit.cpp:5994). A
 * caster's target is cleared for a spell that must not turn it (`Creature::SetSpellFocus`,
 * Creature.cpp:3574-3586: SPELL_ATTR5_DONT_TURN_DURING_CAST) and UNIT_FLAG2_CANNOT_TURN names the
 * client's own turning (UnitDefines.h:199). The turning is the client's.
 *
 * Wow.exe 3.3.5a 12340 (Ghidra read-only, `.runtime/re-2026-10-11/glue-1110/mov-4.txt`, `mov-5.txt`,
 * `mov-6.txt`, `s533-1.txt`, `s504-1.txt`): 0x00735f60 decides the drawn facing (+0xaa0) of every unit that
 * is not the active player, every frame. While the unit
 *
 * * moves on none of its own axes — movement word (+0x7cc) `& 0xf` clear; a spline sets forward;
 * * stands — vtable+0x138 is 0x0071a380, byte 0 of UNIT_FIELD_BYTES_1, the stand state;
 * * holds no emote state whose Emotes.dbc row (0x00ad3774 table) lacks EmoteFlags 0x2000 — 5.32: read
 *   (generated `EMOTE_FLAGS`; a row not there forbids nothing; the ready stances 26/27/333 carry 0x2000);
 * * is not UNIT_FLAG_STUNNED (0x40000), UNIT_FLAG_POSSESSED (0x1000000) nor UNIT_FLAG2_CANNOT_TURN
 *   (0x8000), and is no player at all (the object's type mask carries PLAYER);
 * * casts nothing with SPELL_ATTR5_DONT_TURN_DURING_CAST (0x00722640: the spell at +0xa60, AttributesEx5
 *   0x80000) — 5.32: read from the casts this client tracks (`UnitFacingSources.casting`);
 * * rides no vehicle seat, or one whose VehicleSeat.dbc row has VEHICLE_SEAT_FLAG_ALLOW_TURNING (0x400;
 *   0x0074b8b0, 0x005d3340) — 5.32: such a seat turns its passenger, in the seat ({@link unitSeatFacing}),
 *
 * it faces UNIT_FIELD_CHANNEL_OBJECT while channelling a spell with SPELL_ATTR1_CHANNEL_TRACK_TARGET
 * (0x4000, the flag 0x0072bc70 sets in +0xa30 when UNIT_CHANNEL_SPELL changes), and UNIT_FIELD_TARGET
 * otherwise — when that unit is in view. With neither, it faces the active player while that player has its
 * gossip, quest, vendor, trainer, bank… window open on it (the global 0x00bd07a8: set by 0x0051fce0 from the
 * frames — QuestFrame.cpp, TradeFrame.cpp, ItemTextFrame.cpp among them — cleared by 0x00512e60) — 5.32:
 * `UnitFacingSources.interactionNpc`. Everything else draws the unit at its own movement facing.
 *
 * The drawn facing then follows the chosen one smoothly ({@link ShownUnitFacing}).
 *
 * Not modelled: a vehicle's own aim target (+0xf5c +0x160, before the unit's target), +0xa30 bit 0's fixed
 * facing (+0xab8).
 */

import { CREATURE_MOVEMENT_CHASE_RATES, EMOTE_FLAGS } from "../generated/animations.js"; // 5.32
import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { guidFromWords } from "../protocol/Guid.js";
import { MOVEMENT_FLAGS } from "./MovementProtocol.js";
import { spellAttributeWords } from "./PetCastSpell.js";
import type { WorldObjectState } from "./WorldState.js";

/** `UNIT_FLAG_PLAYER_CONTROLLED`, `UNIT_FLAG_PET_IN_COMBAT`, `UNIT_FLAG_STUNNED`, `UNIT_FLAG_POSSESSED` (UnitDefines.h). */
const UNIT_FLAG_PLAYER_CONTROLLED = 0x0000_0008;
const UNIT_FLAG_PET_IN_COMBAT = 0x0000_0800;
const UNIT_FLAG_STUNNED = 0x0004_0000;
const UNIT_FLAG_POSSESSED = 0x0100_0000;
/** `UNIT_FLAG2_CANNOT_TURN` (UnitDefines.h:199). */
const UNIT_FLAG2_CANNOT_TURN = 0x0000_8000;
/** `SPELL_ATTR1_CHANNEL_TRACK_TARGET` (SharedDefines.h:458), Spell.dbc AttributesEx. */
export const SPELL_ATTR1_CHANNEL_TRACK_TARGET = 0x0000_4000;
/** 5.32: `SPELL_ATTR5_DONT_TURN_DURING_CAST` (SharedDefines.h), Spell.dbc AttributesEx5 — 0x00722640's test. */
export const SPELL_ATTR5_DONT_TURN_DURING_CAST = 0x0008_0000;
/** 5.32: Emotes.dbc EmoteFlags bit 0x00735f60 needs on a held emote state's row for the unit to turn. */
export const EMOTE_FLAG_TURNS = 0x2000;
/** 5.32: `VEHICLE_SEAT_FLAG_ALLOW_TURNING` (DBCEnums.h), VehicleSeat.dbc Flags — the seat 0x00735f60 turns. */
export const VEHICLE_SEAT_FLAG_ALLOW_TURNING = 0x0000_0400;
/** 5.32: `_DAT_009ea558`: a SmoothFacingChaseRate this small is none. */
export const CHASE_RATE_MINIMUM = 1e-5;
/** Forward, backward and the two strafes: what 0x00735f60 calls moving (`& 0xf`). */
const OWN_AXES = MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.backward | MOVEMENT_FLAGS.strafeLeft | MOVEMENT_FLAGS.strafeRight;
const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;
const TYPEID_GAMEOBJECT = 5;

const TARGET = UPDATE_FIELDS.UNIT_FIELD_TARGET.offset;
const CHANNEL_OBJECT = UPDATE_FIELDS.UNIT_FIELD_CHANNEL_OBJECT.offset;
const CHANNEL_SPELL = UPDATE_FIELDS.UNIT_CHANNEL_SPELL.offset;
const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
const FLAGS_2 = UPDATE_FIELDS.UNIT_FIELD_FLAGS_2.offset;
const BYTES_1 = UPDATE_FIELDS.UNIT_FIELD_BYTES_1.offset;
const EMOTE_STATE = UPDATE_FIELDS.UNIT_NPC_EMOTESTATE.offset;

/**
 * 5.32: what 0x00735f60 reads that is not on the unit's own fields, registered by the page (app/EnterWorld.ts)
 * from the world client; each absent answer reads as Wow.exe's «nothing there».
 */
export interface UnitFacingSources {
  /** The spell a unit is casting now, not channelling (+0xa60, SMSG_SPELL_START until it ends), or undefined. */
  casting?(guid: bigint): number | undefined;
  /** The unit the player's interaction window is open on (0x00bd07a8), or undefined. */
  interactionNpc?(): bigint | undefined;
  /** A creature's CreatureMovementInfo id (SMSG_CREATURE_QUERY_RESPONSE `movementId`; +0x964 +0x58), or undefined. */
  movementId?(object: WorldObjectState): number | undefined;
}

let sources: UnitFacingSources = {};

/** 5.32: the page's answers (`undefined` forgets them, as on leaving the world). */
export function setUnitFacingSources(next: UnitFacingSources | undefined): void {
  sources = next ?? {};
}

/** A guid held in two slots, or undefined for an empty one — no bigint is made for the empty case. */
function guidIn(object: WorldObjectState, index: number): bigint | undefined {
  const low = object.fields.get(index) ?? 0;
  const high = object.fields.get(index + 1) ?? 0;
  return low === 0 && high === 0 ? undefined : guidFromWords(low >>> 0, high >>> 0);
}

/** Whether a spell's row carries SPELL_ATTR1_CHANNEL_TRACK_TARGET; undefined while its row is not known. */
export function spellChannelTracksTarget(spellId: number): boolean | undefined {
  const words = spellAttributeWords(spellId);
  return words === undefined ? undefined : ((words[1] ?? 0) & SPELL_ATTR1_CHANNEL_TRACK_TARGET) !== 0;
}

/**
 * The unit 0x00735f60 turns `object` toward, or undefined when it keeps its own facing — every test but the
 * seat's ({@link unitAutoFacing} and {@link unitSeatFacing} add those). `selfGuid` is the active player.
 */
function facingTarget(
  object: WorldObjectState,
  objects: ReadonlyMap<bigint, WorldObjectState>,
  channelTracksTarget: (spellId: number) => boolean | undefined,
  selfGuid: bigint | undefined,
): WorldObjectState | undefined {
  if (object.typeId !== TYPEID_UNIT) return undefined;
  if (!object.position || (object.movementFlags & OWN_AXES) !== 0 || object.motion !== undefined) return undefined;
  // 5.32: an emote state whose row does not carry 0x2000 (0x00735f60's first test).
  const emote = object.fields.get(EMOTE_STATE) ?? 0;
  if (emote !== 0) {
    const emoteFlags = EMOTE_FLAGS[emote];
    if (emoteFlags !== undefined && (emoteFlags & EMOTE_FLAG_TURNS) === 0) return undefined;
  }
  if (((object.fields.get(BYTES_1) ?? 0) & 0xff) !== 0) return undefined;
  const flags = object.fields.get(FLAGS) ?? 0;
  if ((flags & (UNIT_FLAG_STUNNED | UNIT_FLAG_POSSESSED)) !== 0) return undefined;
  if (((object.fields.get(FLAGS_2) ?? 0) & UNIT_FLAG2_CANNOT_TURN) !== 0) return undefined;
  // 5.32: 0x00722640 — not while casting a spell that must not turn its caster.
  const casting = sources.casting?.(object.guid);
  if (casting !== undefined && ((spellAttributeWords(casting)?.[5] ?? 0) & SPELL_ATTR5_DONT_TURN_DURING_CAST) !== 0) {
    return undefined;
  }
  const channel = object.fields.get(CHANNEL_SPELL) ?? 0;
  let guid = channel !== 0 && channelTracksTarget(channel) === true
    ? guidIn(object, CHANNEL_OBJECT) : guidIn(object, TARGET);
  // 5.32: no target — the active player, while its interaction window is open on this unit.
  if (guid === undefined && selfGuid !== undefined && sources.interactionNpc?.() === object.guid) guid = selfGuid;
  if (guid === undefined || guid === object.guid) return undefined;
  const target = objects.get(guid);
  if (!target?.position || (target.typeId !== TYPEID_UNIT && target.typeId !== TYPEID_PLAYER)) return undefined;
  const dx = target.position.x - object.position.x;
  const dy = target.position.y - object.position.y;
  return dx === 0 && dy === 0 ? undefined : target;
}

/**
 * The world facing (radians, the orientation's own convention) Wow.exe 0x00735f60 turns `object` to,
 * or undefined when it keeps its own. `objects` finds the target; `channelTracksTarget` answers
 * whether a spell carries SPELL_ATTR1_CHANNEL_TRACK_TARGET (undefined: its row is not known, which
 * reads as no — UNIT_FIELD_TARGET, which the core points at the channel's target for such a spell
 * anyway, `Spell::SendChannelStart` → `SetSpellFocus`, Spell.cpp:4879-4885). A passenger of a vehicle
 * seat is turned in its seat instead ({@link unitSeatFacing}); a ship's passenger is turned here.
 */
export function unitAutoFacing(
  object: WorldObjectState,
  objects: ReadonlyMap<bigint, WorldObjectState>,
  channelTracksTarget: (spellId: number) => boolean | undefined = spellChannelTracksTarget,
  selfGuid?: bigint,
): number | undefined {
  if (object.transport !== undefined && objects.get(object.transport.guid)?.typeId !== TYPEID_GAMEOBJECT) return undefined;
  const target = facingTarget(object, objects, channelTracksTarget, selfGuid);
  if (target === undefined) return undefined;
  return Math.atan2(target.position!.y - object.position!.y, target.position!.x - object.position!.x);
}

/**
 * 5.32: a vehicle seat's passenger (`object.transport` names the vehicle, `seatFlags` its VehicleSeat.dbc row's
 * Flags, undefined while the row is not known — which Wow.exe reads as no row, and turns): the facing in the seat
 * 0x00735f60 turns it to, `angle to the target − the vehicle's drawn facing` (0x00717e50 sums the drawn facings
 * up the chain of vehicles; `vehicleFacing` answers it), or undefined when it keeps its seat's own — no target,
 * a seat without VEHICLE_SEAT_FLAG_ALLOW_TURNING, or the vehicle not in view.
 */
export function unitSeatFacing(
  object: WorldObjectState,
  objects: ReadonlyMap<bigint, WorldObjectState>,
  seatFlags: number | undefined,
  vehicleFacing: (vehicle: WorldObjectState) => number,
  selfGuid?: bigint,
  channelTracksTarget: (spellId: number) => boolean | undefined = spellChannelTracksTarget,
): number | undefined {
  const transport = object.transport;
  if (transport === undefined) return undefined;
  if (seatFlags !== undefined && (seatFlags & VEHICLE_SEAT_FLAG_ALLOW_TURNING) === 0) return undefined;
  const vehicle = objects.get(transport.guid);
  if (vehicle === undefined) return undefined;
  const target = facingTarget(object, objects, channelTracksTarget, selfGuid);
  if (target === undefined) return undefined;
  const world = Math.atan2(target.position!.y - object.position!.y, target.position!.x - object.position!.x);
  return wrap(world - vehicleFacing(vehicle));
}

/**
 * How the drawn facing follows the chosen one in 0x00735f60: a creature whose CreatureMovementInfo row
 * (SMSG_CREATURE_QUERY_RESPONSE `movementId`) names a SmoothFacingChaseRate over 1e-5 springs at that rate
 * (0x007160b0) — 5.32: read (`UnitFacingSources.movementId`, generated `CREATURE_MOVEMENT_CHASE_RATES`);
 * otherwise `"average"` — half of the last four frames' differences a frame — for a unit that is not
 * UNIT_FLAG_PLAYER_CONTROLLED and for a player; a critically damped spring of 20 rad/s (`_DAT_009f281c`)
 * for a player's pet or charm, 30 (`_DAT_00a19cdc`) while UNIT_FLAG_PET_IN_COMBAT is up (0x0071afb0).
 */
export function unitFacingTurn(object: WorldObjectState): "average" | number {
  const movement = object.typeId === TYPEID_UNIT ? sources.movementId?.(object) : undefined;
  if (movement !== undefined && movement !== 0) {
    const rate = CREATURE_MOVEMENT_CHASE_RATES[movement];
    if (rate !== undefined && rate > CHASE_RATE_MINIMUM) return rate;
  }
  const flags = object.fields.get(FLAGS) ?? 0;
  if (object.typeId === TYPEID_PLAYER || (flags & UNIT_FLAG_PLAYER_CONTROLLED) === 0) return "average";
  return (flags & UNIT_FLAG_PET_IN_COMBAT) !== 0 ? 30 : 20;
}

/** `_DAT_009f1968`: a difference this small is no difference — the drawn facing takes the chosen one. */
export const UNIT_FACING_SNAP = 0.01;

function wrap(angle: number): number {
  let value = angle % (Math.PI * 2);
  if (value > Math.PI) value -= Math.PI * 2;
  else if (value < -Math.PI) value += Math.PI * 2;
  return value;
}

/**
 * One unit's drawn facing, stepped once a frame toward the facing chosen for it (0x00735f60 from
 * LAB_0073632a; +0xaa0 the drawn facing, +0xaa4 the spring's rate of turn, +0xaa8..+0xab4 the last
 * four differences). The averaged step is per frame, as it is there.
 */
export class ShownUnitFacing {
  /** The drawn facing; NaN until the first step, which takes the chosen facing as it is. */
  angle = Number.NaN;
  #velocity = 0;
  readonly #history = [0, 0, 0, 0];

  step(chosen: number, turn: "average" | number, seconds: number): number {
    if (!Number.isFinite(chosen)) return this.angle;
    if (!Number.isFinite(this.angle)) {
      this.angle = chosen;
      return chosen;
    }
    const difference = wrap(chosen - this.angle);
    if (turn === "average") {
      if (Math.abs(difference) < UNIT_FACING_SNAP) {
        this.#history[0] = 0;
        this.angle = chosen;
        return chosen;
      }
      const history = this.#history;
      // A turn the other way starts afresh.
      if ((difference >= 0 && history[0]! < 0) || (difference < 0 && history[0]! > 0)) history[0] = 0;
      let average: number;
      if (history[0] === 0) {
        history.fill(difference);
        average = difference;
      } else {
        history[3] = history[2]!;
        history[2] = history[1]!;
        history[1] = history[0]!;
        history[0] = difference;
        average = (history[0] + history[1]! + history[2]! + history[3]!) * 0.25;
        // Never past the facing chosen.
        if (difference <= 0 ? average < difference : average > difference) average = difference;
      }
      this.angle = wrap(this.angle + average * 0.5);
      return this.angle;
    }
    if (!(seconds > 0)) return this.angle;
    // 0x007160b0, with the chosen facing taken to within half a turn of the drawn one.
    const target = this.angle + difference;
    const omega = turn;
    const x = omega * seconds;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = this.angle - target;
    const carried = (change * omega + this.#velocity) * seconds;
    this.angle = wrap(target + (change + carried) * decay);
    this.#velocity = (this.#velocity - carried * omega) * decay;
    return this.angle;
  }
}
