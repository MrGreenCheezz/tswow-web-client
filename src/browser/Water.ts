// Water, ocean, magma and slime: which is which, what they are drawn with, and how deep they are.
//
// The surface used to be one translucent blue slab whatever the liquid was, with a hard line where
// it met the shore. The class is already in the data — the TrinityCore map file records it per
// cell as the same four-way flag the client's own `LiquidType.SoundBank` uses — and the client
// ships each one as thirty animation frames, which the gateway publishes as a single strip.

import * as THREE from "three";
import type { LightSample } from "./LightTypes.js";
import type { RetainedResourceVisitor } from "./ResourceAccounting.js";
import type { BenchmarkAsyncReadinessStats } from "./RenderBenchmarkReadiness.js";

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
  readonly #stripFailures = new Map<LiquidClass, { attempts: number; after: number }>();
  /** Texture ownership is exact even if a non-standard loader hands the same object to two paths. */
  readonly #disposedTextures = new WeakSet<THREE.Texture>();
  /** Handles returned by TextureLoader remain owned until their callback settles or the session ends. */
  readonly #pendingTextureHandles = new Set<THREE.Texture>();
  #classes: Map<number, LiquidClass> | undefined;
  #loadingClasses = false;
  #classFailure: { attempts: number; after: number } | undefined;
  /** Invalidates callbacks captured by the world session being torn down. */
  #epoch = 0;
  #disposed = false;
  #generation = 0;
  #success = 0;
  #error = 0;
  readonly #now: () => number;

  /** Immutable exact request counters; settled class/strip caches are not active work. */
  get stats(): Readonly<BenchmarkAsyncReadinessStats> {
    return Object.freeze({
      pending: this.#loading.size
        + (this.#loadingClasses ? 1 : 0)
        + [...this.#stripFailures.entries()].filter(([liquidClass, failure]) =>
          failure.after !== Infinity && !this.#loading.has(liquidClass)).length
        + (this.#classFailure !== undefined && this.#classFailure.after !== Infinity && !this.#loadingClasses ? 1 : 0),
      success: this.#success,
      error: [...this.#stripFailures.values()].filter((failure) => failure.after === Infinity).length
        + (this.#classFailure?.after === Infinity ? 1 : 0),
      generation: this.#generation,
    });
  }

  get revision(): number {
    return this.#generation;
  }

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

  constructor(gatewayWebSocketUrl: string, now: () => number = Date.now) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
    this.#now = now;
  }

  /** Releases retained strip textures and makes every later public operation inert. Safe to repeat. */
  dispose(): void {
    if (this.#disposed) return;
    this.#epoch++;
    this.#disposed = true;
    for (const strip of this.#strips.values()) {
      if (strip) this.#disposeTexture(strip.texture);
    }
    for (const texture of this.#pendingTextureHandles) this.#disposeTexture(texture);
    this.#pendingTextureHandles.clear();
    this.#strips.clear();
    this.#loading.clear();
    this.#stripFailures.clear();
    this.#classes = undefined;
    this.#loadingClasses = false;
    this.#classFailure = undefined;
    this.onStatus = undefined;
  }

  #isCurrent(epoch: number): boolean {
    return !this.#disposed && epoch === this.#epoch;
  }

  #disposeTexture(texture: THREE.Texture): void {
    if (this.#disposedTextures.has(texture)) return;
    this.#disposedTextures.add(texture);
    try { texture.dispose(); } catch { /* best-effort release must continue through every strip */ }
  }

  #releasePendingTexture(texture: THREE.Texture | undefined): void {
    if (texture) this.#pendingTextureHandles.delete(texture);
  }

  /** Adds every successfully cached liquid strip; failed entries retain no texture. */
  visitRetainedResources(visitor: RetainedResourceVisitor): void {
    for (const strip of this.#strips.values()) {
      if (strip) visitor.referenceGpuTexture(this, strip.texture);
    }
  }

  /**
   * `LiquidType.dbc` row to surface, once the table has landed. Asked for once per session: it is
   * twenty-six rows, and a tile built before it arrives is rebuilt when the strip it wanted lands.
   */
  get classes(): ReadonlyMap<number, LiquidClass> | undefined {
    if (this.#disposed) return undefined;
    if (!this.#classes && !this.#loadingClasses
      && (this.#classFailure === undefined || this.#classFailure.after <= this.#now())) {
      this.#loadingClasses = true;
      void this.#loadClasses();
    }
    return this.#classes;
  }

  async #loadClasses(): Promise<void> {
    const epoch = this.#epoch;
    let settled = false;
    const settle = (success: boolean): void => {
      if (settled) return;
      settled = true;
      if (!this.#isCurrent(epoch)) return;
      this.#loadingClasses = false;
      this.#generation++;
      if (success) this.#success++;
      else this.#error++;
    };
    try {
      const response = await fetch(`${this.#baseUrl}/dbc/liquid-types`);
      if (!response.ok) throw new Error(`Liquid type gateway returned ${response.status}`);
      const value = await response.json() as Record<string, string>;
      const classes = new Map<number, LiquidClass>();
      for (const [id, named] of Object.entries(value)) {
        if ((LIQUID_CLASSES as readonly string[]).includes(named)) classes.set(Number(id), named as LiquidClass);
      }
      if (!this.#isCurrent(epoch)) return;
      this.#classes = classes;
      this.#classFailure = undefined;
      // The same counter the strips bump: a tile drawn before the table arrived is classing its
      // cells by the flag, and this is what sends it back to do it again.
      settle(true);
    } catch (error) {
      if (!this.#isCurrent(epoch)) return;
      const attempts = (this.#classFailure?.attempts ?? 0) + 1;
      const wait = WATER_RETRY_BACKOFF_MS[attempts - 1];
      this.#classFailure = {
        attempts,
        after: wait === undefined ? Infinity : this.#now() + wait,
      };
      settle(false);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      settle(false);
    }
  }

  get(liquidClass: LiquidClass): LiquidStrip | undefined {
    if (this.#disposed) return undefined;
    const strip = this.#strips.get(liquidClass);
    if (strip) return strip;
    const failure = this.#stripFailures.get(liquidClass);
    if ((strip === undefined || strip === null && failure !== undefined && failure.after <= this.#now())
      && !this.#loading.has(liquidClass)
      && (failure === undefined || failure.after <= this.#now())) {
      this.#loading.add(liquidClass);
      void this.#load(liquidClass);
    }
    return undefined;
  }

  async #load(liquidClass: LiquidClass): Promise<void> {
    const epoch = this.#epoch;
    let loaderTexture: THREE.Texture | undefined;
    let settled = false;
    const settle = (success: boolean): void => {
      if (settled) return;
      settled = true;
      if (!this.#isCurrent(epoch)) return;
      this.#loading.delete(liquidClass);
      this.#generation++;
      if (success) this.#success++;
      else this.#error++;
    };
    try {
      const response = await fetch(`${this.#baseUrl}/liquid/${liquidClass}`);
      if (!response.ok) throw new Error(`Liquid gateway returned ${response.status}`);
      const value = await response.json() as { frames?: unknown };
      const frames = value.frames;
      if (typeof frames !== "number" || !Number.isInteger(frames) || frames < 1 || frames > 128) {
        throw new Error("Liquid gateway returned an invalid frame count");
      }
      if (!this.#isCurrent(epoch)) return;
      let callbackSettled = false;
      let resolvedTexture: THREE.Texture | undefined;
      const texture = await new Promise<THREE.Texture>((resolve, reject) => {
        loaderTexture = new THREE.TextureLoader().load(`${this.#baseUrl}/liquid/${liquidClass}.png`,
          (loaded) => {
            if (callbackSettled) {
              if (loaded !== resolvedTexture) this.#disposeTexture(loaded);
              return;
            }
            callbackSettled = true;
            resolvedTexture = loaded;
            if (!this.#isCurrent(epoch)) this.#disposeTexture(loaded);
            resolve(loaded);
          }, undefined, () => {
            if (callbackSettled) return;
            callbackSettled = true;
            reject(new Error(`Failed to load the ${liquidClass} strip`));
          });
        if (loaderTexture) {
          if (this.#isCurrent(epoch)) this.#pendingTextureHandles.add(loaderTexture);
          else this.#disposeTexture(loaderTexture);
        }
      });
      if (!this.#isCurrent(epoch)) {
        this.#releasePendingTexture(loaderTexture);
        this.#disposeTexture(texture);
        if (loaderTexture && loaderTexture !== texture) this.#disposeTexture(loaderTexture);
        return;
      }
      // A non-standard loader may resolve a different texture than its returned handle. The
      // callback texture is retained; the handle is still our ownership to release.
      this.#releasePendingTexture(loaderTexture);
      if (loaderTexture && loaderTexture !== resolvedTexture) this.#disposeTexture(loaderTexture);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      // Never vertically: the strip's rows are frames, and wrapping one into the next would run
      // the top of one frame into the bottom of the one before it.
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;
      this.#strips.set(liquidClass, { texture, frames });
      this.#stripFailures.delete(liquidClass);
      settle(true);
      this.onStatus?.(`Жидкости: ${[...this.#strips.values()].filter(Boolean).length}`, false);
    } catch (error) {
      if (!this.#isCurrent(epoch)) {
        this.#releasePendingTexture(loaderTexture);
        if (loaderTexture) this.#disposeTexture(loaderTexture);
        return;
      }
      this.#releasePendingTexture(loaderTexture);
      if (loaderTexture) this.#disposeTexture(loaderTexture);
      this.#strips.set(liquidClass, null);
      const attempts = (this.#stripFailures.get(liquidClass)?.attempts ?? 0) + 1;
      const wait = WATER_RETRY_BACKOFF_MS[attempts - 1];
      this.#stripFailures.set(liquidClass, {
        attempts,
        after: wait === undefined ? Infinity : this.#now() + wait,
      });
      settle(false);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.#releasePendingTexture(loaderTexture);
      settle(false);
    }
  }
}

const WATER_RETRY_BACKOFF_MS: readonly number[] = [2_000, 8_000, 30_000];

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
 * Uniform objects shared by every water/ocean material in one renderer.  The values are mutated in
 * place by the renderer; replacing either the value object or a material's binding would make a
 * compiled program keep the previous frame's lighting.
 */
export interface WaterShaderSharedUniforms {
  readonly time: { value: number };
  readonly sunDirection: { value: THREE.Vector3 };
  readonly sunColour: { value: THREE.Color };
  /** 1 while the camera is underwater, otherwise 0. */
  readonly underwater: { value: number };
}

export interface WaterShaderProfile {
  readonly waterFresnel: boolean;
  readonly waterMicroWaves: boolean;
  readonly waterSunSparkle: boolean;
  readonly fantasyGlow: boolean;
}

export const WATER_SHADER_PROFILE_VERSION = 2;

export const DEFAULT_WATER_SHADER_PROFILE: Readonly<WaterShaderProfile> = Object.freeze({
  waterFresnel: false,
  waterMicroWaves: false,
  waterSunSparkle: false,
  fantasyGlow: false,
});

export function createWaterShaderSharedUniforms(): WaterShaderSharedUniforms {
  return {
    time: { value: 0 },
    sunDirection: { value: new THREE.Vector3(0, 1, 0) },
    sunColour: { value: new THREE.Color(0xffffff) },
    underwater: { value: 0 },
  };
}

type LiquidShaderSource = Parameters<THREE.Material["onBeforeCompile"]>[0];
type LiquidShaderRenderer = Parameters<THREE.Material["onBeforeCompile"]>[1];

interface WaterShaderBinding {
  readonly liquidClass: LiquidClass;
  readonly shared: WaterShaderSharedUniforms;
  readonly previousCompile: (shader: LiquidShaderSource, renderer: LiquidShaderRenderer) => void;
  readonly previousKey: string;
  mask: number;
}

const WATER_SHADER_BINDINGS = new WeakMap<THREE.MeshBasicMaterial, WaterShaderBinding>();

interface LiquidFantasyGlowBinding {
  readonly previousCompile: (shader: LiquidShaderSource, renderer: LiquidShaderRenderer) => void;
  readonly previousKey: string;
  enabled: boolean;
}

const LIQUID_FANTASY_GLOW_BINDINGS = new WeakMap<THREE.MeshBasicMaterial, LiquidFantasyGlowBinding>();

function waterShaderMask(profile: Readonly<Partial<WaterShaderProfile>> | undefined): number {
  return (profile?.waterFresnel === true ? 1 : 0)
    | (profile?.waterMicroWaves === true ? 2 : 0)
    | (profile?.waterSunSparkle === true ? 4 : 0);
}

/**
 * Injects the optional water branch after the existing liquid hook.  The hook and cache-key
 * wrapper are installed once per material, so toggling settings cannot create a chain of wrappers
 * or invoke the existing liquid hook more than once per compile.
 *
 * The zero-mask path deliberately only calls the captured hook and returns.  In particular, it
 * does not prepend a varying, add uniforms, or change the captured cache key.
 */
export function setLiquidWaterShaderProfile(
  material: THREE.MeshBasicMaterial,
  liquidClass: LiquidClass,
  profile: Readonly<Partial<WaterShaderProfile>> | undefined,
  shared: WaterShaderSharedUniforms,
): void {
  if (liquidClass !== "water" && liquidClass !== "ocean") return;
  const mask = waterShaderMask(profile);
  const existing = WATER_SHADER_BINDINGS.get(material);
  if (existing) {
    if (existing.liquidClass !== liquidClass || existing.shared !== shared) {
      throw new Error("Liquid water material was rebound with conflicting class or uniforms");
    }
    if (existing.mask !== mask) {
      existing.mask = mask;
      material.needsUpdate = true;
    }
    return;
  }

  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  const binding: WaterShaderBinding = {
    liquidClass,
    shared,
    previousCompile,
    previousKey,
    mask,
  };
  WATER_SHADER_BINDINGS.set(material, binding);

  material.onBeforeCompile = (shader, renderer) => {
    binding.previousCompile.call(material, shader, renderer);
    if (binding.mask === 0) return;
    injectWaterShader(shader, binding);
  };
  material.customProgramCacheKey = () => binding.mask === 0
    ? binding.previousKey
    : `${binding.previousKey}|water-profile-v${WATER_SHADER_PROFILE_VERSION}-${binding.mask}`;
  if (mask !== 0) material.needsUpdate = true;
}

/** Applies the same binding to an already-built animated liquid material. */
export function applyLiquidShaderProfile(
  liquid: LiquidMaterial,
  liquidClass: LiquidClass,
  profile: Readonly<Partial<WaterShaderProfile>> | undefined,
  shared: WaterShaderSharedUniforms,
): void {
  setLiquidWaterShaderProfile(liquid.material, liquidClass, profile, shared);
  setLiquidFantasyGlowProfile(
    liquid.material,
    liquidClass,
    profile?.fantasyGlow === true,
  );
}

/** Optional magma/slime branch whose disabled source and cache key are byte-identical baseline. */
function setLiquidFantasyGlowProfile(
  material: THREE.MeshBasicMaterial,
  liquidClass: LiquidClass,
  enabled: boolean,
): void {
  if (liquidClass !== "magma" && liquidClass !== "slime") return;
  const existing = LIQUID_FANTASY_GLOW_BINDINGS.get(material);
  if (existing) {
    if (existing.enabled !== enabled) {
      existing.enabled = enabled;
      material.needsUpdate = true;
    }
    return;
  }
  const binding: LiquidFantasyGlowBinding = {
    previousCompile: material.onBeforeCompile,
    previousKey: material.customProgramCacheKey(),
    enabled,
  };
  LIQUID_FANTASY_GLOW_BINDINGS.set(material, binding);
  material.onBeforeCompile = (shader, renderer) => {
    binding.previousCompile.call(material, shader, renderer);
    if (!binding.enabled) return;
    const marker = "#include <opaque_fragment>";
    if (shader.fragmentShader.split(marker).length - 1 !== 1) {
      throw new Error("Liquid fantasy glow expected MeshBasic opaque marker");
    }
    shader.fragmentShader = shader.fragmentShader.replace(marker, `
      /* liquid-fantasy-glow-v1 */
      float liquidFantasyEnergy = smoothstep(0.08, 0.92, diffuseColor.a);
      outgoingLight *= 1.18 + liquidFantasyEnergy * 0.22;
      ${marker}`);
  };
  material.customProgramCacheKey = () => binding.enabled
    ? `${binding.previousKey}|liquid-fantasy-glow-v1`
    : binding.previousKey;
  if (enabled) material.needsUpdate = true;
}

/** Applies the profile to the cold-cache stand-in without sharing water styling with lava. */
export function applyFallbackLiquidShaderProfile(
  material: THREE.MeshBasicMaterial,
  liquidClass: LiquidClass,
  profile: Readonly<Partial<WaterShaderProfile>> | undefined,
  shared: WaterShaderSharedUniforms,
): void {
  if (liquidClass === "water" || liquidClass === "ocean") {
    setLiquidWaterShaderProfile(material, liquidClass, profile, shared);
    return;
  }
  const fantasy = profile?.fantasyGlow === true;
  const wasFantasy = !material.transparent && material.depthWrite;
  material.color.set(fantasy ? (liquidClass === "magma" ? 0xff5b18 : 0x54b85b) : 0x2d7fa5);
  if (fantasy) material.color.multiplyScalar(liquidClass === "magma" ? 1.32 : 1.18);
  material.transparent = !fantasy;
  material.opacity = fantasy ? 1 : 0.58;
  material.depthWrite = fantasy;
  if (wasFantasy !== fantasy) material.needsUpdate = true;
}

function injectWaterShader(shader: LiquidShaderSource, binding: WaterShaderBinding): void {
  const beginVertex = "#include <begin_vertex>";
  const opaqueFragment = "#include <opaque_fragment>";
  if (shader.vertexShader.split(beginVertex).length - 1 !== 1
    || shader.fragmentShader.split(opaqueFragment).length - 1 !== 1) {
    throw new Error("Water shader profile expected MeshBasic begin/opaque markers");
  }

  shader.uniforms.waterTime = binding.shared.time;
  shader.uniforms.waterSunDirection = binding.shared.sunDirection;
  shader.uniforms.waterSunColour = binding.shared.sunColour;
  shader.uniforms.waterUnderwater = binding.shared.underwater;

  // Three's MeshBasic vertex shader does not expose a useful world-position varying.  Keep these
  // values in our own varyings so the fragment branches work for both terrain and WMO liquids.
  if (!shader.vertexShader.includes("vWaterWorldPosition")) {
    shader.vertexShader = `
varying vec3 vWaterWorldPosition;
varying vec3 vWaterWorldNormal;
${shader.vertexShader}`.replace(beginVertex, `
#include <begin_vertex>
  vec4 waterWorldPosition = modelMatrix * vec4(transformed, 1.0);
  vWaterWorldPosition = waterWorldPosition.xyz;
  vWaterWorldNormal = normalize(mat3(modelMatrix) * normal);
`);
  }

  if (shader.fragmentShader.includes("water-profile-v2")) return;
  const effects: string[] = ["/* water-profile-v2 */", `
  vec3 waterBaseNormalRaw = vWaterWorldNormal;
  vec3 waterSurfaceNormal = waterBaseNormalRaw
    * inversesqrt(max(dot(waterBaseNormalRaw, waterBaseNormalRaw), 1e-8));
`];
  if ((binding.mask & 5) !== 0) {
    effects.push("  vec3 waterSunColourLinear = pow(max(waterSunColour, vec3(0.0)), vec3(2.2));\n");
  }
  if ((binding.mask & 2) !== 0) {
    effects.push(`
  float waterWavePhaseA = dot(vWaterWorldPosition.xz, vec2(0.071, 0.113)) + waterTime * 1.7;
  float waterWavePhaseB = dot(vWaterWorldPosition.xz, vec2(-0.137, 0.053)) - waterTime * 1.1;
  float waterWave = sin(waterWavePhaseA) + 0.5 * sin(waterWavePhaseB);
  vec2 waterWaveSlope = cos(waterWavePhaseA) * vec2(0.071, 0.113)
    + 0.5 * cos(waterWavePhaseB) * vec2(-0.137, 0.053);
  vec3 waterWaveNormalRaw = waterSurfaceNormal
    + vec3(-waterWaveSlope.x * 0.65, 0.0, -waterWaveSlope.y * 0.65);
  waterSurfaceNormal = waterWaveNormalRaw
    * inversesqrt(max(dot(waterWaveNormalRaw, waterWaveNormalRaw), 1e-8));
  outgoingLight *= 1.0 + waterWave * 0.03;
`);
  }
  if ((binding.mask & 1) !== 0) {
    effects.push(`
  vec3 waterToCameraRaw = cameraPosition - vWaterWorldPosition;
  vec3 waterToCamera = waterToCameraRaw * inversesqrt(max(dot(waterToCameraRaw, waterToCameraRaw), 1e-8));
  float waterFacing = clamp(abs(dot(waterSurfaceNormal, waterToCamera)), 0.0, 1.0);
  float waterFresnel = pow(1.0 - waterFacing, 3.0);
  float waterFresnelVisibility = 1.0 - clamp(waterUnderwater, 0.0, 1.0);
  outgoingLight = mix(
    outgoingLight,
    outgoingLight + waterSunColourLinear * 0.28,
    waterFresnel * 0.65 * waterFresnelVisibility);
`);
  }
  if ((binding.mask & 4) !== 0) {
    effects.push(`
  if (waterUnderwater < 0.5) {
    vec2 waterSparkPhase = vWaterWorldPosition.xz * vec2(0.19, -0.23) + waterTime * vec2(0.7, -0.45);
    vec3 waterSparkleNormalRaw = waterSurfaceNormal + vec3(
      0.08 * sin(waterSparkPhase.x),
      0.0,
      0.08 * sin(waterSparkPhase.x + waterSparkPhase.y));
    vec3 waterSparkleNormal = waterSparkleNormalRaw
      * inversesqrt(max(dot(waterSparkleNormalRaw, waterSparkleNormalRaw), 1e-8));
    vec3 waterSparkleViewRaw = cameraPosition - vWaterWorldPosition;
    vec3 waterSparkleView = waterSparkleViewRaw
      * inversesqrt(max(dot(waterSparkleViewRaw, waterSparkleViewRaw), 1e-8));
    vec3 waterSunDirectionRaw = waterSunDirection;
    vec3 waterSunDirectionSafe = waterSunDirectionRaw
      * inversesqrt(max(dot(waterSunDirectionRaw, waterSunDirectionRaw), 1e-8));
    vec3 waterReflection = reflect(-waterSunDirectionSafe, waterSparkleNormal);
    float waterSun = max(dot(waterReflection, waterSparkleView), 0.0);
    float waterSpark = smoothstep(0.35, 0.95, waterSun);
    waterSpark *= waterSpark * waterSpark;
    outgoingLight += waterSunColourLinear * waterSpark * 0.24;
  }
`);
  }
  shader.fragmentShader = `
uniform float waterTime;
uniform vec3 waterSunDirection;
uniform vec3 waterSunColour;
uniform float waterUnderwater;
varying vec3 vWaterWorldPosition;
varying vec3 vWaterWorldNormal;
${shader.fragmentShader}`.replace(opaqueFragment, `${effects.join("")}\n${opaqueFragment}`);
}

/**
 * The surface material for one liquid class.
 *
 * A `MeshBasicMaterial` rather than a shader of its own, so three.js keeps supplying the fog, the
 * tone mapping and the colour space; the base liquid hook injects only the strip/depth inputs, and
 * the optional water profile is a separate post-hook. The map's V is folded into one row of the
 * strip, which is what makes the surface animate, and the alpha comes from the depth the geometry
 * carries per vertex rather than being one number for the whole sheet.
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
