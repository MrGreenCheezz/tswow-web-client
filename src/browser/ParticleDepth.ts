// 15.11 (6.15): what a particle emitter's draw does with depth and alpha, as Wow.exe 3.3.5a 12340 sets it (Ghidra
// read-only, .runtime/re-2026-11-15/fx5/r1/d.c 0x008214e0, r2/d.c 0x00833c80, 0x0081ca20, 0x0081fe90; constants
// read from the PE: 0x00a3fdcc = 224/255, 0x00a45564 = 1/255):
//
// - The model load (0x00833c80 → 0x00978bf0) gives each emitter a material {blend, flags}: the record's blendingType
//   (+0x28) 0, 1, 2, 3, 4, 5, 6 becomes 0, 1, 2, 10, 3, 4, 5, which the draw maps back (0x0081ca20) to the M2 blend
//   modes 0…6 — the same number the file holds. The flags start at 7; blends 2…6 clear bit 4 (blends 0 and 1 and an
//   unknown one keep it); bit 1 is "not record 0x1" (lit), bit 2 "not record 0x8" (fogged).
// - The draw (0x008214e0) turns them into M2 material flags: 0x4 always (two-sided), 0x1 without bit 1 (unlit),
//   0x2 without bit 2 (unfogged), 0x10 without bit 4 — "no depth write". So an opaque or alpha-key emitter's particles
//   write depth and every other blend's do not; none turns depth testing off.
// - The M2 state 0x0081fe90 sets the alpha test from the blend: none for opaque (reference 0), 224/255 × the draw
//   item's float +0xc for alpha key, and 1/255 for every other blend. That float was not traced for a particle draw, and
//   it is not a constant for model batches: the stand's recordings (F:\WowOracle\runs\s06.tsv, draws 2541 and 2543)
//   hold alpha-key M2 draws at reference 136 as well as 224. No recorded frame has an alpha-key particle draw (every
//   alpha-tested draw with the particle vertex format FVF 0x142 is blended at reference 1). So the alpha-key gate is
//   left out here until its factor is known (open tail): an alpha-key emitter keeps no alpha test, as before 15.11.
//   Recorded blended draws confirm the 1/255 reference (ALPHAFUNC 7, GREATEREQUAL).
// - Depth write and the gate go together. An alpha-key quad that wrote depth without the original's gate would write
//   it for its transparent texels and for a particle still fading in, and cut quad-shaped holes into whatever
//   transparent thing is drawn behind it afterwards (other particles, smoke, water); the original's gate is what
//   keeps those texels out of the depth buffer. So until the factor is known an alpha-key emitter (123 emitters in 30
//   models of the client: the earth elemental's stones, Entangling Roots, the falling leaves of Silvermoon) is drawn as
//   it was before 15.11, with neither. One recorded frame of the original with such an emitter in view settles it.

import { BLEND_ALPHA_KEY, BLEND_OPAQUE } from "./Wvm.js";

/** 0x00a3fdcc: the alpha-key reference before its unknown factor (draw item +0xc); not applied, see above. */
export const PARTICLE_ALPHA_KEY_REFERENCE = 224 / 255;
/** 0x00a45564. */
export const PARTICLE_ALPHA_REFERENCE = 1 / 255;

/** Depth write and alpha-test reference of an emitter with the record's `blendType`. */
export function particleDepthState(blendType: number): { depthWrite: boolean; alphaTest: number } {
  if (blendType === BLEND_OPAQUE) return { depthWrite: true, alphaTest: 0 };
  if (blendType === BLEND_ALPHA_KEY) return { depthWrite: false, alphaTest: 0 }; // both wait for the gate's factor
  // 0x00833c80's default: a blending type past 6 keeps bit 4 and the material's blend 0 (opaque).
  if (!(blendType >= 0 && blendType <= 6)) return { depthWrite: true, alphaTest: 0 };
  return { depthWrite: false, alphaTest: PARTICLE_ALPHA_REFERENCE };
}
