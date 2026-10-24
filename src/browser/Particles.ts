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
//   * Byte 0x2D of the record is not a head-or-tail enum (it is `fp_2_5` fixed point from Burning
//     Crusade onwards). 23.10 (6.27): the choice lives in the flags instead — 0x20000 draws a head,
//     0x40000 a tail, both draw both (Wow.exe SetParticleStyle 0x00978d00, see the flag table below).
//     A tail runs back along the velocity for `tailLength` *seconds of flight*, clamped to the
//     particle's age by 0x400 (BuildVertex 0x0097be80).
//   * `verticalRange` measures from a different zero on each generator, because each generator's
//     natural zero is different. On a plane it is the half-angle off the plane's normal, so zero
//     is a beam straight up — which is what `sunwell_beamfx.m2` is. On a sphere it is the latitude
//     band around the equator, so zero is a ring in the emitter's own XY plane — which is what a
//     campfire's flames rise from. Reading the sphere the plane's way puts every one of the
//     bonfire's particles on a single point above the fire.

import type { WvmParticleEmitter, WvmRamp, WvmTrack } from "./Wvm.js";
import { twinklePhase, twinkleSize } from "./ParticleTwinkle.js"; // 05.10-A7a-F1

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
//
// 23.10 (6.27): the record's bits as Wow.exe reads them. The emitter setup in CM2Model's load (the loop
// at 0x00833c80…0x00833e10, called from 0x00832ea0) maps each record bit onto a CParticleEmitter2 flag —
// read here from the bytes of the unpacked 3.3.5a 12340 Wow.exe — and the emitter code then acts on those
// (wowdecomp ParticleSystem2.cpp, cross-checked byte for byte at the addresses cited per bit):
//   0x1 → unlit material, 0x2 → depth-sorted (0x0097e580), 0x4 → head along the velocity (0x0097be80),
//   0x8 → unfogged material (0x008214e0), 0x10 → model space (0x009815c0/0x00981950/0x0097a390),
//   0x20 → size × the emitter's scale (0x0097be80), 0x40 → inherits the emitter's velocity (0x0097eb10),
//   0x80/0x100 → sphere: stop at the centre / rise straight up, 0x200 → spin either way,
//   0x400 → tail no longer than the particle's age, 0x800 → spawn along the emitter's path,
//   0x1000 → quad in the particle space's XY plane, 0x2000 → spawn on the ground, 0x4000 → follow,
//   0x10000 → random cell, 0x20000 → draw a head, 0x40000 → draw a tail (SetParticleStyle 0x00978d00),
//   0x80000 → independent scale variation.
// Until 23.10 the names below were the wiki's, several bits off: 0x80 was taken for model space (it is
// a sphere-only bit), 0x10 for "do not trail" (it is model space), 0x400 for a birth-to-head streak (it
// clamps the tail) and 0x20000/0x40000 for outward/inward spheres (they are the head and the tail). Of the
// 5,445 emitters under `spells\`, 1,076 draw only a tail and 1,984 live in model space.

/** 23.10 (6.27): drawn back to front within the emitter (m_flags 0x20, BuildParticleVertices 0x0097e580). */
export const PARTICLE_FLAG_SORT = 0x00000002;
/** 23.10 (6.27): the head quad turns to lie along the particle's velocity (m_flags 0x200000, 0x0097be80). */
export const PARTICLE_FLAG_VELOCITY_HEAD = 0x00000004;
/** 23.10 (6.27): fog leaves the particle alone (CParticleMat bit 2 off → M2 material 0x2, 0x008214e0). */
export const PARTICLE_FLAG_UNFOGGED = 0x00000008;
/** 23.10 (6.27): particles live in the emitter's frame, so posing the emitter carries them (m_flags 0x200). */
export const PARTICLE_FLAG_MODEL_SPACE = 0x00000010;
/** 23.10 (6.27): the quad's size follows the emitter's scale (m_flags 0x400 → × m_xformScale, 0x0097be80). */
export const PARTICLE_FLAG_SCALE_WITH_EMITTER = 0x00000020;
/** 23.10 (6.27): a sphere's particle dies once it passes the centre (m_flags 0x1000, MoveParticle 0x00979bb0). */
export const PARTICLE_FLAG_SPHERE_STOP_AT_CENTRE = 0x00000080;
/** 23.10 (6.27): a sphere's particle flies straight up its own Z (m_flags 0x8000, 0x00981950). */
export const PARTICLE_FLAG_SPHERE_STRAIGHT_UP = 0x00000100;
/** 23.10 (6.27): a tail is never longer than the particle has lived (m_flags 0x20000, 0x0097be80). */
export const PARTICLE_FLAG_CLAMP_TAIL = 0x00000400;
/** Quads lie in the particle space's XY plane instead of turning to face the camera (m_flags 0x4000). */
export const PARTICLE_FLAG_XY_QUAD = 0x00001000;
/** 23.10 (6.27): particles are carried along with the emitter's movement (m_flags 0x80000, 0x0097eb10). */
export const PARTICLE_FLAG_FOLLOW = 0x00004000;
/** 23.10 (6.27): a head quad is drawn (SetParticleStyle 0x00978d00 → m_flags 0x4). */
export const PARTICLE_FLAG_HEAD = 0x00020000;
/** 23.10 (6.27): a tail quad is drawn, back along the velocity (SetParticleStyle → m_flags 0x8). */
export const PARTICLE_FLAG_TAIL = 0x00040000;
/** ScaleVary works on x and y separately; without it, x varies both and y is unused. */
export const PARTICLE_FLAG_SCALE_VARY_INDEPENDENT = 0x00080000;
/**
 * 13.10 6.15: a random flip-book cell per particle. Wow.exe maps record flag 0x10000 to emitter flag 0x100000
 * (0x00833xxx → 0x00978e30, only when the grid has more than one cell) and 0x00979e90 draws the cell from the
 * particle's own seed when the head-cell ramp has no keys. The bit kept here before (0x200000) is the record's
 * 0x4, which Wow.exe reads as something else entirely.
 */
export const PARTICLE_FLAG_RANDOM_FLIPBOOK = 0x00010000;
/**
 * 13.10 6.15: record flag 0x200 → emitter 0x10000: half the particles spin the other way (0x0097be80 negates the
 * angle when bit 5 of the particle's address is set; here a bit of the spawn serial stands in for the address).
 */
export const PARTICLE_FLAG_SPIN_EITHER_WAY = 0x00000200;

/**
 * 25.10 (6.27): the emitter inherits its own movement (record 0x40 → m_flags 0x800 at 0x00833d…, M2Model setup;
 * CParticleEmitter2::Update 0x0097eb10 measures it every 1/30 s, CreateParticle 0x009815c0/0x00981950 adds it).
 */
export const PARTICLE_FLAG_INHERIT_VELOCITY = 0x00000040;
/** 25.10 (6.27): spawn anywhere along the emitter's move this step (record 0x800 → m_flags 0x2000, 0x0097d8c0). */
export const PARTICLE_FLAG_SPAWN_ALONG_PATH = 0x00000800;
/**
 * 25.10 (6.27): a world-space particle is born on the ground under it, raised by its larger birth scale (record
 * 0x2000 → m_flags 0x40000, ProjectParticle 0x00979740 from CreateParticle 0x009815c0/0x00981950).
 */
export const PARTICLE_FLAG_SPAWN_ON_GROUND = 0x00002000;
/**
 * 25.10 (6.27): no steady stream — one burst of `rate` particles each time the emitter turns visible with a rate
 * (record 0x8000 clears m_flags 0x1 at 0x00833e…; CM2Model::AnimateParticleST 0x008309c0 raises m_flags 0x40 on
 * the edge, EmitNewParticles 0x0097d8c0 spends int(rate) at once). 1,665 of the 8,454 spell visuals use it.
 */
export const PARTICLE_FLAG_BURST = 0x00008000;
/** 25.10 (6.27): unlit material — without it the particle takes the scene's light (CParticleMat bit 1, 0x0097e730). */
export const PARTICLE_FLAG_UNLIT = 0x00000001;

/**
 * 25.10 (6.27): CM2Model::AnimateParticleST (0x008309c0) puts every emitter's frame through the static matrix at
 * 0x00d411e0 — (0,1,0,0, −1,0,0,0, 0,0,1,0, 0,0,0,1), built at 0x00830c74 — before its bone: the emitter's own
 * x runs along the model's y and its y along the model's −x. So a plane's length (0xC8) lies along the model's y, a
 * partial azimuth starts at the model's +y, and a model-space quad in its XY plane is turned a quarter. Census:
 * 1,537 spell visuals have a plane longer than wide, 927 a partial azimuth, 790 a model-space XY quad.
 */
function rotateEmitterFrame(out: number[]): void {
  const x = out[0]!;
  out[0] = -out[1]!;
  out[1] = x;
}

/** 25.10 (6.27): VEL_UPDATE_TIME (0x0097eb10): how often the inherited velocity is measured. */
const INHERIT_UPDATE_SECONDS = 0.033333335;

/**
 * 25.10 (6.27): EmitNewParticles (0x0097d8c0) thins an emitter by its distance from the camera — rate ×
 * clamp(1 − (d − 50) · 0.02, 0.25, 1), d in yards — unless its effect asked to ignore distance (m_flags 0x400000,
 * CEffect::SetEmissionRateIgnoresDistance 0x006f75f0 — PlaySpellVisualKit 0x00745230 asks it for a spell with a
 * SpellMissile row: `VisualInstance.ignoreDistance`, the renderer then passes no camera).
 */
export function emitterDistanceScale(distance: number): number {
  if (!(distance > 50)) return 1;
  const scale = 1 - (distance - 50) * 0.02;
  return scale < 0.25 ? 0.25 : scale;
}

/** `M2Particle.emitterType`. */
export const EMITTER_PLANE = 1;
export const EMITTER_SPHERE = 2;
export const EMITTER_SPLINE = 3;
export const EMITTER_BONE = 4;


/**
 * The most particles one emitter can draw at once: Wow.exe's own limit, not a guess.
 *
 * 13.10 6.15: there is no fixed 256 in Wow.exe. An emitter's pool (0x0097edf0 → 0x0097e480 → 0x0097e3f0) is
 * round((rate + rateVary) · (lifespan + lifespanVary) · 1.15) particles (0x009f23cc = 1.15) rounded up to a power
 * of two, regrown whenever those values rise, and spawning stops while the pool has no free slot (0x0097d8c0).
 * What does cap it is the draw (0x0097e730): at most 0x4000 vertices a call, four a quad — 4,096 particles.
 * Census 05.10: 1,069 of 25,520 emitters (4.2 %) want more than the 256 this used to be.
 */
export const EMITTER_CAPACITY = 4096;

/** 0x009f23cc: the headroom Wow.exe gives an emitter's pool over rate × lifespan. */
const POOL_HEADROOM = 1.15;

/** The largest value a track reaches anywhere — the pool must hold the busiest moment of the emitter's life. */
function trackMaximum(track: WvmTrack | undefined, fallback: number): number {
  let maximum = -Infinity;
  for (const sub of track?.tracks ?? []) {
    for (let index = 0; index < sub.values.length; index++) maximum = Math.max(maximum, sub.values[index]!);
  }
  return Number.isFinite(maximum) ? maximum : fallback;
}

/**
 * 13.10 6.15: how many particles this emitter's pool holds, as 0x0097edf0 sizes it: the next power of two of
 * round((rate + rateVary) · (lifespan + lifespanVary) · 1.15), here over the busiest key of each track (Wow.exe
 * regrows the pool as the values rise, never shrinks it), capped by the draw limit. 23.10 (6.27): no burst
 * multiplier — record 0x40 is velocity inheritance (0x0097eb10), and Sync (0x0097edf0) counts rate × life only.
 */
export function particleCapacity(emitter: WvmParticleEmitter): number {
  const rate = Math.max(0, trackMaximum(emitter.emissionRate, 0)) + Math.max(0, emitter.emissionRateVary);
  const life = Math.max(0, trackMaximum(emitter.lifespan, 1)) + Math.max(0, emitter.lifespanVary);
  if (!(rate > 0) || !Number.isFinite(rate * life)) return 0;
  // Wow.exe rounds to nearest, so a pool under half a particle would be empty and the emitter never seen; at
  // least one is kept, which is what this simulation always gave such an emitter (a spell's first burst).
  const wanted = Math.max(1, Math.round(rate * life * POOL_HEADROOM));
  let pool = 1;
  while (pool < wanted && pool < EMITTER_CAPACITY) pool *= 2;
  return Math.min(pool, EMITTER_CAPACITY);
}

/**
 * 13.10 6.15: which per-sequence sub-track an emitter reads while `sequence` plays.
 *
 * Wow.exe samples every emitter track on the sequence its bone is playing (0x0082d2f0 → 0x0082b340): the
 * sub-array of that slot, sub-array 0 when the slot is past the track's sub-array count, and the default (0;
 * 1 for enabledIn, 0x0082b270) when that slot's sub-array is empty. The artifact keeps only the non-empty
 * sub-arrays with their slots, so the count is not known: a track whose only keys are sequence 0 is read as a
 * one-sub-array track — constant on every sequence, the common case — and anything else by the playing slot.
 * No sequence (a doodad, nothing playing) keeps the first sub-track, as before. A global-sequence track ignores it.
 */
export function emitterTrackSequence(track: WvmTrack | undefined, sequence: number | undefined): number | undefined {
  if (sequence === undefined || !track || track.globalSequence >= 0) return undefined;
  const tracks = track.tracks;
  if (tracks.length === 0 || (tracks.length === 1 && tracks[0]!.sequence === 0)) return undefined;
  return sequence;
}

/** One emitter track at this frame, on the playing sequence (`emitterTrackSequence`). */
function emitterTrack(
  value: WvmTrack, animationMs: number, worldMs: number, globalSequences: Uint32Array,
  fallback: number, sequence: number | undefined,
): number {
  return sampleTrack(value, animationMs, worldMs, globalSequences, fallback, 0, emitterTrackSequence(value, sequence));
}

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
  // Runs for every emitter and every particle of a frame: no closures and no `find` callback here,
  // which were a third of a crowded city's per-frame garbage between them (bench heap profile).
  let sub = track.tracks[0];
  if (sequence !== undefined && track.globalSequence < 0) {
    sub = undefined;
    for (let index = 0; index < track.tracks.length; index++) {
      if (track.tracks[index]!.sequence === sequence) {
        sub = track.tracks[index];
        break;
      }
    }
  }
  // No keys for the sequence being played is not "invisible": it is "this track says nothing while
  // that plays", and what it says instead is the caller's own default.
  if (!sub) return fallback;
  const keys = sub.times.length;
  if (keys === 0) return fallback;
  const components = Math.max(1, track.components);
  const values = sub.values;
  if (keys === 1) return values[component] ?? fallback;

  const span = sub.times[keys - 1]! - sub.times[0]!;
  let time: number;
  if (track.globalSequence >= 0) {
    const duration = globalSequences[track.globalSequence] ?? 0;
    time = duration > 0 ? worldMs % duration : worldMs;
  } else {
    time = span > 0 ? sub.times[0]! + (animationMs % span) : animationMs;
  }

  if (time <= sub.times[0]!) return values[component] ?? fallback;
  if (time >= sub.times[keys - 1]!) return values[(keys - 1) * components + component] ?? fallback;
  let index = 0;
  while (index + 1 < keys && sub.times[index + 1]! <= time) index++;
  const from = sub.times[index]!;
  const to = sub.times[index + 1]!;
  const start = values[index * components + component] ?? fallback;
  // Interpolation 0 is a step; 1 is linear, and 2 and 3 are Hermite and Bezier, whose tangents the
  // artifact does not carry. Linear is what is left, and it is what the reference clients do too.
  if (track.interpolation === 0 || to <= from) return start;
  const fraction = (time - from) / (to - from);
  const end = values[(index + 1) * components + component] ?? fallback;
  return start + (end - start) * fraction;
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

  // Four ramps per particle per frame: the key reads are inlined rather than a closure per call.
  const values = ramp.values;
  const clamped = life < 0 ? 0 : life > 1 ? 1 : life;
  if (keys === 1 || clamped <= ramp.times[0]!) {
    for (let part = 0; part < out.length; part++) out[part] = values[Math.min(part, components - 1)] ?? fallback;
    return out;
  }
  if (clamped >= ramp.times[keys - 1]!) {
    const last = (keys - 1) * components;
    for (let part = 0; part < out.length; part++) out[part] = values[last + Math.min(part, components - 1)] ?? fallback;
    return out;
  }
  let index = 0;
  while (index + 1 < keys && ramp.times[index + 1]! <= clamped) index++;
  const from = ramp.times[index]!;
  const to = ramp.times[index + 1]!;
  const fraction = to > from ? (clamped - from) / (to - from) : 0;
  const first = index * components;
  const second = (index + 1) * components;
  for (let part = 0; part < out.length; part++) {
    const at = Math.min(part, components - 1);
    const start = values[first + at] ?? fallback;
    out[part] = start + ((values[second + at] ?? fallback) - start) * fraction;
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
  /** 05.10-A7a-F1 (6.15): this particle's offset into the twinkle noise table (`ParticleTwinkle.ts`). */
  phase?: number;
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
  animationStartMs?: number | undefined;
  worldStartMs?: number | undefined;
  /** 13.10 6.15: the sequence-table slot the model is playing, for per-sequence tracks (`emitterTrackSequence`). */
  sequence?: number | undefined;
  /** 25.10 (6.27): the camera in the scene, for the distance thinning (`emitterDistanceScale`); absent: none. */
  viewX?: number | undefined;
  viewY?: number | undefined;
  viewZ?: number | undefined;
  /**
   * 25.10 (6.27): the ground's scene height under scene (x, z), for record 0x2000 (`PARTICLE_FLAG_SPAWN_ON_GROUND`);
   * undefined where nothing is known (the particle keeps its spawn point, as when 0x00979740's callback fails).
   */
  ground?: ((x: number, z: number) => number | undefined) | undefined;
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
  /** 05.10-A7a-F1 (6.15): spawns so far, hashed into each particle's twinkle phase; no random draw. */
  twinkleSerial?: number;
  /** 13.10 6.15: the pool Wow.exe would give this emitter (`particleCapacity`); spawning stops when it is full. */
  readonly capacity: number;
  /**
   * 25.10 (6.27): record 0x40 — the inherited velocity (m_parentVelocity, scene axes for a world-space emitter,
   * the emitter's own for a model-space one) and the time since it was last measured (m_ivelTimer).
   */
  parentVX: number; parentVY: number; parentVZ: number;
  inheritTimer: number;
  /** 25.10 (6.27): record 0x8000 — whether this visible stretch has had its burst (M2ModelParticle m_burstFired). */
  burstFired: boolean;
  /** 25.10 (6.27): record 0x800 — the emitter's move this step, which spawns are spread along. */
  pathX: number; pathY: number; pathZ: number;
  /** 25.10 (6.27): a spline emitter's last end (0xDC) and whether its next spawn sits there (0x00981cd0). */
  splineEnd: number;
  splineAtEnd: boolean;
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
    capacity: particleCapacity(emitter), // 13.10 6.15
    parentVX: 0, parentVY: 0, parentVZ: 0, inheritTimer: 0, burstFired: false, pathX: 0, pathY: 0, pathZ: 0, // 25.10 (6.27)
    splineEnd: 0, splineAtEnd: false,
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
  system.twinkleSerial = 0; // 05.10-A7a-F1
  system.parentVX = system.parentVY = system.parentVZ = system.inheritTimer = 0; // 25.10 (6.27)
  system.burstFired = false;
  system.pathX = system.pathY = system.pathZ = 0;
  system.splineEnd = 0;
  system.splineAtEnd = false;
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

/**
 * 25.10 (6.27): a spline emitter's cubic Bézier (C3Spline_Bezier3): ⌊points / 3⌋ segments of four points sharing
 * ends, each 20-step length cached per point array. Writes the point at arc length `t` (0..1) and its first
 * derivative (the tangent, unnormalised); false without a whole segment.
 */
const BEZIER_LENGTHS = new WeakMap<Float32Array, Float64Array>();
function bezierAt(points: Float32Array, t: number, position: number[], tangent: number[]): boolean {
  const segments = Math.floor(points.length / 3 / 3);
  if (segments < 1 || points.length < (segments * 3 + 1) * 3) return false;
  let lengths = BEZIER_LENGTHS.get(points);
  if (!lengths) {
    lengths = new Float64Array(segments + 1);
    for (let segment = 0; segment < segments; segment++) {
      // 0x004c3b10: twenty chords at 0.05 steps.
      bezierPoint(points, segment, 0, scratchB);
      let px = scratchB[0]!, py = scratchB[1]!, pz = scratchB[2]!, length = 0;
      for (let step = 1; step <= 20; step++) {
        bezierPoint(points, segment, step * 0.05, scratchB);
        length += Math.hypot(scratchB[0]! - px, scratchB[1]! - py, scratchB[2]! - pz);
        px = scratchB[0]!; py = scratchB[1]!; pz = scratchB[2]!;
      }
      lengths[segment] = length;
      lengths[segments] = lengths[segments]! + length;
    }
    BEZIER_LENGTHS.set(points, lengths);
  }
  // 0x004c3bd0: walk the cached lengths to the segment holding t · total, unclamped within it.
  let segment = 0;
  let segmentT = t;
  if (segments > 1) {
    const target = lengths[segments]! * t;
    let before = 0;
    while (segment < segments - 1 && before + lengths[segment]! <= target) {
      before += lengths[segment]!;
      segment++;
    }
    segmentT = lengths[segment]! > 0 ? (target - before) / lengths[segment]! : 0;
  }
  bezierPoint(points, segment, segmentT, position);
  // The derivative of the Bernstein basis (0x004c3e70).
  const u = 1 - segmentT;
  const w0 = -3 * u * u, w1 = 3 * u * u - 6 * u * segmentT, w2 = 6 * u * segmentT - 3 * segmentT * segmentT, w3 = 3 * segmentT * segmentT;
  const at = segment * 9;
  for (let axis = 0; axis < 3; axis++) {
    tangent[axis] = w0 * points[at + axis]! + w1 * points[at + 3 + axis]! + w2 * points[at + 6 + axis]! + w3 * points[at + 9 + axis]!;
  }
  return true;
}

function bezierPoint(points: Float32Array, segment: number, t: number, out: number[]): void {
  const u = 1 - t;
  const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
  const at = segment * 9;
  for (let axis = 0; axis < 3; axis++) {
    out[axis] = w0 * points[at + axis]! + w1 * points[at + 3 + axis]! + w2 * points[at + 6 + axis]! + w3 * points[at + 9 + axis]!;
  }
}

/** 25.10 (6.27): `vector` turned by `angle` about the unit `axis` (C33Matrix::Rotation, as 0x00981d40 uses it). */
function rotateAbout(vector: number[], axis: number[], angle: number): void {
  const c = Math.cos(angle), s = Math.sin(angle);
  const x = vector[0]!, y = vector[1]!, z = vector[2]!;
  const ax = axis[0]!, ay = axis[1]!, az = axis[2]!;
  const dot = ax * x + ay * y + az * z;
  vector[0] = x * c + (ay * z - az * y) * s + ax * dot * (1 - c);
  vector[1] = y * c + (az * x - ax * z) * s + ay * dot * (1 - c);
  vector[2] = z * c + (ax * y - ay * x) * s + az * dot * (1 - c);
}

/** A symmetric draw: −1 to 1, so a "vary" of v spreads a value by ±v. */
function spread(random: () => number): number {
  return random() * 2 - 1;
}

const scratchA: number[] = [0, 0, 0];
const scratchB: number[] = [0, 0, 0];
const scratchC: number[] = [0, 0, 0];
const scratchRamp: number[] = [0, 0, 0];
const spawnPosition: number[] = [0, 0, 0];
const spawnDirection: number[] = [0, 0, 1];

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
  sequence: number | undefined, // 13.10 6.15
): void {
  const { emitter, globalSequences, random } = system;
  const track = (value: WvmTrack, fallback: number): number =>
    emitterTrack(value, animationMs, worldMs, globalSequences, fallback, sequence);

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
      // 25.10 (6.27): the direction is the drawn angles' unit vector whatever the radius (0x00981950) — a sphere
      // of no radius throws along its azimuth, not straight up: Judgement's two gold beams (bones 11/12 of
      // judgement_impact_chest.m2) rose as one vertical streak; a negative radius no longer turns it inward.
      direction[0] = flat * Math.cos(azimuth);
      direction[1] = flat * Math.sin(azimuth);
      direction[2] = Math.sin(elevation);
      // 23.10 (6.27): 0x20000/0x40000 are the head and tail styles, not outward/inward — a tail-only sphere
      // flew backwards here. A sphere's own direction bit is 0x100: straight up its Z (0x00981950).
      if ((emitter.flags & PARTICLE_FLAG_SPHERE_STRAIGHT_UP) !== 0) {
        direction[0] = 0;
        direction[1] = 0;
        direction[2] = 1;
      }
      break;
    }
    case EMITTER_SPLINE: {
      // 25.10 (6.27): as CSplineParticleEmitter::CreateParticle (0x00981d40) builds it — a point at arc length
      // t ∈ [start, end] (0xC8 and 0xDC clamped to 0..1, SetWidth 0x00981c90 / SetHeight 0x00981cd0; the first
      // spawn after `end` moves is at `end`) along the cubic Bézier through the points (C3Spline_Bezier3, basis
      // 0x00ac3778, 20-step segment lengths 0x004c3b10), thrown straight up the emitter's z — or, with a latitude,
      // up turned about the path's tangent by ±latitude and pushed out along that by longitude · rand. Census: 50
      // emitters in 136 spell visuals. Until 25.10 a random polyline point with the plane's cone.
      const start = Math.min(1, Math.max(0, areaLength));
      const end = Math.min(1, Math.max(0, areaWidth));
      let t: number;
      if (system.splineAtEnd) {
        t = end;
        system.splineAtEnd = false;
      } else {
        t = (end - start) * random() + start;
      }
      if (!bezierAt(emitter.splinePoints, t, position, scratchC)) {
        position[0] = position[1] = position[2] = 0;
        scratchC[0] = 1; scratchC[1] = 0; scratchC[2] = 0;
      }
      direction[0] = 0;
      direction[1] = 0;
      direction[2] = 1;
      if (vertical !== 0) {
        normalise(scratchC);
        rotateAbout(direction, scratchC, vertical * spread(random));
        if (horizontal !== 0) {
          const out = random() * horizontal;
          position[0] = position[0]! + direction[0]! * out;
          position[1] = position[1]! + direction[1]! * out;
          position[2] = position[2]! + direction[2]! * out;
        }
      }
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
  // 25.10 (6.27): the emitter's frame is the bone's turned a quarter about z (0x008309c0, `rotateEmitterFrame`).
  rotateEmitterFrame(position);
  rotateEmitterFrame(direction);
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
  if (system.particles.length > 0 || system.capacity <= 0) return false; // 13.10 6.15: an empty pool spawns nothing
  const { emitter, globalSequences } = system;
  const enabled = emitterTrack(emitter.enabledIn, frame.animationMs, frame.worldMs,
    globalSequences, 1, frame.sequence);
  const rate = emitterTrack(emitter.emissionRate, frame.animationMs, frame.worldMs,
    globalSequences, 0, frame.sequence);
  if (enabled <= 0.5 || rate <= 0) return false;
  // Set the transform/origin exactly as a zero-time ordinary step would before spawning in the
  // emitter's current frame. No pending debt or particle age is fabricated.
  stepParticlesOnce(system, 0, frame);
  // 25.10 (6.27): a burst emitter's first frame is its whole burst (0x0097d8c0), and it is then spent.
  if ((emitter.flags & PARTICLE_FLAG_BURST) !== 0) {
    system.burstFired = true;
    emitBurst(system, frame, Math.floor(rate));
    return system.particles.length > 0;
  }
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
  const { matrix, animationMs, worldMs, sequence } = frame;
  const track = (value: WvmTrack, fallback: number): number =>
    emitterTrack(value, animationMs, worldMs, globalSequences, fallback, sequence); // 13.10 6.15

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
  // 23.10 (6.27): only a following emitter (record 0x4000 → m_flags 0x80000) carries its particles, by
  // clamp(speed · slope + intercept, 0, 1) of its own move — the line through (followSpeed1, followScale1) and
  // (followSpeed2, followScale2), no slope when the speeds coincide (SetFollowParams 0x00978dd0, Update
  // 0x0097eb10) — and only particles older than two steps take it (MoveParticle 0x00979bb0). SoR's emitters
  // author follow values without the bit, and every one of them was dragged along.
  let carryX = 0;
  let carryY = 0;
  let carryZ = 0;
  if (!system.modelSpace && (emitter.flags & PARTICLE_FLAG_FOLLOW) !== 0 && step > 0) {
    const speed = Math.hypot(moveX, moveY, moveZ) / step;
    const span = emitter.followSpeed2 - emitter.followSpeed1;
    const flat = Math.abs(span) < 2.384e-7;
    const slope = flat ? 0 : (emitter.followScale2 - emitter.followScale1) / span;
    const intercept = flat ? 0 : emitter.followScale1 - emitter.followSpeed1 * slope;
    const scale = Math.min(1, Math.max(0, speed * slope + intercept));
    carryX = moveX * scale;
    carryY = moveY * scale;
    carryZ = moveZ * scale;
  }

  // 23.10 (6.27): which way is down. Wow.exe takes gravity off the particle's own z (MoveParticle 0x00979bb0):
  // a model-space particle falls along its emitter's −Z, every other one along the world's — the scene's −Y.
  // Record 0x8 is the unfogged material bit, not a "world up" switch (0x00833d…, 0x008214e0).
  let gravityX = 0;
  let gravityY = -1;
  let gravityZ = 0;
  if (system.modelSpace) {
    gravityY = 0;
    gravityZ = -1;
  }
  // 23.10 (6.27): a sphere whose particles stop at the centre (record 0x80 on a sphere → m_flags 0x1000).
  const stopAtCentre = emitter.emitterType === EMITTER_SPHERE && (emitter.flags & PARTICLE_FLAG_SPHERE_STOP_AT_CENTRE) !== 0;
  const centreX = system.modelSpace ? emitter.position[0] : system.originX;
  const centreY = system.modelSpace ? emitter.position[1] : system.originY;
  const centreZ = system.modelSpace ? emitter.position[2] : system.originZ;

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
    // 23.10 (6.27): the carry reaches particles older than two steps only (0x00979bb0).
    const carried = particle.age > step + step;
    const stepX = particle.vx * step;
    const stepY = particle.vy * step;
    const stepZ = particle.vz * step;
    particle.x += stepX + (carried ? carryX : 0);
    particle.y += stepY + (carried ? carryY : 0);
    particle.z += stepZ + (carried ? carryZ : 0);
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
    // 23.10 (6.27): a sphere's inward particle is gone once it moves away from the centre (0x00979bb0).
    if (stopAtCentre && step > 0
      && (particle.x - centreX) * stepX + (particle.y - centreY) * stepY + (particle.z - centreZ) * stepZ > 0) {
      particles[index] = particles[particles.length - 1]!;
      particles.pop();
    }
  }

  if (step <= 0) return;

  // 25.10 (6.27): record 0x40 — Update (0x0097eb10) measures the emitter's move every VEL_UPDATE_TIME: the last
  // frame's move × ivelScale (record 0x170, m_ivelScale +0x14c) / (30 × the time since the last measurement), and
  // zero while nothing is alive. It is a world vector; a model-space emitter adds it to its particles' own-frame
  // velocity unconverted, as 0x009815c0 does — the scene move (x, y, z) is the world's (x, −z, y), taken as the
  // emitter's (turned) frame and so the bone frame's (z, x, y).
  if ((emitter.flags & PARTICLE_FLAG_INHERIT_VELOCITY) !== 0) {
    system.inheritTimer += step;
    if (system.inheritTimer > INHERIT_UPDATE_SECONDS) {
      const scale = particles.length > 0 ? emitter.burstMultiplier / (system.inheritTimer * 29.999998) : 0;
      system.inheritTimer = 0;
      if (system.modelSpace) {
        system.parentVX = moveZ * scale;
        system.parentVY = moveX * scale;
        system.parentVZ = moveY * scale;
      } else {
        system.parentVX = moveX * scale;
        system.parentVY = moveY * scale;
        system.parentVZ = moveZ * scale;
      }
    }
  }
  // 25.10 (6.27): record 0x800 — this step's move, for spawns spread along it (0x0097d8c0).
  system.pathX = moveX;
  system.pathY = moveY;
  system.pathZ = moveZ;

  // Off for this stretch of the animation, and that is a real state rather than an absence: four
  // of the twenty-six local emitters key `enabledIn`, and all four switch off partway through.
  const enabled = track(emitter.enabledIn, 1);
  const base = enabled > 0.5 ? track(emitter.emissionRate, 0) : 0;
  const burst = (emitter.flags & PARTICLE_FLAG_BURST) !== 0; // 25.10 (6.27)
  // 25.10 (6.27): a spline emits rate × end (SetEmissionRate 0x009814e0), and its first spawn after the end moves
  // is at the end (SetHeight 0x00981cd0).
  let splineScale = 1;
  if (emitter.emitterType === EMITTER_SPLINE) {
    const end = Math.min(1, Math.max(0, track(emitter.emissionAreaWidth, 0)));
    if (Math.abs(end - system.splineEnd) >= 2.384e-7) {
      system.splineEnd = end;
      system.splineAtEnd = true;
    }
    splineScale = end;
  }
  if (base <= 0) {
    // Stopped, not merely quiet: an emitter that has been switched off owes nothing when it
    // comes back on. 25.10 (6.27): and a burst emitter fires again (0x008309c0 clears m_burstFired).
    system.pending = 0;
    system.burstFired = false;
    return;
  }
  // 23.10 (6.27): the rate is the rate — record 0x40 is velocity inheritance (0x0097eb10) and EmitNewParticles
  // (0x0097d8c0) multiplies only by the density setting and the view-distance thinning, not by 0x170.
  // 25.10 (6.27): the thinning is applied (`emitterDistanceScale`), from the emitter's origin to the camera.
  const rate = splineScale * (frame.viewX === undefined ? base : base * emitterDistanceScale(Math.hypot(
    system.originX - frame.viewX, system.originY - (frame.viewY ?? 0), system.originZ - (frame.viewZ ?? 0))));
  // A step whose variance draw came out at or below zero contributes nothing and takes nothing
  // away. Clearing the accumulator here instead loses every fraction of a particle banked since
  // the last spawn, and loses more of it the higher the frame rate — 82 of the client's emitters
  // carry a variance and 53 of them have one large enough to go negative, so
  // `spells\missile_wave_ice.m2` emitted 0.8 particles in two seconds at 30 frames a second, 0.1
  // at 60 and none at all at 144, against the 4 its numbers ask for.
  const varied = emitter.emissionRateVary === 0
    ? rate
    : Math.max(0, rate + emitter.emissionRateVary * spread(random));
  const capacity = system.capacity;
  if (burst) {
    // 25.10 (6.27): int(rate) particles at once on the first visible step, then nothing until the emitter has been
    // off or rateless again (0x0097d8c0 under m_flags 0x40; the steady stream needs m_flags 0x1, which 0x8000 clears).
    if (!system.burstFired) {
      system.burstFired = true;
      emitBurst(system, frame, Math.floor(varied));
    }
    return;
  }
  if (varied <= 0) return;

  system.pending += varied * step;
  // A tab that was in the background does not owe a thousand particles on the frame it returns.
  // 13.10 6.15: the pool is the emitter's own (`particleCapacity`, Wow.exe 0x0097edf0), not a flat 256.
  if (system.pending > capacity) system.pending = capacity;
  // 25.10 (6.27): int(owed + 0.5) are spawned and the owed count keeps the rest, which may go below zero
  // (EmitNewParticles 0x0097d8c0) — a slow emitter's first particle comes half a period sooner than at owed ≥ 1.
  let count = Math.floor(system.pending + 0.5);
  let emitted = 0;
  while (count > 0 && particles.length < capacity) {
    particles.push(spawn(system, frame));
    count--;
    emitted++;
  }
  system.pending -= emitted;
  if (particles.length >= capacity) system.pending = 0;
}

/** 25.10 (6.27): one burst of `count` particles, as far as the pool has room (0x0097d8c0). */
function emitBurst(system: ParticleSystem, frame: EmitterFrame, count: number): void {
  const particles = system.particles;
  for (let left = count; left > 0 && particles.length < system.capacity; left--) particles.push(spawn(system, frame));
}

function spawn(system: ParticleSystem, frame: EmitterFrame): Particle {
  const { emitter, globalSequences, random } = system;
  const { matrix, animationMs, worldMs, sequence } = frame;
  const track = (value: WvmTrack, fallback: number): number =>
    emitterTrack(value, animationMs, worldMs, globalSequences, fallback, sequence); // 13.10 6.15

  // 25.10 (6.27): module scratch, not two arrays per spawn (a burst spawns hundreds at once).
  const local = spawnPosition;
  const direction = spawnDirection;
  local[0] = 0; local[1] = 0; local[2] = 0;
  direction[0] = 0; direction[1] = 0; direction[2] = 1;
  spawnLocal(system, animationMs, worldMs, local, direction, sequence);

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
    // 25.10 (6.27): record 0x800 — born anywhere along the emitter's move this step (0x0097d8c0 sets the frame's
    // translation to last + move · t, t uniform).
    if ((emitter.flags & PARTICLE_FLAG_SPAWN_ALONG_PATH) !== 0) {
      const back = 1 - random();
      x -= system.pathX * back;
      y -= system.pathY * back;
      z -= system.pathZ * back;
    }
    // 25.10 (6.27): record 0x2000 — on the ground under it, raised by the larger of its birth scales
    // (ProjectParticle 0x00979740: z = ground + max(scale.x, scale.y) of the scale ramp at its age, here 0).
    if ((emitter.flags & PARTICLE_FLAG_SPAWN_ON_GROUND) !== 0 && frame.ground) {
      // World::ProjectPositionCallback (0x0077f540): a ray 20 yards straight down from the particle; no floor in that
      // reach (or one above it) leaves the particle where it was born.
      const ground = frame.ground(x, z);
      if (ground !== undefined && Number.isFinite(ground) && ground <= y && y - ground <= 20) {
        sampleRamp(emitter.scale, 0, scratchRamp, 1);
        const lift = (emitter.scale?.components ?? 1) > 1 ? Math.max(scratchRamp[0]!, scratchRamp[1]!) : scratchRamp[0]!;
        y = ground + lift;
      }
    }
    // 23.10 (6.27): the direction is turned *and* stretched by the emitter's frame — Wow.exe multiplies the
    // emitter-space velocity by the transform's 3×3 as it stands (CPlaneParticleEmitter::CreateParticle
    // 0x009815c0, the sphere's 0x00981950), so a spell effect at twice the size throws its sparks twice as far,
    // as its spawn area already was. Until 23.10 the vector was normalised here.
    transformVector(matrix, direction[0]!, direction[1]!, direction[2]!, scratchB);
    vx = scratchB[0]! * speed;
    vy = scratchB[1]! * speed;
    vz = scratchB[2]! * speed;
  }
  // 25.10 (6.27): record 0x40 — plus the emitter's inherited velocity, varied like the speed (1 + sfloat ·
  // variation; 0x009815c0, 0x00981950).
  if ((emitter.flags & PARTICLE_FLAG_INHERIT_VELOCITY) !== 0
    && (system.parentVX !== 0 || system.parentVY !== 0 || system.parentVZ !== 0)) {
    const inherit = 1 + variation * spread(random);
    vx += system.parentVX * inherit;
    vy += system.parentVY * inherit;
    vz += system.parentVZ * inherit;
  }

  const life = Math.max(0.02, track(emitter.lifespan, 1) + emitter.lifespanVary * spread(random));
  const independent = (emitter.flags & PARTICLE_FLAG_SCALE_VARY_INDEPENDENT) !== 0;
  const varyX = emitter.scaleVary[0];
  const varyY = independent ? emitter.scaleVary[1] : emitter.scaleVary[0];
  const cells = Math.max(1, emitter.textureRows) * Math.max(1, emitter.textureColumns);
  const scaleX = Math.max(0, 1 + varyX * spread(random));
  const scaleY = Math.max(0, 1 + varyY * spread(random));
  // `baseSpin` is zero on every one of the 8,575 emitters in the client, so what this really
  // reads is a random starting angle from `baseSpinVary` — which is 2π wherever it is set, and
  // 2π is exactly "anywhere".
  let spin = emitter.baseSpin + emitter.baseSpinVary * spread(random);
  let spinRate = emitter.spin + emitter.spinVary * spread(random);
  // 13.10 6.15: Wow.exe's random cell (0x00979e90) only when the head-cell ramp is empty and there is a grid.
  const randomCell = (emitter.flags & PARTICLE_FLAG_RANDOM_FLIPBOOK) !== 0 && cells > 1
    && (emitter.headCell?.times.length ?? 0) === 0;
  const cellOffset = randomCell ? Math.floor(random() * cells) : 0;
  // 05.10-A7a-F1 (6.15): from the spawn serial, so the random stream above is unchanged.
  const serial = system.twinkleSerial = ((system.twinkleSerial ?? 0) + 1) >>> 0;
  const phase = twinklePhase(serial);
  // 13.10 6.15: record flag 0x200 turns every other particle the other way (0x0097be80 negates the angle).
  if ((emitter.flags & PARTICLE_FLAG_SPIN_EITHER_WAY) !== 0 && (phase & 1) === 1) {
    spin = -spin;
    spinRate = -spinRate;
  }

  return {
    x, y, z, vx, vy, vz,
    bx: x, by: y, bz: z,
    age: 0,
    life,
    scaleX,
    scaleY,
    spin,
    spinRate,
    cellOffset,
    phase,
  };
}

/**
 * 13.10 6.15: whether this emitter's quads turn at all. Wow.exe's quad writer (0x0097be80) draws the plain corner
 * table when spin (+0xc8) and spinVary (+0xcc) are both zero — the base angle (0x0097a130: baseSpin + vary) is then
 * never applied, however wide `baseSpinVary` is — and otherwise turns the quad by base + age · rate.
 */
export function particleSpins(emitter: Pick<WvmParticleEmitter, "spin" | "spinVary">): boolean {
  return emitter.spin !== 0 || emitter.spinVary !== 0;
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
  /** 23.10 (6.27): the tail quad's cell (the tail-cell ramp, Wow.exe InterpolateAllTracks 0x00979e90). */
  tailCell?: number;
  /**
   * 23.10 (6.27): the head ramp's next cell and how far towards it this moment is (0..1) — what the enhanced
   * profile's frame blending mixes; the faithful draw uses `cell` alone, as Wow.exe does.
   */
  nextCell?: number;
  cellBlend?: number;
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
  // 05.10-A7a-F1 (6.15): a twinkle reading now exists (`ParticleTwinkle.ts`) — behind the
  // `particleTwinkle` switch — 25.10 (6.27): on by default, the 3.3.5a writer being read exactly (0x0097be80).
  const twinkle = twinkleSize(emitter, particle.age, particle.phase ?? 0);
  if (twinkle !== 1) {
    out.width *= twinkle;
    out.height *= twinkle;
  }
  const cells = Math.max(1, emitter.textureRows) * Math.max(1, emitter.textureColumns);
  sampleRamp(emitter.headCell, life, scratchRamp, 0);
  const value = scratchRamp[0]! + particle.cellOffset;
  const cell = Math.floor(value);
  out.cell = ((cell % cells) + cells) % cells;
  // 23.10 (6.27): the step towards the next authored cell, never past the ramp's own last cell.
  const top = headCellMaximum(emitter.headCell) + particle.cellOffset;
  const next = Math.min(cell + 1, Math.max(cell, Math.floor(top)));
  out.nextCell = ((next % cells) + cells) % cells;
  out.cellBlend = next === cell ? 0 : value - cell;
  sampleRamp(emitter.tailCell, life, scratchRamp, 0);
  const tail = Math.floor(scratchRamp[0]!);
  out.tailCell = ((tail % cells) + cells) % cells;
  return out;
}

const HEAD_CELL_MAXIMA = new WeakMap<object, number>();

/** 23.10 (6.27): the largest cell a head ramp names (0 without one), cached per ramp. */
function headCellMaximum(ramp: WvmRamp | undefined): number {
  if (!ramp || ramp.values.length === 0) return 0;
  let maximum = HEAD_CELL_MAXIMA.get(ramp);
  if (maximum === undefined) {
    maximum = 0;
    for (let index = 0; index < ramp.values.length; index++) maximum = Math.max(maximum, ramp.values[index]!);
    HEAD_CELL_MAXIMA.set(ramp, maximum);
  }
  return maximum;
}

/** The camera's own axes in the scene, which is all a billboard needs to know about it. */
export interface BillboardView {
  rightX: number; rightY: number; rightZ: number;
  upX: number; upY: number; upZ: number;
}

/** Where one emitter's quads are written. Four vertices and six indices per quad. */
export interface QuadBuffers {
  positions: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  /**
   * 23.10 (6.27): the enhanced profile's frame blending — the next flip-book cell's corner UVs and the blend
   * towards it, per vertex. Absent on every faithful build, which then writes exactly what it always wrote.
   */
  uvs2?: Float32Array;
  blends?: Float32Array;
}

/** Room for `count` quads, with the index buffer they all share. */
export function createQuadBuffers(count: number, frameBlend = false): QuadBuffers & { indices: Uint16Array } {
  const indices = new Uint16Array(count * 6);
  for (let quad = 0; quad < count; quad++) {
    const base = quad * 4;
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], quad * 6);
  }
  return {
    positions: new Float32Array(count * 4 * 3),
    uvs: new Float32Array(count * 4 * 2),
    colors: new Float32Array(count * 4 * 4),
    ...(frameBlend ? { uvs2: new Float32Array(count * 4 * 2), blends: new Float32Array(count * 4) } : {}),
    indices,
  };
}

/**
 * 23.10 (6.27): how many quads one particle of this emitter draws — a head (record 0x20000), a tail
 * (0x40000) or both (SetParticleStyle 0x00978d00: four vertices each). An emitter with neither style draws a
 * head: no shipped 3.3.5a emitter is authored so (0 of the 5,445 under `spells\`), and a hand-made one in a
 * test or a tool should still show something.
 */
export function particleQuadsPerParticle(emitter: Pick<WvmParticleEmitter, "flags">): number {
  const head = (emitter.flags & PARTICLE_FLAG_HEAD) !== 0;
  const tail = (emitter.flags & PARTICLE_FLAG_TAIL) !== 0;
  return head && tail ? 2 : 1;
}

/**
 * 23.10 (6.27): what an emitter's drawn particles add up to this frame — their summed visible energy
 * (alpha × brightness × area) and its energy-weighted colour and centre in the scene. The enhanced profile
 * lights the surroundings from it (`SpellLights.ts`); nothing faithful reads it.
 */
export interface ParticleGlow {
  energy: number;
  red: number; green: number; blue: number;
  x: number; y: number; z: number;
}

const appearance: ParticleAppearance = {
  red: 1, green: 1, blue: 1, alpha: 1, width: 1, height: 1, cell: 0, tailCell: 0, nextCell: 0, cellBlend: 0,
};

/** Reused per call: the order a sorted emitter writes its particles in. */
let sortOrder = new Uint32Array(64);
let sortDepth = new Float64Array(64);

/**
 * Turns one emitter's live particles into quads, and says how many it wrote.
 *
 * 23.10 (6.27): written as Wow.exe's CParticleEmitter2::BuildVertex (0x0097be80) builds them, in the view's
 * plane: a head is the quad ±scale around the particle — the corner table at 0x00b2d5b4 is ±1, so the scale
 * ramp is the *half* size (until 23.10 this drew every particle at half its size) — upright, spinning, lying
 * in the particle space's XY plane (0x1000) or along its velocity (0x4); a tail runs from the particle back
 * along its velocity for `tailLength` seconds (clamped to its age by 0x400), as wide as its scale. Corner
 * texture coordinates are the client's (0x00b2d5d4): the cell's top-left texel at the view's top-left corner,
 * cell n at column n mod columns and row n div columns counted from the top of the sheet — the rows ran
 * from the bottom, upside down, before. Sizes take the emitter's scale only with record 0x20.
 *
 * The caller keeps the buffers and the geometry; this only fills them. A particle whose quad has no area or
 * no opacity is skipped rather than written.
 */
export function writeParticleQuads(
  system: ParticleSystem,
  view: BillboardView,
  buffers: QuadBuffers,
  glow?: ParticleGlow,
): number {
  const { emitter, particles } = system;
  const columns = Math.max(1, emitter.textureColumns);
  const rows = Math.max(1, emitter.textureRows);
  const flags = emitter.flags;
  const tailStyle = (flags & PARTICLE_FLAG_TAIL) !== 0;
  const headStyle = (flags & PARTICLE_FLAG_HEAD) !== 0 || !tailStyle;
  const xyQuad = (flags & PARTICLE_FLAG_XY_QUAD) !== 0;
  const velocityHead = (flags & PARTICLE_FLAG_VELOCITY_HEAD) !== 0;
  const clampTail = (flags & PARTICLE_FLAG_CLAMP_TAIL) !== 0;
  const spins = particleSpins(emitter); // 13.10 6.15
  const capacity = Math.floor(buffers.positions.length / 12);
  const m = system.matrix;
  const modelSpace = system.modelSpace;
  // m_xformScale: the length of the emitter transform's first column (UpdateXform 0x0097ac20).
  const frameScale = (flags & PARTICLE_FLAG_SCALE_WITH_EMITTER) !== 0 ? Math.hypot(m[0]!, m[1]!, m[2]!) : 1;
  const frameBlend = buffers.uvs2 !== undefined && buffers.blends !== undefined;

  // The XY plane of the particles' own space: the emitter's frame for model space, the world's horizontal
  // (WoW x and y are scene x and −z) otherwise (RenderParticlesPrep 0x0097a390), unit length either way.
  let planeAX = 1, planeAY = 0, planeAZ = 0, planeBX = 0, planeBY = 0, planeBZ = -1;
  if (xyQuad && modelSpace) {
    // 25.10 (6.27): the emitter's frame is the bone's turned a quarter about z (0x008309c0): its x is the bone's y,
    // its y the bone's −x, and s_billboardXform (0x0097a390) takes them from that frame.
    transformVector(m, 0, 1, 0, scratchA);
    normalise(scratchA);
    transformVector(m, -1, 0, 0, scratchB);
    normalise(scratchB);
    planeAX = scratchA[0]!; planeAY = scratchA[1]!; planeAZ = scratchA[2]!;
    planeBX = scratchB[0]!; planeBY = scratchB[1]!; planeBZ = scratchB[2]!;
  }

  // Depth order, far first (the client pops its queue deepest first), for a sorted emitter.
  const count = particles.length;
  const sorted = (flags & PARTICLE_FLAG_SORT) !== 0 && count > 1;
  if (sorted) {
    if (sortOrder.length < count) {
      sortOrder = new Uint32Array(count * 2);
      sortDepth = new Float64Array(count * 2);
    }
    // The view's forward is −(right × up).
    const forwardX = -(view.rightY * view.upZ - view.rightZ * view.upY);
    const forwardY = -(view.rightZ * view.upX - view.rightX * view.upZ);
    const forwardZ = -(view.rightX * view.upY - view.rightY * view.upX);
    for (let index = 0; index < count; index++) {
      const particle = particles[index]!;
      let x = particle.x, y = particle.y, z = particle.z;
      if (modelSpace) {
        transformPoint(m, x, y, z, scratchC);
        x = scratchC[0]!; y = scratchC[1]!; z = scratchC[2]!;
      }
      sortOrder[index] = index;
      sortDepth[index] = x * forwardX + y * forwardY + z * forwardZ;
    }
    const order = sortOrder.subarray(0, count);
    order.sort((left, right) => sortDepth[right]! - sortDepth[left]!);
  }

  let quads = 0;
  for (let visit = 0; visit < count; visit++) {
    if (quads >= capacity) break;
    const particle = particles[sorted ? sortOrder[visit]! : visit]!;
    particleAppearance(emitter, particle, appearance);
    if (appearance.alpha <= 0.002 || appearance.width <= 0 || appearance.height <= 0) continue;
    const sizeX = appearance.width * frameScale;
    const sizeY = appearance.height * frameScale;

    let centreX = particle.x;
    let centreY = particle.y;
    let centreZ = particle.z;
    if (modelSpace) {
      transformPoint(m, centreX, centreY, centreZ, scratchA);
      centreX = scratchA[0]!;
      centreY = scratchA[1]!;
      centreZ = scratchA[2]!;
    }
    // The velocity in the scene: a model-space one goes through the emitter's frame (s_particleXform).
    let velocityX = particle.vx;
    let velocityY = particle.vy;
    let velocityZ = particle.vz;
    if (modelSpace) {
      transformVector(m, velocityX, velocityY, velocityZ, scratchB);
      velocityX = scratchB[0]!;
      velocityY = scratchB[1]!;
      velocityZ = scratchB[2]!;
    }

    if (headStyle && quads < capacity) {
      // Four corners from two axes: corner (sx, sy) of {(−1,−1), (1,−1), (1,1), (−1,1)} is
      // centre + axis·sx·sizeX + side·sy·sizeY.
      let axisX = view.rightX, axisY = view.rightY, axisZ = view.rightZ;
      let sideX = view.upX, sideY = view.upY, sideZ = view.upZ;
      let width = sizeX;
      const speedSquared = velocityX * velocityX + velocityY * velocityY + velocityZ * velocityZ;
      if (velocityHead && speedSquared > 2.384e-7) {
        // 0x200000: the quad's x axis lies along the reverse velocity as the eye sees it, its length
        // foreshortened by how much of that velocity is in the view's plane.
        const along = -(velocityX * view.rightX + velocityY * view.rightY + velocityZ * view.rightZ);
        const up = -(velocityX * view.upX + velocityY * view.upY + velocityZ * view.upZ);
        const flat = Math.hypot(along, up);
        if (flat > 4.88e-4) {
          const ax = along / flat;
          const ay = up / flat;
          width = sizeX * flat / Math.sqrt(speedSquared);
          axisX = view.rightX * ax + view.upX * ay;
          axisY = view.rightY * ax + view.upY * ay;
          axisZ = view.rightZ * ax + view.upZ * ay;
          sideX = view.upX * ax - view.rightX * ay;
          sideY = view.upY * ax - view.rightY * ay;
          sideZ = view.upZ * ax - view.rightZ * ay;
        } else {
          width = 0;
        }
      } else {
        if (xyQuad) {
          axisX = planeAX; axisY = planeAY; axisZ = planeAZ;
          sideX = planeBX; sideY = planeBY; sideZ = planeBZ;
        }
        if (spins && particle.spin !== 0) { // 13.10 6.15: no spin rate, no turn (Wow.exe 0x0097be80)
          const cos = Math.cos(particle.spin);
          const sin = Math.sin(particle.spin);
          const baseAxisX = axisX, baseAxisY = axisY, baseAxisZ = axisZ;
          axisX = baseAxisX * cos + sideX * sin;
          axisY = baseAxisY * cos + sideY * sin;
          axisZ = baseAxisZ * cos + sideZ * sin;
          sideX = sideX * cos - baseAxisX * sin;
          sideY = sideY * cos - baseAxisY * sin;
          sideZ = sideZ * cos - baseAxisZ * sin;
        }
      }
      if (width > 0) {
        const dx = axisX * width, dy = axisY * width, dz = axisZ * width;
        const ex = sideX * sizeY, ey = sideY * sizeY, ez = sideZ * sizeY;
        const at = quads * 12;
        const positions = buffers.positions;
        positions[at] = centreX - dx - ex; positions[at + 1] = centreY - dy - ey; positions[at + 2] = centreZ - dz - ez;
        positions[at + 3] = centreX + dx - ex; positions[at + 4] = centreY + dy - ey; positions[at + 5] = centreZ + dz - ez;
        positions[at + 6] = centreX + dx + ex; positions[at + 7] = centreY + dy + ey; positions[at + 8] = centreZ + dz + ez;
        positions[at + 9] = centreX - dx + ex; positions[at + 10] = centreY - dy + ey; positions[at + 11] = centreZ - dz + ez;
        writeCellUvs(buffers.uvs, quads, appearance.cell, columns, rows, false);
        if (frameBlend) {
          writeCellUvs(buffers.uvs2!, quads, appearance.nextCell ?? appearance.cell, columns, rows, false);
          buffers.blends!.fill(appearance.cellBlend ?? 0, quads * 4, quads * 4 + 4);
        }
        writeColour(buffers.colors, quads);
        quads++;
        if (glow) addGlow(glow, centreX, centreY, centreZ, width * sizeY);
      }
    }

    if (tailStyle && quads < capacity) {
      let length = emitter.tailLength;
      if (clampTail && length > particle.age) length = particle.age;
      const tailX = -velocityX * length;
      const tailY = -velocityY * length;
      const tailZ = -velocityZ * length;
      const along = tailX * view.rightX + tailY * view.rightY + tailZ * view.rightZ;
      const up = tailX * view.upX + tailY * view.upY + tailZ * view.upZ;
      const flatSquared = along * along + up * up;
      const at = quads * 12;
      const positions = buffers.positions;
      if (flatSquared < 0.00077160494) {
        // Too short to read as a streak on screen: a plain upright quad in the tail's cell.
        const dx = view.rightX * sizeX, dy = view.rightY * sizeX, dz = view.rightZ * sizeX;
        const ex = view.upX * sizeY, ey = view.upY * sizeY, ez = view.upZ * sizeY;
        positions[at] = centreX - dx - ex; positions[at + 1] = centreY - dy - ey; positions[at + 2] = centreZ - dz - ez;
        positions[at + 3] = centreX + dx - ex; positions[at + 4] = centreY + dy - ey; positions[at + 5] = centreZ + dz - ez;
        positions[at + 6] = centreX + dx + ex; positions[at + 7] = centreY + dy + ey; positions[at + 8] = centreZ + dz + ez;
        positions[at + 9] = centreX - dx + ex; positions[at + 10] = centreY - dy + ey; positions[at + 11] = centreZ - dz + ez;
        writeCellUvs(buffers.uvs, quads, appearance.tailCell ?? 0, columns, rows, false);
        if (glow) addGlow(glow, centreX, centreY, centreZ, sizeX * sizeY);
      } else {
        // Across the streak, in the view's plane: (−perpY, perpX) with perp = flat · scale / |flat|.
        const inverse = 1 / Math.sqrt(flatSquared);
        const perpX = along * sizeX * inverse;
        const perpY = up * inverse * sizeY;
        const wx = -perpY * view.rightX + perpX * view.upX;
        const wy = -perpY * view.rightY + perpX * view.upY;
        const wz = -perpY * view.rightZ + perpX * view.upZ;
        const endX = centreX + tailX, endY = centreY + tailY, endZ = centreZ + tailZ;
        // Loop order head+w, head−w, end−w, end+w with the client's texcoords (0,0), (0,1), (1,1), (1,0):
        // u runs from the particle back along the tail, v across it.
        positions[at] = centreX + wx; positions[at + 1] = centreY + wy; positions[at + 2] = centreZ + wz;
        positions[at + 3] = centreX - wx; positions[at + 4] = centreY - wy; positions[at + 5] = centreZ - wz;
        positions[at + 6] = endX - wx; positions[at + 7] = endY - wy; positions[at + 8] = endZ - wz;
        positions[at + 9] = endX + wx; positions[at + 10] = endY + wy; positions[at + 11] = endZ + wz;
        writeCellUvs(buffers.uvs, quads, appearance.tailCell ?? 0, columns, rows, true);
        if (glow) addGlow(glow, centreX + tailX * 0.5, centreY + tailY * 0.5, centreZ + tailZ * 0.5, Math.sqrt(flatSquared) * sizeX);
      }
      if (frameBlend) {
        // A tail has no frame blending: its cell is the tail ramp's, held.
        buffers.uvs2!.set(buffers.uvs.subarray(quads * 8, quads * 8 + 8), quads * 8);
        buffers.blends!.fill(0, quads * 4, quads * 4 + 4);
      }
      writeColour(buffers.colors, quads);
      quads++;
    }
  }
  return quads;
}

/**
 * One quad's texture coordinates for `cell`. A head's loop corners (−1,−1), (1,−1), (1,1), (−1,1) take the
 * client's texcoords (0,1), (1,1), (1,0), (0,0); a tail's head+w, head−w, end−w, end+w take (0,0), (0,1),
 * (1,1), (1,0) (0x00b2d5d4 and BuildVertex 0x0097be80). v = 0 is the top of the image here, as for every
 * client texture (`flipY` off).
 */
function writeCellUvs(uvs: Float32Array, quad: number, cell: number, columns: number, rows: number, tail: boolean): void {
  const column = cell % columns;
  const row = Math.floor(cell / columns) % rows;
  const u0 = column / columns;
  const u1 = (column + 1) / columns;
  const v0 = row / rows;
  const v1 = (row + 1) / rows;
  const at = quad * 8;
  if (tail) {
    uvs[at] = u0; uvs[at + 1] = v0; uvs[at + 2] = u0; uvs[at + 3] = v1;
    uvs[at + 4] = u1; uvs[at + 5] = v1; uvs[at + 6] = u1; uvs[at + 7] = v0;
  } else {
    uvs[at] = u0; uvs[at + 1] = v1; uvs[at + 2] = u1; uvs[at + 3] = v1;
    uvs[at + 4] = u1; uvs[at + 5] = v0; uvs[at + 6] = u0; uvs[at + 7] = v0;
  }
}

/** The current appearance's colour on all four corners of one quad. */
function writeColour(colors: Float32Array, quad: number): void {
  const at = quad * 16;
  for (let corner = 0; corner < 4; corner++) {
    const to = at + corner * 4;
    colors[to] = appearance.red;
    colors[to + 1] = appearance.green;
    colors[to + 2] = appearance.blue;
    colors[to + 3] = appearance.alpha;
  }
}

/** 23.10 (6.27): one drawn quad's share of the emitter's glow (`ParticleGlow`). */
function addGlow(glow: ParticleGlow, x: number, y: number, z: number, area: number): void {
  const brightness = Math.max(appearance.red, appearance.green, appearance.blue);
  const energy = appearance.alpha * brightness * Math.max(0, area);
  if (!(energy > 0) || !Number.isFinite(energy)) return;
  glow.energy += energy;
  glow.red += appearance.red * appearance.alpha * area;
  glow.green += appearance.green * appearance.alpha * area;
  glow.blue += appearance.blue * appearance.alpha * area;
  glow.x += x * energy;
  glow.y += y * energy;
  glow.z += z * energy;
}


/* --- Ribbons --------------------------------------------------------------------------------
   13.10 6.15: a ribbon is not a cloud of independent points but one strip that remembers where its bone has
   been. It now runs as Wow.exe's CRibbonEmitter does, in `RibbonEmitter.ts`; the names stay exported here
   for the callers that have always found them in this file. */

export {
  RIBBON_MIN_LIFETIME, createRibbonSystem, resetRibbonSystem, ribbonCapacity, ribbonLifetime, ribbonRate,
  stepRibbon, stepRibbonCatchUp, writeRibbonStrip, type RibbonEdge, type RibbonSystem,
} from "./RibbonEmitter.js";

/**
 * The longest strip a ribbon can need: 0x009808a0 sizes the ring ceil(lifetime · ceil(rate)) + 2, and the
 * client's records reach edgesPerSecond 100 and edgeLifetime 25 — so 2,502 edges. Only a bound for callers that
 * want one number; each ribbon's buffers are sized by its own `ribbonCapacity`.
 */
export const RIBBON_CAPACITY = 2502;
