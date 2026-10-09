// 6.07 (line A7a, slice C): the two `UNIT_FIELD_FLAGS` bits that are poses.
//
// `UNIT_FLAG_STUNNED` 0x00040000 and `UNIT_FLAG_LOOTING` 0x00000400 (`UnitDefines.h:145,153`; the
// core's own comment on the second is "loot animation"). Neither was read by the renderer: a unit
// stunned by a spell without a state kit stood idle, and a player bent over a corpse stood upright.
//
// Both are held entries keyed by an `owner` string and lasting until the flag falls
// (`until: Infinity`). The stun is in the arbiter's strongest layer (`state`), and the layer is the
// point: a hit's CombatWound or a swing cannot take it away, and a pushed unit stays stunned. Looting
// is three clips — Loot as the lead-in, LootHold for as long as the window is open, LootUp once when
// it closes — and the lead-in/follow-up mechanism of spell kits already plays the first two in order.
// Looting is held in the `emote` layer instead (a deviation from the spec's `state`): a `state` hold
// keeps the whole body over a moving base, so a looter who stepped away with the window still open
// would slide bent over the ground; as an emote hold, walking ends it (`unitActionEndsOnMovement`)
// and a flinch or a cast plays over it and hands it back.
//
// The core raises LOOTING only for a creature corpse (`Player::SendLoot`, `Player.cpp:9014-9015`,
// LOOT_CORPSE and not an item) and clears it on release (`LootHandler.cpp:311`), so it is seen on
// every looter, not only on this client's own character.
//
// Work happens on an edge only: the renderer keeps the applied bits on the unit and calls
// `syncFlagPoses` when they differ, so a unit that is neither stunned nor looting pays one AND.

import { ANIMATION_IDS } from "../generated/animations.js";
import { isLocomotionGait, resolveAnimation } from "./AnimatedModel.js";
import type { UnitActionPayload, UnitActionQueue, UnitActionRequest } from "./UnitActionArbiter.js";

export const UNIT_FLAG_LOOTING = 0x00000400;
export const UNIT_FLAG_STUNNED = 0x00040000;
export const FLAG_POSE_MASK = UNIT_FLAG_LOOTING | UNIT_FLAG_STUNNED;
export const FLAG_POSE_STUN = "flag:stun";
export const FLAG_POSE_LOOT = "flag:loot";

/** How long a one-shot may wait for its keyframes; the renderer's `ACTION_SIDECAR_WAIT`. */
const SIDECAR_WAIT = 3_000;
/** How long a missing clip is worth waiting for outside a sidecar fetch; the renderer's `ACTION_CLIP_WAIT`. */
const CLIP_WAIT = 900;

/** The bits that should be on show: none on a corpse, whose queue the renderer clears. */
export function flagPoseBits(flags: number | undefined, terminal: boolean): number {
  return terminal ? 0 : (flags ?? 0) & FLAG_POSE_MASK;
}

function payload(now: number, animation: number, followUp?: number): UnitActionPayload {
  return {
    wanted: [animation], action: undefined, stage: followUp === undefined ? "main" : "lead",
    ...(followUp === undefined ? {} : { followUp: { animation: followUp, mode: "hold" as const } }),
    sequenceAt: 0, waitUntil: now + CLIP_WAIT, sidecarWaitUntil: now + SIDECAR_WAIT, source: "external",
  };
}

function hold(owner: string, layer: "state" | "emote", now: number, animation: number,
  followUp?: number): UnitActionRequest<UnitActionPayload> {
  return { layer, held: true, until: Number.POSITIVE_INFINITY, owner, payload: payload(now, animation, followUp) };
}

/**
 * Applies a change of the flag bits to a unit's action queue.
 *
 * `queue` is the unit's queue if it has one; `submit` creates it when needed. A bit that rises
 * replaces any entry its owner left behind (a unit that left view and came back is a new rendered
 * unit with the old queue); a bit that falls takes its entry away, and LOOTING falling plays LootUp
 * once — unless the unit is now a corpse, where the renderer has already cleared the queue.
 */
export function syncFlagPoses(
  previous: number, next: number, terminal: boolean, now: number,
  queue: UnitActionQueue<UnitActionPayload, unknown> | undefined,
  submit: (request: UnitActionRequest<UnitActionPayload>) => void,
  /**
   * 05.10 review C: the animations the unit's model claims (`SkinnedTemplate.animations`), when
   * known. No playable rig carries LootUp, and its AnimationData fallback is Loot — the way *down*
   * (HumanMale ends 0.56 yd lower than it starts) — so on those rigs getting up is the blend back to
   * the stance, not a second dip.
   */
  claims?: { has(animation: number): boolean },
): void {
  const raised = next & ~previous;
  const fallen = previous & ~next;
  if ((raised | fallen) & UNIT_FLAG_STUNNED) queue?.removeWhere((entry) => entry.owner === FLAG_POSE_STUN);
  if ((raised | fallen) & UNIT_FLAG_LOOTING) queue?.removeWhere((entry) => entry.owner === FLAG_POSE_LOOT);
  const stun = ANIMATION_IDS["Stun"];
  if ((raised & UNIT_FLAG_STUNNED) !== 0 && stun !== undefined) submit(hold(FLAG_POSE_STUN, "state", now, stun));
  const loot = ANIMATION_IDS.Loot;
  const lootHold = ANIMATION_IDS["LootHold"];
  if ((raised & UNIT_FLAG_LOOTING) !== 0) submit(hold(FLAG_POSE_LOOT, "emote", now, loot, lootHold));
  const lootUp = ANIMATION_IDS["LootUp"];
  if ((fallen & UNIT_FLAG_LOOTING) !== 0 && !terminal && lootUp !== undefined && (claims?.has(lootUp) ?? true)) {
    // The emote layer and not `state`: getting up is not held by the server, so a looter who walks
    // off as the window closes is not dragged along in it (a whole-body one-shot gives way).
    submit({ layer: "emote", held: false, until: now + SIDECAR_WAIT, payload: payload(now, lootUp) });
  }
}

/**
 * 05.10 review C: the clip a pose transition (`poseTransition`) plays on this rig, or undefined when
 * there is none worth playing.
 *
 * AnimationData's fallback still answers (KneelEnd → KneelStart, SleepUp → SleepDown), except when
 * it lands on a travelling gait: JumpLandRun falls back to Run, and Run played once is one stride
 * at the authored rate followed by a restart of the very same clip from frame 0 when the base takes
 * over (`#playAnimation` resets an action it is asked to loop) — a pop on every running landing of
 * a rig whose sidecar has not brought JumpLandRun yet. The base's own Run is the honest answer.
 */
export function poseTransitionClip(
  available: ReadonlySet<number> | Map<number, unknown>, transition: number | undefined,
): number | undefined {
  if (transition === undefined) return undefined;
  const clip = resolveAnimation(available, [transition]);
  return isLocomotionGait(clip) ? undefined : clip;
}
