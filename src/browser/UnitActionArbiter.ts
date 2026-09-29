// Who owns a unit's action pose, and on which part of the body it is shown.
//
// Until this module a unit had one action slot — `Map<guid, record>` in the renderer — and every
// packet that named a pose overwrote it: a flinch replaced the precast it landed on, a stun was
// replaced by the next hit, and a melee swing replaced a cast that had not started yet. Nothing
// ever came back. And a playing full-body one-shot blocked the whole pose pass until its clip
// ended, so a unit that started moving slid with its legs locked in a cast stance for up to the
// clip's length (SpellCastOmni 0.88 s, EmoteRoar 3.2 s on HumanMale).
//
// The rules here are pure so they can be asserted without a scene:
// * layers, strongest first: aura state > cast (precast, channel, release) > melee/shoot >
//   reaction (impact flinch) > emote. A weaker one-shot never interrupts a stronger live pose; a
//   stronger or equal request takes over at once; when a pose ends the strongest surviving hold
//   comes back.
// * a pose over a base that is not plain standing (moving, mounted, swimming, sitting, crouched)
//   plays on the upper body when its AnimationData row allows it (Bodyflags bit 0x8), and the
//   base keeps every track the pose does not key; otherwise it gives way, except an aura state,
//   which keeps the whole body (a Bladestorm spins while it moves).

import * as THREE from "three";
import { ANIMATION_BODY_FLAGS, ANIMATION_IDS } from "../generated/animations.js";
import type { UnitAction } from "./AnimatedModel.js";
import type { VisualAnimationMode } from "./SpellVisuals.js";

/**
 * What the renderer keeps per queued pose: what was asked for, and the waits that decide whether
 * its keyframes are worth waiting for. The arbiter never reads it.
 */
export interface UnitActionPayload {
  /** AnimationData ids a kit or an emote named; empty for a semantic action. */
  wanted: number[];
  /** A swing or a shot, whose pose depends on what the unit is holding when it is drawn. */
  action: UnitAction | undefined;
  /** A `StartAnimID` lead-in is playing, with the kit's own `AnimID` to follow. */
  stage: "lead" | "main";
  followUp?: { animation: number; mode: VisualAnimationMode };
  /** When the lead-in hands over to the follow-up; 0 until the lead-in's clip has started. */
  sequenceAt: number;
  /**
   * How long a request may wait for keyframes that are still on their way.
   *
   * Of the 165 emotes the table names only nine travel with every model; the rest are one sidecar
   * request away, and deleting the request on the first frame without a clip lost them all.
   */
  waitUntil: number;
  /** The larger deadline, used only while this rig's sidecar is really queued or on the wire. */
  sidecarWaitUntil: number;
  /** A missing clip has entered the bounded network/CPU wait; cleared once it plays. */
  waitingForClip?: boolean;
  source: "external" | "visual";
}

/** What the renderer is showing from one unit's queue, and on which part of the body. */
export interface ShownUnitAction {
  entry: UnitActionEntry<UnitActionPayload>;
  animation: number;
  slot: "full" | "upper";
  /** The mixer action playing it — how a rebuilt model is told apart from the one it was put on. */
  action: THREE.AnimationAction;
}

/** The layers a packet-driven pose lives in. See {@link UNIT_ACTION_PRIORITY}. */
export type UnitActionLayer = "state" | "cast" | "melee" | "reaction" | "emote";

/**
 * How strong each layer is.
 *
 * An aura state outranks everything because the server holds the unit in it: a stunned unit hit by
 * Cone of Cold stays stunned, and before this its CombatWound flinch replaced Stun for good. A
 * cast outranks a flinch for the same reason a cast bar survives a hit (pushback, not an interrupt).
 */
export const UNIT_ACTION_PRIORITY: Readonly<Record<UnitActionLayer, number>> = {
  state: 4, cast: 3, melee: 2, reaction: 1, emote: 0,
};

export interface UnitActionRequest<Payload> {
  layer: UnitActionLayer;
  /** A pose held until `until` (precast, channel, aura state, emote stance), or a one-shot. */
  held: boolean;
  /**
   * Absolute end on the renderer clock: a hold's authored end, or the latest moment a one-shot may
   * still start. Once a one-shot is playing the renderer moves it to the moment it hands back.
   */
  until: number;
  /** Cancellation identity, when a spell visual asked for the pose. */
  owner?: unknown;
  payload: Payload;
}

export interface UnitActionEntry<Payload> extends UnitActionRequest<Payload> {
  /** Arrival order: within a layer the newest request is the one shown. */
  readonly sequence: number;
  /** Set by the renderer once the clip is playing. */
  started: boolean;
}

/**
 * One unit's live pose requests.
 *
 * Deliberately small: a unit has a handful of entries at most (a hold per layer and the one-shot
 * that is playing), so a flat array scanned per frame is cheaper than any index.
 */
export class UnitActionQueue<Payload, Shown = unknown> {
  #entries: UnitActionEntry<Payload>[] = [];
  #sequence = 0;
  /** The renderer's own record of what it is showing from this queue; opaque here. */
  shown: Shown | undefined;

  get size(): number {
    return this.#entries.length;
  }

  /** Nothing waiting and nothing on show: the owner may forget the queue. */
  get idle(): boolean {
    return this.#entries.length === 0 && this.shown === undefined;
  }

  get entries(): readonly UnitActionEntry<Payload>[] {
    return this.#entries;
  }

  /**
   * Adds a request, or refuses it: a request whose moment has already passed, and a one-shot
   * weaker than the pose that owns the unit. Holds are always kept — a weaker stance waits
   * underneath and comes back when the stronger one ends.
   */
  submit(request: UnitActionRequest<Payload>, now: number): UnitActionEntry<Payload> | undefined {
    this.expire(now);
    if (!(request.until > now)) return undefined;
    const top = this.top();
    if (!request.held && top !== undefined
      && UNIT_ACTION_PRIORITY[top.layer] > UNIT_ACTION_PRIORITY[request.layer]) return undefined;
    // A newer request retires the one-shots of its own layer: a channel hold replaces the release
    // that preceded it, a second swing the first. Older holds of the layer stay underneath.
    if (this.#entries.some((entry) => entry.layer === request.layer && !entry.held)) {
      this.#entries = this.#entries.filter((entry) => entry.layer !== request.layer || entry.held);
    }
    const entry: UnitActionEntry<Payload> = { ...request, sequence: ++this.#sequence, started: false };
    this.#entries.push(entry);
    return entry;
  }

  /** The request that owns the unit: the strongest layer, and in it the newest. */
  top(): UnitActionEntry<Payload> | undefined {
    let best: UnitActionEntry<Payload> | undefined;
    for (const entry of this.#entries) {
      if (best === undefined) {
        best = entry;
        continue;
      }
      const difference = UNIT_ACTION_PRIORITY[entry.layer] - UNIT_ACTION_PRIORITY[best.layer];
      if (difference > 0 || (difference === 0 && entry.sequence > best.sequence)) best = entry;
    }
    return best;
  }

  /** Drops everything whose moment has passed. Allocates nothing when nothing expired. */
  expire(now: number): void {
    if (!this.#entries.some((entry) => !(entry.until > now))) return;
    this.#entries = this.#entries.filter((entry) => entry.until > now);
  }

  remove(entry: UnitActionEntry<Payload>): boolean {
    const index = this.#entries.indexOf(entry);
    if (index < 0) return false;
    this.#entries.splice(index, 1);
    return true;
  }

  /** Removes and returns every entry the predicate selects. */
  removeWhere(predicate: (entry: UnitActionEntry<Payload>) => boolean): UnitActionEntry<Payload>[] {
    const removed = this.#entries.filter(predicate);
    if (removed.length > 0) this.#entries = this.#entries.filter((entry) => !predicate(entry));
    return removed;
  }

  clear(): void {
    this.#entries = [];
  }
}

/** Where a pose is shown: on the whole body, on the upper body over the base, or not at all. */
export type UnitActionDisplay = "full" | "upper" | "yield";

/**
 * How a pose meets the unit's own base pose.
 *
 * Standing still, the pose owns the whole body as it always did. Over any other base the legs
 * belong to the base: an upper-body-capable pose plays above it, an aura state keeps the whole body
 * (Stun, Bladestorm's Whirlwind), and anything else gives way — a roar or a special attack is not
 * drawn with frozen legs sliding across the ground.
 */
export function unitActionDisplay(layer: UnitActionLayer, upperBody: boolean, baseIdle: boolean): UnitActionDisplay {
  if (baseIdle) return "full";
  if (upperBody) return "upper";
  return layer === "state" ? "full" : "yield";
}

/**
 * Whether moving ends a request outright rather than merely hiding it.
 *
 * An emote stance is the one: /dance ends when the character walks away, which is what the old
 * single slot did for every hold. Casts are ended by the server's interrupt packet, not by the
 * renderer guessing; aura states last as long as the aura.
 */
export function unitActionEndsOnMovement(layer: UnitActionLayer, held: boolean): boolean {
  return layer === "emote" && held;
}

/**
 * `AnimationData.Bodyflags` bit that marks a pose playable on the upper body alone.
 *
 * Not documented anywhere; measured on this build's 506 rows. It is set on every cast, ready and
 * attack pose and on the upper-body gestures — SpellCastOmni/Directed, ReadySpellOmni, the
 * Attack* family, CombatWound, EmoteTalk/Wave/Point/Salute/Laugh (all 0x108 or 0x128) — and absent
 * from the whole-body ones: EmoteRoar/Dance/Kneel/Bow (0x100), Special1H/2H, Kick, Whirlwind
 * (0x120), the ChannelCast pair (0x100). An A/B against the native client is still owed.
 */
export const BODY_FLAG_UPPER_BODY = 0x8;

export function animationPlaysOnUpperBody(
  animation: number,
  bodyFlags: Readonly<Record<number, number>> = ANIMATION_BODY_FLAGS,
): boolean {
  return ((bodyFlags[animation] ?? 0) & BODY_FLAG_UPPER_BODY) !== 0;
}

/**
 * A held pose that is a one-way motion: play it once and hold its last frame.
 *
 * Death is what a held `Dead` resolves to on the playable rigs (HumanMale carries no 6 and its
 * fallback is 1), and looping it made quest corpses such as «Мертвый солдат» (45801) fall down,
 * stand up and fall again for as long as their aura lasted.
 */
export function heldClipPlaysOnce(animation: number): boolean {
  return animation === ANIMATION_IDS.Death;
}

const underlays = new WeakMap<THREE.AnimationClip, WeakMap<THREE.AnimationClip, THREE.AnimationClip>>();

/**
 * The base clip minus every track the upper-body clip keys.
 *
 * Three's mixer blends by normalised weight, so a gait and an overlay both at weight 1 do not
 * layer — they average. Measured on HumanMale, Run under a filtered SpellCastOmni left the upper
 * body 0.50 of the way back to the run on all 114 compared bones and the spell hand 0.55–0.59 of
 * the way back. Giving each property exactly one owner is what makes the overlay exact: the gait
 * keeps the legs and every property the cast leaves alone — 1–3 upper-body bones per cast on
 * HumanMale's Run (1–7 per pose across HumanMale, OrcFemale and TaurenMale), which a lower-body-only
 * cut would have dropped to the bind pose — and the cast keeps the rest.
 *
 * Cached per pair; the base itself comes back when the overlay keys nothing it keys.
 */
export function locomotionUnderlayClip(base: THREE.AnimationClip, overlay: THREE.AnimationClip): THREE.AnimationClip {
  let byBase = underlays.get(overlay);
  if (!byBase) {
    byBase = new WeakMap();
    underlays.set(overlay, byBase);
  }
  const cached = byBase.get(base);
  if (cached) return cached;
  const owned = new Set(overlay.tracks.map((track) => track.name));
  const tracks = base.tracks.filter((track) => !owned.has(track.name));
  let clip = base;
  if (tracks.length !== base.tracks.length) {
    clip = new THREE.AnimationClip(`${base.name}-under-${overlay.name}`, base.duration, tracks);
    // The stride's authored speed and blend travel with the clip, as the overlay's do.
    clip.userData = { ...base.userData };
  }
  byBase.set(base, clip);
  return clip;
}
