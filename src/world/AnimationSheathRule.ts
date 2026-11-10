/**
 * Plan item 5.05 (11.11): what a unit's sheath does when its model starts an animation — Wow.exe 3.3.5a 12340
 * 0x00738180, which the animation player 0x007385c0 calls at its end with bit 0x20 of its play flags (`keep`).
 * Read-only Ghidra: .runtime/re-2026-10-05/l621/r1.c, re-2026-11-11/combat/l6.lst (the whole body), d5.c, d6.c.
 *
 * The animation it judges is the model's own (0x00717260): the unit's action animation (+0xb84) when the model plays
 * it, else the model's current one. Its AnimationData row (table 0x00ad30e8) gives Weaponflags (+8) and BehaviorID
 * (+0x18). `held` is the sheath setter's state (+0xb5c, SheathSetter.ts). In order, every branch ending the call:
 *   1. Weaponflags 0x4 and not `keep`: sheathe (0).
 *   2. held ranged (2): for a unit that is not the active player, ranged again (no change). Then, unless the
 *      animation is 105/106/112 (LoadBow, LoadRifle, LoadThrown) or its behavior is a ranged one (0x0071d2e0: 0x2e,
 *      0x31, 0x69-0x70), or it has no row: Weaponflags 0x10 sheathes (no `keep` test here), 0x20 draws melee (1).
 *   3. a cast in progress (+0xa60, the spell the unit's cast bar is for; cleared by 0x0072e430 at its end): sheathe
 *      unless the spell's Attributes has 0x40000 (SPELL_ATTR0_DONT_AFFECT_SHEATH_STATE); nothing else either way.
 *   4. attacking (the unit's attack target +0xa20/+0xa24) with a combat behavior (0x0071d590): draw melee.
 *   5. Weaponflags 0x10 and not `keep`: sheathe; Weaponflags 0x20: draw melee.
 *   6. attacking: draw melee.
 *   7. a unit that is not the active player (0x004cee50): its held state follows the server's sheath byte; the
 *      active player keeps its own (then 0x00726090(1), an item-visual flag only).
 * The setter is called with (state, 1, 0): the model changes for every unit, and CMSG_SET_SHEATHED goes out only for
 * the active player and only on a change of the held state (0x00736d30).
 */

/** The ranged behaviors of 0x0071d2e0. */
const RANGED_BEHAVIORS: ReadonlySet<number> = new Set([0x2e, 0x31, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f, 0x70]);
/** The combat behaviors of 0x0071d590. */
const COMBAT_BEHAVIORS: ReadonlySet<number> = new Set([
  10, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x1e, 0x24, 0x39, 0x3a, 0x3b, 0x55, 0x56, 0x57, 0x58, 0x5f,
  0x75, 0x76, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf, 0xb0, 0xb1, 0xb2, 0xb3, 0xd4,
]);
/** LoadBow, LoadRifle, LoadThrown: the ids 0x00738289-0x0073829e skip in the ranged branch. */
const RANGED_LOADS: ReadonlySet<number> = new Set([105, 106, 112]);
/** SPELL_ATTR0_DONT_AFFECT_SHEATH_STATE (SharedDefines.h), the bit 0x00738315 tests. */
export const SPELL_ATTR0_DONT_AFFECT_SHEATH_STATE = 0x40000;

const WEAPON_SHEATHE = 0x4;
const WEAPON_SHEATHE_IDLE = 0x10;
const WEAPON_DRAW_MELEE = 0x20;

export interface AnimationSheathInput {
  /** The animation's AnimationData row: undefined when the table has none for it (or no animation, -1). */
  readonly row: { readonly weaponFlags: number; readonly behavior: number } | undefined;
  readonly animation: number;
  /** Bit 0x20 of 0x007385c0's play flags. */
  readonly keep: boolean;
  /** The setter's held state (0, 1, 2). */
  readonly held: number;
  /**
   * The cast in progress (+0xa60): undefined for none; `attributes0` undefined when the spell's row is not known —
   * 0x004cfd20 finding no row also leaves the sheath alone.
   */
  readonly casting: { readonly attributes0: number | undefined } | undefined;
  readonly attacking: boolean;
  readonly activePlayer: boolean;
  /** The server's sheath byte (UNIT_FIELD_BYTES_2), for branch 7. */
  readonly published: number | undefined;
}

/** 0x00738180: the state it hands the sheath setter, or undefined when it leaves the sheath alone. */
export function animationSheathState(input: AnimationSheathInput): number | undefined {
  const { row, animation } = input;
  const flags = row?.weaponFlags ?? 0;
  if (row !== undefined && (flags & WEAPON_SHEATHE) !== 0 && !input.keep) return 0;
  if (input.held === 2) {
    if (RANGED_LOADS.has(animation) || row === undefined || RANGED_BEHAVIORS.has(row.behavior)) {
      return input.activePlayer ? undefined : 2;
    }
    if ((flags & WEAPON_SHEATHE_IDLE) !== 0) return 0;
    if ((flags & WEAPON_DRAW_MELEE) !== 0) return 1;
    return input.activePlayer ? undefined : 2;
  }
  if (input.casting !== undefined) {
    const attributes = input.casting.attributes0;
    return attributes !== undefined && (attributes & SPELL_ATTR0_DONT_AFFECT_SHEATH_STATE) === 0 ? 0 : undefined;
  }
  if (input.attacking && row !== undefined && COMBAT_BEHAVIORS.has(row.behavior)) return 1;
  if (row !== undefined) {
    if ((flags & WEAPON_SHEATHE_IDLE) !== 0 && !input.keep) return 0;
    if ((flags & WEAPON_DRAW_MELEE) !== 0) return 1;
  }
  if (input.attacking) return 1;
  if (!input.activePlayer && input.published !== undefined && input.published !== input.held) return input.published;
  return undefined;
}
