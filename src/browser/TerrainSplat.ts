import * as THREE from "three";
import type { TerrainGrid } from "./Terrain.js";
import type { RetainedResourceVisitor } from "./ResourceAccounting.js";
import { withGeneration } from "./GatewayGeneration.js";

/** Ground textures are republished at this size so one array can hold all of a tile's layers. */
const LAYER_SIZE = 256;
const MAX_LAYERS = 32;
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

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
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
      failed,
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
      const response = await fetch(withGeneration(base));
      // 7.23: 404 is the gateway saying this tile has nothing to paint (a stub under a dungeon, a
      // map with no ADT) — final and not an error, so it is remembered like one but not reported.
      if (response.status === 404) {
        if (this.#isCurrent(request)) this.#tiles.set(request.key, null);
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
      for (const id of new Set(layers)) request.layers.set(id, this.#acquireLayer(id));
      const results = await Promise.allSettled([
        Promise.all(layers.map((id) => request.layers.get(id)!.promise)),
        this.#loadTexture(request, withGeneration(`${base}/alpha.png`)),
        this.#loadTexture(request, withGeneration(`${base}/index.png`)),
        painted ? this.#loadTexture(request, withGeneration(`${base}/mccv.png`)) : Promise.resolve(undefined),
      ]);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
      if (!this.#isCurrent(request)) return;
      const pixels = (results[0] as PromiseFulfilledResult<Uint8ClampedArray[]>).value;
      const alpha = (results[1] as PromiseFulfilledResult<THREE.Texture>).value;
      const index = (results[2] as PromiseFulfilledResult<THREE.Texture>).value;
      const colours = (results[3] as PromiseFulfilledResult<THREE.Texture | undefined>).value;

      const data = new Uint8Array(LAYER_SIZE * LAYER_SIZE * 4 * layers.length);
      for (let layer = 0; layer < pixels.length; layer++) data.set(pixels[layer]!, layer * LAYER_SIZE * LAYER_SIZE * 4);
      const array = new THREE.DataArrayTexture(data, LAYER_SIZE, LAYER_SIZE, layers.length);
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
      const splat: TerrainSplat = { layers: array, alpha, index, ...(colours ? { colours } : {}) };
      const tile: TerrainSplatTileRecord = {
        splat,
        layers: new Map(request.layers),
        textures: new Set(request.textures),
      };
      request.layers.clear();
      request.textures.clear();
      this.#tiles.set(request.key, tile);
      installed = true;
      this.#reportStatus(`Terrain splat: ${[...this.#tiles.values()].filter(Boolean).length} тайлов`, false);
    } catch (error) {
      if (this.#isCurrent(request)) {
        this.#tiles.set(request.key, null);
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

  #acquireLayer(id: string): LayerRecord {
    let layer = this.#layers.get(id);
    if (!layer) {
      const promise = decodeImagePixels(withGeneration(`${this.#baseUrl}/terrain-layer/${id}.png`), LAYER_SIZE);
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
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.splatLayers = { value: splat.layers };
    shader.uniforms.splatAlpha = { value: splat.alpha };
    shader.uniforms.splatIndex = { value: splat.index };
    shader.uniforms.splatRepeat = { value: SPLAT_REPEAT };
    if (splat.colours) shader.uniforms.splatColours = { value: splat.colours };
    shader.vertexShader = `varying vec2 vSplatUv;\n${shader.vertexShader}`
      .replace("#include <begin_vertex>", "vSplatUv = uv;\n#include <begin_vertex>");
    shader.fragmentShader = `
      precision highp sampler2DArray;
      uniform sampler2DArray splatLayers;
      uniform sampler2D splatAlpha;
      uniform sampler2D splatIndex;
      uniform float splatRepeat;
      varying vec2 vSplatUv;
      ${painted ? "uniform sampler2D splatColours;" : ""}

      vec3 splatLayer(float slot, vec2 detail, vec3 fallback) {
        return slot < 0.0 ? fallback : texture(splatLayers, vec3(detail, slot)).rgb;
      }
    ${shader.fragmentShader}`.replace("#include <map_fragment>", `
      vec4 splatSlots = texture2D(splatIndex, vSplatUv) * 255.0 - 1.0;
      vec3 splatBlend = texture2D(splatAlpha, vSplatUv).rgb;
      vec2 splatDetail = vSplatUv * splatRepeat;
      vec3 splatColour = splatLayer(splatSlots.r, splatDetail, vec3(0.30, 0.38, 0.26));
      if (splatSlots.g >= 0.0) splatColour = mix(splatColour, texture(splatLayers, vec3(splatDetail, splatSlots.g)).rgb, splatBlend.r);
      if (splatSlots.b >= 0.0) splatColour = mix(splatColour, texture(splatLayers, vec3(splatDetail, splatSlots.b)).rgb, splatBlend.g);
      if (splatSlots.a >= 0.0) splatColour = mix(splatColour, texture(splatLayers, vec3(splatDetail, splatSlots.a)).rgb, splatBlend.b);
      diffuseColor.rgb *= splatColour;
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
  };
  // Without this every terrain material would share one compiled program and its uniforms.
  // Two programs, not one: a tile with painted ground compiles a different shader from one
  // without, and sharing the key would hand the second the first's missing sampler.
  const splatKey = painted ? "terrain-splat-mccv" : "terrain-splat";
  material.customProgramCacheKey = () => `${previousKey}|${splatKey}`;
  material.color.setHex(0xffffff);
  material.needsUpdate = true;
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
