/**
 * 25.10 (7.50): the models that give light by themselves — every M2 of the client's archive chain that
 * declares an `M2Light` point light — named by the gateway so the browser asks for them as soon as a tile
 * lists a placement, as it asks for lamps.
 *
 * The browser's lamp catalog (`src/browser/LightTemplateCatalog.ts`) knows a lamp before it is built by
 * its name: the enhanced profile's heuristic (flame and glow cards, unlit lamp glass, lantern panes, fire
 * emitters; `modelFixtureLights`) only ever reads a model whose file name reads as a lamp, torch or fire.
 * A model's own M2 lights are the one way a model with any other name lights, and only the file says so:
 * on the Goldshire -> Stormwind night run `StormwindGypsyWagon01.m2` (a lantern on a wagon) switched on
 * 112 yards from the player, when its first placement was built. The gateway reads every model once
 * (`tools/generate-lit-model-index.mjs`, with the `readLights` the model generator publishes WVM9's
 * light table with, kept by `m2PointLights`' test: type 1, finite position) and serves the list:
 *
 *   GET /visual/lit-models?v=1[&vg=<visual generation>]  ->  { "version": 1, "models": ["world\\…\\x.m2", …] }
 *
 * Paths lower case with backslashes. 111 of the 22,587 models of this client; 6.9 KB. Shared by the
 * gateway route (`src/gateway/LitModelIndexRoute.ts`), the browser (`src/browser/LitModelIndexClient.ts`)
 * and the bench (`bench/lookdev.mjs --lit-models`).
 */

export const LIT_MODEL_INDEX_ROUTE = "/visual/lit-models";
/** The answer's shape; the request names it as `?v=` (and `tools/generate-lit-model-index.mjs` writes it). */
export const LIT_MODEL_INDEX_VERSION = 1;
/** The file beside the visual models the route serves. */
export const LIT_MODEL_INDEX_FILE = "lit-models.json";
/** More entries than any client holds models: a body past it is not an index. */
const LIT_MODEL_INDEX_LIMIT = 100_000;

/** A model path as the index spells it: lower case, backslashes. */
export function litModelKey(path: string): string {
  return path.replaceAll("/", "\\").toLowerCase();
}

/** The index's set of keys, or undefined for a body that is not one (a different version, a wrong shape). */
export function parseLitModelIndex(value: unknown): ReadonlySet<string> | undefined {
  const body = value as { version?: unknown; models?: unknown } | null;
  if (!body || typeof body !== "object" || body.version !== LIT_MODEL_INDEX_VERSION || !Array.isArray(body.models)
    || body.models.length > LIT_MODEL_INDEX_LIMIT) return undefined;
  const models = new Set<string>();
  for (const entry of body.models as unknown[]) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 260) return undefined;
    models.add(litModelKey(entry));
  }
  return models;
}
