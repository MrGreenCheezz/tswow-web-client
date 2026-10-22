/**
 * 22.10 (12.14): loading in worker mode (`?renderworker=1`). The world is drawn with the worker's own resource clients
 * (RenderWorkerClients.ts), while the page keeps the ones physics and its windows need. Two things the in-page
 * renderer got for free, because there the page's clients were the drawing ones:
 *
 * * the loading curtain: it waited for the page's terrain and then three page frames, so in worker mode it lifted
 *   before the worker had its own tile or had drawn anything (`RenderWorkerReadinessTracker`, ui/LoadingScreen.ts);
 * * the asset warm-up: it warmed the page's environment client (RenderWorkerModelWarmup.ts, app/WarmModelTarget.ts).
 *
 * Nothing here touches the DOM or a worker scope, so the tests drive it directly.
 */

import { terrainGridIndex } from "./Terrain.js";

/** Whether the worker's terrain has answered where the page asked for the environment (its view subject). */
export interface RenderWorkerDrawReadiness {
  readonly map: number;
  readonly x: number;
  readonly y: number;
  /** The worker's terrain tile under (x, y) has answered, a deliberate 404 included (`TerrainClient.isReady`). */
  readonly terrain: boolean;
  /** The set of clients that answered (RenderWorkerClientProtocol.ts `RenderWorkerClientsKey.key`). */
  readonly clients: number;
}

/**
 * The page's count of consecutive worker frames drawn with the terrain ready, for one map and terrain tile: another
 * map or tile (a teleport, a step over a tile edge) starts the count again, so a report from before a transfer never
 * lifts the curtain at the destination.
 */
export class RenderWorkerReadinessTracker {
  #map = Number.NaN;
  #cell = -1;
  #frames = 0;

  /**
   * One drawn worker frame's report (`RenderWorkerFrameReport.readiness`); a frame without one, or one drawn with
   * another set of clients than the page's current one (`clients`: a report still in flight from the last world),
   * counts as not ready.
   */
  observe(readiness: RenderWorkerDrawReadiness | undefined, clients: number): void {
    if (readiness === undefined || !readiness.terrain || readiness.clients !== clients) {
      this.#frames = 0;
      return;
    }
    const cell = terrainGridIndex(readiness.x, readiness.y);
    if (readiness.map !== this.#map || cell !== this.#cell) {
      this.#map = readiness.map;
      this.#cell = cell;
      this.#frames = 0;
    }
    this.#frames++;
  }

  /** Worker frames drawn in a row with the terrain ready on this map and tile; 0 for any other. */
  framesReadyAt(map: number, x: number, y: number): number {
    return map === this.#map && terrainGridIndex(x, y) === this.#cell ? this.#frames : 0;
  }

  reset(): void {
    this.#map = Number.NaN;
    this.#cell = -1;
    this.#frames = 0;
  }
}
