/**
 * 15.11 (7.50): a lamp whose light is animated — its glow card's weight, alpha or colour, its flame's
 * `enabledIn`/emission rate, its M2 light's visibility, strength or colour keyed over time — carries those
 * tracks in its template (`LightTemplates.ts`), so an unbuilt placement lights at a moment exactly as the
 * built one does at that moment.
 *
 * The clock. A doodad's batch tracks are drawn on the frame clock: its materials are its build's, shared by
 * every placement (`ModelBuild.ts` `AnimatedBatch`), and `WorldRenderer3D.#updateBatchColours(now)` moves
 * them with the world time, wrapping a sequence-keyed track on its own span (`sampleTrack`). The glow card of
 * `BE_LampPost_Ghostlands01.m2` (weight keyed on sequence 0: dark 0–667 ms, 0.7 at 800, … over 5 s) blinks
 * on that clock, on every placement in step. A built doodad's light is sampled on that same clock, so the
 * light follows the card the player sees and every placement's phase is known before it is built: the
 * prelit stand-in and the built lamp sample the same tracks at the same time, and nothing changes on screen
 * when the model arrives. (Its bones may still swing on the placement's own mixer: the light's position is
 * the bone's, its strength the clock's.) Wow.exe keeps a sequence time per model instance; when an instance's
 * time starts is not established here, and this client cannot draw a per-placement phase with shared
 * materials anyway.
 *
 * The far glow is a static list (`FarLightGlows.ts`, rebuilt only when placements change), so an animated
 * lamp glows from afar at its average over one period (`FAR_GLOW_MOTION_SAMPLES` evenly spaced moments):
 * the same light energy as the blinking lamp gives over time, steady at 48–280 yards where a blink is a
 * pixel or two, and the same for a built and an unbuilt placement. Before 15.11 both sampled time 0, where
 * the Ghostlands post is dark, so it never had a far glow. The mean is the tracks' alone, kept per motion;
 * the placement only adds the heuristic's flicker at time 0, as a steady lamp's far glow has it.
 *
 * Per frame (lamps7 follow-up): a template is sampled once a frame and shared by all its placements
 * (`PrelitLights.ts` `MotionSlot`); a dark moment keeps the light ranked at strength 0
 * (`sampleFixtureLightKept`, and the prelit list likewise), so a blink does not reshuffle the near set.
 */
import * as THREE from "three";
import {
  FIXTURE_RADIUS_CAP, M2_LIGHT_RADIUS_CAP, fixtureFlicker, sampleFixtureLight, type FixtureLight, type LocalLightSample,
} from "./LocalLighting.js";
import { sampleRamp, sampleTrack } from "./Particles.js";
import type { WvmModel, WvmTrack } from "./Wvm.js";

/** Which of `sampleFixtureLight`'s three kinds the tracks belong to. */
export type LightMotionKind = "card" | "emitter" | "light";

/**
 * A fixture's time-dependent tracks, only the first sub-track of each (what `sampleFixtureLight` reads):
 * card — texture weight, colour alpha, colour rgb; emitter — `enabledIn`, emission rate; light —
 * visibility, diffuse intensity, diffuse colour. Null where the fixture has no such track.
 */
export interface LightMotion {
  readonly kind: LightMotionKind;
  readonly tracks: readonly (WvmTrack | null)[];
  readonly globalSequences: Uint32Array;
}

/** Moments over one period an animated lamp's far glow averages. */
export const FAR_GLOW_MOTION_SAMPLES = 64;

/** Whether `sampleTrack` answers differently at different times: more than one key in the sub-track it reads. */
function animated(track: WvmTrack | undefined): boolean {
  return track !== undefined && (track.tracks[0]?.times.length ?? 0) > 1;
}

/** The first sub-track only, copied: the template outlives the model. */
function firstTrack(track: WvmTrack | undefined): WvmTrack | null {
  const sub = track?.tracks[0];
  if (!track || !sub) return null;
  return {
    interpolation: track.interpolation, globalSequence: track.globalSequence, components: track.components,
    tracks: [{ sequence: sub.sequence, times: Uint32Array.from(sub.times), values: Float32Array.from(sub.values) }],
  };
}

/** The tracks `sampleFixtureLight` reads for `fixture`, by kind. */
function fixtureTracks(fixture: FixtureLight, model: WvmModel): { kind: LightMotionKind; tracks: (WvmTrack | undefined)[] } | undefined {
  if (fixture.light) {
    return { kind: "light", tracks: [fixture.light.visibility, fixture.light.diffuseIntensity, fixture.light.diffuseColor] };
  }
  if (fixture.batch) {
    const colour = model.colours[fixture.batch.colorIndex];
    return { kind: "card", tracks: [model.textureWeights[fixture.batch.textureWeight], colour?.alpha, colour?.rgb] };
  }
  if (fixture.emitter) return { kind: "emitter", tracks: [fixture.emitter.enabledIn, fixture.emitter.emissionRate] };
  return undefined;
}

const MOTIONS = new WeakMap<FixtureLight, LightMotion | null>();

/** The fixture's animated tracks, or undefined when its light is the same at every moment. Cached per fixture. */
export function fixtureMotion(fixture: FixtureLight, model: WvmModel): LightMotion | undefined {
  const known = MOTIONS.get(fixture);
  if (known !== undefined) return known ?? undefined;
  const read = fixtureTracks(fixture, model);
  let motion: LightMotion | null = null;
  if (read && read.tracks.some(animated)) {
    motion = { kind: read.kind, tracks: read.tracks.map(firstTrack), globalSequences: Uint32Array.from(model.globalSequences) };
  }
  MOTIONS.set(fixture, motion);
  return motion ?? undefined;
}

const emitterColour = [1, 1, 1];
const emitterOpacity = [1];

/**
 * An emitter fixture's colour and strength apart from its gate (`enabledIn`, emission rate), as
 * `sampleFixtureLight` takes them from its life ramps at 0.2; undefined when the ramp leaves it dark.
 */
export function emitterFixtureBase(fixture: FixtureLight): { colour: [number, number, number]; intensity: number } | undefined {
  const emitter = fixture.emitter;
  if (!emitter) return undefined;
  const colour: [number, number, number] = [fixture.colour[0], fixture.colour[1], fixture.colour[2]];
  const ramp = sampleRamp(emitter.color, 0.2, emitterColour, 1);
  const peak = Math.max(ramp[0]!, ramp[1]!, ramp[2]!);
  if (peak > 0) {
    colour[0] = ramp[0]! / peak;
    colour[1] = ramp[1]! / peak;
    colour[2] = ramp[2]! / peak;
  }
  const opacity = sampleRamp(emitter.opacity, 0.2, emitterOpacity, 1)[0]!;
  if (!Number.isFinite(opacity) || opacity <= 0.001) return undefined;
  return { colour, intensity: fixture.intensity * Math.min(1, opacity) };
}

/** What a motion gives at a moment: colour and strength before the heuristic's flicker. */
export interface MotionValue {
  readonly colour: THREE.Vector3;
  intensity: number;
}

/**
 * The animated light at (`animationMs`, `worldMs`) from its base colour and strength (the template's), as
 * `sampleFixtureLight` computes it; false while it is dark.
 */
export function sampleMotion(motion: LightMotion, colour: readonly [number, number, number], intensity: number,
  animationMs: number, worldMs: number, out: MotionValue): boolean {
  // No closure here: an animated lamp is sampled every frame (allocation-free, lamps7 follow-up).
  const t = motion.tracks, g = motion.globalSequences;
  if (motion.kind === "light") {
    if (sampleTrack(t[0] ?? undefined, animationMs, worldMs, g, 1) <= 0) return false;
    const strength = sampleTrack(t[1] ?? undefined, animationMs, worldMs, g, 1);
    if (!(strength > 0.001)) return false;
    out.colour.set(sampleTrack(t[2] ?? undefined, animationMs, worldMs, g, 1, 0),
      sampleTrack(t[2] ?? undefined, animationMs, worldMs, g, 1, 1), sampleTrack(t[2] ?? undefined, animationMs, worldMs, g, 1, 2));
    out.intensity = Math.min(2, strength);
    return Number.isFinite(out.colour.x) && Number.isFinite(out.colour.y) && Number.isFinite(out.colour.z);
  }
  out.colour.set(colour[0], colour[1], colour[2]);
  if (motion.kind === "emitter") {
    if (sampleTrack(t[0] ?? undefined, animationMs, worldMs, g, 1) <= 0.5
      || sampleTrack(t[1] ?? undefined, animationMs, worldMs, g, 0) <= 0) return false;
    out.intensity = intensity;
    return true;
  }
  const opacity = sampleTrack(t[0] ?? undefined, animationMs, worldMs, g, 1) * sampleTrack(t[1] ?? undefined, animationMs, worldMs, g, 1);
  out.colour.x *= sampleTrack(t[2] ?? undefined, animationMs, worldMs, g, 1, 0);
  out.colour.y *= sampleTrack(t[2] ?? undefined, animationMs, worldMs, g, 1, 1);
  out.colour.z *= sampleTrack(t[2] ?? undefined, animationMs, worldMs, g, 1, 2);
  if (!Number.isFinite(opacity) || opacity <= 0.001) return false;
  out.intensity = intensity * Math.min(1, opacity);
  return Number.isFinite(out.intensity)
    && Number.isFinite(out.colour.x) && Number.isFinite(out.colour.y) && Number.isFinite(out.colour.z);
}

/** One period of the motion, milliseconds: the longest loop of its animated tracks (0: none known). */
export function motionPeriod(motion: LightMotion): number {
  let period = 0;
  for (const track of motion.tracks) {
    const sub = track?.tracks[0];
    if (!track || !sub || sub.times.length < 2) continue;
    const loop = track.globalSequence >= 0 ? motion.globalSequences[track.globalSequence] ?? 0
      : sub.times[sub.times.length - 1]! - sub.times[0]!;
    if (loop > period) period = loop;
  }
  return period;
}

/** An animated light's mean over one period, before the heuristic's flicker; null when it is never lit. */
export interface MotionMean {
  readonly colour: readonly [number, number, number];
  readonly intensity: number;
}
const MEANS = new WeakMap<LightMotion, MotionMean | null>();
const meanMoment: MotionValue = { colour: new THREE.Vector3(), intensity: 0 };

/**
 * The motion's colour and strength averaged over one period (`FAR_GLOW_MOTION_SAMPLES` moments; colour × strength
 * is the moments' mean, dark ones counting as 0), from its base colour and strength. Placement-free, so it is
 * computed once per motion and kept (lamps7 follow-up: per placement it cost 64 samples a lamp at every rebuild).
 */
export function motionMean(motion: LightMotion, colour: readonly [number, number, number], intensity: number): MotionMean | undefined {
  const known = MEANS.get(motion);
  if (known !== undefined) return known ?? undefined;
  const period = motionPeriod(motion);
  const moments = period > 0 ? FAR_GLOW_MOTION_SAMPLES : 1;
  let red = 0, green = 0, blue = 0, strength = 0;
  for (let index = 0; index < moments; index++) {
    const ms = period > 0 ? (index + 0.5) * period / FAR_GLOW_MOTION_SAMPLES : 0;
    if (!sampleMotion(motion, colour, intensity, ms, ms, meanMoment)) continue;
    const value = Math.max(0, meanMoment.intensity);
    red += meanMoment.colour.x * value;
    green += meanMoment.colour.y * value;
    blue += meanMoment.colour.z * value;
    strength += value;
  }
  const mean = strength > 0 && Number.isFinite(strength)
    ? { colour: [red / strength, green / strength, blue / strength] as const, intensity: strength / moments } : null;
  MEANS.set(motion, mean);
  return mean ?? undefined;
}

/**
 * The far glow of an animated light at a placement (model-to-world `matrix`): its period's mean colour and
 * strength (`motionMean`), times the heuristic's flicker at time 0 at the placement as a steady lamp's far glow
 * has it; position and reach as `sampleFixtureLight` places them. Built and unbuilt lamps both use this.
 */
export function sampleMotionFar(mean: MotionMean, position: readonly [number, number, number], reach: number, client: boolean,
  matrix: THREE.Matrix4, result: LocalLightSample): boolean {
  const e = matrix.elements;
  result.position.set(position[0], position[1], position[2]).applyMatrix4(matrix);
  const scale = Math.max(Math.hypot(e[0]!, e[1]!, e[2]!), Math.hypot(e[4]!, e[5]!, e[6]!), Math.hypot(e[8]!, e[9]!, e[10]!));
  result.radius = Math.min(client ? M2_LIGHT_RADIUS_CAP : FIXTURE_RADIUS_CAP, reach * scale);
  result.colour.set(mean.colour[0], mean.colour[1], mean.colour[2]);
  result.intensity = client ? mean.intensity : mean.intensity * fixtureFlicker(e[12]!, e[13]!, e[14]!, 0);
  result.client = client;
  result.halo = true;
  return Number.isFinite(result.radius) && result.radius > 0 && Number.isFinite(result.intensity)
    && Number.isFinite(result.position.x) && Number.isFinite(result.position.y) && Number.isFinite(result.position.z);
}

/** An animated fixture's base colour and strength, as its template keeps them (`deriveLightTemplates`). */
export function fixtureMotionBase(fixture: FixtureLight): { colour: [number, number, number]; intensity: number } | undefined {
  return fixture.emitter ? emitterFixtureBase(fixture)
    : { colour: [fixture.colour[0], fixture.colour[1], fixture.colour[2]], intensity: fixture.intensity };
}

/**
 * A built placement's far glow sample of one fixture (`farLightSources`): at time 0 for a steady light, as
 * since 22.10; an animated one's period mean (`sampleMotionFar`).
 */
export function sampleFixtureFarLight(fixture: FixtureLight, model: WvmModel, matrix: THREE.Matrix4,
  result: LocalLightSample): boolean {
  const motion = fixtureMotion(fixture, model);
  if (!motion) return sampleFixtureLight(fixture, model, matrix, 0, 0, result);
  const base = fixtureMotionBase(fixture);
  const mean = base && motionMean(motion, base.colour, base.intensity);
  return mean !== undefined && sampleMotionFar(mean, fixture.position, fixture.radius, fixture.light !== undefined, matrix, result);
}

const CAN_LIGHT = new WeakMap<FixtureLight, boolean>();
/** Whether an animated fixture has a template at all (a flame whose own ramp leaves it dark has none). Cached. */
function fixtureCanLight(fixture: FixtureLight): boolean {
  let answer = CAN_LIGHT.get(fixture);
  if (answer === undefined) {
    answer = !fixture.emitter || emitterFixtureBase(fixture) !== undefined;
    CAN_LIGHT.set(fixture, answer);
  }
  return answer;
}

/**
 * lamps7 follow-up (15.11, 7.50): a built lamp's near-light sample that keeps an animated light in the
 * selection through its dark moments, at strength 0. `LocalLightSelection` ranks the nearest twelve and
 * fades every selected light towards the first one left out; a blinking lamp that left the ranking while
 * dark (`BE_LampPost_Ghostlands01.m2`: 40 % of each 5 s loop) let the next lamp in and moved that cut, so
 * every other selected pool and the screen-space pools' shares stepped twice a blink. A steady light dark
 * at this moment (never lit) is still left out.
 */
export function sampleFixtureLightKept(fixture: FixtureLight, model: WvmModel, matrix: THREE.Matrix4,
  animationMs: number, worldMs: number, result: LocalLightSample): boolean {
  if (sampleFixtureLight(fixture, model, matrix, animationMs, worldMs, result)) return true;
  if (!fixtureMotion(fixture, model) || !fixtureCanLight(fixture)) return false;
  result.position.set(fixture.position[0], fixture.position[1], fixture.position[2]).applyMatrix4(matrix);
  const e = matrix.elements;
  const scale = Math.max(Math.hypot(e[0]!, e[1]!, e[2]!), Math.hypot(e[4]!, e[5]!, e[6]!),
    Math.hypot(e[8]!, e[9]!, e[10]!));
  const client = fixture.light !== undefined;
  result.radius = Math.min(client ? M2_LIGHT_RADIUS_CAP : FIXTURE_RADIUS_CAP, fixture.radius * scale);
  result.intensity = 0;
  result.client = client;
  result.halo = true;
  return Number.isFinite(result.radius) && result.radius > 0
    && Number.isFinite(result.position.x) && Number.isFinite(result.position.y) && Number.isFinite(result.position.z);
}

/** Whether a stored track is well formed; typed or plain arrays (the persistent record is read back untyped). */
function reviveTrack(value: unknown): WvmTrack | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const track = value as Partial<Record<keyof WvmTrack, unknown>>;
  if (![track.interpolation, track.globalSequence, track.components].every((n) => typeof n === "number" && Number.isInteger(n))) {
    return undefined;
  }
  if (!Array.isArray(track.tracks) || track.tracks.length !== 1) return undefined;
  const sub = track.tracks[0] as { sequence?: unknown; times?: unknown; values?: unknown } | null;
  const numbers = (list: unknown): list is ArrayLike<number> => (Array.isArray(list) || ArrayBuffer.isView(list))
    && Array.prototype.every.call(list, (n: unknown) => typeof n === "number" && Number.isFinite(n));
  if (!sub || typeof sub.sequence !== "number" || !numbers(sub.times) || !numbers(sub.values)
    || sub.times.length > 4096 || sub.values.length !== sub.times.length * Math.max(1, track.components as number)) return undefined;
  return {
    interpolation: track.interpolation as number, globalSequence: track.globalSequence as number,
    components: track.components as number,
    tracks: [{ sequence: sub.sequence, times: Uint32Array.from(sub.times), values: Float32Array.from(sub.values) }],
  };
}

/** A stored motion, revived with typed arrays; undefined when it is not one. */
export function reviveLightMotion(value: unknown): LightMotion | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const stored = value as { kind?: unknown; tracks?: unknown; globalSequences?: unknown };
  const sizes = { card: 3, emitter: 2, light: 3 } as const;
  if (stored.kind !== "card" && stored.kind !== "emitter" && stored.kind !== "light") return undefined;
  if (!Array.isArray(stored.tracks) || stored.tracks.length !== sizes[stored.kind]) return undefined;
  const sequences = stored.globalSequences;
  if (!(Array.isArray(sequences) || sequences instanceof Uint32Array) || sequences.length > 4096
    || !Array.prototype.every.call(sequences, (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0)) return undefined;
  const tracks: (WvmTrack | null)[] = [];
  for (const entry of stored.tracks) {
    const track = reviveTrack(entry);
    if (track === undefined) return undefined;
    tracks.push(track);
  }
  return { kind: stored.kind, tracks, globalSequences: Uint32Array.from(sequences as ArrayLike<number>) };
}
