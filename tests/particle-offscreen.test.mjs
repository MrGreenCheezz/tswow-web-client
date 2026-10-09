import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";

import {
  PARTICLE_FLAG_MODEL_SPACE, PARTICLE_FLAG_PINNED, PARTICLE_FLAG_XY_QUAD,
  createParticleSystem, createQuadBuffers, writeParticleQuads,
} from "../dist/code/browser/Particles.js";
import { particlesOutside } from "../dist/code/browser/ParticleRender.js";

// 12.08: an emitter judged off screen must be one whose written quads could not be seen: the box
// of every vertex `writeParticleQuads` would write lies outside the frustum whenever
// `particlesOutside` says so.

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const ramp = (values, components = 1) => ({ components, times: Float32Array.from(values.map((_, i) => i / Math.max(1, values.length / components - 1))).slice(0, values.length / components), values: Float32Array.from(values) });
const track = () => ({ interpolation: 0, globalSequence: -1, components: 1, tracks: [] });

function emitter(flags, next) {
  const blank = {
    id: 1, flags, position: [0, 0, 0], bone: 0, texture: 0, blendType: 4, emitterType: 1,
    particleType: 0, headTail: 0, particleColorIndex: 0, textureTileRotation: 0,
    textureRows: 1, textureColumns: 1, lifespanVary: 0, emissionRateVary: 0, scaleVary: [0, 0],
    tailLength: next() < 0.5 ? 0 : next() * 2, twinkleSpeed: 0, twinklePercent: 0, twinkleScaleMin: 0, twinkleScaleMax: 0,
    burstMultiplier: 0, drag: 0, baseSpin: 0, baseSpinVary: 0, spin: 0, spinVary: 0,
    windVector: [0, 0, 0], windTime: 0, followSpeed1: 0, followScale1: 0, followSpeed2: 0,
    followScale2: 0, splinePoints: new Float32Array(0),
  };
  for (const name of ["emissionSpeed", "speedVariation", "verticalRange", "horizontalRange",
    "gravity", "lifespan", "emissionRate", "emissionAreaLength", "emissionAreaWidth", "zSource",
    "enabledIn"]) blank[name] = track();
  const keys = 3;
  const scale = [];
  for (let index = 0; index < keys; index++) scale.push(0.1 + next() * 4, 0.1 + next() * 4);
  blank.scale = ramp(scale, 2);
  blank.color = ramp([1, 1, 1, 1, 1, 1], 3);
  blank.opacity = ramp([1, 1]);
  blank.headCell = ramp([0, 0]);
  blank.tailCell = ramp([0, 0]);
  return blank;
}

function system(seed) {
  const next = random(seed);
  const flags = (next() < 0.4 ? PARTICLE_FLAG_PINNED : 0) | (next() < 0.4 ? PARTICLE_FLAG_MODEL_SPACE : 0)
    | (next() < 0.25 ? PARTICLE_FLAG_XY_QUAD : 0);
  const made = createParticleSystem(emitter(flags, next), new Uint32Array(0), seed);
  const centre = [(next() - 0.5) * 300, (next() - 0.5) * 60, (next() - 0.5) * 300];
  for (let index = 0, count = 1 + Math.floor(next() * 40); index < count; index++) {
    const x = centre[0] + (next() - 0.5) * 20, y = centre[1] + (next() - 0.5) * 20, z = centre[2] + (next() - 0.5) * 20;
    made.particles.push({
      x, y, z, vx: (next() - 0.5) * 30, vy: (next() - 0.5) * 30, vz: (next() - 0.5) * 30,
      bx: x + (next() - 0.5) * 15, by: y + (next() - 0.5) * 15, bz: z + (next() - 0.5) * 15,
      age: next() * 0.9, life: 1, scaleX: 0.3 + next() * 2, scaleY: 0.3 + next() * 2,
      spin: next() * 6, spinRate: 0, cellOffset: 0, phase: 0,
    });
  }
  if (made.modelSpace) {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3((next() - 0.5) * 50, (next() - 0.5) * 10, (next() - 0.5) * 50),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(next() * 6, next() * 6, next() * 6)),
      new THREE.Vector3(0.3 + next() * 3, 0.3 + next() * 3, 0.3 + next() * 3));
    made.matrix.set(matrix.elements);
  }
  return made;
}

function view(next) {
  const camera = new THREE.PerspectiveCamera(50 + next() * 40, 1.7, 0.3, 600);
  camera.position.set((next() - 0.5) * 300, (next() - 0.5) * 80, (next() - 0.5) * 300);
  camera.lookAt((next() - 0.5) * 300, (next() - 0.5) * 30, (next() - 0.5) * 300);
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  return { frustum, billboard: { rightX: right.x, rightY: right.y, rightZ: right.z, upX: up.x, upY: up.y, upZ: up.z } };
}

test("off screen means every written quad is off screen, over 3000 random systems and views", () => {
  const identity = new THREE.Matrix4();
  let culled = 0, kept = 0;
  for (let seed = 1; seed <= 3000; seed++) {
    const next = random(seed * 977);
    const made = system(seed);
    const { frustum, billboard } = view(next);
    const outside = particlesOutside(made, frustum, identity);
    const buffers = createQuadBuffers(256);
    const quads = writeParticleQuads(made, billboard, buffers);
    const box = new THREE.Box3();
    for (let index = 0; index < quads * 12; index += 3) {
      box.expandByPoint(new THREE.Vector3(buffers.positions[index], buffers.positions[index + 1], buffers.positions[index + 2]));
    }
    if (outside) {
      culled++;
      assert.ok(quads === 0 || !frustum.intersectsBox(box), `seed ${seed}: judged off screen, but a written quad reaches the view`);
    } else kept++;
  }
  assert.ok(culled > 300 && kept > 300, `both answers occur (${culled} culled, ${kept} kept)`);
});

test("an empty system or twinkle is never culled; the renderer passes its frustum", () => {
  const made = system(5);
  made.particles.length = 0;
  const far = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().makeOrthographic(-1, 1, 1, -1, 0.1, 1));
  assert.equal(particlesOutside(made, far, new THREE.Matrix4()), false);
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /firstBurstAnimationMs: 0 \} : \{\}\),\s+frustum: this\.#effectFrustum,/);
  const render = readFileSync(new URL("../src/browser/ParticleRender.ts", import.meta.url), "utf8");
  assert.match(render, /if \(particles\.length === 0 \|\| renderSwitches\.particleTwinkle\) return false;/);
  assert.match(render, /drawn\.mesh\.visible = quads > 0;/);
});

test("a quad whose centre is just past the edge but whose half-size reaches in is kept", () => {
  // An orthographic view of x, y in [-1, 1] looking down -z; one particle at x = 1.7 whose quad is
  // 2 wide (scale ramp 2, factor 1): it spans x 0.7 … 2.7 and so shows on screen.
  const next = random(9);
  const made = createParticleSystem(emitter(0, next), new Uint32Array(0), 9);
  made.emitter.scale = { components: 2, times: Float32Array.from([0, 1]), values: Float32Array.from([2, 2, 2, 2]) };
  made.particles.push({ x: 1.7, y: 0, z: -5, vx: 0, vy: 0, vz: 0, bx: 1.7, by: 0, bz: -5,
    age: 0.5, life: 1, scaleX: 1, scaleY: 1, spin: 0, spinRate: 0, cellOffset: 0, phase: 0 });
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const buffers = createQuadBuffers(4);
  const quads = writeParticleQuads(made, { rightX: 1, rightY: 0, rightZ: 0, upX: 0, upY: 1, upZ: 0 }, buffers);
  assert.equal(quads, 1);
  const box = new THREE.Box3();
  for (let index = 0; index < 12; index += 3) box.expandByPoint(new THREE.Vector3(buffers.positions[index], buffers.positions[index + 1], buffers.positions[index + 2]));
  assert.ok(frustum.intersectsBox(box), "the written quad does reach the view");
  assert.equal(particlesOutside(made, frustum, new THREE.Matrix4()), false);
  made.particles[0].x = made.particles[0].bx = 3.5; // now 2.5 … 4.5: really off screen
  assert.equal(particlesOutside(made, frustum, new THREE.Matrix4()), true);
});
