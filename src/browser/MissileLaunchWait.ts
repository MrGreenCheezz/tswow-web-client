// 15.11 (events8; 6.12): when a missile queued by a cast leaves its caster. Wow.exe 3.3.5a 12340 (Ghidra read-only,
// .runtime/re-2026-11-15/combat5/d3.c, fx7/r1/d.c, events8/r1/d.c; combat7/g3.c):
//
// - SPELL_GO launches a visual's missiles itself when its CastKit plays no animation (0x0080e1b0 → 0x0072e240), and the
//   launcher 0x00732ff0 does for SpellVisual.Flags & 4 (`launchNow`). Otherwise 0x00732ff0 queues them on the caster
//   (+0x9ec) and stamps the time (+0x9e8).
// - The unit update 0x00734390 launches the queue (0x0072df00):
//   * from the point an event stored (+0xaf0, flag +0xa30 0x80000000) in the update after the event — the model-event
//     callback 0x00732650 stores it for "$CSL", "$CSR", "$CST" (their own position) and "$BWR" (attachment 35 HandArrow
//     while the animation's behaviour is AttackBow/LoadBow/HoldBow, 0x0071da60; attachment 36 for AttackRifle/LoadRifle/
//     HoldRifle, 0x0071daa0; else its own position);
//   * from 0x0071a720's point 2 s after the queueing (`(now − +0x9e8) − 2000 ≥ 0`);
//   * from 0x0071a720's point at once while the unit's kit animation (+0xfa4, written by the kit player 0x0073b140,
//     reset to −1 by the animation's end 0x0073bbd0 and a model change 0x0073e410) is −1 or not a cast: 0x0071dcc0 counts
//     only the behaviours (AnimationData +0x18) Spell 2, SpellCast 32, SpellCastArea 33, SpellCastDirected 53,
//     SpellCastOmni 54 (0x0071d380), AttackThrown 107, AttackBow 46 and AttackRifle 49.
//
// So a missile of an animating cast leaves at the first of those four events in the clip the kit plays, else when the
// clip ends, and never later than 2 s; a kit animation that is no cast lets it go at once. The moments are the M2's own
// keys (`/visual/model-events?v=2`, VehicleMuzzle.ts). While they are unknown — the caster's model or its events still on
// the way, or a gateway older than version 2 — the missile leaves at the GO, as it did before: nothing waits on them.
// Assumed, not read: the clip is the kit animation's variation 0 at speed 1 from the GO (the renderer plays it so), and a
// model that has neither the animation nor any of its AnimationData fallbacks plays no animation (+0xfa4 counts as −1).

import { ANIMATION_BEHAVIORS, ANIMATION_FALLBACK } from "../generated/animations.js";
import type { ModelEvents, ModelShotEvent } from "./VehicleMuzzle.js";

/** 0x00734390: queued missiles no event took leave this long after they were queued. */
export const MISSILE_QUEUE_LIMIT_MS = 2_000;
/** 0x0071dcc0 (with 0x0071d380): the kit animation behaviours that hold the queue. */
const HOLDING_BEHAVIORS: ReadonlySet<number> = new Set([2, 32, 33, 53, 54, 107, 46, 49]);
/** 0x00732650: the events that store the launch point. */
const LAUNCH_EVENTS: ReadonlySet<string> = new Set(["$CSL", "$CSR", "$CST", "$BWR"]);
/** 0x0071da60 / 0x0071daa0: the behaviours whose "$BWR" stores attachment 35 / 36. */
const BOW_BEHAVIORS: ReadonlySet<number> = new Set([0x2e, 0x69, 0x6d]);
const RIFLE_BEHAVIORS: ReadonlySet<number> = new Set([0x31, 0x6a, 0x6e]);
const MAX_FALLBACK_HOPS = 8;

/** HandArrow and Bullet (M2 attachment ids 35 and 36). */
export const ATTACHMENT_HAND_ARROW = 35;
export const ATTACHMENT_BULLET = 36;

/** When the queued missiles leave, relative to the GO, and the event that stored their point (if one did). */
export interface MissileLaunchWait {
  readonly delay: number;
  readonly event?: ModelShotEvent;
  /** The kit animation the event fired in. */
  readonly animation: number;
}

export function animationBehavior(animation: number): number {
  return ANIMATION_BEHAVIORS[animation] ?? animation;
}

/** The sequence 0x00832ab0 plays for `animation` on a model with `sequences`: the id itself or its fallbacks. */
export function playedAnimation(sequences: ModelEvents["sequences"] & object, animation: number): number | undefined {
  let id = animation;
  for (let hop = 0; hop <= MAX_FALLBACK_HOPS; hop++) {
    if (sequences.some((sequence) => sequence[0] === id)) return id;
    const next = ANIMATION_FALLBACK[id];
    if (next === undefined || next === id) return undefined;
    id = next;
  }
  return undefined;
}

/** The first key of `event` in `animation` (variation 0), or undefined. */
function firstKey(event: ModelShotEvent, animation: number): number | undefined {
  if (event.globalSequence !== undefined) return undefined; // on a loop's clock, not the clip's
  for (const [id, variation, times] of event.keys ?? []) {
    if (id === animation && variation === 0 && times.length > 0) return Math.min(...times);
  }
  return undefined;
}

/**
 * The wait of missiles queued by a cast whose kit plays `kitAnimation`, for a caster model with `model`'s events;
 * undefined while those are unknown (the caller launches at once, as before).
 */
export function missileLaunchWait(model: ModelEvents | undefined, kitAnimation: number): MissileLaunchWait | undefined {
  if (!HOLDING_BEHAVIORS.has(animationBehavior(kitAnimation))) return { delay: 0, animation: kitAnimation };
  if (model === undefined || model.sequences === undefined) return undefined;
  const played = playedAnimation(model.sequences, kitAnimation);
  if (played === undefined) return { delay: 0, animation: kitAnimation };
  let best: { at: number; event: ModelShotEvent } | undefined;
  for (const event of model.events) {
    if (!LAUNCH_EVENTS.has(event.id)) continue;
    const at = firstKey(event, played);
    if (at !== undefined && (best === undefined || at < best.at)) best = { at, event };
  }
  if (best !== undefined && best.at < MISSILE_QUEUE_LIMIT_MS) return { delay: best.at, event: best.event, animation: kitAnimation };
  const duration = model.sequences.find((sequence) => sequence[0] === played && sequence[1] === 0)?.[2]
    ?? model.sequences.find((sequence) => sequence[0] === played)?.[2] ?? MISSILE_QUEUE_LIMIT_MS;
  return { delay: Math.min(Math.max(0, duration), MISSILE_QUEUE_LIMIT_MS), animation: kitAnimation };
}

/** 0x00732650's "$BWR": the attachment its point is taken from while the unit plays `animation`, or undefined (its own). */
export function releaseAttachment(animation: number): number | undefined {
  const behavior = animationBehavior(animation);
  if (BOW_BEHAVIORS.has(behavior)) return ATTACHMENT_HAND_ARROW;
  if (RIFLE_BEHAVIORS.has(behavior)) return ATTACHMENT_BULLET;
  return undefined;
}

/** What the renderer keeps per drawn effect, as far as holding it goes (MissileLanding.ts `LandingVisual`'s shape). */
export interface HeldVisual {
  readonly instance: { startedAt: number; endsAt: number; readonly flight?: unknown };
  readonly handle: unknown;
  authoredEndsAt?: number;
}

interface HoldRecord {
  readonly leaveAt: number;
  readonly wait: MissileLaunchWait | undefined;
  readonly decidedAt: number;
}

/**
 * The holds of drawn casts, one per cast (all missiles of a queue leave together, 0x0072df00 walks the whole list).
 * The first missile frame decides it; a positive delay moves the cast's later effects (its impacts, planned at the
 * arrival from the GO) and its missiles' arrivals by the same delay, so the flight keeps its planned length.
 */
export class MissileLaunchHolds {
  readonly #byHandle = new Map<unknown, HoldRecord>();
  readonly #fired = new WeakMap<object, MissileLaunchWait>();

  /**
   * Whether `visual`'s missile still waits at `now`. `resolve` gives the wait (called once per cast); `visuals` are all
   * drawn effects, of which those of `visual.handle` are moved.
   */
  held(visual: HeldVisual, now: number, resolve: () => MissileLaunchWait | undefined, visuals: readonly HeldVisual[]): boolean {
    let record = this.#byHandle.get(visual.handle);
    if (record === undefined) {
      const wait = resolve();
      const delay = wait?.delay ?? 0;
      const goAt = visual.instance.startedAt;
      record = { leaveAt: goAt + delay, wait, decidedAt: now };
      this.#sweep(now);
      this.#byHandle.set(visual.handle, record);
      if (delay > 0) shiftCast(visuals, visual.handle, goAt, delay);
    }
    if (record.wait?.event !== undefined) this.#fired.set(visual.instance, record.wait);
    return now < record.leaveAt;
  }

  /** The event whose point a held missile leaves from, once it may leave. */
  firedEvent(instance: object): MissileLaunchWait | undefined {
    return this.#fired.get(instance);
  }

  #sweep(now: number): void {
    for (const [handle, record] of this.#byHandle) {
      if (now - record.decidedAt > 60_000) this.#byHandle.delete(handle);
    }
  }
}

/** The renderer's holds (one renderer per page or worker, as MissileFlight's own flight states). */
export const missileLaunchHolds = new MissileLaunchHolds();

/** Moves the cast's effects after its GO, and its missiles' arrivals, by `delay`. */
export function shiftCast(visuals: readonly HeldVisual[], handle: unknown, goAt: number, delay: number): number {
  let moved = 0;
  for (const visual of visuals) {
    if (visual.handle !== handle) continue;
    const instance = visual.instance;
    if (instance.flight !== undefined) {
      instance.endsAt += delay;
    } else if (instance.startedAt > goAt) {
      instance.startedAt += delay;
      instance.endsAt += delay;
    } else continue;
    if (visual.authoredEndsAt !== undefined) visual.authoredEndsAt += delay;
    moved++;
  }
  return moved;
}
