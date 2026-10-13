/**
 * 13.10 (7.11): what the MOMT flags F_UNLIT (0x1), F_UNFOGGED (0x2) and the two clamp bits (0x40,
 * 0x80) change about how a run is drawn — exactly where Wow.exe 3.3.5a honours them, which is not
 * everywhere it could.
 *
 * Every run carries its record's flag byte (`WmoRun.materialFlags`, all MOMT flags fit it: max 0xF0
 * over the client's 25,034 records), so this needs no artifact change and an old artifact gets it too.
 *
 * Wow.exe picks one of three batch renderers per group (`.runtime/re-2026-10-11/glue-1110/w711-*.txt`):
 * 0x007abf50 calls `*0x00cfbecc` = 0x007ac9f0 for a group whose MOCV buffer exists (group +0x108),
 * else `*0x00cfbec4` = 0x007ac6a0 (set in 0x007ad020); both hand a MOHD 0x2 root (the unified path,
 * root header +0x3c & 2) to 0x007a9380. Per batch each one sets, from the MOMT word `*puVar`:
 *   * the texture's address mode, every path: `0x00681450(tex, ~flags>>6 & 1, ~flags>>7 & 1)` — wrap
 *     S unless 0x40, wrap T unless 0x80;
 *   * the light mode (0x007a8b10; 0 picks the even, unlit vertex program `color = MOCV` via
 *     0x007a84d0, 1/2 the sun's DNInfo colours, 3 the MOHD ambient alone) and fog (0x007a8440, 0 off):
 *       - classic without MOCV (0x007ac6a0), every batch: light `~flags & 1`, fog `~flags & 2`;
 *       - classic with MOCV (0x007ac9f0): F_UNLIT is never read (exterior batches take light 2 under
 *         0x20, else 1; interior ones run unlit anyway), F_UNFOGGED is honoured on every batch;
 *       - unified (0x007a9380): the transition batches honour both; an exterior group (MOGP 0x48)
 *         honours F_UNLIT and keeps its fog on; an interior group ignores both (light 3 or 2).
 * Corpus (the client's own WMOs, `.runtime/re-2026-10-13/7.11/unlit.out.txt`): F_UNLIT reaches a drawn batch
 * 338 times without MOCV (exterior windows: `MM_ELWYNN_WND_EXT__01`, `MM_WINDOWS_16`…) and 165 times
 * in unified exterior groups (lava, Azjol-Nerub's windows); 620 + 48 classic-with-MOCV batches carry
 * the bit and are drawn lit. F_UNFOGGED: 9 batches. Clamp: 1,356 batches.
 *
 * The unlit vertex program has no `+ c[29]` (the night glow) and no sun: its colour is MOCV, and a
 * group without MOCV binds no colour stream; read here as white, the only reading under which the
 * client's exterior windows are not black. A run this renderer already draws as a room's inside is
 * unlit already and is left alone.
 */

import * as THREE from "three";

import { WMO_MATERIAL_CLAMP_S, WMO_MATERIAL_CLAMP_T, WMO_MATERIAL_UNFOGGED, WMO_MATERIAL_UNLIT } from "./WmoMaterials.js";
import {
  WMO_GROUP_HAS_COLOURS, WMO_LIGHT_TRANSITION, wmoRunIsInterior,
  type WmoGroup, type WmoModel, type WmoRun,
} from "./WmoModel.js";

/** MOGP 0x8 (outdoor) or 0x40 (exterior lit): Wow.exe's own test, `(group + 0x30) & 0x48`. */
const WMO_GROUP_EXTERIOR_LIT = 0x48;

export interface WmoRunDrawState {
  /** Drawn without the sun: texture × MOCV (white without MOCV), no night glow. */
  readonly unlit: boolean;
  /** Drawn without fog. */
  readonly unfogged: boolean;
  readonly clampS: boolean;
  readonly clampT: boolean;
}

const PLAIN: WmoRunDrawState = Object.freeze({ unlit: false, unfogged: false, clampS: false, clampT: false });

/** What a run's flags change, by the batch renderer Wow.exe would draw it with. */
export function wmoRunDrawState(
  model: Pick<WmoModel, "vertexLight">,
  group: Pick<WmoGroup, "flags" | "indoor">,
  run: Pick<WmoRun, "materialFlags" | "lighting">,
): WmoRunDrawState {
  const flags = run.materialFlags;
  if ((flags & (WMO_MATERIAL_UNLIT | WMO_MATERIAL_UNFOGGED | WMO_MATERIAL_CLAMP_S | WMO_MATERIAL_CLAMP_T)) === 0) return PLAIN;
  const classic = model.vertexLight === "classic";
  const transition = run.lighting === WMO_LIGHT_TRANSITION;
  const unlitHonoured = classic
    ? (group.flags & WMO_GROUP_HAS_COLOURS) === 0
    : transition || (group.flags & WMO_GROUP_EXTERIOR_LIT) !== 0;
  return {
    unlit: (flags & WMO_MATERIAL_UNLIT) !== 0 && unlitHonoured && !wmoRunIsInterior(group, run),
    unfogged: (flags & WMO_MATERIAL_UNFOGGED) !== 0 && (classic || transition),
    clampS: (flags & WMO_MATERIAL_CLAMP_S) !== 0,
    clampT: (flags & WMO_MATERIAL_CLAMP_T) !== 0,
  };
}

/** The part of a material's cache key a state adds; "" for none, so every other run keeps its key. */
export function wmoRunDrawStateKey(state: WmoRunDrawState): string {
  return state.unlit || state.unfogged ? `wmo-flags-v1:${state.unlit ? "u" : ""}${state.unfogged ? "f" : ""}` : "";
}

/** The geometry attribute an unlit run of a group with MOCV is multiplied by: linear MOCV RGB. */
export const WMO_UNLIT_MOCV_ATTRIBUTE = "wowWmoMocv";

/** Whether a group needs {@link WMO_UNLIT_MOCV_ATTRIBUTE}: an unlit run, and MOCV to read. */
export function wmoGroupNeedsUnlitMocv(
  model: Pick<WmoModel, "vertexLight">,
  group: Pick<WmoGroup, "flags" | "indoor">,
  runs: readonly Pick<WmoRun, "materialFlags" | "lighting">[],
): boolean {
  if ((group.flags & WMO_GROUP_HAS_COLOURS) === 0) return false;
  for (const run of runs) if (wmoRunDrawState(model, group, run).unlit) return true;
  return false;
}

/** MOCV (RGBA bytes, sRGB) as linear RGB floats — what the unlit vertex program passes on. */
export function wmoUnlitMocv(colours: Uint8Array): Float32Array {
  const count = colours.length >> 2;
  const result = new Float32Array(count * 3);
  const lookup = SRGB_LOOKUP;
  for (let vertex = 0; vertex < count; vertex++) {
    result[vertex * 3] = lookup[colours[vertex * 4]!]!;
    result[vertex * 3 + 1] = lookup[colours[vertex * 4 + 1]!]!;
    result[vertex * 3 + 2] = lookup[colours[vertex * 4 + 2]!]!;
  }
  return result;
}

const SRGB_LOOKUP = (() => {
  const values = new Float32Array(256);
  for (let index = 0; index < 256; index++) {
    const value = index / 255;
    values[index] = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }
  return values;
})();

const COLOR_FRAGMENT = "#include <color_fragment>";
const COLOR_VERTEX = "#include <color_vertex>";

/** The replacements an unlit run with MOCV makes, split out for a static GLSL test. */
export const WMO_UNLIT_MOCV_GLSL = Object.freeze({
  vertexPars: /* glsl */ `
attribute vec3 ${WMO_UNLIT_MOCV_ATTRIBUTE};
varying vec3 vWowWmoMocv;
`,
  vertex: /* glsl */ `
${COLOR_VERTEX}
  vWowWmoMocv = ${WMO_UNLIT_MOCV_ATTRIBUTE};
`,
  fragmentPars: /* glsl */ `
varying vec3 vWowWmoMocv;
`,
  fragment: /* glsl */ `
${COLOR_FRAGMENT}
  diffuseColor.rgb *= vWowWmoMocv;
`,
});

/** Multiplies an unlit run's colour by its group's MOCV ({@link WMO_UNLIT_MOCV_ATTRIBUTE}). */
export function applyWmoUnlitMocv(material: THREE.MeshBasicMaterial): void {
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    const once = (source: string, marker: string): boolean => source.split(marker).length - 1 === 1;
    if (!once(shader.vertexShader, COLOR_VERTEX) || !once(shader.fragmentShader, COLOR_FRAGMENT)) {
      throw new Error("WMO unlit MOCV expected one colour marker in each stage");
    }
    shader.vertexShader = `${WMO_UNLIT_MOCV_GLSL.vertexPars}\n${shader.vertexShader}`
      .replace(COLOR_VERTEX, WMO_UNLIT_MOCV_GLSL.vertex);
    shader.fragmentShader = `${WMO_UNLIT_MOCV_GLSL.fragmentPars}\n${shader.fragmentShader}`
      .replace(COLOR_FRAGMENT, WMO_UNLIT_MOCV_GLSL.fragment);
  };
  material.customProgramCacheKey = () => `${previousKey}|wmo-unlit-mocv-v1`;
  material.needsUpdate = true;
}

/** Sets the clamp bits on a run's own texture view (the shared base keeps repeating). */
export function applyWmoRunClamp(texture: THREE.Texture, state: WmoRunDrawState): void {
  const wrapS = state.clampS ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  const wrapT = state.clampT ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  if (texture.wrapS === wrapS && texture.wrapT === wrapT) return;
  texture.wrapS = wrapS;
  texture.wrapT = wrapT;
  // A view whose base has no pixels yet is parked by `privateTextureView` until they arrive; one
  // with pixels needs its own upload for the new sampler state.
  if (texture.image) texture.needsUpdate = true;
}
