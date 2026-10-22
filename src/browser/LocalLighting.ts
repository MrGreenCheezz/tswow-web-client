import * as THREE from "three";
import { sampleRamp, sampleTrack } from "./Particles.js";
import { renderSwitches } from "./RenderSwitches.js"; // 05.10-A7a-F2
import {
  BLEND_ADD, BLEND_BLEND_ADD, BLEND_NO_ALPHA_ADD, MATERIAL_UNLIT,
  type WvmBatch, type WvmLight, type WvmModel, type WvmParticleEmitter, // 05.10-A7a-F2
} from "./Wvm.js";
import {
  M2_LIGHT_ATTENUATION, M2_LIGHT_FALLOFF_CAP, WORLD_LOCAL_LIGHT_LIMIT, type WorldLightUniforms,
} from "./WorldLighting.js";
import { localLightSelectionFade } from "./CinematicLights.js"; // 22.10 (7.36)

/** Camera distance, in yards, past which no fixture is selected. */
const LOCAL_LIGHT_RANGE = 64;

/** Enhanced fixture light is an artistic addition, not a fabricated M2 light record. */
export interface FixtureLight {
  readonly position: readonly [number, number, number];
  readonly bone: number;
  readonly radius: number;
  readonly intensity: number;
  readonly colour: readonly [number, number, number];
  readonly batch?: WvmBatch;
  readonly emitter?: WvmParticleEmitter;
  /** 05.10-A7a-F2 (6.17): the model's own `M2Light`, whose tracks drive colour, reach and visibility. */
  readonly light?: WvmLight;
}

/** 05.10-A7a-F2 (6.17): `M2Light.type` 1; type 0 (directional) lights nothing in the world. */
const M2_LIGHT_POINT = 1;

/**
 * 05.10-A7a-F2 (6.17): the point lights the file itself declares — 104 models in the 05.10 census
 * (`humanguardtower.m2` ×4, `undeadcampfire.m2`, `smallbrazier01.m2`, …). Named by the file, so the
 * file-name gate below does not apply to them; everything else keeps the heuristic.
 */
function m2PointLights(model: WvmModel): FixtureLight[] {
  const lights: FixtureLight[] = [];
  for (const light of model.lights ?? []) {
    if (light.type !== M2_LIGHT_POINT || !light.position.every(Number.isFinite)) continue;
    // 12.10-6.17: the client's reach, not the file's attenuation end (`m2LightFalloff`).
    lights.push({
      position: light.position, bone: light.bone, radius: M2_LIGHT_REACH,
      intensity: 1, colour: [1, 1, 1], light,
    });
    if (lights.length === WORLD_LOCAL_LIGHT_LIMIT) break;
  }
  return lights;
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
  // 05.10-A7a-F2 (6.17): with `m2Lights` on, a model that declares its lights is lit by them and
  // only them. Cached apart from the heuristic's answer, so flipping the switch takes effect.
  const declares = renderSwitches.m2Lights && (model.lights?.length ?? 0) > 0;
  const cacheKey = declares ? `\u0001${name}` : name;
  const cached = byName?.get(cacheKey);
  if (cached) return cached;
  if (!byName) { byName = new Map(); fixtureCache.set(model, byName); }
  if (declares) {
    const declared = m2PointLights(model);
    byName.set(cacheKey, declared.length > 0 ? declared : EMPTY);
    return declared.length > 0 ? declared : EMPTY;
  }
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
    if (submeshes.has(batch.submesh) || (batch.materialFlags & MATERIAL_UNLIT) === 0) continue;
    const texture = batch.textures.map((slot) => model.textures[slot]?.path ?? "").join(" ").toLowerCase();
    // 22.10 (7.36): or an unlit lamp glass of any blend — `stormwindstreetlamp01.m2` draws its lit
    // pane as an opaque unlit `StormwindLampGlass.blp` and has no glow card, flame or M2 light.
    const additive = [BLEND_ADD, BLEND_NO_ALPHA_ADD, BLEND_BLEND_ADD].includes(batch.blendMode);
    if (!(additive && /glow|flame|fire|light/.test(texture)) && !/lampglass/.test(texture)) continue;
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
  /**
   * 12.10-6.17: lit with the client's own falloff (`m2LightFalloff`) rather than the heuristic
   * fixture's soft pool. Set by every `sampleFixtureLight`; absent reads as the heuristic.
   */
  client?: boolean;
  /**
   * 22.10 (7.36): whether the light is a known emitter that may wear a halo (`LightHalos.ts`).
   * Set by every sampler; a WMO record's place is only roughly its lamp's, so it wears none.
   */
  halo?: boolean;
}

/**
 * 12.10-6.17: how Wow.exe attenuates an M2 point light. The lit M2 vertex programs
 * (`Shaders\Vertex\arbvp1\Diffuse_T1.bls` #3/#5/#7/#9, one to four lights) add, per light,
 * `colour · max(N·L, 0) / (c[25] + c[26]·d + c[27]·d²)` to the sun and ambient terms before the
 * `MIN …, 1`, with no range test; the terrain chunk program takes up to three of the same lights
 * (0x7d0050 fills position, colour and those three coefficients per light from 0x8349e0). The
 * coefficients are the `CM2Light`'s at +0x54/+0x58/+0x5c, which its constructor (0x834a40) sets to
 * (0, 0.7, 0.03) — `0x9e2ec0` and `0x9f23c8` — and no other writer of them was found; the file's
 * attenuation start and end (1.89 yd on `humanguardtower.m2`, 0.97 on `undeadcampfire.m2`) are not
 * what reaches the shader. A light also lights whatever is in the grid cells its model's bounds
 * touch (0x81e400, four nearest per model in 0x834f60), not only within those few yards.
 * The coefficients are `M2_LIGHT_ATTENUATION` and the cap `M2_LIGHT_FALLOFF_CAP` (WorldLighting.ts).
 */
export const M2_LIGHT_REACH = 20;

/**
 * 12.10-6.17: CPU twin of the shader's client falloff for a light `distance` yards away: the
 * client's curve, capped at the source, faded out over the last quarter of `radius` (by
 * `M2_LIGHT_REACH` = 20 yd it has fallen to 0.038 of the light's colour; the client has no end).
 */
export function m2LightFalloff(distance: number, radius = M2_LIGHT_REACH): number {
  if (!Number.isFinite(distance) || distance < 0 || !(radius > 0)) return 0;
  const [constant, linear, quadratic] = M2_LIGHT_ATTENUATION;
  const curve = Math.min(M2_LIGHT_FALLOFF_CAP, 1 / Math.max(constant + linear * distance + quadratic * distance * distance, 1e-3));
  const t = Math.max(0, Math.min(1, (distance - 0.75 * radius) / (0.25 * radius)));
  return curve * (1 - t * t * (3 - 2 * t));
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
  result.client = false; // 12.10-6.17
  result.halo = true; // 22.10 (7.36)
  if (fixture.light) return sampleM2Light(fixture, fixture.light, sample, matrix, result); // 05.10-A7a-F2
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

/**
 * 05.10-A7a-F2 (6.17): one `M2Light` at a moment — diffuse colour × diffuse intensity, off while
 * visibility is 0. No synthetic flicker: the file animates its own.
 * 12.10-6.17: lit with the client's falloff (`m2LightFalloff`, `client`), out to `M2_LIGHT_REACH`
 * yards times the placement scale. The reach used to be the file's `attenuationEnd` — 1.89 yd on
 * the guard tower's lanterns, 0.97 on a campfire — which the client does not use as one, so the
 * pools were a yard or two across (owner, 12.10: «свет заметен, но слабоват»).
 */
function sampleM2Light(
  fixture: FixtureLight,
  light: WvmLight,
  sample: (track: Parameters<typeof sampleTrack>[0], fallback: number, component?: number) => number,
  matrix: THREE.Matrix4,
  result: LocalLightSample,
): boolean {
  if (sample(light.visibility, 1) <= 0) return false;
  const intensity = sample(light.diffuseIntensity, 1);
  if (!(intensity > 0.001)) return false;
  result.colour.set(sample(light.diffuseColor, 1, 0), sample(light.diffuseColor, 1, 1), sample(light.diffuseColor, 1, 2));
  result.position.set(...fixture.position).applyMatrix4(matrix);
  const e = matrix.elements;
  const scale = Math.max(Math.hypot(e[0]!, e[1]!, e[2]!), Math.hypot(e[4]!, e[5]!, e[6]!),
    Math.hypot(e[8]!, e[9]!, e[10]!));
  result.radius = Math.min(24, M2_LIGHT_REACH * scale);
  // Capped at twice the heuristic's 1.1-ish scale: a hand-edited or broken track stays bounded.
  result.intensity = Math.min(2, intensity);
  result.client = true;
  return Number.isFinite(result.radius) && result.radius > 0 && Number.isFinite(result.intensity)
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
  // 22.10 (7.36): one entry past the limit, the nearest light left out, sets the fade-out cut.
  readonly #entries = Array.from({ length: WORLD_LOCAL_LIGHT_LIMIT + 1 }, () => ({
    position: new THREE.Vector3(), colour: new THREE.Vector3(), radius: 0, intensity: 0, distance: Infinity,
    client: false, halo: false, weight: 0,
  }));
  #count = 0;
  #limit = 0;

  begin(limit: number): void {
    this.#count = 0;
    this.#limit = Math.max(0, Math.min(WORLD_LOCAL_LIGHT_LIMIT, Math.floor(limit)));
  }

  /** 22.10 (7.36): `rankScale` ranks the light as if that many times farther (`WMO_LIGHT_RANK_SCALE`). */
  add(sample: LocalLightSample, camera: THREE.Vector3, rankScale = 1): void {
    if (this.#limit === 0) return;
    const distance = sample.position.distanceToSquared(camera) * rankScale * rankScale;
    if (distance > LOCAL_LIGHT_RANGE * LOCAL_LIGHT_RANGE) return;
    const kept = this.#limit + 1;
    let index = this.#count;
    while (index > 0 && this.#entries[index - 1]!.distance > distance) index--;
    if (index >= kept) return;
    const reusable = this.#entries[Math.min(this.#count, kept - 1)]!;
    for (let at = Math.min(this.#count, kept - 1); at > index; at--) this.#entries[at] = this.#entries[at - 1]!;
    this.#entries[index] = reusable;
    reusable.position.copy(sample.position);
    reusable.colour.copy(sample.colour);
    reusable.radius = sample.radius;
    reusable.intensity = sample.intensity;
    reusable.client = sample.client === true;
    reusable.halo = sample.halo === true;
    reusable.distance = distance;
    this.#count = Math.min(this.#count + 1, kept);
  }

  write(uniforms: WorldLightUniforms, viewMatrix: THREE.Matrix4): number {
    const count = Math.min(this.#count, this.#limit);
    // 22.10 (7.36): every selected light fades to nothing as it nears the first one left out (or
    // the selection's range), so the nearest-N set reshuffles without a pool popping on or off.
    const cut = this.#count > this.#limit ? Math.sqrt(this.#entries[this.#limit]!.distance) : LOCAL_LIGHT_RANGE;
    uniforms.wowLocalLightCount.value = count;
    for (let index = 0; index < count; index++) {
      const entry = this.#entries[index]!;
      const position = uniforms.wowLocalLightPosition.value[index]!;
      position.set(entry.position.x, entry.position.y, entry.position.z, 1).applyMatrix4(viewMatrix);
      // 12.10-6.17: a negative reach tells the shader to use the client's falloff (m2LightFalloff).
      position.w = entry.client ? -entry.radius : entry.radius;
      entry.weight = entry.intensity * localLightSelectionFade(Math.sqrt(entry.distance), cut);
      uniforms.wowLocalLightColour.value[index]!.set(entry.colour.x, entry.colour.y, entry.colour.z, entry.weight);
    }
    return count;
  }

  /** 22.10 (7.36): the lights the last `write` sent that wear a halo, with their written strength. */
  forEachHalo(visit: (position: THREE.Vector3, colour: THREE.Vector3, strength: number) => void): void {
    const count = Math.min(this.#count, this.#limit);
    for (let index = 0; index < count; index++) {
      const entry = this.#entries[index]!;
      if (entry.halo && entry.weight > 0) visit(entry.position, entry.colour, entry.weight);
    }
  }
}
