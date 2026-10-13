// 12.10 6.03/6.07: how Wow.exe 3.3.5a 12340 plays an animation a model does not have.
//
// Every sequence a unit, a bone or a doodad asks for goes through 0x00826350 before it plays (called by
// `CM2Model::SetBoneSequence` 0x00832ab0 and the model's other setters, 0x00832ea0, 0x00834540, 0x00831fc0,
// 0x00827190, 0x0082ced0): a missing id walks AnimationData.Fallback (+0x14) until the model has one, and each
// row it leaves behind adds to a playback mode through that row's Flags (+0x10):
//
//   direction = +1, offset = 0
//   Flags & 0x10 → offset += direction; direction = −direction      (the fallback plays backwards)
//   Flags & 0x20 → offset += direction; direction = 0               (the fallback holds still)
//
// and the result is the sequence with a mode in its high word: direction > 0 forwards (0), < 0 backwards
// (1), 0 holding on its first frame (2) when the offset is not above zero, on its last (3) otherwise.
// 0x00826b00 applies it: modes 1 and 3 negate the speed and start the clip at its end, modes 2 and 3
// then set the speed to 0 — so a hold is the frame itself, at once, not a clip played through to it.
//
// What the table makes of it (this build's AnimationData, the rows with either bit): LootHold → Loot held
// on its last frame (down at the corpse) and LootUp → Loot played backwards (getting up) on every playable
// rig, none of which carries 188 or 189; Dead → Death held; KneelLoop → KneelStart held and KneelEnd →
// KneelStart backwards, SitGround/Sleep → their Down clip held and SitGroundUp/SleepUp → it backwards,
// Walkbackwards → Walk backwards, SwimBackwards → Swim backwards, Drowned → Drown held, DeathEndHold →
// DeathEnd held; the doors' Closed/Opened/Destroyed and Open/Close/Rebuild likewise.
//
// Pure apart from `applyPlayback`, which sets a mixer action up for a mode. Per-frame cost: a short walk
// of the fallback chain (≤ 8 hops) per resolved request; no allocation.

import * as THREE from "three";
import { ANIMATION_FALLBACK, ANIMATION_PLAYBACK_FLAGS } from "../generated/animations.js";

export const PLAYBACK_FORWARD = 0;
export const PLAYBACK_BACKWARD = 1;
export const PLAYBACK_HOLD_FIRST = 2;
export const PLAYBACK_HOLD_LAST = 3;
export type PlaybackMode = 0 | 1 | 2 | 3;

/** AnimationData.Flags bits 0x00826350 reads. */
const FLAG_BACKWARD = 0x10;
const FLAG_HOLD = 0x20;
/** The walk's bound, as `resolveAnimation`'s. */
const MAX_HOPS = 8;

/**
 * The mode `resolved` plays in when `requested` was asked for: the rows walked from `requested` down the
 * fallback chain to `resolved`, each adding its Flags as 0x00826350 does. Forwards when they are the same
 * id or when `resolved` is not on the chain (a later rung of a wanted list, not a fallback).
 */
export function fallbackPlayback(requested: number, resolved: number,
  flags: Readonly<Record<number, number>> = ANIMATION_PLAYBACK_FLAGS,
  fallback: Readonly<Record<number, number>> = ANIMATION_FALLBACK): PlaybackMode {
  if (requested === resolved) return PLAYBACK_FORWARD;
  let direction = 1;
  let offset = 0;
  let id: number | undefined = requested;
  for (let hop = 0; id !== undefined && id !== resolved; hop++) {
    if (hop >= MAX_HOPS) return PLAYBACK_FORWARD;
    const bits = flags[id] ?? 0;
    if ((bits & FLAG_BACKWARD) !== 0) {
      offset += direction;
      direction = -direction;
    }
    if ((bits & FLAG_HOLD) !== 0) {
      offset += direction;
      direction = 0;
    }
    id = fallback[id];
  }
  if (id !== resolved) return PLAYBACK_FORWARD;
  if (direction > 0) return PLAYBACK_FORWARD;
  if (direction < 0) return PLAYBACK_BACKWARD;
  return offset > 0 ? PLAYBACK_HOLD_LAST : PLAYBACK_HOLD_FIRST;
}

/**
 * The mode for a wanted list that `resolveAnimation` answered with `resolved`: the first rung whose chain
 * reaches it, as the resolver walked them.
 */
export function wantedPlayback(wanted: Iterable<number>, resolved: number | undefined): PlaybackMode {
  if (resolved === undefined) return PLAYBACK_FORWARD;
  for (const start of wanted) {
    let id: number | undefined = start;
    for (let hop = 0; id !== undefined && hop < MAX_HOPS; hop++) {
      if (id === resolved) return fallbackPlayback(start, resolved);
      id = ANIMATION_FALLBACK[id];
    }
  }
  return PLAYBACK_FORWARD;
}

/** Whether a mode holds a frame instead of playing (0x00826b00: speed 0). */
export function playbackHolds(mode: PlaybackMode): boolean {
  return mode === PLAYBACK_HOLD_FIRST || mode === PLAYBACK_HOLD_LAST;
}

/**
 * Sets an action that has just been (re)started up for `mode`, as 0x00826b00 sets a track: backwards from
 * the clip's end, or held on its first or last frame. `loop` is how the caller wants a playing clip to end;
 * a held one is a clamped `LoopOnce` whatever it is, so the mixer keeps the frame instead of wrapping it.
 * Forwards leaves the action exactly as the caller set it.
 */
export function applyPlayback(action: THREE.AnimationAction, mode: PlaybackMode, loop: boolean): void {
  if (mode === PLAYBACK_FORWARD) return;
  const duration = action.getClip().duration;
  if (mode === PLAYBACK_BACKWARD) {
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    action.timeScale = -Math.abs(action.timeScale === 0 ? 1 : action.timeScale);
    action.time = duration;
    return;
  }
  action.setLoop(THREE.LoopOnce, Infinity);
  action.clampWhenFinished = true;
  action.timeScale = 0;
  action.time = mode === PLAYBACK_HOLD_LAST ? duration : 0;
}
