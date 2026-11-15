// 6.06 (15.11, combat11): a melee swing keeps its own clock while its attacker is off screen.
//
// Recorded on the Oracle stand (Wow.exe 3.3.5a 12340, `F:\WowOracle\runs\combat11-e2-attacker-offscreen`): a wolf behind
// the camera — none of its draws in the frames — swings at an orc in view (SMSG_ATTACK_START, SMSG_ATTACKERSTATEUPDATE).
// The orc's StandWound starts about 0.36 s after the swing packet: the wolf's AttackUnarmed $CAH key (334 / 400 ms,
// `Creature\Wolf\Wolf.m2`), the same moment a swing in view gives (`combat11-e5-awake-hit`, a horse in view: its $CAH at
// 533 ms, the wound 0.53 s after the packet). So the attacker's model runs its swing and fires its events whether or not it
// is drawn; the 11.11 note "a model off screen is not animated" does not hold for this.
//
// This renderer freezes an off-screen unit's mixer, so a swing's clip — whose time is the victim's cue clock
// (SwingProgressWatch.ts, `#meleeSwingProgress`) — stood still until the attacker came back into view, and the victim's
// parry or wound waited with it. Here only that one action's time moves on, by the frame's elapsed time; nothing is posed.

/** The part of a mixer action the clock moves (THREE.AnimationAction). */
export interface SwingClockAction {
  time: number;
  readonly timeScale: number;
  getClip(): { readonly duration: number };
}

/** The renderer's record of what a unit's queue shows (UnitActionArbiter.ts `ShownUnitAction`). */
export interface SwingClockShown {
  readonly entry: { readonly layer: string };
  readonly action: SwingClockAction;
}

/** Moves an off-screen unit's melee swing on by `elapsed` seconds, up to its clip's end; anything else is left alone. */
export function advanceOffscreenSwing(shown: SwingClockShown | undefined, elapsed: number): void {
  if (shown === undefined || shown.entry.layer !== "melee" || !(elapsed > 0)) return;
  const action = shown.action;
  const duration = action.getClip().duration;
  if (!(duration > 0) || action.time >= duration) return;
  const scale = Number.isFinite(action.timeScale) && action.timeScale > 0 ? action.timeScale : 1;
  action.time = Math.min(duration, action.time + elapsed * scale);
}
