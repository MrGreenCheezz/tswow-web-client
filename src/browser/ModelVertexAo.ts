import type * as THREE from "three";

/**
 * 04.11 (the owner's pilot): the occlusion `tools/model-polish.mjs` baked into a model, read back.
 *
 * It travels in the length of the normal: every lit path normalises the normal, so nothing else sees it and
 * the model carries no extra stream. An artifact says so in its flags (`WVM9_NORMALS_CARRY_AO`); on any other
 * model this step is not installed at all, so what the file's normals happen to measure means nothing.
 */

/** The same floor the bake writes: `AO_NORMAL_FLOOR` in `tools/model-polish.mjs`. */
export const MODEL_AO_NORMAL_FLOOR = 0.25;
/** How much of the occlusion reaches the light: the textures already paint some of it. */
export const MODEL_AO_STRENGTH = 0.75;

const VERTEX_MARKER = "#include <beginnormal_vertex>";
const FRAGMENT_MARKER = "#include <opaque_fragment>";

/**
 * Hangs the read-back on a lit material's chain, before the world light wraps it, so a locally lit copy
 * rebuilt from the chain keeps it.
 */
export function installModelVertexAo(material: THREE.Material): void {
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    if (!shader.vertexShader.includes(VERTEX_MARKER) || !shader.fragmentShader.includes(FRAGMENT_MARKER)) return;
    shader.vertexShader = `varying float wvmVertexAo;\n${shader.vertexShader}`.replace(VERTEX_MARKER, `${VERTEX_MARKER}
      wvmVertexAo = clamp( ( length( normal ) - ${MODEL_AO_NORMAL_FLOOR.toFixed(3)} ) / ${(1 - MODEL_AO_NORMAL_FLOOR).toFixed(3)}, 0.0, 1.0 );`);
    shader.fragmentShader = `varying float wvmVertexAo;\n${shader.fragmentShader}`.replace(FRAGMENT_MARKER, `
      outgoingLight *= mix( 1.0, wvmVertexAo, ${MODEL_AO_STRENGTH.toFixed(3)} );
      ${FRAGMENT_MARKER}`);
  };
  material.customProgramCacheKey = () => `${previousKey}|model-vertex-ao-v1`;
}
