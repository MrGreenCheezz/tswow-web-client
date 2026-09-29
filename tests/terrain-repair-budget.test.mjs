import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { streamingHarness } from './terrain-streaming-harness.mjs';
import { TERRAIN_GRID_SIZE } from '../dist/code/browser/Terrain.js';
import * as THREE from 'three';
import { rendererMethods } from './terrain-streaming-harness.mjs';

const source = readFileSync(new URL('../src/browser/WorldRenderer3D.ts', import.meta.url), 'utf8');
const player = { x: -0.9 * TERRAIN_GRID_SIZE, y: -0.5 * TERRAIN_GRID_SIZE, z: 10, orientation: 0 };
function fixture(options = {}) {
  const renderer = streamingHarness(source, { clock: { now: () => 0 }, ...options });
  const cpu = { revision: 1, stats: { active: 0 },
    setActiveTiles() {}, ownRevision() { return 1; }, tileRevision() { return this.revision; },
    heightAt() { return 1; }, isHole() { return false; }, isReady() { return true; } };
  const draw = () => renderer.updateTerrain(player, 0, () => 1, cpu);
  for (let frame = 0; frame < 9; frame++) draw();
  return { renderer, cpu, draw };
}

test('a speculative neighbour revision does not synchronously rebuild visible terrain', () => {
  const { renderer, cpu, draw } = fixture({ repairSteps: 500 });
  const retained = [...renderer.terrains.values()].map(tile => [tile, tile.mesh.geometry]);
  cpu.revision++;
  draw();
  assert.equal(renderer.rebuilt, 0, 'the foreground repair must use a bounded generator');
  for (const [tile, geometry] of retained) {
    assert.equal(tile.mesh.geometry, geometry, 'old visible ground stays until the full repair is ready');
    assert.equal(tile.revision, 1, 'do not publish a revision whose geometry is still incomplete');
  }
  renderer.clearTerrain();
});

test('a completed repair atomically replaces ground, retains splat material and eventually repairs every tile', () => {
  const { renderer, cpu, draw } = fixture({ repairSteps: 500 });
  const retained = [...renderer.terrains.values()].map(tile => ({ tile, geometry: tile.mesh.geometry, material: tile.material }));
  const disposed = new Set();
  for (const { geometry } of retained) geometry.addEventListener('dispose', () => disposed.add(geometry));
  cpu.revision++;
  for (let frame = 0; frame < 3; frame++) {
    draw();
    assert.equal(disposed.size, 0);
    assert.ok(renderer.repairAdvances <= (frame + 1) * 128, 'zero-resolution clocks still cap per-frame steps');
  }
  draw();
  assert.equal(disposed.size, 1);
  assert.equal(renderer.terrainRepairsPending, 8);
  for (let frame = 0; frame < 32; frame++) draw();
  assert.equal(renderer.terrainRepairsPending, 0);
  assert.equal(disposed.size, 9);
  for (const { tile, geometry, material } of retained) {
    assert.notEqual(tile.mesh.geometry, geometry);
    assert.equal(tile.mesh.material, material);
    assert.equal(tile.material, material);
    assert.equal(tile.revision, 2);
    assert.equal(tile.ownRevision, 1);
  }
  renderer.clearTerrain();
});

test('updated dependencies and map changes cancel unfinished repairs without publishing stale geometry', () => {
  const { renderer, cpu, draw } = fixture({ repairSteps: 500 });
  cpu.revision++;
  draw();
  const first = renderer.terrainRepair, geometry = first.rendered.mesh.geometry;
  cpu.revision++;
  draw();
  assert.equal(renderer.repairCancelled, 1);
  assert.notEqual(renderer.terrainRepair, first);
  assert.equal(renderer.terrainRepair.revision, 3);
  assert.equal(first.rendered.mesh.geometry, geometry);
  assert.equal(first.rendered.revision, 1);
  renderer.updateTerrain(player, 1, () => 1, cpu);
  assert.equal(renderer.repairCancelled, 2);
  assert.ok([...renderer.terrains.keys()].every(key => key.startsWith('1/')));
  renderer.clearTerrain();
  assert.equal(renderer.terrainRepair, undefined);
  assert.equal(renderer.terrainRepairsPending, 0);
});

test('liquid strip arrival replaces water only, and disposal never releases shared water materials', () => {
  const { renderer, cpu, draw } = fixture();
  const tile = renderer.terrains.get('0/32/32');
  const geometry = tile.mesh.geometry;
  const sharedMaterial = new THREE.MeshBasicMaterial();
  const oldWater = new THREE.Mesh(new THREE.BufferGeometry(), sharedMaterial);
  tile.water = [oldWater]; renderer.scene.add(oldWater);
  let oldDisposed = 0, materialDisposed = 0;
  oldWater.geometry.addEventListener('dispose', () => oldDisposed++);
  sharedMaterial.addEventListener('dispose', () => materialDisposed++);
  const replacement = new THREE.BufferGeometry();
  renderer.liquidTextures = { generation: 1 };
  renderer.liquidMaterial = () => ({ material: sharedMaterial });
  renderer.repairTerrainSteps = function* (_map, _grid, _player, _height, _client, ground, water) {
    assert.equal(ground, false);
    assert.equal(water, true);
    yield;
    return { water: new Map([['water', replacement]]) };
  };
  draw();
  assert.equal(tile.mesh.geometry, geometry);
  assert.equal(tile.liquidGeneration, 1);
  assert.equal(oldDisposed, 1);
  assert.equal(materialDisposed, 0);
  assert.equal(tile.water[0].geometry, replacement);
  assert.equal(tile.water[0].material, sharedMaterial);
  assert.equal(tile.water[0].visible, tile.mesh.visible);
  renderer.clearTerrain();
  assert.equal(materialDisposed, 0);
  sharedMaterial.dispose();
});

test('repair failures retain visible resources and release completed replacement water', () => {
  const { renderer, cpu, draw } = fixture();
  const tile = renderer.terrains.get('0/32/32'), oldGeometry = tile.mesh.geometry;
  cpu.revision++;
  renderer.repairTerrainSteps = function* () { yield; throw new Error('broken sampler'); };
  assert.throws(draw, /broken sampler/);
  assert.equal(renderer.terrainRepair, undefined);
  assert.equal(tile.mesh.geometry, oldGeometry);
  assert.equal(tile.revision, 1);
  const water = new THREE.BufferGeometry();
  let disposed = 0;
  water.addEventListener('dispose', () => disposed++);
  renderer.repairTerrainSteps = function* () { return { data: {}, water: new Map([['water', water]]) }; };
  renderer.terrainGeometryFromData = () => { throw new Error('buffer install failed'); };
  assert.throws(draw, /buffer install failed/);
  assert.equal(disposed, 1);
  assert.equal(tile.mesh.geometry, oldGeometry);
  assert.equal(tile.revision, 1);
  renderer.clearTerrain();
});

test('the real repair generator bounds terrain samples and skips water for known-dry neighbour repairs', () => {
  const Harness = rendererMethods(source, ['#repairTerrainSteps', '#terrainBoundingSphereSteps', '#terrainGeometryFromData']);
  const renderer = new Harness();
  renderer.waterGeometrySteps = function* () { assert.fail('known-dry neighbour repair must not scan water'); };
  let samples = 0, largestSamples = 0, steps = 0;
  const job = renderer.repairTerrainSteps(0, { x: 32, y: 32 }, player,
    (x, y) => { samples++; return Math.sin(x / 100) + Math.cos(y / 100); },
    { isHole: () => false }, true, false);
  let result;
  do {
    samples = 0; result = job.next(); steps++;
    largestSamples = Math.max(largestSamples, samples);
  } while (!result.done);
  assert.ok(steps > 50);
  assert.ok(largestSamples <= 4 * 131, `one step sampled ${largestSamples} heights`);
  assert.equal(result.value.water, undefined);
  assert.equal(result.value.data.positions.length, 33025 * 3);
  const reference = new THREE.BufferGeometry();
  reference.setAttribute('position', new THREE.BufferAttribute(result.value.data.positions, 3));
  reference.computeBoundingSphere();
  assert.deepEqual(result.value.boundingSphere, reference.boundingSphere, 'bounds retain exact Three arithmetic');
  const installed = renderer.terrainGeometryFromData(result.value.data, result.value.boundingSphere);
  assert.equal(installed.boundingSphere, result.value.boundingSphere, 'commit uses already finished bounds');
  reference.dispose(); installed.dispose();
});
