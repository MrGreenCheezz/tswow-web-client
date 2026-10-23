/**
 * 23.10 (6.27): «Живые эффекты заклинаний» — the enhanced profile's look for a spell's own particles.
 *
 * The owner (23.10): almost every spell effect reads flat and crude, Seal of Righteousness most of all. With
 * the parity fixes of the same day the particles are the client's shapes and sizes; this adds, on the
 * enhanced profile only, three things the 2008 renderer could not do. Nothing here is reachable from the
 * faithful path: a spell effect built without the leaf has no extra attribute, uniform or program.
 *
 *   * Flip-book frame blending: a particle whose head ramp walks a sheet (Seal of Righteousness's
 *     `clouds8x8fade` steps through 32 cells in 0.45 s) mixes the cell it is in with the next one by how far
 *     the ramp has gone between them, instead of snapping cell to cell (Wow.exe truncates: 0x00979560).
 *   * Soft ground: a camera-facing particle fades over its last `SPELL_SOFT_GROUND` yards above the ground
 *     under its effect, so a glow standing in the floor ends in a gradient rather than a cut line. A quad
 *     lying in its own XY plane (a rune, a ring on the floor) is meant to touch the ground and keeps its look.
 *   * Glow: additive particles get brighter where they are dense, and their hottest texels roll towards
 *     white, which lands them over the cinematic bloom's 0.8 threshold (CinematicPost.ts) — the capture is
 *     display-referred eight-bit, so headroom has to be spent here, on the particle, not in the post chain.
 */
import * as THREE from "three";

/** Yards above the effect's ground over which a camera-facing particle fades in. */
export const SPELL_SOFT_GROUND = 0.6;
/** Brightness gain of an additive spell particle at full opacity (1 + gain · energy). */
export const SPELL_GLOW_GAIN = 0.45;
/** Above this channel maximum the colour rolls towards white by `SPELL_GLOW_WHITE` of the excess. */
export const SPELL_GLOW_KNEE = 0.55;
export const SPELL_GLOW_WHITE = 0.9;

/** The per-effect inputs a living spell material reads each frame. */
export interface SpellParticleLookUniforms {
  /** Scene height (WoW z) of the ground under the effect; −Infinity-like (−1e6) when unknown. */
  readonly spellGround: { value: number };
}

const LOOKS = new WeakMap<THREE.Material, SpellParticleLookUniforms>();

/** CPU twin of the soft-ground fade for a fragment `height` yards above the ground. */
export function spellSoftGroundFade(height: number, softness = SPELL_SOFT_GROUND): number {
  if (!Number.isFinite(height)) return 1;
  const t = Math.max(0, Math.min(1, height / softness));
  return t * t * (3 - 2 * t);
}

/**
 * CPU twin of the glow on one fragment's colour (`rgb` in place) at opacity `alpha`. The roll to white is
 * keyed on what the fragment adds to the frame — colour × alpha for a SrcAlpha blend, the colour for One/One —
 * so a faint particle keeps its hue and only the dense, hot core whitens.
 */
export function spellGlowColour(rgb: [number, number, number], alpha: number, srcAlphaBlend = true): [number, number, number] {
  const a = Math.max(0, Math.min(1, alpha));
  const energy = a * a * (3 - 2 * a);
  for (let index = 0; index < 3; index++) rgb[index] = rgb[index]! * (1 + SPELL_GLOW_GAIN * energy);
  const weight = srcAlphaBlend ? a : 1;
  const peak = Math.max(rgb[0], rgb[1], rgb[2]) * weight;
  const white = Math.max(0, peak - SPELL_GLOW_KNEE) * SPELL_GLOW_WHITE / Math.max(weight, 1e-3);
  for (let index = 0; index < 3; index++) rgb[index] = rgb[index]! + white;
  return rgb;
}

/**
 * Installs the living look on one spell particle material. `additive` decides whether the glow applies
 * (an alpha or modulating particle is a smoke or a shadow, not a light); `srcAlphaBlend` whether the soft
 * fade goes on the alpha (SrcAlpha blends) or on the colour (One/One); `soft` is false for XY-plane quads;
 * `frameBlend` whether the material reads the `uv2Cell`/`cellBlend` attributes.
 */
export function installSpellParticleLook(
  material: THREE.MeshBasicMaterial,
  options: { additive: boolean; srcAlphaBlend: boolean; soft: boolean; frameBlend: boolean },
): SpellParticleLookUniforms {
  const uniforms: SpellParticleLookUniforms = { spellGround: { value: -1e6 } };
  LOOKS.set(material, uniforms);
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  const key = `spell-look-v1:${options.additive ? 1 : 0}${options.srcAlphaBlend ? 1 : 0}${options.soft ? 1 : 0}${options.frameBlend ? 1 : 0}`;
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms["spellGround"] = uniforms.spellGround;
    const replaceOnce = (source: string, marker: string, replacement: string): string => {
      if (source.split(marker).length - 1 !== 1) throw new Error(`Spell particle look expected one ${marker}`);
      return source.replace(marker, replacement);
    };
    shader.vertexShader = replaceOnce(shader.vertexShader, "#include <uv_vertex>", `#include <uv_vertex>
      ${options.frameBlend ? "vSpellUv2 = uv2Cell; vSpellCellBlend = cellBlend;" : ""}
      vSpellHeight = ( modelMatrix * vec4( position, 1.0 ) ).y;`);
    shader.vertexShader = `${options.frameBlend ? "attribute vec2 uv2Cell;\nattribute float cellBlend;\nvarying vec2 vSpellUv2;\nvarying float vSpellCellBlend;\n" : ""}varying float vSpellHeight;\n${shader.vertexShader}`;
    shader.fragmentShader = `${options.frameBlend ? "varying vec2 vSpellUv2;\nvarying float vSpellCellBlend;\n" : ""}varying float vSpellHeight;\nuniform float spellGround;\n${shader.fragmentShader}`;
    if (options.frameBlend) {
      shader.fragmentShader = replaceOnce(shader.fragmentShader, "#include <map_fragment>", `
      /* spell-look-v1 frame blend */
      vec4 sampledDiffuseColor = texture2D( map, vMapUv );
      if ( vSpellCellBlend > 0.0 ) sampledDiffuseColor = mix( sampledDiffuseColor, texture2D( map, vSpellUv2 ), vSpellCellBlend );
      diffuseColor *= sampledDiffuseColor;`);
    }
    const glow = options.additive ? `
      float spellEnergy = smoothstep( 0.0, 1.0, diffuseColor.a );
      diffuseColor.rgb *= 1.0 + ${SPELL_GLOW_GAIN.toFixed(3)} * spellEnergy;
      float spellWeight = ${options.srcAlphaBlend ? "diffuseColor.a" : "1.0"};
      float spellPeak = max( diffuseColor.r, max( diffuseColor.g, diffuseColor.b ) ) * spellWeight;
      diffuseColor.rgb += vec3( max( spellPeak - ${SPELL_GLOW_KNEE.toFixed(3)}, 0.0 ) * ${SPELL_GLOW_WHITE.toFixed(3)}
        / max( spellWeight, 0.001 ) );` : "";
    const soft = options.soft ? `
      float spellSoft = smoothstep( 0.0, ${SPELL_SOFT_GROUND.toFixed(3)}, vSpellHeight - spellGround );
      ${options.srcAlphaBlend ? "diffuseColor.a *= spellSoft;" : "diffuseColor.rgb *= spellSoft;"}` : "";
    shader.fragmentShader = replaceOnce(shader.fragmentShader, "#include <color_fragment>", `#include <color_fragment>
      /* spell-look-v1 */${glow}${soft}`);
  };
  material.customProgramCacheKey = () => `${previousKey}|${key}`;
  material.needsUpdate = true;
  return uniforms;
}

/** The living look's uniforms of a material, when it wears one. */
export function spellParticleLookOf(material: THREE.Material): SpellParticleLookUniforms | undefined {
  return LOOKS.get(material);
}
