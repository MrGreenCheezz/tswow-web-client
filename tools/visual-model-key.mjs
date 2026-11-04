// The name a `/visual/model` artifact is published under, for tools that publish ahead of the
// gateway (`tools/pregenerate.mjs`, 10.22). The gateway's own spelling is `visualModelHash` and
// `visualModelCacheNamespace` in `src/gateway/Gateway.ts`; `tests/pregenerate.test.mjs` keeps the two
// equal — a disagreement would publish every model under a name nobody asks for.

import { createHash } from "node:crypto";

/** The route generation of a model path: WMOs and M2s turn over separately. */
export function visualModelNamespace(modelPath) {
  // 05.10-A7a-F2 (visual-v23); 05.10-A7b-1: visual-wmo-v25; 12.10 6.24: visual-v24, the key bone table;
  // 13.10 7.11: visual-wmo-v26, the Composite streams; 22.10 (7.37): visual-wmo-v27, the transition range.
  // 26.10 (6.31): visual-spell-v1 — the spell models alone, whose clips carry M2Sequence.flags.
  // 03.11 (6.16в, 6.34): visual-unit-v1 — creatures and characters, whose clips carry their variations.
  const lower = modelPath.toLowerCase();
  if (lower.endsWith(".wmo")) return "visual-wmo-v27";
  if (isSpellModelPath(lower)) return SPELL_MODEL_NAMESPACE;
  return isUnitModelPath(lower) ? UNIT_MODEL_NAMESPACE : "visual-v24";
}

/**
 * 6.31 (26.10): the namespace of the spell models (`Spells\…`). Their clips carry `M2Sequence.flags` — a missile
 * stretches its InFlight over the flight when bit 0x1 is set (Missile_C) — and only theirs turn over: 1,567 small
 * files regenerate on demand, not every creature and doodad of the client.
 */
export const SPELL_MODEL_NAMESPACE = "visual-spell-v1";

/**
 * 03.11 (6.16в, 6.34): the namespace of the models a unit is drawn with (`Creature\…`, `Character\…`). Their clips are chosen
 * the way Wow.exe chooses (the table, then a variation by frequency), which only a unit does: about 1,200 models turn over on
 * demand, not every doodad of the client.
 */
export const UNIT_MODEL_NAMESPACE = "visual-unit-v1";

/** Whether a model path is a unit's (`Creature\…`, `Character\…`, either separator, any case). */
export function isUnitModelPath(modelPath) {
  return /^(?:creature|character)[\\/]/i.test(modelPath);
}

/** Whether a model path is a spell model's (`Spells\…`, either separator, any case). */
export function isSpellModelPath(modelPath) {
  return /^spells[\\/]/i.test(modelPath);
}

/**
 * 04.11 (7.62): the generation of the refined models (tools/model-refine.mjs). Bumped when the bake changes, which
 * turns every name over. Equal to `REFINED_MODEL_VERSION` in src/world/RefinedModels.ts (a test holds them so).
 */
export const REFINED_MODEL_VERSION = "1";

/** 04.11 (7.62): whether a model has a refined copy: world doodads and creatures, never characters, items or spells. */
export function isRefinedModelPath(modelPath) {
  return /^(?:world|creature)[\\/].*\.m2$/i.test(modelPath);
}

/**
 * 04.11 (7.62): the name of a model's refined copy, beside the plain one. Which bytes a job publishes is decided by the
 * name it is asked for, as with every namespace here. The plain namespace is part of it, so a copy turns over with it.
 */
export function refinedModelHash(modelPath) {
  return createHash("sha1").update(`refined-${REFINED_MODEL_VERSION}\0${visualModelNamespace(modelPath)}\0${modelPath.toLowerCase()}`).digest("hex");
}

/** `<hash>` of `<VISUAL_MODEL_DIR>/<hash>.bin` for a model path (backslashes, any case). */
export function visualModelHash(modelPath) {
  return visualModelHashIn(visualModelNamespace(modelPath), modelPath);
}

/**
 * The same name under an explicit namespace. 13.10 7.11: the generator asks it for `visual-wmo-v25`,
 * the name a gateway started before v26 still asks for, so that gateway keeps receiving the exact
 * v25 bytes (WME4/WME5, no Composite streams) from these freshly loaded tools until it restarts.
 */
export function visualModelHashIn(namespace, modelPath) {
  return createHash("sha1").update(`${namespace}\0${modelPath.toLowerCase()}`).digest("hex");
}
