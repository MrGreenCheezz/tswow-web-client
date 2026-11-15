// 5.05 (15.11, bow9): the bow string and the arrow in the hand — a unit's ranged auto-repeat stance and the two model events
// that pull and release the string. Wow.exe 3.3.5a 12340, Ghidra read-only (.runtime/re-2026-11-15/events8/r1, r2,
// combat5/d2.c, bow9/r1, r2):
//
// - The mark. +0xa38 bit 0x200 is set by 0x00715ac0(1) from 0x007fa2e0 — the cast's visual start, for a spell with
//   AttributesEx2 & 0x20 (AUTOREPEAT) — which 0x00805330 runs on the player's own send and on every SMSG_SPELL_START
//   without CAST_FLAG_PENDING (0x00806700), whoever the caster. It is cleared by SMSG_CANCEL_AUTO_REPEAT for any unit
//   (0x0072d130), the player's own cancel 0x00807560 and the unit's teardown 0x00734fd0; the first two also stop the
//   draw (0x0072afe0). The page keeps it (world/RangedRepeatMarks.ts) and hands it over in RenderInputs.rangedRepeat.
// - The rung. 0x00714f90, in the base chooser 0x00724500 after the movement, cast-pose and melee-stance rungs and before
//   the stand state, emote state and Stand: while the shown sheath (+0xb5c) is 2 and the mark is set, and no arrow is in
//   the hand (+0xa38 & 0x4000), the stance is LoadBow 0x69 for a bow (ranged subclass 2), LoadRifle 0x6a for a gun or
//   crossbow (3, 0x12), LoadThrown 0x70 for thrown (0x10), HoldThrown 0x6f for a wand (0x13), ReadyUnarmed 0x19 for any
//   other; with the arrow in the hand it names nothing and the clip on show stays.
// - The clip ends (0x0073b510): LoadBow → HoldBow 0x6d, LoadRifle → HoldRifle 0x6e; HoldBow plays again while the unit
//   channels (UNIT_FIELD_CHANNEL_SPELL) or has 0x600 (the mark, or a precast animation 0x400), HoldRifle and
//   HoldThrown/LoadThrown → HoldThrown only while it channels or has 0x400; otherwise the chooser runs again.
// - "$BWP" (0x00756240): for the active player only while its current or repeat spell has Attributes & 2 (REQ_AMMO);
//   for every unit only while its movement word (+0x7cc) has none of 0x2e0100f (moving, strafing, falling, swimming,
//   ascending, descending, flying). Then 0x00756040 plays BowPull 0xa0 on the ranged weapon's model (+0xb40) when the
//   model has it, at a speed that makes it last the rest of the unit's clip; the ammo model (+0xb44) is hung on
//   HandArrow 35 unless the ranged weapon is a gun or crossbow; bit 0x4000 is set.
// - "$BWR" (0x00732650): bit 0x4000 cleared; with missiles queued (+0x9ec) the weapon goes to sequence 0 in a bow
//   behaviour (AttackBow/LoadBow/HoldBow, model with attachment 35), plays BowRelease 0xa1 in a rifle behaviour (36);
//   the ammo model is unhung.
// - The stop 0x0072afe0 (the queue's launch 0x0072df00, the cancels above, a missile launch, …): bit 0x4000 cleared, the
//   ammo unhung, the weapon back to sequence 0 unless it plays 0xa1.
// - The ammo model (0x007206a0): made from an ItemDisplayInfo id (+0xb48) by 0x004eab50; SMSG_SPELL_START of a REQ_AMMO
//   spell hands it the packet's ammo display with type 0x1e, which becomes 0x19 when the ranged item is thrown, else 0x18
//   (the packet's own inventory type is not read). A new display while bit 0x4000 is set is hung at once — not for a gun
//   or crossbow, and only as ammo (0x18).
//
// What is this client's and not read: the clip end is seen as the base clip wrapping (the base loops here); a re-pick
// is any frame the body shows something that is not the cycle's clip, and with the arrow in the hand it keeps the hold
// (Wow.exe keeps whatever plays); BowPull holds its last frame until the release or the stop (0x00832ab0's last two
// arguments are 1, 1; the drawn string through HoldBow is what the original shows); the 0x400 precast bit is not kept.

import { ANIMATION_BEHAVIORS } from "../generated/animations.js";
import type { ModelEvents } from "./VehicleMuzzle.js";

export const LOAD_BOW = 0x69;
export const LOAD_RIFLE = 0x6a;
export const HOLD_BOW = 0x6d;
export const HOLD_RIFLE = 0x6e;
export const HOLD_THROWN = 0x6f;
export const LOAD_THROWN = 0x70;
export const READY_UNARMED_ANIMATION = 0x19;
/** The weapon model's own sequences. */
export const BOW_PULL = 0xa0;
export const BOW_RELEASE = 0xa1;
export const WEAPON_STAND = 0;
/** The ranged slot (EQUIPMENT_SLOT_RANGED). */
export const EQUIPMENT_SLOT_RANGED = 17;
/** +0x7cc bits under which "$BWP" does nothing (0x00756240). */
export const PULL_BLOCKING_MOVEMENT = 0x02e0100f;
/** The shown sheath of the rung. */
const SHEATH_RANGED = 2;
const SUBCLASS_BOW = 2;
const SUBCLASS_GUN = 3;
const SUBCLASS_THROWN = 0x10;
const SUBCLASS_CROSSBOW = 0x12;
const SUBCLASS_WAND = 0x13;
const INVTYPE_AMMO = 0x18;
const INVTYPE_THROWN = 0x19;
const INVTYPE_RANGED = 15;
/** AnimationData behaviours 0x0071da60 and 0x0071daa0 test. */
const BOW_BEHAVIORS: ReadonlySet<number> = new Set([0x2e, 0x69, 0x6d]);
const RIFLE_BEHAVIORS: ReadonlySet<number> = new Set([0x31, 0x6a, 0x6e]);
export const PULL_EVENT = "$BWP";
export const RELEASE_EVENT = "$BWR";

/**
 * The ranged item's subclass as far as the rung needs it: its own, else an inventory type that names one (15 is a bow,
 * 25 thrown); 26 is a gun, a crossbow or a wand alike, and stays unknown.
 */
export function rangedSubClass(item: { inventoryType: number; subClass?: number | undefined } | undefined): number | undefined {
  if (item === undefined) return undefined;
  if (item.subClass !== undefined) return item.subClass;
  if (item.inventoryType === INVTYPE_RANGED) return SUBCLASS_BOW;
  if (item.inventoryType === INVTYPE_THROWN) return SUBCLASS_THROWN;
  return undefined;
}

/** 0x00714f90: the stance the rung names for a ranged weapon of `subClass` (undefined: no ranged weapon). */
export function rangedLoadAnimation(subClass: number | undefined): number {
  switch (subClass) {
    case SUBCLASS_BOW: return LOAD_BOW;
    case SUBCLASS_GUN: case SUBCLASS_CROSSBOW: return LOAD_RIFLE;
    case SUBCLASS_THROWN: return LOAD_THROWN;
    case SUBCLASS_WAND: return HOLD_THROWN;
    default: return READY_UNARMED_ANIMATION;
  }
}

/** 0x00756240 / 0x007206a0: a gun or a crossbow takes no arrow in the hand. */
export function takesNoArrow(subClass: number | undefined): boolean {
  return subClass === SUBCLASS_GUN || subClass === SUBCLASS_CROSSBOW;
}

/** 0x007206a0: the type the ammo model is made as — thrown when the ranged item is thrown (inventory type 0x19). */
export function ammoInventoryType(rangedInventoryType: number | undefined): number {
  return rangedInventoryType === INVTYPE_THROWN ? INVTYPE_THROWN : INVTYPE_AMMO;
}

/** 0x0073b510: what follows the end of `animation` without a new choice; undefined: the chooser runs again. */
export function clipEndFollower(animation: number, mark: boolean, channel: boolean): number | undefined {
  switch (animation) {
    case LOAD_BOW: return HOLD_BOW;
    case LOAD_RIFLE: return HOLD_RIFLE;
    case HOLD_BOW: return channel || mark ? HOLD_BOW : undefined;
    case HOLD_RIFLE: return channel ? HOLD_RIFLE : undefined;
    case HOLD_THROWN: case LOAD_THROWN: return channel ? HOLD_THROWN : undefined;
    default: return undefined;
  }
}

/** The hold a load stance hands over to (0x0073b510's first followers); a stance with none holds itself. */
export function holdOf(load: number): number {
  switch (load) {
    case LOAD_BOW: return HOLD_BOW;
    case LOAD_RIFLE: return HOLD_RIFLE;
    case LOAD_THROWN: return HOLD_THROWN;
    default: return load;
  }
}

/** 0x00756040: BowPull's speed so it lasts the rest of the unit's clip; undefined when nothing of the clip remains. */
export function bowPullSpeed(pullMs: number, clipMs: number, atMs: number): number | undefined {
  const remaining = clipMs - atMs;
  if (!(remaining > 0) || !(pullMs > 0)) return undefined;
  return pullMs / remaining;
}

/** A sequence's length in a model's table (variation 0 first), undefined when the model has no such sequence. */
export function sequenceLength(sequences: ModelEvents["sequences"], animation: number): number | undefined {
  if (sequences === undefined) return undefined;
  let any: number | undefined;
  for (const [id, variation, ms] of sequences) {
    if (id !== animation) continue;
    if (variation === 0) return ms;
    any ??= ms;
  }
  return any;
}

/** The keys (ms) of event `id` in `animation`'s variation `variation`; empty when it has none there. */
export function eventKeys(model: ModelEvents | undefined, id: string, animation: number, variation: number): readonly number[] {
  if (model === undefined) return NO_KEYS;
  for (const event of model.events) {
    if (event.id !== id || event.globalSequence !== undefined) continue;
    for (const [sequence, at, times] of event.keys ?? []) {
      if (sequence === animation && at === variation) return times;
    }
  }
  return NO_KEYS;
}
const NO_KEYS: readonly number[] = Object.freeze([]);

/** A clip on show: its animation, variation, where it is, how long it is, and its start (a new token is a new start). */
export interface ShownClip {
  readonly animation: number;
  readonly variation: number;
  readonly timeMs: number;
  readonly durationMs: number;
  readonly token: object;
}

/** What one frame of a unit hands the draw. */
export interface BowDrawFrame {
  readonly now: number;
  /** +0xa38 & 0x200 (RenderInputs.rangedRepeat). */
  readonly mark: boolean;
  /** The shown sheath (+0xb5c). */
  readonly sheath: number | undefined;
  /** The ranged item's subclass (`rangedSubClass`). */
  readonly subClass: number | undefined;
  /** The movement word (+0x7cc). */
  readonly movement: number;
  /** UNIT_FIELD_CHANNEL_SPELL is set. */
  readonly channel: boolean;
  /** The active player, and whether its current or repeat spell has REQ_AMMO. */
  readonly self: boolean;
  readonly reqAmmo: boolean;
  /** The whole-body clip on show, and the upper body's over it. */
  readonly base: ShownClip | undefined;
  readonly upper: ShownClip | undefined;
  /** The unit model's events (`/visual/model-events?v=2`); undefined while on the way. */
  readonly events: ModelEvents | undefined;
  /** The ranged weapon model's sequences (the same route); undefined while on the way or without a model. */
  readonly weapon: ModelEvents["sequences"];
  /** An ammo display is known (+0xb44 made). */
  readonly ammo: boolean;
  /** Missiles are queued on the unit (+0x9ec). */
  readonly queued: boolean;
}

/** The sequence the weapon model is asked to play, from `at`, at `speed`. */
export interface WeaponSequence {
  readonly animation: number;
  readonly speed: number;
  readonly at: number;
}

interface Seen {
  token: object | undefined;
  animation: number;
  timeMs: number;
}

/** One unit's draw: the stance it asks for, the arrow, the weapon's sequence. */
export class BowDraw {
  /** +0xa38 & 0x4000. */
  arrow = false;
  /** The ammo model is on HandArrow. */
  hung = false;
  /** The weapon model's sequence; undefined: never asked, the rest pose. */
  weapon: WeaponSequence | undefined;
  /** The ammo display (+0xb48) and the type it was made as. */
  ammoDisplay = 0;
  ammoType = INVTYPE_AMMO;
  #phase: "load" | "hold" | undefined;
  readonly #base: Seen = { token: undefined, animation: -1, timeMs: 0 };
  readonly #upper: Seen = { token: undefined, animation: -1, timeMs: 0 };

  /** The cycle's stance for this frame (0x00714f90 with 0x0073b510's ends), or undefined: the rung names nothing. */
  step(frame: BowDrawFrame): number | undefined {
    const baseEnded = this.#observe(this.#base, frame.base, frame);
    this.#observe(this.#upper, frame.upper, frame);
    if (frame.sheath !== SHEATH_RANGED) {
      this.#phase = undefined;
      return undefined;
    }
    const load = rangedLoadAnimation(frame.subClass);
    const hold = holdOf(load);
    const shown = frame.base?.animation;
    if (!frame.mark) return this.#afterMark(frame, load, hold, shown, baseEnded);
    const showing = this.#phase === "load" ? load : this.#phase === "hold" ? hold : undefined;
    if (showing === undefined || shown !== showing) {
      // A choice (the chooser runs): no arrow in the hand → the load stance; with one, what plays stays (the hold).
      this.#phase = this.arrow ? "hold" : "load";
    } else if (baseEnded) {
      const next = clipEndFollower(showing, frame.mark, frame.channel);
      if (next !== undefined) this.#phase = next === load ? "load" : "hold";
      else this.#phase = this.arrow ? "hold" : "load";
    }
    return this.#phase === "hold" ? hold : load;
  }

  /**
   * 5.05 (15.11, combat11, stand `runs/combat11-c2-bow-move`, `combat11-d2-bow-move`): the mark is gone (a cancel) while the
   * cycle's clip is on show. Wow.exe does not re-pick then: the clip runs to its end, LoadBow's end still hands to HoldBow
   * (0x0073b510's first followers ask for no mark), and HoldBow's end without the mark goes back to the chooser — a cancel in
   * LoadBow showed LoadBow to its end, then HoldBow; one in HoldBow showed HoldBow to the end of its cycle, then Stand. Any
   * other clip on the body ends it at once.
   */
  #afterMark(frame: BowDrawFrame, load: number, hold: number, shown: number | undefined, ended: boolean): number | undefined {
    const showing = this.#phase === "load" ? load : this.#phase === "hold" ? hold : undefined;
    if (showing === undefined || shown !== showing) {
      this.#phase = undefined;
      return undefined;
    }
    if (ended) {
      const next = clipEndFollower(showing, false, frame.channel);
      if (next === undefined) {
        this.#phase = undefined;
        return undefined;
      }
      this.#phase = next === load ? "load" : "hold";
    }
    return this.#phase === "hold" ? hold : load;
  }

  /** 0x0072afe0. */
  stop(now: number): void {
    this.arrow = false;
    this.hung = false;
    if (this.weapon !== undefined && this.weapon.animation !== BOW_RELEASE) {
      this.weapon = { animation: WEAPON_STAND, speed: 1, at: now };
    }
  }

  /**
   * 0x007206a0: the unit's ammo display (SMSG_SPELL_START of a REQ_AMMO spell). Another display unhangs the old model;
   * the new one is hung at once while the arrow bit is set, as ammo, and not for a gun or crossbow.
   */
  setAmmo(display: number, rangedInventoryType: number | undefined, subClass: number | undefined): void {
    const type = ammoInventoryType(rangedInventoryType);
    if (display === this.ammoDisplay && type === this.ammoType) return;
    this.hung = false;
    this.ammoDisplay = display;
    this.ammoType = type;
    if (display !== 0 && !takesNoArrow(subClass) && this.arrow && type === INVTYPE_AMMO) this.hung = true;
  }

  /** Walks one clip from where it was last seen; true when it reached its end (wrapped or ran out). */
  #observe(seen: Seen, clip: ShownClip | undefined, frame: BowDrawFrame): boolean {
    if (clip === undefined) {
      seen.token = undefined;
      seen.animation = -1;
      return false;
    }
    let from: number;
    let ended = false;
    if (clip.token === seen.token && clip.animation === seen.animation) {
      from = seen.timeMs;
      if (clip.timeMs < from) {
        ended = true;
        this.#fire(from, clip.durationMs, clip, frame);
      } else {
        this.#fire(from, clip.timeMs, clip, frame);
        ended = clip.timeMs >= clip.durationMs && from < clip.durationMs;
      }
    } else {
      this.#fire(-1, clip.timeMs, clip, frame);
    }
    seen.token = clip.token;
    seen.animation = clip.animation;
    seen.timeMs = clip.timeMs;
    return ended;
  }

  /** The two events with a key in (from, to] of the clip. */
  #fire(from: number, to: number, clip: ShownClip, frame: BowDrawFrame): void {
    for (const key of eventKeys(frame.events, PULL_EVENT, clip.animation, clip.variation)) {
      if (key > from && key <= to) this.#pull(key, clip, frame);
    }
    for (const key of eventKeys(frame.events, RELEASE_EVENT, clip.animation, clip.variation)) {
      if (key > from && key <= to) this.#release(clip, frame);
    }
  }

  /** "$BWP", 0x00756240 → 0x00756040. */
  #pull(key: number, clip: ShownClip, frame: BowDrawFrame): void {
    if (frame.self && !frame.reqAmmo) return;
    if ((frame.movement & PULL_BLOCKING_MOVEMENT) !== 0) return;
    const pull = sequenceLength(frame.weapon, BOW_PULL);
    if (pull !== undefined) {
      const speed = bowPullSpeed(pull, clip.durationMs, key);
      if (speed !== undefined) this.weapon = { animation: BOW_PULL, speed, at: frame.now - Math.max(0, clip.timeMs - key) };
    }
    if (!takesNoArrow(frame.subClass) && frame.ammo && !this.hung) this.hung = true;
    this.arrow = true;
  }

  /** "$BWR", 0x00732650. */
  #release(clip: ShownClip, frame: BowDrawFrame): void {
    this.arrow = false;
    if (frame.queued) {
      const behavior = ANIMATION_BEHAVIORS[clip.animation] ?? clip.animation;
      if (BOW_BEHAVIORS.has(behavior)) this.weapon = { animation: WEAPON_STAND, speed: 1, at: frame.now };
      else if (RIFLE_BEHAVIORS.has(behavior)) this.weapon = { animation: BOW_RELEASE, speed: 1, at: frame.now };
    }
    this.hung = false;
  }
}
