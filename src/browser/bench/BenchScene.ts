/**
 * 22.10 ARC-2 S6a: the bench scene's world half — the config, the scenario flags, the crowd and its per-frame
 * placement, the camera and the pushed unit-model table. Shared by the in-page harness (Harness.ts) and the page of
 * `--renderbridge worker` (WorkerBenchPage.ts), so both drive the same world; the renderer half is BenchRenderSide.ts.
 * Nothing here touches the renderer or the page.
 */

import { WorldState, type WorldObjectState } from "../../world/WorldState.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { MOVEMENT_FLAGS } from "../../world/MovementProtocol.js";
import type { UnitModel } from "../CreatureModelClient.js";
import { NO_RENDER_LOOKUPS, type RenderLookups } from "../RenderLookups.js";
import type { RenderFrameTime } from "../WorldRenderer3D.js";
import type { SettingValues } from "../ui/SettingsModel.js";
import type { BenchCastsConfig } from "./BenchSpellCasts.js";

export interface BenchGraphics {
  lightingQuality: number; grassRadius: number; grassDense: boolean; grassDensity: number; fullscreenGlow: boolean;
  godRays?: boolean;
}

export interface BenchConfig {
  seed: number; width: number; height: number; pixelRatio: number; durationSeconds: number;
  warmupSeconds: number; timeoutSeconds: number; halfMinute: number;
  route: { map: number; x: number; y: number; dx: number; dy: number };
  graphics: BenchGraphics;
  /** A dense city square: a fixed WMO floor, a mixed population and the live client's settings. */
  city: { map: number; x: number; y: number; z: number; population: number; spacing: number; walkers: number;
    orbit: number; pitch: number; displays: number[]; graphics: BenchGraphics;
    /** 25.10 (perf): a casting crowd (BenchSpellCasts.ts); absent in bench/city.json. */
    casts?: BenchCastsConfig };
  /** `bench/run.mjs --settings`: a player's account settings, pushed like the page pushes them. */
  settings?: SettingValues;
  /**
   * `bench/lookdev.mjs`: a fixed camera (yaw, pitch, orbit) over the scenario's own route, a weather
   * packet handed to the renderer as the world would, and how many frames `view()` lets run
   * before it reads the pixels (rain, wind and the veil need a few seconds to settle). Never part
   * of a measurement: lookdev frames are looked at, not timed.
   */
  view?: { yaw: number; pitch: number; orbit: number };
  weather?: { state: number; intensity: number; abrupt: boolean } | null;
  viewFrames?: number;
  /**
   * 23.10 (7.48): `bench/lookdev.mjs --hd-textures`: the HD generation the page is told, as `/client/patch-status`
   * tells a live page; with «Чёткие текстуры эффектов» on, effect textures are then asked for with `hd=`.
   */
  hdTextureGeneration?: string;
}

export interface BenchScenario {
  readonly name: string;
  readonly worldCrowd: boolean;
  /**
   * `city-arrival`: the city square without its crowd during preparation; the crowd then comes into
   * range while the clock runs, eight units a second, as it does when a rider enters a city. The
   * plain `city` builds everyone before timing, so it never measures a unit's first appearance.
   */
  readonly arrival: boolean;
  readonly city: boolean;
  /** The scenarios drawn by WorldRenderer3D (the others are a plain three.js crowd). */
  readonly movement: boolean;
  readonly count: number;
  readonly graphics: BenchGraphics;
  readonly map: number;
}

export const ARRIVAL_GROUP = 8;

export function benchScenario(config: BenchConfig, name: string): BenchScenario {
  const worldCrowd = name.startsWith('world-crowd-');
  const arrival = name === 'city-arrival';
  const city = name === 'city' || arrival;
  const movement = name === 'movement' || worldCrowd || city;
  const count = name === 'movement' ? 10 : city ? config.city.population : Number(name.split('-').at(-1));
  if (!city && ![10, 50, 64, 200].includes(count)) throw new Error('Invalid scenario');
  return { name, worldCrowd, arrival, city, movement, count,
    graphics: city ? config.city.graphics : config.graphics, map: city ? config.city.map : config.route.map };
}

/** The measured scenario's renderer phases, in column order. */
export function benchPhaseNames(scenario: BenchScenario): string[] {
  return scenario.movement
    ? ['query', 'setup', 'terrain', 'env', 'ground', 'objects', 'units', 'visuals', 'warm', 'evict', 'submit']
    : ['animation', 'submit'];
}

/** The crowd of a world scenario: the player first, then the NPCs, placed for a moment of the run. */
export class BenchCrowd {
  readonly state = new WorldState();
  readonly objects: WorldObjectState[] = [];

  constructor(readonly config: BenchConfig, readonly scenario: BenchScenario, displayIdOf: (index: number) => number) {
    const { city, worldCrowd, arrival, count } = scenario;
    for (let i = 0; i < count; i++) {
      const npc = (worldCrowd || city) && i > 0;
      // City walkers run small loops; everyone else in a crowd stands, as vendors and guards do.
      const walking = city
        ? npc && i % Math.max(1, Math.floor(count / Math.max(1, config.city.walkers))) === 0
        : !npc;
      const object: WorldObjectState = { guid: BigInt(i + 1), typeId: npc ? 3 : 4,
        position: { x: config.route.x, y: config.route.y, z: 60, orientation: Math.PI },
        movementFlags: walking ? MOVEMENT_FLAGS.forward : 0, updateFlags: 0, targetGuid: undefined,
        runSpeed: 7, turnRate: undefined, motion: undefined, glide: undefined,
        transport: undefined, speeds: undefined, transportTime: undefined,
        fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, displayIdOf(i)],
          [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100], [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 100]]) };
      if (!arrival || i === 0) this.state.objects.set(object.guid, object);
      this.objects.push(object);
    }
    this.state.selfGuid = this.objects[0]!.guid;
  }

  /** The point the camera and the scenery query follow at `fraction` of the route (the player's own x and y). */
  routeX(fraction: number): number {
    const { config, scenario } = this;
    const angle = fraction * Math.PI * 2;
    return scenario.city ? config.city.x
      : config.route.x + (scenario.worldCrowd ? Math.cos(angle) * 22 : config.route.dx * fraction);
  }

  routeY(fraction: number): number {
    const { config, scenario } = this;
    const angle = fraction * Math.PI * 2;
    return scenario.city ? config.city.y
      : config.route.y + (scenario.worldCrowd ? Math.sin(angle) * 22 : config.route.dy * Math.sin(angle));
  }

  /**
   * Every object's position at `seconds` into the run (`fraction` of the route). True when the player stood over
   * terrain without a height (an off-city route frame the harness counts while recording).
   */
  place(seconds: number, fraction: number, heightAt: (x: number, y: number) => number | undefined): boolean {
    const { config, scenario, objects } = this;
    const { city, worldCrowd, count } = scenario;
    const centreX = city ? config.city.x : config.route.x;
    const centreY = city ? config.city.y : config.route.y;
    const x = this.routeX(fraction);
    const y = this.routeY(fraction);
    const rows = Math.ceil(Math.sqrt(count - 1));
    const spacing = city ? config.city.spacing : 2.5;
    let selfMissing = false;
    for (let i = 0; i < objects.length; i++) {
      const object = objects[i]!;
      const p = object.position!;
      if (city) {
        if (i === 0) { p.x = centreX; p.y = centreY; }
        else {
          const gridX = centreX + ((i - 1) % rows - (rows - 1) / 2) * spacing;
          const gridY = centreY + (Math.floor((i - 1) / rows) - (rows - 1) / 2) * spacing;
          const loop = object.movementFlags !== 0 ? seconds * 0.9 + i : 0;
          p.x = gridX + (object.movementFlags !== 0 ? Math.cos(loop) * 1.5 : 0);
          p.y = gridY + (object.movementFlags !== 0 ? Math.sin(loop) * 1.5 : 0);
          p.orientation = object.movementFlags !== 0 ? loop + Math.PI / 2 : (i * 2.39996) % (Math.PI * 2);
        }
        p.z = config.city.z;
        continue;
      }
      p.x = worldCrowd && i > 0 ? config.route.x + ((i - 1) % rows - (rows - 1) / 2) * 2.5
        : x + (i === 0 ? 0 : (i % 3) * 2 - 4);
      p.y = worldCrowd && i > 0 ? config.route.y + (Math.floor((i - 1) / rows) - (rows - 1) / 2) * 2.5
        : y + (i === 0 ? 0 : Math.ceil(i / 3) * 3);
      const height = heightAt(p.x, p.y);
      if (height !== undefined) p.z = height + .02;
      else if (i === 0) selfMissing = true;
    }
    return selfMissing;
  }

  /** city-arrival: admits the units due by this many seconds into the measurement. */
  arrive(seconds: number): void {
    const { objects, state } = this;
    const due = Math.min(objects.length, 1 + ARRIVAL_GROUP * Math.floor(seconds));
    for (let i = 1; i < due; i++) if (!state.objects.has(objects[i]!.guid)) state.objects.set(objects[i]!.guid, objects[i]!);
  }
}

/** The orbit camera at `fraction` of the run, written into `out`. */
export function benchCamera(config: BenchConfig, scenario: BenchScenario, fraction: number,
  out: { yaw: number; pitch: number; orbit: number }): void {
  const { city, worldCrowd } = scenario;
  const angle = fraction * Math.PI * 2;
  const view = config.view;
  out.yaw = view ? view.yaw : city ? angle : worldCrowd ? angle : Math.sin(fraction * Math.PI * 2) * .4;
  out.pitch = view ? view.pitch : city ? config.city.pitch : worldCrowd ? -.4 : -.22;
  out.orbit = view ? view.orbit : city ? config.city.orbit : worldCrowd ? 42 : 24;
}

/** The renderer's frame clock: a crowd's admission clock stands at zero while the scene is prepared. */
export function benchFrameTime(config: BenchConfig, scenario: BenchScenario, preparing: boolean, seconds: number,
  elapsed: number, frame: number): RenderFrameTime {
  const crowdClock = scenario.worldCrowd || scenario.city;
  return { nowMs: (crowdClock ? preparing ? 0 : config.warmupSeconds + seconds : seconds) * 1000,
    elapsedSeconds: elapsed, frameIndex: frame };
}

/**
 * 22.10 ARC-2 S2c: `modelOf` reaches the renderer as the pushed unit-model table, filled for every unit (it asks
 * for nothing, so answering the ones the renderer then culls changes nothing). Its answer reads only the display
 * id, which no bench unit changes, and units only ever arrive — so the table is filled when the count moves.
 */
export class BenchUnitModels {
  readonly models = new Map<bigint, UnitModel>();
  readonly lookups: RenderLookups = { ...NO_RENDER_LOOKUPS, unitModels: this.models };
  #filled = -1;

  constructor(readonly modelOf: (object: WorldObjectState) => UnitModel | undefined) {}

  refresh(state: WorldState): void {
    if (this.#filled === state.objects.size) return;
    this.#filled = state.objects.size;
    for (const object of state.objects.values()) {
      if (this.models.has(object.guid)) continue;
      const model = this.modelOf(object);
      if (model !== undefined) this.models.set(object.guid, model);
    }
  }
}

/** The display a unit is drawn with: by display id in the city, else the one character display. */
export function benchModelOf(scenario: BenchScenario, display: UnitModel, cityDisplays: readonly UnitModel[]):
  (object: WorldObjectState) => UnitModel | undefined {
  if (!scenario.city) return () => display;
  const displayById = new Map(cityDisplays.map((model) => [model.id, model]));
  return (object) => displayById.get(object.fields.get(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset) ?? 0);
}
