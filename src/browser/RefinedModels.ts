// 04.11 (7.62): «Сглаженные модели» — the browser half of the refined copies the gateway publishes.
//
// A model's URL asks for its refined copy only while the setting is on in this realm (the renderer's: the worker or the
// page), only for a path that has one, and only once the gateway said it serves them (`refinedModelGeneration`). With the
// setting off, always in the faithful and comparison profiles, every URL is what it was. Models already held keep what
// they arrived as, so a change applies from the next page load.

import { isRefinedModelPath } from "../world/RefinedModels.js";
import { withRefinedModelGeneration } from "./GatewayGeneration.js";

let wanted = false;

/** This realm's setting (WorldRenderer3D.setRefinedModels). */
export function setRefinedModelsEnabled(setting: boolean): void {
  wanted = setting;
}

/** `url` of one model with the request for its refined copy, when that is wanted and possible. */
export function withRefinedModel(url: string, modelPath: string): string {
  return wanted && isRefinedModelPath(modelPath) ? withRefinedModelGeneration(url) : url;
}
