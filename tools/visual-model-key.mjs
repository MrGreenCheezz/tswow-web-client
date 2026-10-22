// The name a `/visual/model` artifact is published under, for tools that publish ahead of the
// gateway (`tools/pregenerate.mjs`, 10.22). The gateway's own spelling is `visualModelHash` and
// `visualModelCacheNamespace` in `src/gateway/Gateway.ts`; `tests/pregenerate.test.mjs` keeps the two
// equal — a disagreement would publish every model under a name nobody asks for.

import { createHash } from "node:crypto";

/** The route generation of a model path: WMOs and M2s turn over separately. */
export function visualModelNamespace(modelPath) {
  // 05.10-A7a-F2 (visual-v23); 05.10-A7b-1: visual-wmo-v25; 12.10 6.24: visual-v24, the key bone table;
  // 13.10 7.11: visual-wmo-v26, the Composite streams; 22.10 (7.37): visual-wmo-v27, the transition range.
  return modelPath.toLowerCase().endsWith(".wmo") ? "visual-wmo-v27" : "visual-v24";
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
