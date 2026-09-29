/** Synthetic lifetime probe using the real Three.js/WebGL renderer and ProgramWarmup. */
import * as THREE from 'three';
import { ProgramWarmup } from '../src/browser/ProgramWarmup.js';

const canvas = document.querySelector('canvas')!;
const button = document.querySelector('button')!;
const output = document.querySelector('pre')!;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(640, 360, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15181d);
const camera = new THREE.PerspectiveCamera(45, 640 / 360, .1, 100);
camera.position.z = 4;
const visible = new THREE.Mesh(new THREE.SphereGeometry(.8, 24, 16), new THREE.MeshNormalMaterial());
scene.add(visible);
renderer.render(scene, camera);
const results: unknown[] = [];

button.addEventListener('click', async () => {
  button.disabled = true;
  const warmup = new ProgramWarmup(renderer, scene);
  const cycles = [];
  for (let cycle = 0; cycle < 8; cycle++) {
    const group = new THREE.Group();
    const batch: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];
    for (let i = 0; i < 24; i++) {
      const material = new THREE.MeshBasicMaterial();
      // Different authored shader profiles; no scene objects or network packets are fabricated.
      material.defines = { AUDIT_VARIANT: cycle * 24 + i };
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(.1, .1, .1), material);
      batch.push(mesh);
      group.add(mesh);
    }
    const registeredAt = performance.now();
    warmup.registerObject(group);
    const registrationCpuMs = performance.now() - registeredAt;
    const queuedBeforeDispose = warmup.queued;
    const disposedAt = performance.now();
    for (const mesh of batch) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    const disposalCpuMs = performance.now() - disposedAt;
    const queuedAfterDispose = warmup.queued;
    const started = performance.now();
    for (let i = 0; i < 8; i++) warmup.tick(camera);
    const warmupCpuMs = performance.now() - started;
    renderer.render(scene, camera);
    cycles.push({ cycle, queuedBeforeDispose, queuedAfterDispose, registrationCpuMs, disposalCpuMs,
      warmupCpuMs, queueLifecycleCpuMs: registrationCpuMs + disposalCpuMs + warmupCpuMs,
      programCount: renderer.info.programs?.length ?? null,
      visibleCalls: renderer.info.render.calls, visibleTriangles: renderer.info.render.triangles });
    // A second disposal is test cleanup only. The game does not dispose an already retired owner.
    for (const mesh of batch) mesh.material.dispose();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
  results.push({ run: results.length + 1, label: 'synthetic: 8 bursts of 24 disposed queued meshes',
    viewport: [innerWidth, innerHeight], canvas: [canvas.width, canvas.height], dpr: devicePixelRatio,
    cycles, compiledDiscardedMaterials: warmup.programs, failures: warmup.failures,
    programsAfterCleanup: renderer.info.programs?.length ?? null,
    gpuTime: 'unavailable: timings above are CPU submission, not GPU execution' });
  warmup.reset();
  output.textContent = JSON.stringify(results, null, 2);
  button.disabled = false;
});

document.querySelector('#compiled-disposal')!.addEventListener('click', () => {
  const warmup = new ProgramWarmup(renderer, scene);
  const material = new THREE.MeshBasicMaterial();
  material.defines = { AUDIT_DISPOSE_AFTER_COMPILE: 1 };
  const geometry = new THREE.BoxGeometry();
  warmup.registerObject(new THREE.Mesh(geometry, material));
  warmup.tick(camera);
  const program = renderer.properties.get(material)['currentProgram'] as {
    program: WebGLProgram | undefined; isReady(): boolean | null;
  } | undefined;
  let readinessQueries = 0;
  if (program) {
    const isReady = program.isReady.bind(program);
    program.isReady = () => { readinessQueries++; return isReady(); };
  }
  material.dispose();
  geometry.dispose();
  const handleCleared = program !== undefined && program.program === undefined;
  for (let frame = 0; frame < 4; frame++) warmup.tick(camera);
  renderer.render(scene, camera);
  document.querySelector('#compiled-disposal-result')!.textContent = JSON.stringify({
    label: 'synthetic: dispose compiled program before warmup settling',
    compiled: warmup.programs, handleCleared, readinessQueries,
    uniformsFetched: warmup.uniformLocations, programs: renderer.info.programs?.length ?? null,
    visibleCalls: renderer.info.render.calls, visibleTriangles: renderer.info.render.triangles,
  }, null, 2);
  warmup.reset();
});
