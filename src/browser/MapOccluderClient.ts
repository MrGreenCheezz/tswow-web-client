/**
 * 15.11 (7.54, portal8): one map's occluder polygons from the gateway (`/dbc/occluders/<map>`, read there from the
 * user's own Wow.exe by `src/gateway/MapOccluderTable.ts`).
 *
 * One request per map, made the first time the walk asks. Until it answers, and for good after a 404 (no Wow.exe,
 * another build, a gateway older than the route) or a body that does not parse, the answer is "none" and the walk runs
 * without occluders, as before 7.54's follow-up; nothing waits for it. Other failures retry on 2 s / 8 s / 30 s.
 * Answers are the parsed list or undefined: a frame's asks allocate nothing.
 */
import type { MapOccluderRecord } from "./MapOccluders.js";

/** The route's version (`MAP_OCCLUDERS_VERSION` in the gateway). */
export const MAP_OCCLUDERS_ROUTE_VERSION = 1;

const RETRY_MS = [2_000, 8_000, 30_000] as const;

/** The records of a `/dbc/occluders/<map>` body, or undefined when it is not one. */
export function parseMapOccluderBody(body: unknown): MapOccluderRecord[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const occluders = (body as { occluders?: unknown }).occluders;
  if (!Array.isArray(occluders)) return undefined;
  const records: MapOccluderRecord[] = [];
  for (const entry of occluders as unknown[]) {
    if (!entry || typeof entry !== "object") return undefined;
    const { flags, points } = entry as { flags?: unknown; points?: unknown };
    if (typeof flags !== "number" || !Array.isArray(points) || points.length < 9 || points.length % 3 !== 0) return undefined;
    if (!points.every((value) => typeof value === "number" && Number.isFinite(value))) return undefined;
    records.push({ flags, points: points as number[] });
  }
  return records;
}

export class MapOccluderClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  /** A map's records, or null: none for good. */
  readonly #maps = new Map<number, MapOccluderRecord[] | null>();
  readonly #pending = new Set<number>();
  readonly #retry = new Map<number, { attempts: number; at: number }>();
  readonly stats = { requests: 0, maps: 0, none: 0, failures: 0 };

  constructor(baseUrl: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    now: () => number = () => performance.now()) {
    this.#baseUrl = baseUrl;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** The map's records, or undefined while asking, after a failure, or when it has none. */
  records(map: number | undefined): readonly MapOccluderRecord[] | undefined {
    if (map === undefined) return undefined;
    const known = this.#maps.get(map);
    if (known !== undefined) return known ?? undefined;
    if (this.#pending.has(map)) return undefined;
    const retry = this.#retry.get(map);
    if (retry && this.#now() < retry.at) return undefined;
    this.#pending.add(map);
    void this.#load(map);
    return undefined;
  }

  async #load(map: number): Promise<void> {
    this.stats.requests++;
    try {
      const response = await this.#fetch(`${this.#baseUrl}/dbc/occluders/${map}?v=${MAP_OCCLUDERS_ROUTE_VERSION}`);
      if (response.status === 404 || response.status === 400) {
        this.#maps.set(map, null);
        this.stats.none++;
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const records = parseMapOccluderBody(await response.json() as unknown) ?? null;
      this.#maps.set(map, records);
      if (records) this.stats.maps++; else this.stats.none++;
      this.#retry.delete(map);
    } catch {
      this.stats.failures++;
      const attempts = (this.#retry.get(map)?.attempts ?? 0) + 1;
      if (attempts > RETRY_MS.length) {
        this.#maps.set(map, null);
        this.#retry.delete(map);
      } else this.#retry.set(map, { attempts, at: this.#now() + RETRY_MS[attempts - 1]! });
    } finally {
      this.#pending.delete(map);
    }
  }
}
