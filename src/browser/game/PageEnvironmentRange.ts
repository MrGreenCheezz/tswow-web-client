/**
 * 22.10 (12.14): how far around the view subject the page asks its environment client for placements (game/Loop.ts).
 * With the in-page renderer the page's client is the one that draws, so it streams the renderer's whole band
 * (`ENVIRONMENT_STREAM_RANGE`, 810 yards: 14 tiles around Stormwind's square). In worker mode the worker streams that band with its own client
 * (RenderWorkerSession.ts, at the same point), and the page's list serves only the area locator (the visual of the floor
 * under the subject: a placement is listed in every tile its bounds cross, so the subject's own tile holds it) and the
 * warm-up's nearest scenery — the tile under the subject and, near an edge, its neighbours. The page then neither
 * decodes nor holds the other tiles a second time.
 */

import type { ClientRenderer } from "../ClientRenderer.js";
import { ENVIRONMENT_STREAM_RANGE } from "../Terrain.js";

/** The page's own band while a worker draws: the subject's tile, and the next one within this many yards of an edge. */
export const PAGE_ONLY_ENVIRONMENT_RANGE = 64;

export function pageEnvironmentRange(renderer: ClientRenderer | undefined): number {
  if (renderer?.renderWorker !== undefined) return PAGE_ONLY_ENVIRONMENT_RANGE;
  // 22.10 (7.39): the in-page renderer's own band, which the lighting path and detail widen (SceneryReach.ts).
  return (renderer as { readonly environmentStreamRange?: number } | undefined)?.environmentStreamRange
    ?? ENVIRONMENT_STREAM_RANGE;
}
