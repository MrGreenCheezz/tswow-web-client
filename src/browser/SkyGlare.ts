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
//     23.10 (7.43): read from the client-style cloud texture itself (`SkyClouds.ts`, densityAt).
//   * Depth term 0x007eda30: 1 − min(1, liquid depth × 0.1); the sky is not drawn under water here.
//   * 15.11 (sky8): the occlusion (+8 = 0x009ac3c0) is asked only while the target is not 0. With hardware
//     occlusion queries (the stand's Direct3D 9 card) it is 0x009abe00: a colourless quad at the glare, depth-tested
//     against the finished world at the far end of the depth range (0.999–1), its passed pixels over its projected
//     area, at most 1, read a frame late — so a glare off the screen or behind a wall counts 0. Without queries it
//     is the ray 0x009abc60: from the camera (0.5 along) to the far clip toward the glare, 0 when world collision
//     (0x0077f310, flags 0x200112) or the scene test 0x004f9410 meets something. Here: the glare's direction on
//     the screen times that ray against the terrain and the collision world (`SkyGlareOcclusion.ts`); the query's
//     quad size (0x007edbe0 scales its unit square by a field not identified) is not reproduced, so the share at
//     the screen's edge is all or nothing.
//   * 15.11 (sky8): the update ends with +0xa4 = max(view · toGlare, 0.7)^10 × current (0x007ef8fd–0x007ef911,
//     the CRT pow at 0x0088d0c0, 10 at 0x00af4dc0). For the sun's glare that is 0x00d38f4c, and the next light
//     build (0x007816f0, outdoors and indoors alike when the world is drawn) scales the frame's ambient and direct
//     light bytes by round((1 − 0.35 × it) × 255) / 256 (0.35 at 0x00a3e860): looking into the sun dims the world
//     by up to 35 %. The moon's +0xa4 is not read.
// What is still not reproduced: the glare is drawn in the sky pass, so the world in front of it covers it per pixel
// as well as through the occlusion.

import type { LightSample, ResolvedColour } from "./LightTypes.js";
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

/**
 * 15.11 (sky8): 0x007ef6e0 multiplies the target by the occlusion (vtable +8, 0x009ac3c0) only when the target is not
 * already 0 — a glare that cannot show asks nothing.
 */
export function occludedGlareTarget(target: number, occlusion: number): number {
  return target === 0 ? 0 : target * clamp01(occlusion);
}

/** 15.11 (sky8): 0x00af4dc0, the power the facing cosine is raised to for the dimming. */
export const GLARE_DIMMING_EXPONENT = 10;
/** 15.11 (sky8): 0x00a3e860, how much of the light the sun's glare can take away (0x007816f0). */
export const GLARE_LIGHT_DIMMING = 0.3499999940395355;

/**
 * 15.11 (sky8): the glare's +0xa4 (0x007ef911): max(view · toGlare, align)^10 × current, where `facing` is the raw
 * cosine. Looking straight at it, `current`; looking away, 0.7^10 ≈ 2.8 % of it.
 */
export function glareDimming(spec: GlareSpec, facing: number, current: number): number {
  const cosine = Number.isFinite(facing) ? Math.max(facing, spec.align) : spec.align;
  return Math.pow(cosine, GLARE_DIMMING_EXPONENT) * clamp01(current);
}

/**
 * 15.11 (sky8): the byte 0x007816f0 scales the frame's ambient and direct light with — round((1 − 0.35 × dimming)
 * × 255), 255 when the sun's glare is out.
 */
export function glareLightByte(dimming: number): number {
  return Math.round((1 - GLARE_LIGHT_DIMMING * clamp01(dimming)) * 255) & 0xff;
}

/**
 * 15.11 (sky8): one colour channel (0..1) through 0x007816f0's byte multiply. Wow.exe takes (c × factor + 255) >> 8
 * on the channel's byte — c × factor / 255 to within a byte, and exactly c at 255; the channel here is not a byte
 * (it is blended in floats), so it is scaled by factor / 255.
 */
export function dimByGlare(channel: number, factor: number): number {
  return factor >= 255 ? channel : channel * factor / 255;
}

/**
 * 15.11 (sky8): the frame's light with 0x007816f0's dimming by the sun's glare — its ambient and direct colours
 * scaled, everything else as it was. The same object when the factor is 255; a copy otherwise, so the sample the
 * page keeps (debug readouts, the minimap) is not touched.
 */
export function dimLightSampleByGlare(sample: LightSample, dimming: number): LightSample {
  const factor = glareLightByte(dimming);
  if (factor >= 255) return sample;
  const scale = (colour: ResolvedColour): ResolvedColour => ({
    r: dimByGlare(colour.r, factor), g: dimByGlare(colour.g, factor), b: dimByGlare(colour.b, factor),
  });
  return {
    ...sample,
    colours: { ...sample.colours, ambient: scale(sample.colours.ambient), diffuse: scale(sample.colours.diffuse) },
  };
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
