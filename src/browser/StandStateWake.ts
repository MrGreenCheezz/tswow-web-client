// 6.43: a unit's stand-state pose — asleep, seated, kneeling — gives way while the unit holds a melee target or moves,
// and comes back as soon as neither is true, though the field never changed.
//
// Measured on the Wow.exe stand 15.11 (F:\WowOracle\tools\face6-session.mjs with FACE6_TAG=q2b, series
// runs\face6-q2b-*.bones read by face6-pose.mjs, frames face6-q2b-*-end.png): Onyxia's display with stand state 3 in
// UNIT_FIELD_BYTES_1 and the field left at 3 throughout, as TrinityCore keeps her (creature_template_addon StandState 3):
//
// * in combat (UNIT_FLAG_IN_COMBAT) with UNIT_FIELD_TARGET set she lies (Sleep);
// * SMSG_ATTACK_START and her swing: the attack straight from lying (no SleepUp), then the ready stance, standing;
// * SMSG_ATTACK_STOP and the target cleared: lying again at once — a blend into Sleep, no SleepDown — for 15 s and after;
// * a cast (SMSG_SPELL_START, SMSG_SPELL_GO): the cast clips over the pose, then lying again at once;
// * an emote (SMSG_EMOTE 15, EmoteRoar, which her model has): nothing drawn, she lies on — 0x006cfe70 refuses an emote
//   to a unit whose field says Sleep (game/EmoteRefusal.ts); a melee hit taken drew no wound either, but neither did
//   one on her standing in face6-react-g-hit-awake, so that recording says nothing about the pose;
// * a spline: she walks it, and lies again the moment it ends;
// * the field 3 → 0 (the control): SleepUp, a swing, the ready stance — a change of the field does play its edge.
//
// That is the base chain read 11.11 (.runtime/re-2026-11-11/combat4, anim4/r6.c): the rung 0x0071e0d0 — a melee target
// at +0xa20, written by SMSG_ATTACK_START, cleared by SMSG_ATTACK_STOP (0x00756770) — and the gaits come before the
// stand-state rung 0x0071e1f0, and the base is re-picked when they end. The 06.11 recording ("stands after a swing and
// after a run, the field still 3") had sent SMSG_ATTACK_START with the swing and never an SMSG_ATTACK_STOP: she stood
// on her melee target, not on a wake that outlived it. An ordinary model does the same (F:\WowOracle\tools\face6-wolf.mjs,
// frames runs\face6-wolf2-*.png, a wolf with stand state 3): lying, attacking and standing after SMSG_ATTACK_START and
// its swing, lying again after SMSG_ATTACK_STOP, running on the spline, lying again where the spline ended.
//
// What gives way is the pose alone: the edge clips (SleepDown, SleepUp, SitGroundUp…) belong to a change of the field,
// so a pose that gives way to a melee target or a move, and returns after it, crosses without them (`standWakeEdge`).

import { UNIT_STAND_STATE_DEAD, UNIT_STAND_STATE_STAND } from "../world/CharacterProgressProtocol.js";

/** The stand state the 0x0073F0BF handler leaves out of the rung besides stand and dead. */
const UNIT_STAND_STATE_NO_POSE = 9;

/** What a unit keeps between frames: the field's value last frame, and whether this frame's value differs from it. */
export interface StandWakeState {
  field: number;
  fieldChanged: boolean;
}

/** Where a unit keeps it (RenderedUnit `standWake`), undefined before its first frame. */
export interface StandStateWake {
  standWake: StandWakeState | undefined;
}

/** Whether a stand state is one the rung holds as a pose. */
export function standStateHoldsPose(standState: number): boolean {
  return standState !== UNIT_STAND_STATE_STAND && standState !== UNIT_STAND_STATE_DEAD && standState !== UNIT_STAND_STATE_NO_POSE;
}

/**
 * The stand state the unit is posed with this frame: stand while it holds a melee target (+0xa20) or moves — the
 * rungs above the stand-state pose — and the field's own otherwise. Called once a frame per unit.
 */
export function shownStandState(unit: StandStateWake, standState: number, moving: boolean, meleeTarget = false): number {
  const kept = unit.standWake;
  if (kept === undefined) unit.standWake = { field: standState, fieldChanged: false };
  else {
    kept.fieldChanged = kept.field !== standState;
    kept.field = standState;
  }
  if (!standStateHoldsPose(standState)) return standState;
  return meleeTarget || moving ? UNIT_STAND_STATE_STAND : standState;
}

/**
 * Whether a change of the shown stand state between two frames came from the rungs above the pose, not from the field:
 * such a change crosses without the field's edge clip (no SleepUp on a swing, no SleepDown after SMSG_ATTACK_STOP).
 */
export function standWakeEdge(unit: StandStateWake, previousShown: number | undefined, nextShown: number): boolean {
  return previousShown !== undefined && previousShown !== nextShown && unit.standWake !== undefined && !unit.standWake.fieldChanged;
}
