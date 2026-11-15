import * as THREE from "three";
import { GroundMist, type MistKinds } from "./GroundMist.js";
import { ZoneDust } from "./ZoneDust.js";
import { withGeneration } from "./GatewayGeneration.js";
import {
  advanceZoneWeights, caveRoom, emptyZoneSample, mapSnowShare, sampleZoneTerrain, zeroZoneWeights, zoneKindTargets,
  type MapColourPixels, type ZoneSample, type ZoneTerrainProbe, type ZoneWeights,
} from "./ZoneAtmosphereKinds.js";

/**
 * 7.40 «Атмосфера зон» — the owner's wish of 22.10: mist and air where they belong. Not Wow.exe's: the enhanced
 * lighting levels only, never the faithful ones (0 «как в оригинале», 3), where nothing here is even created.
 *
 * Per kind (ZoneAtmosphereKinds.ts says how each is recognised):
 * - marsh  — low mist pooling in the hollows and over the standing water; the zone fog starts nearer and greener.
 * - forest — a thin mist in the low ground at dusk, night and dawn; the sun's shafts through the canopy stronger.
 * - coast  — sea haze lying over the water, lit by a low sun; the zone fog paler and nearer.
 * - cave   — close, damp air: the fog (room fog included) shorter and earthier, dust hanging in the light.
 * - cold   — blown snow streaming low along the wind; the zone fog whiter and nearer.
 *
 * Every tint is taken from the zone's own fog colour (its Light.dbc row this frame), scaled by its own brightness, so
 * the hour, the weather and the zone's palette carry through: a marsh at sunset is a warm green-gold, at night dark.
 */

/** The setting's strength range (1 = the tuned look). */
export const ZONE_STRENGTH_MAX = 2;
/** Seconds between terrain samples. */
export const ZONE_SAMPLE_INTERVAL = 1;
/** A move this long between two frames (yards) is a jump, not a walk: the weights take the new place at once. */
export const ZONE_JUMP_YARDS = 150;

export function zoneStrength(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 1;
  return Math.max(0, Math.min(ZONE_STRENGTH_MAX, n));
}

/** How much each kind pulls the fog's start and end in at weight 1, strength 1. */
const NEAR_PULL: Readonly<ZoneWeights> = Object.freeze({ marsh: 0.55, forest: 0.2, coast: 0.3, cave: 0.5, cold: 0.2 });
const FAR_PULL: Readonly<ZoneWeights> = Object.freeze({ marsh: 0.4, forest: 0.1, coast: 0.2, cave: 0.45, cold: 0.15 });
/** Each kind's fog tint as a multiple of the fog's own luminance, and how far it mixes in at weight 1. */
const TINT: Readonly<Record<keyof ZoneWeights, readonly [number, number, number, number]>> = Object.freeze({
  marsh: [0.9, 1.0, 0.86, 0.35],
  forest: [0.94, 1.03, 0.9, 0.15],
  coast: [0.98, 1.06, 1.16, 0.25],
  cave: [0.82, 0.76, 0.66, 0.35],
  cold: [1.12, 1.16, 1.26, 0.15],
});

export interface ZoneFogTarget {
  near: number;
  far: number;
  readonly color: THREE.Color;
}

/**
 * Shapes one fog for the weights: the start and end pulled in, the colour tinted from its own luminance. `kinds`
 * picks which kinds act on this fog (the outdoor ones on the zone fog, the cave on a room's). Pure; tested.
 */
export function shapeZoneFog(
  fog: ZoneFogTarget, weights: Readonly<ZoneWeights>, strength: number, kinds: readonly (keyof ZoneWeights)[],
): void {
  const s = zoneStrength(strength);
  if (s <= 0 || !(fog.far > 0)) return;
  let near = 0;
  let far = 0;
  for (const kind of kinds) {
    near += weights[kind] * NEAR_PULL[kind];
    far += weights[kind] * FAR_PULL[kind];
  }
  near = Math.min(0.8, near * s);
  far = Math.min(0.7, far * s);
  if (near > 0 || far > 0) {
    const nextFar = fog.far * (1 - far);
    fog.near = Math.min(Math.max(0, fog.near) * (1 - near), nextFar * 0.9);
    fog.far = Math.max(fog.near + 1, nextFar);
  }
  const c = fog.color;
  const luminance = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  let mixed = 0;
  for (const kind of kinds) {
    const [r, g, b, share] = TINT[kind];
    const amount = Math.min(0.6 - mixed, weights[kind] * share * s);
    if (amount <= 0) continue;
    mixed += amount;
    c.r += (Math.min(1, luminance * r) - c.r) * amount;
    c.g += (Math.min(1, luminance * g) - c.g) * amount;
    c.b += (Math.min(1, luminance * b) - c.b) * amount;
  }
}

/** The outdoor kinds that shape the zone fog. */
export const OUTDOOR_FOG_KINDS: readonly (keyof ZoneWeights)[] = Object.freeze(["marsh", "forest", "coast", "cold"]);
export const CAVE_FOG_KINDS: readonly (keyof ZoneWeights)[] = Object.freeze(["cave"]);

/**
 * The mist densities of a frame. Mist thickens in the cool of the day (night, dawn, dusk) and in rain; blown snow
 * thickens with wind and snowfall. Pure; tested.
 */
export function mistKinds(
  weights: Readonly<ZoneWeights>, strength: number, daylight: number, rain: number, snow: number, wind: number,
  out: MistKinds = { marsh: 0, coast: 0, cold: 0, forest: 0 },
): MistKinds {
  const s = zoneStrength(strength);
  const day = Math.max(0, Math.min(1, Number.isFinite(daylight) ? daylight : 1));
  const wet = Math.max(0, Math.min(1, Number.isFinite(rain) ? rain : 0));
  const snowing = Math.max(0, Math.min(1, Number.isFinite(snow) ? snow : 0));
  const gust = Math.max(0, Math.min(1, Number.isFinite(wind) ? wind : 0));
  const cool = 1.3 - 0.3 * day; // 1.3 at night, 1 at full day: a marsh's mist reads as mist at noon too
  out.marsh = weights.marsh * s * cool * (1 + 0.5 * wet);
  out.coast = weights.coast * s * (0.85 + 0.3 * (1 - day)) * (1 + 0.3 * wet);
  out.cold = weights.cold * s * (0.22 + 0.45 * gust + 0.6 * snowing);
  // A forest's mist is mostly a dusk-to-dawn thing: a trace at noon, three times that at night.
  out.forest = weights.forest * s * (0.35 + 0.75 * (1 - day)) * (1 + 0.4 * wet);
  return out;
}

/**
 * The shaft multiplier under a canopy: up to 1.6 times at strength 1, and only where the trees are thick (squared:
 * a few trees round a village, forest weight 0.65, give 1.25). The shafts light the whole view toward a low sun, so
 * a sparse wood must not wash it. Pure.
 */
export function zoneShaftBoost(weights: Readonly<ZoneWeights>, strength: number): number {
  return 1 + 0.6 * weights.forest * weights.forest * zoneStrength(strength);
}

/** Everything one frame hands over; reused, never allocated per frame. */
export interface ZoneAtmosphereFrame {
  map: number | undefined;
  /** WoW world position of the character (x north, y west). */
  worldX: number;
  worldY: number;
  /** Scene-space feet. */
  feet: THREE.Vector3;
  probe: ZoneTerrainProbe | undefined;
  trees: number;
  cameraRoom: { readonly modelName: string; readonly groupFlags: number } | undefined;
  indoors: boolean;
  underwater: boolean;
  seconds: number;
  elapsed: number;
  rain: number;
  snow: number;
  windX: number;
  windZ: number;
  wind: number;
  daylight: number;
  sunDirection: THREE.Vector3;
  sunColour: THREE.Color;
  ambient: THREE.Color;
  fogColour: THREE.Color;
  pixelScale: number;
}

type ColourState = { map: number; pixels: MapColourPixels | null | undefined };

/** Fetches and decodes a map's colour picture to RGBA; undefined where the page or worker cannot decode it. */
export async function loadMapColourPixels(url: string): Promise<MapColourPixels | undefined> {
  if (typeof fetch !== "function" || typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
    return undefined;
  }
  const response = await fetch(url);
  if (!response.ok) return undefined;
  const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: image.width, height: image.height, data: image.data };
  } finally {
    bitmap.close();
  }
}

export class ZoneAtmosphere {
  readonly weights: ZoneWeights = zeroZoneWeights();
  readonly #target: ZoneWeights = zeroZoneWeights();
  readonly sample: ZoneSample = emptyZoneSample();
  readonly #scene: THREE.Scene;
  readonly #colourUrl: (map: number) => string | undefined;
  #mist: GroundMist | undefined;
  #dust: ZoneDust | undefined;
  #strength = 1;
  #sampledAt = Number.NEGATIVE_INFINITY;
  #sampledMap: number | undefined;
  #sampledX = Number.NaN;
  #sampledY = Number.NaN;
  #colour: ColourState | undefined;
  readonly #kinds: MistKinds = { marsh: 0, coast: 0, cold: 0, forest: 0 };
  readonly #light = new THREE.Color();
  /** The mist's colour: the frame's zone fog colour, which it adds by its alpha (GroundMist blends additively). */
  readonly #mistColour = new THREE.Color();
  readonly #glowColour = new THREE.Color();
  readonly #mistFrame = {
    centre: new THREE.Vector3(), probe: undefined as ZoneTerrainProbe | undefined, kinds: this.#kinds, seconds: 0,
    windX: 0, windZ: 0, light: this.#mistColour, sunColour: this.#glowColour, sunDirection: new THREE.Vector3(0, 1, 0), glow: 0,
  };

  /** `gateway` answers the gateway's origin (empty or undefined until the world has one). */
  constructor(scene: THREE.Scene, gateway: () => string | undefined) {
    this.#scene = scene;
    this.#colourUrl = (map) => {
      const base = gateway();
      return base ? withGeneration(`${base}/horizon/${map}/colour.png`) : undefined;
    };
  }

  get strength(): number { return this.#strength; }
  set strength(value: number) { this.#strength = zoneStrength(value); }
  get shaftBoost(): number { return zoneShaftBoost(this.weights, this.#strength); }
  get mist(): GroundMist | undefined { return this.#mist; }
  get dust(): ZoneDust | undefined { return this.#dust; }

  update(frame: ZoneAtmosphereFrame): void {
    const step = Number.isFinite(frame.elapsed) ? Math.max(0, frame.elapsed) : 0;
    // A jump (a teleport, a portal, a new map) is a new place at once: no fade from the old one.
    const jumped = frame.map !== this.#sampledMap
      || Math.hypot(frame.worldX - this.#sampledX, frame.worldY - this.#sampledY) > ZONE_JUMP_YARDS;
    if (jumped || frame.seconds - this.#sampledAt >= ZONE_SAMPLE_INTERVAL || frame.seconds < this.#sampledAt) {
      this.#sampledAt = frame.seconds;
      this.#sampledMap = frame.map;
      this.#sampledX = frame.worldX;
      this.#sampledY = frame.worldY;
      this.#sampleNow(frame);
      if (jumped) Object.assign(this.weights, this.#target);
    }
    advanceZoneWeights(this.weights, this.#target, step);

    // The scene's light on the air: ambient plus some of the sun, kept off black and off glare.
    const a = frame.ambient;
    const sun = frame.sunColour;
    const f = frame.fogColour;
    // Between the scene light and the fog colour: mist is the air the fog is made of, lit where it stands.
    this.#light.setRGB(
      Math.min(1, 0.45 * (a.r + 0.4 * sun.r) + 0.45 * f.r),
      Math.min(1, 0.45 * (a.g + 0.4 * sun.g) + 0.45 * f.g),
      Math.min(1.05, 0.45 * (a.b + 0.4 * sun.b) + 0.45 * f.b),
    );
    const outdoors = !frame.indoors && !frame.underwater;
    const kinds = mistKinds(this.weights, this.#strength, frame.daylight, frame.rain, frame.snow, frame.wind, this.#kinds);
    if (outdoors && kinds.marsh + kinds.coast + kinds.cold + kinds.forest > 0.004) {
      this.#mist ??= this.#adopt(new GroundMist());
      const m = this.#mistFrame;
      m.centre.copy(frame.feet);
      m.probe = frame.probe;
      m.seconds = frame.seconds;
      // Mist creeps with the air; blown snow races with it.
      const pace = 0.35 + 3.5 * Math.min(1, kinds.cold);
      m.windX = frame.windX * pace + 0.25;
      m.windZ = frame.windZ * pace + 0.1;
      m.sunDirection.copy(frame.sunDirection);
      // Lit from behind by a low sun: strongest a little above the horizon, nothing below it or overhead.
      const elevation = frame.sunDirection.y;
      m.glow = elevation > -0.05 ? Math.max(0, 1 - Math.abs(elevation - 0.18) / 0.45) * Math.min(1, frame.daylight + 0.3) : 0;
      this.#glowColour.copy(sun);
      this.#mistColour.copy(f);
      this.#mist.update(m, step);
    } else {
      this.#mist?.hide();
    }
    const cave = this.weights.cave * this.#strength;
    if (cave > 0.01 && !frame.underwater) {
      this.#dust ??= this.#adopt(new ZoneDust());
      this.#dust.update(cave, this.#light, frame.pixelScale, step);
    } else {
      this.#dust?.hide();
    }
  }

  /** Shapes the zone fog (outdoors) of this frame. */
  shapeOutdoorFog(fog: ZoneFogTarget): void {
    shapeZoneFog(fog, this.weights, this.#strength, OUTDOOR_FOG_KINDS);
  }

  /** Shapes a cave's fog — the scene's and the room's — of this frame. */
  shapeCaveFog(fog: ZoneFogTarget): void {
    shapeZoneFog(fog, this.weights, this.#strength, CAVE_FOG_KINDS);
  }

  #sampleNow(frame: ZoneAtmosphereFrame): void {
    const sample = this.sample;
    if (frame.probe) sampleZoneTerrain(frame.probe, frame.worldX, frame.worldY, sample);
    sample.trees = frame.trees;
    sample.caveRoom = caveRoom(frame.cameraRoom?.modelName, frame.cameraRoom?.groupFlags);
    sample.snowing = frame.snow;
    sample.snowGround = 0;
    if (frame.map !== undefined) {
      const colour = this.#colourFor(frame.map);
      if (colour) sample.snowGround = mapSnowShare(colour, frame.worldX, frame.worldY);
    }
    zoneKindTargets(sample, this.#target);
  }

  /** The map's colour picture once decoded; asked for once per map (a failure is final for the map). */
  #colourFor(map: number): MapColourPixels | undefined {
    const known = this.#colour;
    if (known && known.map === map) return known.pixels ?? undefined;
    const state: ColourState = { map, pixels: undefined };
    this.#colour = state;
    const url = this.#colourUrl(map);
    if (!url) {
      state.pixels = null;
      return undefined;
    }
    void loadMapColourPixels(url).then((pixels) => { state.pixels = pixels ?? null; }, () => { state.pixels = null; });
    return undefined;
  }

  #adopt<T extends { object: THREE.Object3D }>(owner: T): T {
    this.#scene.add(owner.object);
    return owner;
  }

  get objects(): THREE.Object3D[] {
    const objects: THREE.Object3D[] = [];
    if (this.#mist) objects.push(this.#mist.object);
    if (this.#dust) objects.push(this.#dust.object);
    return objects;
  }

  /** Replay restart: weights back to zero, the grid forgotten. */
  reset(): void {
    for (const kind of Object.keys(this.weights) as (keyof ZoneWeights)[]) {
      this.weights[kind] = 0;
      this.#target[kind] = 0;
    }
    this.#sampledAt = Number.NEGATIVE_INFINITY;
    this.#sampledMap = undefined;
    this.#sampledX = Number.NaN;
    this.#sampledY = Number.NaN;
    this.#mist?.reset();
    this.#dust?.reset();
  }

  dispose(): void {
    for (const owner of [this.#mist, this.#dust]) {
      if (!owner) continue;
      this.#scene.remove(owner.object);
      owner.dispose();
    }
    this.#mist = undefined;
    this.#dust = undefined;
    this.#colour = undefined;
    this.reset();
  }
}
