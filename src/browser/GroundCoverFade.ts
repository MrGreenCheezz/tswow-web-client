import * as THREE from "three";
import { GROUND_COVER_FADE_WIDTH } from "./GroundCover.js";

/** Per-renderer state shared by all grass materials, in scene x/z coordinates. */
export interface GroundCoverFadeUniforms {
  readonly centre: THREE.IUniform<THREE.Vector2>;
  readonly radius: THREE.IUniform<number>;
}

export function createGroundCoverFadeUniforms(): GroundCoverFadeUniforms {
  return { centre: { value: new THREE.Vector2() }, radius: { value: 0 } };
}

const PROJECT_VERTEX = "#include <project_vertex>";
export const GROUND_COVER_FADE_MARKER = "ground-cover-distance-fade-v1";

/** Uniform scale about each tuft's fixed root, after wind deformation and before projection. */
export function installGroundCoverFade(material: THREE.Material, uniforms: GroundCoverFadeUniforms): void {
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    if (!shader.vertexShader.includes(PROJECT_VERTEX)) {
      throw new Error("Ground-cover fade requires the three.js <project_vertex> shader chunk");
    }
    shader.uniforms["uGroundCoverCentre"] = uniforms.centre;
    shader.uniforms["uGroundCoverRadius"] = uniforms.radius;
    shader.vertexShader = "uniform vec2 uGroundCoverCentre;\nuniform float uGroundCoverRadius;\n"
      + shader.vertexShader.replace(PROJECT_VERTEX, [
        `// ${GROUND_COVER_FADE_MARKER}`,
        "vec4 groundCoverRoot = vec4( 0.0, 0.0, 0.0, 1.0 );",
        "#ifdef USE_INSTANCING",
        "groundCoverRoot = instanceMatrix * groundCoverRoot;",
        "#endif",
        "vec2 groundCoverXZ = ( modelMatrix * groundCoverRoot ).xz;",
        `float groundCoverScale = smoothstep( 0.0, ${GROUND_COVER_FADE_WIDTH.toFixed(1)},`,
        "  uGroundCoverRadius - distance( groundCoverXZ, uGroundCoverCentre ) );",
        "transformed *= groundCoverScale;",
        PROJECT_VERTEX,
      ].join("\n"));
  };
  material.customProgramCacheKey = () => `${previousKey}|${GROUND_COVER_FADE_MARKER}`;
}
