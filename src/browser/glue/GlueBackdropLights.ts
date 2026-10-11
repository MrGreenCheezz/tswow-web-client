/**
 * 12.10 — the point lights a glue model carries, which light everything in its scene.
 *
 * `GlueParent.lua`'s `SetLighting` (the stock character screens' only light call) explains the split
 * in its own words: `AddLight`/`AddCharacterLight` «only supports setting directional lights, and
 * pulls the default point lights from the models», and `RaceLights[]` «duplicates the 3.2.2 color
 * values in the models» because «the models no longer contain directional lights». So the race sets
 * replace the model's directional and ambient lights and nothing else: its `M2Light` records of type
 * 1 (point) keep lighting the backdrop and whoever stands in it.
 *
 * The stage applied the race set alone. That is fine for a backdrop whose model has no point light —
 * human, dwarf, tauren, blood elf, death knight carry only directional records — and wrong for the
 * ones that light their figure with points (measured off the gateway's models, 12.10):
 *
 * - `UI_NightElf`: `RaceLights.NIGHTELF` is one ambient, 0.2 x (0.451, 0.451, 0.851) = (0.090, 0.090,
 *   0.170), the model's own record #2 — and the moonlight is point #1, (0.769, 0.875, 1) x 2.5 above
 *   the mark at z 5.59, with #3 x 0.7 beside it. Without them the figure stood in near black: the
 *   owner's «при выборе персонажа будто нет освещения, сильно видно на ночных эльфах»;
 * - `UI_Scourge`: ambient 0.2 only, the figure lit by points #0 x 2 and #2 x 0.25 and a torch #1
 *   (x 0.6, flickering on global sequence 1);
 * - `UI_Orc`, `UI_Draenei`, `UI_CharacterSelect`: one or two weaker points beside their keys.
 *
 * Attenuation: the record's start and end in yards. three's point light has one radius with a smooth
 * window to zero at it (`decay` 0), so the end is the radius and the start is not modelled — the
 * window keeps ≥ 0.95 of the light out to 0.4 of the radius, which is where these records start.
 * The light sits at its record's position in model space; its bone's animation is not followed (the
 * glue backdrops' light bones are static).
 */

import * as THREE from "three";
import { sampleTrack } from "../Particles.js";
import type { WvmLight, WvmModel } from "../Wvm.js";

/** `M2Light.type` of a point light (LocalLighting.ts reads the same records in the world). */
const M2_LIGHT_POINT = 1;

/**
 * Point lights per glue view. «Up to four lights per light set» (GlueParent.lua) is the corpus'
 * ceiling for the sets it adds; the backdrops carry at most three points (`UI_NightElf`, `UI_Scourge`).
 * Made once per view — three compiles the light count into every program.
 */
export const GLUE_MAX_POINT_LIGHTS = 4;

/** One point light at a moment, in the model's own space and units. */
export interface GlueBackdropPointLight {
  /** Model space, Z up — the model root's local frame. */
  readonly position: readonly [number, number, number];
  /** Diffuse colour times intensity, linear. */
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** Attenuation end, yards. */
  readonly radius: number;
}

/** The model's point lights that shine at `animationMs`/`worldMs`, at most `GLUE_MAX_POINT_LIGHTS`. */
export function glueBackdropPointLights(
  model: Pick<WvmModel, "lights" | "globalSequences">,
  animationMs: number,
  worldMs: number,
): GlueBackdropPointLight[] {
  const out: GlueBackdropPointLight[] = [];
  for (const light of model.lights ?? []) {
    if (out.length === GLUE_MAX_POINT_LIGHTS) break;
    const sampled = samplePoint(light, model.globalSequences, animationMs, worldMs);
    if (sampled) out.push(sampled);
  }
  return out;
}

function samplePoint(
  light: WvmLight,
  globalSequences: Uint32Array,
  animationMs: number,
  worldMs: number,
): GlueBackdropPointLight | undefined {
  if (light.type !== M2_LIGHT_POINT || !light.position.every(Number.isFinite)) return undefined;
  const sample = (track: WvmLight["diffuseColor"], fallback: number, component = 0): number =>
    sampleTrack(track, animationMs, worldMs, globalSequences, fallback, component);
  if (sample(light.visibility, 1) <= 0) return undefined;
  const intensity = Math.max(0, sample(light.diffuseIntensity, 0));
  const radius = sample(light.attenuationEnd, 0);
  if (!(intensity > 0) || !(radius > 0)) return undefined;
  return {
    position: light.position,
    r: Math.max(0, sample(light.diffuseColor, 1, 0)) * intensity,
    g: Math.max(0, sample(light.diffuseColor, 1, 1)) * intensity,
    b: Math.max(0, sample(light.diffuseColor, 1, 2)) * intensity,
    radius,
  };
}

/** Writes one sample onto a three light; `scale` is the model root's world scale (radius is yards). */
export function applyGlueBackdropPointLight(
  target: THREE.PointLight,
  light: GlueBackdropPointLight | undefined,
  root: THREE.Object3D | undefined,
  scale: number,
  intensityScale: number,
): void {
  const peak = light ? Math.max(light.r, light.g, light.b) : 0;
  if (!light || !root || !(peak > 0)) {
    target.intensity = 0;
    return;
  }
  target.color.setRGB(light.r / peak, light.g / peak, light.b / peak);
  target.intensity = peak * intensityScale;
  target.distance = light.radius * Math.abs(scale);
  target.position.set(light.position[0], light.position[1], light.position[2]);
  root.localToWorld(target.position);
}

/**
 * 12.10: the fixed-function client's clamp. A glue surface is `texel x (ambient + N·L x diffuse)`
 * with the light sum clamped to 1 per channel (the D3D vertex colour is saturated before it
 * modulates the texture — `GLUE_LIGHT_INTENSITY_SCALE`'s table: «min(1, 1.5)»). three adds light
 * without a ceiling, so a key over 1 — the night elf's moonlight is 2.5 — washed the skin to grey
 * white. With metalness 0, `totalDiffuse` is `diffuseColor x light`, so the clamp is
 * `min(totalDiffuse, diffuseColor)`. Chained onto the material's own `onBeforeCompile` (ModelBuild's
 * steps); only `MeshStandardMaterial`s — the lit batches — and only materials a glue view built.
 */
const GLUE_LIGHT_CLAMP_LINE = "vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;";
const GLUE_LIGHT_CLAMPED = new WeakSet<THREE.Material>();

export function clampGlueLighting(material: THREE.Material): void {
  if (!(material instanceof THREE.MeshStandardMaterial) || GLUE_LIGHT_CLAMPED.has(material)) return;
  GLUE_LIGHT_CLAMPED.add(material);
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    if (!shader.fragmentShader.includes(GLUE_LIGHT_CLAMP_LINE)) return;
    shader.fragmentShader = shader.fragmentShader.replace(GLUE_LIGHT_CLAMP_LINE,
      "vec3 outgoingLight = min( totalDiffuse, diffuseColor.rgb ) + totalSpecular + totalEmissiveRadiance; /* glue-light-clamp-v1 */");
  };
  material.customProgramCacheKey = () => `${previousKey}|glue-light-clamp-v1`;
  material.needsUpdate = true;
}

