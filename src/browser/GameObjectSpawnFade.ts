// 15.11 (6.11; fade9): a new game object fades in as Wow.exe 3.3.5a 12340 fades it (Ghidra read-only,
// .runtime/re-2026-11-15/fade9/r1–r9):
//
// - PostInitObject 0x004d63b0 sends a game object to its creation 0x00712f30, which calls the same 0x00744a50 a unit's
//   creation does: the model-alpha byte (+0xc8, left 0 by the object constructor 0x00745e60, which the game object's
//   constructor 0x00714250 runs first) walks to vfunc +0xe8's alpha over 1000 ms when vfunc +0xe4 answers true, else it
//   is set at once; the walk is the generic 0x00743e10 (the game object vtable 0xa34640's slot +0x84), whole bytes
//   linearly, as 0x0071ac30 walks a unit's.
// - The game object's +0xe4 (0x0070b9e0) and +0xe8 (0x0070b9a0) ask its type behaviour (+0x1a0, made by 0x00714250 from
//   the type byte, GAMEOBJECT_BYTES_1 byte 1): slot +0x8 and slot +0x3c.
//   - Every behaviour answers alpha 1.0 (0x004d5ff0), except DUNGEON_DIFFICULTY (type 31, vtable 0xa34420, 0x0070dd50):
//     1.0 when GAMEOBJECT_DYNAMIC has 0x2 (GO_DYNFLAG_LO_ANIMATE), else 0.5 (0x009e2ec4).
//   - The fade question: the common behaviours (0x007124b0's family: doors, buttons, quest givers, chests, generic, traps,
//     spell focuses, texts, goobers, area damage, duel flags, fishing, rituals, mailboxes, guard posts, spell casters,
//     meeting stones, flag stands, capture points, aura generators, guild banks, …) answer 0x00712510: "the current
//     animation kind is not Spawn (0)" — and at creation the kind is the state's (0x0070d600, Closed/Opened/Destroyed…),
//     so they fade; binder, chair, transports, camera, map object, barber chair, destructible building, trapdoor and
//     unknown types answer 0x008a1420, always.
// - So every game object fades in over 1 s to its alpha. The one way it is shown at once: created with the spawn flag
//   (0x00712f30's fourth argument, from PostInitObject) and its model has the Spawn animation (0x0070c370 → 0x0070c480,
//   which plays it and sets the alpha with time 0). This client neither tracks that flag nor plays Spawn; not ported.
// - A state change (0x0070d690 → 0x0070d510) sets an animation kind and never the alpha; a second CREATE of a live object
//   (flag 0x40000 at +0xbc, set by 0x00744a50) only applies values (0x004d5550): neither fades again. The re-setup
//   0x007130a0 → 0x00744d20 zeroes the byte for an object set up anew, as a unit's.
//
// The clock starts on the first frame the object can be drawn (`RenderedGameObject.admittedAt`), as the unit's does
// (UnitSpawnFade.ts): Wow.exe reads the model locally at creation, here it streams.

import { readByte, readField } from "../world/Fields.js";
import type { WorldObjectState } from "../world/WorldState.js";

/** 0x00744a50: the fade-in's time. */
export const GAMEOBJECT_SPAWN_FADE_MS = 1000;
/** SharedDefines.h GAMEOBJECT_TYPE_DUNGEON_DIFFICULTY. */
export const GAMEOBJECT_TYPE_DUNGEON_DIFFICULTY = 31;
/** SharedDefines.h GO_DYNFLAG_LO_ANIMATE. */
const GO_DYNFLAG_LO_ANIMATE = 0x2;

/** vfunc +0xe8 of a game object (0x0070b9a0 → its behaviour's +0x3c): the alpha it fades in to. */
export function gameObjectModelAlpha(type: number | undefined, dynamic: number | undefined): number {
  if (type !== GAMEOBJECT_TYPE_DUNGEON_DIFFICULTY) return 1;
  return ((dynamic ?? 0) & GO_DYNFLAG_LO_ANIMATE) !== 0 ? 1 : 0.5;
}

/** {@link gameObjectModelAlpha} read off the wire: the type byte (GAMEOBJECT_BYTES_1 byte 1) and GAMEOBJECT_DYNAMIC. */
export function gameObjectModelAlphaOf(object: WorldObjectState): number {
  return gameObjectModelAlpha(readByte(object, "GAMEOBJECT_BYTES_1", 1), readField(object, "GAMEOBJECT_DYNAMIC"));
}

/**
 * The game object's model alpha now, `elapsed` ms after its clock started: the byte walked from 0 to round(α·255) over
 * 1000 ms in whole bytes (trunc(T·t/1000)/255), then held at T/255. Before the clock starts: 1 (nothing to fade yet).
 */
export function gameObjectSpawnAlpha(admittedAt: number | undefined, now: number, alpha = 1): number {
  const target = Math.max(0, Math.min(255, Math.round(alpha * 255)));
  if (admittedAt === undefined || !Number.isFinite(admittedAt) || !Number.isFinite(now)) return target / 255;
  const elapsed = Math.floor(now - admittedAt);
  if (elapsed >= GAMEOBJECT_SPAWN_FADE_MS) return target / 255;
  if (elapsed <= 0) return 0;
  return Math.trunc((target * elapsed) / GAMEOBJECT_SPAWN_FADE_MS) / 255;
}
