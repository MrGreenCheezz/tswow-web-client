/**
 * 25.10 (7.50): `GET /visual/lit-models?v=1` — the models that give light by themselves (`src/world/LitModelIndex.ts`):
 * every M2 of the client that declares an `M2Light` point light, so the browser asks for them as soon as a tile lists
 * a placement and lights it before it is built (`LightTemplateCatalog.ts`), as it does lamps by their names.
 *
 * One file for the whole client, `<visual models>/lit-models.json`, published by `tools/generate-lit-model-index.mjs`
 * on the first request (≈24 s: every model of the chain is read once) on a lane of its own, so no model or texture
 * waits behind it; kept with its source stamp and published again when the dataset fingerprint finds an archive
 * changed. A hit is kept for good when the URL names the current visual generation (`vg=`, AssetGeneration.ts).
 *
 * Shape of the answers, like its siblings: Origin refused 403; a wrong `v` 400 (with CORS); no generator and no
 * file 404; a failed generation 500, which the browser retries. A gateway older than this route answers 404 from
 * its fallback, which the browser reads as "no index": models past no name gate light when first built, as before
 * (`LitModelIndexClient.ts`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { respondFile } from "./FileResponse.js";
import { originAllowed } from "./UpgradeGuard.js";
import { LIT_MODEL_INDEX_FILE, LIT_MODEL_INDEX_ROUTE, LIT_MODEL_INDEX_VERSION } from "../world/LitModelIndex.js";

export { LIT_MODEL_INDEX_ROUTE } from "../world/LitModelIndex.js";

export interface LitModelIndexRouteOptions {
  readonly visualModelsDirectory: string;
  readonly allowedOrigins: readonly string[];
  /** Publishes the index (once per lane key); absent: an absent file is a 404. */
  readonly generate?: (() => Promise<void>) | undefined;
  /** Drops a stale index (the dataset fingerprint), before it is read. */
  readonly ensureCurrent?: ((file: string) => Promise<void>) | undefined;
  readonly cacheControl: (requestedGeneration: string | null) => string;
}

function refuse(response: ServerResponse, status: number, origin: string | undefined): void {
  response.writeHead(status, { ...(origin ? { "access-control-allow-origin": origin } : {}), "cache-control": "no-store" }).end();
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Answers `/visual/lit-models`; false leaves every other path to the rest of the gateway. */
export async function serveLitModelIndexRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: LitModelIndexRouteOptions,
): Promise<boolean> {
  if (request.method !== "GET" || url.pathname !== LIT_MODEL_INDEX_ROUTE) return false;
  const origin = request.headers.origin;
  if (!originAllowed(origin, options.allowedOrigins)) {
    response.writeHead(403).end();
    return true;
  }
  if (url.searchParams.get("v") !== String(LIT_MODEL_INDEX_VERSION)) {
    refuse(response, 400, origin);
    return true;
  }
  const file = join(options.visualModelsDirectory, LIT_MODEL_INDEX_FILE);
  try {
    await options.ensureCurrent?.(file);
    if (!await exists(file)) {
      if (!options.generate) {
        refuse(response, 404, origin);
        return true;
      }
      await options.generate();
      if (!await exists(file)) throw new Error("lit model index was not published");
    }
    await respondFile(request, response, file, {
      origin, contentType: "application/json; charset=utf-8",
      cacheControl: options.cacheControl(url.searchParams.get("vg")),
    });
  } catch {
    if (!response.headersSent) refuse(response, 500, origin);
  }
  return true;
}
