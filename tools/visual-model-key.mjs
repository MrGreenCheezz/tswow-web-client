// The name a `/visual/model` artifact is published under, for tools that publish ahead of the
// gateway (`tools/pregenerate.mjs`, 10.22). The gateway's own spelling is `visualModelHash` and
// `visualModelCacheNamespace` in `src/gateway/Gateway.ts`; `tests/pregenerate.test.mjs` keeps the two
// equal — a disagreement would publish every model under a name nobody asks for.

import { createHash } from "node:crypto";

/** The route generation of a model path: WMOs and M2s turn over separately. */
export function visualModelNamespace(modelPath) {
  // 05.10-A7a-F2 (visual-v23); 05.10-A7b-1: visual-wmo-v25 (24 is left to A7a's next M2 bump).
  return modelPath.toLowerCase().endsWith(".wmo") ? "visual-wmo-v25" : "visual-v23";
}

/** `<hash>` of `<VISUAL_MODEL_DIR>/<hash>.bin` for a model path (backslashes, any case). */
export function visualModelHash(modelPath) {
  return createHash("sha1").update(`${visualModelNamespace(modelPath)}\0${modelPath.toLowerCase()}`).digest("hex");
}
