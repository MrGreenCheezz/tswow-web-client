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

// ---- 05.10-A7b-8 (7.09 slice A): surfaces -------------------------------------------------------
// Which animation strip a `LiquidType` row is drawn with.
//
// The four class strips (`/liquid/water` …) are the family of the lowest-numbered row of each sound
// bank: `lake_a`, `ocean_h`, `lava`, `slime`. Three rows of this client name another family and were
// drawn with their class's strip: 9 "Fast Water" (`fast_a`, 16 frames), 15 "Green Lava" (`lavagreen`)
// and 181 "Orange Slime" (`LavaOrange`). A "surface" is the class when the row's family is its
// class's own strip, and `class|family` otherwise; the shading (profile, colours, overlay) always
// follows the class, only the strip follows the family. Without the v2 table (a gateway older than
// R1) every surface is a class, which is exactly the look before this slice.
//
// Kept in this file, not a sibling module: tests import `src/browser/Water.ts` directly, where a
// runtime import of `./X.js` does not resolve.

export type LiquidSurface = LiquidClass | `${LiquidClass}|${string}`;

/** The class order the map flag and `SoundBank` share: 0 water, 1 ocean, 2 magma, 3 slime. */
const CLASSES: readonly LiquidClass[] = LIQUID_CLASSES;

/** A strip family is a lower-cased archive file name; the gateway route accepts nothing else. */
export const LIQUID_FAMILY_SLUG = /^[a-z0-9_]{1,32}$/;

/** The part of `/dbc/liquid-types?v=2` a surface is decided from. */
export interface LiquidSurfaceRow {
  soundBank: number;
  family: string;
  textures: readonly string[];
}

/** The class a surface is shaded as. No allocation: called per material per frame. */
export function liquidSurfaceClass(surface: LiquidSurface): LiquidClass {
  for (const liquidClass of CLASSES) {
    if (surface === liquidClass) return liquidClass;
    if (surface.startsWith(liquidClass) && surface.charCodeAt(liquidClass.length) === 124) return liquidClass;
  }
  return "water";
}

/** The strip family a surface names, or `undefined` for a class surface (its class strip). */
export function liquidSurfaceFamily(surface: LiquidSurface): string | undefined {
  const bar = surface.indexOf("|");
  return bar < 0 ? undefined : surface.slice(bar + 1);
}

/** Whether a row names an animated family (`….%d.blp`), the only kind a strip is built from. */
function animated(row: LiquidSurfaceRow): boolean {
  return (row.textures[0] ?? "").includes("%d") && LIQUID_FAMILY_SLUG.test(row.family);
}

/**
 * Row id → surface, out of the v2 table. The class strip's family is decided exactly as the strip
 * generator decides it (`liquidTexturePattern`: the lowest id of the bank with an animated
 * texture), so a row whose family is that one keeps sharing the class strip — no second download
 * and no second texture for the same frames.
 */
export function buildLiquidSurfaces(
  classes: ReadonlyMap<number, LiquidClass>,
  rows: Readonly<Record<string, LiquidSurfaceRow>>,
): Map<number, LiquidSurface> {
  const classFamily = new Map<LiquidClass, { id: number; family: string }>();
  for (const [key, row] of Object.entries(rows)) {
    const id = Number(key);
    const bankClass = CLASSES[row.soundBank];
    if (!bankClass || !animated(row)) continue;
    const best = classFamily.get(bankClass);
    if (!best || id < best.id) classFamily.set(bankClass, { id, family: row.family });
  }
  const surfaces = new Map<number, LiquidSurface>();
  for (const [id, liquidClass] of classes) {
    const row = rows[String(id)];
    const own = classFamily.get(liquidClass)?.family;
    surfaces.set(id, row && animated(row) && own !== undefined && row.family !== own
      ? `${liquidClass}|${row.family}`
      : liquidClass);
  }
  return surfaces;
}

/**
 * What `/dbc/liquid-types` answered: the v2 body (`{ version: 2, classes, rows }`) or the v1 record
 * of classes an older gateway sends whatever the query says.
 */
export function parseLiquidTypes(value: unknown): {
  classes: Map<number, LiquidClass>;
  surfaces: Map<number, LiquidSurface> | undefined;
} {
  const body = value as { version?: unknown; classes?: unknown; rows?: unknown } | null;
  const v2 = body !== null && typeof body === "object" && body.version === 2
    && typeof body.classes === "object" && body.classes !== null;
  const record = (v2 ? body!.classes : value) as Record<string, unknown>;
  const classes = new Map<number, LiquidClass>();
  for (const [id, named] of Object.entries(record ?? {})) {
    if ((CLASSES as readonly unknown[]).includes(named)) classes.set(Number(id), named as LiquidClass);
  }
  if (!v2 || typeof body!.rows !== "object" || body!.rows === null) return { classes, surfaces: undefined };
  const rows: Record<string, LiquidSurfaceRow> = {};
  for (const [id, row] of Object.entries(body!.rows as Record<string, unknown>)) {
    const candidate = row as Partial<LiquidSurfaceRow> | null;
    if (!candidate || typeof candidate.family !== "string" || typeof candidate.soundBank !== "number"
      || !Array.isArray(candidate.textures)) continue;
    rows[id] = { soundBank: candidate.soundBank, family: candidate.family, textures: candidate.textures.map(String) };
  }
  return { classes, surfaces: buildLiquidSurfaces(classes, rows) };
}

/**
 * The surface a cell or a WMO liquid is drawn with: the row's own surface once the v2 table has
 * arrived, else its class exactly as `liquidClassOf` decides it.
 */
export function liquidSurfaceOf(
  classOf: LiquidClass,
  entry: number,
  surfaces: ReadonlyMap<number, LiquidSurface> | undefined,
): LiquidSurface {
  const named = entry > 0 ? surfaces?.get(entry) : undefined;
  // A row's surface carries the class the table gave it; the flag fallback never disagrees with a
  // surface of a row the table names, because both read the same `classes`.
  return named !== undefined && liquidSurfaceClass(named) === classOf ? named : classOf;
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
/** Readability floors: the shallows stay readable over the bottom instead of vanishing. */
export const WATER_MIN_SHALLOW_ALPHA = 0.62;
export const WATER_MIN_DEEP_ALPHA = 0.85;
export const WATER_TEXTURE_ALPHA_FLOOR = 0.55;
/** Cold-cache water must remain recognisable while its animated strip is in flight. */
export const WATER_FALLBACK_OPACITY = 0.6;
/** Micro-waves must remain visible through the surface alpha without reading as a flashing sheet. */
export const WATER_WAVE_LIGHT_STRENGTH = 0.065;

export interface LiquidStrip {
  texture: THREE.Texture;
  frames: number;
}

/** Downloads one liquid's animation strip, and answers with it once it has arrived. */
export class LiquidTextureClient {
  onStatus: ((message: string, error: boolean) => void) | undefined;
  readonly #baseUrl: string;
  readonly #strips = new Map<LiquidSurface, LiquidStrip | null>(); // 05.10-A7b-8: by surface
  readonly #loading = new Set<LiquidSurface>();
  readonly #stripFailures = new Map<LiquidSurface, { attempts: number; after: number }>();
  /** Texture ownership is exact even if a non-standard loader hands the same object to two paths. */
  readonly #disposedTextures = new WeakSet<THREE.Texture>();
  /** Handles returned by TextureLoader remain owned until their callback settles or the session ends. */
  readonly #pendingTextureHandles = new Set<THREE.Texture>();
  #classes: Map<number, LiquidClass> | undefined;
  /** 05.10-A7b-8: row -> surface from the v2 table; absent against an older gateway (v1 record). */
  #surfaces: Map<number, LiquidSurface> | undefined;
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
    this.#surfaces = undefined; // 05.10-A7b-8
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

  /**
   * 05.10-A7b-8 (7.09 A): row -> surface (`class` or `class|family`), from the same request as
   * `classes`. `undefined` until it lands, and for good against a gateway older than R1, whose body
   * is the v1 record of classes: every surface is then its class, the look before the slice.
   */
  get surfaces(): ReadonlyMap<number, LiquidSurface> | undefined {
    if (this.#disposed) return undefined;
    void this.classes;
    return this.#surfaces;
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
      // 05.10-A7b-8: `?v=2`; an older gateway ignores the query and answers the v1 record.
      const response = await fetch(`${this.#baseUrl}/dbc/liquid-types?v=2`);
      if (!response.ok) throw new Error(`Liquid type gateway returned ${response.status}`);
      const { classes, surfaces } = parseLiquidTypes(await response.json());
      if (!this.#isCurrent(epoch)) return;
      this.#classes = classes;
      this.#surfaces = surfaces;
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

  get(liquidClass: LiquidSurface): LiquidStrip | undefined {
    if (this.#disposed) return undefined;
    // 05.10-A7b-8: a family strip that is finally unavailable (404 from an older gateway, a family
    // the client lacks, the retries spent) draws with its class strip rather than the flat sheet.
    if (this.#stripFailures.get(liquidClass)?.after === Infinity && liquidClass.includes("|")) {
      return this.get(liquidSurfaceClass(liquidClass));
    }
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

  async #load(liquidClass: LiquidSurface): Promise<void> {
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
      // 05.10-A7b-8: a family surface asks `/liquid/family/<slug>`; a class keeps `/liquid/<class>`.
      const family = liquidSurfaceFamily(liquidClass);
      if (family !== undefined && !LIQUID_FAMILY_SLUG.test(family)) throw new LiquidStripAbsent(family);
      const stripPath = family === undefined ? `/liquid/${liquidClass}` : `/liquid/family/${family}`;
      const response = await fetch(`${this.#baseUrl}${stripPath}`);
      if (family !== undefined && response.status === 404) throw new LiquidStripAbsent(family);
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
        loaderTexture = new THREE.TextureLoader().load(`${this.#baseUrl}${stripPath}.png`,
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
      // 05.10-A7b-8: an absent family is final at once; its class strip stands in.
      const wait = error instanceof LiquidStripAbsent ? undefined : WATER_RETRY_BACKOFF_MS[attempts - 1];
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

/** 05.10-A7b-8: a family strip the gateway does not have (404): not worth a retry. */
class LiquidStripAbsent extends Error {
  constructor(family: string) {
    super(`Liquid family ${family} is not published`);
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
 * Uniform objects shared by every water/ocean material in one renderer.  The values are mutated in
 * place by the renderer; replacing either the value object or a material's binding would make a
 * compiled program keep the previous frame's lighting.
 */
export interface WaterShaderSharedUniforms {
  readonly time: { value: number };
  readonly sunDirection: { value: THREE.Vector3 };
  readonly sunColour: { value: THREE.Color };
  /** Sky/fog colour the surface mirrors at grazing angles. Fed from the zone fog each frame. */
  readonly skyColour: { value: THREE.Color };
  /** 1 while the camera is underwater, otherwise 0. */
  readonly underwater: { value: number };
  /**
   * The Light.dbc sky bands the dome is drawn with (linear working space, like the dome's own
   * uniforms), zenith to horizon. Read only by the sky-reflection leaf (mask bit 32).
   */
  readonly skyTop: { value: THREE.Color };
  readonly skyUpper: { value: THREE.Color };
  readonly skyMiddle: { value: THREE.Color };
  readonly skyLower: { value: THREE.Color };
  readonly skyHorizon: { value: THREE.Color };
  /**
   * The visible sun (`godRaySunDirection`: allowed below the horizon), unlike `sunDirection`, the key
   * light that is floored above the ground at night. Glints and the mirrored sun must line up with
   * the disc in the sky and vanish once it has set. Read only by the cinematic leaves (16, 32).
   */
  readonly visibleSun: { value: THREE.Vector3 };
  /**
   * Ripple normal maps per surface class (`setWaterDetailNormalMaps`, `WaterDetailNormalMaps`);
   * empty by default, where the procedural octaves carry the surface on their own.
   */
  readonly detail: Readonly<Record<WaterDetailClass, WaterDetailSlot>>;
}

/** Normal-map slots exist per class that can reflect: rivers/lakes and the sea. */
export type WaterDetailClass = "water" | "ocean";

export interface WaterDetailSlot {
  /** Ocean: the near sea. Water: rivers and lakes. */
  readonly near: { value: THREE.Texture | null };
  /** Ocean: the far sea, taking over with footprint. Water: still water (slow, WMO), per vertex. */
  readonly alternate: { value: THREE.Texture | null };
  /** x slope gain (0: no maps, the procedural octaves), y near tile, z alternate tile (yards), w scroll (yards/s). */
  readonly params: { value: THREE.Vector4 };
  /** Height over width of the near and alternate maps, times their vertical stretch. */
  readonly aspect: { value: THREE.Vector2 };
  /** Per-axis slope variance of the near and alternate maps at full resolution (see `slopeVariance`). */
  readonly variance: { value: THREE.Vector2 };
}

/** The dome's band uniforms, by the names `buildSky` gives them. */
export interface WaterSkyBandSource {
  readonly skyTop: { readonly value: THREE.Color };
  readonly skyUpper: { readonly value: THREE.Color };
  readonly skyMiddle: { readonly value: THREE.Color };
  readonly skyLower: { readonly value: THREE.Color };
  readonly skyHorizon: { readonly value: THREE.Color };
}

/** Copies the dome's current bands into the water's own uniform objects (no allocation). */
export function copyWaterSkyBands(shared: WaterShaderSharedUniforms, sky: WaterSkyBandSource): void {
  shared.skyTop.value.copy(sky.skyTop.value);
  shared.skyUpper.value.copy(sky.skyUpper.value);
  shared.skyMiddle.value.copy(sky.skyMiddle.value);
  shared.skyLower.value.copy(sky.skyLower.value);
  shared.skyHorizon.value.copy(sky.skyHorizon.value);
}

export interface WaterShaderProfile {
  readonly waterFresnel: boolean;
  readonly waterMicroWaves: boolean;
  readonly waterSunSparkle: boolean;
  readonly waterFoam: boolean;
  readonly fantasyGlow: boolean;
  /** Cinematic leaf: microfacet sun glints and the glitter path of the visible sun; absent means off. */
  readonly waterSunGlitter?: boolean;
  /**
   * Cinematic leaf: the surface mirrors the Light.dbc sky bands through a Schlick Fresnel term,
   * layered over the authored water body, replacing the flat fog-colour Fresnel while on; absent
   * means off.
   */
  readonly waterSkyReflection?: boolean;
}

export const WATER_SHADER_PROFILE_VERSION = 5;

export const DEFAULT_WATER_SHADER_PROFILE: Readonly<WaterShaderProfile> = Object.freeze({
  waterFresnel: false,
  waterMicroWaves: false,
  waterSunSparkle: false,
  waterFoam: false,
  fantasyGlow: false,
});

export function createWaterShaderSharedUniforms(): WaterShaderSharedUniforms {
  return {
    time: { value: 0 },
    sunDirection: { value: new THREE.Vector3(0, 1, 0) },
    sunColour: { value: new THREE.Color(0xffffff) },
    skyColour: { value: new THREE.Color(0x87b5d6) },
    underwater: { value: 0 },
    // The dome's own stand-in bands (WorldRenderer3D `#resetLightingDefaults`) until a sample lands.
    skyTop: { value: new THREE.Color(0x001f49) },
    skyUpper: { value: new THREE.Color(0x3aa2cf) },
    skyMiddle: { value: new THREE.Color(0x99dcf5) },
    skyLower: { value: new THREE.Color(0xafdae0) },
    skyHorizon: { value: new THREE.Color(0xb4b4b4) },
    visibleSun: { value: new THREE.Vector3(0, 1, 0) },
    detail: Object.freeze({ water: emptyWaterDetailSlot(), ocean: emptyWaterDetailSlot() }),
  };
}

function emptyWaterDetailSlot(): WaterDetailSlot {
  return {
    near: { value: null },
    alternate: { value: null },
    params: { value: new THREE.Vector4(0, 8, 8, 0.3) },
    aspect: { value: new THREE.Vector2(1, 1) },
    variance: { value: new THREE.Vector2(0.03, 0.03) },
  };
}

/**
 * Slope gain of a photographed water normal map. The shipped near maps carry ~0.22 RMS slope per
 * axis at full resolution and two averaged layers keep 1/sqrt(2) of it, so 0.5 lands a lake near the
 * procedural octaves' ~0.075 and the calm map at about half that.
 */
export const WATER_DETAIL_STRENGTH = 0.5;

export interface WaterDetailNormalMapOptions {
  /** Slope gain, 0..1.5; 0 unplugs the maps. Default `WATER_DETAIL_STRENGTH`. */
  readonly strength?: number;
  /** Yards covered by one repeat of the near map (its first layer). Default 8. */
  readonly tileYards?: number;
  /** Yards per repeat of the alternate map. Default the near tile. */
  readonly alternateTileYards?: number;
  /** How fast the layers drift apart, yards per second. Default 0.3. */
  readonly scrollYardsPerSecond?: number;
  /**
   * Extra vertical stretch of the maps. A photographed water surface is foreshortened — its waves
   * come out squashed along the picture's height — and this gives them back some depth. Default 1.
   */
  readonly stretch?: number;
  /**
   * Per-axis slope variance of each map at full resolution, near then alternate. The mip filter
   * averages ripples away with distance; this is what the shader hands back to the glitter lobe and
   * the sky blur for what it lost. Default 0.03 each.
   */
  readonly slopeVariance?: readonly [number, number];
}

function textureAspect(texture: THREE.Texture | null): number {
  const image = texture?.image as { width?: unknown; height?: unknown } | null | undefined;
  const width = typeof image?.width === "number" ? image.width : 0;
  const height = typeof image?.height === "number" ? image.height : 0;
  return width > 0 && height > 0 ? height / width : 1;
}

/**
 * Plugs tileable tangent-space normal maps (+Z up, linear) into one class's ripples, or unplugs them
 * with `null`. No program is rebuilt: every water variant that computes ripples (sparkle, glitter,
 * sky reflection) already samples the two slots behind a uniform branch, and with nothing plugged in
 * it takes the procedural octaves instead. The caller keeps ownership of the textures.
 *
 * Ocean: `near` is the close sea and `alternate` the far sea, which takes over as a pixel covers more
 * water (distance, grazing angle). Water: `near` is rivers and lakes, `alternate` still water — slow
 * water and WMO pools, chosen per vertex from the liquid's `LiquidType` row.
 */
export function setWaterDetailNormalMaps(
  shared: WaterShaderSharedUniforms,
  liquidClass: WaterDetailClass,
  near: THREE.Texture | null,
  alternate: THREE.Texture | null = near,
  options: WaterDetailNormalMapOptions = {},
): void {
  const finite = (value: number | undefined, fallback: number, min: number, max: number): number =>
    value !== undefined && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const slot = shared.detail[liquidClass];
  const other = alternate ?? near;
  for (const texture of [near, other]) {
    if (!texture) continue;
    if (texture.wrapS !== THREE.RepeatWrapping || texture.wrapT !== THREE.RepeatWrapping
      || texture.colorSpace !== THREE.NoColorSpace) {
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.colorSpace = THREE.NoColorSpace;
      texture.needsUpdate = true;
    }
  }
  const tile = finite(options.tileYards, 8, 0.5, 400);
  const stretch = finite(options.stretch, 1, 0.25, 4);
  slot.params.value.set(
    near ? finite(options.strength, WATER_DETAIL_STRENGTH, 0, 1.5) : 0,
    tile,
    finite(options.alternateTileYards, tile, 0.5, 400),
    finite(options.scrollYardsPerSecond, 0.3, 0, 10),
  );
  slot.aspect.value.set(textureAspect(near) * stretch, textureAspect(other) * stretch);
  slot.variance.value.set(
    finite(options.slopeVariance?.[0], 0.03, 0, 1),
    finite(options.slopeVariance?.[1], options.slopeVariance?.[0] ?? 0.03, 0, 1),
  );
  slot.near.value = near;
  slot.alternate.value = near ? other : null;
}

/** Still water: `LiquidType` 5 "Slow Water", 13 "WMO Water", 17 "WMO Water - Interior". */
const STILL_WATER_ENTRIES: ReadonlySet<number> = new Set([5, 13, 17]);

/**
 * The per-vertex `liquidCalm` the water geometry carries: 1 for still water (slow water and WMO
 * pools), 0 for rivers, lakes of plain or fast water, and everything else. Only the enhanced water
 * reads it, to pick the calm normal map.
 */
export function liquidCalmOf(entry: number, wmo = false): number {
  return wmo || STILL_WATER_ENTRIES.has(entry) ? 1 : 0;
}

/**
 * The normal maps shipped in `public/textures/water/` (CC-BY 3.0, Keith333 — see LICENSE.md there),
 * per class: tile sizes in yards and the vertical stretch that undoes the photographs' foreshortening.
 */
export const WATER_DETAIL_MAP_SET: Readonly<Record<WaterDetailClass, Readonly<{
  near: string; alternate: string; tileYards: number; alternateTileYards: number; stretch: number;
  slopeVariance: readonly [number, number];
}>>> = Object.freeze({
  ocean: Object.freeze({
    near: "SeaWaves_N.jpg", alternate: "SeaDistant_N.jpg", tileYards: 16, alternateTileYards: 42, stretch: 1.5,
    slopeVariance: Object.freeze([0.052, 0.011] as const),
  }),
  water: Object.freeze({
    near: "Lake_N.jpg", alternate: "GreenCalm_N.jpg", tileYards: 9, alternateTileYards: 11, stretch: 1.5,
    slopeVariance: Object.freeze([0.048, 0.014] as const),
  }),
});
/** Root-relative: Vite serves `public/` at `/` in development and copies it into `dist/web` for builds. */
export const WATER_DETAIL_MAP_BASE_URL = "/textures/water/";
/** Decoded no wider than this: 1024 x 683 RGBA with mips is ~3.7 MB of GPU memory per map. */
export const WATER_DETAIL_MAP_MAX_WIDTH = 1024;

/** Fetches one normal map and decodes it off the main thread, scaled down to `maxWidth`. */
export async function decodeWaterNormalMap(url: string, maxWidth = WATER_DETAIL_MAP_MAX_WIDTH): Promise<THREE.Texture> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Water normal map ${url} returned ${response.status}`);
  const full = await createImageBitmap(await response.blob());
  let bitmap = full;
  if (full.width > maxWidth) {
    try {
      bitmap = await createImageBitmap(full, {
        resizeWidth: maxWidth,
        resizeHeight: Math.max(1, Math.round(full.height * maxWidth / full.width)),
        resizeQuality: "high",
      });
    } finally {
      full.close();
    }
  }
  const texture = new THREE.Texture(bitmap);
  // An ImageBitmap cannot be flipped on upload; the orientation of a ripple map does not matter.
  texture.flipY = false;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.colorSpace = THREE.NoColorSpace;
  texture.name = url;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Loads `WATER_DETAIL_MAP_SET` once, on the first `request()` — which the renderer makes only while
 * an enhanced water leaf (glitter or sky reflection) is on, so the faithful frame never fetches them —
 * and plugs each class in as soon as both of its maps have landed. Until then, and for good if a map
 * fails, that class keeps the procedural octaves.
 */
export class WaterDetailNormalMaps {
  readonly #shared: WaterShaderSharedUniforms;
  readonly #baseUrl: string;
  readonly #decode: (url: string) => Promise<THREE.Texture>;
  readonly #textures = new Set<THREE.Texture>();
  #requested = false;
  #disposed = false;
  #pending = 0;
  #loaded = 0;
  #failed = 0;

  constructor(
    shared: WaterShaderSharedUniforms,
    baseUrl = WATER_DETAIL_MAP_BASE_URL,
    decode: (url: string) => Promise<THREE.Texture> = decodeWaterNormalMap,
  ) {
    this.#shared = shared;
    this.#baseUrl = baseUrl;
    this.#decode = decode;
  }

  /** Maps in flight, bound, and given up on. */
  get stats(): Readonly<{ pending: number; loaded: number; failed: number }> {
    return Object.freeze({ pending: this.#pending, loaded: this.#loaded, failed: this.#failed });
  }

  get requested(): boolean {
    return this.#requested;
  }

  /** Starts the one download of every map; later calls do nothing. */
  request(): void {
    if (this.#requested || this.#disposed) return;
    this.#requested = true;
    for (const liquidClass of ["ocean", "water"] as const) void this.#loadClass(liquidClass);
  }

  async #loadClass(liquidClass: WaterDetailClass): Promise<void> {
    const set = WATER_DETAIL_MAP_SET[liquidClass];
    const results = await Promise.allSettled([this.#load(set.near), this.#load(set.alternate)]);
    const near = results[0].status === "fulfilled" ? results[0].value : undefined;
    const alternate = results[1].status === "fulfilled" ? results[1].value : undefined;
    if (this.#disposed || !near || !alternate) return;
    setWaterDetailNormalMaps(this.#shared, liquidClass, near, alternate, {
      tileYards: set.tileYards,
      alternateTileYards: set.alternateTileYards,
      stretch: set.stretch,
      slopeVariance: set.slopeVariance,
    });
  }

  async #load(file: string): Promise<THREE.Texture | undefined> {
    this.#pending++;
    try {
      const texture = await this.#decode(`${this.#baseUrl}${file}`);
      if (this.#disposed) {
        disposeWaterNormalMap(texture);
        return undefined;
      }
      this.#textures.add(texture);
      this.#loaded++;
      return texture;
    } catch {
      this.#failed++;
      return undefined;
    } finally {
      this.#pending--;
    }
  }

  /** Every decoded map, bound or not, is GPU memory this object owns. */
  visitRetainedResources(visitor: RetainedResourceVisitor): void {
    for (const texture of this.#textures) visitor.referenceGpuTexture(this, texture);
  }

  /** Unplugs both classes and releases the maps. Safe to repeat. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    setWaterDetailNormalMaps(this.#shared, "water", null);
    setWaterDetailNormalMaps(this.#shared, "ocean", null);
    for (const texture of this.#textures) disposeWaterNormalMap(texture);
    this.#textures.clear();
  }
}

function disposeWaterNormalMap(texture: THREE.Texture): void {
  try { texture.dispose(); } catch { /* best effort */ }
  const image = texture.image as { close?: () => void } | null | undefined;
  try { image?.close?.(); } catch { /* best effort */ }
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
    | (profile?.waterSunSparkle === true ? 4 : 0)
    | (profile?.waterFoam === true ? 8 : 0)
    | (profile?.waterSunGlitter === true ? 16 : 0)
    | (profile?.waterSkyReflection === true ? 32 : 0);
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
  surface: LiquidSurface, // 05.10-A7b-8: shaded by its class
  profile: Readonly<Partial<WaterShaderProfile>> | undefined,
  shared: WaterShaderSharedUniforms,
): void {
  const liquidClass = liquidSurfaceClass(surface);
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

/** Masks whose code reads the value-noise helpers: micro-waves, sparkle, foam, glitter, sky. */
const WATER_NOISE_MASK = 2 | 4 | 8 | 16 | 32;
/** Masks that read the rippled facet slope: sparkle, glitter and the sky reflection. */
const WATER_RIPPLE_MASK = 4 | 16 | 32;

function injectWaterShader(shader: LiquidShaderSource, binding: WaterShaderBinding): void {
  const beginVertex = "#include <begin_vertex>";
  const opaqueFragment = "#include <opaque_fragment>";
  if (shader.vertexShader.split(beginVertex).length - 1 !== 1
    || shader.fragmentShader.split(opaqueFragment).length - 1 !== 1) {
    throw new Error("Water shader profile expected MeshBasic begin/opaque markers");
  }
  const mask = binding.mask;
  const noise = (mask & WATER_NOISE_MASK) !== 0;
  const ripple = (mask & WATER_RIPPLE_MASK) !== 0;
  const sky = (mask & 32) !== 0;
  const visibleSun = (mask & (16 | 32)) !== 0;

  shader.uniforms.waterTime = binding.shared.time;
  shader.uniforms.waterSunDirection = binding.shared.sunDirection;
  shader.uniforms.waterSunColour = binding.shared.sunColour;
  shader.uniforms.waterSkyColour = binding.shared.skyColour;
  shader.uniforms.waterUnderwater = binding.shared.underwater;
  if (sky) {
    shader.uniforms.waterSkyTop = binding.shared.skyTop;
    shader.uniforms.waterSkyUpper = binding.shared.skyUpper;
    shader.uniforms.waterSkyMiddle = binding.shared.skyMiddle;
    shader.uniforms.waterSkyLower = binding.shared.skyLower;
    shader.uniforms.waterSkyHorizon = binding.shared.skyHorizon;
  }
  if (visibleSun) shader.uniforms.waterVisibleSun = binding.shared.visibleSun;
  const detailClass: WaterDetailClass = binding.liquidClass === "ocean" ? "ocean" : "water";
  // Still water (slow, WMO) reads the calm map per vertex; the ocean blends near to far by footprint.
  const calm = ripple && detailClass === "water";
  if (ripple) {
    const slot = binding.shared.detail[detailClass];
    shader.uniforms.waterDetailNear = slot.near;
    shader.uniforms.waterDetailAlternate = slot.alternate;
    shader.uniforms.waterDetailParams = slot.params;
    shader.uniforms.waterDetailAspect = slot.aspect;
    shader.uniforms.waterDetailVariance = slot.variance;
  }

  // Three's MeshBasic vertex shader does not expose a useful world-position varying.  Keep these
  // values in our own varyings so the fragment branches work for both terrain and WMO liquids.
  if (!shader.vertexShader.includes("vWaterWorldPosition")) {
    shader.vertexShader = `
varying vec3 vWaterWorldPosition;
varying vec3 vWaterWorldNormal;
${calm ? "attribute float liquidCalm;\nvarying float vWaterCalm;\n" : ""}${shader.vertexShader}`.replace(beginVertex, `
#include <begin_vertex>
  vec4 waterWorldPosition = modelMatrix * vec4(transformed, 1.0);
  vWaterWorldPosition = waterWorldPosition.xyz;
  vWaterWorldNormal = normalize(mat3(modelMatrix) * normal);
${calm ? "  vWaterCalm = liquidCalm;\n" : ""}`);
  }

  if (shader.fragmentShader.includes("water-profile-v3")) return;
  const hasLiquidDepth = shader.vertexShader.includes("vLiquidDepth = liquidDepth;")
    && shader.fragmentShader.includes("uniform float liquidDeepAt;")
    && shader.fragmentShader.includes("vLiquidDepth");
  const effects: string[] = ["/* water-profile-v3 */", `
  vec3 waterBaseNormalRaw = vWaterWorldNormal;
  vec3 waterSurfaceNormal = waterBaseNormalRaw
    * inversesqrt(max(dot(waterBaseNormalRaw, waterBaseNormalRaw), 1e-8));
`];
  if (noise) effects.push(WATER_FOOTPRINT_GLSL);
  if (ripple) {
    effects.push(waterRippleGlsl(calm ? "vWaterCalm"
      : `smoothstep(${glslNumber(WATER_OCEAN_FAR_FOOTPRINT[0])}, ${glslNumber(WATER_OCEAN_FAR_FOOTPRINT[1])}, waterFootprint)`));
  }
  if ((mask & 5) !== 0) {
    effects.push("  vec3 waterSunColourLinear = pow(max(waterSunColour, vec3(0.0)), vec3(2.2));\n");
  }
  if ((mask & 2) !== 0) {
    effects.push(`
  // Broad swell from two rotated octaves of value noise drifting apart. Two crossing sines used to
  // stand here, and their sum repeats: a regular lattice of light and dark across a whole lake.
  vec3 waterSwellField = waterSwell(vWaterWorldPosition.xz, waterTime, waterFootprint);
  float waterWave = waterSwellField.x;
  vec2 waterWaveSlope = waterSwellField.yz;
  vec3 waterWaveNormalRaw = waterSurfaceNormal + vec3(-waterWaveSlope.x, 0.0, -waterWaveSlope.y);
  waterSurfaceNormal = waterWaveNormalRaw
    * inversesqrt(max(dot(waterWaveNormalRaw, waterWaveNormalRaw), 1e-8));
  outgoingLight *= 1.0 + waterWave * ${WATER_WAVE_LIGHT_STRENGTH};
`);
  }
  if (sky) {
    // Supersedes the flat fog-colour Fresnel below while on: what is mirrored is the sky itself.
    effects.push(waterSkyReflectionGlsl(binding.liquidClass));
  } else if ((mask & 1) !== 0) {
    effects.push(`
  vec3 waterToCameraRaw = cameraPosition - vWaterWorldPosition;
  vec3 waterToCamera = waterToCameraRaw * inversesqrt(max(dot(waterToCameraRaw, waterToCameraRaw), 1e-8));
  float waterFacing = clamp(abs(dot(waterSurfaceNormal, waterToCamera)), 0.0, 1.0);
  float waterFresnel = pow(1.0 - waterFacing, 3.0);
  float waterFresnelVisibility = 1.0 - clamp(waterUnderwater, 0.0, 1.0);
  // A grazing look mirrors the sky, not the lakebed: the zone fog colour stands in for it,
  // which is what the horizon fades to at the same angle. The sun keeps a tenth of its tint
  // on top so dawn over water still reads warm.
  vec3 waterSkyColourLinear = pow(max(waterSkyColour, vec3(0.0)), vec3(2.2));
  outgoingLight = mix(
    outgoingLight,
    waterSkyColourLinear + waterSunColourLinear * 0.10,
    waterFresnel * 0.65 * waterFresnelVisibility);
`);
  }
  if ((mask & 4) !== 0) {
    effects.push(`
  if (waterUnderwater < 0.5) {
    // The rippled facet (noise octaves, see waterRipples), not a pair of fixed-frequency sines.
    vec3 waterSparkleNormalRaw = waterSurfaceNormal + vec3(-waterRipple.x, 0.0, -waterRipple.y);
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
  if ((mask & 16) !== 0) effects.push(WATER_SUN_GLITTER_GLSL);
  // Cold-cache fallback materials do not carry the liquid-depth varying.  Keep foam neutral there
  // instead of compiling a reference to a value the fallback shader cannot provide.
  if ((mask & 8) !== 0 && hasLiquidDepth) {
    effects.push(`
  float waterFoamDepth = clamp(vLiquidDepth / max(liquidDeepAt, 1e-4), 0.0, 1.0);
  float waterFoamShore = 1.0 - smoothstep(0.0, 0.42, waterFoamDepth);
  // Patches from two rotated noise octaves (1.9 and 0.83 yards) rather than one sine's parallel
  // stripes; gone where the pixel is too coarse to draw them.
  vec2 waterFoamPoint = vec2(0.6 * vWaterWorldPosition.x - 0.8 * vWaterWorldPosition.z,
    0.8 * vWaterWorldPosition.x + 0.6 * vWaterWorldPosition.z);
  float waterFoamPattern = 0.62 * waterNoise((waterFoamPoint + vec2(0.9, 0.4) * waterTime) / 1.9).x
    + 0.38 * waterNoise((waterFoamPoint.yx - vec2(0.5, 1.1) * waterTime) / 0.83).x;
  float waterFoamDetail = clamp((1.9 / waterFootprint - 2.0) / 3.0, 0.0, 1.0);
  float waterFoamAmount = waterFoamShore * smoothstep(0.5, 0.78, waterFoamPattern) * waterFoamDetail
    * (1.0 - waterUnderwater) * 0.12;
  outgoingLight = mix(outgoingLight, outgoingLight + vec3(0.18, 0.24, 0.24), waterFoamAmount);
`);
  }
  shader.fragmentShader = `
uniform float waterTime;
uniform vec3 waterSunDirection;
uniform vec3 waterSunColour;
uniform vec3 waterSkyColour;
uniform float waterUnderwater;
${visibleSun ? "uniform vec3 waterVisibleSun;\n" : ""}${sky ? WATER_SKY_UNIFORMS_GLSL : ""}${ripple ? WATER_DETAIL_UNIFORMS_GLSL : ""}varying vec3 vWaterWorldPosition;
varying vec3 vWaterWorldNormal;
${calm ? "varying float vWaterCalm;\n" : ""}
${noise ? WATER_NOISE_GLSL : ""}${ripple ? WATER_DETAIL_GLSL : ""}${sky ? WATER_SKY_BAND_GLSL : ""}${shader.fragmentShader}`
    .replace(opaqueFragment, `${effects.join("")}\n${opaqueFragment}`);
}

const WATER_SKY_UNIFORMS_GLSL = `uniform vec3 waterSkyTop;
uniform vec3 waterSkyUpper;
uniform vec3 waterSkyMiddle;
uniform vec3 waterSkyLower;
uniform vec3 waterSkyHorizon;
`;

const WATER_DETAIL_UNIFORMS_GLSL = `uniform sampler2D waterDetailNear;
uniform sampler2D waterDetailAlternate;
uniform vec4 waterDetailParams;
uniform vec2 waterDetailAspect;
uniform vec2 waterDetailVariance;
`;

/** Ocean footprints (yards per pixel) over which the far-sea map takes over from the near one. */
export const WATER_OCEAN_FAR_FOOTPRINT: readonly [number, number] = Object.freeze([0.06, 0.45] as [number, number]);

/**
 * The ripple spectrum: wavelength (yards), steepness (amplitude / wavelength), rotation of the
 * octave's lattice (radians) and drift (yards per second, in the octave's own frame). Wavelength
 * ratios are deliberately not powers of two and every octave is turned by an unrelated angle, so no
 * two lattices line up and their sum has no period to repeat. Total resolved slope is ~0.075 per
 * axis: a calm lake, not a sea.
 */
export const WATER_RIPPLE_OCTAVES: readonly Readonly<{
  wavelength: number; steepness: number; angle: number; drift: readonly [number, number];
}>[] = Object.freeze([
  Object.freeze({ wavelength: 9.7, steepness: 0.1, angle: 0.37, drift: [0.54, 0.11] as const }),
  Object.freeze({ wavelength: 4.53, steepness: 0.08, angle: 1.61, drift: [-0.12, 0.4] as const }),
  Object.freeze({ wavelength: 2.21, steepness: 0.065, angle: 2.83, drift: [0.25, -0.19] as const }),
  Object.freeze({ wavelength: 1.07, steepness: 0.05, angle: 4.19, drift: [-0.22, -0.09] as const }),
]);

/** A ripple is drawn only while one wavelength spans at least this many pixels (fully from +3). */
export const WATER_RIPPLE_MIN_PIXELS = 2;

const glslNumber = (value: number): string => {
  const text = value.toFixed(4);
  return text.includes(".") ? text : `${text}.0`;
};

const WATER_RIPPLE_SUM_GLSL = WATER_RIPPLE_OCTAVES.map((octave, index) => {
  const c = glslNumber(Math.cos(octave.angle));
  const s = glslNumber(Math.sin(octave.angle));
  return `  ${index === 0 ? "vec3 r =" : "r +="} waterOctave(p, time, footprint, ${glslNumber(octave.wavelength)}, `
    + `${glslNumber(octave.steepness)}, vec2(${c}, ${s}), vec2(${glslNumber(octave.drift[0])}, ${glslNumber(octave.drift[1])}));`;
}).join("\n");

/**
 * Value noise and the ripple fields built from it. The hash has no sine in it, so it holds its
 * quality at the world's ±17,000-yard coordinates where `fract(sin(x))` falls apart on some GPUs.
 * The quintic fade keeps the analytic gradient continuous, so a derived normal shows no cell seams.
 */
const WATER_NOISE_GLSL = `float waterHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// x: value 0..1, yz: its gradient.
vec3 waterNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = waterHash(i);
  float b = waterHash(i + vec2(1.0, 0.0));
  float c = waterHash(i + vec2(0.0, 1.0));
  float d = waterHash(i + vec2(1.0, 1.0));
  float k1 = b - a;
  float k2 = c - a;
  float k4 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
}
// One octave's height slope (xy) and, for the part this pixel cannot draw, its slope variance (z).
// A wave spanning fewer than ${WATER_RIPPLE_MIN_PIXELS} pixels would alias into a moire; it fades out over the next
// three and its variance is handed on, so it widens the sun's highlight lobe and blurs the mirrored
// sky instead. Far and grazing water is therefore a smooth glossy mirror by construction.
vec3 waterOctave(vec2 p, float time, float footprint, float wavelength, float steepness, vec2 rotation, vec2 drift) {
  vec2 q = vec2(rotation.x * p.x - rotation.y * p.y, rotation.y * p.x + rotation.x * p.y);
  vec3 n = waterNoise((q + drift * time) / wavelength);
  vec2 slope = vec2(rotation.x * n.y + rotation.y * n.z, rotation.x * n.z - rotation.y * n.y) * steepness;
  float keep = clamp((wavelength / footprint - ${glslNumber(WATER_RIPPLE_MIN_PIXELS)}) / 3.0, 0.0, 1.0);
  return vec3(slope * keep, (1.0 - keep * keep) * steepness * steepness * 0.24);
}
vec3 waterRipples(vec2 p, float time, float footprint) {
${WATER_RIPPLE_SUM_GLSL}
  return r;
}
// The micro-wave swell: value in x (about -1..1), slope in yz; 23 and 10.3 yard octaves.
vec3 waterSwell(vec2 p, float time, float footprint) {
  vec2 qa = vec2(0.8 * p.x - 0.6 * p.y, 0.6 * p.x + 0.8 * p.y);
  vec2 qb = vec2(-0.47 * p.x - 0.88 * p.y, 0.88 * p.x - 0.47 * p.y);
  vec3 a = waterNoise((qa + vec2(0.83, 0.56) * (time * 0.42)) / 23.0);
  vec3 b = waterNoise((qb - vec2(0.31, 0.95) * (time * 0.27)) / 10.3);
  float keepA = clamp((23.0 / footprint - 2.0) / 3.0, 0.0, 1.0);
  float keepB = clamp((10.3 / footprint - 2.0) / 3.0, 0.0, 1.0);
  vec2 slope = vec2(0.8 * a.y + 0.6 * a.z, 0.8 * a.z - 0.6 * a.y) * (0.05 * keepA)
    + vec2(-0.47 * b.y + 0.88 * b.z, -0.47 * b.z - 0.88 * b.y) * (0.035 * keepB);
  return vec3((a.x * 0.65 + b.x * 0.35 - 0.5) * 3.0, slope);
}
`;

/**
 * The ripple normal maps (`setWaterDetailNormalMaps`). Each map is read as two layers — rotated 28°
 * and -71° against the world, at scales 1 and 0.61, drifting in different directions — so no repeat
 * of one lines up with a repeat of the other and the tiling does not show. The texture's mip chain
 * does the anti-aliasing with distance and grazing angle; the slope variance it averages away is
 * handed on, like the procedural octaves', to the glitter lobe and the sky blur, so far water turns
 * into a smooth glossy mirror instead of a flat one. The per-texel slope is taken against the texel's
 * own z, so a strong map cannot tip a facet past vertical.
 */
const WATER_DETAIL_GLSL = `vec3 waterDetailLayer(sampler2D map, float variance, vec2 p, vec2 tile, vec2 rotation, vec2 drift, float time, float footprint) {
  vec2 q = vec2(rotation.x * p.x - rotation.y * p.y, rotation.y * p.x + rotation.x * p.y);
  vec3 n = texture2D(map, (q + drift * time) / tile).xyz * 2.0 - 1.0;
  vec2 texels = vec2(textureSize(map, 0));
  // Slope per yard: a stretched map's rows lie further apart than its columns.
  vec2 s = -n.xy / max(n.z, 0.3) * vec2(1.0, (tile.x * texels.y) / (tile.y * texels.x));
  vec2 slope = vec2(rotation.x * s.x + rotation.y * s.y, rotation.x * s.y - rotation.y * s.x);
  // What the mip filter averaged away at this footprint: the shipped maps keep ~0.62 of their RMS
  // slope per level (measured), so the variance left is 0.384^level of the full-resolution one.
  float level = max(log2(footprint * texels.x / tile.x), 0.0);
  return vec3(slope, variance * (1.0 - exp2(-1.38 * level)));
}
vec3 waterDetailPair(sampler2D map, float variance, vec2 p, float tile, float aspect, float scroll, float time, float footprint) {
  vec2 size = vec2(tile, tile * aspect);
  vec3 a = waterDetailLayer(map, variance, p, size, vec2(0.8829, 0.4695), vec2(0.83, 0.56) * scroll, time, footprint);
  vec3 b = waterDetailLayer(map, variance, p, size * 0.61, vec2(0.3256, -0.9455), vec2(-0.52, 0.85) * (0.8 * scroll), time, footprint);
  return vec3((a.xy + b.xy) * 0.5, (a.z + b.z) * 0.25);
}
// alternate: 0 the near map, 1 the alternate (far sea / still water).
vec3 waterDetailRipple(vec2 p, float time, float footprint, float alternate) {
  float scroll = waterDetailParams.w;
  vec3 near = waterDetailPair(waterDetailNear, waterDetailVariance.x, p, waterDetailParams.y, waterDetailAspect.x, scroll, time, footprint);
  vec3 other = waterDetailPair(waterDetailAlternate, waterDetailVariance.y, p, waterDetailParams.z, waterDetailAspect.y, 0.7 * scroll, time, footprint);
  vec3 r = mix(near, other, clamp(alternate, 0.0, 1.0));
  float gain = waterDetailParams.x;
  return vec3(r.xy * gain, r.z * gain * gain);
}
`;

/** The dome's own band function (`buildSky`), for a mirrored ray; never below the horizon band. */
const WATER_SKY_BAND_GLSL = `vec3 waterSkyBand(float height) {
  float h = clamp(height, 0.0, 1.0);
  vec3 colour = mix(waterSkyHorizon, waterSkyLower, smoothstep(0.0, 0.05, h));
  colour = mix(colour, waterSkyMiddle, smoothstep(0.05, 0.14, h));
  colour = mix(colour, waterSkyUpper, smoothstep(0.14, 0.36, h));
  return mix(colour, waterSkyTop, smoothstep(0.36, 0.85, h));
}
`;

/** Yards of water one pixel covers along its longer (grazing) axis. */
const WATER_FOOTPRINT_GLSL = `
  vec3 waterPixelDx = dFdx(vWaterWorldPosition);
  vec3 waterPixelDy = dFdy(vWaterWorldPosition);
  float waterFootprint = max(max(length(waterPixelDx.xz), length(waterPixelDy.xz)), 1e-3);
`;

/**
 * Rippled facet slope (xy) and the variance of the ripples too fine for this pixel (z): from the
 * normal maps once they are bound, from the procedural octaves until then (and without them).
 * `alternate` is the GLSL weight of the second map: per vertex for still water, by footprint at sea.
 */
function waterRippleGlsl(alternate: string): string {
  return `
  vec3 waterRipple;
  if (waterDetailParams.x > 0.0) {
    waterRipple = waterDetailRipple(vWaterWorldPosition.xz, waterTime, waterFootprint, ${alternate});
  } else {
    waterRipple = waterRipples(vWaterWorldPosition.xz, waterTime, waterFootprint);
  }
`;
}

/**
 * Most of the sky a grazing mirror may show. Rippled water falls well short of Fresnel's 1 at grazing
 * incidence once neighbouring waves mask it, and the authored body colour must stay readable: at half,
 * a far lake still reads as WoW water with the sky in it, not as a milky mirror.
 */
export const WATER_SKY_REFLECTION_STRENGTH = 0.5;
/**
 * Luminance ceiling of the mirrored sky (linear). A sunset horizon band is authored near white; held
 * under this, a lake at dusk reflects warm light instead of washing out to white-pink.
 */
export const WATER_SKY_MIRROR_MAX = 0.36;
/** Share of the low mirror rays that meet a far bank (drawn in the zone fog) instead of the sky. */
export const WATER_SKY_SHORE: Readonly<Record<"water" | "ocean", number>> = Object.freeze({ water: 0.5, ocean: 0.15 });

/**
 * Sky reflection: the view ray mirrored about the rippled facet picks its colour from the dome's own
 * five bands (linear, like the dome's uniforms), a Schlick Fresnel term (F0 = 0.02, water) decides
 * how much of it shows, and it is layered over the authored water body — which keeps its colour and
 * texture wherever the view is steep — rather than replacing it.
 */
function waterSkyReflectionGlsl(liquidClass: LiquidClass): string {
  const shore = WATER_SKY_SHORE[liquidClass === "ocean" ? "ocean" : "water"];
  return `
  /* water-sky-reflection-v2 */
  vec3 waterSkyViewRaw = cameraPosition - vWaterWorldPosition;
  vec3 waterSkyView = waterSkyViewRaw * inversesqrt(max(dot(waterSkyViewRaw, waterSkyViewRaw), 1e-8));
  vec3 waterSkyUpRaw = vWaterWorldNormal;
  vec3 waterSkyUp = waterSkyUpRaw * inversesqrt(max(dot(waterSkyUpRaw, waterSkyUpRaw), 1e-8));
  vec3 waterSkyNormalRaw = waterSurfaceNormal + vec3(-waterRipple.x, 0.0, -waterRipple.y);
  vec3 waterSkyNormal = waterSkyNormalRaw * inversesqrt(max(dot(waterSkyNormalRaw, waterSkyNormalRaw), 1e-8));
  vec3 waterSkyRay = reflect(-waterSkyView, waterSkyNormal);
  // A ray a ripple tips under the horizon meets the next wave, which shows the horizon as well, so a
  // ripple never draws the dome's below-horizon fog as a dark stripe. The ripples too fine for this
  // pixel blur the lookup over the heights they would send the ray to.
  float waterSkySpread = 1.4 * sqrt(waterRipple.z);
  vec3 waterSkyMirror = 0.5 * (waterSkyBand(waterSkyRay.y - waterSkySpread)
    + waterSkyBand(waterSkyRay.y + waterSkySpread));
  // A lake's lowest mirror rays meet its far bank, which stands in the zone fog. Taken from the
  // unrippled mirror ray (its height is the view's), so it is one smooth gradient, not a pattern.
  float waterSkyFlat = clamp(dot(waterSkyView, waterSkyUp), 0.0, 1.0);
  waterSkyMirror = mix(waterSkyMirror, waterSkyColour, ${glslNumber(shore)} * (1.0 - smoothstep(0.0, 0.14, waterSkyFlat)));
  // The sky around the visible sun is brighter than its band; a soft lobe, the glints are leaf 16's.
  vec3 waterSkySun = waterVisibleSun * inversesqrt(max(dot(waterVisibleSun, waterVisibleSun), 1e-8));
  float waterSkySunLobe = max(dot(waterSkyRay, waterSkySun), 0.0);
  waterSkyMirror += pow(max(waterSunColour, vec3(0.0)), vec3(2.2))
    * (pow(waterSkySunLobe, 24.0) * 0.18 * smoothstep(-0.02, 0.06, waterSkySun.y));
  // A mirror never returns more than the sky gives, and a near-white sunset horizon is held under
  // this ceiling so a grazing lake keeps some of its own colour instead of washing out.
  float waterSkyLuma = dot(waterSkyMirror, vec3(0.2126, 0.7152, 0.0722));
  waterSkyMirror *= min(1.0, ${glslNumber(WATER_SKY_MIRROR_MAX)} / max(waterSkyLuma, 1e-4));
  float waterSkyFacing = clamp(dot(waterSkyNormal, waterSkyView), 0.0, 1.0);
  float waterSkyFresnel = min(0.02 + 0.98 * pow(1.0 - waterSkyFacing, 5.0), ${glslNumber(WATER_SKY_REFLECTION_STRENGTH)});
  // Only a surface seen from above mirrors the sky. A liquid plane above the eye (a lake level
  // with a camera on the lower shore) must stay as translucent as the unlit surface was.
  float waterSkyAbove = smoothstep(0.0, 0.03, dot(waterSkyView, waterSkyUp));
  float waterSkyAmount = waterSkyFresnel * waterSkyAbove * (1.0 - clamp(waterUnderwater, 0.0, 1.0));
  // Layered over the translucent body, not blended into it: final = F sky + (1 - F) (a body +
  // (1 - a) bed), so the reflection hides the bed only in proportion to its own strength.
  float waterSkyBodyAlpha = diffuseColor.a;
  float waterSkyAlpha = waterSkyAmount + (1.0 - waterSkyAmount) * waterSkyBodyAlpha;
  outgoingLight = (waterSkyMirror * waterSkyAmount + outgoingLight * ((1.0 - waterSkyAmount) * waterSkyBodyAlpha))
    / max(waterSkyAlpha, 1e-4);
  diffuseColor.a = waterSkyAlpha;
`;
}

/** Capillary roughness under every drawn ripple (slope variance per axis). */
export const WATER_GLITTER_MICRO_VARIANCE = 0.0025;
/** Asymptote of a glint's radiance in multiples of the sun colour, approached as L / (1 + L / peak). */
export const WATER_GLITTER_PEAK = 1.2;

/**
 * Sun glints as a microfacet reflection of the visible sun: the slope a facet needs to mirror the
 * sun into this pixel, against the slope the drawn ripples give it, through a Gaussian as wide as the
 * capillary roughness plus the ripples too fine to draw here. Near, where every octave is drawn, the
 * lobe is narrow and the surface breaks into separate sparkles; far and at grazing angles the
 * unresolved slopes widen it into the smooth glitter path, which lengthens toward the camera as the
 * sun drops. Radiance approaches its ceiling softly, so the core of the path keeps its gradient
 * instead of clipping into a flat column.
 */
const WATER_SUN_GLITTER_GLSL = `
  if (waterUnderwater < 0.5) {
    vec3 glitterViewRaw = cameraPosition - vWaterWorldPosition;
    vec3 glitterView = glitterViewRaw * inversesqrt(max(dot(glitterViewRaw, glitterViewRaw), 1e-8));
    vec3 glitterSun = waterVisibleSun * inversesqrt(max(dot(waterVisibleSun, waterVisibleSun), 1e-8));
    vec3 glitterHalfRaw = glitterView + glitterSun;
    vec3 glitterHalf = glitterHalfRaw * inversesqrt(max(dot(glitterHalfRaw, glitterHalfRaw), 1e-8));
    float glitterCosH = max(glitterHalf.y, 0.05);
    vec2 glitterNeed = -glitterHalf.xz / glitterCosH;
    vec3 glitterFacetRaw = waterSurfaceNormal + vec3(-waterRipple.x, 0.0, -waterRipple.y);
    vec2 glitterHave = -glitterFacetRaw.xz / max(glitterFacetRaw.y, 0.2);
    float glitterVariance = waterRipple.z + ${glslNumber(WATER_GLITTER_MICRO_VARIANCE)};
    vec2 glitterMiss = glitterNeed - glitterHave;
    float glitterCosH2 = glitterCosH * glitterCosH;
    float glitterFacet = exp(-0.5 * dot(glitterMiss, glitterMiss) / glitterVariance)
      / (6.2831853 * glitterVariance * glitterCosH2 * glitterCosH2);
    float glitterFresnel = 0.02 + 0.98 * pow(1.0 - clamp(dot(glitterView, glitterHalf), 0.0, 1.0), 5.0);
    float glitterRadiance = 3.14159265 * glitterFacet * glitterFresnel / (4.0 * max(glitterView.y, 0.25));
    vec3 glitterSunLinear = pow(max(waterSunColour, vec3(0.0)), vec3(2.2));
    vec3 glitter = glitterSunLinear
      * (glitterRadiance / (1.0 + glitterRadiance / ${glslNumber(WATER_GLITTER_PEAK)}) * smoothstep(-0.02, 0.06, glitterSun.y));
    // A reflection sits on the surface, not in the body: premultiplied by the body's alpha.
    outgoingLight += glitter / max(diffuseColor.a, 0.35);
  }
`;

/** Water and ocean: the hue is the zone's band colour, the strip's alpha only rides it as ripple. */
const WATER_LIQUID_COLOUR_GLSL = `float liquidRipple = 0.70 + 0.60 * sampledDiffuseColor.a;
      diffuseColor.rgb *= liquidBody * liquidRipple;`;
/**
 * 06.10-render-fix: magma and slime are their strip's own colour. Their BLPs carry the hue (the
 * strips measure about rgb 173/20/0 for lava, 64/124/17 for slime, alpha 255 throughout), while the
 * band colour stays the white stand-in; the water line above threw the strip RGB away, so every
 * lava, slime, green lava and orange slime surface drew as white × ripple — a white sheet.
 */
const GLOWING_LIQUID_COLOUR_GLSL = `diffuseColor.rgb *= liquidBody * sampledDiffuseColor.rgb;`;

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
export function buildLiquidMaterial(surface: LiquidSurface, strip: LiquidStrip): LiquidMaterial {
  // 05.10-A7b-8: one program per class; a family differs only in its strip.
  const liquidClass = liquidSurfaceClass(surface);
  const glowing = liquidClass === "magma" || liquidClass === "slime";
  const uniforms: LiquidMaterialUniforms = {
    liquidFrame: { value: 0 },
    liquidFrames: { value: strip.frames },
    liquidShallowAlpha: { value: glowing ? 1 : WATER_MIN_SHALLOW_ALPHA },
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
    // A liquid sheet is a height field: from any eye no two of its triangles overlap on screen
    // with opposite facings, so three's back-then-front two-pass draw of a transparent two-sided
    // material composites exactly as one unculled pass does — minus the second `setProgram`
    // re-derivation it costs on every draw of every frame. See `ParticleRender.ts`.
    forceSinglePass: true,
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
      // Colour from the water bands. The strip's RGB is unpacked BLP noise — grey, high
      // variance, no water in it — so adding it only lifts everything towards milk. The real
      // wave signal is the strip's alpha, which spans the full 0..1: ripple brightness rides
      // on it around the authored hue, and the surface alpha breathes with it too.
      vec3 liquidBody = mix(liquidShallowColour, liquidDeepColour, liquidDepthMix);
      ${glowing ? GLOWING_LIQUID_COLOUR_GLSL : WATER_LIQUID_COLOUR_GLSL}
      diffuseColor.a *= mix(liquidShallowAlpha, liquidDeepAlpha, liquidDepthMix)
        * mix(${WATER_TEXTURE_ALPHA_FLOOR}, 1.0, sampledDiffuseColor.a);
    `);
  };
  material.customProgramCacheKey = () => `liquid-${liquidClass}`;
  return { material, uniforms };
}

/** Points a liquid material at the frame this moment falls on, and at the zone's own water. */
export function updateLiquidMaterial(liquid: LiquidMaterial, surface: LiquidSurface,
  sample: LightSample | undefined, seconds: number): void {
  const liquidClass = liquidSurfaceClass(surface); // 05.10-A7b-8: no allocation
  liquid.uniforms.liquidFrame.value =
    Math.floor(seconds * LIQUID_FRAMES_PER_SECOND) % liquid.uniforms.liquidFrames.value;
  if (!sample || liquidClass === "magma" || liquidClass === "slime") return;
  const ocean = liquidClass === "ocean";
  const shallow = ocean ? sample.oceanShallowAlpha : sample.waterShallowAlpha;
  const deep = ocean ? sample.oceanDeepAlpha : sample.waterDeepAlpha;
  liquid.uniforms.liquidShallowAlpha.value = Math.min(1, Math.max(WATER_MIN_SHALLOW_ALPHA, shallow));
  liquid.uniforms.liquidDeepAlpha.value = Math.min(1, Math.max(WATER_MIN_DEEP_ALPHA, deep));
  // The surface texture's RGB is unpacked noise with a mid-grey mean — measured 45/255 on
  // water, 86/255 on ocean — so all of the hue comes from here. The file keeps a close and a
  // far colour for each of ocean and river; the shallows take the close one and the depths the
  // far one, over the same ramp the opacity uses.
  const close = ocean ? sample.colours.oceanClose : sample.colours.riverClose;
  const far = ocean ? sample.colours.oceanFar : sample.colours.riverFar;
  liquid.uniforms.liquidShallowColour.value.setRGB(close.r, close.g, close.b, THREE.SRGBColorSpace);
  liquid.uniforms.liquidDeepColour.value.setRGB(far.r, far.g, far.b, THREE.SRGBColorSpace);
}
