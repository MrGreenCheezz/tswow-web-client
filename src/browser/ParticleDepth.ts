// 15.11 (6.15): what a particle emitter's draw does with depth, blending and the alpha test, as Wow.exe 3.3.5a 12340
// sets it (Ghidra read-only, .runtime/re-2026-11-15/fx5/r1/d.c 0x008214e0, r2/d.c 0x00833c80, 0x0081ca20, 0x0081fe90;
// constants read from the PE: 0x00a3fdcc = 224/255, 0x00a45564 = 1/255), and as the stand recorded it (F:\WowOracle).
//
// - The model load (0x00833c80 → 0x00978bf0) gives each emitter a material {blend, flags}: the record's blendingType
//   (+0x28) 0, 1, 2, 3, 4, 5, 6 becomes 0, 1, 2, 10, 3, 4, 5, which the draw maps back (0x0081ca20) to the M2 blend
//   modes 0…6 — the same number the file holds. The flags start at 7; blends 2…6 clear bit 4 (blends 0 and 1 and an
//   unknown one keep it); bit 1 is "not record 0x1" (lit), bit 2 "not record 0x8" (fogged).
// - The draw (0x008214e0) turns them into M2 material flags: 0x4 always (two-sided), 0x1 without bit 1 (unlit),
//   0x2 without bit 2 (unfogged), 0x10 without bit 4 — "no depth write". So an opaque or alpha-key emitter's particles
//   write depth and every other blend's do not; none turns depth testing off.
// - The M2 state 0x0081fe90 sets the alpha test from the blend: none for opaque, 224/255 × the draw item's float +0xc
//   for alpha key, and 1/255 for every other blend.
//
// 15.11 (fx6), recorded on Wow.exe (runs\fx6-f-*.tsv, the particle vertex format FVF 0x142, stride 24):
// - An alpha-key emitter of a unit at full opacity draws WITHOUT blending, alpha test GREATEREQUAL 224, depth write on,
//   depth test LESSEQUAL, no culling, in the opaque part of the frame next to its model's batches: the Blade's Edge
//   mountain giant's TUMBLINGROCK.BLP (fx6-f-mgiant-1 #821, fx6-f-mgiant-2 #821) and Entangling Roots' PARTROCK.BLP
//   (spells\entanglingroots_state.m2 on the character: fx6-f-roots-1 #821, fx6-f-roots-2 #815).
// - The +0xc factor is the model's own alpha. The despawned mountain giant fades out (its body draws a depth-only pass,
//   then a SrcAlpha/InvSrcAlpha pass), and its live rocks draw BLENDED (SrcAlpha/InvSrcAlpha), depth write still on,
//   at reference 174 with the model alpha 0.777034 in the vertex constants (224 × 0.777 = 174.06; fx6-f-roots-1 #911),
//   and later at 8 (fx6-f-roots-2 #905). Model batches follow the same rule (runs\s06.tsv #2541/#2543: a Silvermoon
//   banner, be_banner01.blp, fading at reference 136, against 224 for the same texture in s04.tsv #768).
// - Every blended particle draw is gated at reference 1 (411 earlier recordings and every fx6 frame).
//
// So the factor below is the alpha of the model the emitter belongs to (1 for a unit or doodad that is not fading).

import * as THREE from "three";
import { FADE_ALPHA_TEST_FLOOR } from "./ModelBuild.js";
import { BLEND_ALPHA_KEY, BLEND_OPAQUE } from "./Wvm.js";

/** 0x00a3fdcc: the alpha-key reference at full model alpha. */
export const PARTICLE_ALPHA_KEY_REFERENCE = 224 / 255;
/** 0x00a45564. */
export const PARTICLE_ALPHA_REFERENCE = 1 / 255;

export interface ParticleDepthState {
  depthWrite: boolean;
  /** Fragments with alpha below this are discarded (D3D ALPHAFUNC GREATEREQUAL); 0 is no test. */
  alphaTest: number;
  /** Whether the draw blends at all; an unblended one goes with the opaque draws. */
  blended: boolean;
}

/**
 * Depth write, alpha-test reference and blending of an emitter with the record's `blendType`, on a model whose alpha
 * is `modelAlpha` (1 when it is not fading).
 */
export function particleDepthState(blendType: number, modelAlpha = 1): ParticleDepthState {
  const alpha = Math.max(0, Math.min(1, modelAlpha));
  if (blendType === BLEND_OPAQUE) return { depthWrite: true, alphaTest: 0, blended: alpha < 1 };
  if (blendType === BLEND_ALPHA_KEY) {
    // The floor keeps the threshold above zero at a model alpha of 0 (see FADE_ALPHA_TEST_FLOOR: zero is another
    // three.js program, and every fragment's alpha is zero then anyway).
    return { depthWrite: true, alphaTest: PARTICLE_ALPHA_KEY_REFERENCE * Math.max(alpha, FADE_ALPHA_TEST_FLOOR), blended: alpha < 1 };
  }
  // 0x00833c80's default: a blending type past 6 keeps bit 4 and the material's blend 0 (opaque).
  if (!(blendType >= 0 && blendType <= 6)) return { depthWrite: true, alphaTest: 0, blended: alpha < 1 };
  return { depthWrite: false, alphaTest: PARTICLE_ALPHA_REFERENCE, blended: true };
}

/**
 * Puts `particleDepthState(blendType, modelAlpha)` on an emitter's material: at its build (alpha 1) and, for the
 * emitters whose state moves with the model's alpha (opaque, alpha key), on every frame. The model alpha already
 * reaches the particles' vertex alpha (Particles.ts `modelAlpha`, m_alphaScale), and Wow.exe's pixel shader tests
 * texture alpha × vertex alpha (combiners_mod.bls, ps_3_0: oC0.a = t0.a × v0.a), so a fixed 224/255 would cut a
 * fading unit's rocks at once where the original's reference falls with the alpha. No program change: the threshold
 * stays above zero, and `transparent`/`blending` are not program state.
 */
export function applyParticleDepthState(material: THREE.Material, blendType: number, modelAlpha = 1): void {
  const state = particleDepthState(blendType, modelAlpha);
  material.depthWrite = state.depthWrite;
  material.alphaTest = state.alphaTest;
  // The blended modes keep the blend `applyBlendMode` gave them; only the unblended ones switch, to SrcAlpha/
  // InvSrcAlpha while their model fades (recorded: fx6-f-roots-1 #911, blend 1/5/6).
  if (!particleDepthFollowsModelAlpha(blendType)) return;
  material.transparent = state.blended;
  material.blending = state.blended ? THREE.NormalBlending : THREE.NoBlending;
}

/** Whether an emitter's depth state moves with its model's alpha (the blends that are unblended at full alpha). */
export function particleDepthFollowsModelAlpha(blendType: number): boolean {
  return !particleDepthState(blendType, 1).blended;
}
