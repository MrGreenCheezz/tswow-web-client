// 15.11 (7.09 slice B, 7.31): the liquid layers the client's own ADT authors, as `/liquid/adt` serves
// them (`tools/adt-liquid.mjs` reads them; the route publishes them per tile).
//
// What the browser takes from them today is the texture placement of magma and slime. Wow.exe fills a
// terrain liquid's vertex buffer in 0x007ce390: a vertex of a layer whose vertex format is 1 (the
// LiquidMaterial of magma, slime and green lava) gets `uv = (s, t) * 0.01171875` (0x00a40414) from the
// file's own u16 pair — MH2O after the heights (0x008a31b0), MCLQ in the vertex's first four bytes
// (0x008a3250) — and only a vertex of another format gets the position rule `xy * 0.06`
// (`pushLiquidCellUvs`). The dataset's `.map` files do not carry (s, t), so until a tile's answer has
// arrived, or where a tile has none, the cell keeps the position rule; measured on the client
// (env4, 11.11), Shadowmoon Valley's green lava steps a median 0.24 uv per cell against the rule's
// 0.25 but anywhere from 0.08 to 0.5, and the magma of Azeroth and Kalimdor 0.49 — twice as coarse.
//
// The answer also carries the heights, the depth bytes and the masks; nothing here reads them yet
// (the depth byte's table is established, what the original's water shader does with it is not —
// see the report of 7.09 B).

/** Wow.exe 0x00a40414: the scale of a format-1 vertex's stored (s, t). */
export const AUTHORED_LIQUID_UV_SCALE = 0.01171875;
/** The version `/liquid/adt` answers; `tools/adt-liquid.mjs` `ADT_LIQUID_VERSION`. */
export const AUTHORED_LIQUID_VERSION = 1;

/** One layer of one chunk, as the route sends it. */
export interface AuthoredLiquidLayer {
  /** `i * 16 + j`: `i` the chunk row (world X falling), `j` the chunk column (world Y falling). */
  chunk: number;
  source: "mh2o" | "mclq";
  type: number;
  /** The vertex format: 0 heights + depth, 1 heights + (s, t), 2 depth only. */
  format: number;
  /** The layer's cells inside the chunk: columns `x .. x + w`, rows `y .. y + h`. */
  x: number;
  y: number;
  w: number;
  h: number;
  min: number;
  max: number;
  /** Per cell, row-major over `w * h`: 1 where the layer has liquid. */
  exists: readonly number[];
  heights?: readonly number[];
  depths?: readonly number[];
  /** Per vertex, row-major over `(w + 1) * (h + 1)`: the raw u16 s, t pairs. */
  uv?: readonly number[];
}

export interface AuthoredLiquidTile {
  /** Format-1 layers with texture coordinates, by chunk, in file order. */
  readonly uvLayers: ReadonlyMap<number, readonly AuthoredLiquidLayer[]>;
  readonly layers: readonly AuthoredLiquidLayer[];
}

function integer(value: unknown, low: number, high: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;
}

function numbers(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

/** The route's JSON, checked; `undefined` for a body that is not a v1 answer. */
export function parseAuthoredLiquidTile(value: unknown): AuthoredLiquidTile | undefined {
  const body = value as { version?: unknown; layers?: unknown } | null;
  if (body === null || typeof body !== "object" || body.version !== AUTHORED_LIQUID_VERSION || !Array.isArray(body.layers)) {
    return undefined;
  }
  const layers: AuthoredLiquidLayer[] = [];
  const uvLayers = new Map<number, AuthoredLiquidLayer[]>();
  for (const item of body.layers as unknown[]) {
    const layer = item as Partial<AuthoredLiquidLayer> | null;
    if (!layer || !integer(layer.chunk, 0, 255) || !integer(layer.format, 0, 3) || !integer(layer.type, 0, 65535)
      || !integer(layer.x, 0, 7) || !integer(layer.y, 0, 7) || !integer(layer.w, 1, 8) || !integer(layer.h, 1, 8)
      || layer.x + layer.w > 8 || layer.y + layer.h > 8 || !numbers(layer.exists, layer.w * layer.h)) continue;
    const vertices = (layer.w + 1) * (layer.h + 1);
    if (layer.uv !== undefined && !numbers(layer.uv, vertices * 2)) continue;
    const checked = layer as AuthoredLiquidLayer;
    layers.push(checked);
    if (checked.format === 1 && checked.uv) {
      const list = uvLayers.get(checked.chunk);
      if (list) list.push(checked);
      else uvLayers.set(checked.chunk, [checked]);
    }
  }
  return { uvLayers, layers };
}

/**
 * The four corners' UVs of the tile cell (`row`, `column`: 0..127, as `#waterGeometrySteps` walks
 * them) from the first format-1 layer that has liquid in it, pushed in that walk's corner order —
 * (x0, y0), (x1, y0), (x0, y1), (x1, y1), which are the vertices (r, c), (r + 1, c), (r, c + 1),
 * (r + 1, c + 1) of the chunk's grid. False, and nothing pushed, where no such layer covers the cell.
 */
export function pushAuthoredLiquidCellUvs(out: number[], tile: AuthoredLiquidTile, row: number, column: number): boolean {
  const layers = tile.uvLayers.get((row >> 3) * 16 + (column >> 3));
  if (!layers) return false;
  const r = row & 7;
  const c = column & 7;
  for (const layer of layers) {
    const ly = r - layer.y;
    const lx = c - layer.x;
    if (ly < 0 || ly >= layer.h || lx < 0 || lx >= layer.w || !layer.exists[ly * layer.w + lx]) continue;
    const uv = layer.uv!;
    const stride = layer.w + 1;
    for (const [dy, dx] of CORNERS) {
      const at = ((ly + dy) * stride + lx + dx) * 2;
      out.push(uv[at]! * AUTHORED_LIQUID_UV_SCALE, uv[at + 1]! * AUTHORED_LIQUID_UV_SCALE);
    }
    return true;
  }
  return false;
}

/** [row step, column step] of the four corners, in the walk's order. */
const CORNERS: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [0, 1], [1, 1]];

const RETRY_MS: readonly number[] = [2_000, 8_000, 30_000];
/** Answers kept; a tile evicted and asked again is fetched again (the browser's cache usually has it). */
const MAX_TILES = 96;

interface Entry {
  tile: AuthoredLiquidTile | null | undefined;
  loading: boolean;
  attempts: number;
  after: number;
}

/**
 * Asks `/liquid/adt/<map>/<gridX>/<gridY>?v=1` once per tile, on the first wet cell that wants it.
 * `tile` answers `undefined` while the answer is on the way, `null` where there is none (404 — an
 * older gateway, or no ADT), and the parsed layers otherwise. `revision` is 0 until a tile has been
 * answered (with layers or for good without) and 1 after, so a tile drawn before its answer is drawn
 * again exactly once.
 */
export class AuthoredLiquidClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #tiles = new Map<string, Entry>();
  #disposed = false;

  constructor(baseUrl: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init), now: () => number = Date.now) {
    this.#baseUrl = baseUrl;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  get size(): number {
    return this.#tiles.size;
  }

  dispose(): void {
    this.#disposed = true;
    this.#tiles.clear();
  }

  revision(map: number, gridX: number, gridY: number): number {
    const entry = this.#tiles.get(`${map}/${gridX}/${gridY}`);
    return entry !== undefined && entry.tile !== undefined ? 1 : 0;
  }

  tile(map: number, gridX: number, gridY: number): AuthoredLiquidTile | null | undefined {
    if (this.#disposed) return null;
    const key = `${map}/${gridX}/${gridY}`;
    let entry = this.#tiles.get(key);
    if (entry && entry.tile !== undefined) return entry.tile;
    if (!entry) {
      if (this.#tiles.size >= MAX_TILES) {
        const oldest = this.#tiles.keys().next().value;
        if (oldest !== undefined) this.#tiles.delete(oldest);
      }
      entry = { tile: undefined, loading: false, attempts: 0, after: 0 };
      this.#tiles.set(key, entry);
    }
    if (!entry.loading && entry.after <= this.#now()) {
      entry.loading = true;
      void this.#load(key, entry, map, gridX, gridY);
    }
    return undefined;
  }

  async #load(key: string, entry: Entry, map: number, gridX: number, gridY: number): Promise<void> {
    try {
      const response = await this.#fetch(`${this.#baseUrl}/liquid/adt/${map}/${gridX}/${gridY}?v=${AUTHORED_LIQUID_VERSION}`);
      if (this.#disposed || this.#tiles.get(key) !== entry) return;
      // 404: no ADT, or a gateway from before the route — the position rule for good. 400: a
      // gateway that serves another version; the same.
      if (response.status === 404 || response.status === 400) {
        entry.tile = null;
        return;
      }
      if (!response.ok) throw new Error(`Liquid layers ${key}: ${response.status}`);
      const parsed = parseAuthoredLiquidTile(await response.json());
      if (this.#disposed || this.#tiles.get(key) !== entry) return;
      entry.tile = parsed ?? null;
    } catch {
      if (this.#disposed || this.#tiles.get(key) !== entry) return;
      const wait = RETRY_MS[entry.attempts];
      entry.attempts++;
      if (wait === undefined) entry.tile = null;
      else entry.after = this.#now() + wait;
    } finally {
      entry.loading = false;
    }
  }
}
