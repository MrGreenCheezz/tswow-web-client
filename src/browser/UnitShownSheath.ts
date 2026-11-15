/**
 * 5.05 (15.11): the sheath a unit that is not the active player shows — Wow.exe 3.3.5a 12340 runs the same animation
 * sheath rule for every unit (world/AnimationSheathRule.ts). Read-only Ghidra: .runtime/re-2026-11-11/combat/d5.c,
 * l6.lst, refs3.txt, refs4.txt.
 *
 * Who runs it. 0x00738180 has one caller, the end of 0x007385c0 (0x00739585), and 0x007385c0 is CGUnit's animation
 * player: locomotion 0x0073b510, the kit player 0x0073b140, stand states 0x0073f060, emotes, swings and reactions all
 * play through it, with no test of who the unit is before the call. The only places that tell the active player apart
 * are inside 0x00738180 itself: the ranged branch compares the unit's guid with the active player's (0x004d3790) and
 * the last branch asks 0x004cee50. So a creature or another player starting an animation is judged by the same rows
 * (AnimationData Weaponflags/BehaviorID), the same `keep` bit of a spell kit, its own cast bar (+0xa60, set by
 * SMSG_SPELL_START for any caster and cleared at SPELL_GO) and its own melee target (+0xa20, SMSG_ATTACKSTART).
 *
 * What it changes. The setter 0x00736d30(state, 1, 0) moves the pieces at once for such a unit (SheathCeremony.ts: a
 * second argument of 1 plays no arm clip) and sends nothing (the packet is the active player's only). The server's
 * byte reaches the unit through the field callback 0x00737aa0 → 0x00736d30(byte, 1, 1), so a change of the byte is
 * shown at once whatever the last start decided; and the rule's last branch hands the byte back at the next start that
 * nothing else decides. Between the two, what the unit holds is the rule's: a creature with its sword out puts it on
 * its back for a cast or a talk emote (EmoteTalk carries Weaponflags 0x10 — hence the *NoSheathe emote rows) and has
 * it in hand again at its next stance or swing.
 *
 * The state lives on the renderer's unit and dies with it; per frame it costs a compare unless the unit started an
 * animation or its byte moved.
 */
import { ANIMATION_BEHAVIORS, ANIMATION_WEAPON_FLAGS } from "../generated/animations.js";
import { animationSheathState } from "../world/AnimationSheathRule.js";

/** The melee sheath state (`SHEATH_STATE_MELEE`). */
const SHEATH_STATE_MELEE = 1;

/** A cast as the world client holds it (WorldClient `casts`, held from SMSG_SPELL_START to its end). */
export interface ShownSheathCast {
  readonly spellId: number;
  readonly channel: boolean;
}

/** What the rule reads beyond the unit's own animation: the casts, the spells' attribute words, the melee targets. */
export interface ShownSheathContext {
  readonly casts: ReadonlyMap<bigint, ShownSheathCast>;
  /** The spell rows' attribute words by id (`/dbc/spells` `attributes`); absent: not known. */
  readonly spellAttributes: ReadonlyMap<number, readonly number[]>;
  /** The units with a melee target of their own (+0xa20; game/SwingReactionCues.ts). */
  readonly meleeTargets: ReadonlySet<bigint>;
}

/** The AnimationData row 0x00738180 reads (table 0x00ad30e8): undefined when the generated tables know nothing of it. */
export function animationSheathRow(animation: number): { readonly weaponFlags: number; readonly behavior: number } | undefined {
  if (animation < 0) return undefined;
  const weaponFlags = ANIMATION_WEAPON_FLAGS[animation];
  const behavior = ANIMATION_BEHAVIORS[animation];
  return weaponFlags === undefined && behavior === undefined ? undefined : { weaponFlags: weaponFlags ?? 0, behavior: behavior ?? 0 };
}

/** One unit's shown sheath: the held state (+0xb5c), the byte it last saw and the animation starts it has judged. */
export class UnitShownSheath {
  held: number;
  published: number;
  starts: number;

  constructor(published: number, starts: number) {
    this.held = published;
    this.published = published;
    this.starts = starts;
  }
}

/**
 * 5.05 (15.11, combat7): a melee swing of this unit arrived (SMSG_ATTACKERSTATEUPDATE). Wow.exe's handler 0x00756800
 * case 0x14a, for an attacker the client has, calls 0x00736d30(1, 1, 0) when its held state is not 1 — the melee
 * weapons drawn at once, before the swing's animation, whatever the swing draws (re-2026-11-11/combat4/c1.c). A unit
 * the renderer has not judged yet has nothing to change: it starts from its byte.
 */
export function swungAt(shown: UnitShownSheath | undefined): void {
  if (shown !== undefined) shown.held = SHEATH_STATE_MELEE;
}

/**
 * One frame of a unit that is not the active player: a new byte is taken first (0x00737aa0 runs when the packet is
 * read, before the frame animates), then the latest animation start is judged (0x00738180; starts within one frame end
 * on that frame's animation and the last start's `keep`). Returns the record, created on the first call with the byte
 * as its state and the current count as already judged.
 */
export function stepUnitShownSheath(
  shown: UnitShownSheath | undefined, guid: bigint, published: number, starts: number,
  animation: number, keep: boolean, context: ShownSheathContext,
): UnitShownSheath {
  if (shown === undefined) return new UnitShownSheath(published, starts);
  if (published !== shown.published) {
    shown.published = published;
    shown.held = published;
  }
  if (starts === shown.starts) return shown;
  shown.starts = starts;
  const cast = context.casts.get(guid);
  const state = animationSheathState({
    row: animationSheathRow(animation), animation, keep, held: shown.held,
    casting: cast === undefined || cast.channel ? undefined : { attributes0: context.spellAttributes.get(cast.spellId)?.[0] },
    attacking: context.meleeTargets.has(guid), activePlayer: false, published,
  });
  if (state !== undefined) shown.held = state;
  return shown;
}
