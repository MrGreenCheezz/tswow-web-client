/**
 * 05.10-A7b-7 (M-A7b-1): the generation of `/terrain-splat` files this gateway serves and asks
 * `tools/generate-terrain-splat.mjs` to write (`TERRAIN_SPLAT_GENERATION` there; the two are kept
 * equal by `tests/terrain-splat-v2.test.mjs`).
 *
 * v2 is slice 7 of line A7b: `alpha.png` carries the baked `MCSH` shadow in its alpha (7.06), a
 * ground texture of another size than 256² is resampled rather than point-sampled under a
 * `terrain-layer-v2` id and `splat.json` names its `layerSize` (7.16). The generator is told the
 * generation in the job: a gateway still serving the unversioned files names none and keeps
 * receiving those exact bytes from the same freshly loaded tools.
 */
export const TERRAIN_SPLAT_GENERATION = "terrain-splat-v2";
