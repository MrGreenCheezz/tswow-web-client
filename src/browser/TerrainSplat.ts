import * as THREE from "three";
import type { TerrainGrid } from "./Terrain.js";

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

/**
 * The ingredients the terrain shader blends per tile: every ground texture the tile uses stacked
 * into one array, the alpha maps that fade between them, and the per-chunk list naming which four
 * of the array's layers a chunk draws with.
 */
export class TerrainSplatClient {
  onStatus: ((message: string, error: boolean) => void) | undefined;
  readonly #baseUrl: string;
  readonly #tiles = new Map<string, TerrainSplat | null>();
  readonly #loading = new Set<string>();
  /** Neighbouring tiles share ground textures, so each one is only decoded once. */
  readonly #layerCache = new Map<string, Promise<Uint8ClampedArray>>();

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  /** Returns the tile's splat once it has loaded, and starts the download the first time. */
  get(map: number, grid: TerrainGrid): TerrainSplat | undefined {
    const key = `${map}/${grid.x}/${grid.y}`;
    const tile = this.#tiles.get(key);
    if (tile) return tile;
    if (tile === undefined && !this.#loading.has(key)) {
      this.#loading.add(key);
      void this.#load(map, grid, key);
    }
    return undefined;
  }

  async #load(map: number, grid: TerrainGrid, key: string): Promise<void> {
    try {
      const base = `${this.#baseUrl}/terrain-splat/${map}/${grid.x}/${grid.y}`;
      const response = await fetch(base);
      if (!response.ok) throw new Error(`Terrain splat gateway returned ${response.status}`);
      const value: unknown = await response.json();
      const layers = (value as { layers?: unknown }).layers;
      if (!Array.isArray(layers) || layers.length === 0 || layers.length > MAX_LAYERS
        || !layers.every((id) => typeof id === "string" && /^[0-9a-f]{40}$/.test(id))) {
        throw new Error("Terrain splat gateway returned an invalid layer list");
      }

      const painted = (value as { mccv?: unknown }).mccv === true;
      const [pixels, alpha, index, colours] = await Promise.all([
        Promise.all(layers.map((id: string) => this.#layerPixels(id))),
        loadTexture(`${base}/alpha.png`),
        loadTexture(`${base}/index.png`),
        painted ? loadTexture(`${base}/mccv.png`) : Promise.resolve(undefined),
      ]);

      const data = new Uint8Array(LAYER_SIZE * LAYER_SIZE * 4 * layers.length);
      for (let layer = 0; layer < pixels.length; layer++) data.set(pixels[layer]!, layer * LAYER_SIZE * LAYER_SIZE * 4);
      const array = new THREE.DataArrayTexture(data, LAYER_SIZE, LAYER_SIZE, layers.length);
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

      this.#tiles.set(key, { layers: array, alpha, index, ...(colours ? { colours } : {}) });
      this.onStatus?.(`Terrain splat: ${[...this.#tiles.values()].filter(Boolean).length} тайлов`, false);
    } catch (error) {
      this.#tiles.set(key, null);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.#loading.delete(key);
    }
  }

  #layerPixels(id: string): Promise<Uint8ClampedArray> {
    let pixels = this.#layerCache.get(id);
    if (!pixels) {
      pixels = decodeImagePixels(`${this.#baseUrl}/terrain-layer/${id}.png`, LAYER_SIZE);
      this.#layerCache.set(id, pixels);
    }
    return pixels;
  }
}

function loadTexture(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, resolve, undefined, () => reject(new Error(`Failed to load ${url}`)));
  });
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
