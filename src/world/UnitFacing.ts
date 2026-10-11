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
 * `mov-6.txt`): 0x00735f60 decides the drawn facing (+0xaa0) of every unit that is not the active
 * player, every frame. While the unit
 *
 * * moves on none of its own axes — movement word (+0x7cc) `& 0xf` clear; a spline sets forward;
 * * stands — vtable+0x138 is 0x0071a380, byte 0 of UNIT_FIELD_BYTES_1, the stand state;
 * * is in no emote state that forbids it (UNIT_NPC_EMOTESTATE's Emotes.dbc row without flag 0x2000;
 *   the ready stances 25/26/27 carry it) — not modelled here: the client's emote table has no flags,
 *   and `Unit::Attack` clears a creature's emote state anyway (Unit.cpp:6011-6014);
 * * is not UNIT_FLAG_STUNNED (0x40000), UNIT_FLAG_POSSESSED (0x1000000) nor UNIT_FLAG2_CANNOT_TURN
 *   (0x8000), and is no player at all (the object's type mask carries PLAYER);
 * * casts nothing with SPELL_ATTR5_DONT_TURN_DURING_CAST (0x00722640) — not read here: the core has
 *   already emptied UNIT_FIELD_TARGET for that very spell;
 * * rides no vehicle seat, or one with VEHICLE_SEAT_FLAG_ALLOW_TURNING (0x400; 0x0074b8b0) — a seat
 *   is not turned here at all,
 *
 * it faces UNIT_FIELD_CHANNEL_OBJECT while channelling a spell with SPELL_ATTR1_CHANNEL_TRACK_TARGET
 * (0x4000, the flag 0x0072bc70 sets in +0xa30 when UNIT_CHANNEL_SPELL changes), and UNIT_FIELD_TARGET
 * otherwise — when that unit is in view. (With no target it also faces the active player while that
 * player has its gossip, vendor or trainer window open on it, the global 0x00bd07a8 — not modelled:
 * this client keeps no single «npc» unit.) Everything else draws the unit at its own movement facing.
 *
 * The drawn facing then follows the chosen one smoothly ({@link ShownUnitFacing}).
 */

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
/** Forward, backward and the two strafes: what 0x00735f60 calls moving (`& 0xf`). */
const OWN_AXES = MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.backward | MOVEMENT_FLAGS.strafeLeft | MOVEMENT_FLAGS.strafeRight;
const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;

const TARGET = UPDATE_FIELDS.UNIT_FIELD_TARGET.offset;
const CHANNEL_OBJECT = UPDATE_FIELDS.UNIT_FIELD_CHANNEL_OBJECT.offset;
const CHANNEL_SPELL = UPDATE_FIELDS.UNIT_CHANNEL_SPELL.offset;
const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
const FLAGS_2 = UPDATE_FIELDS.UNIT_FIELD_FLAGS_2.offset;
const BYTES_1 = UPDATE_FIELDS.UNIT_FIELD_BYTES_1.offset;

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
 * The world facing (radians, the orientation's own convention) Wow.exe 0x00735f60 turns `object` to,
 * or undefined when it keeps its own. `objects` finds the target; `channelTracksTarget` answers
 * whether a spell carries SPELL_ATTR1_CHANNEL_TRACK_TARGET (undefined: its row is not known, which
 * reads as no — UNIT_FIELD_TARGET, which the core points at the channel's target for such a spell
 * anyway, `Spell::SendChannelStart` → `SetSpellFocus`, Spell.cpp:4879-4885).
 */
export function unitAutoFacing(
  object: WorldObjectState,
  objects: ReadonlyMap<bigint, WorldObjectState>,
  channelTracksTarget: (spellId: number) => boolean | undefined = spellChannelTracksTarget,
): number | undefined {
  if (object.typeId !== TYPEID_UNIT) return undefined;
  const position = object.position;
  if (!position || (object.movementFlags & OWN_AXES) !== 0 || object.motion !== undefined) return undefined;
  if (((object.fields.get(BYTES_1) ?? 0) & 0xff) !== 0) return undefined;
  const flags = object.fields.get(FLAGS) ?? 0;
  if ((flags & (UNIT_FLAG_STUNNED | UNIT_FLAG_POSSESSED)) !== 0) return undefined;
  if (((object.fields.get(FLAGS_2) ?? 0) & UNIT_FLAG2_CANNOT_TURN) !== 0) return undefined;
  if (object.transport !== undefined && objects.get(object.transport.guid)?.typeId !== 5) return undefined;
  const channel = object.fields.get(CHANNEL_SPELL) ?? 0;
  const guid = channel !== 0 && channelTracksTarget(channel) === true
    ? guidIn(object, CHANNEL_OBJECT) : guidIn(object, TARGET);
  if (guid === undefined || guid === object.guid) return undefined;
  const target = objects.get(guid);
  if (!target?.position || (target.typeId !== TYPEID_UNIT && target.typeId !== TYPEID_PLAYER)) return undefined;
  const dx = target.position.x - position.x;
  const dy = target.position.y - position.y;
  if (dx === 0 && dy === 0) return undefined;
  return Math.atan2(dy, dx);
}

/**
 * How the drawn facing follows the chosen one in 0x00735f60: `"average"` — half of the last four
 * frames' differences a frame — for a unit that is not UNIT_FLAG_PLAYER_CONTROLLED and for a player;
 * a critically damped spring (0x007160b0) of 20 rad/s (`_DAT_009f281c`) for a player's pet or charm,
 * 30 (`_DAT_00a19cdc`) while UNIT_FLAG_PET_IN_COMBAT is up (0x0071afb0). (A creature whose
 * CreatureMovementInfo row names a SmoothFacingChaseRate springs at that rate instead; this client
 * does not keep the creature's movement id.)
 */
export function unitFacingTurn(object: WorldObjectState): "average" | number {
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
