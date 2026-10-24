import * as THREE from "three";
import { lightingClassicLook } from "./LightingQuality.js";
import { OP_MOD, OP_OPAQUE, decodeShaderId } from "./M2Combiners.js";
import {
  ReliefSwitch, absoluteReliefUrl, injectReliefShape, injectReliefSun, reliefChunks, type ReliefLook,
} from "./ReliefShader.js";
import {
  WMO_RELIEF_CAVITY, WMO_RELIEF_LOCAL_SPAN, WMO_RELIEF_NORMAL_MAX_TILT, WMO_RELIEF_NORMAL_STRENGTH,
  WMO_RELIEF_SKY, WMO_RELIEF_SUN_FACING, WMO_RELIEF_SUN_GAIN, WMO_RELIEF_SUN_RANGE,
  WMO_RELIEF_WALL_TILT,
} from "./WmoReliefShader.js";
import { WMO_RELIEF_FLAT, WmoReliefMaps, type WmoReliefMapStats } from "./WmoReliefMaps.js";
import { deriveWmoReliefAsync } from "./WmoReliefWorker.js";
import {
  BLEND_OPAQUE, MATERIAL_BILLBOARD, MATERIAL_UNLIT, TEXTURE_TYPE_OWN, TEXTURE_WRAP_X, TEXTURE_WRAP_Y,
  type WvmBatch, type WvmModel, type WvmTextureSlot,
} from "./Wvm.js";

/**
 * 23.10 (7.47 stage 3): «Объём предметов» — the buildings' relief (stage 2) on the world's M2
 * doodads: rocks and cliffs, tree trunks, fences, barrels, crates, carts, statues, furniture.
 *
 * Which batches. Decided by what the batch is, never by its file name (stage 2 found name lists
 * useless): opaque (blend mode 0 — alpha-keyed batches are the foliage cards and the atlases that
 * mix a trunk or a box with leaves and flowers: 42–98 % of their texels opaque, no per-texture
 * answer), lit (no F_UNLIT, not a billboard), one self-named texture on UV set 0 drawn as plain
 * Opaque or Mod (no second stage, no sphere/environment map: the metal of weapon racks, lamps'
 * glass), no texture transform (flowing water, scrolling runes). The texture's band-passed contrast
 * must then clear the buildings' floor (`WMO_RELIEF_MIN_CONTRAST`), answered by the relief worker:
 * a flat texture gets no map and stays as drawn. Units (characters, creatures, items, mounts) never
 * ask: only the renderer's scenery builds set {@link M2ReliefBuild} (`WorldRenderer3D.#wvmNode`).
 * Over the bench cache (Elwynn, Goldshire, Stormwind, Durotar; `docs/WORK_PLAN.ru.md` 7.47) the rule
 * admits 51–78 % of the doodads' drawn triangles.
 *
 * How. The stage-2 program (`ReliefShader.ts`) with this stage's {@link M2_RELIEF_LOOK}: the depth is
 * a share of the texture's own repeat in yards, measured per pixel from the UV's screen derivatives,
 * so a 2-yard barrel and a 12-yard cliff each get a depth to their texel size. The shape half is in
 * the material's own chain (before the world light), so a locally lit indoor copy keeps it; the sun
 * half goes after the world light. The program key is set when the material is built and the map
 * arrives as a uniform (a 1×1 stand-in and a switch at 0 until then), so nothing recompiles while
 * playing; instanced copies share the material and so its uniforms.
 *
 * Toggling. The leaf is part of the doodads' build key (`WorldRenderer3D.#doodadBuildKey`): turning
 * it on or off rebuilds the placed doodads once, as the wind leaf does; off (and on the classic
 * lighting levels) every build is exactly what it was.
 */

/** 23.10 (7.47 stage 3): bumped when the injected program changes; part of the program key. */
export const M2_RELIEF_PROFILE_VERSION = 1;
export const M2_RELIEF_MARKER = `m2-relief-v${M2_RELIEF_PROFILE_VERSION}`;
/**
 * 23.10 (7.47 stage 3): the march's depth in UV units of the texture, and its cap in yards. A doodad
 * texture is an atlas — islands, not a repeat — so the march's shift (up to 1/0.3 of the depth at a
 * grazing view) must stay well inside an island: three quarters of the buildings' depth.
 */
export const M2_RELIEF_DEPTH_UV = 0.015;
export const M2_RELIEF_DEPTH_MAX = 0.06;

/** 23.10 (7.47 stage 3): the share of the sun a doodad's own relief may shade (the buildings' is 0.6). */
export const M2_RELIEF_SHADOW_STRENGTH = 0.45;

/** 23.10 (7.47 stage 3): the doodads' relief numbers (the buildings' shading, a shallower march). */
export const M2_RELIEF_LOOK: ReliefLook = Object.freeze({
  marker: M2_RELIEF_MARKER,
  depthUv: M2_RELIEF_DEPTH_UV,
  depthMax: M2_RELIEF_DEPTH_MAX,
  normalStrength: WMO_RELIEF_NORMAL_STRENGTH,
  normalMaxTilt: WMO_RELIEF_NORMAL_MAX_TILT,
  wallTilt: WMO_RELIEF_WALL_TILT,
  cavity: WMO_RELIEF_CAVITY,
  sky: WMO_RELIEF_SKY,
  localSpan: WMO_RELIEF_LOCAL_SPAN,
  // A doodad is often seen magnified (a 256² texture over a 3-yard rock, a yard away): the shading's
  // neighbourhood is held at the span in texels of the map, not just in pixels.
  localFloor: true,
  // The factors scale the neighbourhood's mean colour, not the texel: the stills' mean drifted +2–3 % without.
  keepMean: true,
  // Softer than the buildings' 0.6: a magnified rock's hollows read as holes at full strength.
  shadowStrength: M2_RELIEF_SHADOW_STRENGTH,
  sunGain: WMO_RELIEF_SUN_GAIN,
  sunRange: WMO_RELIEF_SUN_RANGE,
  sunFacing: WMO_RELIEF_SUN_FACING,
});

const M2_CHUNKS = reliefChunks(M2_RELIEF_LOOK);

/** 23.10 (7.47 stage 3): what a scenery build asks of `buildModel` while the leaf is active. */
export interface M2ReliefBuild {
  readonly enabled: true;
}

/** 23.10 (7.47 stage 3): the one value a scenery build passes while the leaf is active. */
export const M2_RELIEF_BUILD: M2ReliefBuild = Object.freeze({ enabled: true });

export type M2ReliefRejection =
  | "blend" | "unlit" | "billboard" | "slot" | "uv-set" | "layers" | "combiner" | "uv-animated";

/**
 * 23.10 (7.47 stage 3): why a batch gets no relief, or `undefined` when it may (the texture's
 * contrast is still to be answered by the worker). See the file comment.
 */
export function m2BatchReliefRejection(
  model: Pick<WvmModel, "textures" | "textureTransforms" | "shaderIdsResolved">,
  batch: Pick<WvmBatch, "blendMode" | "materialFlags" | "textures" | "uvSets" | "shaderId" | "textureTransform">,
): M2ReliefRejection | undefined {
  if (batch.blendMode !== BLEND_OPAQUE) return "blend";
  if ((batch.materialFlags & MATERIAL_UNLIT) !== 0) return "unlit";
  if ((batch.materialFlags & MATERIAL_BILLBOARD) !== 0) return "billboard";
  const slot: WvmTextureSlot | undefined = model.textures[batch.textures[0] ?? -1];
  if (!slot || slot.type !== TEXTURE_TYPE_OWN || !slot.path) return "slot";
  if ((batch.uvSets[0] ?? 0) !== 0) return "uv-set";
  if (batch.textures.some((texture, unit) => unit > 0 && texture >= 0)) return "layers";
  if (model.shaderIdsResolved === true) {
    const stages = decodeShaderId(batch.shaderId);
    // A 0x8000 special id, a sphere-mapped stage, or a first stage that is not plain colour.
    if (!stages || stages.sphere0 || (stages.op0 !== OP_OPAQUE && stages.op0 !== OP_MOD)) return "combiner";
  }
  if (model.textureTransforms[batch.textureTransform] !== undefined) return "uv-animated";
  return undefined;
}

/** 23.10 (7.47 stage 3): the leaf on the levels that may draw it — never the classic ones. */
export function m2ReliefActive(enabled: boolean, lightingQuality: number): boolean {
  return enabled && !lightingClassicLook(lightingQuality);
}

/** 23.10 (7.47 stage 3): the build-key prefix of a scenery build made while the leaf is active. */
export const M2_RELIEF_BUILD_PREFIX = "m2-relief|";

/**
 * 23.10 (7.47 stage 3): released doodad maps kept for a quick rebuild — doodads come and go with
 * range far more often than buildings. ≤ 128² RGBA each: 128 × 64 KB = 8 MB CPU at most.
 */
export const M2_RELIEF_RETAIN = 128;

/** A map clamps where its texture does: an atlas island's edge must not pull in the opposite edge. */
const CLAMP_SUFFIX = "#clamp";

let maps: WmoReliefMaps | undefined;

/** 23.10 (7.47 stage 3): the doodads' maps of this thread (tests may hand in their own before the first use). */
export function m2ReliefMaps(replacement?: WmoReliefMaps): WmoReliefMaps {
  if (replacement) maps = replacement;
  maps ??= new WmoReliefMaps(
    (key) => deriveWmoReliefAsync(key.endsWith(CLAMP_SUFFIX) ? key.slice(0, -CLAMP_SUFFIX.length) : key),
    M2_RELIEF_RETAIN,
    prepareM2ReliefTexture,
  );
  return maps;
}

/** 23.10 (7.47 stage 3): the map key of a texture URL and its slot's wrap flags. */
export function m2ReliefMapKey(url: string, slotFlags: number): string {
  const absolute = absoluteReliefUrl(url);
  return (slotFlags & (TEXTURE_WRAP_X | TEXTURE_WRAP_Y)) === (TEXTURE_WRAP_X | TEXTURE_WRAP_Y)
    ? absolute : `${absolute}${CLAMP_SUFFIX}`;
}

/** 23.10 (7.47 stage 3): the clamping half of the key, applied to a new map's texture. */
export function prepareM2ReliefTexture(key: string, texture: THREE.DataTexture): void {
  if (!key.endsWith(CLAMP_SUFFIX)) return;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
}

interface M2ReliefBinding {
  readonly relief: { value: THREE.Texture };
  readonly on: ReliefSwitch;
  release?: (() => void) | undefined;
  sun: boolean;
}

const BINDINGS = new WeakMap<THREE.Material, M2ReliefBinding>();
const LIVE = new Set<M2ReliefBinding>();

function pristine(material: THREE.Material): boolean {
  return material.onBeforeCompile === THREE.Material.prototype.onBeforeCompile
    && material.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey;
}

/**
 * 23.10 (7.47 stage 3): the shape half on a doodad batch's material, as it is built (after its own
 * second-layer/fog steps, before the world light). `slotFlags` are the texture slot's wrap flags.
 * Returns false when the material already has it.
 */
export function installM2ReliefShape(material: THREE.Material, url: string, slotFlags: number): boolean {
  if (BINDINGS.has(material)) return false;
  const previousCompile = material.onBeforeCompile;
  // Evaluated before the wrap: the default key is the handler's own source (`WorldLighting.ts` does the same).
  const previousKey = pristine(material) ? "" : material.customProgramCacheKey();
  const binding: M2ReliefBinding = { relief: { value: WMO_RELIEF_FLAT }, on: new ReliefSwitch(), sun: false };
  BINDINGS.set(material, binding);
  LIVE.add(binding);
  const lit = material instanceof THREE.MeshStandardMaterial;
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms["wmoRelief"] = binding.relief;
    shader.uniforms["wmoReliefOn"] = binding.on;
    injectReliefShape(shader, M2_CHUNKS, lit);
  };
  const key = `${previousKey}|${M2_RELIEF_MARKER}`;
  material.customProgramCacheKey = () => key;
  // A map already derived (shared or retained) is bound before the first draw, at full strength;
  // one that arrives later fades in.
  let acquiring = true;
  binding.release = m2ReliefMaps().acquire(m2ReliefMapKey(url, slotFlags), (texture) => {
    binding.relief.value = texture;
    binding.on.arrive(!acquiring);
  });
  acquiring = false;
  const dispose = () => {
    material.removeEventListener("dispose", dispose);
    LIVE.delete(binding);
    binding.release?.();
    binding.release = undefined;
  };
  material.addEventListener("dispose", dispose);
  return true;
}

/**
 * 23.10 (7.47 stage 3): the sun half, wrapped after the world light on a material that has the
 * shape. A copy rebuilt from the chain before the world light (a locally lit indoor doodad) drops
 * it with the world light, and keeps the shape.
 */
export function installM2ReliefSun(material: THREE.Material): boolean {
  const binding = BINDINGS.get(material);
  if (!binding || binding.sun) return false;
  binding.sun = true;
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    injectReliefSun(shader, M2_CHUNKS);
  };
  const key = `${previousKey}|${M2_RELIEF_MARKER}:sun`;
  material.customProgramCacheKey = () => key;
  return true;
}

/** 23.10 (7.47 stage 3): whether the material draws doodad relief (tests and diagnostics). */
export function m2ReliefDrawing(material: THREE.Material): boolean {
  return BINDINGS.has(material);
}

/** 23.10 (7.47 stage 3): whether the material's relief map has arrived (tests and diagnostics). */
export function m2ReliefMapReady(material: THREE.Material): boolean {
  return BINDINGS.get(material)?.on.arrived === true;
}

export interface M2ReliefStats extends WmoReliefMapStats {
  /** Live doodad materials drawing the relief, and those whose map has arrived. */
  readonly drawing: number;
  readonly withMap: number;
}

/** 23.10 (7.47 stage 3): the leaf's state in this thread (the bench hook and the report). */
export function m2ReliefStats(): M2ReliefStats {
  let withMap = 0;
  for (const binding of LIVE) if (binding.on.arrived) withMap++;
  return { drawing: LIVE.size, withMap, ...m2ReliefMaps().stats };
}
