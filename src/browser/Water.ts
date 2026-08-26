// Water, ocean, magma and slime: which is which, what they are drawn with, and how deep they are.
//
// The surface used to be one translucent blue slab whatever the liquid was, with a hard line where
// it met the shore. The class is already in the data — the TrinityCore map file records it per
// cell as the same four-way flag the client's own `LiquidType.SoundBank` uses — and the client
// ships each one as thirty animation frames, which the gateway publishes as a single strip.

import * as THREE from "three";
import type { LightSample } from "./LightTypes.js";

/**
 * The liquid classes, in the order the map file's flag byte numbers them.
 *
 * `MAP_LIQUID_TYPE_WATER` 0x01, `OCEAN` 0x02, `MAGMA` 0x04, `SLIME` 0x08 and `DARK_WATER` 0x10.
 * Dark water is water that drains the swimmer, not a different surface, so it draws as water.
 */
export const LIQUID_CLASSES = ["water", "ocean", "magma", "slime"] as const;
export type LiquidClass = (typeof LIQUID_CLASSES)[number];

const FLAG_OCEAN = 0x02;
const FLAG_MAGMA = 0x04;
const FLAG_SLIME = 0x08;

/**
 * Which surface a cell is drawn with: its `LiquidType.dbc` row when the table has arrived, and the
 * map file's four-way flag when it has not.
 *
 * The two disagree on one row in this dataset and it is a visible one — 181 "Orange Slime" is
 * sound bank 0, so the flag calls it water, while its texture is `XTEXTURES\LavaOrange`. It sits
 * on 49 chunks of Northrend that were being drawn as a blue river. The flag stays as the fallback
 * because it is always present, and because 1,561 of the 3,196 tiles with liquid carry only a
 * tile-wide id anyway.
 */
export function liquidClassOf(flags: number, entry = 0, classes?: ReadonlyMap<number, LiquidClass>): LiquidClass {
  const named = entry > 0 ? classes?.get(entry) : undefined;
  if (named) return named;
  if (flags & FLAG_MAGMA) return "magma";
  if (flags & FLAG_SLIME) return "slime";
  if (flags & FLAG_OCEAN) return "ocean";
  return "water";
}

/** One repeat of the surface texture per liquid cell, which is the grid the heights are on. */
export const LIQUID_CELL_YARDS = 533.3333333333334 / 128;
/** How fast the thirty frames are walked. A one-second loop, which is what the client looks like. */
export const LIQUID_FRAMES_PER_SECOND = 30;
/**
 * How far down the surface reaches its deep opacity.
 *
 * The two opacities come from `LightParams` and vary by zone; the depth over which they cross does
 * not appear in any table, so this is a look. Three yards puts the fade in the shallows where the
 * bottom is still visible, which is where the client's shoreline sits.
 */
const DEEP_AT_YARDS = 3;

export interface LiquidStrip {
  texture: THREE.Texture;
  frames: number;
}

/** Downloads one liquid's animation strip, and answers with it once it has arrived. */
export class LiquidTextureClient {
  onStatus: ((message: string, error: boolean) => void) | undefined;
  readonly #baseUrl: string;
  readonly #strips = new Map<LiquidClass, LiquidStrip | null>();
  readonly #loading = new Set<LiquidClass>();
  #classes: Map<number, LiquidClass> | undefined;
  #loadingClasses = false;
  #generation = 0;

  /**
   * Bumped whenever a strip lands.
   *
   * A surface built before its strip arrived is drawing with the stand-in sheet, and nothing else
   * about that tile has changed to make it rebuild, so the number it was built at is what tells it
   * to try again.
   */
  get generation(): number {
    return this.#generation;
  }

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  /**
   * `LiquidType.dbc` row to surface, once the table has landed. Asked for once per session: it is
   * twenty-six rows, and a tile built before it arrives is rebuilt when the strip it wanted lands.
   */
  get classes(): ReadonlyMap<number, LiquidClass> | undefined {
    if (!this.#classes && !this.#loadingClasses) {
      this.#loadingClasses = true;
      void this.#loadClasses();
    }
    return this.#classes;
  }

  async #loadClasses(): Promise<void> {
    try {
      const response = await fetch(`${this.#baseUrl}/dbc/liquid-types`);
      if (!response.ok) throw new Error(`Liquid type gateway returned ${response.status}`);
      const value = await response.json() as Record<string, string>;
      const classes = new Map<number, LiquidClass>();
      for (const [id, named] of Object.entries(value)) {
        if ((LIQUID_CLASSES as readonly string[]).includes(named)) classes.set(Number(id), named as LiquidClass);
      }
      this.#classes = classes;
      // The same counter the strips bump: a tile drawn before the table arrived is classing its
      // cells by the flag, and this is what sends it back to do it again.
      this.#generation++;
    } catch (error) {
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
      this.#loadingClasses = false;
    }
  }

  get(liquidClass: LiquidClass): LiquidStrip | undefined {
    const strip = this.#strips.get(liquidClass);
    if (strip) return strip;
    if (strip === undefined && !this.#loading.has(liquidClass)) {
      this.#loading.add(liquidClass);
      void this.#load(liquidClass);
    }
    return undefined;
  }

  async #load(liquidClass: LiquidClass): Promise<void> {
    try {
      const response = await fetch(`${this.#baseUrl}/liquid/${liquidClass}`);
      if (!response.ok) throw new Error(`Liquid gateway returned ${response.status}`);
      const value = await response.json() as { frames?: unknown };
      const frames = value.frames;
      if (typeof frames !== "number" || !Number.isInteger(frames) || frames < 1 || frames > 128) {
        throw new Error("Liquid gateway returned an invalid frame count");
      }
      const texture = await new Promise<THREE.Texture>((resolve, reject) => {
        new THREE.TextureLoader().load(`${this.#baseUrl}/liquid/${liquidClass}.png`, resolve, undefined,
          () => reject(new Error(`Failed to load the ${liquidClass} strip`)));
      });
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      // Never vertically: the strip's rows are frames, and wrapping one into the next would run
      // the top of one frame into the bottom of the one before it.
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;
      this.#strips.set(liquidClass, { texture, frames });
      this.#generation++;
      this.onStatus?.(`Жидкости: ${[...this.#strips.values()].filter(Boolean).length}`, false);
    } catch (error) {
      this.#strips.set(liquidClass, null);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.#loading.delete(liquidClass);
    }
  }
}

export interface LiquidMaterialUniforms {
  liquidFrame: { value: number };
  liquidFrames: { value: number };
  liquidShallowAlpha: { value: number };
  liquidDeepAlpha: { value: number };
  liquidDeepAt: { value: number };
  liquidShallowColour: { value: THREE.Color };
  liquidDeepColour: { value: THREE.Color };
}

export interface LiquidMaterial {
  material: THREE.MeshBasicMaterial;
  uniforms: LiquidMaterialUniforms;
}

/**
 * The surface material for one liquid class.
 *
 * A `MeshBasicMaterial` rather than a shader of its own, so three.js keeps supplying the fog, the
 * tone mapping and the colour space; only two things are injected. The map's V is folded into one
 * row of the strip, which is what makes the surface animate, and the alpha comes from the depth
 * the geometry carries per vertex rather than being one number for the whole sheet.
 *
 * Magma and slime are not translucent and are not lit: lava does not take the sky's colour, it
 * gives its own.
 */
export function buildLiquidMaterial(liquidClass: LiquidClass, strip: LiquidStrip): LiquidMaterial {
  const glowing = liquidClass === "magma" || liquidClass === "slime";
  const uniforms: LiquidMaterialUniforms = {
    liquidFrame: { value: 0 },
    liquidFrames: { value: strip.frames },
    liquidShallowAlpha: { value: glowing ? 1 : 0.5 },
    liquidDeepAlpha: { value: 1 },
    liquidDeepAt: { value: DEEP_AT_YARDS },
    // Stand-ins until a light sample arrives; magma and slime keep them, being their own colour.
    liquidShallowColour: { value: new THREE.Color(glowing ? 0xffffff : 0x3b5c67) },
    liquidDeepColour: { value: new THREE.Color(glowing ? 0xffffff : 0x001d29) },
  };
  const material = new THREE.MeshBasicMaterial({
    map: strip.texture,
    transparent: !glowing,
    depthWrite: glowing,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = `
      attribute float liquidDepth;
      varying float vLiquidDepth;
      ${shader.vertexShader}`.replace("#include <begin_vertex>", `
      vLiquidDepth = liquidDepth;
      #include <begin_vertex>`);
    shader.fragmentShader = `
      uniform float liquidFrame;
      uniform float liquidFrames;
      uniform float liquidShallowAlpha;
      uniform float liquidDeepAlpha;
      uniform float liquidDeepAt;
      uniform vec3 liquidShallowColour;
      uniform vec3 liquidDeepColour;
      varying float vLiquidDepth;
      ${shader.fragmentShader}`.replace("#include <map_fragment>", `
      // The strip is one frame above the next, so the surface's own V is squeezed into the row
      // this frame occupies. Kept a texel inside it, or the filter reaches into its neighbour.
      float liquidRow = clamp(fract(vMapUv.y), 0.002, 0.998);
      vec2 liquidUv = vec2(vMapUv.x, (liquidFrame + liquidRow) / liquidFrames);
      vec4 sampledDiffuseColor = texture2D(map, liquidUv);
      float liquidDepthMix = clamp(vLiquidDepth / liquidDeepAt, 0.0, 1.0);
      // Colour from the water bands, the texture's own value only as the ripple on top of it, and
      // its alpha as where the surface catches the light.
      vec3 liquidBody = mix(liquidShallowColour, liquidDeepColour, liquidDepthMix);
      diffuseColor.rgb *= liquidBody + sampledDiffuseColor.rgb;
      diffuseColor.a *= mix(liquidShallowAlpha, liquidDeepAlpha, liquidDepthMix)
        * mix(0.55, 1.0, sampledDiffuseColor.a);
    `);
  };
  material.customProgramCacheKey = () => `liquid-${liquidClass}`;
  return { material, uniforms };
}

/** Points a liquid material at the frame this moment falls on, and at the zone's own water. */
export function updateLiquidMaterial(liquid: LiquidMaterial, liquidClass: LiquidClass,
  sample: LightSample | undefined, seconds: number): void {
  liquid.uniforms.liquidFrame.value =
    Math.floor(seconds * LIQUID_FRAMES_PER_SECOND) % liquid.uniforms.liquidFrames.value;
  if (!sample || liquidClass === "magma" || liquidClass === "slime") return;
  const ocean = liquidClass === "ocean";
  liquid.uniforms.liquidShallowAlpha.value = ocean ? sample.oceanShallowAlpha : sample.waterShallowAlpha;
  liquid.uniforms.liquidDeepAlpha.value = ocean ? sample.oceanDeepAlpha : sample.waterDeepAlpha;
  // The surface texture is black — mean rgb 4,4,4, with every bit of its detail in the alpha — so
  // all of the colour comes from here. The file keeps a close and a far colour for each of ocean
  // and river; the shallows take the close one and the depths the far one, over the same ramp the
  // opacity uses.
  const close = ocean ? sample.colours.oceanClose : sample.colours.riverClose;
  const far = ocean ? sample.colours.oceanFar : sample.colours.riverFar;
  liquid.uniforms.liquidShallowColour.value.setRGB(close.r, close.g, close.b, THREE.SRGBColorSpace);
  liquid.uniforms.liquidDeepColour.value.setRGB(far.r, far.g, far.b, THREE.SRGBColorSpace);
}
