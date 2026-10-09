import type { CollisionModel } from "../../world/CollisionFormat.js";
import { RetryingCatalogClient, type RetryingCatalogOptions } from "../CatalogClient.js";
import type { CollisionBox } from "./Collision.js";

/**
 * 11.01 slice A2: a game object's collision model, by display id.
 *
 * The core gives a game object collision only when its display id is in
 * `vmaps/GameObjectModels.dtree` (`GameObjectModel::initialize`, GameObjectModel.cpp:104-120), and
 * finds the geometry by the name that file gives. This is that lookup in the browser: the table
 * comes from the gateway (`GET /vmap/gobject-models`, gateway/GameObjectModels.ts), a few display ids
 * per request, and the geometry from the collision client the static world already uses
 * (`/collision/model/<name>`), so a ship's deck is the same `.vmo` the server stands its passengers
 * on. Shared by the transport decks (TransportCollision.ts) and, later, lifts and doors (slice B).
 *
 * A gateway older than the route answers 404; `RetryingCatalogClient` asks once more after a pause
 * and then waits for `retry()` (the next world mount). Until then every display id reads as "not
 * yet" and nothing becomes solid — the behaviour before this slice.
 */

export const GAME_OBJECT_MODELS_ROUTE_VERSION = 1;
/** As many display ids as one request carries (`GAME_OBJECT_MODELS_MAX_IDS` on the gateway). */
export const GAME_OBJECT_MODELS_BATCH = 256;

export interface GameObjectModelInfo {
  readonly displayId: number;
  /** The vmap file name, as `CollisionClient.model` takes it. */
  readonly name: string;
  readonly isWmo: boolean;
  /** The model-space box the extractor recorded (`.dtree` low/high). */
  readonly bounds: CollisionBox;
}

/** The geometry half: `CollisionClient` in the page. */
export interface CollisionModelSource {
  model(name: string): CollisionModel | undefined;
  isResolved(name: string): boolean;
  requestGroups(name: string, groups: readonly number[]): void;
  readonly revision: number;
}

/**
 * One answer, checked: every requested id maps to its model or to `null` (no collision in the
 * core). Undefined for any other shape, which the retrying client treats as a failed attempt.
 */
export function gameObjectModelsFrom(
  data: unknown,
  ids: readonly number[],
): Map<number, GameObjectModelInfo | null> | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const answer = data as { version?: unknown; models?: unknown };
  if (answer.version !== GAME_OBJECT_MODELS_ROUTE_VERSION || !Array.isArray(answer.models)) return undefined;
  const result = new Map<number, GameObjectModelInfo | null>();
  for (const id of ids) result.set(id, null);
  for (const row of answer.models as unknown[]) {
    if (typeof row !== "object" || row === null) return undefined;
    const { displayId, name, isWmo, bounds } = row as Record<string, unknown>;
    if (typeof displayId !== "number" || !result.has(displayId)) return undefined;
    if (typeof name !== "string" || name.length === 0 || typeof isWmo !== "boolean") return undefined;
    if (!Array.isArray(bounds) || bounds.length !== 6 || !bounds.every((value) => typeof value === "number" && Number.isFinite(value))) {
      return undefined;
    }
    const [minX, minY, minZ, maxX, maxY, maxZ] = bounds as number[];
    result.set(displayId, {
      displayId,
      name,
      isWmo,
      bounds: { minX: minX!, minY: minY!, minZ: minZ!, maxX: maxX!, maxY: maxY!, maxZ: maxZ! },
    });
  }
  return result;
}

export interface GameObjectCollisionModelsOptions extends RetryingCatalogOptions {
  /** Runs the batch of display ids asked for this turn; `queueMicrotask` in the page. */
  readonly schedule?: (flush: () => void) => void;
}

type Batch = RetryingCatalogClient<Map<number, GameObjectModelInfo | null>>;

export class GameObjectCollisionModels {
  readonly origin: string;
  readonly #geometry: CollisionModelSource;
  readonly #options: GameObjectCollisionModelsOptions;
  readonly #schedule: (flush: () => void) => void;
  readonly #infos = new Map<number, GameObjectModelInfo | null>();
  /** The request each display id rides on. */
  readonly #batches = new Map<number, Batch>();
  #queued: number[] = [];
  #flushScheduled = false;
  #revision = 0;

  constructor(gatewayOrigin: string, geometry: CollisionModelSource, options: GameObjectCollisionModelsOptions = {}) {
    this.origin = gatewayOrigin;
    this.#geometry = geometry;
    this.#options = options;
    this.#schedule = options.schedule ?? ((flush) => queueMicrotask(flush));
  }

  /** Moves whenever a table row or a model's geometry lands. */
  get revision(): number {
    return this.#revision + this.#geometry.revision;
  }

  /** The `.dtree` row; `null` when the core gives this display id no collision; undefined until known. */
  info(displayId: number): GameObjectModelInfo | null | undefined {
    const known = this.#infos.get(displayId);
    if (known !== undefined) return known;
    if (!Number.isInteger(displayId) || displayId <= 0 || displayId > 0xffff_ffff) return null;
    if (!this.#batches.has(displayId) && !this.#queued.includes(displayId)) {
      this.#queued.push(displayId);
      if (!this.#flushScheduled) {
        this.#flushScheduled = true;
        this.#schedule(() => this.flush());
      }
    }
    return undefined;
  }

  /**
   * The collision model; `null` when there is none (no `.dtree` row, or the gateway has no file for
   * the name); undefined while either half loads. A big model arrives as group boxes only — see
   * `requestGroups`.
   */
  model(displayId: number): CollisionModel | null | undefined {
    const info = this.info(displayId);
    if (!info) return info;
    const model = this.#geometry.model(info.name);
    if (model) return model;
    return this.#geometry.isResolved(info.name) ? null : undefined;
  }

  requestGroups(displayId: number, groups: readonly number[]): void {
    const info = this.#infos.get(displayId);
    if (info && groups.length > 0) this.#geometry.requestGroups(info.name, groups);
  }

  /** Sends the display ids asked for since the last flush, in batches the gateway accepts. */
  flush(): void {
    this.#flushScheduled = false;
    const queued = this.#queued;
    this.#queued = [];
    for (let start = 0; start < queued.length; start += GAME_OBJECT_MODELS_BATCH) {
      const ids = queued.slice(start, start + GAME_OBJECT_MODELS_BATCH).sort((a, b) => a - b);
      const batch: Batch = new RetryingCatalogClient(
        this.origin,
        `/vmap/gobject-models?v=${GAME_OBJECT_MODELS_ROUTE_VERSION}&ids=${ids.join(",")}`,
        (data) => gameObjectModelsFrom(data, ids),
        this.#options,
      );
      batch.onLoaded = (rows) => {
        for (const [id, row] of rows) this.#infos.set(id, row);
        this.#revision++;
      };
      for (const id of ids) this.#batches.set(id, batch);
      void batch.load();
    }
  }

  /** A world mount: every batch that gave up or was cut short asks again; loaded ones do nothing. */
  retry(): void {
    for (const batch of new Set(this.#batches.values())) void batch.retry();
  }

  /**
   * A world leave: nothing is asked behind the character screen. Rows already held are kept; ids
   * asked for this turn and not yet sent are dropped, and the next `info` after the mount asks again.
   */
  stop(): void {
    this.#queued = [];
    for (const batch of new Set(this.#batches.values())) batch.stop();
  }
}
