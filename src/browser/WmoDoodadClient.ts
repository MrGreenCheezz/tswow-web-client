// 12.10 6.25: the doodads of a WMO drawn as a game object — a ship's sails, a zeppelin's propellers.
//
// `/visual/doodads?path=<wmo>` answers the WMO's doodad set 0 as JSON (`tools/wmo-doodad-list.mjs`):
// one record per doodad, its position and rotation in the WMO's model space. A WMO an ADT places takes
// its doodads from the tile instead, so only game objects ask. One request per path; a 404 is final
// (the client does not ship the model), any other failure retries on the 2 s / 8 s / 30 s ladder the
// other visual routes use.

import { VISUAL_MODEL_ROUTE_VERSION } from "./Wvm.js";

export interface WmoDoodadPlacement {
  /** The M2's archive path (`.m2`). */
  readonly name: string;
  /** MODD position, WMO model space. */
  readonly position: readonly [number, number, number];
  /** MODD rotation quaternion (x, y, z, w), WMO model space. */
  readonly rotation: readonly [number, number, number, number];
  readonly scale: number;
  /** MODD room illumination, RGBA 0–255, when a lit room owns the doodad. */
  readonly localLight?: readonly [number, number, number, number];
}

const RETRY_MS = [2_000, 8_000, 30_000] as const;
const MAX_DOODADS = 4_096;

/** The URL of a WMO's doodad list. */
export function wmoDoodadsUrl(baseUrl: string, wmoPath: string): string {
  const path = wmoPath.replaceAll("/", "\\");
  return `${baseUrl}/visual/doodads?path=${encodeURIComponent(path)}&v=${VISUAL_MODEL_ROUTE_VERSION}`;
}

function finiteTuple(value: unknown, length: number): number[] | undefined {
  if (!Array.isArray(value) || value.length !== length) return undefined;
  for (const item of value) if (typeof item !== "number" || !Number.isFinite(item)) return undefined;
  return value as number[];
}

/** The list out of the route's JSON; undefined for a body that is not one (version 1 only). */
export function parseWmoDoodadList(value: unknown): WmoDoodadPlacement[] | undefined {
  const body = value as { version?: unknown; doodads?: unknown } | null;
  if (!body || typeof body !== "object" || body.version !== 1 || !Array.isArray(body.doodads)
    || body.doodads.length > MAX_DOODADS) return undefined;
  const result: WmoDoodadPlacement[] = [];
  for (const record of body.doodads as unknown[]) {
    const doodad = record as { name?: unknown; position?: unknown; rotation?: unknown; scale?: unknown; localLight?: unknown } | null;
    if (!doodad || typeof doodad.name !== "string" || !/\.m2$/i.test(doodad.name)) return undefined;
    const position = finiteTuple(doodad.position, 3);
    const rotation = finiteTuple(doodad.rotation, 4);
    if (!position || !rotation || typeof doodad.scale !== "number" || !(doodad.scale > 0)) return undefined;
    const light = doodad.localLight === undefined ? undefined : finiteTuple(doodad.localLight, 4);
    if (doodad.localLight !== undefined && !light) return undefined;
    result.push({
      name: doodad.name,
      position: [position[0]!, position[1]!, position[2]!],
      rotation: [rotation[0]!, rotation[1]!, rotation[2]!, rotation[3]!],
      scale: doodad.scale,
      ...(light ? { localLight: [light[0]!, light[1]!, light[2]!, light[3]!] as const } : {}),
    });
  }
  return result;
}

export class WmoDoodadClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #lists = new Map<string, readonly WmoDoodadPlacement[] | null>();
  readonly #pending = new Set<string>();
  readonly #retry = new Map<string, { attempts: number; at: number }>();

  constructor(baseUrl: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    now: () => number = () => performance.now()) {
    this.#baseUrl = baseUrl;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  /**
   * The doodads of `wmoPath`: the list once it has arrived, null when there is none to have, and
   * undefined while it is on its way (asking for it, the first time).
   */
  doodads(wmoPath: string): readonly WmoDoodadPlacement[] | null | undefined {
    const key = wmoPath.toLowerCase();
    const known = this.#lists.get(key);
    if (known !== undefined) return known;
    if (this.#pending.has(key)) return undefined;
    const retry = this.#retry.get(key);
    if (retry && this.#now() < retry.at) return undefined;
    this.#pending.add(key);
    void this.#load(key, wmoPath);
    return undefined;
  }

  async #load(key: string, wmoPath: string): Promise<void> {
    try {
      const response = await this.#fetch(wmoDoodadsUrl(this.#baseUrl, wmoPath));
      if (response.status === 404) {
        this.#lists.set(key, null);
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const list = parseWmoDoodadList(await response.json() as unknown);
      // A body that does not parse will not parse next time either.
      this.#lists.set(key, list ?? null);
    } catch {
      const attempts = (this.#retry.get(key)?.attempts ?? 0) + 1;
      if (attempts > RETRY_MS.length) this.#lists.set(key, null);
      else this.#retry.set(key, { attempts, at: this.#now() + RETRY_MS[attempts - 1]! });
    } finally {
      this.#pending.delete(key);
    }
  }
}
