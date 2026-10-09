import { gameObject } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { RetryingCatalogClient, type RetryingCatalogOptions } from "../CatalogClient.js";

/**
 * 05.10-11.01: a transport model's convex volume — the WMO root's MCVP planes — by display id.
 *
 * Wow.exe takes a falling passenger off its transport on the first falling step outside this volume
 * (0x007618b0 → 0x006ec7b0, refused while 0x0074b5e0 → GO vt+0xf0 → 0x0070b360 → 0x0077ffb0 answers
 * «inside»), testing the offset in the transport's frame — the one the passenger's packets carry.
 * The planes come from the gateway (`GET /vmap/gobject-volumes`, gateway/GameObjectVolumes.ts).
 *
 * A gateway older than the route answers 404: every volume stays undefined, and the ride keeps the
 * wowee rule (`RIDE_LEAVE_FRAMES`) it had before. A display without a row (an M2, no root) is null —
 * the same older rule, for good.
 */

export const CARRIER_VOLUMES_ROUTE_VERSION = 1;
/** As many display ids as one request carries (`GAME_OBJECT_MODELS_MAX_IDS` on the gateway). */
const CARRIER_VOLUMES_BATCH = 256;

/** 0x007aea10: outside as soon as one plane gives a·x + b·y + c·z + d > 0; on a plane is inside. */
export function insideConvexVolume(planes: Float64Array, x: number, y: number, z: number): boolean {
  for (let index = 0; index + 3 < planes.length; index += 4) {
    if (planes[index]! * x + planes[index + 1]! * y + planes[index + 2]! * z + planes[index + 3]! > 0) return false;
  }
  return true;
}

/** One answer, checked: every id maps to its planes or to null. Undefined for any other shape. */
export function carrierVolumesFrom(data: unknown, ids: readonly number[]): Map<number, Float64Array | null> | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const answer = data as { version?: unknown; volumes?: unknown };
  if (answer.version !== CARRIER_VOLUMES_ROUTE_VERSION || !Array.isArray(answer.volumes)) return undefined;
  const result = new Map<number, Float64Array | null>();
  for (const id of ids) result.set(id, null);
  for (const row of answer.volumes as unknown[]) {
    if (typeof row !== "object" || row === null) return undefined;
    const { displayId, planes } = row as Record<string, unknown>;
    if (typeof displayId !== "number" || !result.has(displayId)) return undefined;
    if (!Array.isArray(planes) || planes.length % 4 !== 0
      || !planes.every((value) => typeof value === "number" && Number.isFinite(value))) return undefined;
    result.set(displayId, Float64Array.from(planes as number[]));
  }
  return result;
}

export interface CarrierVolumesOptions extends RetryingCatalogOptions {
  /** Runs the batch of display ids asked for this turn; `queueMicrotask` in the page. */
  readonly schedule?: (flush: () => void) => void;
}

type Batch = RetryingCatalogClient<Map<number, Float64Array | null>>;

export class CarrierVolumes {
  readonly origin: string;
  readonly #options: CarrierVolumesOptions;
  readonly #schedule: (flush: () => void) => void;
  readonly #volumes = new Map<number, Float64Array | null>();
  readonly #batches = new Map<number, Batch>();
  #queued: number[] = [];
  #flushScheduled = false;

  constructor(gatewayOrigin: string, options: CarrierVolumesOptions = {}) {
    this.origin = gatewayOrigin;
    this.#options = options;
    this.#schedule = options.schedule ?? ((flush) => queueMicrotask(flush));
  }

  /** The planes, flat; null when the model has none to give; undefined until known (or never, on an older gateway). */
  volume(displayId: number): Float64Array | null | undefined {
    const known = this.#volumes.get(displayId);
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

  /** The volume of a game object in view, by its `GAMEOBJECT_DISPLAYID`. */
  forObject(object: WorldObjectState): Float64Array | null | undefined {
    const displayId = gameObject.displayId(object);
    return displayId ? this.volume(displayId) : null;
  }

  flush(): void {
    this.#flushScheduled = false;
    const queued = this.#queued;
    this.#queued = [];
    for (let start = 0; start < queued.length; start += CARRIER_VOLUMES_BATCH) {
      const ids = queued.slice(start, start + CARRIER_VOLUMES_BATCH).sort((a, b) => a - b);
      const batch: Batch = new RetryingCatalogClient(
        this.origin,
        `/vmap/gobject-volumes?v=${CARRIER_VOLUMES_ROUTE_VERSION}&ids=${ids.join(",")}`,
        (data) => carrierVolumesFrom(data, ids),
        this.#options,
      );
      batch.onLoaded = (rows) => {
        for (const [id, row] of rows) this.#volumes.set(id, row);
      };
      for (const id of ids) this.#batches.set(id, batch);
      void batch.load();
    }
  }

  /** A world mount: every batch that gave up or was cut short asks again; loaded ones do nothing. */
  retry(): void {
    for (const batch of new Set(this.#batches.values())) void batch.retry();
  }

  /** A world leave: nothing asked behind the character screen; volumes already held are kept. */
  stop(): void {
    this.#queued = [];
    for (const batch of new Set(this.#batches.values())) batch.stop();
  }
}
