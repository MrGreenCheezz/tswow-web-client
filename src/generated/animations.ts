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
  | "AttackUnarmed" | "Attack1H" | "Attack2H" | "Attack2HL" | "AttackBow" | "AttackRifle"
  | "AttackThrown" | "AttackOff" | "ReadyUnarmed" | "Ready1H" | "Ready2H" | "ReadyBow"
  | "ReadyRifle" | "ReadyThrown" | "ReadySpellOmni" | "SpellCastOmni" | "ChannelCastOmni"
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
