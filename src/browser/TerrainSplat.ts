import * as THREE from "three";
import type { TerrainGrid } from "./Terrain.js";
import type { RetainedResourceVisitor } from "./ResourceAccounting.js";
import { withGeneration } from "./GatewayGeneration.js";
import { RetryLadder } from "./RetryLadder.js"; // 05.10-A7b-0 1.24
import { renderSwitches } from "./RenderSwitches.js"; // 05.10-A7b-7Г
import { lightingClassicLook } from "./LightingQuality.js"; // 05.10-7.20

/** Ground textures are republished at this size so one array can hold all of a tile's layers. */
const LAYER_SIZE = 256;
const MAX_LAYERS = 32;
/**
 * 05.10-A7b-7 (7.16): the sides a `terrain-splat-v2` tile may give its layer array in `splat.json`'s
 * `layerSize` (512 only when one of its ground textures has at least 512² pixels; none of the 336
 * sampled in this client does). Anything else — an older gateway names none — is the 256 it always was.
 */
const LAYER_SIZES: ReadonlySet<number> = new Set([256, 512]);
/**
 * 05.10-A7b-7 (M-A7b-1): the splat generation this client reads, as `?v=` on the two files whose
 * bytes changed (`splat.json`, `alpha.png`). The route matches the path only, so an older gateway
 * answers the same request with its own files: RGB alpha (no baked shadow: alpha 255 reads as lit)
 * and no `layerSize` (256) — the ground it drew before.
 */
export const TERRAIN_SPLAT_CLIENT_VERSION = 2;

/** 05.10-A7b-7 (7.16): the layer array side a splat.json asks for; 256 unless it names 256 or 512. */
export function terrainSplatLayerSize(value: unknown): number {
  const size = (value as { layerSize?: unknown } | null)?.layerSize;
  return typeof size === "number" && LAYER_SIZES.has(size) ? size : LAYER_SIZE;
}

/**
 * 05.10-A7b-7 (7.06): how strongly the baked `MCSH` shadow darkens the ground, shared by every
 * terrain program (one uniform object, set on a lighting-quality change, never per frame).
 */
const TERRAIN_BAKED_SHADOW = { value: 1 };

/**
 * 05.10-A7b-7 (7.06): the classic path (lighting quality 0, no shadow pass) draws the client's baked
 * shadow at full strength; the enhanced and cinematic presets keep the owner's look — their own
 * cascaded sun shadow, no baked term on top (the client takes `min(baked, dynamic)`, never the
 * product, and the presets were tuned without it). Calibrated against the original in 14.25.
 * 05.10-7.20: the comparison level (3) is classic too, and it also runs the shadow pass.
 * 05.10 review 7.20: there the cascades' term folds into the baked one as the client's does —
 * `min(baked, dynamic)` on the albedo, the sun unshadowed (`injectTerrainShadowFold`).
 */
export function terrainBakedShadowStrength(lightingQuality: number): number {
  return lightingClassicLook(lightingQuality) ? 1 : 0; // 05.10-7.20: and the comparison level
}

/** 05.10-A7b-7 (7.06): sets the shared strength (0..1) every terrain program reads. */
export function setTerrainBakedShadowStrength(strength: number): void {
  TERRAIN_BAKED_SHADOW.value = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 1;
}

/** 05.10-A7b-7: the current shared strength (tests and diagnostics). */
export function terrainBakedShadowStrengthValue(): number {
  return TERRAIN_BAKED_SHADOW.value;
}

/**
 * 05.10-A7b-7Г (7.16 Г): how much of the ground's specular term is drawn, shared by every terrain
 * program that has one (only tiles loaded with the `terrainSpecular` render switch on). The client
 * draws it when the `specular` CVar is set and pixel shaders are available (0x0078DE60 sets bit
 * 0x08000000 of 0x00CD774C; 0x007BD8A0 turns it into the per-frame terrain flag) — the classic path
 * here; the enhanced and cinematic presets keep their look.
 */
const TERRAIN_SPECULAR = { value: 1 };
/**
 * 05.10-A7b-7Г: the exponent — benilla's reading of 1.12 (`terrain.wgsl`). 05.10 review 7.16 Б/Г:
 * Wow.exe's `c[27].w` is the same 20.0 (the float at 0x00A3FFF0, stored at 0x007CFE5C); `c[27].rgb`
 * is the scene light's accumulated specular colour (0x008355D0, from the source light's +0x48 in
 * 0x00834F60), zero without a light — which colour the sun gives there is still unread.
 */
export const TERRAIN_SPECULAR_EXPONENT = 20;

/** 05.10-A7b-7Г: full on the classic path, none on the presets. */
export function terrainSpecularStrength(lightingQuality: number): number {
  return lightingClassicLook(lightingQuality) ? 1 : 0; // 05.10-7.20: and the comparison level
}

/** 05.10-A7b-7Г: sets the shared strength (0..1); a broken value turns the term off. */
export function setTerrainSpecularStrength(strength: number): void {
  TERRAIN_SPECULAR.value = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0;
}

/** 05.10-A7b-7Г: the current shared strength (tests and diagnostics). */
export function terrainSpecularStrengthValue(): number {
  return TERRAIN_SPECULAR.value;
}

/**
 * 05.10-A7b-7Г: the specular masks a `terrain-splat-v2` splat.json names — one 40-hex id or null per
 * layer, at least one id — or undefined (an older gateway, a tile without `_s` textures, a bad list).
 */
export function terrainSplatSpecularMasks(value: unknown, layerCount: number): (string | null)[] | undefined {
  const list = (value as { specular?: unknown } | null)?.specular;
  if (!Array.isArray(list) || list.length !== layerCount) return undefined;
  if (!list.every((id) => id === null || (typeof id === "string" && /^[0-9a-f]{40}$/.test(id)))) return undefined;
  return list.some((id) => id !== null) ? list as (string | null)[] : undefined;
}
/**
 * How often a ground texture repeats across a whole tile. A tile is 16 chunks wide, so this is
 * eight repeats per chunk — roughly one texture every four metres, the density the original
 * client draws at. Raising it makes the ground busier, lowering it makes it smoother.
 */
export const SPLAT_REPEAT = 16 * 8;

export interface TerrainSplat {
  layers: THREE.DataArrayTexture;
  alpha: THREE.Texture;
  index: THREE.Texture;
  /**
   * `MCCV`, the colour the artist painted on the ground, on the tile's own vertex grid.
   *
   * Absent on 3,550 of the world's 5,744 tiles — everything outside WotLK — and that absence is
   * the neutral answer, not black.
   */
  colours?: THREE.Texture;
  /**
   * 05.10-A7b-7Г (7.16 Г): the layers' alpha holds their `_s.blp` specular masks (255 where a layer
   * has none). Only when the `terrainSpecular` render switch was on as the tile loaded.
   */
  specular?: boolean;
}

export interface TerrainSplatStats {
  readonly resident: number;
  readonly failed: number;
  readonly active: number;
  /** Bytes in successfully decoded, shared RGBA layer pixel arrays only. */
  readonly decodedLayerBytes: number;
  /** Number of unique layer ids retained in the request/result promise cache. */
  readonly layerRequestEntries: number;
}

interface LayerRecord {
  readonly id: string;
  readonly promise: Promise<Uint8ClampedArray>;
  pixels?: Uint8ClampedArray;
  leases: number;
}

interface TerrainSplatTileRecord {
  readonly splat: TerrainSplat;
  readonly layers: ReadonlyMap<string, LayerRecord>;
  /** Every loader handle is owned even if a non-standard loader resolves with a different object. */
  readonly textures: ReadonlySet<THREE.Texture>;
}

interface TerrainSplatRequest {
  readonly key: string;
  readonly epoch: number;
  readonly layers: Map<string, LayerRecord>;
  readonly textures: Set<THREE.Texture>;
  cancelled: boolean;
}

/**
 * The ingredients the terrain shader blends per tile: every ground texture the tile uses stacked
 * into one array, the alpha maps that fade between them, and the per-chunk list naming which four
 * of the array's layers a chunk draws with.
 */
export class TerrainSplatClient {
  onStatus: ((message: string, error: boolean) => void) | undefined;
  readonly #baseUrl: string;
  readonly #tiles = new Map<string, TerrainSplatTileRecord | null>();
  readonly #requests = new Map<string, TerrainSplatRequest>();
  /** Present after the first production active-set update; absent preserves direct-get compatibility. */
  #activeKeys: Set<string> | undefined;
  /** Neighbouring tiles share one decoded record while at least one tile/request leases it. */
  readonly #layers = new Map<string, LayerRecord>();
  /** Texture.dispose dispatches an event repeatedly, so ownership needs its own exact-once guard. */
  readonly #disposedTextures = new WeakSet<THREE.Texture>();
  #decodedLayerBytes = 0;
  #epoch = 0;
  #disposed = false;
  /**
   * 05.10-A7b-0 1.24: a tile whose request failed (anything but the 404 of 7.23) is asked again
   * after 2 s, 8 s and 30 s instead of keeping bare ground until it leaves the active set.
   */
  readonly #failures: RetryLadder<string>;

  /** `now` (05.10-A7b-0 1.24) is the retry ladder's clock; tests inject their own. */
  constructor(gatewayWebSocketUrl: string, now?: () => number) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
    this.#failures = new RetryLadder<string>(undefined, now);
  }

  /** 05.10-A7b-9 (7.18): tiles drawn without their splat until a retry lands (1.24). */
  get retrying(): number {
    return this.#failures.retryingCount();
  }

  get stats(): TerrainSplatStats {
    let resident = 0;
    let failed = 0;
    for (const tile of this.#tiles.values()) {
      if (tile === null) failed++;
      else resident++;
    }
    return Object.freeze({
      resident,
      failed: failed + this.#failures.size, // 05.10-A7b-0 1.24: waiting for a retry or out of them
      active: this.#requests.size,
      decodedLayerBytes: this.#decodedLayerBytes,
      layerRequestEntries: this.#layers.size,
    });
  }

  /** Counts decoded shared pixels, per-tile copies, and each retained logical texture allocation. */
  visitRetainedResources(visitor: RetainedResourceVisitor): void {
    for (const [id, layer] of this.#layers) {
      if (layer.pixels) visitor.referenceCpu(`terrain-splat-layer:${id}`, layer.pixels);
    }
    for (const tile of this.#tiles.values()) {
      if (!tile) continue;
      const layerData = tile.splat.layers.image.data;
      if (layerData) visitor.referenceCpu(tile, layerData);
      for (const texture of tile.textures) visitor.referenceGpuTexture(tile, texture);
    }
    for (const request of this.#requests.values()) {
      for (const texture of request.textures) {
        if (!this.#disposedTextures.has(texture)) visitor.referenceGpuTexture(request, texture);
      }
    }
  }

  /** Makes the tile cache exactly the renderer's retained footprint (visible, prepared and recent). */
  setActiveTiles(map: number | undefined, grids: Iterable<TerrainGrid>): void {
    if (this.#disposed) return;
    const active = new Set<string>();
    if (map !== undefined) {
      for (const grid of grids) active.add(`${map}/${grid.x}/${grid.y}`);
    }
    this.#activeKeys = active;
    this.#failures.retain(active); // 05.10-A7b-0 1.24: a tile that comes back starts a new ladder
    for (const [key, request] of this.#requests) {
      if (!active.has(key)) this.#cancelRequest(request);
    }
    for (const key of this.#tiles.keys()) {
      if (!active.has(key)) this.#evict(key);
    }
  }

  /** Returns the tile's splat once it has loaded, and starts the download the first time. */
  get(map: number, grid: TerrainGrid): TerrainSplat | undefined {
    const key = `${map}/${grid.x}/${grid.y}`;
    const tile = this.#tiles.get(key);
    if (tile) return tile.splat;
    if (this.#disposed || tile === null || this.#requests.has(key)) return undefined;
    if (this.#activeKeys !== undefined && !this.#activeKeys.has(key)) return undefined;
    if (!this.#failures.ready(key)) return undefined; // 05.10-A7b-0 1.24: waiting for its retry
    const request: TerrainSplatRequest = {
      key,
      epoch: this.#epoch,
      layers: new Map(),
      textures: new Set(),
      cancelled: false,
    };
    this.#requests.set(key, request);
    void this.#load(map, grid, request);
    return undefined;
  }

  /** Cancels every logical request and releases all resident CPU/GPU ownership. */
  dispose(): void {
    this.#epoch++;
    this.#disposed = true;
    this.#activeKeys = new Set();
    this.#failures.reset(); // 05.10-A7b-0 1.24
    for (const request of [...this.#requests.values()]) this.#cancelRequest(request);
    for (const key of [...this.#tiles.keys()]) this.#evict(key);
    this.onStatus = undefined;
  }

  #isCurrent(request: TerrainSplatRequest): boolean {
    return !this.#disposed
      && !request.cancelled
      && request.epoch === this.#epoch
      && this.#requests.get(request.key) === request
      && (this.#activeKeys === undefined || this.#activeKeys.has(request.key));
  }

  #cancelRequest(request: TerrainSplatRequest): void {
    if (request.cancelled) return;
    request.cancelled = true;
    if (this.#requests.get(request.key) === request) this.#requests.delete(request.key);
    this.#disposeRequestTextures(request);
    this.#releaseRequestLayers(request);
  }

  #evict(key: string): void {
    const tile = this.#tiles.get(key);
    if (tile === undefined) return;
    this.#tiles.delete(key);
    if (!tile) return;
    for (const texture of tile.textures) this.#disposeTexture(texture);
    for (const layer of tile.layers.values()) this.#releaseLayer(layer);
  }

  #disposeTexture(texture: THREE.Texture): void {
    if (this.#disposedTextures.has(texture)) return;
    this.#disposedTextures.add(texture);
    try { texture.dispose(); } catch { /* best-effort release must continue through every sibling */ }
  }

  #trackTexture(request: TerrainSplatRequest, texture: THREE.Texture): void {
    if (!this.#isCurrent(request)) {
      this.#disposeTexture(texture);
      return;
    }
    request.textures.add(texture);
  }

  #disposeRequestTextures(request: TerrainSplatRequest): void {
    for (const texture of request.textures) this.#disposeTexture(texture);
    request.textures.clear();
  }

  #releaseRequestLayers(request: TerrainSplatRequest): void {
    for (const layer of request.layers.values()) this.#releaseLayer(layer);
    request.layers.clear();
  }

  #releaseLayer(layer: LayerRecord): void {
    layer.leases--;
    if (layer.leases !== 0 || this.#layers.get(layer.id) !== layer) return;
    this.#layers.delete(layer.id);
    if (layer.pixels) {
      this.#decodedLayerBytes -= layer.pixels.byteLength;
      delete layer.pixels;
    }
  }

  async #load(map: number, grid: TerrainGrid, request: TerrainSplatRequest): Promise<void> {
    let installed = false;
    try {
      const base = `${this.#baseUrl}/terrain-splat/${map}/${grid.x}/${grid.y}`;
      const response = await fetch(withGeneration(`${base}?v=${TERRAIN_SPLAT_CLIENT_VERSION}`)); // 05.10-A7b-7
      // 7.23: 404 is the gateway saying this tile has nothing to paint (a stub under a dungeon, a
      // map with no ADT) — final and not an error, so it is remembered like one but not reported.
      if (response.status === 404) {
        if (this.#isCurrent(request)) {
          this.#failures.clear(request.key); // 05.10-A7b-0 1.24
          this.#tiles.set(request.key, null);
        }
        return;
      }
      if (!response.ok) throw new Error(`Terrain splat gateway returned ${response.status}`);
      const value: unknown = await response.json();
      if (!this.#isCurrent(request)) return;
      const layers = (value as { layers?: unknown }).layers;
      if (!Array.isArray(layers) || layers.length === 0 || layers.length > MAX_LAYERS
        || !layers.every((id) => typeof id === "string" && /^[0-9a-f]{40}$/.test(id))) {
        throw new Error("Terrain splat gateway returned an invalid layer list");
      }

      const painted = (value as { mccv?: unknown }).mccv === true;
      const layerSize = terrainSplatLayerSize(value); // 05.10-A7b-7 (7.16)
      for (const id of new Set(layers)) request.layers.set(id, this.#acquireLayer(id, layerSize));
      // 05.10-A7b-7Г (7.16 Г): masks only while the switch is on — off, nothing more is fetched.
      const masks = renderSwitches.terrainSpecular ? terrainSplatSpecularMasks(value, layers.length) : undefined;
      if (masks) {
        for (const id of masks) if (id !== null && !request.layers.has(id)) request.layers.set(id, this.#acquireLayer(id, layerSize));
      }
      // A mask that will not load costs the tile its glint, never its ground.
      const maskPixels = masks
        ? Promise.all(masks.map((id) => (id === null ? undefined : request.layers.get(id)!.promise))).catch(() => undefined)
        : Promise.resolve(undefined);
      const results = await Promise.allSettled([
        Promise.all(layers.map((id) => request.layers.get(id)!.promise)),
        // 05.10-A7b-7 (7.06): RGBA since v2 — its alpha is the baked shadow (see #loadBitmapTexture).
        this.#loadTexture(request, withGeneration(`${base}/alpha.png?v=${TERRAIN_SPLAT_CLIENT_VERSION}`)),
        this.#loadTexture(request, withGeneration(`${base}/index.png`)),
        painted ? this.#loadTexture(request, withGeneration(`${base}/mccv.png`)) : Promise.resolve(undefined),
        maskPixels, // 05.10-A7b-7Г
      ]);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
      if (!this.#isCurrent(request)) return;
      const pixels = (results[0] as PromiseFulfilledResult<Uint8ClampedArray[]>).value;
      const alpha = (results[1] as PromiseFulfilledResult<THREE.Texture>).value;
      const index = (results[2] as PromiseFulfilledResult<THREE.Texture>).value;
      const colours = (results[3] as PromiseFulfilledResult<THREE.Texture | undefined>).value;

      const data = new Uint8Array(layerSize * layerSize * 4 * layers.length);
      for (let layer = 0; layer < pixels.length; layer++) data.set(pixels[layer]!, layer * layerSize * layerSize * 4);
      // 05.10-A7b-7Г: each mask's grey into its layer's alpha, in this tile's own copy (the decoded
      // layers are shared between tiles); a layer without one stays opaque — full mask, as the
      // client's textures without alpha read. No new memory: the array was RGBA already.
      const masked = (results[4] as PromiseFulfilledResult<(Uint8ClampedArray | undefined)[] | undefined>).value;
      if (masked) {
        const texels = layerSize * layerSize;
        for (let layer = 0; layer < masked.length; layer++) {
          const mask = masked[layer];
          const offset = layer * texels * 4 + 3;
          if (mask) for (let texel = 0; texel < texels; texel++) data[offset + texel * 4] = mask[texel * 4]!;
          else for (let texel = 0; texel < texels; texel++) data[offset + texel * 4] = 255;
        }
      }
      const array = new THREE.DataArrayTexture(data, layerSize, layerSize, layers.length);
      this.#trackTexture(request, array);
      array.format = THREE.RGBAFormat;
      array.type = THREE.UnsignedByteType;
      array.colorSpace = THREE.SRGBColorSpace;
      array.wrapS = THREE.RepeatWrapping;
      array.wrapT = THREE.RepeatWrapping;
      array.minFilter = THREE.LinearMipmapLinearFilter;
      array.magFilter = THREE.LinearFilter;
      array.generateMipmaps = true;
      array.needsUpdate = true;

      // The alpha maps carry no mipmaps on purpose: at a coarse level a chunk shrinks to a single
      // texel and starts bleeding its blend into the chunk next door.
      alpha.minFilter = THREE.LinearFilter;
      alpha.magFilter = THREE.LinearFilter;
      alpha.generateMipmaps = false;
      alpha.wrapS = THREE.ClampToEdgeWrapping;
      alpha.wrapT = THREE.ClampToEdgeWrapping;
      alpha.needsUpdate = true;

      // The layer list must be read exactly, never interpolated between neighbouring chunks.
      index.minFilter = THREE.NearestFilter;
      index.magFilter = THREE.NearestFilter;
      index.generateMipmaps = false;
      index.wrapS = THREE.ClampToEdgeWrapping;
      index.wrapT = THREE.ClampToEdgeWrapping;
      index.needsUpdate = true;

      if (colours) {
        // One texel per vertex of the mesh, read as data rather than as colour: the shader has to
        // do its own conversion, because this is a multiplier that reaches 2.0 and the sRGB decode
        // is only defined up to 1.
        colours.minFilter = THREE.LinearFilter;
        colours.magFilter = THREE.LinearFilter;
        colours.generateMipmaps = false;
        colours.wrapS = THREE.ClampToEdgeWrapping;
        colours.wrapT = THREE.ClampToEdgeWrapping;
        colours.colorSpace = THREE.NoColorSpace;
        colours.needsUpdate = true;
      }

      if (!this.#isCurrent(request)) return;
      const splat: TerrainSplat = {
        layers: array, alpha, index, ...(colours ? { colours } : {}), ...(masked ? { specular: true } : {}), // 05.10-A7b-7Г
      };
      const tile: TerrainSplatTileRecord = {
        splat,
        layers: new Map(request.layers),
        textures: new Set(request.textures),
      };
      request.layers.clear();
      request.textures.clear();
      this.#failures.clear(request.key); // 05.10-A7b-0 1.24
      this.#tiles.set(request.key, tile);
      installed = true;
      this.#reportStatus(`Terrain splat: ${[...this.#tiles.values()].filter(Boolean).length} тайлов`, false);
    } catch (error) {
      if (this.#isCurrent(request)) {
        // 05.10-A7b-0 1.24: no `null` (that was final until the tile left the active set); the
        // ladder holds `get` off for 2 s / 8 s / 30 s and gives up after the fourth failure.
        this.#failures.failed(request.key);
        this.#reportStatus(error instanceof Error ? error.message : String(error), true);
      }
    } finally {
      if (!installed) {
        this.#disposeRequestTextures(request);
        this.#releaseRequestLayers(request);
      }
      if (this.#requests.get(request.key) === request) this.#requests.delete(request.key);
    }
  }

  #reportStatus(message: string, error: boolean): void {
    try { this.onStatus?.(message, error); } catch { /* observers do not participate in ownership */ }
  }

  #acquireLayer(name: string, size = LAYER_SIZE): LayerRecord {
    // 05.10-A7b-7 (7.16): one decoded copy per id *and* array side — two neighbouring tiles with
    // different `layerSize` share the download through the HTTP cache, not the scaled pixels.
    const id = size === LAYER_SIZE ? name : `${name}@${size}`;
    let layer = this.#layers.get(id);
    if (!layer) {
      const promise = decodeImagePixels(withGeneration(`${this.#baseUrl}/terrain-layer/${name}.png`), size);
      layer = { id, promise, leases: 0 };
      this.#layers.set(id, layer);
      const exact = layer;
      void promise.then((pixels) => {
        if (this.#layers.get(id) !== exact) return;
        exact.pixels = pixels;
        this.#decodedLayerBytes += pixels.byteLength;
      }, () => undefined);
    }
    layer.leases++;
    return layer;
  }

  #loadTexture(request: TerrainSplatRequest, url: string): Promise<THREE.Texture> {
    // An <img> handed to WebGL is decoded again on the main thread inside its first upload,
    // because WebGL wants the pixels unpremultiplied and unmanaged: 6-9 ms for a 1024x1024 alpha
    // map, on the frame the tile is prepared. The bitmap path decodes off the main thread.
    if (typeof createImageBitmap === "function" && typeof ImageBitmap === "function"
      && typeof fetch === "function") {
      return this.#loadBitmapTexture(request, url);
    }
    return this.#loadImageTexture(request, url);
  }

  /**
   * The same pixels WebGL's own image upload produces for these textures: `flipY` (the Texture
   * default) is applied by the decoder, and the colour is neither premultiplied nor colour-managed,
   * exactly what `UNPACK_PREMULTIPLY_ALPHA = false` and a `NoColorSpace` texture ask of an <img>.
   *
   * 05.10-A7b-7 (7.06): `premultiplyAlpha: "none"` is load-bearing since `alpha.png` carries the
   * baked shadow in its alpha — a premultiplied decode would zero the three blend weights wherever
   * the ground is in shadow. The <img> fallback below is used only where `createImageBitmap` is
   * missing (no supported browser); WebGL uploads an <img> unpremultiplied when asked to.
   */
  async #loadBitmapTexture(request: TerrainSplatRequest, url: string): Promise<THREE.Texture> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load ${url}`);
    const bitmap = await createImageBitmap(await response.blob(), {
      imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "none",
    });
    const texture = new THREE.Texture(bitmap);
    // Already flipped; WebGL ignores the unpack flip for a bitmap in any case.
    texture.flipY = false;
    // Kept open for as long as the texture lives, so a restored context can upload it again.
    texture.addEventListener("dispose", () => bitmap.close());
    this.#trackTexture(request, texture);
    return texture;
  }

  #loadImageTexture(request: TerrainSplatRequest, url: string): Promise<THREE.Texture> {
    return new Promise((resolve, reject) => {
      let handle: THREE.Texture | undefined;
      let failed = false;
      let settled = false;
      try {
        handle = new THREE.TextureLoader().load(
          url,
          (texture) => {
            this.#trackTexture(request, texture);
            if (settled) return;
            settled = true;
            resolve(texture);
          },
          undefined,
          () => {
            if (settled) return;
            settled = true;
            failed = true;
            if (handle) this.#disposeTexture(handle);
            reject(new Error(`Failed to load ${url}`));
          },
        );
        this.#trackTexture(request, handle);
        if (failed || !this.#isCurrent(request)) this.#disposeTexture(handle);
      } catch (error) {
        if (!settled) {
          settled = true;
          reject(error);
        }
      }
    });
  }
}

/** Reads one PNG back to raw bytes, which is the only way to stack them into a texture array. */
async function decodeImagePixels(url: string, size: number): Promise<Uint8ClampedArray> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Terrain layer gateway returned ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas 2D is unavailable for terrain layers");
    context.drawImage(bitmap, 0, 0, size, size);
    return context.getImageData(0, 0, size, size).data;
  } finally {
    bitmap.close();
  }
}

/**
 * Turns a plain diffuse material into the terrain splat material. Lighting, fog and tone mapping
 * stay exactly as three.js built them; only the surface colour is replaced. Terrain deliberately
 * uses Lambert rather than Standard: a ground albedo is not a metal/specular mask, and even the
 * Standard material's small default dielectric highlight reads as a plastic sheen on the dense
 * splat pattern.
 */
export function applyTerrainSplat(
  material: THREE.MeshLambertMaterial,
  splat: TerrainSplat,
): void {
  const painted = splat.colours !== undefined;
  const specular = splat.specular === true; // 05.10-A7b-7Г
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.splatLayers = { value: splat.layers };
    shader.uniforms.splatAlpha = { value: splat.alpha };
    shader.uniforms.splatIndex = { value: splat.index };
    shader.uniforms.splatRepeat = { value: SPLAT_REPEAT };
    shader.uniforms.splatBakedShadow = TERRAIN_BAKED_SHADOW; // 05.10-A7b-7: shared, not per tile
    if (splat.colours) shader.uniforms.splatColours = { value: splat.colours };
    // 05.10-A7b-7Г: the term needs the world light's sun (it ran first, as the outer hook).
    const glint = specular && terrainSpecularTargetsPresent(shader);
    if (glint) shader.uniforms.splatSpecularStrength = TERRAIN_SPECULAR;
    shader.vertexShader = `varying vec2 vSplatUv;\n${shader.vertexShader}`
      .replace("#include <begin_vertex>", "vSplatUv = uv;\n#include <begin_vertex>");
    shader.fragmentShader = `
      precision highp sampler2DArray;
      uniform sampler2DArray splatLayers;
      uniform sampler2D splatAlpha;
      uniform sampler2D splatIndex;
      uniform float splatRepeat;
      uniform float splatBakedShadow;
      varying vec2 vSplatUv;
      ${painted ? "uniform sampler2D splatColours;" : ""}${glint ? "\n      uniform float splatSpecularStrength;\n      varying float vSplatSpecular;" : "" /* 05.10-A7b-7Г */}

      vec3 splatLayer(float slot, vec2 detail, vec3 fallback) {
        return slot < 0.0 ? fallback : texture(splatLayers, vec3(detail, slot)).rgb;
      }
    ${shader.fragmentShader}`.replace("#include <map_fragment>", `
      vec4 splatSlots = texture2D(splatIndex, vSplatUv) * 255.0 - 1.0;
      // 05.10-A7b-7 (7.16): the alpha map is read inside the chunk that owns the fragment. The index
      // is per chunk (nearest), so a bilinear tap half a texel across the border would blend this
      // chunk's slot with the neighbour's weights for a different texture; the client draws each
      // chunk from its own 64x64 map. 16 chunks a side, 64 texels a chunk.
      vec2 splatChunk = vSplatUv * 16.0;
      vec2 splatCell = min( floor( splatChunk ), vec2( 15.0 ) );
      vec2 splatAlphaUv = ( splatCell + clamp( splatChunk - splatCell, vec2( 0.5 / 64.0 ), vec2( 63.5 / 64.0 ) ) ) / 16.0;
      vec4 splatAlphaTexel = texture2D(splatAlpha, splatAlphaUv);
      vec3 splatBlend = splatAlphaTexel.rgb;
      vec2 splatDetail = vSplatUv * splatRepeat;
      vec3 splatColour = splatLayer(splatSlots.r, splatDetail, vec3(0.30, 0.38, 0.26));
      if (splatSlots.g >= 0.0) splatColour = mix(splatColour, texture(splatLayers, vec3(splatDetail, splatSlots.g)).rgb, splatBlend.r);
      if (splatSlots.b >= 0.0) splatColour = mix(splatColour, texture(splatLayers, vec3(splatDetail, splatSlots.b)).rgb, splatBlend.g);
      if (splatSlots.a >= 0.0) splatColour = mix(splatColour, texture(splatLayers, vec3(splatDetail, splatSlots.a)).rgb, splatBlend.b);
      diffuseColor.rgb *= splatColour;${glint ? `\n      ${TERRAIN_SPECULAR_MASK}` : "" /* 05.10-A7b-7Г */}
      // 05.10-A7b-7 (7.06): MCSH as the client's Shaders/Pixel/arbfp1/terrain2.bls applies it —
      // albedo × (0.3 · lit + 0.7), lit = the alpha map's .w (c[12] = {0.2, 0.3, 0.7, 2}).
      // An older gateway's RGB alpha reads 1 (lit); the presets above the classic path set 0.
      float splatBakedLit = mix( 1.0, splatAlphaTexel.a, splatBakedShadow );
      diffuseColor.rgb *= 0.7 + 0.3 * splatBakedLit;
      ${painted ? `
      // MCCV, applied the way an uncorrected client applies it. 127 is neutral, so the painted
      // value is a display-space multiplier between 0 and 2; raising it to 2.2 is what makes the
      // product come out as the artist's colour times the artist's texture once three has encoded
      // the frame back to sRGB. The half texel is because there are 129 texels across 128 cells,
      // one per vertex, and the sampler wants their centres.
      vec2 mccvUv = vSplatUv * ${(128 / 129).toFixed(8)} + ${(0.5 / 129).toFixed(8)};
      diffuseColor.rgb *= pow(texture2D(splatColours, mccvUv).rgb * 2.007874, vec3(2.2));
      ` : ""}
    `);
    if (glint) injectTerrainSpecular(shader); // 05.10-A7b-7Г
    injectTerrainShadowFold(shader); // 05.10 review 7.20
  };
  // Without this every terrain material would share one compiled program and its uniforms.
  // Two programs, not one: a tile with painted ground compiles a different shader from one
  // without, and sharing the key would hand the second the first's missing sampler.
  const splatKey = painted ? "terrain-splat-mccv-v2" : "terrain-splat-v2"; // 05.10-A7b-7
  const specularKey = specular ? "|terrain-splat-spec-v1" : ""; // 05.10-A7b-7Г
  material.customProgramCacheKey = () => `${previousKey}|${splatKey}${specularKey}`;
  material.color.setHex(0xffffff);
  material.needsUpdate = true;
}

/**
 * 05.10-A7b-7Г (7.16 Г): the specular mask, blended across the chunk's layers with the colour's own
 * weights (benilla `terrain.wgsl`; the client's fragment programs read the layer texture's `.w`).
 * A slot without a texture contributes no mask.
 */
const TERRAIN_SPECULAR_MASK = `float splatSpecMask = splatSlots.r < 0.0 ? 0.0 : texture(splatLayers, vec3(splatDetail, splatSlots.r)).a;
      if (splatSlots.g >= 0.0) splatSpecMask = mix( splatSpecMask, texture(splatLayers, vec3(splatDetail, splatSlots.g)).a, splatBlend.r );
      if (splatSlots.b >= 0.0) splatSpecMask = mix( splatSpecMask, texture(splatLayers, vec3(splatDetail, splatSlots.b)).a, splatBlend.g );
      if (splatSlots.a >= 0.0) splatSpecMask = mix( splatSpecMask, texture(splatLayers, vec3(splatDetail, splatSlots.a)).a, splatBlend.b );`;

const TERRAIN_SPECULAR_VERTEX_MARKER = "#include <fog_vertex>";
const TERRAIN_SPECULAR_FRAGMENT_MARKER = "reflectedLight.directSpecular = vec3( 0.0 );";

/** 05.10-A7b-7Г: whether the program has the world light's terrain body and the vertex hook point. */
function terrainSpecularTargetsPresent(shader: TerrainShaderSource): boolean {
  return shader.fragmentShader.includes("#define WOW_LIGHT_TERRAIN")
    && shader.fragmentShader.split(TERRAIN_SPECULAR_FRAGMENT_MARKER).length === 2
    && shader.vertexShader.split(TERRAIN_SPECULAR_VERTEX_MARKER).length === 2;
}

/**
 * 05.10-A7b-7Г (7.16 Г): the client's terrain specular. `Shaders/Vertex/arbvp1/terrain.bls` in its
 * specular permutations computes, per vertex, `pow(max(N·H, 0), c[27].w) · c[27].rgb` with H the
 * half vector of the light and the eye; the fragment programs add it times the layer's alpha and
 * the baked shadow after the diffuse modulate. Here: per vertex as there, the colour the sun's
 * diffuse (`wowDiffuse`) until `c[27].rgb` is read from Wow.exe and the exponent 20 (benilla; Wow.exe
 * agrees, 05.10 review 7.16 Б/Г), added in
 * display space (the client's framebuffer), scaled by the shared classic-path strength.
 */
function injectTerrainSpecular(shader: TerrainShaderSource): void {
  shader.vertexShader = `uniform vec3 wowSunDirection;\nvarying float vSplatSpecular;\n${shader.vertexShader}`
    .replace(TERRAIN_SPECULAR_VERTEX_MARKER, `
      vec3 splatSpecN = normalize( transformedNormal );
      vec3 splatSpecL = normalize( ( viewMatrix * vec4( wowSunDirection, 0.0 ) ).xyz );
      vec3 splatSpecH = normalize( splatSpecL + normalize( -mvPosition.xyz ) );
      vSplatSpecular = pow( max( dot( splatSpecN, splatSpecH ), 0.0 ), ${TERRAIN_SPECULAR_EXPONENT.toFixed(1)} );
      ${TERRAIN_SPECULAR_VERTEX_MARKER}`);
  shader.fragmentShader = shader.fragmentShader.replace(TERRAIN_SPECULAR_FRAGMENT_MARKER, `${TERRAIN_SPECULAR_FRAGMENT_MARKER}
float splatSpecWeight = vSplatSpecular * splatSpecMask * splatBakedLit * wowShadow * splatSpecularStrength;
if ( splatSpecWeight > 0.0 ) {
  reflectedLight.directDiffuse = pow( pow( reflectedLight.directDiffuse, vec3( 1.0 / 2.2 ) ) + wowDiffuse * splatSpecWeight, vec3( 2.2 ) );
}`);
}

/** 05.10 review 7.20: the world light's terrain sun term, the line the fold has to precede. */
const TERRAIN_SHADOW_FOLD_MARKER = "vec3 wowAuthoredLight = max( wowAmbient + wowDiffuse * ( wowNL * wowShadow ), vec3( 0.0 ) );";

/**
 * 05.10 review 7.20: the client's terrain fragment programs (`Shaders/Pixel/arbfp1/terrain2.bls` and
 * `terrain2_pcf.bls`, every permutation) fold the dynamic shadow into the baked one: five shadow-map
 * taps averaged, faded out towards the map's edge, then `lit = min(MCSH, that)`, applied as
 * `albedo × (0.3 · lit + 0.7)` and to the specular — the vertex-lit sun itself is never shadowed.
 * Wherever the baked term is drawn (the classic look; with a shadow pass that is level 3
 * «сравнение») the terrain does the same: the cascades' term at full strength (the client's PCF has
 * no intensity) joins `splatBakedLit` and the sun term reads no shadow. The presets drop the baked
 * term (strength 0) and keep their own sun shadow untouched. No shadow map, no fold: quality 0's
 * program is unchanged. The slope fade the cascades carry (acne at grazing sun) stays in the term.
 */
function injectTerrainShadowFold(shader: TerrainShaderSource): void {
  if (!shader.fragmentShader.includes("#define WOW_LIGHT_TERRAIN")) return;
  if (shader.fragmentShader.split(TERRAIN_SHADOW_FOLD_MARKER).length !== 2) return;
  shader.fragmentShader = shader.fragmentShader.replace(TERRAIN_SHADOW_FOLD_MARKER, `#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
if ( splatBakedShadow > 0.0 ) {
  float splatDynamicLit = clamp( 1.0 - ( 1.0 - wowShadow ) / max( directionalLightShadows[ 0 ].shadowIntensity, 0.0001 ), 0.0, 1.0 );
  float splatShadowLit = min( splatBakedLit, splatDynamicLit );
  diffuseColor.rgb *= ( 0.7 + 0.3 * splatShadowLit ) / ( 0.7 + 0.3 * splatBakedLit );
  splatBakedLit = splatShadowLit;
  wowShadow = 1.0;
}
#endif
${TERRAIN_SHADOW_FOLD_MARKER}`);
}

export const TERRAIN_MICRO_NORMAL_PROFILE_VERSION = 1;

type TerrainShaderSource = Parameters<THREE.Material["onBeforeCompile"]>[0];
type TerrainShaderRenderer = Parameters<THREE.Material["onBeforeCompile"]>[1];

interface TerrainMicroNormalBinding {
  readonly previousCompile: (shader: TerrainShaderSource, renderer: TerrainShaderRenderer) => void;
  readonly previousKey: string;
  enabled: boolean;
}

const TERRAIN_MICRO_NORMAL_BINDINGS = new WeakMap<THREE.MeshLambertMaterial, TerrainMicroNormalBinding>();
const TERRAIN_NORMAL_MARKER = "#include <normal_fragment_maps>";

/**
 * Gives splatted terrain a small albedo-derived normal before the authored world-light block.
 * The profile is shader-only: no texture, geometry, draw-call or render-pass ownership is added.
 * Its zero path preserves the exact source and cache key captured from the splat/world-light chain.
 */
export function setTerrainSplatMicroNormals(
  material: THREE.MeshLambertMaterial,
  enabled: boolean,
): void {
  const existing = TERRAIN_MICRO_NORMAL_BINDINGS.get(material);
  if (existing) {
    if (existing.enabled !== enabled) {
      existing.enabled = enabled;
      material.needsUpdate = true;
    }
    return;
  }

  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  const binding: TerrainMicroNormalBinding = { previousCompile, previousKey, enabled };
  TERRAIN_MICRO_NORMAL_BINDINGS.set(material, binding);
  material.onBeforeCompile = (shader, renderer) => {
    binding.previousCompile.call(material, shader, renderer);
    if (!binding.enabled) return;
    injectTerrainMicroNormals(shader);
  };
  material.customProgramCacheKey = () => binding.enabled
    ? `${binding.previousKey}|terrain-micro-normal-v${TERRAIN_MICRO_NORMAL_PROFILE_VERSION}`
    : binding.previousKey;
  if (enabled) material.needsUpdate = true;
}

function injectTerrainMicroNormals(shader: TerrainShaderSource): void {
  if (shader.fragmentShader.includes("terrain-micro-normal-v1")) return;
  const normalMarkers = shader.fragmentShader.split(TERRAIN_NORMAL_MARKER).length - 1;
  if (normalMarkers !== 1) {
    throw new Error(`terrain micro-normal expected one normal marker, found ${normalMarkers}`);
  }
  const splatColours = shader.fragmentShader.split("vec3 splatColour =").length - 1;
  if (splatColours !== 1) {
    throw new Error(`terrain micro-normal expected one splat colour, found ${splatColours}`);
  }
  shader.fragmentShader = shader.fragmentShader.replace(TERRAIN_NORMAL_MARKER, `${TERRAIN_NORMAL_MARKER}
      /* terrain-micro-normal-v1 */
      float terrainMicroHeight = dot(splatColour, vec3(0.2126, 0.7152, 0.0722));
      vec2 terrainMicroGradient = vec2(
        dFdx(terrainMicroHeight),
        dFdy(terrainMicroHeight)
      );
      // Layer indices may change abruptly at an authored chunk edge. Suppress only an implausibly
      // large derivative there. Any UV-edge mask — periodic or once per tile — makes its own
      // straight zero-normal strip visible even where the blended colour itself is continuous.
      // Fragment derivatives still have helper invocations at a primitive edge; the texture's
      // clamp/repeat policy and this outlier gate are the conservative boundary handling.
      float terrainMicroGradientLength = length(terrainMicroGradient);
      float terrainMicroOutlierFade = 1.0 - smoothstep(0.16, 0.42, terrainMicroGradientLength);
      float terrainDistanceFade = 1.0 - smoothstep(50.0, 125.0, length(vViewPosition));
      terrainMicroGradient *= 0.08 * terrainMicroOutlierFade * terrainDistanceFade;

      // These vectors and the normal are all view-space. This is the bounded form of Three's own
      // derivative bump basis, fed by the already blended albedo instead of another texture.
      vec3 terrainSigmaXRaw = dFdx(-vViewPosition);
      vec3 terrainSigmaYRaw = dFdy(-vViewPosition);
      vec3 terrainSigmaX = terrainSigmaXRaw
        * inversesqrt(max(dot(terrainSigmaXRaw, terrainSigmaXRaw), 1e-8));
      vec3 terrainSigmaY = terrainSigmaYRaw
        * inversesqrt(max(dot(terrainSigmaYRaw, terrainSigmaYRaw), 1e-8));
      vec3 terrainR1 = cross(terrainSigmaY, normal);
      vec3 terrainR2 = cross(normal, terrainSigmaX);
      float terrainDet = dot(terrainSigmaX, terrainR1) * faceDirection;
      vec3 terrainSurfaceGradient = sign(terrainDet)
        * (terrainMicroGradient.x * terrainR1 + terrainMicroGradient.y * terrainR2);
      normal = normalize(max(abs(terrainDet), 1e-4) * normal - terrainSurfaceGradient);
  `);
}
