import { airborneChanged, isUnitMoving, type UnitPose } from "./AnimatedModel.js";

/**
 * Whether a unit's pose transition (JumpLandRun, KneelStart…) gives way this frame.
 *
 * 12.10 6.07: the moment the unit starts or stops moving — Wow.exe re-picks the base on a movement change
 * (0x0073ee14: +0x44 & 0xc0100f → 0x0073ac30) — instead of holding the unit to the clip's end (833 ms of JumpLandRun
 * slid along under a unit that had stopped). 03.11 (6.35): and when the unit leaves or reaches the ground
 * (`airborneChanged`). `transitionMoving` is whether the unit moved when the transition began; undefined while none
 * runs. 13.09: out of the renderer's `#animateUnit`.
 */
export function poseTransitionGivesWay(
  transitionMoving: boolean | undefined,
  before: UnitPose | undefined,
  pose: UnitPose,
): boolean {
  return transitionMoving !== undefined
    && (transitionMoving !== isUnitMoving(pose.movementFlags, pose.spline) || airborneChanged(before, pose));
}
