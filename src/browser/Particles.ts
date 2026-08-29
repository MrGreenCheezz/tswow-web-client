// Running the emitters the artifact carries, and turning them into triangles.
//
// Nothing here touches three.js or the DOM: an emitter is stepped with a time step and a matrix,
// and its particles are written into flat arrays a caller can hand to a buffer geometry. That is
// what lets the whole simulation be tested against the real client's own files rather than only
// against a screenshot.
//
// The byte layout below was established from four independent references and checked against the
// client itself, which remains the authority for most runtime behaviour. The corpus is every
// emitter the game ships: 22,071 models at version 264, 25,201 particle emitters
// and 1,502 ribbons. Where a documented rule and that corpus disagree, the corpus wins and the
// disagreement is written down at the place it is decided.
//
// Three of those disagreements matter enough to name here:
//
//   * `zSource`. The wiki says the initial velocity is `(position - (0, 0, zSource)).Normalize()`.
//     Every emitter of `6fx_bonfire.m2` sets `zSource` to 255, and 255 is so far above the spawn
//     ring that this formula gives very nearly (0, 0, −1): a bonfire whose flames go into the
//     ground. The sign is the other way round. It is a small correction in practice — `zSource` is
//     zero on 8,434 of the client's own 8,692 emitters under `spells\` and `creature\` — but the
//     ones that set it are the fires.
//   * There is no head-or-tail choice to make. The layout gives byte 0x2D of the record as
//     `headorTail`, an enum of 0, 1 and 2 — and the byte does not hold one. Across the 26 emitters
//     of the local models it takes the values 0, 4, 6, 8, 9, 16, 19, 24 and 32, and an enum of
//     three does not produce 24. Those numbers are `fp_2_5` fixed point — 0, 1/8, 3/16, 1/4, 9/32,
//     1/2, 19/32, 3/4 and 1 — which is what sits at that offset from Burning Crusade onwards:
//     `multiTextureParamX`. So every emitter draws a head, and which of them also draws a streak
//     is the `PINNED` flag, which is a flag and means what it says. `tailLength` is read, but for
//     how long that streak may be rather than for whether there is one: it is the length in
//     *seconds of flight* at the particle's current speed, and it caps a quad that would otherwise
//     run from the birthplace to wherever the particle had got to (`:862-884`).
//   * `verticalRange` measures from a different zero on each generator, because each generator's
//     natural zero is different. On a plane it is the half-angle off the plane's normal, so zero
//     is a beam straight up — which is what `sunwell_beamfx.m2` is. On a sphere it is the latitude
//     band around the equator, so zero is a ring in the emitter's own XY plane — which is what a
//     campfire's flames rise from. Reading the sphere the plane's way puts every one of the
//     bonfire's particles on a single point above the fire.

import type { WvmParticleEmitter, WvmRamp, WvmRibbonEmitter, WvmTrack } from "./Wvm.js";

/**
 * `M2Particle.flags`, and only the bits this simulation acts on.
 *
 * The published table is not wholly trustworthy and the client says so itself: it names 0x1 "lit"
 * and 0x20 "unlightning", and 13,092 of the client's 25,201 emitters — 52% — set both at once.
 * Two mutually exclusive names on the same emitter means at least one of them is on the wrong
 * bit, so nothing here is decided by either. What is acted on is chosen to fail quietly: a
 * misread bit changes how a few emitters look, never whether the frame is drawn.
 *
 * Frequencies, measured across all 25,201: 0x8 on 76.7%, 0x400 on 18.0%, 0x20000 on 83.5%,
 * 0x40000 on 20.4%, 0x40 on 1.5%, 0x80 on 0.6%, 0x80000 on 0.3%. No bit at or above 0x100000 is
 * ever set, which retires the compressed-gravity trap the study called practically important —
 * 0x800000 appears on nothing.
 */
/** Particles rise along world up rather than along the emitter's own. */
export const PARTICLE_FLAG_WORLD_UP = 0x00000008;
/** A pinned emitter still draws particle heads, but deliberately does not stretch them into tails. */
export const PARTICLE_FLAG_DO_NOT_TRAIL = 0x00000010;
export const PARTICLE_FLAG_BURST = 0x00000040;
/** Particles stay in the model's frame, so posing the emitter carries them with it. */
export const PARTICLE_FLAG_MODEL_SPACE = 0x00000080;
/** The quad stretches from where the particle was born to where it is now. Set on 18% of them. */
export const PARTICLE_FLAG_PINNED = 0x00000400;
/** Quads remain in the emitter's local XY plane instead of turning to face the camera. */
export const PARTICLE_FLAG_XY_QUAD = 0x00001000;
export const PARTICLE_FLAG_OUTWARD = 0x00020000;
export const PARTICLE_FLAG_INWARD = 0x00040000;
/** ScaleVary works on x and y separately; without it, x varies both and y is unused. */
export const PARTICLE_FLAG_SCALE_VARY_INDEPENDENT = 0x00080000;
/** Never set on any of the client's emitters, and kept because a private patch may still set it. */
export const PARTICLE_FLAG_RANDOM_FLIPBOOK = 0x00200000;

/** `M2Particle.emitterType`. */
export const EMITTER_PLANE = 1;
export const EMITTER_SPHERE = 2;
export const EMITTER_SPLINE = 3;
export const EMITTER_BONE = 4;


/**
 * How many particles one emitter is allowed to hold at once.
 *
 * An emitter's steady-state population is its peak emission rate times its peak lifespan. Across
 * the client's 25,201 emitters that product has a median of 18 and a ninetieth percentile of 120;
 * 9.5% of emitters want more than 128 and 3.8% more than 256. The tail is very long — the
 * greediest asks for 30,000, which is a number for a cinematic and not for a frame — so the cap
 * is set where it holds 96% of emitters whole and truncates the rest rather than letting one file
 * decide how long a frame takes.
 */
export const EMITTER_CAPACITY = 256;

/**
 * A pseudo-random source that can be replayed.
 *
 * Particles are the one part of the renderer where "run it again and look" is not a test. A
 * seeded generator makes a spawn reproducible, so a test can assert where the first particle of a
 * campfire goes rather than only that some particles exist.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One `M2Track` at a moment.
 *
 * Two clocks meet here. A track bound to a global sequence runs on the world's, wrapped by that
 * loop's own duration — which is what makes a brazier flicker while nobody is near it. Everything
 * else runs on the model's animation, and when nothing is animating the emitter it wraps on the
 * span of its own keys instead of freezing: `Priest_phantasm_base_state.m2` writes its emission
 * rate as `0, 0, 50, 0, 0` across the sequence, and a frozen clock would either never fire or
 * never stop.
 *
 * `sequence` names which of the per-sequence sub-arrays to read, and leaving it out reads the first
 * one there is. Both answers are wanted and they differ: an emitter fills one sub-track or none, so
 * asking it for a sequence it does not carry would put out every fire in the game; a batch's colour
 * is *keyed* on the sequence — the body of every playable model carries its corpse fade under Death
 * and nothing under Stand — so reading the first sub-track there would fade every character out on
 * a loop. A track bound to a global sequence ignores the argument either way: it runs on the
 * world's clock and its keys are in its first sub-array.
 */
export function sampleTrack(
  track: WvmTrack | undefined,
  animationMs: number,
  worldMs: number,
  globalSequences: Uint32Array,
  fallback: number,
  component = 0,
  sequence?: number,
): number {
  if (!track || track.tracks.length === 0) return fallback;
  const sub = sequence === undefined || track.globalSequence >= 0
    ? track.tracks[0]
    : track.tracks.find((candidate) => candidate.sequence === sequence);
  // No keys for the sequence being played is not "invisible": it is "this track says nothing while
  // that plays", and what it says instead is the caller's own default.
  if (!sub) return fallback;
  const keys = sub.times.length;
  if (keys === 0) return fallback;
  const components = Math.max(1, track.components);
  const value = (index: number): number => sub.values[index * components + component] ?? fallback;
  if (keys === 1) return value(0);

  const span = sub.times[keys - 1]! - sub.times[0]!;
  let time: number;
  if (track.globalSequence >= 0) {
    const duration = globalSequences[track.globalSequence] ?? 0;
    time = duration > 0 ? worldMs % duration : worldMs;
  } else {
    time = span > 0 ? sub.times[0]! + (animationMs % span) : animationMs;
  }

  if (time <= sub.times[0]!) return value(0);
  if (time >= sub.times[keys - 1]!) return value(keys - 1);
  let index = 0;
  while (index + 1 < keys && sub.times[index + 1]! <= time) index++;
  const from = sub.times[index]!;
  const to = sub.times[index + 1]!;
  // Interpolation 0 is a step; 1 is linear, and 2 and 3 are Hermite and Bezier, whose tangents the
  // artifact does not carry. Linear is what is left, and it is what the reference clients do too.
  if (track.interpolation === 0 || to <= from) return value(index);
  const fraction = (time - from) / (to - from);
  return value(index) + (value(index + 1) - value(index)) * fraction;
}

/**
 * One `FBlock` at a point in a particle's life, from 0 at birth to 1 at death.
 *
 * There is no interpolation word on an FBlock — the shape has no room for one — so linear it is,
 * with both ends held rather than extrapolated. The wiki guesses that a ramp has three keys for
 * {start, middle, end}: across 21,184 ramps in the client's spell models three is only the mode,
 * and 31% carry some other count — 2, 4, 5, 6, 7, 20, 26 and 32 all occur. A reader that assumed
 * three would lose the shape of one curve in three.
 *
 * The life fraction really is the domain: the first timestamp is 0 on all 21,184 and the last is
 * 32767 on 21,181 of them, the three exceptions holding a single key.
 */
export function sampleRamp(ramp: WvmRamp | undefined, life: number, out: number[], fallback: number): number[] {
  const components = ramp ? Math.max(1, ramp.components) : out.length;
  const keys = ramp ? ramp.times.length : 0;
  for (let part = 0; part < out.length; part++) out[part] = fallback;
  if (!ramp || keys === 0) return out;

  const read = (key: number, part: number): number => ramp.values[key * components + part] ?? fallback;
  const clamped = life < 0 ? 0 : life > 1 ? 1 : life;
  if (keys === 1 || clamped <= ramp.times[0]!) {
    for (let part = 0; part < out.length; part++) out[part] = read(0, Math.min(part, components - 1));
    return out;
  }
  if (clamped >= ramp.times[keys - 1]!) {
    for (let part = 0; part < out.length; part++) out[part] = read(keys - 1, Math.min(part, components - 1));
    return out;
  }
  let index = 0;
  while (index + 1 < keys && ramp.times[index + 1]! <= clamped) index++;
  const from = ramp.times[index]!;
  const to = ramp.times[index + 1]!;
  const fraction = to > from ? (clamped - from) / (to - from) : 0;
  for (let part = 0; part < out.length; part++) {
    const at = Math.min(part, components - 1);
    out[part] = read(index, at) + (read(index + 1, at) - read(index, at)) * fraction;
  }
  return out;
}

/** One live particle. Position and velocity are world space, or emitter space for a model-space emitter. */
export interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Where it was born, for a pinned quad. */
  bx: number; by: number; bz: number;
  age: number;
  life: number;
  /** The scale ramp's two components are multiplied by these, drawn once at birth. */
  scaleX: number;
  scaleY: number;
  /** Radians, and the rate it turns at. */
  spin: number;
  spinRate: number;
  /** Added to whatever cell the head ramp asks for, for a random flip-book start. */
  cellOffset: number;
}

/** The emitter's frame this step: where it is, which way it is facing, and what time it is. */
export interface EmitterFrame {
  /** Column-major 4x4 mapping the emitter's bone space to the scene, i.e. `THREE.Matrix4.elements`. */
  matrix: ArrayLike<number>;
  /** Milliseconds into the model's animation, for tracks that are not on a global sequence. */
  animationMs: number;
  /** Milliseconds on the world's clock, for tracks that are. */
  worldMs: number;
  /** Optional start clocks used only by an explicit async catch-up. */
  animationStartMs?: number;
  worldStartMs?: number;
}

export interface ParticleSystem {
  readonly emitter: WvmParticleEmitter;
  readonly globalSequences: Uint32Array;
  readonly particles: Particle[];
  /** Mutable only so a replay epoch can restore the original deterministic stream in place. */
  random: () => number;
  /** Fractional particles owed from previous steps. */
  pending: number;
  /** Where the emitter's origin was last step, so the follow terms can see it move. */
  originX: number; originY: number; originZ: number;
  placed: boolean;
  /** The last frame's matrix, kept so a model-space emitter can put its particles in the world. */
  matrix: Float64Array;
  /** Particles live in the emitter's frame rather than the world's. */
  readonly modelSpace: boolean;
}

const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function createParticleSystem(
  emitter: WvmParticleEmitter,
  globalSequences: Uint32Array,
  seed = 0x9e3779b9,
): ParticleSystem {
  return {
    emitter,
    globalSequences,
    particles: [],
    random: seededRandom(seed),
    pending: 0,
    originX: 0, originY: 0, originZ: 0,
    placed: false,
    matrix: Float64Array.from(IDENTITY),
    modelSpace: (emitter.flags & PARTICLE_FLAG_MODEL_SPACE) !== 0,
  };
}

/** Rewinds one simulation without replacing any retained typed backing or authored input. */
export function resetParticleSystem(system: ParticleSystem, seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError("particle seed must be a uint32");
  }
  system.particles.length = 0;
  system.random = seededRandom(seed);
  system.pending = 0;
  system.originX = 0;
  system.originY = 0;
  system.originZ = 0;
  system.placed = false;
  system.matrix.set(IDENTITY);
}

/** `matrix * (x, y, z, 1)`, written into `out`. */
function transformPoint(m: ArrayLike<number>, x: number, y: number, z: number, out: number[]): void {
  out[0] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  out[1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  out[2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
}

/** The same without the translation: a direction rather than a place. */
function transformVector(m: ArrayLike<number>, x: number, y: number, z: number, out: number[]): void {
  out[0] = m[0]! * x + m[4]! * y + m[8]! * z;
  out[1] = m[1]! * x + m[5]! * y + m[9]! * z;
  out[2] = m[2]! * x + m[6]! * y + m[10]! * z;
}

/** The inverse of the affine 3x3, used to aim a model-space billboard before applying its scale. */
function inverseTransformVector(
  m: ArrayLike<number>, x: number, y: number, z: number, out: number[],
): boolean {
  const a00 = m[0]!; const a01 = m[4]!; const a02 = m[8]!;
  const a10 = m[1]!; const a11 = m[5]!; const a12 = m[9]!;
  const a20 = m[2]!; const a21 = m[6]!; const a22 = m[10]!;
  const b01 = a22 * a11 - a12 * a21;
  const b11 = a12 * a20 - a10 * a22;
  const b21 = a10 * a21 - a11 * a20;
  const determinant = a00 * b01 + a01 * b11 + a02 * b21;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) return false;
  out[0] = (b01 * x + (a02 * a21 - a01 * a22) * y
    + (a01 * a12 - a02 * a11) * z) / determinant;
  out[1] = (b11 * x + (a00 * a22 - a02 * a20) * y
    + (a02 * a10 - a00 * a12) * z) / determinant;
  out[2] = (b21 * x + (a01 * a20 - a00 * a21) * y
    + (a00 * a11 - a01 * a10) * z) / determinant;
  return true;
}

function normalise(out: number[]): void {
  const length = Math.hypot(out[0]!, out[1]!, out[2]!);
  if (length < 1e-8) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 1;
    return;
  }
  out[0]! /= length;
  out[1]! /= length;
  out[2]! /= length;
}

/** A symmetric draw: −1 to 1, so a "vary" of v spreads a value by ±v. */
function spread(random: () => number): number {
  return random() * 2 - 1;
}

const scratchA: number[] = [0, 0, 0];
const scratchB: number[] = [0, 0, 0];
const scratchC: number[] = [0, 0, 0];
const scratchRamp: number[] = [0, 0, 0];

/**
 * Where one particle starts and which way it goes, in the emitter's own frame.
 *
 * The four generators differ only here. Everything after this point — the integrator, the ramps,
 * the quad — is the same whichever one produced the particle, which is why this is the only place
 * `emitterType` is read.
 */
function spawnLocal(
  system: ParticleSystem,
  animationMs: number,
  worldMs: number,
  position: number[],
  direction: number[],
): void {
  const { emitter, globalSequences, random } = system;
  const track = (value: WvmTrack, fallback: number): number =>
    sampleTrack(value, animationMs, worldMs, globalSequences, fallback);

  const vertical = track(emitter.verticalRange, 0);
  const horizontal = track(emitter.horizontalRange, 0);
  const areaLength = track(emitter.emissionAreaLength, 0);
  const areaWidth = track(emitter.emissionAreaWidth, 0);

  switch (emitter.emitterType) {
    case EMITTER_SPHERE: {
      // Radius between the two area values, and a latitude band around the emitter's equator.
      // Zero vertical range is the equator itself: the ring a campfire's flames stand in.
      const radius = areaLength + (areaWidth - areaLength) * random();
      const elevation = vertical * spread(random);
      const azimuth = horizontal * spread(random);
      const flat = Math.cos(elevation);
      position[0] = radius * flat * Math.cos(azimuth);
      position[1] = radius * flat * Math.sin(azimuth);
      position[2] = radius * Math.sin(elevation);
      direction[0] = position[0]!;
      direction[1] = position[1]!;
      direction[2] = position[2]!;
      normalise(direction);
      // Without a radius there is no outward to speak of; rise instead of dividing by nothing.
      if (radius < 1e-6) {
        direction[0] = 0;
        direction[1] = 0;
        direction[2] = 1;
      }
      if ((emitter.flags & PARTICLE_FLAG_INWARD) !== 0 && (emitter.flags & PARTICLE_FLAG_OUTWARD) === 0) {
        direction[0] = -direction[0]!;
        direction[1] = -direction[1]!;
        direction[2] = -direction[2]!;
      }
      break;
    }
    case EMITTER_SPLINE: {
      // A point along the authored path, straight-line between control points. No local model
      // uses this generator, so it is written to the layout rather than to a measurement.
      const points = emitter.splinePoints.length / 3;
      if (points === 0) {
        position[0] = 0;
        position[1] = 0;
        position[2] = 0;
      } else {
        const at = random() * (points - 1);
        const first = Math.floor(at);
        const next = Math.min(points - 1, first + 1);
        const fraction = at - first;
        for (let axis = 0; axis < 3; axis++) {
          const from = emitter.splinePoints[first * 3 + axis]!;
          position[axis] = from + (emitter.splinePoints[next * 3 + axis]! - from) * fraction;
        }
      }
      const polar = vertical * spread(random);
      const azimuth = horizontal * spread(random);
      direction[0] = Math.sin(polar) * Math.cos(azimuth);
      direction[1] = Math.sin(polar) * Math.sin(azimuth);
      direction[2] = Math.cos(polar);
      break;
    }
    default: {
      // Plane, and bone — a bone generator is a plane of no extent at the bone's own origin.
      const plane = emitter.emitterType !== EMITTER_BONE;
      position[0] = plane ? spread(random) * areaLength * 0.5 : 0;
      position[1] = plane ? spread(random) * areaWidth * 0.5 : 0;
      position[2] = 0;
      // Here the vertical range is the half-angle off the plane's normal, so zero is a beam
      // straight up the emitter's own +Z rather than a spray along its surface.
      const polar = vertical * spread(random);
      const azimuth = horizontal * spread(random);
      direction[0] = Math.sin(polar) * Math.cos(azimuth);
      direction[1] = Math.sin(polar) * Math.sin(azimuth);
      direction[2] = Math.cos(polar);
      break;
    }
  }

  // A z-source overrides whatever the generator chose: the particle flies along the line from a
  // point on the emitter's own axis to where it was born. The wiki states this subtraction the
  // other way round, and taken literally it sends every flame of a bonfire into the ground —
  // `6fx_bonfire.m2` sets zSource to 255 on all five of its emitters, and 255 is far enough above
  // a spawn ring 2.4 across that the result is very nearly straight down.
  const zSource = track(emitter.zSource, 0);
  if (zSource > 0) {
    direction[0] = -position[0]!;
    direction[1] = -position[1]!;
    direction[2] = zSource - position[2]!;
    normalise(direction);
  }
}

/**
 * Advances one emitter by `seconds`, spawning what it owes and moving what it has.
 *
 * The integrator is semi-implicit and takes the drop exactly rather than by accumulation, which
 * is what keeps a particle's arc the same shape at thirty frames a second as at a hundred and
 * forty. Order matters and is the reverse-engineered one: carry, then gravity, then drag.
 */
/** Advances one ordinary render frame; a hitch is deliberately capped at 100 ms. */
export function stepParticles(system: ParticleSystem, seconds: number, frame: EmitterFrame): void {
  stepParticlesOnce(system, seconds > 0 && Number.isFinite(seconds) ? Math.min(seconds, 0.1) : 0, frame);
}

/**
 * Seeds the authored first burst without advancing the emitter clock.  This is only used when a
 * newly resolved visual has been rebased to age zero: simulating an arbitrary pre-roll can skip a
 * short enabled window or let a short-lived particle die before its first visible frame.
 */
export function primeParticleSystem(system: ParticleSystem, frame: EmitterFrame): boolean {
  if (system.particles.length > 0) return false;
  const { emitter, globalSequences } = system;
  const enabled = sampleTrack(emitter.enabledIn, frame.animationMs, frame.worldMs,
    globalSequences, 1);
  const rate = sampleTrack(emitter.emissionRate, frame.animationMs, frame.worldMs,
    globalSequences, 0);
  if (enabled <= 0.5 || rate <= 0) return false;
  // Set the transform/origin exactly as a zero-time ordinary step would before spawning in the
  // emitter's current frame. No pending debt or particle age is fabricated.
  stepParticlesOnce(system, 0, frame);
  system.particles.push(spawn(system, frame));
  return true;
}

/**
 * Explicit async-model catch-up. It is intentionally separate from the frame path and bounded so
 * a late response cannot turn one render tick into an unbounded simulation hitch.
 */
export const EFFECT_CATCHUP_MAX_SECONDS = 1;

export function stepParticlesCatchUp(system: ParticleSystem, seconds: number, frame: EmitterFrame): void {
  const duration = Math.min(EFFECT_CATCHUP_MAX_SECONDS,
    Math.max(0, Number.isFinite(seconds) ? seconds : 0));
  if (duration <= 0) {
    stepParticlesOnce(system, 0, frame);
    return;
  }
  const startAnimation = frame.animationStartMs ?? frame.animationMs;
  const startWorld = frame.worldStartMs ?? frame.worldMs;
  const steps = Math.ceil(duration / 0.1);
  for (let index = 0; index < steps; index++) {
    const elapsed = Math.min(0.1, duration - index * 0.1);
    if (elapsed <= 0) break;
    const fraction = (index * 0.1 + elapsed) / duration;
    stepParticlesOnce(system, elapsed, {
      ...frame,
      animationMs: startAnimation + (frame.animationMs - startAnimation) * fraction,
      worldMs: startWorld + (frame.worldMs - startWorld) * fraction,
    });
  }
}

function stepParticlesOnce(system: ParticleSystem, seconds: number, frame: EmitterFrame): void {
  const { emitter, globalSequences, particles, random } = system;
  const { matrix, animationMs, worldMs } = frame;
  const track = (value: WvmTrack, fallback: number): number =>
    sampleTrack(value, animationMs, worldMs, globalSequences, fallback);

  for (let index = 0; index < 16; index++) system.matrix[index] = matrix[index]!;

  // Where the emitter's own origin is this frame, and how far it moved since the last one.
  transformPoint(matrix, emitter.position[0], emitter.position[1], emitter.position[2], scratchA);
  const moveX = system.placed ? scratchA[0]! - system.originX : 0;
  const moveY = system.placed ? scratchA[1]! - system.originY : 0;
  const moveZ = system.placed ? scratchA[2]! - system.originZ : 0;
  system.originX = scratchA[0]!;
  system.originY = scratchA[1]!;
  system.originZ = scratchA[2]!;
  system.placed = true;

  const step = seconds > 0 ? Math.min(seconds, 0.1) : 0;

  // How much of the emitter's own movement the particles are dragged along with. The two
  // speed/scale pairs are the ends of a ramp: below the first speed nothing is carried, above the
  // second the full second scale is, and between them it is linear. A standing emitter and an
  // emitter with both scales at zero — which is most of them — cost nothing.
  let carryX = 0;
  let carryY = 0;
  let carryZ = 0;
  if (!system.modelSpace && (emitter.followScale1 !== 0 || emitter.followScale2 !== 0) && step > 0) {
    const speed = Math.hypot(moveX, moveY, moveZ) / step;
    const span = emitter.followSpeed2 - emitter.followSpeed1;
    const fraction = span > 0 ? Math.min(1, Math.max(0, (speed - emitter.followSpeed1) / span)) : speed > emitter.followSpeed1 ? 1 : 0;
    const scale = emitter.followScale1 + (emitter.followScale2 - emitter.followScale1) * fraction;
    carryX = moveX * scale;
    carryY = moveY * scale;
    carryZ = moveZ * scale;
  }

  // Which way is down for these particles. A model-space emitter never leaves its own frame, so
  // its gravity is its own −Z; a world-up emitter uses the scene's vertical however the model is
  // turned; everything else falls along the emitter's −Z expressed in the world.
  let gravityX = 0;
  let gravityY = 0;
  let gravityZ = -1;
  if (!system.modelSpace) {
    if ((emitter.flags & PARTICLE_FLAG_WORLD_UP) !== 0) {
      gravityX = 0;
      gravityY = -1;
      gravityZ = 0;
    } else {
      transformVector(matrix, 0, 0, -1, scratchB);
      normalise(scratchB);
      gravityX = scratchB[0]!;
      gravityY = scratchB[1]!;
      gravityZ = scratchB[2]!;
    }
    // Read out of the scratch before anything else borrows it.
  }

  const gravity = track(emitter.gravity, 0);
  const drag = emitter.drag;
  const dragFactor = drag === 0 ? 1 : Math.exp(Math.min(2, Math.max(-2, -drag * step)));
  // Turned into the scene, like the gravity above it and the spawn direction below. It is a
  // `C3Vector` at 0x1A0 of the record, in the same frame as the emitter's own position — and it
  // was the one spatial term the matrix was never applied to. Read raw, a wind blowing straight
  // down in the model's frame came out horizontal, and it did not turn with the doodad's yaw.
  // Only fourteen of the client's 25,201 emitters carry one, and they are the ones it shows on:
  // `waterfall-long.m2`, `blacksmith_smoke.m2`, `smokestack.m2`.
  let windX = emitter.windVector[0];
  let windY = emitter.windVector[1];
  let windZ = emitter.windVector[2];
  const windy = windX !== 0 || windY !== 0 || windZ !== 0;
  if (windy && !system.modelSpace) {
    transformVector(matrix, windX, windY, windZ, scratchB);
    windX = scratchB[0]!;
    windY = scratchB[1]!;
    windZ = scratchB[2]!;
  }

  for (let index = particles.length - 1; index >= 0; index--) {
    const particle = particles[index]!;
    particle.age += step;
    if (particle.age >= particle.life) {
      particles[index] = particles[particles.length - 1]!;
      particles.pop();
      continue;
    }
    particle.x += particle.vx * step + carryX;
    particle.y += particle.vy * step + carryY;
    particle.z += particle.vz * step + carryZ;
    // The exact drop over the step, rather than the drift that accumulating it frame by frame
    // gives: half of it belongs to the position and the whole of it to the velocity.
    if (gravity !== 0) {
      const fall = 0.5 * gravity * step * step;
      particle.x += gravityX * fall;
      particle.y += gravityY * fall;
      particle.z += gravityZ * fall;
      particle.vx += gravityX * gravity * step;
      particle.vy += gravityY * gravity * step;
      particle.vz += gravityZ * gravity * step;
    }
    if (windy) {
      particle.vx += windX * step;
      particle.vy += windY * step;
      particle.vz += windZ * step;
    }
    if (drag !== 0) {
      // Speed multiplied by exp(−drag·t), which is the closed form of the per-step subtraction the
      // reverse-engineered integrator does and, unlike it, gives the same answer at any frame
      // rate — the same reason the drop above is taken exactly. A negative drag is an
      // acceleration, and 61 of the 8,575 emitters in the client authored one, down to −8.95; the
      // exponent is clamped so that neither end can multiply a velocity by more than about eight
      // in a single step.
      particle.vx *= dragFactor;
      particle.vy *= dragFactor;
      particle.vz *= dragFactor;
    }
    particle.spin += particle.spinRate * step;
  }

  if (step <= 0) return;

  // Off for this stretch of the animation, and that is a real state rather than an absence: four
  // of the twenty-six local emitters key `enabledIn`, and all four switch off partway through.
  const enabled = sampleTrack(emitter.enabledIn, animationMs, worldMs, globalSequences, 1);
  const base = enabled > 0.5 ? track(emitter.emissionRate, 0) : 0;
  if (base <= 0) {
    // Stopped, not merely quiet: an emitter that has been switched off owes nothing when it
    // comes back on.
    system.pending = 0;
    return;
  }
  let rate = base;
  if ((emitter.flags & PARTICLE_FLAG_BURST) !== 0 && emitter.burstMultiplier > 0) {
    rate *= emitter.burstMultiplier;
  }
  // A step whose variance draw came out at or below zero contributes nothing and takes nothing
  // away. Clearing the accumulator here instead loses every fraction of a particle banked since
  // the last spawn, and loses more of it the higher the frame rate — 82 of the client's emitters
  // carry a variance and 53 of them have one large enough to go negative, so
  // `spells\missile_wave_ice.m2` emitted 0.8 particles in two seconds at 30 frames a second, 0.1
  // at 60 and none at all at 144, against the 4 its numbers ask for.
  const varied = emitter.emissionRateVary === 0
    ? rate
    : Math.max(0, rate + emitter.emissionRateVary * spread(random));
  if (varied <= 0) return;

  system.pending += varied * step;
  // A tab that was in the background does not owe a thousand particles on the frame it returns.
  if (system.pending > EMITTER_CAPACITY) system.pending = EMITTER_CAPACITY;
  while (system.pending >= 1 && particles.length < EMITTER_CAPACITY) {
    system.pending -= 1;
    particles.push(spawn(system, frame));
  }
  if (particles.length >= EMITTER_CAPACITY) system.pending = 0;
}

function spawn(system: ParticleSystem, frame: EmitterFrame): Particle {
  const { emitter, globalSequences, random } = system;
  const { matrix, animationMs, worldMs } = frame;
  const track = (value: WvmTrack, fallback: number): number =>
    sampleTrack(value, animationMs, worldMs, globalSequences, fallback);

  const local: number[] = [0, 0, 0];
  const direction: number[] = [0, 0, 1];
  spawnLocal(system, animationMs, worldMs, local, direction);

  let speed = track(emitter.emissionSpeed, 0);
  const variation = track(emitter.speedVariation, 0);
  if (variation !== 0) speed *= 1 + variation * spread(random);

  const offsetX = emitter.position[0] + local[0]!;
  const offsetY = emitter.position[1] + local[1]!;
  const offsetZ = emitter.position[2] + local[2]!;

  let x: number;
  let y: number;
  let z: number;
  let vx: number;
  let vy: number;
  let vz: number;
  if (system.modelSpace) {
    x = offsetX;
    y = offsetY;
    z = offsetZ;
    vx = direction[0]! * speed;
    vy = direction[1]! * speed;
    vz = direction[2]! * speed;
  } else {
    transformPoint(matrix, offsetX, offsetY, offsetZ, scratchA);
    x = scratchA[0]!;
    y = scratchA[1]!;
    z = scratchA[2]!;
    // The direction is turned by the emitter but not stretched by it: a model at half scale emits
    // half as far, not half as fast in a direction that is no longer a unit.
    transformVector(matrix, direction[0]!, direction[1]!, direction[2]!, scratchB);
    normalise(scratchB);
    vx = scratchB[0]! * speed;
    vy = scratchB[1]! * speed;
    vz = scratchB[2]! * speed;
  }

  const life = Math.max(0.02, track(emitter.lifespan, 1) + emitter.lifespanVary * spread(random));
  const independent = (emitter.flags & PARTICLE_FLAG_SCALE_VARY_INDEPENDENT) !== 0;
  const varyX = emitter.scaleVary[0];
  const varyY = independent ? emitter.scaleVary[1] : emitter.scaleVary[0];
  const cells = Math.max(1, emitter.textureRows) * Math.max(1, emitter.textureColumns);

  return {
    x, y, z, vx, vy, vz,
    bx: x, by: y, bz: z,
    age: 0,
    life,
    scaleX: Math.max(0, 1 + varyX * spread(random)),
    scaleY: Math.max(0, 1 + varyY * spread(random)),
    // `baseSpin` is zero on every one of the 8,575 emitters in the client, so what this really
    // reads is a random starting angle from `baseSpinVary` — which is 2π wherever it is set, and
    // 2π is exactly "anywhere".
    spin: emitter.baseSpin + emitter.baseSpinVary * spread(random),
    spinRate: emitter.spin + emitter.spinVary * spread(random),
    cellOffset: (emitter.flags & PARTICLE_FLAG_RANDOM_FLIPBOOK) !== 0 ? Math.floor(random() * cells) : 0,
  };
}

/** What one particle looks like right now, before it is turned into corners. */
export interface ParticleAppearance {
  red: number;
  green: number;
  blue: number;
  alpha: number;
  width: number;
  height: number;
  /** Which cell of the flip-book, already wrapped into the grid. */
  cell: number;
}

/**
 * Colour, opacity and size for one particle at its own age.
 *
 * Kept apart from the step because it depends on nothing but the particle's life fraction: two
 * emitters can share it, and a test can ask what a bonfire's flame looks like a third of the way
 * through without running a frame.
 */
export function particleAppearance(
  emitter: WvmParticleEmitter,
  particle: Particle,
  out: ParticleAppearance,
): ParticleAppearance {
  const life = particle.life > 0 ? particle.age / particle.life : 1;
  sampleRamp(emitter.color, life, scratchRamp, 1);
  out.red = scratchRamp[0]!;
  out.green = scratchRamp[1]!;
  out.blue = scratchRamp[2]!;
  sampleRamp(emitter.opacity, life, scratchRamp, 1);
  out.alpha = Math.min(1, Math.max(0, scratchRamp[0]!));
  sampleRamp(emitter.scale, life, scratchRamp, 1);
  // Twinkle is deliberately not applied. `twinkleSpeed` is authored on 8,564 of the client's
  // 8,575 emitters, but no source anywhere — not the wiki, not any of the five reference clients
  // the study audited — gives a formula for how the twinkleScale range enters the size, and the
  // range reaches 47.7 on native content. Every guess that fits one emitter draws another one
  // forty times life size, so the honest answer is to leave it out and say so.
  out.width = scratchRamp[0]! * particle.scaleX;
  out.height = (emitter.scale?.components ?? 1) > 1 ? scratchRamp[1]! * particle.scaleY : out.width;
  const cells = Math.max(1, emitter.textureRows) * Math.max(1, emitter.textureColumns);
  sampleRamp(emitter.headCell, life, scratchRamp, 0);
  const cell = Math.floor(scratchRamp[0]! + particle.cellOffset);
  out.cell = ((cell % cells) + cells) % cells;
  return out;
}

/** The camera's own axes in the scene, which is all a billboard needs to know about it. */
export interface BillboardView {
  rightX: number; rightY: number; rightZ: number;
  upX: number; upY: number; upZ: number;
}

/** Where one emitter's quads are written. Four vertices and six indices per particle. */
export interface QuadBuffers {
  positions: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
}

/** Room for `count` particles, with the index buffer they all share. */
export function createQuadBuffers(count: number): QuadBuffers & { indices: Uint16Array } {
  const indices = new Uint16Array(count * 6);
  for (let quad = 0; quad < count; quad++) {
    const base = quad * 4;
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], quad * 6);
  }
  return {
    positions: new Float32Array(count * 4 * 3),
    uvs: new Float32Array(count * 4 * 2),
    colors: new Float32Array(count * 4 * 4),
    indices,
  };
}

const appearance: ParticleAppearance = { red: 1, green: 1, blue: 1, alpha: 1, width: 1, height: 1, cell: 0 };

/**
 * Turns one emitter's live particles into quads, and says how many it wrote.
 *
 * The caller keeps the buffers and the geometry; this only fills them, so the same code serves a
 * campfire on a hillside and a spell effect on a character's hand. A particle whose quad has no
 * area or no opacity is skipped rather than written — a bonfire's smoke spends the last fifth of
 * its life at zero scale, and drawing those is a sixth of the triangles for nothing.
 */
export function writeParticleQuads(
  system: ParticleSystem,
  view: BillboardView,
  buffers: QuadBuffers,
): number {
  const { emitter, particles } = system;
  const columns = Math.max(1, emitter.textureColumns);
  const rows = Math.max(1, emitter.textureRows);
  const pinned = (emitter.flags & PARTICLE_FLAG_PINNED) !== 0
    && (emitter.flags & PARTICLE_FLAG_DO_NOT_TRAIL) === 0;
  const xyQuad = (emitter.flags & PARTICLE_FLAG_XY_QUAD) !== 0;
  const capacity = Math.floor(buffers.positions.length / 12);

  let quads = 0;
  for (const particle of particles) {
    if (quads >= capacity) break;
    particleAppearance(emitter, particle, appearance);
    if (appearance.alpha <= 0.002 || appearance.width <= 0 || appearance.height <= 0) continue;

    let x = particle.x;
    let y = particle.y;
    let z = particle.z;
    let bornX = particle.bx;
    let bornY = particle.by;
    let bornZ = particle.bz;
    if (system.modelSpace) {
      transformPoint(system.matrix, x, y, z, scratchA);
      x = scratchA[0]!;
      y = scratchA[1]!;
      z = scratchA[2]!;
      transformPoint(system.matrix, bornX, bornY, bornZ, scratchA);
      bornX = scratchA[0]!;
      bornY = scratchA[1]!;
      bornZ = scratchA[2]!;
    }

    // The quad's two axes. A head faces the camera and turns on its own axis; a pinned quad is
    // stretched along the line it has travelled instead, and only its width faces the camera.
    //
    // Pinning is the one thing here decided by the flag table, which is known to be wrong about at
    // least one bit — 0x400 is named Pinned by two independent sources, and 4,543 of the client's
    // 25,201 emitters set it. It degrades continuously if that name is wrong: a particle that has
    // not moved yet gives a quad indistinguishable from a billboard, and the streak only grows as
    // far as the particle actually travels.
    let axisX = view.rightX;
    let axisY = view.rightY;
    let axisZ = view.rightZ;
    let sideX = view.upX;
    let sideY = view.upY;
    let sideZ = view.upZ;
    let halfWidth = appearance.width * 0.5;
    let halfHeight = appearance.height * 0.5;
    let centreX = x;
    let centreY = y;
    let centreZ = z;

    if (system.modelSpace && !xyQuad) {
      // MODEL_SPACE means the complete particle quad stays in the emitter frame, not only its
      // centre. Aim the local billboard at the camera, then carry the normalised local axes
      // through the frame so a hand/effect scale reaches its width and height as well. The old
      // path transformed only the centre and left a scaled MODEL_SPACE spark at its authored
      // size. `shaman_thunder.m2` is the shipped hand-effect seam that exposes this most clearly.
      const rightInModel = inverseTransformVector(system.matrix,
        view.rightX, view.rightY, view.rightZ, scratchA);
      const upInModel = inverseTransformVector(system.matrix,
        view.upX, view.upY, view.upZ, scratchB);
      if (rightInModel && upInModel) {
        normalise(scratchA);
        transformVector(system.matrix, scratchA[0]!, scratchA[1]!, scratchA[2]!, scratchC);
        const rightScale = Math.hypot(scratchC[0]!, scratchC[1]!, scratchC[2]!);
        normalise(scratchC);
        axisX = scratchC[0]!;
        axisY = scratchC[1]!;
        axisZ = scratchC[2]!;

        normalise(scratchB);
        transformVector(system.matrix, scratchB[0]!, scratchB[1]!, scratchB[2]!, scratchC);
        const upScale = Math.hypot(scratchC[0]!, scratchC[1]!, scratchC[2]!);
        normalise(scratchC);
        sideX = scratchC[0]!;
        sideY = scratchC[1]!;
        sideZ = scratchC[2]!;
        if (rightScale > 1e-8) halfWidth *= rightScale;
        if (upScale > 1e-8) halfHeight *= upScale;
      }
    }

    if (xyQuad && !pinned) {
      // The authored plane is the emitter's own XY, carried into world space by the same matrix
      // that places its particles. This is intentionally camera-independent: rotating the view
      // must not make a ground rune or planar magical seal stand up to face it.
      // PINNED takes precedence when both flags are present: its birth-to-head tail is the shape,
      // while XY_QUAD only defines the plane of an ordinary head. Three shipped spell emitters set
      // both, so this ordering is deliberate rather than an accidental second overwrite below.
      transformVector(system.matrix, 1, 0, 0, scratchA);
      transformVector(system.matrix, 0, 1, 0, scratchB);
      const widthScale = Math.hypot(scratchA[0]!, scratchA[1]!, scratchA[2]!);
      const heightScale = Math.hypot(scratchB[0]!, scratchB[1]!, scratchB[2]!);
      normalise(scratchA);
      normalise(scratchB);
      axisX = scratchA[0]!;
      axisY = scratchA[1]!;
      axisZ = scratchA[2]!;
      sideX = scratchB[0]!;
      sideY = scratchB[1]!;
      sideZ = scratchB[2]!;
      if (system.modelSpace) {
        if (widthScale > 1e-8) halfWidth *= widthScale;
        if (heightScale > 1e-8) halfHeight *= heightScale;
      }
    }

    if (pinned) {
      let alongX = x - bornX;
      let alongY = y - bornY;
      let alongZ = z - bornZ;
      const length = Math.hypot(alongX, alongY, alongZ);
      if (length > 1e-5) {
        alongX /= length;
        alongY /= length;
        alongZ /= length;
        // Across the streak: the part of the camera's right that is not along it, so the ribbon
        // of a spark keeps facing the eye however it is flying.
        const dot = alongX * view.rightX + alongY * view.rightY + alongZ * view.rightZ;
        let acrossX = view.rightX - alongX * dot;
        let acrossY = view.rightY - alongY * dot;
        let acrossZ = view.rightZ - alongZ * dot;
        const across = Math.hypot(acrossX, acrossY, acrossZ);
        if (across > 1e-5) {
          acrossX /= across;
          acrossY /= across;
          acrossZ /= across;
          axisX = acrossX;
          axisY = acrossY;
          axisZ = acrossZ;
          sideX = alongX;
          sideY = alongY;
          sideZ = alongZ;
          // How long the streak is allowed to be: the emitter's own `tailLength`, in seconds of
          // travel at the particle's current speed. Nothing read it until now — it is filled in on
          // **5,427 of the 5,445** emitters under `spells\` — and the quad simply ran from the
          // birthplace to wherever the particle had got to. Over the 881 pinned emitters there the
          // spread `emissionSpeed × lifespan` is 0.6 yards at the median and 6.7 at p90, but 27.8
          // at p99 and **83.3 at the worst**: `spells\forceshield_andxplosion.m2` fires at
          // 27.8 yards/s for 3.0 s with `tailLength` 0.1, so a spark that should be a 2.8-yard
          // streak was an 83-yard bar across the screen.
          //
          // The far end stays on the particle rather than the quad staying centred on the
          // birth-to-now midpoint: a shortened tail centred on the old midpoint would lag behind
          // the spark it belongs to, which is worse than a long one.
          //
          // The speed is measured in the same space as `length`. For a model-space emitter that is
          // the emitter's frame carried through the matrix, and the matrix can scale — a spell
          // visual is placed at a scale the server sends — so the velocity goes through it too,
          // exactly as the gravity and wind vectors above do.
          let speed: number;
          if (system.modelSpace) {
            transformVector(system.matrix, particle.vx, particle.vy, particle.vz, scratchB);
            speed = Math.hypot(scratchB[0]!, scratchB[1]!, scratchB[2]!);
          } else speed = Math.hypot(particle.vx, particle.vy, particle.vz);
          const limit = emitter.tailLength > 0 ? speed * emitter.tailLength : length;
          halfHeight = Math.min(length, limit) * 0.5;
          centreX = x - alongX * halfHeight;
          centreY = y - alongY * halfHeight;
          centreZ = z - alongZ * halfHeight;
        }
      }
    } else if (particle.spin !== 0) {
      const cos = Math.cos(particle.spin);
      const sin = Math.sin(particle.spin);
      const baseAxisX = axisX;
      const baseAxisY = axisY;
      const baseAxisZ = axisZ;
      const baseSideX = sideX;
      const baseSideY = sideY;
      const baseSideZ = sideZ;
      axisX = baseAxisX * cos + baseSideX * sin;
      axisY = baseAxisY * cos + baseSideY * sin;
      axisZ = baseAxisZ * cos + baseSideZ * sin;
      sideX = baseSideX * cos - baseAxisX * sin;
      sideY = baseSideY * cos - baseAxisY * sin;
      sideZ = baseSideZ * cos - baseAxisZ * sin;
    }

    const dx = axisX * halfWidth;
    const dy = axisY * halfWidth;
    const dz = axisZ * halfWidth;
    const ex = sideX * halfHeight;
    const ey = sideY * halfHeight;
    const ez = sideZ * halfHeight;

    const at = quads * 12;
    const positions = buffers.positions;
    positions[at] = centreX - dx - ex; positions[at + 1] = centreY - dy - ey; positions[at + 2] = centreZ - dz - ez;
    positions[at + 3] = centreX + dx - ex; positions[at + 4] = centreY + dy - ey; positions[at + 5] = centreZ + dz - ez;
    positions[at + 6] = centreX + dx + ex; positions[at + 7] = centreY + dy + ey; positions[at + 8] = centreZ + dz + ez;
    positions[at + 9] = centreX - dx + ex; positions[at + 10] = centreY - dy + ey; positions[at + 11] = centreZ - dz + ez;

    const column = appearance.cell % columns;
    const row = Math.floor(appearance.cell / columns) % rows;
    const u0 = column / columns;
    const u1 = (column + 1) / columns;
    // The atlas runs top to bottom while the quad is built bottom-up, so the rows are read the
    // other way: cell 0 is the top-left tile, not the bottom-left one.
    const v0 = 1 - (row + 1) / rows;
    const v1 = 1 - row / rows;
    const uvAt = quads * 8;
    buffers.uvs.set([u0, v0, u1, v0, u1, v1, u0, v1], uvAt);

    const colorAt = quads * 16;
    for (let corner = 0; corner < 4; corner++) {
      const to = colorAt + corner * 4;
      buffers.colors[to] = appearance.red;
      buffers.colors[to + 1] = appearance.green;
      buffers.colors[to + 2] = appearance.blue;
      buffers.colors[to + 3] = appearance.alpha;
    }
    quads++;
  }
  return quads;
}

/* --- Ribbons --------------------------------------------------------------------------------
   A ribbon is not a cloud of independent points but one strip that remembers where its bone has
   been. Everything about it is therefore the opposite of a particle: edges are added at one end
   and retired from the other, and the geometry is rebuilt from the whole list every frame. */

export interface RibbonEdge {
  x: number; y: number; z: number;
  /** The bone's own up axis when this edge was laid down, which is the direction it has width in. */
  upX: number; upY: number; upZ: number;
  above: number;
  below: number;
  red: number; green: number; blue: number; alpha: number;
  age: number;
}

export interface RibbonSystem {
  readonly ribbon: WvmRibbonEmitter;
  readonly globalSequences: Uint32Array;
  readonly edges: RibbonEdge[];
  pending: number;
}

/**
 * How many edges one ribbon keeps.
 *
 * `edgesPerSecond * edgeLifetime` is the steady-state length. Across the client's 1,502 ribbon
 * emitters that product has a median of 30, a ninetieth percentile of 120 and a ninety-ninth of
 * 200, so this holds all but the last percent; the longest asks for 2,500. `edgesPerSecond` never
 * exceeds 100 and `edgeLifetime` runs from 0.1 to 25 seconds.
 */
export const RIBBON_CAPACITY = 256;

export function createRibbonSystem(ribbon: WvmRibbonEmitter, globalSequences: Uint32Array): RibbonSystem {
  return { ribbon, globalSequences, edges: [], pending: 0 };
}

/** Rewinds one trail while retaining its authored tracks and array identity. */
export function resetRibbonSystem(system: RibbonSystem): void {
  system.edges.length = 0;
  system.pending = 0;
}

/**
 * Advances one ribbon: ages what it has, drops what has expired, lays down what it owes.
 *
 * An edge's place is fixed in the world the moment it is laid down. That is the whole point of a
 * trail — the sword moves on and the streak stays behind — and it is why the edge stores the
 * bone's up axis rather than looking it up again later.
 */
/** Advances one ordinary ribbon frame; a hitch is deliberately capped at 100 ms. */
export function stepRibbon(system: RibbonSystem, seconds: number, frame: EmitterFrame): void {
  stepRibbonOnce(system, seconds > 0 && Number.isFinite(seconds) ? Math.min(seconds, 0.1) : 0, frame);
}

/** Explicit, bounded async catch-up for a newly resolved ribbon system. */
export function stepRibbonCatchUp(system: RibbonSystem, seconds: number, frame: EmitterFrame): void {
  const duration = Math.min(EFFECT_CATCHUP_MAX_SECONDS,
    Math.max(0, Number.isFinite(seconds) ? seconds : 0));
  if (duration <= 0) {
    stepRibbonOnce(system, 0, frame);
    return;
  }
  const startAnimation = frame.animationStartMs ?? frame.animationMs;
  const startWorld = frame.worldStartMs ?? frame.worldMs;
  const steps = Math.ceil(duration / 0.1);
  for (let index = 0; index < steps; index++) {
    const elapsed = Math.min(0.1, duration - index * 0.1);
    if (elapsed <= 0) break;
    const fraction = (index * 0.1 + elapsed) / duration;
    stepRibbonOnce(system, elapsed, {
      ...frame,
      animationMs: startAnimation + (frame.animationMs - startAnimation) * fraction,
      worldMs: startWorld + (frame.worldMs - startWorld) * fraction,
    });
  }
}

function stepRibbonOnce(system: RibbonSystem, seconds: number, frame: EmitterFrame): void {
  const { ribbon, globalSequences, edges } = system;
  const { matrix, animationMs, worldMs } = frame;
  const track = (value: WvmTrack, fallback: number, component = 0): number =>
    sampleTrack(value, animationMs, worldMs, globalSequences, fallback, component);

  const step = seconds > 0 ? Math.min(seconds, 0.1) : 0;
  const lifetime = ribbon.edgeLifetime > 0 ? ribbon.edgeLifetime : 0.5;
  for (const edge of edges) {
    edge.age += step;
    if (ribbon.gravity !== 0) {
      // The drop over this step of a fall that started when the edge was laid down. Adding a flat
      // half-g-dt-squared every frame instead — which is the obvious thing to write — makes the
      // sag depend on the frame rate rather than on the age.
      edge.y -= ribbon.gravity * step * (edge.age - step * 0.5);
    }
  }
  while (edges.length > 0 && edges[0]!.age >= lifetime) edges.shift();

  if (step <= 0) return;
  // A `uint8` track: a ribbon is on or off, and the byte it is stored in is why the artifact had
  // to learn key widths at all.
  if (track(ribbon.visibility, 1) <= 0.5) {
    system.pending = 0;
    return;
  }

  const rate = ribbon.edgesPerSecond > 0 ? ribbon.edgesPerSecond : 0;
  if (rate <= 0) return;
  system.pending += rate * step;
  if (system.pending > RIBBON_CAPACITY) system.pending = RIBBON_CAPACITY;

  transformPoint(matrix, ribbon.position[0], ribbon.position[1], ribbon.position[2], scratchA);
  transformVector(matrix, 0, 0, 1, scratchB);
  normalise(scratchB);
  while (system.pending >= 1) {
    system.pending -= 1;
    edges.push({
      x: scratchA[0]!, y: scratchA[1]!, z: scratchA[2]!,
      upX: scratchB[0]!, upY: scratchB[1]!, upZ: scratchB[2]!,
      above: track(ribbon.heightAbove, 0.5),
      below: track(ribbon.heightBelow, 0.5),
      red: track(ribbon.color, 1, 0),
      green: track(ribbon.color, 1, 1),
      blue: track(ribbon.color, 1, 2),
      alpha: track(ribbon.alpha, 1),
      age: 0,
    });
    if (edges.length > RIBBON_CAPACITY) edges.shift();
  }
}

/**
 * Writes the strip's triangles and says how many quads it wrote.
 *
 * The length coordinate is the edge's own age rather than its index, so the texture stays put on
 * the trail while the strip fills and empties. Indexing it — which is the obvious thing to write —
 * renormalises every frame, and the pattern visibly crawls backwards along a ribbon that is still
 * growing.
 */
export function writeRibbonStrip(system: RibbonSystem, buffers: QuadBuffers): number {
  const { ribbon, edges } = system;
  const capacity = Math.floor(buffers.positions.length / 12);
  const lifetime = ribbon.edgeLifetime > 0 ? ribbon.edgeLifetime : 0.5;
  let quads = 0;
  for (let index = 0; index + 1 < edges.length && quads < capacity; index++) {
    const near = edges[index]!;
    const far = edges[index + 1]!;
    const at = quads * 12;
    const positions = buffers.positions;
    positions[at] = near.x - near.upX * near.below;
    positions[at + 1] = near.y - near.upY * near.below;
    positions[at + 2] = near.z - near.upZ * near.below;
    positions[at + 3] = far.x - far.upX * far.below;
    positions[at + 4] = far.y - far.upY * far.below;
    positions[at + 5] = far.z - far.upZ * far.below;
    positions[at + 6] = far.x + far.upX * far.above;
    positions[at + 7] = far.y + far.upY * far.above;
    positions[at + 8] = far.z + far.upZ * far.above;
    positions[at + 9] = near.x + near.upX * near.above;
    positions[at + 10] = near.y + near.upY * near.above;
    positions[at + 11] = near.z + near.upZ * near.above;

    const uNear = Math.min(1, Math.max(0, 1 - near.age / lifetime));
    const uFar = Math.min(1, Math.max(0, 1 - far.age / lifetime));
    buffers.uvs.set([uNear, 0, uFar, 0, uFar, 1, uNear, 1], quads * 8);

    // An edge fades out over its own life, so the trail thins towards its tail rather than ending
    // at a hard edge the moment it is retired.
    const fadeNear = near.alpha * (1 - near.age / lifetime);
    const fadeFar = far.alpha * (1 - far.age / lifetime);
    const colorAt = quads * 16;
    const write = (corner: number, edge: RibbonEdge, alpha: number): void => {
      const to = colorAt + corner * 4;
      buffers.colors[to] = edge.red;
      buffers.colors[to + 1] = edge.green;
      buffers.colors[to + 2] = edge.blue;
      buffers.colors[to + 3] = Math.min(1, Math.max(0, alpha));
    };
    write(0, near, fadeNear);
    write(1, far, fadeFar);
    write(2, far, fadeFar);
    write(3, near, fadeNear);
    quads++;
  }
  return quads;
}
