// 13.10 (6.13): one chain beam as Wow.exe 3.3.5a 12340 draws it — CLightning, ..\..\..\Common\Lightning.cpp
// (Ghidra read-only, .runtime/re-2026-10-11/glue-1110/1013-m4.txt, m5.txt; constants read from the PE).
// Pure: no three.js; server coordinates in, vertex arrays out (ChainBeam.ts uploads them).
//
// - Made (0x009aafb0 → 0x009a9900): the row's colour bytes become one ARGB word (byte 156 alpha, then red,
//   green, blue); every vertex takes it unless the row pulses. Then 0x009a8ec0 rolls a cycle: wave angle
//   and spin, wave phase (WavePhase with Flags 0x400, else a random turn), arc angle and spin, a flicker-on
//   time, pulse at 0, a random texture phase; the joints are made anew on the next update.
// - Each frame while shown (0x009ab3b0, dt seconds): the flicker clock runs down — with Flags 0x10 an
//   expired «on» turns the beam off for rand(MinFlickerOff, MaxFlickerOff), an expired «off» rolls a new
//   cycle; the texture scroll is fmod(scroll + TexCoordScale · dt, 1) (0x0088d93a with ST1 = 1); the length
//   L is capped at 10,000; the joints are kept at Flags 0x1 ? JointCount : round(L / AvgSegLen) + 2, plus
//   one, in [2, 1000] (0x009ab2e0), new ones made by 0x009a90c0 with the radius NoiseScale · L +
//   JointOffsetRadius: an offset (±r across, 0, ±r up), a drift (±JointMoveSpeed across and up) and a
//   life — rand · MaxDurationBetweenJoints once the set exists, rand(Min, Max) while it is first made.
//   Every joint but the first then drifts by its velocity · dt, except that with Flags 0x4 a joint whose
//   life ran out is made anew. The wave angle turns by its spin, the wave phase falls by WaveSpeed · dt,
//   the arc angle turns by its spin. With Flags 0x20 the pulse runs at PulseSpeed; with Flags 0x40 (or a
//   negative speed) a pulse past either end rolls a new cycle (a backward one restarting from the far end).
// - Placed (0x009a9ca0, or 0x009a9dc0 with Flags 0x2): the first joint at the start, the last at the end;
//   the frame of the whole beam (0x009a9260: side = (d.y, −d.x, 0) normalised — (0, ±1, 0) when d.y is 0 —
//   up = side × d / |d|); each joint between at start + d · i/(n−1) + (side · s.x + up · s.z) · scale, s
//   the joint offset smoothed by JointSmoothness (s = o · (1 − k) + s_last · k; the first is o). With
//   Flags 0x2 every JointsPerMinorJoint · MinorJointsPerMajorJoint-th joint is placed first on the straight
//   line at MajorJointScale, then every JointsPerMinorJoint-th between two of those at MinorJointScale, then
//   the rest between those at 1, each level in the frame of its own span.
// - Drawn (0x009aa210): to each joint at t = i/(n−1) the wave (0x009a9b30: bell 1 − 4(t − ½)², phase
//   WaveFreq · t · L + wave phase; Flags 0x8: WaveHeight · bell · (side · sin + up · cos), else the wave
//   vector · sin · bell, the wave vector side · cos(angle) · H + up · sin(angle) · H) and the arc (the arc
//   vector, the same of ArcHeight and the arc angle, · bell) are added; a band ±Width wide is built facing
//   the eye — per segment (each joint takes the mean of its two segments' sides) or, with Flags 0x80, one
//   side for the whole beam — and both ends are pinched to the end joints. The pulse (0x009a9490) fades a
//   window [pos − on − 2·fade, pos] in and out along the straight length; outside it nothing is drawn. The
//   texture runs u = i/(n−1), v = 0/1 (½ at the pinched ends), turned by u' = u · S − (phase + scroll),
//   S = L / TextureLength with Flags 0x100 (else 1), plus L / TextureLength more with Flags 0x300.
//   BlendMode is the engine's GxBlend; the alpha reference is 224 for AlphaKey, 1 for 2…6 (0x00ad8b7c).
//
// Hypotheses kept (listed in the report): the vertex RGB is applied once (Wow.exe also hands the RGB to the
// draw as a colour constant); the random generator is Math.random; the Combo walk is in ChainBeamPlan.ts.

import type { SpellChainEffect } from "../gateway/SpellVisual.js";

export interface LightningPoint {
  x: number;
  y: number;
  z: number;
}

/** Row Flags bits (SpellChainEffects.Flags) the code above reads. */
export const LIGHTNING_FIXED_JOINTS = 0x1;
export const LIGHTNING_HIERARCHY = 0x2;
export const LIGHTNING_JOINT_JUMPS = 0x4;
export const LIGHTNING_SPIRAL_WAVE = 0x8;
export const LIGHTNING_FLICKER = 0x10;
export const LIGHTNING_PULSE = 0x20;
export const LIGHTNING_PULSE_WRAPS = 0x40;
export const LIGHTNING_FLAT = 0x80;
export const LIGHTNING_TEXTURE_LENGTH = 0x100;
export const LIGHTNING_TEXTURE_SHIFT = 0x200;
export const LIGHTNING_FIXED_PHASE = 0x400;

/** 0x009ab2e0: joint count bounds; 0x009ea4c8: the longest beam. */
export const LIGHTNING_MAX_JOINTS = 1000;
export const LIGHTNING_MAX_LENGTH = 10_000;
const TINY = 2.384185791015625e-7; // 0x009ea27c
const BASIS_EPSILON = 0.000001; // 0x00a9806c [assumed: a small bias against a zero length]

/** The alpha test reference of a GxBlend (0x00ad8b7c), 0…255. */
export function lightningAlphaReference(blendMode: number): number {
  if (blendMode === 1) return 224;
  return blendMode >= 2 && blendMode <= 6 ? 1 : 0;
}

/** x87 round-to-nearest-even (ROUND / fistp in the default mode). */
function roundEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

interface Joint {
  /** Offset across (x) and up (z) of the beam's frame. */
  ox: number;
  oz: number;
  /** The smoothed offset; NaN before the first placement. */
  sx: number;
  sz: number;
  vx: number;
  vz: number;
  life: number;
}

const _side = { x: 0, y: 0, z: 0 };
const _dir = { x: 0, y: 0, z: 0 };
const _up = { x: 0, y: 0, z: 0 };
const _wave = { x: 0, y: 0, z: 0 };
const _arc = { x: 0, y: 0, z: 0 };
const _base = { x: 0, y: 0, z: 0 };
const _point = { x: 0, y: 0, z: 0 };

/** 0x009a9260: side and up of a direction (side ⟂ d horizontally, up = side × d / (|d| + ε)). */
function basis(d: LightningPoint, side: LightningPoint, up: LightningPoint): void {
  side.x = d.y;
  side.z = 0;
  if (Math.abs(side.x) >= TINY) {
    side.y = -d.x;
    const inverse = 1 / Math.sqrt(side.x * side.x + side.y * side.y);
    side.x *= inverse;
    side.y *= inverse;
  } else {
    side.y = d.x <= 0 ? 1 : -1;
  }
  const inverse = 1 / (Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z) + BASIS_EPSILON);
  up.x = inverse * (side.y * d.z - side.z * d.y);
  up.y = (d.x * side.z - side.x * d.z) * inverse;
  up.z = (side.x * d.y - side.y * d.x) * inverse;
}

/** One CLightning: its row, its clocks and its joints. */
export class LightningBeam {
  readonly row: SpellChainEffect;
  readonly #random: () => number;
  #off = false;
  #jointsMade = false;
  #backwardPulse = false;
  waveAngle = 0;
  waveSpin = 0;
  wavePhase = 0;
  arcAngle = 0;
  arcSpin = 0;
  flicker = 0;
  pulse = 0;
  texturePhase = 0;
  scroll = 0;
  readonly joints: Joint[] = [];
  /** Joint positions after the last `place` (server frame), 3 per joint. */
  positions = new Float64Array(0);
  /** The straight length of the last update. */
  length = 0;

  constructor(row: SpellChainEffect, random: () => number = Math.random) {
    this.row = row;
    this.#random = random;
    this.#rollCycle();
  }

  /** Whether the flicker has it off (0x009aa210 draws nothing then). */
  get off(): boolean {
    return this.#off;
  }

  #between(min: number, max: number): number {
    return min + this.#random() * (max - min);
  }

  #signed(): number {
    return this.#random() * 2 - 1;
  }

  /** 0x009a8ec0: a new cycle (and new joints at the next update). */
  #rollCycle(): void {
    const row = this.row;
    this.#off = false;
    this.#jointsMade = false;
    this.waveAngle = this.#between(row.minWaveAngle, row.maxWaveAngle);
    this.waveSpin = this.#between(row.minWaveSpin, row.maxWaveSpin);
    this.wavePhase = (row.flags & LIGHTNING_FIXED_PHASE) === 0 ? this.#random() * Math.PI * 2 : row.wavePhase;
    this.arcAngle = this.#between(row.minArcAngle, row.maxArcAngle);
    this.arcSpin = this.#between(row.minArcSpin, row.maxArcSpin);
    this.flicker = this.#between(row.minFlickerOnDuration, row.maxFlickerOnDuration);
    this.pulse = 0;
    if (row.pulseSpeed < 0) this.#backwardPulse = true;
    this.texturePhase = this.#random();
  }

  /** 0x009a90c0. */
  #makeJoint(joint: Joint, radius: number): void {
    const row = this.row;
    const up = this.#signed();
    const across = this.#signed();
    joint.ox = across * radius;
    joint.oz = radius * up;
    const driftUp = this.#signed();
    const driftAcross = this.#signed();
    joint.vx = row.jointMoveSpeed * driftAcross;
    joint.vz = row.jointMoveSpeed * driftUp;
    joint.life = this.#jointsMade ? this.#random() * row.maxDurationBetweenJoints
      : this.#between(row.minDurationBetweenJoints, row.maxDurationBetweenJoints);
  }

  /** 0x009ab2e0. */
  #keepJoints(length: number, radius: number): void {
    const row = this.row;
    let count = (row.flags & LIGHTNING_FIXED_JOINTS) !== 0 ? row.jointCount
      : roundEven(length / row.avgSegLen) + 2;
    count += 1;
    if (!(count >= 2)) count = 2;
    if (count > LIGHTNING_MAX_JOINTS) count = LIGHTNING_MAX_JOINTS;
    const keep = this.#jointsMade ? Math.min(this.joints.length, count) : 0;
    this.joints.length = Math.min(this.joints.length, count);
    for (let index = keep; index < count; index++) {
      const joint = this.joints[index] ?? { ox: 0, oz: 0, sx: Number.NaN, sz: Number.NaN, vx: 0, vz: 0, life: 0 };
      this.#makeJoint(joint, radius);
      joint.sx = Number.NaN;
      joint.sz = Number.NaN;
      this.joints[index] = joint;
    }
    this.#jointsMade = true;
    if (this.positions.length !== count * 3) this.positions = new Float64Array(count * 3);
  }

  /**
   * 0x009ab3b0: one frame of `dt` seconds for a beam from `from` to `to`. Returns false when the frame
   * changed nothing to draw (the beam is flickered off).
   */
  update(dt: number, from: LightningPoint, to: LightningPoint): boolean {
    const row = this.row;
    this.flicker -= dt;
    if (!this.#off) {
      if ((row.flags & LIGHTNING_FLICKER) !== 0 && this.flicker <= 0) {
        this.flicker = this.#between(row.minFlickerOffDuration, row.maxFlickerOffDuration);
        this.#off = true;
      }
    } else {
      if (this.flicker > 0) return false;
      this.#rollCycle();
    }
    this.scroll = row.texCoordScale !== 0 ? (this.scroll + row.texCoordScale * dt) % 1 : 0;
    let length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    if (length > LIGHTNING_MAX_LENGTH) length = LIGHTNING_MAX_LENGTH;
    this.length = length;
    const radius = row.noiseScale * length + row.jointOffsetRadius;
    this.#keepJoints(length, radius);
    for (let index = 1; index < this.joints.length; index++) {
      const joint = this.joints[index]!;
      joint.life -= dt;
      if ((row.flags & LIGHTNING_JOINT_JUMPS) === 0 || joint.life >= 0) {
        joint.ox += joint.vx * dt;
        joint.oz += joint.vz * dt;
      } else {
        this.#makeJoint(joint, radius);
      }
    }
    this.waveAngle += this.waveSpin * dt;
    this.wavePhase -= row.waveSpeed * dt;
    this.arcAngle += this.arcSpin * dt;
    if ((row.flags & LIGHTNING_PULSE) !== 0) {
      this.pulse += dt * row.pulseSpeed;
      if (this.#backwardPulse || (row.flags & LIGHTNING_PULSE_WRAPS) !== 0) {
        const span = row.pulseFadeLength + row.pulseFadeLength + row.pulseOnLength;
        if (length <= this.pulse - span) {
          this.#rollCycle();
          this.#backwardPulse = false;
          return !this.#off;
        }
        if (this.pulse < 0) {
          this.#rollCycle();
          this.#backwardPulse = false;
          this.pulse = span + length;
          return !this.#off;
        }
      }
    }
    return !this.#off;
  }

  /** 0x009a9350: one joint placed from `base` along `dir` · t with its smoothed offset · scale. */
  #placeJoint(index: number, base: LightningPoint, t: number, scale: number): void {
    const joint = this.joints[index]!;
    const k = this.row.jointSmoothness;
    if (Number.isNaN(joint.sx)) {
      joint.sx = joint.ox;
      joint.sz = joint.oz;
    } else {
      joint.sx = joint.ox * (1 - k) + joint.sx * k;
      joint.sz = joint.oz * (1 - k) + joint.sz * k;
    }
    const p = this.positions;
    p[index * 3] = (_side.x * joint.sx + _up.x * joint.sz) * scale + _dir.x * t + base.x;
    p[index * 3 + 1] = (_side.y * joint.sx + _up.y * joint.sz) * scale + _dir.y * t + base.y;
    p[index * 3 + 2] = (_side.z * joint.sx + _up.z * joint.sz) * scale + _dir.z * t + base.z;
  }

  #frameOf(fromIndex: number, toIndex: number): void {
    const p = this.positions;
    _dir.x = p[toIndex * 3]! - p[fromIndex * 3]!;
    _dir.y = p[toIndex * 3 + 1]! - p[fromIndex * 3 + 1]!;
    _dir.z = p[toIndex * 3 + 2]! - p[fromIndex * 3 + 2]!;
    basis(_dir, _side, _up);
    _base.x = p[fromIndex * 3]!;
    _base.y = p[fromIndex * 3 + 1]!;
    _base.z = p[fromIndex * 3 + 2]!;
  }

  /** 0x009a9980: the beam's own frame and the wave and arc vectors (`side`, `up` of the whole beam). */
  #waveAndArc(from: LightningPoint, to: LightningPoint, side: LightningPoint, up: LightningPoint): void {
    const row = this.row;
    const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
    basis(d, side, up);
    _wave.x = 0; _wave.y = 0; _wave.z = 0;
    _arc.x = 0; _arc.y = 0; _arc.z = 0;
    if (Math.abs(row.waveHeight) >= TINY && (row.flags & LIGHTNING_SPIRAL_WAVE) === 0) {
      const s = Math.sin(this.waveAngle) * row.waveHeight;
      const c = Math.cos(this.waveAngle) * row.waveHeight;
      _wave.x = side.x * c + up.x * s;
      _wave.y = side.y * c + up.y * s;
      _wave.z = side.z * c + up.z * s;
    }
    if (Math.abs(row.arcHeight) >= TINY) {
      const s = Math.sin(this.arcAngle) * row.arcHeight;
      const c = Math.cos(this.arcAngle) * row.arcHeight;
      _arc.x = side.x * c + up.x * s;
      _arc.y = side.y * c + up.y * s;
      _arc.z = side.z * c + up.z * s;
    }
  }

  /** 0x009a9ca0 / 0x009a9dc0: every joint's position for a beam from `from` to `to`. */
  place(from: LightningPoint, to: LightningPoint, beamSide: LightningPoint, beamUp: LightningPoint): void {
    const p = this.positions;
    const count = this.joints.length;
    if (count < 2) return;
    const last = count - 1;
    p[0] = from.x; p[1] = from.y; p[2] = from.z;
    p[last * 3] = to.x; p[last * 3 + 1] = to.y; p[last * 3 + 2] = to.z;
    this.#waveAndArc(from, to, beamSide, beamUp);
    const row = this.row;
    const minor = row.jointsPerMinorJoint;
    const major = minor * row.minorJointsPerMajorJoint;
    if ((row.flags & LIGHTNING_HIERARCHY) === 0 || !(minor > 0) || !(major > 0)) {
      this.#frameOf(0, last);
      for (let index = 1; index < last; index++) this.#placeJoint(index, _base, index / last, 1);
      return;
    }
    // Majors on the straight line.
    this.#frameOf(0, last);
    for (let index = major; index < last; index += major) this.#placeJoint(index, _base, index / last, row.majorJointScale);
    // Minors between majors.
    let next = Math.min(major, last);
    this.#frameOf(0, next);
    let step = minor / next;
    let t = step;
    for (let index = minor; index < last; index += minor) {
      if (index === next) {
        next = Math.min(index + major, last);
        this.#frameOf(index, next);
        step = minor / (next - index);
        t = step;
      } else {
        this.#placeJoint(index, _base, t, row.minorJointScale);
        t += step;
      }
    }
    // The rest between minors.
    next = Math.min(minor, last);
    this.#frameOf(0, next);
    step = 1 / next;
    t = step;
    for (let index = 1; index < last; index++) {
      if (index === next) {
        next = Math.min(index + minor, last);
        this.#frameOf(index, next);
        step = 1 / (next - index);
        t = step;
      } else {
        this.#placeJoint(index, _base, t, 1);
        t += step;
      }
    }
  }

  /**
   * 0x009aa210 + 0x009a9490: the band for this frame, seen from `eye`. Writes 2 vertices a joint into
   * `positions` (xyz), `uvs` (uv) and `alphas` (0…1); returns the vertex count (0: draw nothing).
   */
  build(from: LightningPoint, to: LightningPoint, eye: LightningPoint,
    positions: Float32Array, uvs: Float32Array, alphas: Float32Array): number {
    const row = this.row;
    const count = this.joints.length;
    if (this.#off || count < 2) return 0;
    const beamSide = { x: 0, y: 0, z: 0 };
    const beamUp = { x: 0, y: 0, z: 0 };
    this.place(from, to, beamSide, beamUp);
    const p = this.positions;
    const last = count - 1;
    const length = this.length;
    const width = row.width;
    const wave = row.waveHeight !== 0;
    const arc = row.arcHeight !== 0;
    const point = (index: number, t: number, out: LightningPoint): void => {
      out.x = p[index * 3]!;
      out.y = p[index * 3 + 1]!;
      out.z = p[index * 3 + 2]!;
      const bell = 1 - (t - 0.5) * (t - 0.5) * 4;
      if (wave) {
        const phase = row.waveFreq * t * length + this.wavePhase;
        if ((row.flags & LIGHTNING_SPIRAL_WAVE) !== 0) {
          const amplitude = row.waveHeight * bell;
          const s = Math.sin(phase) * amplitude;
          const c = Math.cos(phase) * amplitude;
          out.x += beamSide.x * s + beamUp.x * c;
          out.y += beamSide.y * s + beamUp.y * c;
          out.z += beamSide.z * s + beamUp.z * c;
        } else {
          const s = Math.sin(phase) * bell;
          out.x += _wave.x * s;
          out.y += _wave.y * s;
          out.z += _wave.z * s;
        }
      }
      if (arc) {
        out.x += _arc.x * bell;
        out.y += _arc.y * bell;
        out.z += _arc.z * bell;
      }
    };
    positions.fill(0, 0, count * 6);
    if ((row.flags & LIGHTNING_FLAT) === 0) {
      // Per segment: each joint takes the mean of the sides of its two segments.
      let prevX = p[0]!;
      let prevY = p[1]!;
      let prevZ = p[2]!;
      for (let index = 1; index <= last; index++) {
        point(index, index / last, _point);
        const sx0 = (_point.x - prevX);
        const sy0 = (_point.y - prevY);
        const sz0 = (_point.z - prevZ);
        const mx = (_point.x + prevX) * 0.5 - eye.x;
        const my = (_point.y + prevY) * 0.5 - eye.y;
        const mz = (_point.z + prevZ) * 0.5 - eye.z;
        let cx = sy0 * mz - sz0 * my;
        let cy = sz0 * mx - mz * sx0;
        let cz = my * sx0 - sy0 * mx;
        const norm = Math.sqrt(cx * cx + cy * cy + cz * cz);
        if (norm > 0.001) {
          cx /= norm; cy /= norm; cz /= norm;
        }
        cx *= width; cy *= width; cz *= width;
        const a = (index - 1) * 6;
        positions[a] = positions[a]! + (prevX + cx) * 0.5;
        positions[a + 1] = positions[a + 1]! + (prevY + cy) * 0.5;
        positions[a + 2] = positions[a + 2]! + (prevZ + cz) * 0.5;
        positions[a + 3] = positions[a + 3]! + (prevX - cx) * 0.5;
        positions[a + 4] = positions[a + 4]! + (prevY - cy) * 0.5;
        positions[a + 5] = positions[a + 5]! + (prevZ - cz) * 0.5;
        const b = index * 6;
        positions[b] = (_point.x + cx) * 0.5;
        positions[b + 1] = (_point.y + cy) * 0.5;
        positions[b + 2] = (_point.z + cz) * 0.5;
        positions[b + 3] = (_point.x - cx) * 0.5;
        positions[b + 4] = (_point.y - cy) * 0.5;
        positions[b + 5] = (_point.z - cz) * 0.5;
        prevX = _point.x; prevY = _point.y; prevZ = _point.z;
      }
    } else {
      // One side for the whole beam, from its middle.
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dz = to.z - from.z;
      const mx = (to.x + from.x) * 0.5 - eye.x;
      const my = (to.y + from.y) * 0.5 - eye.y;
      const mz = (to.z + from.z) * 0.5 - eye.z;
      let cx = dy * mz - dz * my;
      let cy = dz * mx - mz * dx;
      let cz = my * dx - dy * mx;
      const norm = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (norm > 0.001) {
        cx /= norm; cy /= norm; cz /= norm;
      }
      cx *= width; cy *= width; cz *= width;
      for (let index = 0; index < count; index++) {
        point(index, index / last, _point);
        const a = index * 6;
        positions[a] = _point.x + cx;
        positions[a + 1] = _point.y + cy;
        positions[a + 2] = _point.z + cz;
        positions[a + 3] = _point.x - cx;
        positions[a + 4] = _point.y - cy;
        positions[a + 5] = _point.z - cz;
      }
    }
    // Both ends pinched to the end joints.
    for (const [vertex, joint] of [[0, 0], [last, last]] as const) {
      const a = vertex * 6;
      positions[a] = positions[a + 3] = p[joint * 3]!;
      positions[a + 1] = positions[a + 4] = p[joint * 3 + 1]!;
      positions[a + 2] = positions[a + 5] = p[joint * 3 + 2]!;
    }
    // Texture (0x009ab3b0's UVs through 0x009aa210's matrix).
    const textureLength = row.textureLength > 0 ? row.textureLength : 1;
    const scale = (row.flags & LIGHTNING_TEXTURE_LENGTH) !== 0 ? length / textureLength : 1;
    let shift = this.texturePhase + this.scroll;
    if ((row.flags & (LIGHTNING_TEXTURE_LENGTH | LIGHTNING_TEXTURE_SHIFT)) === (LIGHTNING_TEXTURE_LENGTH | LIGHTNING_TEXTURE_SHIFT)) {
      shift += length / textureLength;
    }
    for (let index = 0; index < count; index++) {
      const u = (index / last) * scale - shift;
      const pinched = index === 0 || index === last;
      uvs[index * 4] = u;
      uvs[index * 4 + 1] = pinched ? 0.5 : 0;
      uvs[index * 4 + 2] = u;
      uvs[index * 4 + 3] = pinched ? 0.5 : 1;
    }
    this.#alphas(alphas, count, length / last);
    return count * 2;
  }

  /** 0x009a9490: the pulse window along the beam (every vertex at the row's alpha without Flags 0x20). */
  #alphas(alphas: Float32Array, count: number, step: number): void {
    const row = this.row;
    const base = (row.color[0] ?? 255) / 255;
    if ((row.flags & LIGHTNING_PULSE) === 0) {
      alphas.fill(base, 0, count * 2);
      return;
    }
    const head = this.pulse;
    const fadeOutStart = head - row.pulseFadeLength;
    const onStart = fadeOutStart - row.pulseOnLength;
    const fadeInStart = onStart - row.pulseFadeLength;
    let along = 0;
    for (let index = 0; index < count; index++, along += step) {
      let alpha: number;
      if (along < fadeInStart || along >= head) alpha = 0;
      else if (along < onStart) alpha = row.pulseFadeLength > 0 ? (along - fadeInStart) * base / row.pulseFadeLength : base;
      else if (along < fadeOutStart) alpha = base;
      else alpha = row.pulseFadeLength > 0 ? (head - along) * base / row.pulseFadeLength : 0;
      alphas[index * 2] = alpha;
      alphas[index * 2 + 1] = alpha;
    }
  }
}
