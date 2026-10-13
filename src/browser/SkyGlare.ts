// 13.10 (7.04): the sun's and the moon's glare sprites (`Textures\sunGlare.blp`, `Textures\moonGlare.blp`)
// as Wow.exe 3.3.5a draws them. Read out of Wow.exe 12340 (`re-2026-10-11/glue-1110/s704-*.txt`,
// `re-2026-10-13/704/glare.txt`); described in our own words, nothing copied.
//
//   * 0x007ee150 / 0x007ee230 set the two glare objects up (0x00d38ea8, 0x00d38f58; vtables
//     0x00a41c18 / 0x00a41c2c); the CVar `SkySunGlare` (0x007ece40, default on) switches both.
//   * Every frame 0x007f0870 calls the update 0x007ef6e0 with the frame time (0x00d38b48), then the
//     draw 0x009ac400:
//       target = cloud term (vtable +0xc) × depth term (+0x10) × (1 − LightSkybox weight)
//                × day curve (keys at +0x70, 4 of them) × occlusion (+8, a ray from the camera);
//       `current` moves toward it at `rise` per second going up and `fall` going down;
//       f = (max(view · toGlare, 0.7) − 0.7) / 0.3 — how squarely the camera looks at it;
//       size = lerp(sizeMin, sizeMax, f) × base; alpha = colour alpha × lerp(alphaMin, alphaMax, f)
//       × current (a byte; nothing is drawn at 0). Colour: Light band 9 (0x007f3230 writes it to
//       0x00d38ec0 / 0x00d38f70 like the bodies'), alpha 1 − storm while a storm blends in.
//   * The draw is a camera-facing quad of that size at the body (12 units out, like the body
//     itself), blend 3 (additive by alpha), no depth.
//   * Cloud term: 0x007efa30 samples the day-night cloud texture at the glare's direction; the sun
//     takes 1 − c (0x007f1020), the moon 1 − |2c − 1| (0x007f1040) — brightest through thin cloud.
//   * Depth term 0x007eda30: 1 − min(1, liquid depth × 0.1); the sky is not drawn under water here.
// What is not reproduced: the occlusion ray (0x009abc60: collision and a second scene test along the
// view to the far clip, or a hardware query); the glare is drawn in the sky pass, so the world in
// front of it covers it per pixel instead of switching it off whole.

import type { SkyKeys } from "./SkyCelestials.js";
import { skyKeyCurve } from "./SkyCelestials.js";

export interface GlareSpec {
  readonly texture: string;
  /** +0x20: the quad's base size, in the bodies' units (12 from the camera). */
  readonly base: number;
  /** +0x90 / +0x94: size factor from looking away (f = 0) to looking straight at it (f = 1). */
  readonly sizeMin: number;
  readonly sizeMax: number;
  /** +0x98: the view·direction cosine under which f is 0. */
  readonly align: number;
  /** +0x9c / +0xa0: alpha factor at f = 0 and f = 1. */
  readonly alphaMin: number;
  readonly alphaMax: number;
  /** +0x28 / +0x2c: how fast `current` follows its target, per second up and down. */
  readonly rise: number;
  readonly fall: number;
  /** +0x70: the day curve. */
  readonly dayKeys: SkyKeys;
}

/** 0x007ee150 (constants 0x009ebbc4, 0x009f281c, 0x009e2ec0, 0x009e2ec4, 0x009e8d2c, 0x00a41bc0, 0x00a41bb0–bc). */
export const SUN_GLARE: GlareSpec = Object.freeze({
  texture: "Textures\\sunGlare.blp",
  base: 1,
  sizeMin: 3,
  sizeMax: 20,
  align: 0.699999988079071,
  alphaMin: 0.5,
  alphaMax: 1,
  rise: 4,
  fall: 1.5151515007019043,
  // Rises 06:30–07:30, sets 19:30–21:00.
  dayKeys: [0.2708333432674408, 0, 0.3125, 1, 0.8125, 1, 0.875, 0],
});

/** 0x007ee230 (constants 0x00a4040c, 0x00a41be8, 0x009e3004, 0x00a37f38, 0x00a41bdc–e4). */
export const MOON_GLARE: GlareSpec = Object.freeze({
  texture: "Textures\\moonGlare.blp",
  base: 2,
  sizeMin: 1,
  sizeMax: 1,
  align: 0.699999988079071,
  alphaMin: 0.10000000149011612,
  alphaMax: 1,
  rise: 3.0303030014038086,
  fall: 1.5151515007019043,
  // Full from 23:59 to 02:00, gone 03:15–22:45.
  dayKeys: [0.0833333358168602, 1, 0.1354166716337204, 0, 0.9479166865348816, 0, 0.9993056058883667, 1],
});

/** 0x007f1020: the sun glare through cloud cover `c` (0–1) at its direction. */
export function sunGlareCloudTerm(cover: number): number {
  return 1 - clamp01(cover);
}

/** 0x007f1040: the moon's glare, brightest through half cover. */
export function moonGlareCloudTerm(cover: number): number {
  const c = clamp01(cover);
  return 1 - Math.abs((c - 0.5) + (c - 0.5));
}

/** The update's target before occlusion: cloud × (1 − skybox weight) × day curve. */
export function glareTarget(spec: GlareSpec, cloudTerm: number, skyboxWeight: number, fraction: number): number {
  return clamp01(cloudTerm) * (1 - clamp01(skyboxWeight)) * skyKeyCurve(spec.dayKeys, fraction);
}

/** 0x007ef6e0: `current` toward `target`, `rise`/`fall` per second, never past it. */
export function glareStep(current: number, target: number, spec: GlareSpec, seconds: number): number {
  const dt = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (current < target) return Math.min(target, current + spec.rise * dt);
  if (current > target) return Math.max(target, current - spec.fall * dt);
  return current;
}

/** f: 0 looking away, 1 straight at it (cosine `facing` between the view and the glare). */
export function glareFacing(spec: GlareSpec, facing: number): number {
  const cosine = Number.isFinite(facing) ? Math.max(facing, spec.align) : spec.align;
  return (cosine - spec.align) / (1 - spec.align);
}

/** The quad's size in the bodies' units. */
export function glareSize(spec: GlareSpec, f: number): number {
  return ((spec.sizeMax - spec.sizeMin) * f + spec.sizeMin) * spec.base;
}

/** The colour's alpha byte the draw tests and blends with, over 255. */
export function glareAlpha(spec: GlareSpec, colourAlpha: number, f: number, current: number): number {
  const byte = Math.round(clamp01(colourAlpha) * ((spec.alphaMax - spec.alphaMin) * f + spec.alphaMin) * current * 255);
  return Math.max(0, Math.min(255, byte)) / 255;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

// --- the cloud cover at a direction, the CPU twin of `CLOUD_FRAGMENT_SHADER` ----------------------

const f32 = Math.fround;

function cloudHash(x: number, y: number): number {
  const value = f32(Math.sin(f32(f32(x * 127.1) + f32(y * 311.7))) * 43758.5453);
  return value - Math.floor(value);
}

function cloudNoise(x: number, y: number): number {
  const cx = Math.floor(x), cy = Math.floor(y);
  const ix = x - cx, iy = y - cy;
  const ex = ix * ix * (3 - 2 * ix), ey = iy * iy * (3 - 2 * iy);
  const bottom = cloudHash(cx, cy) + (cloudHash(cx + 1, cy) - cloudHash(cx, cy)) * ex;
  const top = cloudHash(cx, cy + 1) + (cloudHash(cx + 1, cy + 1) - cloudHash(cx, cy + 1)) * ex;
  return bottom + (top - bottom) * ey;
}

function cloudField(x: number, y: number): number {
  return cloudNoise(x, y) * 0.6667 + cloudNoise(x * 2 + 5.2, y * 2 + 1.3) * 0.3333;
}

/**
 * The drawn clouds' alpha in a scene-space unit direction — what 0x007efa30 reads from the client's
 * own cloud texture. Same field, threshold and offset as the shader (`SkyCelestials.ts`); the hash is
 * evaluated at float precision, so the GPU's own `sin` may differ by a little.
 */
export function cloudAlphaAt(x: number, y: number, z: number, threshold: number, offsetX: number, offsetY: number): number {
  const length = Math.hypot(x, y, z);
  if (!(length > 0)) return 0;
  const dx = x / length, dy = y / length, dz = z / length;
  if (dy <= 0) return 0;
  const px = (dx / (dy + 0.15)) * 1.5 + offsetX;
  const py = (dz / (dy + 0.15)) * 1.5 + offsetY;
  const density = cloudField(px, py);
  const alpha = Math.max(0, Math.min(1, (density - threshold) * 4));
  const t = Math.max(0, Math.min(1, dy / 0.12));
  return alpha * (t * t * (3 - 2 * t));
}
