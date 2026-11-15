// 15.11 (6.12): where a spell's missile leaves a caster whose SpellVisual names neither a MissileAttachment nor a
// MissileCastOffset. Wow.exe 3.3.5a 12340 (Ghidra read-only; .runtime/re-2026-10-03/l1102e/r5.c,
// .runtime/re-2026-10-11/glue-1110/1013-m1.txt, m10.txt; .runtime/re-2026-11-15/fx5/r1/refs.txt):
//
// - A unit's pending missiles are launched by 0x0072df00 with a handed point. 0x0072df00 prefers the visual's own point
//   (0x00720bf0); that answers nothing when MissileAttachment is −1 and MissileCastOffset is (0, 0, 0), and the missile
//   then leaves from the handed one. The handed point is 0x0071a720's on every path (0x0072e240 — SPELL_GO 0x0080e1b0
//   for a visual whose CastKit plays no animation, AnimID < 1 —, the launcher 0x00732ff0 for SpellVisual.Flags & 4,
//   0x00733820, 0x00733e20, and the unit update 0x00734390 two seconds after the cast or with no animation playing)
//   except one: when the cast animation's own event fired, 0x00734390 hands the point that event stored at unit +0xaf0
//   (flag +0xa30 0x80000000). Which event ids store it was not read, so only the GO case is taken here (SpellVisuals.ts).
// - 0x0071a720, on the unit's loaded model: the model's "$CSL" event (0x4c534324), else "$CSR", else "$CST", placed on
//   its bone as posed now (0x008275f0 finds it, 0x008317e0 places it). Without any of them, a passenger (+0xf60) asks
//   0x007446c0 and any other unit its vfunc +0x2c.
// - 15.11, read (.runtime/re-2026-11-15/fx7/r2, r3): vfunc +0x2c is 0x006e6ef0 in both unit vtables (0x00a34d90,
//   0x00a326c8) and copies the unit's position from its movement block (+0xd8, +0x10): the feet. So a model whose
//   events are known and hold none of the three launches from the unit's position (`missileLaunchSource`); 322 of the
//   1,432 models CreatureModelData names are such (mostly townsfolk and guards; `.runtime/re-2026-11-15/fx7/
//   cs-event-census.txt`). Until a model's events are in, the caller keeps its stand-in. 0x007446c0 (a passenger) is
//   still unread: a passenger without the events is placed the same way here.
// - 15.11, read: the cast animation's own event is the unit's model-event callback 0x00732650 (registered by 0x0073e410
//   through 0x00734a40): "$CSL", "$CSR" and "$CST" each store their own position at +0xaf0 while missiles are queued,
//   and "$BWR" stores the position of attachment 35 or 36 (else its own); the next update 0x00734390 launches from
//   it. Queued missiles that no event takes leave from 0x0071a720's point 2 s after they were built, or at once when
//   the unit plays no animation. SpellVisual.Flags & 4 launches them as they are built (0x00732ff0).
//
// The events come from the gateway's `/visual/model-events` (VehicleMuzzle.ts `ModelShotEvents`), once per model; until
// the answer is in, the stand-in is used as well.

import * as THREE from "three";
import type { ModelShotEvent } from "./VehicleMuzzle.js";

/** 0x0071a720's reading order (no "$AIM": that is 0x006fcd60's, the steered shot). */
const ORDER = ["$CSL", "$CSR", "$CST"] as const;

/** The event a spell's missile leaves from when the visual names no point, or undefined. */
export function missileLaunchEvent(events: readonly ModelShotEvent[]): ModelShotEvent | undefined {
  for (const id of ORDER) {
    const event = events.find((candidate) => candidate.id === id);
    if (event !== undefined) return event;
  }
  return undefined;
}

/**
 * 15.11 (6.12): what 0x0071a720 launches from for a model whose events are `events`: the first of its "$CSL"/"$CSR"/
 * "$CST", "position" (the unit's own, vfunc +0x2c = 0x006e6ef0) when it has none, undefined while they are unknown.
 */
export function missileLaunchSource(events: readonly ModelShotEvent[] | undefined): ModelShotEvent | "position" | undefined {
  if (events === undefined) return undefined;
  return missileLaunchEvent(events) ?? "position";
}

const _at = new THREE.Vector3();

/**
 * The event on its bone as posed now (0x008317e0), in server coordinates; false when the bone is missing. `pivots` are
 * the model's bone pivots (x, y, z per bone): the event's position is in model space, the bone's frame at its pivot.
 */
export function placeLaunchEvent(event: ModelShotEvent, bones: readonly THREE.Bone[], pivots: ArrayLike<number>,
  out: { x: number; y: number; z: number }): boolean {
  const bone = bones[event.bone];
  if (bone === undefined) return false;
  bone.updateWorldMatrix(true, false);
  _at.set(event.x - (pivots[event.bone * 3] ?? 0), event.y - (pivots[event.bone * 3 + 1] ?? 0),
    event.z - (pivots[event.bone * 3 + 2] ?? 0));
  bone.localToWorld(_at);
  out.x = _at.x;
  out.y = -_at.z;
  out.z = _at.y;
  return true;
}
