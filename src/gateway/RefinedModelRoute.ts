/**
 * 04.11 (7.62): the refined copies of world doodads and creatures on `/visual/model`.
 *
 * A request carrying `refined=<version>` for a path that has a copy is answered from the copy's own file, published by the
 * same model lane: the tools tell which bytes to write by the name they are asked for (`tools/generate-visual-model.mjs`).
 * Anything else, another version included, is the plain model, so an old URL never fails. `/client/patch-status` says
 * `refinedModelGeneration` while copies are served; a browser asks only after reading it, which is what keeps a gateway
 * without them from filing plain bytes under a refined URL.
 *
 * The switch: `REFINED_MODELS=0` turns it off. On by default for the owner's own play; `tools/start-server.mjs` (bat\32,
 * serving other players) turns it off unless `PUBLIC_REFINED_MODELS=1`.
 */

import { createHash } from "node:crypto";
import { REFINED_MODEL_VERSION } from "../world/RefinedModels.js";

/** The file name of a model's refined copy; `namespace` is the plain model's. `tools/visual-model-key.mjs` spells the same. */
export function refinedModelFileHash(namespace: string, modelPath: string): string {
  return createHash("sha1").update(`refined-${REFINED_MODEL_VERSION}\0${namespace}\0${modelPath.toLowerCase()}`).digest("hex");
}

/** `REFINED_MODELS`: on unless it says 0/false/off/no. */
export function parseRefinedModelsEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env["REFINED_MODELS"]?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}
