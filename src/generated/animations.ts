/**
 * Stable, redistributable facade for animation data generated from the user's local dataset.
 *
 * `npm run build` creates an ignored neutral implementation when no dataset has been supplied.
 * The gateway refuses gameplay with that implementation; `npm run animations:generate` replaces
 * it locally with the real tables without putting client-derived data in Git.
 */
import * as implementation from "./client-data/animations.js";

export const ANIMATION_DATA_AVAILABLE: boolean = implementation.ANIMATION_DATA_AVAILABLE;

/** Animation names the handwritten client accesses directly. Values still come from the DBC. */
export type RequiredAnimationName =
  | "Stand" | "Walk" | "Run" | "Walkbackwards" | "ShuffleLeft" | "ShuffleRight"
  | "RunLeft" | "RunRight" | "JumpStart" | "Jump" | "JumpEnd" | "Fall"
  | "Swim" | "SwimIdle" | "SwimLeft" | "SwimRight" | "SwimBackwards" | "Fly" | "Hover"
  | "Mount" | "Death" | "Dead" | "SitGround" | "SitGroundDown" | "SitGroundUp"
  | "KneelLoop" | "SitChairLow" | "SitChairMed" | "SitChairHigh" | "Sleep" | "SleepDown"
  | "AttackUnarmed" | "Attack1H" | "Attack2H" | "Attack2HL" | "AttackBow" | "FireBow" | "AttackRifle"
  | "AttackThrown" | "AttackOff" | "ReadyUnarmed" | "Ready1H" | "Ready2H" | "ReadyBow"
  | "ReadyRifle" | "ReadyThrown" | "SpellPrecast" | "SpellCast" | "SpellCastArea"
  | "ReadySpellDirected" | "ReadySpellOmni" | "SpellCastDirected" | "SpellCastOmni"
  | "ChannelCastDirected" | "ChannelCastOmni"
  | "FlySpellPrecast" | "FlySpellCast" | "FlySpellCastArea"
  | "FlyReadySpellDirected" | "FlyReadySpellOmni" | "FlySpellCastDirected" | "FlySpellCastOmni"
  | "FlyChannelCastDirected" | "FlyChannelCastOmni"
  | "Loot" | "Close" | "Closed" | "Open" | "Opened" | "Destroy" | "Destroyed"
  | "Custom0" | "Custom1" | "Custom2" | "Custom3" | "EmoteBow" | "EmoteDance"
  | "EmoteTalk" | "EmoteUseStanding" | "EmoteWave" | "UseStandingLoop";

export type AnimationIds = Readonly<
  Record<string, number | undefined> & Record<RequiredAnimationName, number>
>;

export const ANIMATION_IDS = implementation.ANIMATION_IDS as AnimationIds;
export type AnimationName = string;
export const ANIMATION_NAMES: Readonly<Record<number, string>> = implementation.ANIMATION_NAMES;
export const ANIMATION_FALLBACK: Readonly<Record<number, number>> = implementation.ANIMATION_FALLBACK;
export const BASE_ANIMATIONS: readonly number[] = implementation.BASE_ANIMATIONS;
export const EMOTE_ANIMATIONS: Readonly<Record<number, { animation: number; state: boolean }>> =
  implementation.EMOTE_ANIMATIONS;
/**
 * AnimationData.Bodyflags by id, non-zero rows only. Read through a widened view because the
 * neutral stub and implementations generated before the column was published do not carry it;
 * an empty table means "no pose is known to be upper-body capable", never a crash.
 */
export const ANIMATION_BODY_FLAGS: Readonly<Record<number, number>> =
  (implementation as { readonly ANIMATION_BODY_FLAGS?: Readonly<Record<number, number>> })
    .ANIMATION_BODY_FLAGS ?? {};
/**
 * 12.10 6.03/6.07: AnimationData.Flags & 0x30 by id, non-zero rows only — what Wow.exe 0x00826350 reads on
 * a row it falls back from (0x10: the fallback plays backwards; 0x20: it holds). Widened like the body
 * flags: an implementation generated before the column was published plays every fallback forwards.
 */
export const ANIMATION_PLAYBACK_FLAGS: Readonly<Record<number, number>> =
  (implementation as { readonly ANIMATION_PLAYBACK_FLAGS?: Readonly<Record<number, number>> })
    .ANIMATION_PLAYBACK_FLAGS ?? {};
/**
 * 5.32: Emotes.dbc `EmoteFlags` by row and CreatureMovementInfo.dbc `SmoothFacingChaseRate` by row (world/
 * UnitFacing.ts). Widened like the body flags: the neutral stub and older implementations do not carry them, and
 * an empty table means «no row known» — an emote state forbids no turn, a creature springs at the default rate.
 */
export const EMOTE_FLAGS: Readonly<Record<number, number>> =
  (implementation as { readonly EMOTE_FLAGS?: Readonly<Record<number, number>> }).EMOTE_FLAGS ?? {};
export const CREATURE_MOVEMENT_CHASE_RATES: Readonly<Record<number, number>> =
  (implementation as { readonly CREATURE_MOVEMENT_CHASE_RATES?: Readonly<Record<number, number>> })
    .CREATURE_MOVEMENT_CHASE_RATES ?? {};
