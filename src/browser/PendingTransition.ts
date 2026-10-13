// 12.10 6.07: a pose transition whose clip is still on the way waits for it, briefly.
//
// The one-shots between poses — KneelStart, SleepDown, SitGroundDown, JumpStart — are not among the 21 clips that
// travel inside a model; they come with its animation sidecar, which is fetched the first time anything asks for one.
// `poseTransition` fires on the edge only (the frame the stand state or the airborne bit changes), so a kneel begun
// before the sidecar arrived played no KneelStart at all, and nothing asked for it either. Wow.exe has every
// sequence at hand and always plays it (0x0071e1f0: 0x72 KneelStart from standing, 0x73 KneelLoop after it).
//
// Here the edge is remembered while the model claims the clip and the sidecar is on its way, for as long as the unit
// holds the pose it was entering — same stand state, same moving or still — and up to `TRANSITION_SIDECAR_WAIT`; the
// clip plays the moment it is built. The kneeling base itself (KneelLoop) is in the same sidecar, so until then the
// unit stands, and the two arrive together: down, then held.
//
// Pure; one small record per unit while a transition waits, nothing otherwise.

/** How long an edge waits for its clip: a sidecar fetch, as the action queue's first wait (`ACTION_CLIP_WAIT` …). */
export const TRANSITION_SIDECAR_WAIT = 1_500;

export interface PendingTransition {
  readonly animation: number;
  readonly until: number;
  readonly standState: number;
  readonly moving: boolean;
}

export interface TransitionChoice {
  /** The transition to play now, or undefined. */
  readonly play: number | undefined;
  /** What still waits for its clip. */
  readonly pending: PendingTransition | undefined;
}

/**
 * This frame's transition. `edge` is `poseTransition`'s answer; `playable` whether this rig can play a transition
 * now (`poseTransitionClip` resolves it); `claimed` whether the model claims it but has not built it yet.
 */
export function settleTransition(edge: number | undefined, pending: PendingTransition | undefined,
  pose: { readonly standState: number; readonly moving: boolean }, now: number,
  playable: (animation: number) => boolean, claimed: (animation: number) => boolean): TransitionChoice {
  if (edge !== undefined) {
    if (playable(edge)) return { play: edge, pending: undefined };
    return claimed(edge)
      ? { play: undefined, pending: { animation: edge, until: now + TRANSITION_SIDECAR_WAIT, standState: pose.standState, moving: pose.moving } }
      : { play: undefined, pending: undefined };
  }
  if (pending === undefined || now >= pending.until
    || pending.standState !== pose.standState || pending.moving !== pose.moving) return { play: undefined, pending: undefined };
  return playable(pending.animation) ? { play: pending.animation, pending: undefined } : { play: undefined, pending };
}
