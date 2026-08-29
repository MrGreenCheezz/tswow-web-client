// Turning one cast into the models to show, where to put them and when to take them away.
//
// Nothing here touches three.js, the scene or the clock: a cast goes in and a list of placements
// comes out, in the server's own coordinates, with absolute times on them. That is what lets the
// whole schedule be asserted — a fireball's bolt leaves the caster's hand, spends a second in the
// air over twenty-four yards, and its flash appears at the far end when it lands — without a
// canvas anywhere near it.
//
// The shape it has to fit is `SMSG_SPELL_GO`, which is the moment the spell fires: the caster,
// the spell, and who it hit. Two things it does not carry, and both are worked out here.
//
// It does not say how long a missile is in the air. Nothing on the wire does — the server has
// already decided the outcome before it sends the packet. `Spell.Speed` is where that number
// lives, in yards a second, and it is present on most spells with a missile. A zero speed is
// treated as authored-but-unknown and gets one corpus-wide fallback rather than disappearing.
//
// And it does not say how long an effect lasts. Neither does any table: a kit names a model and
// the model's own animation decides. Until one is loaded there is nothing to ask, so the times
// below are the ones the client's own effects run to, and a model that turns out to be longer is
// cut off rather than left standing.

import type {
  SpellVisualEffectTransform, SpellVisualKit, SpellVisualMetadata,
} from "../gateway/SpellVisual.js";
export type { SpellVisualEffectTransform };

/**
 * How long a cast flourish stands on the caster.
 *
 * Long enough to read at a glance and short enough that two casts in a global cooldown do not
 * stack: the shortest cooldown in the game is 1.0 s and the flourish has to be gone by then.
 */
export const CAST_KIT_MS = 900;
/** How long an impact flash stands on the target. Shorter — it is a hit, not a wind-up. */
export const IMPACT_KIT_MS = 700;
/** Below this a missile is not worth flying: it arrives the frame it leaves. */
export const MISSILE_MIN_SECONDS = 0.05;
/** Above this it is not a missile any more, it is scenery. Caps a long shot across a valley. */
export const MISSILE_MAX_SECONDS = 4;
/** One corpus-wide fallback for authored missile models whose Spell.Speed is zero. */
export const MISSILE_FALLBACK_SPEED = 24;
/** A persistent area with no finite SpellDuration still gets a bounded visual lifetime. */
export const PERSISTENT_AREA_FALLBACK_MS = 1_000;
/**
 * How far a bolt bows upward, as a fraction of the distance it covers.
 *
 * Not in any table. A dead-straight line between two points at chest height passes through
 * everything in between and reads as a slide rather than a throw; the client's own bolts rise.
 */
export const MISSILE_ARC = 0.08;

export type Point = { x: number; y: number; z: number };

/** Convert a model-attach offset into the parent frame used by the renderer. */
export function spellVisualTransformOffset(
  transform: SpellVisualEffectTransform,
  attachedToUnit: boolean,
): Point {
  const [x, y, z] = transform.offset;
  // A bone's world matrix already contains M2_TO_SCENE. A free-standing node is in scene space.
  return attachedToUnit ? { x, y, z } : { x, y: z, z: -y };
}

/** Euler components for the DBC's Rz(yaw) * Ry(pitch) * Rx(roll) convention. */
export function spellVisualTransformEuler(
  transform: SpellVisualEffectTransform,
): { x: number; y: number; z: number; order: "ZYX" } {
  const [yaw, pitch, roll] = transform.rotation;
  return { x: roll, y: pitch, z: yaw, order: "ZYX" };
}

/** One model to show: what, where, and between which two moments. */
export interface VisualInstance {
  path: string;
  scale: number;
  /** The unit it hangs on. Absent for something standing in the world on its own. */
  anchor?: bigint;
  /** The M2 attachment id on that unit, or −1 for a placement in the world. */
  attachment: number;
  /** Optional DBC-authored local transform from SpellVisualKitModelAttach. */
  transform?: SpellVisualEffectTransform;
  /** Where it stands, when it stands anywhere. */
  position?: Point;
  /** A missile flies from one to the other over its whole life. */
  flight?: { from: Point; to: Point };
  startedAt: number;
  endsAt: number;
  /** Allow a finite, non-flight effect to cover its authored model clip once loaded. */
  fitToModel?: boolean;
  /** Explicit model-clip lifetime policy; held packet/aura VFX loop until endsAt. */
  modelPlayback?: VisualModelPlayback;
}

export type VisualAnimationMode = "once" | "hold";
/** Playback of an effect model's own skeleton, independent from the unit action request. */
export type VisualModelPlayback = "once" | "hold";

export interface VisualAnimationFollowUp {
  animation: number;
  mode: VisualAnimationMode;
  hold: number;
}

/** A pose the cast asks a unit to strike. */
export interface VisualAnimation {
  guid: bigint;
  animation: number;
  /** Absolute performance-clock time at which the pose/one-shot starts. */
  at: number;
  /** Milliseconds to hold a held pose, or 0 for a one-shot. */
  hold: number;
  /** Unit-action playback policy; VFX lifetime is carried separately by VisualInstance. */
  mode: VisualAnimationMode;
  /** Optional lead-in completion, after which the primary pose is installed. */
  followUp?: VisualAnimationFollowUp;
}

/** A SoundEntries row scheduled alongside the visual plan. */
export interface VisualSound {
  sound: number;
  point: Point;
  at: number;
}

export interface SpellCast {
  caster: bigint;
  casterPoint: Point;
  /** Every unit the packet says was hit, with where it is. */
  targets: readonly { guid: bigint; point: Point }[];
  /** Optional ground destination from SpellCastTargets; the caster/first target is the fallback. */
  destination?: Point;
  areaPoint?: Point;
  /** Present for cast-start planning; existing GO callers need not provide it. */
  castTime?: number;
  channel?: boolean;
}

export interface SpellVisualPlanOptions {
  /** A channel's GO is its impact packet; its held channel pose owns the caster action slot. */
  includeCastAnimation?: boolean;
}

export interface SpellVisualPlan {
  instances: VisualInstance[];
  animations: VisualAnimation[];
  sounds: VisualSound[];
}

/** Seconds a missile spends covering `distance` yards at `speed` yards a second. */
export function missileSeconds(distance: number, speed: number): number {
  if (!(distance > 0)) return 0;
  const fallback = !(speed > 0);
  const effectiveSpeed = fallback ? MISSILE_FALLBACK_SPEED : speed;
  const seconds = distance / effectiveSpeed;
  // The fallback is deliberately positive even for a very short non-zero shot; only authored
  // positive speeds retain the old instant threshold for point-blank casts.
  if (seconds < MISSILE_MIN_SECONDS) return fallback ? MISSILE_MIN_SECONDS : 0;
  return Math.min(MISSILE_MAX_SECONDS, seconds);
}

/**
 * Where a missile is, `progress` of the way through its flight.
 *
 * The bow is a parabola that is zero at both ends and highest in the middle, so the bolt leaves
 * the hand and arrives at the target rather than near them.
 */
export function missilePoint(from: Point, to: Point, progress: number, out: Point): Point {
  const t = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  out.x = from.x + (to.x - from.x) * t;
  out.y = from.y + (to.y - from.y) * t;
  const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  out.z = from.z + (to.z - from.z) * t + distance * MISSILE_ARC * 4 * t * (1 - t);
  return out;
}

/**
 * The tangent of a missile's flight curve, in the same server frame as its endpoints.
 *
 * `missilePoint` deliberately bows a flight upwards. A model that is only given the endpoint yaw
 * then slides sideways through that arc (and has no pitch when the target is above or below the
 * caster). The derivative is the direction the model is actually travelling at this frame, so the
 * renderer can turn the model in all three dimensions without putting scene concerns here.
 */
export function missileDirection(from: Point, to: Point, progress: number, out: Point): Point {
  const t = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const distance = Math.hypot(dx, dy, dz);
  out.x = dx;
  out.y = dy;
  out.z = dz + distance * MISSILE_ARC * 4 * (1 - 2 * t);
  return out;
}

/** The effects of one kit, hung on one unit. */
function kitInstances(
  kit: SpellVisualKit,
  guid: bigint,
  at: Point,
  startedAt: number,
  endsAt: number,
  fitToModel: boolean,
  modelPlayback: VisualModelPlayback,
): VisualInstance[] {
  return kit.effects.map((effect) => {
    // A world effect stands where the unit is rather than on it, which is what puts a rune circle
    // on the ground instead of inside somebody's chest.
    const instance: VisualInstance = {
      path: effect.path,
      scale: effect.scale,
      attachment: effect.attachment,
      startedAt,
      endsAt,
      ...(fitToModel ? { fitToModel: true } : {}),
      ...(modelPlayback === "hold" ? { modelPlayback: "hold" as const } : {}),
      ...(effect.transform ? { transform: effect.transform } : {}),
    };
    if (effect.attachment < 0 || guid === 0n) instance.position = { ...at };
    else instance.anchor = guid;
    return instance;
  });
}

/** Effects from an area kit are world objects, even when the DBC row uses an attachment column. */
function areaKitInstances(
  kit: SpellVisualKit,
  at: Point,
  startedAt: number,
  endsAt: number,
  fitToModel: boolean,
  modelPlayback: VisualModelPlayback,
): VisualInstance[] {
  return kit.effects.map((effect) => ({
    path: effect.path,
    scale: effect.scale,
    attachment: effect.attachment,
    position: { ...at },
    startedAt,
    endsAt,
    ...(fitToModel ? { fitToModel: true } : {}),
    ...(modelPlayback === "hold" ? { modelPlayback: "hold" as const } : {}),
    ...(effect.transform ? { transform: effect.transform } : {}),
  }));
}

function addKit(
  plan: SpellVisualPlan,
  kit: SpellVisualKit | undefined,
  guid: bigint,
  at: Point,
  startedAt: number,
  endsAt: number,
  includeAnimation = true,
  mode: VisualAnimationMode = "once",
  fitToModel = true,
  modelPlayback: VisualModelPlayback = "once",
): void {
  if (!kit) return;
  plan.instances.push(...kitInstances(kit, guid, at, startedAt, endsAt, fitToModel, modelPlayback));
  // Synthetic target 0 is a static point, not a unit the renderer can animate. Keep its
  // world-bound effects and sound, but never enqueue a unit action for a GUID that has no model.
  if (guid !== 0n && includeAnimation) {
    plan.animations.push(...kitAnimations(kit, guid, startedAt, Math.max(0, endsAt - startedAt), mode));
  }
  if (kit.sound > 0) plan.sounds.push({ sound: kit.sound, point: { ...at }, at: startedAt });
}

function addAreaKit(
  plan: SpellVisualPlan,
  kit: SpellVisualKit | undefined,
  guid: bigint,
  at: Point,
  startedAt: number,
  endsAt: number,
  mode: VisualAnimationMode = "once",
  fitToModel = true,
  modelPlayback: VisualModelPlayback = "once",
): void {
  if (!kit) return;
  plan.instances.push(...areaKitInstances(kit, at, startedAt, endsAt, fitToModel, modelPlayback));
  plan.animations.push(...kitAnimations(kit, guid, startedAt, Math.max(0, endsAt - startedAt), mode));
  if (kit.sound > 0) plan.sounds.push({ sound: kit.sound, point: { ...at }, at: startedAt });
}

function areaPoint(cast: SpellCast): Point {
  return { ...(cast.areaPoint ?? cast.destination ?? cast.targets[0]?.point ?? cast.casterPoint) };
}

function arrivalAt(visual: SpellVisualMetadata, cast: SpellCast, target: { point: Point }, now: number): number {
  if (!visual.missile) return now;
  const distance = Math.hypot(
    target.point.x - cast.casterPoint.x,
    target.point.y - cast.casterPoint.y,
    target.point.z - cast.casterPoint.z);
  const seconds = missileSeconds(distance, visual.missile.speed);
  return seconds > 0 ? now + seconds * 1000 : now;
}

/** The animation a kit asks its caster for, if it asks for one. */
function kitAnimations(
  kit: SpellVisualKit,
  guid: bigint,
  at: number,
  hold: number,
  mode: VisualAnimationMode,
): VisualAnimation[] {
  const primaryHold = mode === "hold" ? hold : 0;
  if (kit.startAnimation >= 0 && kit.animation >= 0) {
    return [{
      guid,
      animation: kit.startAnimation,
      at,
      hold: 0,
      mode: "once",
      followUp: { animation: kit.animation, mode, hold: primaryHold },
    }];
  }
  if (kit.animation >= 0) return [{ guid, animation: kit.animation, at, hold: primaryHold, mode }];
  if (kit.startAnimation >= 0) return [{ guid, animation: kit.startAnimation, at, hold: 0, mode: "once" }];
  return [];
}

/**
 * Everything one cast shows, on an absolute clock.
 *
 * The order is the order it happens in: the caster's flourish now, the bolt over the next
 * however-many milliseconds, and the flash at the far end when the bolt gets there. A spell with
 * no missile lands on the same frame it is cast, which is what an instant is.
 */
export function planSpellVisual(
  visual: SpellVisualMetadata,
  cast: SpellCast,
  now: number,
  options: SpellVisualPlanOptions = {},
): SpellVisualPlan {
  const instances: VisualInstance[] = [];
  const animations: VisualAnimation[] = [];
  const sounds: VisualSound[] = [];
  const plan: SpellVisualPlan = { instances, animations, sounds };

  addKit(plan, visual.cast, cast.caster, cast.casterPoint, now, now + CAST_KIT_MS,
    options.includeCastAnimation !== false, "once", true);
  if (visual.animEventSound && visual.animEventSound > 0) {
    sounds.push({ sound: visual.animEventSound, point: { ...cast.casterPoint }, at: now });
  }
  // SpellVisual.MissileSound is authoritative. The optional nested copy is accepted for
  // hand-authored metadata and used only when the direct field is absent, avoiding duplicate
  // playback for gateway records that expose both representations.
  const missileSound = visual.missileSound ?? visual.missile?.sound;
  if (visual.missile && missileSound && missileSound > 0) {
    // SpellVisual.MissileSound is a cast-level event, not a per-target impact sound.
    sounds.push({ sound: missileSound, point: { ...cast.casterPoint }, at: now });
  }

  const arrivals: number[] = [];
  for (const target of cast.targets) {
    const arrival = arrivalAt(visual, cast, target, now);
    arrivals.push(arrival);
    if (visual.missile) {
      if (arrival > now) {
        plan.instances.push({
          path: visual.missile.path,
          scale: visual.missile.scale,
          attachment: visual.missile.attachment,
          flight: { from: { ...cast.casterPoint }, to: { ...target.point } },
          startedAt: now,
          endsAt: arrival,
          modelPlayback: "hold",
        });
      }
    }
    const targetingEnd = arrival > now ? arrival : now + IMPACT_KIT_MS;
    addKit(plan, visual.missileTargeting, target.guid, target.point, now, targetingEnd,
      true, "hold", false, "hold");
    addKit(plan, visual.impact, target.guid, target.point, arrival, arrival + IMPACT_KIT_MS,
      true, "once", true);
    addKit(plan, visual.targetImpact, target.guid, target.point, arrival, arrival + IMPACT_KIT_MS,
      true, "once", true);
  }

  const point = areaPoint(cast);
  const firstImpact = arrivals.length > 0 ? Math.min(...arrivals) : now;
  // CasterImpactKit is the caster-side half of an impact, so it shares the first actual arrival
  // with TargetImpactKit.  With no targets the cast itself is the only meaningful impact.
  addKit(plan, visual.casterImpact, cast.caster, cast.casterPoint, firstImpact, firstImpact + IMPACT_KIT_MS,
    true, "once", true);
  addAreaKit(plan, visual.instantArea, cast.caster, point, now, now + IMPACT_KIT_MS,
    "once", true);
  addAreaKit(plan, visual.impactArea, cast.caster, point, firstImpact, firstImpact + IMPACT_KIT_MS,
    "once", true);
  const persistentDuration = visual.durationMs && visual.durationMs > 0
    ? visual.durationMs
    : PERSISTENT_AREA_FALLBACK_MS;
  addAreaKit(plan, visual.persistentArea, cast.caster, point, firstImpact, firstImpact + persistentDuration,
    "once", false, "hold");
  return plan;
}

/** Plan the body/channel visual emitted by SMSG_SPELL_START or MSG_CHANNEL_START. */
export function planSpellCastStart(visual: SpellVisualMetadata, cast: SpellCast, now: number): SpellVisualPlan {
  const plan: SpellVisualPlan = { instances: [], animations: [], sounds: [] };
  const kit = cast.channel ? visual.channel : visual.precast;
  const duration = cast.castTime !== undefined && cast.castTime > 0 ? cast.castTime : CAST_KIT_MS;
  addKit(plan, kit, cast.caster, cast.casterPoint, now, now + duration, true, "hold", false, "hold");
  return plan;
}

/** Plan a StateKit for an aura; `endsAt` is normally the aura's expiresAt or infinity until removal. */
export function planSpellAuraState(
  visual: SpellVisualMetadata,
  target: { guid: bigint; point: Point },
  now: number,
  endsAt = Number.POSITIVE_INFINITY,
): SpellVisualPlan {
  const plan: SpellVisualPlan = { instances: [], animations: [], sounds: [] };
  addKit(plan, visual.state, target.guid, target.point, now, Math.max(now, endsAt), true, "hold", false, "hold");
  return plan;
}

/** Plan the finite effect/sound emitted when an aura carrying StateDoneKit is actually removed. */
export function planSpellAuraDone(
  visual: SpellVisualMetadata,
  target: { guid: bigint; point: Point },
  now: number,
): SpellVisualPlan {
  const plan: SpellVisualPlan = { instances: [], animations: [], sounds: [] };
  addKit(plan, visual.stateDone, target.guid, target.point, now, now + IMPACT_KIT_MS, true, "once", true);
  return plan;
}

/** Which of these are over. Kept separate so the renderer's sweep is one call and one rule. */
export function expiredInstances(instances: readonly VisualInstance[], now: number): number[] {
  const done: number[] = [];
  for (let index = 0; index < instances.length; index++) {
    if (instances[index]!.endsAt <= now) done.push(index);
  }
  return done;
}
