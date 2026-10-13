// 13.10 (6.12, 6.13): what a SpellVisual row's missile columns mean, as Wow.exe 3.3.5a 12340 reads them
// (Ghidra read-only, .runtime/re-2026-10-11/glue-1110/1013-m1.txt … m8.txt; constants read from the PE).
//
// - MissileDestinationAttachment is not an attachment id. The missile launcher 0x00732ff0 and the beam end
//   0x007fabf0 both look it up in the 16-entry table 0x00adaa20 — unless SpellVisual.Flags has 0x200, when
//   the column is the attachment id itself. On this dataset 1,376 missile rows say 1 (chest), 97 say 0
//   (head), 340 say 2 (the ground under the feet); the one row with Flags 0x200 (14149) says 19.
// - MissileImpactOffset (and MissileCastOffset, 0x007fc5f0) are read with y negated: (x, −y, z). The point is
//   the attachment's, moved by the offset in the attachment's frame (0x0071a860, 0x004c21b0 over 0x00831410);
//   without the attachment (no model yet, the model has none) it is the unit's position raised by
//   0.75 · height · scale (0x009e9ee4 = 0.75), the offset turned by the unit's model matrix (0x006ff6d0).
// - MissileFollowGround{Height, DropSpeed, Approach} are thousandths (0x009e1134 = 0.001): the height at least
//   0.25 yards (0x009e8ce4), the drop speed at least 0.01 (0x009f1968), the approach clamped to [0, 1]. Flags
//   bit 1 (2) turns the ground-following flight on (Missile_C +0x68 |= 0x7800, 0x00732ff0); the other bits
//   are read by the flight (MissileFlight.ts).

/** 0x00adaa20: MissileDestinationAttachment index → M2 attachment id. */
export const MISSILE_DESTINATION_ATTACHMENTS: readonly number[] = Object.freeze(
  [20, 34, 19, 21, 22, 17, 23, 24, 25, 15, 16, 37, 38, 22, 47, 48],
);

/** The chest (0x22): where 0x007fabf0 aims without a spell record. */
export const ATTACH_CHEST = 34;

/** 0x00a32f74: the gravity of a trajectory spell without a SpellMissile row (Missile_C +0x140, 0x00700880). */
export const MISSILE_DEFAULT_GRAVITY = 19.291105270385742;

/** 0x009e9ee4: the attachment-less aim point's share of the unit's height. */
export const AIM_HEIGHT_FRACTION = 0.75;

/**
 * The attachment a SpellVisual's MissileDestinationAttachment names. A raw row (Flags 0x200) names it
 * directly; an index past the table — which Wow.exe would read past its end — is taken as raw, the one
 * reading that is not out of bounds (the only such row on this dataset is the raw one).
 */
export function missileDestinationAttachment(dest: number | undefined, raw = false): number {
  if (dest === undefined || !Number.isInteger(dest)) return ATTACH_CHEST;
  if (raw) return dest;
  return dest >= 0 && dest < MISSILE_DESTINATION_ATTACHMENTS.length ? MISSILE_DESTINATION_ATTACHMENTS[dest]! : dest;
}

/** A SpellVisual offset as Wow.exe reads it: (x, −y, z); undefined when there is none. */
export function visualOffset(stored: readonly number[] | undefined): readonly [number, number, number] | undefined {
  if (!stored || stored.length !== 3) return undefined;
  const [x, y, z] = stored as [number, number, number];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || (x === 0 && y === 0 && z === 0)) return undefined;
  return [x, -y, z];
}

/** MissileFollowGround, as Missile_C +0x100…+0x10c holds it. */
export interface MissileFollowGround {
  /** Yards kept above the ground (≥ 0.25). */
  readonly height: number;
  /** Share of the gap to the ground closed per yard of travel (≥ 0.01). */
  readonly dropSpeed: number;
  /** Horizontal progress after which the flight bends onto its aim point, 0…1. */
  readonly approach: number;
  readonly flags: number;
}

/** Flags bit 1: the missile follows the ground (0x00732ff0 sets Missile_C +0x68 |= 0x7800). */
export const FOLLOW_GROUND_ON = 0x2;
/** Flags bit 2: the approach bends onto the point two steps ahead instead of the target (0x006fffc0). */
export const FOLLOW_GROUND_APPROACH_AHEAD = 0x4;
/** Flags bits 0 and 3 together: the aim point's height is the target's feet + Height (0x006ff6d0). */
export const FOLLOW_GROUND_AIM_AT_HEIGHT = 0x9;

/** The gateway's raw thousandths → the flight's values (0x00732ff0). */
export function followGroundOf(raw: { height: number; dropSpeed: number; approach: number; flags: number } | undefined):
  MissileFollowGround | undefined {
  if (!raw) return undefined;
  const approach = raw.approach * 0.001;
  return {
    height: Math.max(raw.height * 0.001, 0.25),
    dropSpeed: Math.max(raw.dropSpeed * 0.001, 0.01),
    approach: approach < 0 ? 0 : approach < 1 ? approach : 1,
    flags: raw.flags | 0,
  };
}
