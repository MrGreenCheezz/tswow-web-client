/**
 * 04.11 (7.62): which models have a refined copy on the gateway (baked occlusion and rounder silhouettes,
 * tools/model-refine.mjs) and how a request asks for one. The tools spell the same in `tools/visual-model-key.mjs`;
 * `tests/refined-models.test.mjs` holds the two equal.
 */

/** Bumped when the bake changes: every copy gets a new name, and every browser a new URL. */
export const REFINED_MODEL_VERSION = "1";

/** The query parameter of `/visual/model`; a request whose value is not the current version gets the plain model. */
export const REFINED_MODEL_PARAM = "refined";

/** World doodads and creatures; never a character (dense in the HD patches already), an item or a spell. */
export function isRefinedModelPath(modelPath: string): boolean {
  return /^(?:world|creature)[\\/].*\.m2$/i.test(modelPath);
}
