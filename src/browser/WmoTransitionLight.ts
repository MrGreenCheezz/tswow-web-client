/**
 * 22.10 (7.37): how a WMO's transition batches — the doorways and vestibules between a room and the
 * street — are lit: by the sun and by the room at once, mixed per vertex.
 *
 * Wow.exe draws each transition batch twice (classic 0x007AC9F0, unified 0x007A9380): sun-lit under
 * `GxBlend_SrcAlphaOpaque` (9, src·α), then lit by its vertex colour under `GxBlend_InvSrcAlphaAdd`
 * (7, + src·(1 − α)), α being the vertex alpha that `CMapObj::AttenTransVerts` (0x007D78C0) wrote:
 * near a portal to the outside it is the sun, deeper in it is the room. A `visual-wmo-v27` group
 * block carries that alpha and the room colour the client computed (`tools/wmo-transition.mjs`);
 * here one lit material draws both passes: the scene's light, mixed towards texel × room light by
 * 1 − α before the fog.
 *
 * Before this a transition run in a room was drawn unlit with its raw MOCV brightened by its alpha
 * as `FixColorVertexAlpha` brightens every *other* vertex — 4.78× the client's light on the
 * Goldshire Inn's vestibule, the glow at its door. An older artifact has no transition range and
 * keeps that old reading; the name `visual-wmo-v27` is what retires it.
 */

import * as THREE from "three";

import { WMO_LIGHT_TRANSITION, type WmoGroupMesh, type WmoRun } from "./WmoModel.js";

/** Per vertex, the sun's share of a transition vertex's light (AttenTransVerts' α / 255). */
export const WMO_TRANSITION_SUN_ATTRIBUTE = "wowWmoSunShare";

/** Whether a run is drawn as the client's two transition passes: its group carries the range. */
export function wmoRunBlendsSun(mesh: Pick<WmoGroupMesh, "transitionVertices"> | undefined, run: Pick<WmoRun, "lighting">): boolean {
  return run.lighting === WMO_LIGHT_TRANSITION && (mesh?.transitionVertices ?? 0) > 0;
}

/** Whether any run of a group is drawn that way (it then needs the room light and the sun share). */
export function wmoGroupBlendsSun(mesh: Pick<WmoGroupMesh, "transitionVertices" | "runs"> | undefined): boolean {
  return (mesh?.transitionVertices ?? 0) > 0 && mesh!.runs.some((run) => run.lighting === WMO_LIGHT_TRANSITION);
}

/** The sun's share per vertex: the alpha of the transition range, 0 past it. */
export function wmoTransitionSunShare(mesh: Pick<WmoGroupMesh, "colours" | "transitionVertices">): Float32Array {
  const count = mesh.colours.length >> 2;
  const share = new Float32Array(count);
  const end = Math.min(count, mesh.transitionVertices ?? 0);
  for (let vertex = 0; vertex < end; vertex++) share[vertex] = mesh.colours[vertex * 4 + 3]! / 255;
  return share;
}

const BEGIN_VERTEX = "#include <begin_vertex>";
const OPAQUE_FRAGMENT = "#include <opaque_fragment>";

/** The replacements, split out for a static GLSL test. `color` is the group's room light, linear. */
export const WMO_TRANSITION_GLSL = Object.freeze({
  vertexPars: /* glsl */ `
#ifndef USE_COLOR
attribute vec3 color;
#endif
attribute float ${WMO_TRANSITION_SUN_ATTRIBUTE};
varying vec3 vWowWmoRoomLight;
varying float vWowWmoSunShare;
`,
  vertex: /* glsl */ `
${BEGIN_VERTEX}
  vWowWmoRoomLight = color;
  vWowWmoSunShare = ${WMO_TRANSITION_SUN_ATTRIBUTE};
`,
  fragmentPars: /* glsl */ `
varying vec3 vWowWmoRoomLight;
varying float vWowWmoSunShare;
`,
  fragment: /* glsl */ `
  outgoingLight = mix( diffuseColor.rgb * vWowWmoRoomLight, outgoingLight, clamp( vWowWmoSunShare, 0.0, 1.0 ) );
${OPAQUE_FRAGMENT}
`,
});

export const WMO_TRANSITION_PROGRAM_KEY = "wmo-transition-v1";

/** Mixes a lit run's light with its room light by the sun share (Wow.exe's two transition passes). */
export function applyWmoTransitionBlend(material: THREE.MeshStandardMaterial): void {
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    const once = (source: string, marker: string): boolean => source.split(marker).length - 1 === 1;
    if (!once(shader.vertexShader, BEGIN_VERTEX) || !once(shader.fragmentShader, OPAQUE_FRAGMENT)) {
      throw new Error("WMO transition blend expected one begin-vertex and one opaque marker");
    }
    shader.vertexShader = `${WMO_TRANSITION_GLSL.vertexPars}\n${shader.vertexShader}`
      .replace(BEGIN_VERTEX, WMO_TRANSITION_GLSL.vertex);
    shader.fragmentShader = `${WMO_TRANSITION_GLSL.fragmentPars}\n${shader.fragmentShader}`
      .replace(OPAQUE_FRAGMENT, WMO_TRANSITION_GLSL.fragment);
  };
  material.customProgramCacheKey = () => `${previousKey}|${WMO_TRANSITION_PROGRAM_KEY}`;
  material.needsUpdate = true;
}
