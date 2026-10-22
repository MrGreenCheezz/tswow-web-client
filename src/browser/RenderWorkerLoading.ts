/**
 * 22.10 (12.14): loading in worker mode (`?renderworker=1`). The world is drawn with the worker's own resource clients
 * (RenderWorkerClients.ts), while the page keeps the ones physics and its windows need. Three things the in-page
 * renderer got for free, because there the page's clients were the drawing ones:
 *
 * * the loading curtain: it waited for the page's terrain and then three page frames, so in worker mode it lifted
 *   before the worker had its own tile or had drawn anything (`RenderWorkerReadinessTracker`, ui/LoadingScreen.ts);
 * * the status lines: «Terrain: …» and «Environment: …» spoke for the page's clients only (`RenderWorkerStatusCollector`,
 *   app/ResourceStatusLines.ts);
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

/** The two lines of the diagnostics pane the resource clients write (EnterWorld.ts). */
export type ResourceStatusLine = "terrain" | "environment";

export interface RenderWorkerStatus {
  readonly line: ResourceStatusLine;
  readonly message: string;
  readonly error: boolean;
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

/** A client with the status hook EnterWorld.ts sets on the page's. */
interface StatusSource {
  onStatus: ((message: string, error: boolean) => void) | undefined;
}

/** The worker's clients whose messages the page shows (RenderWorkerClients.ts). */
export interface StatusSources {
  readonly terrain: StatusSource;
  readonly splat: StatusSource;
  readonly cover: StatusSource;
  readonly liquids: StatusSource;
  readonly environment: StatusSource;
}

/**
 * The worker's half of the status lines: the clients' messages as EnterWorld.ts routes the page's (terrain, splat,
 * ground cover and liquids to the terrain line, the environment to its own), kept until the next results post. Every
 * error is kept (each one is a notice on the page); of the plain messages only the last per line.
 */
export class RenderWorkerStatusCollector {
  #pending: RenderWorkerStatus[] = [];
  #sources: StatusSources | undefined;

  watch(sources: StatusSources): void {
    this.unwatch();
    this.#sources = sources;
    const route = (line: ResourceStatusLine) => (message: string, error: boolean) => {
      if (this.#sources !== sources) return;
      this.#push({ line, message, error });
    };
    sources.terrain.onStatus = route("terrain");
    sources.splat.onStatus = route("terrain");
    sources.cover.onStatus = route("terrain");
    sources.liquids.onStatus = route("terrain");
    sources.environment.onStatus = route("environment");
  }

  /** The clients are dropped: their late answers say nothing any more. */
  unwatch(): void {
    const sources = this.#sources;
    if (sources === undefined) return;
    this.#sources = undefined;
    for (const source of [sources.terrain, sources.splat, sources.cover, sources.liquids, sources.environment]) {
      source.onStatus = undefined;
    }
  }

  get pending(): number { return this.#pending.length; }

  /** What arrived since the last drain, in order; undefined when nothing did. */
  drain(): RenderWorkerStatus[] | undefined {
    if (this.#pending.length === 0) return undefined;
    const statuses = this.#pending;
    this.#pending = [];
    return statuses;
  }

  #push(status: RenderWorkerStatus): void {
    const pending = this.#pending;
    if (!status.error) {
      // A plain message replaces the line's previous plain one; errors stay.
      const previous = pending.findIndex((entry) => entry.line === status.line && !entry.error);
      if (previous >= 0) pending.splice(previous, 1);
    }
    pending.push(status);
    // A flood of errors (a gateway gone) is bounded: the oldest go first.
    if (pending.length > 32) pending.splice(0, pending.length - 32);
  }
}
