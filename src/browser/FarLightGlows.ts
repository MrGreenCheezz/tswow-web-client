/**
 * 22.10 (7.46): distant lamps glow. Owner, 22.10: running through a town the lamps seemed to switch
 * on only near the character — the light selection (`LOCAL_LIGHT_RANGE`) and the halos
 * (`LIGHT_HALO_FADE`) both end at 64 yards, so past that a lamp showed only its own glass, if any.
 *
 * The expensive per-pixel pool stays with the nearest selected lights (`LocalLightSelection`). Every
 * outdoor fixture source out to `FAR_LIGHT_RANGE` instead wears a cheap glow: the halo's own quad
 * and shader (`LightHalos.ts`), as one instanced draw of at most `FAR_LIGHT_LIMIT`, nearest first.
 *
 * - Continuity: the far glow fades in over exactly the band the near halo fades out over, with the
 *   same radius and strength there, so a lamp crossing 64 yards does not step.
 * - Size: the radius grows as distance^`FAR_LIGHT_GROWTH` past 64 yards and the brightness rises to
 *   `FAR_LIGHT_BOOST` — a lamp shrinks on screen more slowly than its model does, and still reads
 *   as lit at a few hundred yards.
 * - The far end: a smooth fade over the last `FAR_LIGHT_FADE_OUT` of the range, which is also cut
 *   by the zone's fog and, when the cap binds, by the nearest source left out.
 * - Night weighting as the halo's: `LIGHT_HALO_DAY_SHARE` by day.
 *
 * Sources come from what the renderer already keeps: the doodad lamps `modelFixtureLights` finds
 * (M2 lights, glow cards, flames, lamp glass) and a WMO's own outdoor lamps (`WmoFixtureLights.ts`),
 * admitted by the same `fixtureLightSource` test as the near lights (no room-lit or interior
 * doodads, so nothing glows through a building's walls; the quad is depth-tested as the halo is).
 * 23.10 (7.46): and a city's lamp posts that are its WMO's own geometry, with the doodads only its
 * open-air groups name (`WmoOpenAirLamps.ts`).
 * Each placement's sources are sampled once, at their bind pose, and cached; the flat list is
 * rebuilt only after the placement set changed (at most every `FAR_LIGHT_REBUILD_FRAMES`), and the nearest set is
 * re-picked only after the camera moved `FAR_LIGHT_REPICK` yards. A frame only re-weights the
 * picked few hundred, with no allocation.
 */
import * as THREE from "three";
import { fixtureLightSource } from "./FixtureLightSources.js";
import {
  LIGHT_HALO_DAY_SHARE, LIGHT_HALO_FADE, LIGHT_HALO_RADIUS, LIGHT_HALO_STRENGTH, LightHalos,
} from "./LightHalos.js";
import { modelFixtureLights, sampleFixtureLight, type LocalLightSample } from "./LocalLighting.js";
import { sampleWmoLight, wmoOutdoorLightPositions, wmoOutdoorLights } from "./WmoFixtureLights.js";
import type { WmoModel } from "./WmoModel.js";
import {
  sampleWmoLantern, wmoLanternGeneration, wmoLanterns, wmoLanternWorldPositions,
} from "./WmoOpenAirLamps.js"; // 23.10 (7.46)
import type { WvmModel } from "./Wvm.js";

/** Camera distance, yards, past which no far glow is drawn. */
export const FAR_LIGHT_RANGE = 280;
/** Most far glows drawn in one frame (nearest first). */
export const FAR_LIGHT_LIMIT = 384;
/** Share of the range over which the glow fades out at its far end. */
export const FAR_LIGHT_FADE_OUT = 0.25;
/** Past the near halo's end, the glow's radius grows as (distance / 64)^this. */
export const FAR_LIGHT_GROWTH = 0.75;
/**
 * The glow's brightness past the near halo's end: one at 64 yards (no step), rising smoothly to
 * this by `FAR_LIGHT_BOOST_AT`. At the halo's own strength a lamp 100 yards off read as a faint
 * smudge two pixels across; a lit lamp seen from afar is its brightest point.
 */
export const FAR_LIGHT_BOOST = 2.5;
export const FAR_LIGHT_BOOST_AT = 160;
/** Yards the camera moves before the nearest set is picked again. */
export const FAR_LIGHT_REPICK = 4;
/** A WMO lamp record's glow against a doodad lamp's: its place is only roughly the lamp's. */
export const FAR_LIGHT_WMO_SHARE = 0.75;
/**
 * Frames between rebuilds of the source list while placements stream in or out. Frames, not the
 * world clock: the clock may stand still (a paused or fixed-time scene) while placements arrive.
 */
export const FAR_LIGHT_REBUILD_FRAMES = 30;
/** Floats per source: x, y, z, then red, green, blue already times strength. */
const STRIDE = 6;

const smooth = (t: number): number => t * t * (3 - 2 * t);
const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));

/**
 * The far glow's weight, before colour and strength, for a lamp `distance` yards from the camera:
 * the halo's night weight, faded in over the band the near halo fades out over
 * (`lightHaloWeight` + this = the night weight there), brightened past it (`FAR_LIGHT_BOOST`) and
 * faded out over the range's last stretch.
 */
export function farLightGlowWeight(daylight: number, distance: number, range = FAR_LIGHT_RANGE): number {
  if (!Number.isFinite(distance) || distance < 0 || !(range > 0)) return 0;
  const day = clamp01(Number.isFinite(daylight) ? daylight : 1);
  const night = LIGHT_HALO_DAY_SHARE + (1 - LIGHT_HALO_DAY_SHARE) * (1 - day);
  const [near, far] = LIGHT_HALO_FADE;
  const fadeIn = smooth(clamp01((distance - near) / (far - near)));
  const band = range * FAR_LIGHT_FADE_OUT;
  const fadeOut = 1 - smooth(clamp01((distance - (range - band)) / band));
  const boost = 1 + (FAR_LIGHT_BOOST - 1) * smooth(clamp01((distance - far) / (FAR_LIGHT_BOOST_AT - far)));
  return night * fadeIn * fadeOut * boost;
}

/** The far glow's world radius at `distance` yards: the halo's up to 64, then slowly growing. */
export function farLightGlowRadius(distance: number): number {
  const far = LIGHT_HALO_FADE[1];
  return LIGHT_HALO_RADIUS * Math.pow(Math.max(1, Number.isFinite(distance) ? distance / far : 1), FAR_LIGHT_GROWTH);
}

/** What the renderer keeps per placement that the far glows read. */
export interface FarLightPlacement {
  readonly source: {
    readonly id: number;
    readonly name: string;
    readonly interior?: boolean | undefined;
    readonly localLight?: unknown;
  };
  readonly node: THREE.Object3D;
  readonly visual?: THREE.Object3D | undefined;
  readonly wvm?: WvmModel | undefined;
  readonly instanceMatrix?: THREE.Matrix4 | undefined;
  readonly wmo?: { readonly model: WmoModel; readonly modelToWorld: THREE.Matrix4 } | undefined;
}

const NONE = new Float32Array(0);
/** 23.10 (7.46): with the lantern generation of a WMO placement's model they were built at. */
const PLACEMENT_SOURCES = new WeakMap<object, { readonly sources: Float32Array; readonly lanterns: number }>();
const sample: LocalLightSample = { position: new THREE.Vector3(), colour: new THREE.Vector3(), radius: 0, intensity: 0 };

function push(out: number[], value: LocalLightSample, share: number): void {
  const strength = LIGHT_HALO_STRENGTH * Math.max(0, value.intensity) * share;
  out.push(value.position.x, value.position.y, value.position.z,
    value.colour.x * strength, value.colour.y * strength, value.colour.z * strength);
}

/**
 * 23.10 (7.46): which interior doodads stand in the open (`wmoDoodadOpenAir`), as the renderer
 * answers it; without one every interior doodad stays out, as before.
 */
export type FarLightOpenAir = (source: FarLightPlacement["source"]) => boolean;

/**
 * One placement's glow sources, sampled once at their bind pose and cached on the placement.
 * 23.10 (7.46): a building's again once more of its lanterns arrived with its groups.
 */
export function farLightSources(placement: FarLightPlacement, openAir?: FarLightOpenAir): Float32Array {
  const wmo = placement.wmo;
  const lanterns = wmo ? wmoLanterns(wmo.model) : undefined;
  const known = PLACEMENT_SOURCES.get(placement);
  if (known && known.lanterns === (lanterns?.generation ?? 0)) return known.sources;
  const out: number[] = [];
  if (wmo) {
    const lights = wmoOutdoorLights(wmo.model);
    if (lights.length > 0) {
      const positions = wmoOutdoorLightPositions(wmo, lights, wmo.modelToWorld);
      for (let index = 0; index < lights.length; index++) {
        if (sampleWmoLight(lights[index]!, positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!, sample)) {
          push(out, sample, FAR_LIGHT_WMO_SHARE);
        }
      }
    }
    // 23.10 (7.46): its lamp posts (WmoOpenAirLamps.ts) glow as a doodad lamp's glass does.
    if (lanterns && lanterns.positions.length > 0) {
      const positions = wmoLanternWorldPositions(wmo, lanterns, wmo.modelToWorld);
      for (let at = 0; at + 2 < positions.length; at += 3) {
        if (sampleWmoLantern(positions[at]!, positions[at + 1]!, positions[at + 2]!, undefined, sample)) push(out, sample, 1);
      }
    }
  }
  const model = placement.wvm;
  if (model && fixtureLightSource(placement.source, true, openAir)) {
    const fixtures = modelFixtureLights(model, placement.source.name, true);
    const root = placement.visual;
    if (fixtures.length > 0 && (placement.instanceMatrix || root)) {
      if (!placement.instanceMatrix) root!.updateWorldMatrix(true, false);
      const matrix = placement.instanceMatrix ?? root!.matrixWorld;
      const start = out.length;
      for (const fixture of fixtures) {
        if (sampleFixtureLight(fixture, model, matrix, 0, 0, sample)) push(out, sample, 1);
      }
      if (out.length > start && !wmo) learnTemplate(placement, out.slice(start));
    }
  }
  const sources = out.length > 0 ? new Float32Array(out) : NONE;
  // 23.10 (7.46): an interior doodad left out may be let in once its building has landed.
  if (sources.length > 0 || placement.source.interior !== true || !openAir) {
    PLACEMENT_SOURCES.set(placement, { sources, lanterns: lanterns?.generation ?? 0 });
  }
  return sources;
}

/**
 * 23.10 (7.36): a lamp model's glow sources in its placement's own frame, learned from the first
 * resident placement of that model. Stormwind's street lamps are city doodads on a size-scaled
 * leash (245–305 yards at detail 1, less once the city's dense scenery budget binds) and its
 * lanterns on the 90-yard floor; a placement not yet drawn has no model and gave no far glow, so in
 * the city lamps seemed to switch on as one approached, while Elwynn's `LampPost.m2` (no source
 * radius, the 400-yard name leash) glowed from afar. The streamed tile list still holds every
 * placement: one known template places the glow of all the others of the same model.
 */
const TEMPLATES = new Map<string, Float32Array>();
let templateGeneration = 0;
const inverse = new THREE.Matrix4();
const point = new THREE.Vector3();

function learnTemplate(placement: FarLightPlacement, world: number[]): void {
  const name = placement.source.name;
  if (TEMPLATES.has(name)) return;
  placement.node.updateWorldMatrix(true, false);
  inverse.copy(placement.node.matrixWorld).invert();
  const local = new Float32Array(world);
  for (let at = 0; at < local.length; at += STRIDE) {
    point.set(local[at]!, local[at + 1]!, local[at + 2]!).applyMatrix4(inverse);
    local[at] = point.x; local[at + 1] = point.y; local[at + 2] = point.z;
  }
  if (!local.every(Number.isFinite)) return;
  TEMPLATES.set(name, local);
  templateGeneration++;
}

/** 23.10 (7.36): a streamed placement the renderer has not built (yet), and how it is placed. */
export interface FarLightStreamed<T extends FarLightPlacement["source"] = FarLightPlacement["source"]> {
  objects: readonly T[];
  /** The placement's frame, as the renderer would place its node (`placeEnvironmentNode`). */
  readonly place: (object: T, target: THREE.Matrix4) => THREE.Matrix4;
}

const placed = new THREE.Matrix4();

/** 23.10 (7.36): appends the glows of the streamed placements no resident stands for. */
export function streamedFarLightSources<T extends FarLightPlacement["source"]>(streamed: FarLightStreamed<T>,
  resident: ReadonlyMap<unknown, unknown>, out: number[], openAir?: FarLightOpenAir): void {
  if (TEMPLATES.size === 0) return;
  for (const object of streamed.objects) {
    const template = TEMPLATES.get(object.name);
    if (!template || resident.has(object.id) || !fixtureLightSource(object, true, openAir)) continue;
    const matrix = streamed.place(object, placed);
    for (let at = 0; at < template.length; at += STRIDE) {
      point.set(template[at]!, template[at + 1]!, template[at + 2]!).applyMatrix4(matrix);
      out.push(point.x, point.y, point.z, template[at + 3]!, template[at + 4]!, template[at + 5]!);
    }
  }
}

export class FarLightGlows {
  readonly #halos = new LightHalos(FAR_LIGHT_LIMIT, "farLightGlows");
  #sources = new Float32Array(STRIDE * 1024);
  #sourceCount = 0;
  #distances = new Float32Array(1024);
  #order = new Uint32Array(1024);
  readonly #picked = new Uint32Array(FAR_LIGHT_LIMIT);
  #pickedCount = 0;
  /** The range the picked set is good for: the far range, the fog, or the first source left out. */
  #pickedRange = FAR_LIGHT_RANGE;
  readonly #pickedAt = new THREE.Vector3(Number.POSITIVE_INFINITY, 0, 0);
  #dirty = true;
  #streamedObjects: readonly unknown[] | undefined;
  #templateGeneration = 0;
  #lanternGeneration = 0; // 23.10 (7.46)
  #framesSinceRebuild = FAR_LIGHT_REBUILD_FRAMES;
  readonly #byDistance = (a: number, b: number): number => this.#distances[a]! - this.#distances[b]!;

  get mesh(): THREE.InstancedMesh {
    return this.#halos.mesh;
  }

  /** The number of glow sources gathered from the loaded placements. */
  get sourceCount(): number {
    return this.#sourceCount;
  }

  /** The placement set changed: rebuild the source list at the next chance. */
  invalidate(): void {
    this.#dirty = true;
  }

  /** Draws nothing this frame (the faithful profiles). */
  clear(): void {
    this.#halos.begin();
  }

  /**
   * One frame: rebuilds the source list if the placements changed (throttled), re-picks the
   * nearest set when the camera has moved, and re-weights the picked glows.
   */
  update(placements: ReadonlyMap<unknown, FarLightPlacement>, camera: THREE.Vector3,
    daylight: number, fogFar = Number.POSITIVE_INFINITY, streamed?: FarLightStreamed<any>, openAir?: FarLightOpenAir): void {
    let repick = false;
    // 23.10 (7.36): a new streamed snapshot or a newly learned lamp template also rebuilds.
    // 23.10 (7.46): and so do a building's newly found lanterns.
    const streamedObjects = streamed?.objects;
    if (streamedObjects !== this.#streamedObjects || this.#templateGeneration !== templateGeneration
      || this.#lanternGeneration !== wmoLanternGeneration()) {
      this.#streamedObjects = streamedObjects;
      this.#templateGeneration = templateGeneration;
      this.#lanternGeneration = wmoLanternGeneration();
      this.#dirty = true;
    }
    if (this.#framesSinceRebuild < FAR_LIGHT_REBUILD_FRAMES) this.#framesSinceRebuild++;
    if (this.#dirty && this.#framesSinceRebuild >= FAR_LIGHT_REBUILD_FRAMES) {
      this.#rebuild(placements, streamed, openAir);
      this.#framesSinceRebuild = 0;
      repick = true;
    }
    const range = Math.max(0, Math.min(FAR_LIGHT_RANGE, Number.isFinite(fogFar) && fogFar > 0 ? fogFar : FAR_LIGHT_RANGE));
    if (repick || this.#pickedAt.distanceToSquared(camera) > FAR_LIGHT_REPICK * FAR_LIGHT_REPICK) {
      this.#pick(camera, range);
    }
    const halos = this.#halos;
    halos.begin();
    const sources = this.#sources;
    const picked = this.#picked;
    const pickedRange = Math.min(range, this.#pickedRange);
    for (let index = 0; index < this.#pickedCount; index++) {
      const at = picked[index]! * STRIDE;
      const x = sources[at]!, y = sources[at + 1]!, z = sources[at + 2]!;
      const dx = x - camera.x, dy = y - camera.y, dz = z - camera.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const weight = farLightGlowWeight(daylight, distance, pickedRange);
      if (!(weight > 0)) continue;
      const red = sources[at + 3]! * weight, green = sources[at + 4]! * weight, blue = sources[at + 5]! * weight;
      if (Math.max(red, green, blue) < 0.002) continue;
      halos.addGlow(x, y, z, farLightGlowRadius(distance), red, green, blue);
    }
    halos.end();
  }

  #rebuild(placements: ReadonlyMap<unknown, FarLightPlacement>, streamed?: FarLightStreamed<any>,
    openAir?: FarLightOpenAir): void {
    this.#dirty = false;
    let count = 0;
    const lists: Iterable<Float32Array> = (function* () {
      for (const placement of placements.values()) yield farLightSources(placement, openAir);
      // 23.10 (7.36): after the residents, which teach the templates.
      if (streamed) {
        const extra: number[] = [];
        streamedFarLightSources(streamed, placements, extra, openAir);
        if (extra.length > 0) yield new Float32Array(extra);
      }
    })();
    for (const own of lists) {
      if (own.length === 0) continue;
      const need = (count + own.length / STRIDE) * STRIDE;
      if (need > this.#sources.length) {
        const grown = new Float32Array(Math.max(need, this.#sources.length * 2));
        grown.set(this.#sources.subarray(0, count * STRIDE));
        this.#sources = grown;
      }
      this.#sources.set(own, count * STRIDE);
      count += own.length / STRIDE;
    }
    this.#sourceCount = count;
    if (this.#distances.length < count) {
      this.#distances = new Float32Array(Math.max(count, this.#distances.length * 2));
      this.#order = new Uint32Array(this.#distances.length);
    }
  }

  #pick(camera: THREE.Vector3, range: number): void {
    this.#pickedAt.copy(camera);
    // Within the near halo's band the glow weighs nothing; keep the cap for the ones that show.
    const inner = Math.max(0, LIGHT_HALO_FADE[0] - FAR_LIGHT_REPICK);
    const outer = range + FAR_LIGHT_REPICK;
    const sources = this.#sources;
    const distances = this.#distances;
    const order = this.#order;
    let count = 0;
    for (let index = 0; index < this.#sourceCount; index++) {
      const at = index * STRIDE;
      const dx = sources[at]! - camera.x, dy = sources[at + 1]! - camera.y, dz = sources[at + 2]! - camera.z;
      const squared = dx * dx + dy * dy + dz * dz;
      if (squared < inner * inner || squared > outer * outer) continue;
      distances[index] = squared;
      order[count++] = index;
    }
    this.#pickedRange = FAR_LIGHT_RANGE;
    if (count > FAR_LIGHT_LIMIT) {
      order.subarray(0, count).sort(this.#byDistance);
      // The first source left out marks the end: everything picked fades out before it, and the
      // camera can move `FAR_LIGHT_REPICK` yards before the set is picked again.
      this.#pickedRange = Math.max(0, Math.sqrt(distances[order[FAR_LIGHT_LIMIT]!]!) - FAR_LIGHT_REPICK);
      count = FAR_LIGHT_LIMIT;
    }
    this.#picked.set(order.subarray(0, count));
    this.#pickedCount = count;
  }

  dispose(): void {
    this.#halos.dispose();
  }
}
