/**
 * 25.10 (12.10): one depth material per caster kind, so the cascades stop re-deriving programs.
 *
 * Three draws every caster's shadow with its one shared depth material, or with one clone per
 * alpha-keyed source material (`WebGLShadowMap.getDepthMaterial`), whatever the caster is: a plain
 * mesh, an instance bucket (with or without instance colours) or a skinned body. Which of those it
 * is belongs to the program (`USE_INSTANCING`, `USE_INSTANCING_COLOR`, `USE_SKINNING`), and three
 * keeps one program per material: each time the same depth material passes from one kind of caster
 * to another, `setProgram` finds `materialProperties.instancing` (or skinning) changed and derives
 * the program's parameters and cache key again (`getProgram` → `getParameters`, ~2 KB of garbage).
 * The bench census (`sceneStats.parameterDerivations`) counted 10 of them per frame in the shadow
 * pass of the Stormwind trade district — the shared material and the clones of models drawn both
 * alone and through a bucket, met by every cascade.
 *
 * Here every depth material three hands an instanced or skinned caster during the cascades is
 * swapped for its twin for that kind: a copy made once, carrying the source's compile hooks (the
 * 7.26 wind of a swaying crown), with the per-draw state three just wrote onto the source (side,
 * textures, threshold, colour mask) copied over before the draw. Each kind then keeps its own
 * program on its own material; plain meshes keep three's own materials. The programs are the ones
 * three would have chosen (the twins' parameters are the source's), so the maps are the same.
 */

import * as THREE from "three";

type DepthState = THREE.Material & {
  map?: THREE.Texture | null;
  alphaMap?: THREE.Texture | null;
  displacementMap?: THREE.Texture | null;
  displacementScale?: number;
  displacementBias?: number;
  wireframe?: boolean;
  wireframeLinewidth?: number;
  linewidth?: number;
};

interface Twins {
  /** Indexed by kind - 1: instanced, instanced with colours, skinned. */
  readonly kinds: (THREE.Material | undefined)[];
}

/** 0 plain, 1 instanced, 2 instanced with colours, 3 skinned (`ShadowCasterList`'s kind order). */
export function shadowDepthKind(object: THREE.Object3D): number {
  const instanced = object as THREE.InstancedMesh;
  if (instanced.isInstancedMesh) return instanced.instanceColor ? 2 : 1;
  return (object as THREE.SkinnedMesh).isSkinnedMesh ? 3 : 0;
}

function makeTwin(source: THREE.Material): THREE.Material {
  const twin = source.clone();
  // `Material.copy` leaves the compile hooks behind; the wind of an alpha-keyed crown lives there.
  twin.onBeforeCompile = source.onBeforeCompile;
  twin.customProgramCacheKey = source.customProgramCacheKey;
  twin.name = `${source.name}|kind`;
  return twin;
}

/** What three writes onto its depth material before each shadow draw, and the cascades' colour mask. */
function copyDrawState(source: DepthState, twin: DepthState): void {
  if (twin.side !== source.side) twin.side = source.side;
  if (twin.visible !== source.visible) twin.visible = source.visible;
  if (twin.colorWrite !== source.colorWrite) twin.colorWrite = source.colorWrite;
  if (twin.alphaTest !== source.alphaTest) twin.alphaTest = source.alphaTest;
  if (twin.map !== source.map) twin.map = source.map ?? null;
  if (twin.alphaMap !== source.alphaMap) twin.alphaMap = source.alphaMap ?? null;
  if (twin.displacementMap !== source.displacementMap) twin.displacementMap = source.displacementMap ?? null;
  if (twin.displacementScale !== source.displacementScale) twin.displacementScale = source.displacementScale ?? 1;
  if (twin.displacementBias !== source.displacementBias) twin.displacementBias = source.displacementBias ?? 0;
  if (twin.wireframe !== source.wireframe) twin.wireframe = source.wireframe ?? false;
  if (twin.clipShadows !== source.clipShadows) twin.clipShadows = source.clipShadows;
  if (twin.clippingPlanes !== source.clippingPlanes) twin.clippingPlanes = source.clippingPlanes;
  if (twin.clipIntersection !== source.clipIntersection) twin.clipIntersection = source.clipIntersection;
}

const TWINS = new WeakMap<THREE.Material, Twins>();

/**
 * The material to draw `object`'s shadow with in place of `depth` (three's choice for this draw):
 * `depth` itself for a plain mesh, a mesh's own `customDepthMaterial` or a non-depth material,
 * otherwise `depth`'s twin for the object's kind with this draw's state.
 */
export function shadowDepthFor(depth: THREE.Material, object: THREE.Object3D): THREE.Material {
  if (!(depth as THREE.MeshDepthMaterial).isMeshDepthMaterial) return depth;
  const kind = shadowDepthKind(object);
  if (kind === 0 || (object as THREE.Mesh).customDepthMaterial === depth) return depth;
  let twins = TWINS.get(depth);
  if (twins === undefined) {
    const made: Twins = { kinds: [undefined, undefined, undefined] };
    twins = made;
    TWINS.set(depth, made);
    depth.addEventListener("dispose", () => {
      for (const twin of made.kinds) twin?.dispose();
      TWINS.delete(depth);
    });
  }
  let twin = twins.kinds[kind - 1];
  if (twin === undefined) {
    twin = makeTwin(depth);
    twins.kinds[kind - 1] = twin;
  } else if (twin.onBeforeCompile !== depth.onBeforeCompile || twin.customProgramCacheKey !== depth.customProgramCacheKey) {
    // A hook installed on the source after its twin was made (7.26 wind): the twin compiles again with it.
    twin.onBeforeCompile = depth.onBeforeCompile;
    twin.customProgramCacheKey = depth.customProgramCacheKey;
    twin.needsUpdate = true;
  }
  copyDrawState(depth as DepthState, twin as DepthState);
  return twin;
}
