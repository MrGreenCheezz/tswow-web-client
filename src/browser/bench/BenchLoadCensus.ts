/**
 * 25.10 (perf): what one frame of a timed scene carried — the load the owner asked to compare under («нагрузка всех
 * объектов, NPC и эффекты»): draws of the main pass and of the shadow pass, skinned units, instanced scenery and its
 * instances, particle meshes and their quads, other meshes, triangles. One frame, drawn by `drawOnce` with three's
 * submit observed; written so the baselines' harness can carry the same file unchanged.
 */

import type * as THREE from "three";

export interface BenchLoadCensus {
  calls: number; triangles: number;
  mainDraws: number; shadowDraws: number;
  skinnedDraws: number; instancedDraws: number; instances: number;
  particleDraws: number; particleQuads: number;
  otherDraws: number; scenes: number;
}

type DirectDraw = (camera: THREE.Camera, scene: THREE.Scene, geometry: THREE.BufferGeometry, material: THREE.Material,
  object: THREE.Object3D, group: unknown) => void;

export function benchLoadCensus(renderer: THREE.WebGLRenderer, drawOnce: () => void): BenchLoadCensus {
  const census: BenchLoadCensus = { calls: 0, triangles: 0, mainDraws: 0, shadowDraws: 0, skinnedDraws: 0,
    instancedDraws: 0, instances: 0, particleDraws: 0, particleQuads: 0, otherDraws: 0, scenes: 0 };
  const target = renderer as unknown as { renderBufferDirect: DirectDraw; render: THREE.WebGLRenderer["render"] };
  const direct = target.renderBufferDirect;
  const render = target.render;
  const shadowMap = renderer.shadowMap as unknown as { render: (...args: unknown[]) => void };
  const shadow = shadowMap.render;
  let inShadow = false;
  shadowMap.render = function (...args: unknown[]) {
    inShadow = true;
    try { shadow.apply(this, args); } finally { inShadow = false; }
  };
  target.render = function (scene, camera) {
    census.scenes++;
    render.call(renderer, scene, camera);
    // The renderer's info is the frame's own (WorldRenderer3D resets it per frame), read after each render.
    census.calls = renderer.info.render.calls;
    census.triangles = renderer.info.render.triangles;
  } as THREE.WebGLRenderer["render"];
  target.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    if (inShadow) census.shadowDraws++;
    else {
      census.mainDraws++;
      const mesh = object as THREE.Mesh & { isSkinnedMesh?: boolean; isInstancedMesh?: boolean; count?: number };
      if (mesh.isSkinnedMesh) census.skinnedDraws++;
      else if (mesh.isInstancedMesh) { census.instancedDraws++; census.instances += mesh.count ?? 0; }
      else if (mesh.renderOrder === 3 && mesh.frustumCulled === false && (material as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
        // Particle meshes (ParticleRender.ts): two triangles a quad.
        census.particleDraws++;
        const indexCount = geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0;
        census.particleQuads += Math.floor(Math.min(indexCount, geometry.drawRange.count) / 6);
      } else census.otherDraws++;
    }
    direct.call(renderer, camera, scene, geometry, material, object, group);
  };
  try { drawOnce(); } finally {
    target.renderBufferDirect = direct;
    target.render = render;
    shadowMap.render = shadow;
  }
  return census;
}
