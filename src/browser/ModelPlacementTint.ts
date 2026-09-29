import * as THREE from "three";
import { WORLD_LIGHT_TARGET, cloneMaterialForPortrait } from "./WorldLighting.js";

/** Display-order RGBA bytes used by placement colour and authored-light records. */
export type ModelPlacementTint = readonly [red: number, green: number, blue: number, alpha: number];

const MODEL_PLACEMENT_TINT_KEY = "modelPlacementTint";
const MODEL_PLACEMENT_TINT_MARKER = "#include <color_fragment>";
const MODEL_PLACEMENT_TINT_VERSION = "m2-placement-tint-v2";
const MODEL_PLACEMENT_LOCAL_LIGHT_KEY = "modelPlacementLocalLight";
const MODEL_PLACEMENT_LOCAL_LIGHT_DIRECTION_KEY = "modelPlacementLocalLightDirection";
const MODEL_PLACEMENT_LOCAL_LIGHT_VERSION = "m2-placement-local-light-v1";
const MODEL_PLACEMENT_LOCAL_LIGHT_VERTEX_MARKER = "#include <begin_vertex>";

/** Per-copy attributes used only by the locally-lit InstancedMesh bucket. */
export const MODEL_PLACEMENT_LOCAL_LIGHT_ATTRIBUTE = MODEL_PLACEMENT_LOCAL_LIGHT_KEY;

/**
 * Stock indoor-M2 key light in the renderer's x/y/z scene frame.
 *
 * It is a fixed client light, not a direction inferred from WMO MOLT records. Keeping the mapping
 * in one exported tuple makes an archive/disassembly axis correction isolated and testable.
 */
export const MODEL_PLACEMENT_LOCAL_LIGHT_DIRECTION = [-0.30822, 0.9, 0.30822] as const;
const MODEL_PLACEMENT_LOCAL_LIGHT_DIRECTION_VECTOR = new THREE.Vector3(
  ...MODEL_PLACEMENT_LOCAL_LIGHT_DIRECTION,
).normalize();

/** Placement copies following each cached source material's animated appearance. */
const MODEL_PLACEMENT_TINT_COPIES = new WeakMap<THREE.Material, Set<THREE.Material>>();

type ColouredMaterial = THREE.Material & { color: THREE.Color };

function coloured(material: THREE.Material): material is ColouredMaterial {
  return "color" in material && (material as Partial<ColouredMaterial>).color instanceof THREE.Color;
}

/** Converts the file's display-space RGB bytes into three's linear working colour. */
export function modelPlacementTintColour(
  tint: ModelPlacementTint | undefined,
  target = new THREE.Color(),
): THREE.Color {
  if (!tint) return target.setRGB(1, 1, 1);
  return target.setRGB(tint[0] / 255, tint[1] / 255, tint[2] / 255, THREE.SRGBColorSpace);
}

function copyAnimatedAppearance(source: THREE.Material, copy: THREE.Material): void {
  if (coloured(source) && coloured(copy)) copy.color.copy(source.color);
  copy.opacity = source.opacity;
  copy.visible = source.visible;
}

function registerAnimatedCopy(source: THREE.Material, copy: THREE.Material): void {
  let copies = MODEL_PLACEMENT_TINT_COPIES.get(source);
  if (!copies) {
    copies = new Set();
    MODEL_PLACEMENT_TINT_COPIES.set(source, copies);
  }
  copies.add(copy);
  copy.addEventListener("dispose", () => copies?.delete(copy));
}

function localLightBody(colour: string): string {
  return `
      // The stock 3.3.5 indoor-M2 setup derives both terms from MODD RGB and one fixed key light.
      // MOLT/point lights are disabled on this path; do not substitute a nearest root light here.
      vec3 modelPlacementColour = clamp( ${colour}, 0.0, 1.0 );
      float modelPlacementMaximum = max(
        max( modelPlacementColour.r, modelPlacementColour.g ),
        max( modelPlacementColour.b, 0.000001 )
      );
      float modelPlacementAmbientScale = min(
        1.0,
        ( 96.0 / 255.0 ) / modelPlacementMaximum
      );
      float modelPlacementDiffuseScale = max(
        1.0,
        ( 168.0 / 255.0 ) / modelPlacementMaximum
      );
      vec3 modelPlacementAmbient = modelPlacementColour * modelPlacementAmbientScale;
      vec3 modelPlacementDiffuse = modelPlacementColour * modelPlacementDiffuseScale;
      vec3 modelPlacementViewLightDirection = normalize(
        ( viewMatrix * vec4( ${MODEL_PLACEMENT_LOCAL_LIGHT_DIRECTION_KEY}, 0.0 ) ).xyz
      );
      float modelPlacementNL = max(
        dot( normalize( normal ), modelPlacementViewLightDirection ),
        0.0
      );
      vec3 modelPlacementAuthoredLight = max(
        modelPlacementAmbient + modelPlacementDiffuse * modelPlacementNL,
        vec3( 0.0 )
      );
      // Like the outdoor path, MODD and the traced 96/168 scales are display-space multipliers;
      // convert their final sum once before multiplying the already-linear texture sample.
      reflectedLight.directDiffuse = diffuseColor.rgb * pow( modelPlacementAuthoredLight, vec3( 2.2 ) );
      reflectedLight.indirectDiffuse = vec3( 0.0 );
      reflectedLight.directSpecular = vec3( 0.0 );
      reflectedLight.indirectSpecular = vec3( 0.0 );`;
}

function replaceLocalLightBlock(shader: Parameters<THREE.Material["onBeforeCompile"]>[0], body: string): void {
  const unindented = WORLD_LIGHT_TARGET.replaceAll("\n\t", "\n");
  const target = shader.fragmentShader.includes(WORLD_LIGHT_TARGET) ? WORLD_LIGHT_TARGET : unindented;
  if (shader.fragmentShader.split(target).length - 1 !== 1) {
    throw new Error("M2 placement light expected exactly one light integration block");
  }
  shader.fragmentShader = shader.fragmentShader.replace(target, body);
}

/**
 * Copies one placement's materials so its fixed tint is normal renderer-owned material state.
 *
 * Three invokes `Material.onBeforeRender` before it knows whether the program's ordinary uniforms
 * need refreshing. Mutating one uniform there on a shared cached material therefore leaves the GPU
 * with the first chair's colour when the next chair uses the same material id. Distinct material
 * ids make three upload the distinct uniform maps in the usual path, while still sharing textures,
 * geometry and the compiled program.
 *
 * The fourth MODD byte is deliberately absent from the shader. It is the lighting colour's stored
 * alpha component, but the reference renderer forces this placement colour to alpha=1 rather than
 * treating it as mesh opacity. Doing the same prevents opaque and alpha-keyed doodads disappearing.
 */
export function createModelPlacementTintMaterials(
  materials: readonly THREE.Material[],
  tint: ModelPlacementTint | undefined,
): THREE.Material[] | undefined {
  if (!tint || (tint[0] === 255 && tint[1] === 255 && tint[2] === 255)) return undefined;
  const colour = modelPlacementTintColour(tint);

  return materials.map((source) => {
    const copy = source.clone();
    const uniform = { value: new THREE.Vector3(colour.r, colour.g, colour.b) };
    const previousCompile = source.onBeforeCompile;
    const previousRender = source.onBeforeRender;
    const previousKey = source.customProgramCacheKey();

    // Material.copy intentionally drops these hooks. Carry the complete M2 shader chain forward,
    // then append only the placement multiplier; every copy can still share the compiled program.
    copy.onBeforeCompile = (shader, renderer) => {
      previousCompile.call(copy, shader, renderer);
      if (shader.fragmentShader.split(MODEL_PLACEMENT_TINT_MARKER).length - 1 !== 1) {
        throw new Error("M2 placement tint expected exactly one color fragment marker");
      }
      shader.uniforms[MODEL_PLACEMENT_TINT_KEY] = uniform;
      shader.fragmentShader = `uniform vec3 ${MODEL_PLACEMENT_TINT_KEY};\n${shader.fragmentShader}`
        .replace(
          MODEL_PLACEMENT_TINT_MARKER,
          `${MODEL_PLACEMENT_TINT_MARKER}\n      diffuseColor.rgb *= ${MODEL_PLACEMENT_TINT_KEY};`,
        );
    };
    copy.customProgramCacheKey = () => `${previousKey}|${MODEL_PLACEMENT_TINT_VERSION}`;
    copy.onBeforeRender = (renderer, scene, camera, geometry, object, group) => {
      copyAnimatedAppearance(source, copy);
      previousRender.call(copy, renderer, scene, camera, geometry, object, group);
    };

    registerAnimatedCopy(source, copy);
    copy.needsUpdate = true;
    return copy;
  });
}

/**
 * Placement-owned materials for one locally-lit WMO doodad.
 *
 * Standard batches replace the cached material's outdoor-light wrapper with the WMO's authored
 * fixed indoor light. Unlit/additive batches are cloned but deliberately left uncoloured: the
 * reference disables lighting for those batches, so multiplying MODD into them would apply the
 * same colour through a path that never received it in the client.
 */
export function createModelPlacementLocalLightMaterials(
  materials: readonly THREE.Material[],
  light: ModelPlacementTint | undefined,
): THREE.Material[] | undefined {
  if (!light) return undefined;
  const colourUniform = { value: new THREE.Vector3(light[0] / 255, light[1] / 255, light[2] / 255) };
  const directionUniform = { value: MODEL_PLACEMENT_LOCAL_LIGHT_DIRECTION_VECTOR };

  return materials.map((source) => {
    // Unlike Material.clone(), this preserves the M2 second-layer/fog hooks while unwrapping the
    // world-light hook installed last by ModelBuild.
    const copy = cloneMaterialForPortrait(source);
    const previousCompile = copy.onBeforeCompile;
    const previousRender = source.onBeforeRender;
    const previousKey = copy.customProgramCacheKey();
    if (copy instanceof THREE.MeshStandardMaterial) {
      copy.onBeforeCompile = (shader, renderer) => {
        previousCompile.call(copy, shader, renderer);
        shader.uniforms[MODEL_PLACEMENT_LOCAL_LIGHT_KEY] = colourUniform;
        shader.uniforms[MODEL_PLACEMENT_LOCAL_LIGHT_DIRECTION_KEY] = directionUniform;
        shader.fragmentShader = `
          uniform vec3 ${MODEL_PLACEMENT_LOCAL_LIGHT_KEY};
          uniform vec3 ${MODEL_PLACEMENT_LOCAL_LIGHT_DIRECTION_KEY};
          ${shader.fragmentShader}`;
        replaceLocalLightBlock(shader, localLightBody(MODEL_PLACEMENT_LOCAL_LIGHT_KEY));
      };
      copy.customProgramCacheKey = () => `${previousKey}|${MODEL_PLACEMENT_LOCAL_LIGHT_VERSION}:uniform`;
    }
    copy.onBeforeRender = (renderer, scene, camera, geometry, object, group) => {
      copyAnimatedAppearance(source, copy);
      previousRender.call(copy, renderer, scene, camera, geometry, object, group);
    };
    registerAnimatedCopy(source, copy);
    copy.needsUpdate = true;
    return copy;
  });
}

/** One material array shared by a locally-lit instanced bucket; light data comes from attributes. */
export function createInstancedModelPlacementLocalLightMaterials(
  materials: readonly THREE.Material[],
): THREE.Material[] {
  return materials.map((source) => {
    const copy = cloneMaterialForPortrait(source);
    const previousCompile = copy.onBeforeCompile;
    const previousRender = source.onBeforeRender;
    const previousKey = copy.customProgramCacheKey();
    if (copy instanceof THREE.MeshStandardMaterial) {
      copy.onBeforeCompile = (shader, renderer) => {
        previousCompile.call(copy, shader, renderer);
        if (shader.vertexShader.split(MODEL_PLACEMENT_LOCAL_LIGHT_VERTEX_MARKER).length - 1 !== 1) {
          throw new Error("Instanced M2 placement light expected exactly one vertex marker");
        }
        shader.vertexShader = `
          attribute vec3 ${MODEL_PLACEMENT_LOCAL_LIGHT_ATTRIBUTE};
          varying vec3 modelPlacementVLocalLight;
          ${shader.vertexShader}`.replace(
          MODEL_PLACEMENT_LOCAL_LIGHT_VERTEX_MARKER,
          `${MODEL_PLACEMENT_LOCAL_LIGHT_VERTEX_MARKER}
          modelPlacementVLocalLight = ${MODEL_PLACEMENT_LOCAL_LIGHT_ATTRIBUTE};`,
        );
        shader.fragmentShader = `
          varying vec3 modelPlacementVLocalLight;
          ${shader.fragmentShader}`;
        shader.uniforms[MODEL_PLACEMENT_LOCAL_LIGHT_DIRECTION_KEY] = {
          value: MODEL_PLACEMENT_LOCAL_LIGHT_DIRECTION_VECTOR,
        };
        shader.fragmentShader = `
          uniform vec3 ${MODEL_PLACEMENT_LOCAL_LIGHT_DIRECTION_KEY};
          ${shader.fragmentShader}`;
        replaceLocalLightBlock(shader, localLightBody("modelPlacementVLocalLight"));
      };
      copy.customProgramCacheKey = () => `${previousKey}|${MODEL_PLACEMENT_LOCAL_LIGHT_VERSION}:instanced`;
    }
    copy.onBeforeRender = (renderer, scene, camera, geometry, object, group) => {
      copyAnimatedAppearance(source, copy);
      previousRender.call(copy, renderer, scene, camera, geometry, object, group);
    };
    registerAnimatedCopy(source, copy);
    copy.needsUpdate = true;
    return copy;
  });
}

/** Propagates the M2 colour/opacity track before three filters invisible materials for this frame. */
export function syncModelPlacementTintMaterials(source: THREE.Material): void {
  const copies = MODEL_PLACEMENT_TINT_COPIES.get(source);
  if (!copies) return;
  for (const copy of copies) copyAnimatedAppearance(source, copy);
}

/** Releases only placement-owned material state; shared textures remain owned by the model build. */
export function disposeModelPlacementTintMaterials(
  materials: readonly THREE.Material[] | undefined,
): void {
  if (!materials) return;
  for (const material of new Set(materials)) material.dispose();
}
