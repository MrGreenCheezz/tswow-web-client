/**
 * 24.10 (7.50): the lights of the streamed placements, before their models are built.
 *
 * Every placement the tiles list whose model lights (`LightTemplateCatalog.ts`) gets its lights from
 * the model's templates (`LightTemplates.ts`) at the place the renderer would put it, filtered as a
 * built placement is (`fixtureLightSource`: no room-lit or interior doodad, except one only open-air
 * groups name). The renderer then offers the nearest of them to the light selection
 * (`forEachNear`) and all of them to the far glows (`appendFarSources`), skipping the placements
 * that are built — those light themselves, as before.
 *
 * Cost: a new placement snapshot (a tile landed) reads every placement's name once against the
 * catalog (a map lookup each); the lights themselves are placed once per placement and kept on it.
 * A frame reads the grid cells within `LOCAL_LIGHT_RANGE` of the focus only.
 */
import * as THREE from "three";
import { fixtureLightSource } from "./FixtureLightSources.js";
import { LIGHT_HALO_STRENGTH } from "./LightHalos.js";
import { fixtureFlicker, type LocalLightSample } from "./LocalLighting.js";
import { sampleLightTemplate, type LightTemplate } from "./LightTemplates.js";
import type { LightTemplateCatalog } from "./LightTemplateCatalog.js";

/** What a placement carries that the prelit lights read (`EnvironmentObject`). */
export interface PrelitPlacement {
  readonly id: number;
  readonly kind: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly interior?: boolean | undefined;
  readonly localLight?: unknown;
  /** A building's MODF box (world x/y/z), when the tile gives one. */
  readonly bounds?: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number } | undefined;
}

export interface PrelitHost<T extends PrelitPlacement> {
  /** The placement's model-to-scene matrix, as its built node and mesh would have it. */
  readonly place: (object: T, target: THREE.Matrix4) => THREE.Matrix4;
  /**
   * For a building's doodad (`interior`), whether only open-air groups name it
   * (`wmoDoodadOpenAir`); undefined while its building is not known yet.
   */
  readonly openAir: (object: T) => boolean | undefined;
  /** Whether the placement is built with its model, and so lights itself. */
  readonly built: (id: number) => boolean;
  /** Whether a building placement's model (its root: lamps, open-air groups) has arrived. */
  readonly buildingKnown?: (id: number) => boolean;
}

/**
 * Floats per light: scene x, y, z; colour r, g, b; radius; strength; client (0/1); far glow r, g, b;
 * the placement's scene translation (the flicker's phase, as `sampleFixtureLight` reads it).
 */
const STRIDE = 15;
/** The grid's cell, yards. */
const CELL = 32;
/** Frames between rebuilds for newly known templates or buildings. */
export const PRELIT_REBUILD_FRAMES = 10;
/** Selection range the near query covers (`LOCAL_LIGHT_RANGE`). */
const NEAR_RANGE = 64;

const NONE = new Float32Array(0);
const matrix = new THREE.Matrix4();
const scratch: LocalLightSample = { position: new THREE.Vector3(), colour: new THREE.Vector3(), radius: 0, intensity: 0 };

/** One placement's lights, placed once (`PLACED`), with the template list they came from. */
interface Placed {
  readonly templates: readonly LightTemplate[];
  readonly lights: Float32Array;
}
const PLACED = new WeakMap<object, Placed>();

/** The scene-space lights of one placement's templates, `STRIDE` floats each. */
export function placeTemplates<T extends PrelitPlacement>(object: T, templates: readonly LightTemplate[],
  place: (object: T, target: THREE.Matrix4) => THREE.Matrix4): Float32Array {
  const known = PLACED.get(object);
  if (known && known.templates === templates) return known.lights;
  const frame = place(object, matrix);
  const e = frame.elements;
  const out: number[] = [];
  for (const template of templates) {
    if (!sampleLightTemplate(template, frame, 0, scratch)) continue;
    // The far glow's colour: as `farLightSources` pushes a built lamp's bind-pose sample (time 0).
    const strength = LIGHT_HALO_STRENGTH * Math.max(0, template.client ? template.intensity
      : template.intensity * fixtureFlicker(e[12]!, e[13]!, e[14]!, 0));
    out.push(scratch.position.x, scratch.position.y, scratch.position.z,
      scratch.colour.x, scratch.colour.y, scratch.colour.z, scratch.radius,
      template.intensity, template.client ? 1 : 0,
      scratch.colour.x * strength, scratch.colour.y * strength, scratch.colour.z * strength, e[12]!, e[13]!, e[14]!);
  }
  const lights = out.length > 0 ? new Float32Array(out) : NONE;
  PLACED.set(object, { templates, lights });
  return lights;
}

export class PrelitLights<T extends PrelitPlacement = PrelitPlacement> {
  #objects: readonly T[] | undefined;
  /** The snapshot's placements that may light, by the catalog's candidate rule. */
  #candidates: T[] = [];
  /** The snapshot's buildings: their roots name their own lamps and which doodads stand in the open. */
  #buildings: T[] = [];
  #candidateGeneration = -1;
  #templateGeneration = -1;
  /** Interior doodads whose building was not known at the last rebuild. */
  #undecided: T[] = [];
  #framesSinceRebuild = PRELIT_REBUILD_FRAMES;
  #dirty = true;
  #lights = new Float32Array(0);
  #ids: number[] = [];
  #count = 0;
  readonly #cells = new Map<number, number[]>();
  #generation = 0;
  /** Counters for the bench and the tests. */
  readonly stats = { rebuilds: 0, candidates: 0, lights: 0, rebuildMs: 0, scans: 0, scanMs: 0, placements: 0 };

  /** The next update places the lights again at once if anything changed (the loading curtain lifts next). */
  flush(): void {
    this.#framesSinceRebuild = PRELIT_REBUILD_FRAMES;
  }

  /** Grows when the light list changed (the far glows rebuild from it). */
  get generation(): number {
    return this.#generation;
  }

  /** Lights known for the current snapshot, built placements included. */
  get count(): number {
    return this.#count;
  }

  /**
   * One frame: re-reads the snapshot if it is new, asks the catalog for the candidates' models, and
   * places the lights again when templates or buildings became known (throttled).
   */
  update(objects: readonly T[], catalog: LightTemplateCatalog, host: PrelitHost<T>, camera: THREE.Vector3): void {
    const fresh = objects !== this.#objects || catalog.candidateGeneration !== this.#candidateGeneration;
    if (fresh) {
      const started = performance.now();
      this.#objects = objects;
      this.#candidateGeneration = catalog.candidateGeneration;
      const candidates: T[] = [];
      const buildings: T[] = [];
      for (const object of objects) {
        if (object.kind === "m2") {
          if (catalog.candidate(object.name)) candidates.push(object);
        } else if (object.kind === "wmo") {
          buildings.push(object);
          catalog.wantLampTable(object.name); // 24.10 (7.50): its lamp posts, before its groups
        }
      }
      this.#candidates = candidates;
      this.#buildings = buildings;
      this.#dirty = true;
      this.stats.scans++;
      this.stats.placements = objects.length;
      this.stats.scanMs = performance.now() - started;
    }
    if (catalog.generation !== this.#templateGeneration) this.#dirty = true;
    if (this.#framesSinceRebuild < PRELIT_REBUILD_FRAMES) this.#framesSinceRebuild++;
    if (!this.#dirty && this.#undecided.length > 0 && this.#framesSinceRebuild >= PRELIT_REBUILD_FRAMES) {
      // A building landed: its open-air doodads may light now (asked at most once per throttle period).
      if (this.#undecided.some((object) => host.openAir(object) !== undefined)) this.#dirty = true;
      else this.#framesSinceRebuild = 0;
    }
    if (this.#dirty && (fresh || this.#framesSinceRebuild >= PRELIT_REBUILD_FRAMES)) {
      this.#rebuild(catalog, host, camera);
      this.#framesSinceRebuild = 0;
    }
  }

  #rebuild(catalog: LightTemplateCatalog, host: PrelitHost<T>, camera: THREE.Vector3): void {
    const started = performance.now();
    this.#dirty = false;
    this.#templateGeneration = catalog.generation;
    this.#undecided = [];
    this.#cells.clear();
    const ids: number[] = [];
    let lights = this.#lights;
    let count = 0;
    for (const object of this.#candidates) {
      const templates = catalog.templates(object.name);
      if (templates === undefined) {
        // Scene x/z against the placement's world x/-y: the yards to the camera on the ground.
        catalog.want(object.name, Math.hypot(object.x - camera.x, -object.y - camera.z));
        continue;
      }
      if (templates.length === 0) continue;
      let open: boolean | undefined = false;
      if (object.interior === true && object.localLight === undefined && object.id < 0) {
        open = host.openAir(object);
        if (open === undefined) {
          this.#undecided.push(object);
          continue;
        }
      }
      if (!fixtureLightSource(object, true, open)) continue;
      const own = placeTemplates(object, templates, host.place);
      if (own.length === 0) continue;
      if ((count * STRIDE) + own.length > lights.length) {
        const grown = new Float32Array(Math.max(lights.length * 2, (count * STRIDE) + own.length, STRIDE * 256));
        grown.set(lights.subarray(0, count * STRIDE));
        lights = grown;
      }
      lights.set(own, count * STRIDE);
      for (let at = 0; at < own.length; at += STRIDE) {
        const index = count++;
        ids.push(object.id);
        const key = cellKey(Math.floor(own[at]! / CELL), Math.floor(own[at + 2]! / CELL));
        const cell = this.#cells.get(key);
        if (cell) cell.push(index); else this.#cells.set(key, [index]);
      }
    }
    this.#lights = lights;
    this.#ids = ids;
    this.#count = count;
    this.#generation++;
    this.stats.rebuilds++;
    this.stats.candidates = this.#candidates.length;
    this.stats.lights = count;
    this.stats.rebuildMs = performance.now() - started;
  }

  /**
   * Lamp placements within `range` yards of world (x, y) whose model's lights are not known yet: the
   * loading curtain waits for none (`WorldRenderer3D.lightsReadyAround`).
   */
  pendingNear(catalog: LightTemplateCatalog, host: PrelitHost<T>, x: number, y: number, range: number): number {
    let pending = 0;
    for (const object of this.#candidates) {
      const dx = object.x - x, dy = object.y - y;
      if (dx * dx + dy * dy > range * range) continue;
      const templates = catalog.templates(object.name);
      // Unknown, or a lamp of a building whose open-air groups are not known yet.
      if (templates === undefined) pending++;
      else if (templates.length > 0 && object.interior === true && object.localLight === undefined && object.id < 0
        && host.openAir(object) === undefined) pending++;
    }
    // A building around or near the point whose root has not come: its own lamps, MOLT and lanterns.
    // 24.10 (7.50): or whose lamp table (its lamp posts) is still on its first way from the gateway.
    if (host.buildingKnown) {
      for (const object of this.#buildings) {
        const box = object.bounds;
        const near = box
          ? x >= box.minX - range && x <= box.maxX + range && y >= box.minY - range && y <= box.maxY + range
          : (object.x - x) ** 2 + (object.y - y) ** 2 <= range * range;
        if (near && (!host.buildingKnown(object.id) || catalog.lampTablePending(object.name))) pending++;
      }
    }
    return pending;
  }

  /**
   * Offers every unbuilt placement's light within the selection's range of `focus` (scene space),
   * sampled at `worldMs` as a built one would be.
   */
  forEachNear(focus: THREE.Vector3, worldMs: number, host: Pick<PrelitHost<T>, "built">,
    visit: (sample: LocalLightSample) => void, result: LocalLightSample): void {
    if (this.#count === 0) return;
    const lights = this.#lights;
    const x0 = Math.floor((focus.x - NEAR_RANGE) / CELL), x1 = Math.floor((focus.x + NEAR_RANGE) / CELL);
    const z0 = Math.floor((focus.z - NEAR_RANGE) / CELL), z1 = Math.floor((focus.z + NEAR_RANGE) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const cell = this.#cells.get(cellKey(cx, cz));
        if (!cell) continue;
        for (const index of cell) {
          const at = index * STRIDE;
          const dx = lights[at]! - focus.x, dy = lights[at + 1]! - focus.y, dz = lights[at + 2]! - focus.z;
          if (dx * dx + dy * dy + dz * dz > NEAR_RANGE * NEAR_RANGE || host.built(this.#ids[index]!)) continue;
          if (!sampleStored(lights, at, worldMs, result)) continue;
          visit(result);
        }
      }
    }
  }

  /** Appends the far glow source (x, y, z, r, g, b) of every unbuilt placement's light. */
  appendFarSources(host: Pick<PrelitHost<T>, "built">, out: number[]): void {
    const lights = this.#lights;
    let lastId = Number.NaN;
    let lastBuilt = false;
    for (let index = 0; index < this.#count; index++) {
      const id = this.#ids[index]!;
      if (id !== lastId) {
        lastId = id;
        lastBuilt = host.built(id);
      }
      if (lastBuilt) continue;
      const at = index * STRIDE;
      // 24.10 (7.50): with the pool's reach (negative for an M2 light) and share, as `farLightSources` (FAR_LIGHT_STRIDE).
      out.push(lights[at]!, lights[at + 1]!, lights[at + 2]!, lights[at + 9]!, lights[at + 10]!, lights[at + 11]!,
        lights[at + 8] === 1 ? -lights[at + 6]! : lights[at + 6]!, 1);
    }
  }
}

/** One stored light at `worldMs`: the template's flicker at its placement, as `sampleLightTemplate`. */
function sampleStored(lights: Float32Array, at: number, worldMs: number, result: LocalLightSample): boolean {
  const client = lights[at + 8] === 1;
  result.position.set(lights[at]!, lights[at + 1]!, lights[at + 2]!);
  result.colour.set(lights[at + 3]!, lights[at + 4]!, lights[at + 5]!);
  result.radius = lights[at + 6]!;
  result.client = client;
  result.halo = true;
  result.intensity = client ? lights[at + 7]!
    : lights[at + 7]! * fixtureFlicker(lights[at + 12]!, lights[at + 13]!, lights[at + 14]!, worldMs);
  return result.radius > 0;
}

function cellKey(x: number, z: number): number {
  return ((x + 32768) & 0xffff) * 65536 + ((z + 32768) & 0xffff);
}
