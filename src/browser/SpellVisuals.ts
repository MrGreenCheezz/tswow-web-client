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
  SpellVisualEffectTransform, SpellVisualKit, SpellVisualMetadata, SpellVisualShake,
} from "../gateway/SpellVisual.js";
import type { VisualBeam } from "./ChainBeam.js"; // 05.10-A7a-E
import type { UnitActionLayer } from "./UnitActionArbiter.js";
import type { MissileFlightPlan } from "./MissileFlight.js"; // 05.10-A7a-E
import { kitWoundBehavior } from "./game/AnimationSplit.js"; // 05.10-6.21
export type { SpellVisualEffectTransform };

/**
 * How long a precast or channel may outlive its own clock while its end packet is on the way.
 *
 * The cast is finished by `SMSG_SPELL_GO` (or a stop/failure), not by the bar: TrinityCore casts
 * on the first map update after its timer reaches zero (`Spell::update`, MapUpdateInterval 10 ms
 * on this realm), and the packet then crosses the network, so the GO lands after the local
 * deadline. Ending the stance on that deadline dropped the arms towards Stand before every release
 * (a 0.92–1.0 yd spell-hand jump on HumanMale) and brought them back up for the cast. The packet
 * still ends it; this only bounds how long a lost packet can leave the stance standing.
 */
export const CAST_END_GRACE_MS = 400;

/**
 * How long a cast flourish stands on the caster.
 *
 * Long enough to read at a glance and short enough that two casts in a global cooldown do not
 * stack: the shortest cooldown in the game is 1.0 s and the flourish has to be gone by then.
 */
export const CAST_KIT_MS = 900;
/** How long an impact flash stands on the target. Shorter — it is a hit, not a wind-up. */
export const IMPACT_KIT_MS = 700;
/**
 * How long a kit the server named by number stands on its unit.
 *
 * `SMSG_PLAY_SPELL_VISUAL` carries a kit id, a GUID and nothing else — no duration, no spell to
 * borrow a `SpellDuration` from, no end packet. So the kit gets the same bounded life a cast
 * flourish gets, and `fitToModel` lets a longer authored model clip finish rather than being cut;
 * `SMSG_PLAY_SPELL_IMPACT` takes the shorter impact window instead, because it is a hit.
 */
export const PACKET_KIT_MS = CAST_KIT_MS;
/**
 * How much an authored `AreaEffectSize` may grow the placement's own scale.
 *
 * The field is named like a radius in yards and is not one — the reasoning and the counts are on
 * `SpellVisualEffect.areaSize` in the gateway. What is left is a number that sometimes asks for
 * something *bigger* than `Scale` and can never be trusted as a multiplier, so it is applied as a
 * ceiling-capped floor and nothing else.
 *
 * Measured with this code against this dataset: of the 687 distinct effect placements a spell can
 * reach through the three area columns, 34 carry a non-identity value at all and this rule moves
 * **four** of them, across 13 spells — `thunderclap_cast_base` twice (its 20 held at 2 by this cap
 * instead of putting a 130-yard ring on the ground), `shadesofdarkness_cast` 2→3 and
 * `Canon_Impact_Dust` 1.5→2. The other 683 are byte-identical to what was drawn before.
 */
export const AREA_EFFECT_SIZE_MAX_GROWTH = 2;

/**
 * What an area placement is actually drawn at.
 *
 * Only ever larger, never smaller: an authored `Scale` is a decision an artist made about that
 * model, and the one thing measurement supports about `AreaEffectSize` is that where it exceeds
 * `Scale` it is asking for a wider footprint than the model's own default.
 */
export function areaEffectScale(scale: number, areaSize: number | undefined): number {
  if (!(scale > 0) || areaSize === undefined || !(areaSize > 1) || !(areaSize > scale)) return scale;
  return Math.min(areaSize, scale * AREA_EFFECT_SIZE_MAX_GROWTH);
}
/** Below this a missile is not worth flying: it arrives the frame it leaves. */
export const MISSILE_MIN_SECONDS = 0.05;
/** Above this it is not a missile any more, it is scenery. Caps a long shot across a valley. */
export const MISSILE_MAX_SECONDS = 4;
/** One corpus-wide fallback for authored missile models whose Spell.Speed is zero. */
export const MISSILE_FALLBACK_SPEED = 24;
/** A persistent area with no finite SpellDuration still gets a bounded visual lifetime. */
export const PERSISTENT_AREA_FALLBACK_MS = 1_000;
// 05.10-A7a-E (6.12): MISSILE_ARC (an invented 0.08 bow) is gone. Wow.exe flies a missile straight at the
// target's current point and bows it only by its SpellMissileMotion script (MissileFlight.ts).
/** The chest: where a missile is aimed on its target (MissileDestinationAttachment is not settled, 6.12). */
export const MISSILE_TARGET_ATTACHMENT = 34;
/** SpellMissileMotion.MissileCount is 1…10 on this dataset; never more instances than this per target. */
export const MISSILE_COUNT_MAX = 10;

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
  /**
   * A missile flies from one to the other over its whole life. 05.10-A7a-E (6.12): `from`/`to` are the
   * fallbacks; the renderer launches from `launch`'s attachment and homes on `target`'s (MissileFlight.ts).
   */
  flight?: MissileFlightPlan;
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
  /** 05.10-6.21: a kit AnimID wound, chosen by Wow.exe's flinch rule when queued (game/AnimationSplit.ts). */
  kitWound?: true;
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
  /**
   * Which of the unit's action layers the pose belongs to: the phase decides it, and the layer
   * decides what it may interrupt (see `UnitActionArbiter.ts`). Absent only on hand-authored plans.
   */
  layer?: UnitActionLayer;
  /** 05.10-6.21: `animation` is a kit AnimID wound (see {@link VisualAnimationFollowUp.kitWound}). */
  kitWound?: true;
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

/**
 * The authored model paths of a set of phases, in the order a cast needs them.
 *
 * Prefetch is the one consumer that wants paths without a plan: nothing is placed, nothing is
 * timed, and the answer is wanted before the cast even happens. Keeping the walk here — beside the
 * planner that reads the same fields — means the warm-up and the draw can never disagree about
 * which files a kit is made of.
 */
export type SpellVisualPhase =
  | SpellVisualMetadata["cast"]
  | SpellVisualMetadata["missile"];

export function spellVisualPhasePaths(phases: readonly SpellVisualPhase[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  const add = (path: string): void => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };
  for (const phase of phases) {
    if (!phase) continue;
    // A missile is one authored file; every other phase is a kit of up to twelve effect columns.
    if ("path" in phase) add(phase.path);
    else for (const effect of phase.effects) add(effect.path);
  }
  return paths;
}

/** Every phase a spell can show, in the order a normal cast is most likely to need them. */
export function spellVisualAllPhases(visual: SpellVisualMetadata): SpellVisualPhase[] {
  return [
    visual.precast, visual.cast, visual.channel, visual.missileTargeting,
    visual.missile, visual.impact, visual.casterImpact, visual.targetImpact,
    visual.instantArea, visual.impactArea, visual.persistentArea, visual.state, visual.stateDone,
  ];
}

/**
 * What a cast that has just started is about to draw, caster and target side alike.
 *
 * `castTime` is the head start this list exists to spend: the flourish is needed when the bar
 * fills, the bolt and both impacts one packet later. The aura phases are deliberately absent —
 * they belong to {@link spellAuraPrewarmPaths}, which a different packet drives.
 */
export function spellCastPrewarmPaths(visual: SpellVisualMetadata): string[] {
  return spellVisualPhasePaths([
    visual.precast, visual.cast, visual.channel, visual.missileTargeting, visual.missile,
    visual.impact, visual.casterImpact, visual.targetImpact,
    visual.instantArea, visual.impactArea, visual.persistentArea,
  ]);
}

/** What an aura application is about to draw: its persistent state, and the flash when it ends. */
export function spellAuraPrewarmPaths(visual: SpellVisualMetadata): string[] {
  return spellVisualPhasePaths([visual.state, visual.stateDone]);
}

/** 05.10-A7a-E (6.13): a kit's camera shakes, from where its unit stood, at an absolute time. */
export interface VisualShake {
  shakes: readonly SpellVisualShake[];
  point: Point;
  at: number;
}

export interface SpellVisualPlan {
  instances: VisualInstance[];
  animations: VisualAnimation[];
  sounds: VisualSound[];
  /** 05.10-A7a-E (6.13): chain beams (ChainBeam.ts); absent when the plan has none. */
  beams?: VisualBeam[];
  /** 05.10-A7a-E (6.13): camera shakes (CameraShake.ts); absent when the plan has none. */
  shakes?: VisualShake[];
}

/** 05.10-A7a-E (6.13): beam ends — the caster's spell hand for a cast, its chest for a channel, the target's chest. */
export const BEAM_CAST_ATTACHMENT = 22;
export const BEAM_CHEST_ATTACHMENT = 34;

/**
 * 05.10-A7a-E (6.13): a caster-side kit's beams to the cast's targets, in the order the packet lists them,
 * each target the start of the next segment (Chain Lightning's jumps; a hypothesis for the multi-target
 * case). A static target (guid 0) ends the band at its point.
 */
function addBeams(
  plan: SpellVisualPlan,
  kit: SpellVisualKit | undefined,
  caster: bigint,
  casterPoint: Point,
  targets: readonly { guid: bigint; point: Point }[],
  startedAt: number,
  endsAt: number,
): void {
  if (!kit?.chains || kit.chains.length === 0 || caster === 0n || targets.length === 0) return;
  const beams = (plan.beams ??= []);
  for (const chain of kit.chains) {
    let from: VisualBeam["from"] = { guid: caster, attachment: BEAM_CAST_ATTACHMENT, point: { ...casterPoint } };
    for (const target of targets) {
      const to = target.guid !== 0n
        ? { guid: target.guid, attachment: BEAM_CHEST_ATTACHMENT, point: { ...target.point } }
        : { attachment: BEAM_CHEST_ATTACHMENT, point: { ...target.point } };
      beams.push({ effect: chain.effect, from, to, startedAt, endsAt });
      if (target.guid === 0n) break;
      from = { guid: target.guid, attachment: BEAM_CHEST_ATTACHMENT, point: { ...target.point } };
    }
  }
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
 * Where a missile is, `progress` of the way along the straight line (05.10-A7a-E: no bow; the renderer
 * flies missiles with MissileFlight.ts, this stays for callers that only want the line).
 */
export function missilePoint(from: Point, to: Point, progress: number, out: Point): Point {
  const t = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  out.x = from.x + (to.x - from.x) * t;
  out.y = from.y + (to.y - from.y) * t;
  out.z = from.z + (to.z - from.z) * t;
  return out;
}

/** The direction of that line, in the same server frame as its endpoints (05.10-A7a-E: no bow). */
export function missileDirection(from: Point, to: Point, _progress: number, out: Point): Point {
  out.x = to.x - from.x;
  out.y = to.y - from.y;
  out.z = to.z - from.z;
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
    // The one place `AreaEffectSize` is read: these three columns are what the field is about.
    scale: areaEffectScale(effect.scale, effect.areaSize),
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
  layer: UnitActionLayer,
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
  if (kit.shake) (plan.shakes ??= []).push({ shakes: kit.shake, point: { ...at }, at: startedAt }); // 05.10-A7a-E
  // Synthetic target 0 is a static point, not a unit the renderer can animate. Keep its
  // world-bound effects and sound, but never enqueue a unit action for a GUID that has no model.
  if (guid !== 0n && includeAnimation) {
    plan.animations.push(...kitAnimations(kit, guid, startedAt, Math.max(0, endsAt - startedAt), mode, layer));
  }
  if (kit.sound > 0) plan.sounds.push({ sound: kit.sound, point: { ...at }, at: startedAt });
}

/**
 * An area kit's models and sound, and deliberately no pose.
 *
 * The three area columns place their models on the ground, and their `AnimID` names no unit: the
 * one this used to go to was the caster. 11 spell rows carry `StartAnimID` 0 in an ImpactAreaKit
 * and 36/28/22 carry `AnimID` 0 in the instant/impact/persistent columns; among them Corpse
 * Explosion's damage row 50444, which stood its own caster in a 2.5 s Stand clip after every
 * explosion.
 */
function addAreaKit(
  plan: SpellVisualPlan,
  kit: SpellVisualKit | undefined,
  at: Point,
  startedAt: number,
  endsAt: number,
  fitToModel = true,
  modelPlayback: VisualModelPlayback = "once",
): void {
  if (!kit) return;
  plan.instances.push(...areaKitInstances(kit, at, startedAt, endsAt, fitToModel, modelPlayback));
  if (kit.shake) (plan.shakes ??= []).push({ shakes: kit.shake, point: { ...at }, at: startedAt }); // 05.10-A7a-E
  if (kit.sound > 0) plan.sounds.push({ sound: kit.sound, point: { ...at }, at: startedAt });
}

/** 05.10-A7a-G2 6.05б: a DynamicObject's PersistentAreaKit at its point, held until the object goes (DynamicObjectVisual.ts). */
export function planPersistentArea(visual: SpellVisualMetadata, at: Point, now: number): SpellVisualPlan {
  const plan: SpellVisualPlan = { instances: [], animations: [], sounds: [] };
  addAreaKit(plan, visual.persistentArea, at, now, Number.POSITIVE_INFINITY, false, "hold");
  return plan;
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

/**
 * Whether a kit animation column names a pose at all.
 *
 * −1 is the table's "none", and 0 is too: it is Stand, which is what the unit is doing whenever
 * nothing else is asked of it, and every kit that names it names it where there is nothing to pose.
 * The whole Death Knight kit carries `StartAnimID` 0 with `AnimID` −1 on its ImpactKit — 163 spells,
 * 55 of them learnable: Icy Touch, Death Coil, Blood/Heart/Frost Strike, Obliterate, Blood Boil,
 * Strangulate, Mind Freeze, the three presences — and played as a pose it stood every target in a
 * full-body 2.67 s Stand clip that stopped its swings and slid it across the ground when it moved.
 */
export function kitNamesPose(animation: number): boolean {
  return animation > 0;
}

/** The animation a kit asks its unit for, if it asks for one, in the layer its phase belongs to. */
export function kitAnimations(
  kit: SpellVisualKit,
  guid: bigint,
  at: number,
  hold: number,
  mode: VisualAnimationMode,
  layer: UnitActionLayer,
): VisualAnimation[] {
  const primaryHold = mode === "hold" ? hold : 0;
  const start = kitNamesPose(kit.startAnimation);
  const primary = kitNamesPose(kit.animation);
  // 05.10-6.21: Wow.exe 0x73b140 hands a non-state kit's AnimID wound (8..10) to the flinch chooser.
  const wound = primary && layer !== "state" && kitWoundBehavior(kit.animation) ? { kitWound: true as const } : {};
  if (start && primary) {
    return [{
      guid,
      animation: kit.startAnimation,
      at,
      hold: 0,
      mode: "once",
      followUp: { animation: kit.animation, mode, hold: primaryHold, ...wound }, // 05.10-6.21
      layer,
    }];
  }
  if (primary) return [{ guid, animation: kit.animation, at, hold: primaryHold, mode, layer, ...wound }]; // 05.10-6.21
  if (start) return [{ guid, animation: kit.startAnimation, at, hold: 0, mode: "once", layer }];
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

  addKit(plan, visual.cast, "cast", cast.caster, cast.casterPoint, now, now + CAST_KIT_MS,
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
        // 05.10-A7a-E (6.12): from the caster's missile attachment to the target's chest, homing, with
        // the motion script; MissileCount missiles per target, each with its own index.
        const missile = visual.missile;
        const count = Math.min(MISSILE_COUNT_MAX, Math.max(1, missile.motion?.count ?? 1));
        for (let missileIndex = 0; missileIndex < count; missileIndex++) {
          plan.instances.push({
            path: missile.path,
            scale: missile.scale,
            attachment: missile.attachment,
            flight: {
              from: { ...cast.casterPoint },
              to: { ...target.point },
              ...(cast.caster !== 0n ? { launch: { guid: cast.caster, attachment: missile.attachment } } : {}),
              ...(target.guid !== 0n ? { target: { guid: target.guid, attachment: MISSILE_TARGET_ATTACHMENT } } : {}),
              ...(missile.motion ? { motion: missile.motion } : {}),
              missileIndex,
              missileCount: count,
              spellId: visual.id,
            },
            startedAt: now,
            endsAt: arrival,
            modelPlayback: "hold",
          });
        }
      }
    }
    const targetingEnd = arrival > now ? arrival : now + IMPACT_KIT_MS;
    addKit(plan, visual.missileTargeting, "reaction", target.guid, target.point, now, targetingEnd,
      true, "hold", false, "hold");
    addKit(plan, visual.impact, "reaction", target.guid, target.point, arrival, arrival + IMPACT_KIT_MS,
      true, "once", true);
    addKit(plan, visual.targetImpact, "reaction", target.guid, target.point, arrival, arrival + IMPACT_KIT_MS,
      true, "once", true);
  }

  // 05.10-A7a-E (6.13): beams of the cast kit (Chain Lightning 321 → 743) over the flourish, and of the
  // impact kits from the caster to each target over its impact window.
  addBeams(plan, visual.cast, cast.caster, cast.casterPoint, cast.targets, now, now + CAST_KIT_MS);
  cast.targets.forEach((target, index) => {
    const arrival = arrivals[index]!;
    for (const kit of [visual.impact, visual.targetImpact]) {
      addBeams(plan, kit, cast.caster, cast.casterPoint, [target], arrival, arrival + IMPACT_KIT_MS);
    }
  });

  const point = areaPoint(cast);
  const firstImpact = arrivals.length > 0 ? Math.min(...arrivals) : now;
  // CasterImpactKit is the caster-side half of an impact, so it shares the first actual arrival
  // with TargetImpactKit.  With no targets the cast itself is the only meaningful impact.
  addKit(plan, visual.casterImpact, "reaction", cast.caster, cast.casterPoint, firstImpact,
    firstImpact + IMPACT_KIT_MS, true, "once", true);
  addAreaKit(plan, visual.instantArea, point, now, now + IMPACT_KIT_MS, true);
  addAreaKit(plan, visual.impactArea, point, firstImpact, firstImpact + IMPACT_KIT_MS, true);
  const persistentDuration = visual.durationMs && visual.durationMs > 0
    ? visual.durationMs
    : PERSISTENT_AREA_FALLBACK_MS;
  addAreaKit(plan, visual.persistentArea, point, firstImpact, firstImpact + persistentDuration,
    false, "hold");
  return plan;
}

/**
 * Plan the body/channel visual emitted by SMSG_SPELL_START or MSG_CHANNEL_START.
 *
 * The stance lasts the cast time plus {@link CAST_END_GRACE_MS}: the end packet, not the bar, is
 * what finishes it. A channel whose ChannelKit names no pose holds its CastKit's pose instead —
 * 212 channel rows are authored that way (Eagle Eye and Far Sight put ChannelCastOmni on the cast
 * kit, NPC Whirlwind channels Whirlwind), and the one-shot SPELL_GO plays for them used to be the
 * only pose of a channel that runs for seconds. 85 of the 212 cast kits name a release pose
 * (SpellCastDirected/Omni), which this loops for the channel; whether the native client does the
 * same is not verified. (05.10-6.21: "212/85" is not reproducible; measured on this dataset: 184 rows
 * with a pose on the cast kit and none on the channel kit among channelled spells, 88 of them
 * SpellCast*; or 45/24 counting SpellVisual rows with a ChannelKit — docs/implementation/line-A10.ru.md.)
 */
export function planSpellCastStart(visual: SpellVisualMetadata, cast: SpellCast, now: number): SpellVisualPlan {
  const plan: SpellVisualPlan = { instances: [], animations: [], sounds: [] };
  const kit = cast.channel ? visual.channel : visual.precast;
  const duration = (cast.castTime !== undefined && cast.castTime > 0 ? cast.castTime : CAST_KIT_MS)
    + CAST_END_GRACE_MS;
  addKit(plan, kit, "cast", cast.caster, cast.casterPoint, now, now + duration, true, "hold", false, "hold");
  // 05.10-A7a-E (6.13): a channel kit's beams (Drain Life 11762 → 719, Mind Flay 11744 → 750, Drain Mana
  // 430 → 744, Drain Soul 950 → 723) run from the caster's chest to its channel object, read every frame.
  if (cast.channel && cast.caster !== 0n && kit?.chains) {
    const beams = (plan.beams ??= []);
    for (const chain of kit.chains) {
      beams.push({
        effect: chain.effect,
        from: { guid: cast.caster, attachment: BEAM_CHEST_ATTACHMENT, point: { ...cast.casterPoint } },
        to: { channelOf: cast.caster, attachment: BEAM_CHEST_ATTACHMENT },
        startedAt: now,
        endsAt: now + duration,
      });
    }
  }
  if (cast.channel && cast.caster !== 0n && !kitPoses(visual.channel) && visual.cast && kitPoses(visual.cast)) {
    // The pose only: the cast kit's models and sound already played with SPELL_GO.
    plan.animations.push(...kitAnimations(visual.cast, cast.caster, now, duration, "hold", "cast"));
  }
  return plan;
}

function kitPoses(kit: SpellVisualKit | undefined): boolean {
  return kit !== undefined && (kitNamesPose(kit.startAnimation) || kitNamesPose(kit.animation));
}

/** Plan a StateKit for an aura; `endsAt` is normally the aura's expiresAt or infinity until removal. */
export function planSpellAuraState(
  visual: SpellVisualMetadata,
  target: { guid: bigint; point: Point },
  now: number,
  endsAt = Number.POSITIVE_INFINITY,
): SpellVisualPlan {
  const plan: SpellVisualPlan = { instances: [], animations: [], sounds: [] };
  addKit(plan, visual.state, "state", target.guid, target.point, now, Math.max(now, endsAt), true, "hold", false, "hold");
  return plan;
}

/** Plan the finite effect/sound emitted when an aura carrying StateDoneKit is actually removed. */
export function planSpellAuraDone(
  visual: SpellVisualMetadata,
  target: { guid: bigint; point: Point },
  now: number,
): SpellVisualPlan {
  const plan: SpellVisualPlan = { instances: [], animations: [], sounds: [] };
  addKit(plan, visual.stateDone, "state", target.guid, target.point, now, now + IMPACT_KIT_MS, true, "once", true);
  return plan;
}

/**
 * Everything one kit shows when the server names it by number and says nothing else.
 *
 * The whole packet is a GUID, a kit id and which of the two opcodes it arrived on, so this is the
 * smallest planner in the file: one kit, on one unit, over one bounded window. It goes through the
 * same `addKit` as every phase of a cast, which is what makes the kit's attachments, its
 * `StartAnimID`→`AnimID` pair and its `SoundID` behave here exactly as they do inside a spell.
 *
 * `guid` 0 is refused rather than drawn at the world origin: a kit packet always names a unit, and
 * a unit the client has not got is a unit whose position is unknown.
 */
export function planSpellVisualKitEvent(
  kit: SpellVisualKit,
  target: { guid: bigint; point: Point },
  now: number,
  impact = false,
): SpellVisualPlan {
  const plan: SpellVisualPlan = { instances: [], animations: [], sounds: [] };
  if (target.guid === 0n) return plan;
  const endsAt = now + (impact ? IMPACT_KIT_MS : PACKET_KIT_MS);
  // A scripted kit is a gesture — sitting down to eat, a boss flourish — and an impact kit a hit;
  // neither is a cast, and neither may interrupt one.
  addKit(plan, kit, impact ? "reaction" : "emote", target.guid, target.point, now, endsAt, true, "once", true);
  return plan;
}

/** The models one kit is made of — the prewarm seam for a kit that arrived on its own. */
export function spellVisualKitPaths(kit: SpellVisualKit | undefined): string[] {
  return spellVisualPhasePaths([kit]);
}

/** Which of these are over. Kept separate so the renderer's sweep is one call and one rule. */
export function expiredInstances(instances: readonly VisualInstance[], now: number): number[] {
  const done: number[] = [];
  for (let index = 0; index < instances.length; index++) {
    if (instances[index]!.endsAt <= now) done.push(index);
  }
  return done;
}
