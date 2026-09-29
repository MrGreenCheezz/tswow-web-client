import * as THREE from "three";
import { sampleRamp, sampleTrack } from "./Particles.js";
import {
  BLEND_ADD, BLEND_BLEND_ADD, BLEND_NO_ALPHA_ADD, MATERIAL_UNLIT,
  type WvmBatch, type WvmModel, type WvmParticleEmitter,
} from "./Wvm.js";
import { WORLD_LOCAL_LIGHT_LIMIT, type WorldLightUniforms } from "./WorldLighting.js";

/** Enhanced fixture light is an artistic addition, not a fabricated M2 light record. */
export interface FixtureLight {
  readonly position: readonly [number, number, number];
  readonly bone: number;
  readonly radius: number;
  readonly intensity: number;
  readonly colour: readonly [number, number, number];
  readonly batch?: WvmBatch;
  readonly emitter?: WvmParticleEmitter;
}

const fixtureCache = new WeakMap<WvmModel, Map<string, readonly FixtureLight[]>>();
const EMPTY: readonly FixtureLight[] = Object.freeze([]);

function fixtureColour(path: string): readonly [number, number, number] {
  if (/blue|ice|frost/.test(path)) return [0.32, 0.62, 1];
  if (/green|fel/.test(path)) return [0.42, 1, 0.28];
  if (/purple|violet/.test(path)) return [0.72, 0.40, 1];
  if (/red/.test(path)) return [1, 0.30, 0.14];
  return [1, 0.56, 0.20];
}

/**
 * Duskwood/Elwynn lamps have no M2 lights: they express illumination as an unlit additive glow
 * quad. Locate that existing flame/glow, never the model bounds (which include posts and chains).
 * The name gate prevents a creature's eyes, magic weapon or an arbitrary additive mesh becoming
 * a lamp. Off/broken fixtures and models without a visible luminous source remain dark.
 */
export function modelFixtureLights(model: WvmModel, name: string): readonly FixtureLight[] {
  let byName = fixtureCache.get(model);
  const cached = byName?.get(name);
  if (cached) return cached;
  if (!byName) { byName = new Map(); fixtureCache.set(model, byName); }
  const path = name.replaceAll("/", "\\").toLowerCase();
  const filename = path.slice(path.lastIndexOf("\\") + 1);
  if (!/(?:lamp|lantern|torch|brazier|campfire|bonfire|hearth|candle|chandelier|firepit)/.test(filename)
    || /(?:unlit|nolight|broken|wrecked|busted|(?:^|[_-])off(?:[_.-]|$)|\d?off\.)/.test(filename)) {
    byName.set(name, EMPTY);
    return EMPTY;
  }
  const lights: FixtureLight[] = [];
  const submeshes = new Set<number>();
  for (const batch of model.batches) {
    if (submeshes.has(batch.submesh) || (batch.materialFlags & MATERIAL_UNLIT) === 0
      || ![BLEND_ADD, BLEND_NO_ALPHA_ADD, BLEND_BLEND_ADD].includes(batch.blendMode)) continue;
    const texture = batch.textures.map((slot) => model.textures[slot]?.path ?? "").join(" ").toLowerCase();
    if (!/glow|flame|fire|light/.test(texture)) continue;
    const submesh = model.submeshes[batch.submesh];
    if (!submesh) continue;
    const vertices = new Set<number>();
    for (let index = submesh.indexStart; index < submesh.indexStart + submesh.indexCount; index++) {
      const vertex = model.indices[index];
      if (vertex !== undefined && vertex * 3 + 2 < model.positions.length) vertices.add(vertex);
    }
    if (vertices.size === 0) continue;
    const position: [number, number, number] = [0, 0, 0];
    const boneWeights = new Map<number, number>();
    for (const vertex of vertices) {
      for (let axis = 0; axis < 3; axis++) position[axis]! += model.positions[vertex * 3 + axis]! / vertices.size;
      for (let slot = 0; slot < 4; slot++) {
        const bone = model.boneIndices?.[vertex * 4 + slot];
        const weight = model.boneWeights?.[vertex * 4 + slot] ?? 0;
        if (bone !== undefined && weight > 0) boneWeights.set(bone, (boneWeights.get(bone) ?? 0) + weight);
      }
    }
    if (!position.every(Number.isFinite)) continue;
    let bone = -1;
    let weight = 0;
    for (const [candidate, sum] of boneWeights) if (sum > weight) { bone = candidate; weight = sum; }
    lights.push({ position, bone, radius: 8, intensity: 1.1, colour: fixtureColour(`${filename} ${texture}`), batch });
    submeshes.add(batch.submesh);
    if (lights.length === 4) break;
  }
  // A glow card already represents its flame. Adding its particles again doubles one fixture.
  if (lights.length === 0) {
    for (const emitter of model.particleEmitters) {
      const texture = model.textures[emitter.texture]?.path?.toLowerCase() ?? "";
      if (!/flame|fire|glow/.test(texture) || /smoke|spark|ember/.test(texture)) continue;
      if (!emitter.position.every(Number.isFinite)) continue;
      const fire = /campfire|bonfire|hearth|firepit|brazier/.test(filename);
      lights.push({
        position: emitter.position, bone: emitter.bone, radius: fire ? 7 : 6,
        intensity: fire ? 1.15 : 1.1, colour: fixtureColour(`${filename} ${texture}`), emitter,
      });
      if (lights.length >= 4) break;
    }
  }
  byName.set(name, lights.length > 0 ? lights : EMPTY);
  return lights.length > 0 ? lights : EMPTY;
}

export interface LocalLightSample {
  readonly position: THREE.Vector3;
  readonly colour: THREE.Vector3;
  radius: number;
  intensity: number;
}

const flameColour = [1, 1, 1];
const flameOpacity = [1];

/** Tracks which hide a flame/glow also turn its light off; its global colour loop is preserved. */
export function sampleFixtureLight(
  fixture: FixtureLight,
  model: WvmModel,
  matrix: THREE.Matrix4,
  animationMs: number,
  worldMs: number,
  result: LocalLightSample,
): boolean {
  const sample = (track: Parameters<typeof sampleTrack>[0], fallback: number, component = 0): number =>
    sampleTrack(track, animationMs, worldMs, model.globalSequences, fallback, component);
  let opacity = 1;
  result.colour.set(...fixture.colour);
  if (fixture.batch) {
    const batch = fixture.batch;
    const colour = model.colours[batch.colorIndex];
    opacity = sample(model.textureWeights[batch.textureWeight], 1) * sample(colour?.alpha, 1);
    if (colour) {
      result.colour.x *= sample(colour.rgb, 1, 0);
      result.colour.y *= sample(colour.rgb, 1, 1);
      result.colour.z *= sample(colour.rgb, 1, 2);
    }
  }
  if (fixture.emitter) {
    const emitter = fixture.emitter;
    if (sample(emitter.enabledIn, 1) <= 0.5 || sample(emitter.emissionRate, 0) <= 0) return false;
    // The living flame's colour comes from its own lifetime ramp; skip the faded tail.
    const colour = sampleRamp(emitter.color, 0.2, flameColour, 1);
    const peak = Math.max(colour[0]!, colour[1]!, colour[2]!);
    if (peak > 0) result.colour.set(colour[0]! / peak, colour[1]! / peak, colour[2]! / peak);
    opacity = sampleRamp(emitter.opacity, 0.2, flameOpacity, 1)[0]!;
  }
  if (!Number.isFinite(opacity) || opacity <= 0.001) return false;
  result.position.set(...fixture.position).applyMatrix4(matrix);
  const e = matrix.elements;
  const scale = Math.max(Math.hypot(e[0]!, e[1]!, e[2]!), Math.hypot(e[4]!, e[5]!, e[6]!),
    Math.hypot(e[8]!, e[9]!, e[10]!));
  result.radius = Math.min(12, fixture.radius * scale);
  // Stable low-amplitude flicker; no random calls and no dependency on frame rate.
  const phase = e[12]! * 0.71 + e[13]! * 0.37 + e[14]! * 0.53;
  const seconds = worldMs / 1000;
  const flicker = 0.94 + 0.04 * Math.sin(seconds * 4.1 + phase) + 0.02 * Math.sin(seconds * 7.7 + phase * 1.7);
  result.intensity = fixture.intensity * Math.min(1, opacity) * flicker;
  return Number.isFinite(result.radius) && result.radius > 0
    && Number.isFinite(result.intensity)
    && Number.isFinite(result.colour.x) && Number.isFinite(result.colour.y) && Number.isFinite(result.colour.z)
    && Number.isFinite(result.position.x) && Number.isFinite(result.position.y) && Number.isFinite(result.position.z);
}

/** CPU twin of the shared shader's soft, finite-radius attenuation. */
export function localLightFalloff(distance: number, radius: number): number {
  if (!(radius > 0) || !Number.isFinite(distance) || !Number.isFinite(radius)) return 0;
  const t = Math.max(0, Math.min(1, distance / radius));
  return 1 - t * t * (3 - 2 * t);
}

/** A tiny reusable ranked list; never creates lights, render targets or shader variants. */
export class LocalLightSelection {
  readonly #entries = Array.from({ length: WORLD_LOCAL_LIGHT_LIMIT }, () => ({
    position: new THREE.Vector3(), colour: new THREE.Vector3(), radius: 0, intensity: 0, distance: Infinity,
  }));
  #count = 0;
  #limit = 0;

  begin(limit: number): void {
    this.#count = 0;
    this.#limit = Math.max(0, Math.min(WORLD_LOCAL_LIGHT_LIMIT, Math.floor(limit)));
  }

  add(sample: LocalLightSample, camera: THREE.Vector3): void {
    if (this.#limit === 0) return;
    const distance = sample.position.distanceToSquared(camera);
    if (distance > 64 * 64) return;
    let index = this.#count;
    while (index > 0 && this.#entries[index - 1]!.distance > distance) index--;
    if (index >= this.#limit) return;
    const reusable = this.#entries[Math.min(this.#count, this.#limit - 1)]!;
    for (let at = Math.min(this.#count, this.#limit - 1); at > index; at--) this.#entries[at] = this.#entries[at - 1]!;
    this.#entries[index] = reusable;
    reusable.position.copy(sample.position);
    reusable.colour.copy(sample.colour);
    reusable.radius = sample.radius;
    reusable.intensity = sample.intensity;
    reusable.distance = distance;
    this.#count = Math.min(this.#count + 1, this.#limit);
  }

  write(uniforms: WorldLightUniforms, viewMatrix: THREE.Matrix4): number {
    uniforms.wowLocalLightCount.value = this.#count;
    for (let index = 0; index < this.#count; index++) {
      const entry = this.#entries[index]!;
      const position = uniforms.wowLocalLightPosition.value[index]!;
      position.set(entry.position.x, entry.position.y, entry.position.z, 1).applyMatrix4(viewMatrix);
      position.w = entry.radius;
      uniforms.wowLocalLightColour.value[index]!.set(entry.colour.x, entry.colour.y, entry.colour.z, entry.intensity);
    }
    return this.#count;
  }
}
