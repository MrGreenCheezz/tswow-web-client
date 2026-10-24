import * as THREE from "three";
import { lightingClassicLook } from "./LightingQuality.js";
import {
  RELIEF_FADE_IN_MS, ReliefSwitch, absoluteReliefUrl, injectReliefShape, injectReliefSun, reliefChunks, setReliefClock,
  type ReliefLook,
} from "./ReliefShader.js"; // 23.10 (7.47 stage 3)
import { RELIEF_STRENGTH, RELIEF_STRENGTH_UNIFORM } from "./ReliefStrength.js"; // 24.10 (7.47)
import { WMO_MATERIAL_SIDN, WMO_MATERIAL_WINDOW } from "./WmoMaterials.js";
import { WMO_RELIEF_FLAT, WmoReliefMaps, type WmoReliefMapStats } from "./WmoReliefMaps.js";

/**
 * 22.10 (7.47 stage 2): «Объём зданий» — the ground's relief (stage 1, `TerrainReliefShader.ts`) on
 * building surfaces: stone walls, cobbles, brick, roof tiles, planks.
 *
 * Which runs. The WMO artifact names its textures by URL only (`/visual/texture/<hash>-<n>.png`), so
 * there is no path to match an allowlist against at run time; what decides is what the run is and
 * what its texture holds. A run gets relief when it is opaque (blend mode 0: no alpha test, no
 * blending), not clamped (0x40/0x80: trims and decals), not a window (MOMT 0x20, or 0x10, the
 * night-lit glass), not an environment-mapped or Composite look, not drawn unlit (F_UNLIT exterior
 * glass) — and its texture's band-passed contrast clears `WMO_RELIEF_MIN_CONTRAST`
 * (`WmoReliefDerive.ts`). A name list would not do even with the paths: Blizzard names these
 * textures by part, not material (MM_STRMWND_WALL_05, _TRIM_02, MM_STREET_02, MM_MM_SIDEWALK_01,
 * _SUPPORTS_01), so «stone|cobble|brick|rock|plank|roof|tile» covers 7.5 % of Stormwind's drawn
 * triangles and this rule 96 % — everything but the clamped lamps, the windows, banners and rugs.
 *
 * How. WMO UVs are not planar, so the tangent frame comes from the screen derivatives of the view
 * position and the UV (the cotangent frame: ∇u and ∇v on the face's plane, in UV per yard). The
 * depth is {@link WMO_RELIEF_DEPTH_UV} of a texture repeat, at most {@link WMO_RELIEF_DEPTH_MAX}
 * yards — gentler than the ground, since walls are mostly seen at a grazing angle. The march, the
 * steps and the distance fade are the ground's: 5–10 steps, full to 35 yards, none past 85, nothing
 * below a 9° view; the march's shift is capped at 1/0.3 of the depth, so a silhouette never swims.
 * Every run darkens its joints (cavity) and lights the stones' upturned faces from overhead (sky):
 * the shape in the shade and in rooms (MOCV-lit, no sun). A lit run (exterior, transition) also
 * takes the derived normal into the sun's N·L — only there, not the rim or fill — and the soft sun
 * self-shadow.
 *
 * Program keys. A material is bound when it is built (or when the leaf turns on), with its key
 * {@link WMO_RELIEF_MARKER}; its map arrives later through a uniform — a 1×1 flat stand-in and a
 * switch at 0 until then — so the program never changes while playing. Off, or on a classic level
 * (lighting quality 0 and the comparison level 3), nothing is wrapped and every program is exactly
 * what it was.
 */

/** 22.10 (7.47 stage 2): bumped when the injected program changes; part of the cache key. */
export const WMO_RELIEF_PROFILE_VERSION = 2; // 22.10 (7.47): v2 — the shading's tilt, the sun as a factor, cavity and sky
export const WMO_RELIEF_MARKER = `wmo-relief-v${WMO_RELIEF_PROFILE_VERSION}`;
/**
 * 22.10 (7.47 stage 2): the relief's depth in UV units of the run's texture (the ground's is 0.03).
 * 22.10 (7.47): kept — the march was not why the buildings read flat (the shading was, see
 * {@link WMO_RELIEF_WALL_TILT}); 0.025 under a 0.11-yard cap read no better in the stills and stepped
 * along the wall tops.
 */
export const WMO_RELIEF_DEPTH_UV = 0.02;
/** 22.10 (7.47 stage 2): and never deeper than this, in yards (≈ 7 cm), however large the texture's repeat. */
export const WMO_RELIEF_DEPTH_MAX = 0.08;
/** 22.10 (7.47): the share of the sun term a stone's own shadow may take (stage 2: 0.5; the ground's too is 0.6). */
export const WMO_RELIEF_SHADOW_STRENGTH = 0.6;
/**
 * 22.10 (7.47): the joints' cavity — the light factor is 1 ± this × the height against its
 * neighbourhood (×2, clamped to ±1): a joint darker, a crown lighter, the face's mean kept (a
 * darkening-only cavity took 6 % off a Stormwind wall). What reads in the shade and in rooms, where
 * there is no sun for the tilt to shape.
 */
export const WMO_RELIEF_CAVITY = 0.35;
/** 22.10 (7.47): the neighbourhood the shading terms measure the height against, in texels of the map (a mip ≈ 4 levels up). */
export const WMO_RELIEF_LOCAL_SPAN = 16;
/**
 * 22.10 (7.47): the overhead light's share by the stone's own tilt — a face turned up is lighter, one
 * turned down darker (± this times the tilt's upward part). The shade's and the rooms' direction.
 */
export const WMO_RELIEF_SKY = 0.4;
/**
 * 22.10 (7.47): the derived normal's tilt over the one the depth implies, and its cap (tangent of the
 * tilt). Stage 2 put the tilted normal into `normal`, which the world light's rim and fill also read
 * (`pow( 1 - N·V, 3 )` against the cool ambient): the steep joints took a sky-blue rim, and the cure
 * was half strength under a ≈ 17° cap — flat. The tilt now reaches the sun's N·L alone,
 * as a hue-neutral factor on the colour (`SUN` below); the rim, the fill and the lamps keep the
 * face's own normal, so the full slope the depth implies is safe, capped at ≈ 31° for smooth stones.
 */
export const WMO_RELIEF_NORMAL_STRENGTH = 1.0;
export const WMO_RELIEF_NORMAL_MAX_TILT = 0.6;
/**
 * 22.10 (7.47): a wall's tilt (tangent) where the height stands ±0.5 off its neighbourhood. Building textures
 * are painted lit from above — a light top edge, a dark lower one, a face shaded top to bottom — so
 * the brightness' slope across a face runs against its shape: the height's normal turned every face
 * down, and under a high sun the relief undid the painted light (local contrast 8.8 → 8.1 on a
 * Stormwind wall: why stage 2 read flat). On an upright face the tilt is the shading's instead —
 * brighter than the mean leans up the face, darker down — which agrees with the paint
 * and needs no slope at all, so it stays as smooth as the height. Floors (cobbles, painted from
 * above) keep the height's slope, as the ground does.
 */
export const WMO_RELIEF_WALL_TILT = 0.7;
/** 22.10 (7.47): the relief's sun factor — its gain over the N·L difference, and how far from one it may go. */
export const WMO_RELIEF_SUN_GAIN = 1.0;
export const WMO_RELIEF_SUN_RANGE = 0.5;
/** 22.10 (7.47): the face's own N·L at which its relief takes the whole sun factor (none at 0). */
export const WMO_RELIEF_SUN_FACING = 0.2;

export type WmoReliefVariant = "lit" | "room";

export interface WmoReliefRun {
  readonly url: string;
  readonly blendMode: number;
  readonly materialFlags: number;
  /** Drawn by the unlit program (F_UNLIT honoured): no light for the relief to shape. */
  readonly unlit: boolean;
  /** 0x40/0x80 clamp. */
  readonly clamped: boolean;
  /** The run's look samples an environment map or a second layer (`WmoRunLook.ts`). */
  readonly envOrComposite: boolean;
  /** Drawn as a room's inside: MeshBasicMaterial × MOCV, no sun. */
  readonly interior: boolean;
}

/** 22.10 (7.47 stage 2): which relief a run gets, if any (see the file comment). */
export function wmoRunReliefVariant(run: WmoReliefRun): WmoReliefVariant | undefined {
  if (!run.url || run.blendMode !== 0 || run.unlit || run.clamped || run.envOrComposite) return undefined;
  if ((run.materialFlags & (WMO_MATERIAL_WINDOW | WMO_MATERIAL_SIDN)) !== 0) return undefined;
  return run.interior ? "room" : "lit";
}

/** 22.10 (7.47 stage 2): the leaf on the levels that may draw it — never the classic ones. */
export function wmoReliefActive(enabled: boolean, lightingQuality: number): boolean {
  return enabled && !lightingClassicLook(lightingQuality);
}

/** 22.10 (7.47 stage 2): the depth (yards) the shader marches for a texture repeating every `yardsPerRepeat`. */
export function wmoReliefDepth(yardsPerRepeat: number): number {
  return Math.min(WMO_RELIEF_DEPTH_UV * Math.max(0, yardsPerRepeat), WMO_RELIEF_DEPTH_MAX);
}

type ShaderSource = Parameters<THREE.Material["onBeforeCompile"]>[0];
type ShaderRenderer = Parameters<THREE.Material["onBeforeCompile"]>[1];

/** 23.10 (7.47 stage 3): stage 2's numbers as a look of the shared relief program (`ReliefShader.ts`). */
export const WMO_RELIEF_LOOK: ReliefLook = Object.freeze({
  marker: WMO_RELIEF_MARKER,
  depthUv: WMO_RELIEF_DEPTH_UV,
  depthMax: WMO_RELIEF_DEPTH_MAX,
  normalStrength: WMO_RELIEF_NORMAL_STRENGTH,
  normalMaxTilt: WMO_RELIEF_NORMAL_MAX_TILT,
  wallTilt: WMO_RELIEF_WALL_TILT,
  cavity: WMO_RELIEF_CAVITY,
  sky: WMO_RELIEF_SKY,
  localSpan: WMO_RELIEF_LOCAL_SPAN,
  shadowStrength: WMO_RELIEF_SHADOW_STRENGTH,
  sunGain: WMO_RELIEF_SUN_GAIN,
  sunRange: WMO_RELIEF_SUN_RANGE,
  sunFacing: WMO_RELIEF_SUN_FACING,
});

const WMO_CHUNKS = reliefChunks(WMO_RELIEF_LOOK);

/**
 * 22.10 (7.47 stage 2): injects the relief into a compiled WMO run program. A cosmetic leaf never
 * breaks a compile: without its markers exactly once, the program is left as it was.
 * 23.10 (7.47 stage 3): the program text now lives in `ReliefShader.ts` (the doodads share it).
 */
export function injectWmoRelief(shader: ShaderSource, variant: WmoReliefVariant): void {
  if (!injectReliefShape(shader, WMO_CHUNKS, variant === "lit")) return;
  // Outside the world light (no sun term to find) a lit run keeps the cavity and the sky alone.
  if (variant === "lit") injectReliefSun(shader, WMO_CHUNKS);
}

interface WmoReliefBinding {
  readonly previousCompile: (shader: ShaderSource, renderer: ShaderRenderer) => void;
  readonly previousKey: () => string;
  readonly variant: WmoReliefVariant;
  /** Shared by every program this material compiles, so a program reused from its cache still finds them. */
  readonly relief: { value: THREE.Texture };
  readonly on: ReliefSwitch;
  active: boolean;
  release?: (() => void) | undefined;
}

interface Tracked {
  readonly url: string;
  readonly variant: WmoReliefVariant;
}

/** 23.10 (7.47): a map that arrives after the material is drawn fades in over this, not pops. */
export const WMO_RELIEF_FADE_IN_MS = RELIEF_FADE_IN_MS;

/** 23.10 (7.47): the fade-in's clock (tests hand in their own); shared with the doodads' relief. */
export function setWmoReliefClock(now: () => number): void {
  setReliefClock(now);
}

const TRACKED = new Map<THREE.Material, Tracked>();
const BINDINGS = new WeakMap<THREE.Material, WmoReliefBinding>();
let reliefActive = false;
let maps: WmoReliefMaps | undefined;

/** 22.10 (7.47 stage 2): the maps of this thread (tests may hand in their own before the first use). */
export function wmoReliefMaps(replacement?: WmoReliefMaps): WmoReliefMaps {
  if (replacement) maps = replacement;
  maps ??= new WmoReliefMaps();
  return maps;
}

const absoluteUrl = absoluteReliefUrl;

function setBound(material: THREE.Material, tracked: Tracked, active: boolean): boolean {
  let binding = BINDINGS.get(material);
  if (!binding) {
    // An off request for a material that never had the hook wraps nothing: its program stays as it was.
    if (!active) return false;
    const created: WmoReliefBinding = {
      previousCompile: material.onBeforeCompile,
      previousKey: material.customProgramCacheKey.bind(material),
      variant: tracked.variant,
      relief: { value: WMO_RELIEF_FLAT },
      on: new ReliefSwitch(),
      active: false,
    };
    BINDINGS.set(material, created);
    material.onBeforeCompile = (shader, renderer) => {
      created.previousCompile.call(material, shader, renderer);
      if (!created.active) return;
      shader.uniforms["wmoRelief"] = created.relief;
      shader.uniforms["wmoReliefOn"] = created.on;
      shader.uniforms[RELIEF_STRENGTH_UNIFORM] = RELIEF_STRENGTH; // 24.10 (7.47): «Сила объёма», one value for every program
      injectWmoRelief(shader, created.variant);
    };
    material.customProgramCacheKey = () => created.active
      ? `${created.previousKey()}|${WMO_RELIEF_MARKER}:${created.variant}`
      : created.previousKey();
    binding = created;
  }
  if (binding.active === active) return false;
  binding.active = active;
  material.needsUpdate = true;
  if (active) {
    const held = binding;
    // 23.10 (7.47): a map already derived (shared or retained) is bound before the first draw, at
    // full strength; one that arrives later fades in.
    let acquiring = true;
    held.release = wmoReliefMaps().acquire(absoluteUrl(tracked.url), (texture) => {
      held.relief.value = texture;
      held.on.arrive(!acquiring);
    });
    acquiring = false;
  } else {
    binding.release?.();
    binding.release = undefined;
    binding.relief.value = WMO_RELIEF_FLAT;
    binding.on.clear();
  }
  return true;
}

function untrack(event: { target: THREE.Material }): void {
  const material = event.target;
  material.removeEventListener("dispose", untrack);
  TRACKED.delete(material);
  const binding = BINDINGS.get(material);
  if (binding) {
    binding.release?.();
    binding.release = undefined;
  }
}

/**
 * 22.10 (7.47 stage 2): a WMO run material that may draw relief (`wmoRunReliefVariant`), from its
 * build to its disposal. Bound at once when the leaf is active, so its first program already has the
 * relief key; otherwise when the leaf turns on.
 */
export function trackWmoReliefMaterial(material: THREE.Material, url: string, variant: WmoReliefVariant): void {
  if (TRACKED.has(material)) return;
  const tracked = { url, variant };
  TRACKED.set(material, tracked);
  material.addEventListener("dispose", untrack);
  if (reliefActive) setBound(material, tracked, true);
}

/**
 * 22.10 (7.47 stage 2): turns the relief of every tracked material on or off (the renderer's leaf
 * and lighting level). Returns how many programs changed key (each recompiles once on its next draw).
 */
export function setWmoReliefActive(active: boolean): number {
  if (active === reliefActive) return 0;
  reliefActive = active;
  let changed = 0;
  for (const [material, tracked] of TRACKED) if (setBound(material, tracked, active)) changed++;
  if (!active) wmoReliefMaps().trim(); // 23.10 (7.47): off, nothing is kept for a comeback
  return changed;
}

/** 22.10 (7.47 stage 2): whether the material currently draws relief (tests and diagnostics). */
export function wmoReliefDrawing(material: THREE.Material): boolean {
  return BINDINGS.get(material)?.active === true;
}

/** 22.10 (7.47 stage 2): whether the material's relief map has arrived (tests and diagnostics). */
export function wmoReliefMapReady(material: THREE.Material): boolean {
  return BINDINGS.get(material)?.on.arrived === true;
}

export interface WmoReliefStats extends WmoReliefMapStats {
  readonly tracked: number;
  readonly drawing: number;
  readonly withMap: number;
}

/** 22.10 (7.47 stage 2): the leaf's state in this thread (the bench hook and the report). */
export function wmoReliefStats(): WmoReliefStats {
  let drawing = 0;
  let withMap = 0;
  for (const material of TRACKED.keys()) {
    const binding = BINDINGS.get(material);
    if (binding?.active) drawing++;
    if (binding?.active && binding.on.arrived) withMap++;
  }
  return { tracked: TRACKED.size, drawing, withMap, ...wmoReliefMaps().stats };
}
