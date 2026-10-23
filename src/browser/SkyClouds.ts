// 23.10 (7.43): the day-night clouds as Wow.exe 3.3.5a (build 12340) makes them — a small CPU-built
// texture of value noise, coloured and lit per texel, on a shallow dome — replacing the shader
// noise and the directional shading that turned the shadowed half of a cloud black.
//
// Read out of Wow.exe (`.runtime/re-2026-10-05/A7b-6/b1–b3.txt` from the local Ghidra project, the
// constants checked byte for byte against the executable by `.runtime/lane-clouds/consts.mjs`; the
// named reconstruction github.com/SatyPardus/wowdecomp, `WorldClient/DayNight*.cpp`, was used to
// read the functions faster). The behaviour is described in our own words; nothing is copied.
//
//   * 0x007f2790 sets the clouds up once: level of detail 0 (0x007f1b10 → a 128 × 128 texture, size
//     table 0x00a41aac, `SkyCloudLOD` defaults to "0" and 0x007f1cd0 caps it at 3), the dome
//     (0x007f20e0, radius 1) and the sharpness table (0x007edb50 with 0.96 at 0x00a41d10, built while
//     the density byte is the start-up 0.6 at 0x009f5ad4, i.e. 102). The constructor 0x007f04b0
//     keeps 4 octaves (+0x28), 8 rows per frame (+0x10) and an animation speed of 2 (0x00a4040c).
//   * 0x007ed250 fills two tables: 256 lattice values 1 − 2·rand()/32767 (0x00d38688, the CRT's
//     `rand`, so they differ per session) and the fade (1 − cos(i·π/256))/2 (0x00d38188).
//   * 0x007efd00, every frame, writes 8 rows of the texture. Each texel sums 4 octaves of 3-D value
//     noise — lattice values picked through the permutation 0x00af4a70, blended by the fade table —
//     at steps of 16, 32, 64, 128 (0x00af4dc4, row 0: 8, 16, 32, 64 lattice cells across the
//     texture), amplitudes 1, 1/2, 1/4, 1/8. X starts at the animation frame (8.8 fixed point) and
//     the third axis is the frame itself, so the field drifts and slowly changes shape. The level
//     byte is sum·64 + 128 (0x009e8dd8, 0x009e8c6c); alpha = sharpness[level − density byte], where
//     the density byte is round((1 − Light float band 3)·255) taken as a byte. Colour (0x007efae0):
//     band 12 + band 11 · shade + band 10 · lit, shade = ((255 − alpha) / 2 + 64) / 255 — thin
//     cloud 0.75, thick 0.25 — and lit the cosine between the heightfield normal (the slope of the
//     first three octaves) and a POINT light in texel space: the sun (the moon outside 04:50–22:10)
//     projected onto the dome, 64 texels above it (+192 · storm, 0x00a41c9c), times
//     (1 − 0.75 · storm) (0x009e9ee4; the day curve 0x00af4be0 is 1 at every key). Both lengths use
//     the 0x5f3997bb inverse-square-root estimate with no refinement step. Clamped, stored as bytes;
//     a transparent texel takes its left neighbour's colour so filtering leaves no dark fringe.
//     After the last row the texture is shown if the frame (round(2 · seconds)) moved on.
//   * 0x007f20e0: the dome — 12 rings at polar angles 0x00a41ad4 × π (0 … 0.25, the horizon of a unit
//     sphere lowered by cos(π/4)), 16 segments, texture radius 0.5 · ring / 11 around the centre,
//     vertex alpha 0x00a41b04 (255 down to ring 8, then 128, 0, 0). 0x009acd40 draws it scaled by
//     6.67 with plain alpha blending, no depth, no fog, the texture times the vertex colour.
//   * 0x007eda90 + 0x007ef920: a light's direction meets the dome sphere and maps to the texture as
//     u, v = 0.5 + (x, y) / |(x, y)| · angle / (π/2) (angle from the sphere's top, at most π/4).
//     0x007efa30 reads the alpha byte under a body for its glare (`SkyGlare.ts`).
//
// Why ours went black (23.10): the shader lit a 2-octave field from the sun as a directional light
// at its own elevation; with a low sun half the slopes faced away, and Stormwind's Light has band
// 12 = black, so a thick core showed 0.25 · band 11 — near black. In the client the point light
// sits 64 texels over the sun's spot, so the cosine stays positive almost everywhere.

import * as THREE from "three";

/** 0x00af4a70: the 256-entry permutation the lattice is indexed through. */
export const CLOUD_PERMUTATION: Readonly<Uint8Array> = Uint8Array.from([
  225, 155, 210, 108, 175, 199, 221, 144, 203, 116, 70, 213, 69, 158, 33, 252, 5, 82, 173, 133, 222, 139, 174, 27,
  9, 71, 90, 246, 75, 130, 91, 191, 169, 138, 2, 151, 194, 235, 81, 7, 25, 113, 228, 159, 205, 253, 134, 142,
  248, 65, 224, 217, 22, 121, 229, 63, 89, 103, 96, 104, 156, 17, 201, 129, 36, 8, 165, 110, 237, 117, 231, 56,
  132, 211, 152, 20, 181, 111, 239, 218, 170, 163, 51, 172, 157, 47, 80, 212, 176, 250, 87, 49, 99, 242, 136, 189,
  162, 115, 44, 43, 124, 94, 150, 16, 141, 247, 32, 10, 198, 223, 255, 72, 53, 131, 84, 57, 220, 197, 58, 50,
  208, 11, 241, 28, 3, 192, 62, 202, 18, 215, 153, 24, 76, 41, 15, 179, 39, 46, 55, 6, 128, 167, 23, 188,
  106, 34, 187, 140, 164, 73, 112, 182, 244, 195, 227, 13, 35, 77, 196, 185, 26, 200, 226, 119, 31, 123, 168, 125,
  249, 68, 183, 230, 177, 135, 160, 180, 12, 1, 243, 148, 102, 166, 38, 238, 251, 37, 240, 126, 64, 74, 161, 40,
  184, 149, 171, 178, 101, 66, 29, 59, 146, 61, 254, 107, 42, 86, 154, 4, 236, 232, 120, 21, 233, 209, 45, 98,
  193, 114, 78, 19, 206, 14, 118, 127, 48, 79, 147, 85, 30, 207, 219, 54, 88, 234, 190, 122, 95, 67, 143, 109,
  137, 214, 145, 93, 92, 100, 245, 0, 216, 186, 60, 83, 105, 97, 204, 52,
]);
/** 0x00af4dc4, row 0 (level of detail 0): each octave's step per texel, in 1/256 of a lattice cell. */
export const CLOUD_OCTAVE_STEPS: readonly number[] = [16, 32, 64, 128];
/** 0x007f04b0 (+0x28): octaves summed. */
export const CLOUD_OCTAVES = 4;
/** 0x00a41aac[0] / 0x00a41ac0[0]: the texture's side at the default `SkyCloudLOD` 0, and its log2. */
export const CLOUD_TEXTURE_SIZE = 128;
export const CLOUD_TEXTURE_SHIFT = 7;
/** 0x007f04b0 (+0x10): rows written per frame. */
export const CLOUD_ROWS_PER_UPDATE = 8;
/** 0x00a4040c: animation frames (1/256 of a cell of drift and of shape change) per second. */
export const CLOUD_ANIM_SPEED = 2;
/** 0x00a41d10, 0x009f5ad4: the sharpness base and the density the table is built at. */
export const CLOUD_SHARPNESS = 0.9599999785423279;
export const CLOUD_START_DENSITY = 0.6000000238418579;
/** 0x009e8dd8 / 0x00a41c9c: the light's height above the texture, in texels, and its storm lift. */
export const CLOUD_LIGHT_HEIGHT = 64;
export const CLOUD_STORM_LIGHT_HEIGHT = 192;
/** 0x009e9ee4: the storm takes up to three quarters of the lit term. */
export const CLOUD_STORM_DIMMING = 0.75;
/** 0x00a41ad4 (× π): the dome rings' polar angles. */
export const CLOUD_RING_POLAR: readonly number[] = [
  0, 0.02500000037252903, 0.05000000074505806, 0.07500000298023224, 0.10000000149011612, 0.125,
  0.15000000596046448, 0.17499999701976776, 0.20499999821186066, 0.23000000417232513, 0.24500000476837158, 0.25,
];
/** 0x00a41b04: each ring's vertex alpha. */
export const CLOUD_RING_ALPHA: readonly number[] = [255, 255, 255, 255, 255, 255, 255, 255, 255, 128, 0, 0];
/** 0x007f20e0: segments around each ring (φ steps of π/8). */
export const CLOUD_DOME_SEGMENTS = 16;
/** 0x009eaf48: the dome sphere's centre sits cos(π/4) under the camera. */
const DOME_DROP = Math.cos(Math.PI / 4);

const BYTE = 0.0039215689; // 0x00a45564, 1/255 as the client multiplies it

/** The FPU's `fistp` (round half to even), as the client stores its bytes and frame number. */
export function fistp(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** The C runtime's `rand` (Microsoft's LCG), for 0x007ed250's lattice values. */
export function msvcRand(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 214013) + 2531011) >>> 0;
    return (state >>> 16) & 0x7fff;
  };
}

/** 0x007ed250: the 256 lattice values, 1 − 2·rand()/32767. `seed` stands for the session's `srand`. */
export function cloudLatticeValues(seed = 1): Float32Array {
  const random = msvcRand(seed);
  const values = new Float32Array(256);
  const scale = Math.fround(0.000030518509);
  for (let index = 0; index < 256; index++) {
    const r = random();
    values[index] = 1 - (r * scale + r * scale);
  }
  return values;
}

/** 0x007ed250: the fade, (1 − cos(i·π/256))/2. */
export function cloudFadeTable(): Float32Array {
  const fade = new Float32Array(256);
  for (let index = 0; index < 256; index++) fade[index] = (1 - Math.cos(index * 0.012271847)) * 0.5;
  return fade;
}

/** 0x007edb50: alpha over (level − density byte): 255 − 0.96^e · 255 with e growing by (255 − d)/256. */
export function cloudSharpnessTable(sharpness = CLOUD_SHARPNESS, densityByte = cloudDensityByte(CLOUD_START_DENSITY)): Uint8Array {
  const table = new Uint8Array(256);
  const step = (255 - densityByte) * 0.00390625;
  let exponent = 0;
  for (let index = 0; index < 256; index++) {
    table[index] = Math.trunc(255 - Math.pow(sharpness, exponent) * 255);
    exponent = Math.fround(exponent + step);
  }
  return table;
}

/** 0x007efd00: the density byte, round((1 − band 3)·255) kept as its low byte (a band over 1 wraps). */
export function cloudDensityByte(density: number): number {
  const safe = Number.isFinite(density) ? density : 0;
  return ((fistp((1 - Math.fround(safe)) * 255) % 256) + 256) % 256;
}

/**
 * 0x007eda90 + 0x007ef920: where a direction (scene space: x, up, −y of the world) meets the dome,
 * as fractions of the texture (0–1). `out[0]` is u (world x), `out[1]` v (world y).
 */
export function cloudDomeUv(x: number, y: number, z: number, out: Float64Array | number[]): void {
  // World axes: (x, −z, y). The ray from the camera meets the unit sphere centred DOME_DROP below.
  const wx = x, wy = -z, wz = y;
  const a = wx * wx + wy * wy + wz * wz;
  if (!(a > 0)) { out[0] = 0.5; out[1] = 0.5; return; }
  const b = 2 * DOME_DROP * wz;
  const c = DOME_DROP * DOME_DROP - 1;
  const t = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  cloudTextureUv(wx * t, wy * t, wz * t, out);
}

/** 0x007ef920 on a world offset from the camera (x, y, z up): the texture fractions it maps to. */
export function cloudTextureUv(wx: number, wy: number, wz: number, out: Float64Array | number[]): void {
  const dz = wz + DOME_DROP;
  const length = Math.hypot(wx, wy, dz);
  let angle = length > 0 ? Math.acos(Math.max(-1, Math.min(1, dz / length))) : 0;
  if (angle > 0.78539819) angle = 0.78539819;
  const radius = angle * 1.2732395 * 0.5;
  const flat = Math.hypot(wx, wy);
  const nx = flat <= 0.000009999999 ? 0 : wx / flat;
  const ny = flat <= 0.000009999999 ? 0 : wy / flat;
  out[0] = nx * radius + 0.5;
  out[1] = ny * radius + 0.5;
}

/** The lighting one pass of rows is written with (0x007efae0). Colours are display bytes / 255. */
export interface CloudShading {
  /** Band 11, times the thickness shade. */
  shadeR: number; shadeG: number; shadeB: number;
  /** Band 10, times the lit cosine. */
  sunR: number; sunG: number; sunB: number;
  /** Band 12, the base. */
  baseR: number; baseG: number; baseB: number;
  /** The light in texel space: its spot on the texture (texels) and its height. */
  lightU: number; lightV: number; lightHeight: number;
  /** (1 − 0.75 · storm). */
  intensity: number;
  /** The density byte ({@link cloudDensityByte}). */
  densityByte: number;
}

export function createCloudShading(): CloudShading {
  return {
    shadeR: 0, shadeG: 0, shadeB: 0, sunR: 0, sunG: 0, sunB: 0, baseR: 0, baseG: 0, baseB: 0,
    lightU: CLOUD_TEXTURE_SIZE / 2, lightV: CLOUD_TEXTURE_SIZE / 2, lightHeight: CLOUD_LIGHT_HEIGHT, intensity: 1,
    densityByte: 255,
  };
}

/** Fills the colour part of `out` from packed display-space 0xRRGGBB bands 10, 11, 12. */
export function setCloudBands(out: CloudShading, band10: number, band11: number, band12: number): void {
  const channel = (packed: number, shift: number) => (((Number.isFinite(packed) ? packed : 0) >> shift) & 0xff) * BYTE;
  out.sunR = channel(band10, 16); out.sunG = channel(band10, 8); out.sunB = channel(band10, 0);
  out.shadeR = channel(band11, 16); out.shadeG = channel(band11, 8); out.shadeB = channel(band11, 0);
  out.baseR = channel(band12, 16); out.baseG = channel(band12, 8); out.baseB = channel(band12, 0);
}

// The 0x5f3997bb inverse square root estimate, on a shared float/int view.
const rsqrtFloat = new Float32Array(1);
const rsqrtBits = new Uint32Array(rsqrtFloat.buffer);
function roughInverseSqrt(value: number): number {
  rsqrtFloat[0] = value;
  rsqrtBits[0] = (0x5f3997bb - ((rsqrtBits[0]! >>> 1) & 0x3fffffff)) >>> 0;
  return rsqrtFloat[0]!;
}

/**
 * The client's cloud texture (0x007efd00): a CPU buffer written a few rows per frame and shown when
 * a pass completes. `pixels` is what the GPU texture shows; `densities` the alpha bytes behind it.
 */
export class DayNightCloudTexture {
  readonly size = CLOUD_TEXTURE_SIZE;
  /** RGBA bytes being written by the current pass. */
  #work = new Uint8Array(CLOUD_TEXTURE_SIZE * CLOUD_TEXTURE_SIZE * 4);
  /** RGBA bytes of the last finished pass — the texture on screen. */
  #shown = new Uint8Array(CLOUD_TEXTURE_SIZE * CLOUD_TEXTURE_SIZE * 4);
  /** Alpha bytes of the pass being written (0x007efa30 reads these, as the client does). */
  readonly densities = new Uint8Array(CLOUD_TEXTURE_SIZE * CLOUD_TEXTURE_SIZE);
  readonly #previousRow = new Float32Array(CLOUD_TEXTURE_SIZE);
  readonly #lattice: Float32Array;
  readonly #fade = cloudFadeTable();
  readonly #sharpness = cloudSharpnessTable();
  // Per-octave state, reused (0x007efd00 keeps it on the stack).
  readonly #octaveX = new Uint16Array(CLOUD_OCTAVES);
  readonly #octaveY = new Uint16Array(CLOUD_OCTAVES);
  readonly #octavePerm = new Int32Array(CLOUD_OCTAVES * 4);
  readonly #octaveCell = new Int32Array(CLOUD_OCTAVES);
  readonly #corner = new Float32Array(CLOUD_OCTAVES * 8);
  #animTime = 0;
  #animFrame = 0;
  #row = 0;
  #fullUpdate = false;
  /** Whether a pass was ever shown: the first one is, whatever its frame (the client starts with a full update). */
  #everShown = false;

  constructor(seed = 1) {
    this.#lattice = cloudLatticeValues(seed);
  }

  /** The bytes on screen (a finished pass). Replaced, not rewritten, when a pass is shown. */
  get pixels(): Uint8Array {
    return this.#shown;
  }

  /** The animation frame (8.8 fixed point drift), as 0x007efd00 keeps it at +0x88. */
  get frame(): number {
    return this.#animFrame;
  }

  /**
   * Writes the whole texture on the next update (the client's +0x0a, set when the level of detail
   * changes), so the clouds come back from a pause without a stale pass. Ignored until a first pass
   * was shown: 128 rows at once cost ≈1 ms warm but ≈14 ms before the JIT has seen the loop, so the
   * first pass is written 8 rows a frame like every other and shown as soon as it is done.
   */
  requestFullUpdate(): void {
    if (this.#everShown) this.#fullUpdate = true;
  }

  /**
   * One frame of 0x007efd00: `deltaSeconds` of animation, then 8 rows (all of them on a full
   * update). Returns true when a finished pass became {@link pixels}.
   */
  update(deltaSeconds: number, shading: CloudShading): boolean {
    const size = this.size;
    const full = this.#fullUpdate;
    if (full) this.#row = 0;
    const rows = full ? size : CLOUD_ROWS_PER_UPDATE;
    this.#animTime += Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;
    this.#writeRows(this.#row, Math.min(rows, size - this.#row), shading);
    this.#row += rows;
    let shown = false;
    if (this.#row >= size) {
      const frame = fistp(CLOUD_ANIM_SPEED * this.#animTime) & 0xffff;
      if (frame !== this.#animFrame || full || !this.#everShown) {
        this.#everShown = true;
        this.#animFrame = frame;
        const finished = this.#work;
        this.#work = this.#shown;
        this.#shown = finished;
        // The client's single buffer carries the finished pass into the next one (transparent
        // texels at column 0 keep their last colour); copy so the swap changes nothing else.
        this.#work.set(finished);
        shown = true;
      }
      this.#row = 0;
    }
    this.#fullUpdate = false;
    return shown;
  }

  /** 0x007efa30: the alpha (0–1) under a texture position given as fractions (u, v). */
  densityAt(u: number, v: number): number {
    const max = this.size - 1;
    const x = Math.max(0, Math.min(max, Math.trunc(u * this.size)));
    const y = Math.max(0, Math.min(max, Math.trunc(v * this.size)));
    return (this.densities[(y << CLOUD_TEXTURE_SHIFT) + x] ?? 0) * BYTE;
  }

  #writeRows(firstRow: number, count: number, shading: CloudShading): void {
    const size = this.size;
    const perm = CLOUD_PERMUTATION;
    const lattice = this.#lattice;
    const fade = this.#fade;
    const sharpness = this.#sharpness;
    const texels = this.#work;
    const frame = this.#animFrame;
    const zCell = frame >> 8;
    const permZ0 = perm[zCell]!;
    const permZ1 = perm[(zCell + 1) & 0xff]!;
    const fadeZ = fade[frame & 0xff]!;
    const octaveX = this.#octaveX, octaveY = this.#octaveY, octavePerm = this.#octavePerm;
    const octaveCell = this.#octaveCell, corner = this.#corner;
    for (let octave = 0; octave < CLOUD_OCTAVES; octave++) {
      octaveY[octave] = (CLOUD_OCTAVE_STEPS[octave]! * firstRow) & 0xffff;
    }
    const gradientScale = 1 << (CLOUD_TEXTURE_SHIFT - 7);
    const densityByte = shading.densityByte;
    const lightHeight = shading.lightHeight;
    for (let r = 0; r < count; r++) {
      const row = firstRow + r;
      const rowStart = row << CLOUD_TEXTURE_SHIFT;
      for (let octave = 0; octave < CLOUD_OCTAVES; octave++) {
        const y0 = octaveY[octave]! >> 8;
        const y1 = (y0 + 1) & 0xff;
        octavePerm[octave * 4] = perm[(permZ0 + y0) & 0xff]!;
        octavePerm[octave * 4 + 1] = perm[(permZ0 + y1) & 0xff]!;
        octavePerm[octave * 4 + 2] = perm[(permZ1 + y0) & 0xff]!;
        octavePerm[octave * 4 + 3] = perm[(permZ1 + y1) & 0xff]!;
        octaveCell[octave] = -1;
        octaveX[octave] = frame;
      }
      let previous = 0;
      let gradX = 0;
      let gradY = 0;
      const lightV = shading.lightV - row;
      for (let col = 0; col < size; col++) {
        let sum = 0;
        for (let octave = 0; octave < CLOUD_OCTAVES; octave++) {
          const x = octaveX[octave]!;
          const cell = x >> 8;
          const base = octave * 8;
          if (cell !== octaveCell[octave]) {
            octaveCell[octave] = cell;
            for (let k = 0; k < 4; k++) {
              const p = octavePerm[octave * 4 + k]!;
              const v0 = lattice[perm[(p + cell) & 0xff]!]!;
              corner[base + k * 2] = v0;
              corner[base + k * 2 + 1] = lattice[perm[(p + cell + 1) & 0xff]!]! - v0;
            }
          }
          const fx = fade[x & 0xff]!;
          const fy = fade[octaveY[octave]! & 0xff]!;
          const c0 = corner[base + 1]! * fx + corner[base]!;
          const c1 = corner[base + 3]! * fx + corner[base + 2]!;
          const c2 = corner[base + 5]! * fx + corner[base + 4]!;
          const c3 = corner[base + 7]! * fx + corner[base + 6]!;
          const near = c0 + (c1 - c0) * fy;
          const far = c2 + (c3 - c2) * fy;
          octaveX[octave] = (x + CLOUD_OCTAVE_STEPS[octave]!) & 0xffff;
          sum += (near + (far - near) * fadeZ) / (1 << octave);
          if (octave === 2) {
            // The slope of the first three octaves is the heightfield normal (x from the texel to
            // the left, y from the same column one row up).
            gradX = (previous - sum) * gradientScale;
            gradY = (this.#previousRow[col]! - sum) * gradientScale;
            this.#previousRow[col] = sum;
            previous = sum;
          }
        }
        const level = fistp(sum * 64 + 128) & 0xff;
        const index = level - densityByte;
        const alpha = index < 0 ? 0 : sharpness[index]!;
        this.densities[rowStart + col] = alpha;
        const at = (rowStart + col) * 4;
        if (alpha === 0) {
          if (col >= 1) {
            texels[at] = texels[at - 4]!;
            texels[at + 1] = texels[at - 3]!;
            texels[at + 2] = texels[at - 2]!;
            texels[at + 3] = 0;
          }
          continue;
        }
        const shade = (((255 - alpha) >> 1) + 64) * BYTE;
        let red = shading.shadeR * shade + shading.baseR;
        let green = shading.shadeG * shade + shading.baseG;
        let blue = shading.shadeB * shade + shading.baseB;
        const lx = shading.lightU - col;
        const ly = lightV;
        const lightInverse = roughInverseSqrt(lightHeight * lightHeight + ly * ly + lx * lx);
        const normalInverse = roughInverseSqrt(gradY * gradY + gradX * gradX + 1);
        let lit = (lightHeight + gradX * lx + gradY * ly) * (normalInverse * lightInverse);
        if (lit > 0) {
          lit *= shading.intensity;
          red += shading.sunR * lit;
          green += shading.sunG * lit;
          blue += shading.sunB * lit;
        }
        texels[at] = fistp(Math.min(red, 1) * 255) & 0xff;
        texels[at + 1] = fistp(Math.min(green, 1) * 255) & 0xff;
        texels[at + 2] = fistp(Math.min(blue, 1) * 255) & 0xff;
        texels[at + 3] = alpha;
      }
      for (let octave = 0; octave < CLOUD_OCTAVES; octave++) {
        octaveY[octave] = (octaveY[octave]! + CLOUD_OCTAVE_STEPS[octave]!) & 0xffff;
      }
    }
  }
}

/**
 * 0x007f20e0: the cloud dome around the camera in scene space (world (x, y, z) → scene (x, z, −y)),
 * scaled by `radius`: positions, the texture `uv` and the ring alpha (`cloudAlpha`, 0–1).
 */
export function buildCloudDomeGeometry(radius: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const alphas: number[] = [];
  const ringStart: number[] = [];
  const rings = CLOUD_RING_POLAR.length;
  for (let ring = 0; ring < rings; ring++) {
    const theta = CLOUD_RING_POLAR[ring]! * Math.PI;
    const sinTheta = Math.sin(theta);
    const textureRadius = 0.5 * (ring / (rings - 1));
    const z = Math.cos(theta) - DOME_DROP;
    ringStart.push(positions.length / 3);
    const count = ring === 0 ? 1 : CLOUD_DOME_SEGMENTS;
    for (let segment = 0; segment < count; segment++) {
      const phi = segment * (Math.PI / 8);
      const wx = Math.sin(phi) * sinTheta, wy = Math.cos(phi) * sinTheta;
      positions.push(wx * radius, z * radius, -wy * radius);
      uvs.push(Math.sin(phi) * textureRadius + 0.5, Math.cos(phi) * textureRadius + 0.5);
      alphas.push(CLOUD_RING_ALPHA[ring]! / 255);
    }
  }
  // The client draws one strip whose ring joins are degenerate; the same triangles as a list.
  const indices: number[] = [];
  for (let ring = 1; ring < rings; ring++) {
    const previous = ringStart[ring - 1]!, current = ringStart[ring]!;
    const pole = ring === 1;
    for (let segment = 0; segment < CLOUD_DOME_SEGMENTS; segment++) {
      const next = (segment + 1) % CLOUD_DOME_SEGMENTS;
      const a = previous + (pole ? 0 : segment), b = current + segment;
      const c = previous + (pole ? 0 : next), d = current + next;
      if (pole) indices.push(a, b, d);
      else indices.push(a, b, c, c, b, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("cloudAlpha", new THREE.Float32BufferAttribute(alphas, 1));
  geometry.setIndex(indices);
  return geometry;
}

/** The GPU copy of {@link DayNightCloudTexture.pixels}: bilinear, unmipped, display-space bytes. */
export function createCloudDataTexture(pixels: Uint8Array): THREE.DataTexture {
  const texture = new THREE.DataTexture(pixels, CLOUD_TEXTURE_SIZE, CLOUD_TEXTURE_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace; // decoded after filtering, as the client blends bytes
  texture.name = "DNClouds";
  texture.needsUpdate = true;
  return texture;
}

export const CLOUD_VERTEX_SHADER = /* glsl */ `
attribute float cloudAlpha;
varying vec2 vCloudUv;
varying float vCloudAlpha;
void main() {
  vCloudUv = uv;
  vCloudAlpha = cloudAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** 0x009acd40: the texel times the vertex colour (white, ring alpha), alpha-blended. */
export const CLOUD_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D cloudMap;
varying vec2 vCloudUv;
varying float vCloudAlpha;
vec3 cloudToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
void main() {
  vec4 texel = texture2D(cloudMap, vCloudUv);
  float alpha = texel.a * vCloudAlpha;
  if (alpha <= 0.0) discard;
  gl_FragColor = vec4(cloudToLinear(texel.rgb), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
