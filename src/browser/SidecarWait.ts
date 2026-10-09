// 6.19 (line A7a, slice G2, 05.10): how long a pose may wait for its rig's sidecar.
//
// A character model carries its base clips (21 on HumanMale); every emote, cast flourish and most
// stances are in a second artifact, the sidecar (HumanMale 9,833,124 bytes, 182 clips). A pose that
// arrives before it gets `ACTION_SIDECAR_WAIT` (3 s) — and the queue entry expired at that mark
// whether or not the download was still running: a remote player's first /dance or first cast on a
// cold cache (508 ms just to publish the artifact, then the transfer behind two lanes and the model
// downloads) was lost.
//
// `extendSidecarWait` is called by the renderer for an entry that is waiting for its clip. While the
// rig's sidecar is really queued or on the wire (`EnvironmentClient.animationsInFlight`), it pushes
// the entry's deadlines `SIDECAR_WAIT_MARGIN` ahead of now, never past `ACTION_SIDECAR_LIMIT` after
// the request — so a stall still ends, and a pose with nothing coming still goes at 3 s as before.
// A one-shot moves both its queue deadline (`until`) and its keyframe deadline; a hold (a cast, an
// aura state, a flag stun) keeps its authored end and only waits longer for its keyframes; a shot is
// never extended (`pendingActionExpired` retires a stale shot at its own window, deliberately).
//
// `poseExitClips` is the other half: the one-shot that ends a pose (KneelEnd, SleepUp, SitGroundUp,
// JumpLandRun/JumpEnd) is asked for while the unit is still in the pose. `needsSidecarAnimations`
// never asked for them because AnimationData's fallback resolves each against the base set
// (JumpLandRun → Run), so the transition was drawn only if the background prefetch happened to have
// compiled it. `sidecarClaims` is the exact test those ids need.
//
// Per-frame cost: `extendSidecarWait` runs only for an entry already waiting for a clip (a compare
// and up to three writes); `poseExitClips` returns shared constant arrays — nothing allocated.

import { ANIMATION_IDS } from "../generated/animations.js";
import { MOVEMENT_FLAGS } from "../world/MovementProtocol.js";
import {
  UNIT_STAND_STATE_KNEEL, UNIT_STAND_STATE_SIT, UNIT_STAND_STATE_SLEEP,
} from "../world/CharacterProgressProtocol.js";
import type { UnitActionEntry, UnitActionPayload } from "./UnitActionArbiter.js";

/** The renderer's `ACTION_SIDECAR_WAIT`: the window every request starts with. */
const SIDECAR_WAIT = 3_000;
/** The outer bound after the request: a gesture eight seconds late is the last one worth playing. */
export const ACTION_SIDECAR_LIMIT = 8_000;
/** How far ahead of now an in-flight wait is pushed each time it is looked at. */
export const SIDECAR_WAIT_MARGIN = 1_000;

/** The limit is remembered per payload, from the deadline the request was made with. */
const limits = new WeakMap<UnitActionPayload, number>();

/** Pushes an unstarted entry's deadlines while its sidecar is in flight; true when it did. */
export function extendSidecarWait(entry: Pick<UnitActionEntry<UnitActionPayload>, "held" | "until" | "started" | "payload">,
  now: number, inFlight: boolean): boolean {
  const pending = entry.payload;
  if (entry.started || !inFlight || pending.action === "shoot") return false;
  let limit = limits.get(pending);
  if (limit === undefined) {
    limit = pending.sidecarWaitUntil - SIDECAR_WAIT + ACTION_SIDECAR_LIMIT;
    limits.set(pending, limit);
  }
  let next = Math.min(limit, now + SIDECAR_WAIT_MARGIN);
  // A hold's own end bounds its keyframe wait, so its `until` is never moved below.
  if (entry.held) next = Math.min(next, entry.until);
  if (next > pending.sidecarWaitUntil) pending.sidecarWaitUntil = next;
  if (next > entry.until) entry.until = next;
  return true;
}

const NONE: readonly number[] = [];
const ids = (...names: string[]): readonly number[] =>
  names.map((name) => ANIMATION_IDS[name]).filter((id): id is number => typeof id === "number");
const KNEEL_EXIT = ids("KneelEnd");
const SLEEP_EXIT = ids("SleepUp");
const SIT_EXIT = ids("SitGroundUp");
const LANDING = ids("JumpLandRun", "JumpEnd");

/** The one-shots that can end the pose the unit is in now (`poseTransition`'s exits). */
export function poseExitClips(pose: { readonly dead: boolean; readonly movementFlags: number; readonly standState: number }): readonly number[] {
  if (pose.dead) return NONE;
  if ((pose.movementFlags & (MOVEMENT_FLAGS.falling | MOVEMENT_FLAGS.fallingFar)) !== 0) return LANDING;
  switch (pose.standState) {
    case UNIT_STAND_STATE_KNEEL: return KNEEL_EXIT;
    case UNIT_STAND_STATE_SLEEP: return SLEEP_EXIT;
    case UNIT_STAND_STATE_SIT: return SIT_EXIT;
    default: return NONE;
  }
}

/** Whether the rig claims one of these exact ids, has not built it, and has not fetched its sidecar yet. */
export function sidecarClaims(template: { readonly clips: { has(id: number): boolean };
  readonly animations: { has(id: number): boolean }; readonly merged?: boolean | undefined }, wanted: readonly number[]): boolean {
  if (template.merged === true) return false;
  for (const id of wanted) if (template.animations.has(id) && !template.clips.has(id)) return true;
  return false;
}
