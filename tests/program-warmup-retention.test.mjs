import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { ProgramWarmup, PROGRAM_WARMUP_RETAINED_PROGRAMS } from "../dist/code/browser/ProgramWarmup.js";

/** Models Three's acquire/release ownership at Material.dispose, with actual material events. */
function rendererWithProgramLifetimes() {
  const records = new Map(), programs = new Map(), compiled = [], disposed = [];
  let serial = 0;
  return {
    records, programs, compiled, disposed,
    get creations() { return serial; },
    extensions: { has: () => true },
    properties: { get: material => records.get(material) },
    compile(scene) {
      const materials = new Set();
      scene.traverse(mesh => {
        if (!mesh.isMesh) return;
        const material = mesh.material;
        materials.add(material);
        let record = records.get(material);
        if (!record) {
          record = { programs: new Map() };
          records.set(material, record);
          material.addEventListener("dispose", () => {
            disposed.push(material);
            for (const program of record.programs.values()) {
              program.references--;
              if (program.references === 0) {
                programs.delete(program.key);
                program.program = undefined;
              }
            }
            records.delete(material);
          });
        }
        const sides = material.transparent && material.side === THREE.DoubleSide && !material.forceSinglePass
          ? [THREE.BackSide, THREE.FrontSide] : [material.side];
        for (const side of sides) {
          const key = JSON.stringify([material.type, material.customProgramCacheKey(), side,
            !!mesh.isSkinnedMesh, !!mesh.isInstancedMesh, mesh.geometry.getAttribute("color")?.itemSize,
            !!material.map, material.vertexColors]);
          if (!record.programs.has(key)) {
            const shader = { uniforms: {} };
            material.onBeforeCompile(shader, this);
            record.uniforms = shader.uniforms;
            let program = programs.get(key);
            if (!program) {
              program = { key, id: serial++, references: 0, program: {}, isReady: () => true,
                uniformFetches: 0, getUniforms() { this.uniformFetches++; } };
              programs.set(key, program);
            }
            program.references++;
            record.programs.set(key, program);
            record.currentProgram = program;
          }
        }
        compiled.push({ material, record, keys: [...record.programs.keys()] });
      });
      return materials;
    },
  };
}

function fadingMesh(key = "same", colourSize = 3) {
  const geometry = new THREE.BoxGeometry();
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(
    new Float32Array(geometry.attributes.position.count * colourSize), colourSize,
  ));
  const material = new THREE.MeshStandardMaterial({ transparent: true, side: THREE.DoubleSide, vertexColors: true });
  material.customProgramCacheKey = () => key;
  return new THREE.SkinnedMesh(geometry, material);
}

test("identical shaders survive repeated transient material disposal without new program creation", () => {
  const renderer = rendererWithProgramLifetimes(), target = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const warmup = new ProgramWarmup(renderer, target);
  let firstIds;
  for (let cycle = 0; cycle < 12; cycle++) {
    const mesh = fadingMesh();
    warmup.registerObject(mesh);
    warmup.tick(camera);
    // The live material acquires the same ordinary renderer programs on its first submission.
    renderer.compile(new THREE.Group().add(mesh));
    const ids = [...renderer.programs.values()].map(p => p.id);
    firstIds ??= ids;
    assert.deepEqual(ids, firstIds);
    warmup.unregisterObject(mesh);
    mesh.material.dispose();
    mesh.geometry.dispose();
    assert.deepEqual([...renderer.programs.values()].map(p => p.id), firstIds,
      "retiring the visible material must not destroy the last compiled owner");
    assert.equal(warmup.retainedPrograms, 2, "back and front each consume one retained program reference");
  }
  assert.equal(renderer.creations, 2);
  warmup.reset();
  assert.equal(renderer.programs.size, 0);
  assert.equal(warmup.retainedPrograms, 0);
});

test("keepers preserve exact geometry and custom shader variants without retaining source textures or uniforms", () => {
  const renderer = rendererWithProgramLifetimes(), warmup = new ProgramWarmup(renderer, new THREE.Scene());
  const camera = new THREE.PerspectiveCamera(), texture = new THREE.Texture();
  const uniform = { value: texture };
  const meshes = [fadingMesh("layer", 3), fadingMesh("layer", 4)];
  for (const mesh of meshes) {
    mesh.material.map = texture;
    mesh.material.userData = { source: "original" };
    mesh.material.onBeforeCompile = shader => { shader.uniforms.layer = uniform; };
    warmup.registerObject(mesh);
  }
  warmup.tick(camera);
  assert.equal(warmup.retainedPrograms, 4, "RGB/RGBA and both sides remain distinct");
  assert.equal(renderer.programs.size, 4);
  for (const { material, record } of renderer.compiled) {
    assert.ok(meshes.every(mesh => mesh.material !== material));
    assert.equal(material.map, null);
    assert.deepEqual(material.userData, {});
    assert.equal(material.onBeforeCompile, THREE.Material.prototype.onBeforeCompile);
    assert.deepEqual(record.uniforms, {});
  }
  assert.equal(uniform.value, texture, "detach the keeper's container, never clear a shared uniform value");
  assert.ok(meshes.every(mesh => mesh.material.map === texture));
  for (const mesh of meshes) renderer.compile(new THREE.Group().add(mesh));
  assert.equal(renderer.creations, 4, "a real draw with custom hooks reuses exactly the warmed key");
  warmup.reset();
  assert.equal(renderer.programs.size, 4, "real owners survive keeper disposal");
  for (const mesh of meshes) { mesh.material.dispose(); mesh.geometry.dispose(); }
  assert.equal(renderer.programs.size, 0);
});

test("retention counts both sides, evicts least-recently used owners and permits a dropped hint to requeue", () => {
  const renderer = rendererWithProgramLifetimes(), warmup = new ProgramWarmup(renderer, new THREE.Scene());
  const camera = new THREE.PerspectiveCamera(), meshes = [];
  for (let index = 0; index < PROGRAM_WARMUP_RETAINED_PROGRAMS / 2; index++) {
    const mesh = fadingMesh(String(index));
    meshes.push(mesh);
    warmup.registerObject(mesh);
    warmup.tick(camera);
  }
  assert.equal(warmup.retainedPrograms, PROGRAM_WARMUP_RETAINED_PROGRAMS);
  warmup.registerObject(meshes[0]);
  assert.equal(warmup.queued, 0, "touching a live hint updates recency without recompiling");
  warmup.registerObject(fadingMesh("overflow"));
  warmup.tick(camera);
  assert.equal(renderer.programs.size, PROGRAM_WARMUP_RETAINED_PROGRAMS);
  assert.equal(warmup.retainedPrograms, PROGRAM_WARMUP_RETAINED_PROGRAMS);
  warmup.registerObject(meshes[0]);
  assert.equal(warmup.queued, 0, "recently touched first owner remains retained");
  warmup.registerObject(meshes[1]);
  assert.equal(warmup.queued, 1, "evicted program handles invalidate a completed warmup hint");
  warmup.tick(camera);
  assert.equal(warmup.retainedPrograms, PROGRAM_WARMUP_RETAINED_PROGRAMS);
  warmup.reset();
  assert.equal(renderer.programs.size, 0);
  assert.equal(new Set(renderer.disposed).size, renderer.disposed.length, "owners dispose exactly once");
});

test("failed compilation releases any programs acquired before the failure and allows retry", () => {
  const renderer = rendererWithProgramLifetimes(), warmup = new ProgramWarmup(renderer, new THREE.Scene());
  const compile = renderer.compile.bind(renderer);
  renderer.compile = scene => { compile(scene); throw new Error("later compile failed"); };
  const mesh = fadingMesh(), camera = new THREE.PerspectiveCamera();
  warmup.registerObject(mesh);
  warmup.tick(camera);
  assert.equal(warmup.failures, 1);
  assert.equal(warmup.retainedPrograms, 0);
  assert.equal(renderer.programs.size, 0, "partial shader acquisition cannot leak an owner");
  renderer.compile = compile;
  warmup.registerObject(mesh);
  warmup.tick(camera);
  assert.equal(warmup.retainedPrograms, 2);
  warmup.reset();
  assert.equal(renderer.programs.size, 0);
});
