// Which poses Wow.exe lays over a moving base, and how it chooses a kit's wound pose (6.21, 05.10).
//
// Read from Wow.exe 3.3.5a (12340); notes in .runtime/re-2026-10-05/l621/.
//
// * The animation player (0x7385c0) keeps two tracks per unit: the whole model, and a split track on
//   the subtree of key bone 4 (SpineLow), or key bone 6 (Head) when the model has no SpineLow
//   (0x73e922-0x73e952). Whether a requested pose goes to the split track is 0x723e30: the pose's
//   AnimationData BehaviorID must be in a fixed list (0x71d800, called with the pose in eax at
//   0x723f29) and the base must be moving, turning, swimming or flying (movement flags & 0x2e000ff,
//   0x723f44) — or mounted, which takes its own branch with the same list (0x7385c0, rider path).
//   Bodyflags bit 0x8 plays no part in it. The two places 29.09 took for "bit 0x8 of the current
//   animation" (0x6da1cf, 0x6ddbea) read the SpellShapeshiftForm table (object 0xad49f4, row array
//   0xad4a14) at the shapeshift form byte (UNIT_FIELD_BYTES_2 byte 3, 0x71af70), not AnimationData
//   (object 0xad30c8, row array 0xad30e8).
// * A kit whose AnimID has a wound behaviour (8..10, 0x71d510) is not played as named on a non-state
//   kit: 0x73b140 hands it to the flinch chooser 0x736640, with "critical" only for the raw id 10
//   (0x73b372). The chooser plays CombatCritical for a critical, CombatWound for a unit with a melee
//   target of its own (`+0xa20`, written by SMSG_ATTACK_START), StandWound otherwise.

import { ANIMATION_IDS, ANIMATION_NAMES } from "../../generated/animations.js";

/** AnimationData BehaviorIDs Wow.exe 0x71d800 lets onto the split track. 110 of them. */
export const WOW_SPLIT_BEHAVIORS: ReadonlySet<number> = new Set([
  2, 8, 9, 10, 14, 15,
  ...span(16, 36), ...span(46, 49), ...span(51, 74), 76, 77, 78, ...span(80, 90),
  ...span(105, 113), 117, 118, ...span(122, 125), 128, 129, 130, 133, 134, 136, 137, 138,
  ...span(153, 156), 185, 186, 195, ...span(213, 222), 225,
]);

function span(from: number, to: number): number[] {
  const out: number[] = [];
  for (let id = from; id <= to; id++) out.push(id);
  return out;
}

/** Stock AnimationData ids of the three wound poses (0x736640 uses the literals 8, 9, 10). */
const STAND_WOUND = 8;
const COMBAT_WOUND = 9;
const COMBAT_CRITICAL = 10;

type Names = Readonly<Record<number, string>>;
type Ids = Readonly<Record<string, number | undefined>>;

/**
 * AnimationData.BehaviorID of an animation. On this build every row whose BehaviorID differs from its
 * id is the Fly twin of a ground row ("FlyX" → "X", 277 of 506 rows, measured), so the twin is found
 * by name; without names the id is its own behaviour.
 */
export function animationBehavior(animation: number, names: Names = ANIMATION_NAMES, ids: Ids = ANIMATION_IDS): number {
  const name = names[animation];
  if (name === undefined || !name.startsWith("Fly")) return animation;
  return ids[name.slice(3)] ?? animation;
}

const splitCache = new WeakMap<Names, Map<number, boolean>>();

/**
 * Whether Wow.exe puts this pose on the split (upper-body) track over a moving base. Answered once
 * per animation id and kept, so the per-frame call allocates nothing.
 */
export function animationSplitsOverBase(animation: number, names: Names = ANIMATION_NAMES, ids: Ids = ANIMATION_IDS): boolean {
  let byId = splitCache.get(names);
  if (byId === undefined) {
    byId = new Map();
    splitCache.set(names, byId);
  }
  let split = byId.get(animation);
  if (split === undefined) {
    split = WOW_SPLIT_BEHAVIORS.has(animationBehavior(animation, names, ids));
    byId.set(animation, split);
  }
  return split;
}

/** A kit AnimID that Wow.exe routes through the flinch chooser (BehaviorID 8..10, 0x71d510). */
export function kitWoundBehavior(animation: number, names: Names = ANIMATION_NAMES, ids: Ids = ANIMATION_IDS): boolean {
  const behavior = animationBehavior(animation, names, ids);
  return behavior >= STAND_WOUND && behavior <= COMBAT_CRITICAL;
}

/** The wound 0x736640 plays for a kit AnimID: critical only for the raw id 10. */
export function kitWoundAnimation(animation: number, hasMeleeTarget: boolean): number {
  if (animation === COMBAT_CRITICAL) return COMBAT_CRITICAL;
  return hasMeleeTarget ? COMBAT_WOUND : STAND_WOUND;
}
