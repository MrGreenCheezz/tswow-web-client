// 15.11 (sky8, 7.59): what a LightSkybox model's sky copy of a batch material has to keep.
//
// The renderer draws an authored sky (DalaranSkyBox.m2 and the rest) through fog-free, depth-free copies of the model's
// batch materials (`WorldRenderer3D.#updateSkybox`). The copy kept the first texture and the colour and dropped
// everything `ModelBuild` had folded into the material for the batch's texture stages: the second texture (`alphaMap`)
// and the combiner program installed through `onBeforeCompile` (`M2Combiners.ts`, Wow.exe 0x836980 / 0x836600).
// Dalaran's sky has 21 aurora curtains (submeshes 30–50) drawn additively with shader 0x4014 — AURORALIGHT_OR_B.BLP
// modulated ×2 by its mask AURORAMASK_B_ORANGE.BLP on the second UV set. Without the mask each curtain is its light
// texture over the whole card: hard-edged bright strips laid flat on the sky, the most at night when the additive
// light is not lost in a bright day sky.
//
// An unlit source (every batch of the client's sky models carries M2 material flag 0x01) is a `MeshBasicMaterial` built
// with the same shader chunks as the copy, so its second texture and its program hook carry over as they are. A lit
// source's hook expects the standard material's lighting chunks and stays out, as before.

import * as THREE from "three";

/** Gives the sky copy of an unlit batch material the source's second texture and combiner program. */
export function carrySkyboxBatchStages(source: THREE.Material, copy: THREE.MeshBasicMaterial): void {
  if (!(source instanceof THREE.MeshBasicMaterial)) return;
  copy.alphaMap = source.alphaMap;
  copy.onBeforeCompile = source.onBeforeCompile;
  copy.customProgramCacheKey = source.customProgramCacheKey;
}
