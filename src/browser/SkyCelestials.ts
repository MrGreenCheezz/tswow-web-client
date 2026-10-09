// 05.10-A7b-6 (7.04 slices 1–4): the sun, the two moons, the stars and the day-night clouds of the
// procedural sky, and the LightSkybox flags that decide whether they show and how a sky clip runs.
//
// Everything numeric here was read out of the 3.3.5a client (Wow.exe 12340) — its own key tables and
// constants, cited by address; no code is copied, the behaviour is described in our own words.
// Notes and raw outputs: `.runtime/re-2026-10-05/A7b-6/` (b1…b6).
//
//   * 0x7f2790 sets the sky up: `Textures\sunCenter.blp` at base scale 1, `Textures\moon.blp` at 1.75
//     (0xa1ea74), `Textures\moon02.blp` at 1 with a 1.7-day cycle (0xa241a0), and
//     `Environments\Stars\stars.mdl` (0x9abb00; the archives hold it as `Stars.m2`).
//   * 0x7eecc0, every frame: each body's direction is spherical (polar angle from the zenith,
//     azimuth in the world's X/Y plane) from two piecewise-linear key tables over the fraction of the
//     day, at distance 12 (0xa1047c) from the camera, and its size is a third table times the base.
//   * 0x7ed3b0 is the key interpolator: time clamped to [0, 1], linear between keys, wrapping from
//     the last key to the first across midnight; a pair closer than 0.001 holds the earlier value.
//   * 0x7f3230: the bodies' colour is Light int band 9 (the sampled block's tenth colour), its alpha
//     replaced by 1 − storm when the storm light is blended in.
//   * 0x7edbe0/0x7edee0: each body is a quad of side `scale` facing the camera; the part under the
//     camera's horizon is clipped away and the vertices within 0.4 units of it fade to transparent.
//   * 0x7f09b0: stars, sun, moon, second moon and clouds are drawn only while no loaded LightSkybox
//     model covers the sky — weight above 0.99 and `LightSkybox.Flags & 2` clear.
//   * 0x7ee0d0: the stars model sits on the camera with alpha = key table 0xaf4c20 × 254 + 1 (/255),
//     drawn when that byte exceeds 1.
//   * 0x7efd00/0x7efae0: the day-night clouds are a CPU noise texture (`DNClouds0/1`), covered where
//     the noise exceeds 1 − Light float band 3 (low byte, as the client keeps it), coloured
//     band 12 + band 11 × density shade + band 10 × lighting, lit from the sun from 04:50 to 22:10
//     and from the moon outside it, the lit term scaled down by 0.75 × storm.
//   * 0x7ecf20: a LightSkybox model with `Flags & 1` has its clip laid over the game day (time =
//     minute / 1440 × duration, played at one clip per day); without it the clip runs on the wall
//     clock like any model.
//
// What is NOT from the client (calibrations, recorded in WORK_PLAN 7.04 and the line): the clouds'
// noise shape, drift speed and alpha ramp (the client builds its alpha table at run time), and the
// day number the second moon's cycle counts from. The glare sprites (`sunGlare.blp`,
// `moonGlare.blp`, their day curves at 0x7ee150/0x7ee230) are not drawn: their draw routine was not
// located, so their size and strength would be guesses.

import * as THREE from "three";

import type { ModelTextureStatus } from "./TextureLoad.js";
import { textureUrl } from "./Wvm.js";

/** Half-minutes in a game day (the Light.dbc clock), as `LightClient.DAY_HALF_MINUTES`. */
const DAY_HALF_MINUTES = 2880;

/** 0xa1047c: the bodies sit 12 units from the camera; their quads are `scale` units across. */
export const SKY_CELESTIAL_DISTANCE = 12;
/** 0x7edee0 (0x9f98d8, ×2.5 at 0x9edce8): vertices within 0.4 units above the horizon fade out. */
export const SKY_HORIZON_FADE = 0.4;
/** 0xa241a0 → 0xd38e84: the second moon's cycle, in game days. */
export const MOON2_PERIOD_DAYS = 1.7;
/** 0x7f2790: base scales (sun 1.0, moon 1.75 at 0xa1ea74, second moon 1.0). */
export const SUN_BASE_SCALE = 1;
export const MOON_BASE_SCALE = 1.75;
export const MOON2_BASE_SCALE = 1;
/** 0x7efae0 (0xa41ca4, 0xa41ca0): the clouds take the sun's light in [0.2014, 0.9236) of the day. */
export const CLOUD_SUN_FROM = 0.2013888955116272;
export const CLOUD_SUN_UNTIL = 0.9236111044883728;

export const SKY_SUN_TEXTURE = "Textures\\sunCenter.blp";
export const SKY_MOON_TEXTURE = "Textures\\moon.blp";
export const SKY_MOON2_TEXTURE = "Textures\\moon02.blp";
export const SKY_STARS_MODEL = "Environments\\Stars\\Stars.m2";

/** Flat `[time0, value0, time1, value1, …]` keys over the fraction of the day. */
export type SkyKeys = readonly number[];

// The tables 0x7eecc0 fills once (guard bits at 0xd39208), as (fraction of day, radians / scale).
/** 0xd391e0: the sun's polar angle — 100° (under the horizon) at 05:30 and 21:30, 5° at noon. */
export const SUN_POLAR: SkyKeys = [
  0.2291666716337204, 1.7453292608261108, 0.4965277910232544, 0.0872664675116539,
  0.5, 0.0872664675116539, 0.5034722089767456, 0.0872664675116539, 0.8958333134651184, 1.7453292608261108,
];
/** 0xd391c8: the sun's azimuth — a constant 45°: it rises and sets on one bearing. */
export const SUN_AZIMUTH: SkyKeys = [
  0.2291666716337204, 0.7853981852531433, 0.5, 0.7853981852531433, 0.8958333134651184, 0.7853981852531433,
];
/** 0xd39128: the sun's size — twice its noon size near the horizon. */
export const SUN_SCALE: SkyKeys = [0.25, 2, 0.28125, 1, 0.84375, 1, 0.875, 2];
/** 0xd391a0 (and 0xd39160 for the second moon): 35° from the zenith around midnight, set 04:00–22:00. */
export const MOON_POLAR: SkyKeys = [
  0, 0.6108652353286743, 0.0034722222480922937, 0.6108652353286743, 0.1666666716337204, 1.7453292608261108,
  0.9166666865348816, 1.7453292608261108, 0.9965277910232544, 0.6108652353286743,
];
/** 0xd39188: the moon's azimuth, 45° like the sun's. */
export const MOON_AZIMUTH: SkyKeys = [
  0, 0.7853981852531433, 0.1666666716337204, 0.7853981852531433, 0.9166666865348816, 0.7853981852531433,
];
/** 0xd39148: the second moon's azimuth drifts 135° → 150° → 165° over its own cycle. */
export const MOON2_AZIMUTH: SkyKeys = [
  0, 2.356194496154785, 0.1666666716337204, 2.6179938316345215, 0.9166666865348816, 2.879793405532837,
];
/** 0xd39108: both moons' size — 1 around midnight, 1.5 while set. */
export const MOON_SCALE: SkyKeys = [
  0.0416666716337204, 1, 0.1666666716337204, 1.5, 0.9166666865348816, 1.5, 0.9993056058883667, 1,
];
/** 0xaf4c20: star visibility — full 00:00–03:00, gone 04:30–22:30. */
export const STAR_ALPHA: SkyKeys = [0.125, 1, 0.1875, 0, 0.9375, 0, 1, 1];

/** The client's key interpolator (0x7ed3b0). Empty tables answer 0. */
export function skyKeyCurve(keys: SkyKeys, time: number): number {
  const count = keys.length >> 1;
  if (count === 0) return 0;
  const t = Number.isFinite(time) ? Math.max(0, Math.min(1, time)) : 0;
  let next = 0;
  while (next < count && !(t <= keys[next * 2]!)) next++;
  let previous: number;
  if (next === count) {
    next = 0;
    previous = count - 1;
  } else {
    previous = next === 0 ? count - 1 : next - 1;
  }
  const from = keys[previous * 2]!;
  const fromValue = keys[previous * 2 + 1]!;
  let span = keys[next * 2]! - from;
  if (Math.abs(span) < 0.001) return fromValue;
  if (span < 0) span += 1;
  let into = t - from;
  if (into < 0) into += 1;
  return fromValue + (keys[next * 2 + 1]! - fromValue) * (into / span);
}

/** Fraction of the game day for a Light.dbc time in half-minutes. */
export function skyDayFraction(time: number): number {
  const safe = Number.isFinite(time) ? time : 0;
  return (((safe % DAY_HALF_MINUTES) + DAY_HALF_MINUTES) % DAY_HALF_MINUTES) / DAY_HALF_MINUTES;
}

/** The second moon's clock: where it is in its 1.7-day cycle (0x7eecc0, 16.16 fixed point there). */
export function moon2Fraction(day: number, fraction: number): number {
  const total = (Number.isFinite(day) ? day : 0) + (Number.isFinite(fraction) ? fraction : 0);
  const cycles = total / MOON2_PERIOD_DAYS;
  const value = cycles - Math.floor(cycles);
  return value >= 1 ? 0 : value;
}

export interface SkyVector { x: number; y: number; z: number }

/**
 * A body's unit direction in scene space from the client's polar angle and azimuth.
 *
 * The client places it at (cos az · sin polar, sin az · sin polar, cos polar) in world axes — X north,
 * Y west, Z up — and the scene draws world (x, y, z) as (x, z, −y).
 */
export function celestialDirection<T extends SkyVector>(polar: number, azimuth: number, target: T): T {
  const ring = Math.sin(polar);
  target.x = Math.cos(azimuth) * ring;
  target.y = Math.cos(polar);
  target.z = -Math.sin(azimuth) * ring;
  return target;
}

/** One body of the sky at one moment: direction (scene, unit) and quad size in client units. */
export interface CelestialBody extends SkyVector { scale: number }

export interface CelestialFrame {
  sun: CelestialBody;
  moon: CelestialBody;
  moon2: CelestialBody;
  /** 0..1, the stars model's alpha (the byte the client keeps, over 255). */
  stars: number;
}

export function createCelestialFrame(): CelestialFrame {
  return {
    sun: { x: 0, y: 1, z: 0, scale: 1 },
    moon: { x: 0, y: 1, z: 0, scale: 1 },
    moon2: { x: 0, y: 1, z: 0, scale: 1 },
    stars: 0,
  };
}

/** Fills `out` for a fraction of the day and a day number; no allocation. */
export function computeCelestialFrame(fraction: number, day: number, out: CelestialFrame): CelestialFrame {
  const t = Number.isFinite(fraction) ? fraction : 0;
  celestialDirection(skyKeyCurve(SUN_POLAR, t), skyKeyCurve(SUN_AZIMUTH, t), out.sun);
  out.sun.scale = skyKeyCurve(SUN_SCALE, t) * SUN_BASE_SCALE;
  celestialDirection(skyKeyCurve(MOON_POLAR, t), skyKeyCurve(MOON_AZIMUTH, t), out.moon);
  out.moon.scale = skyKeyCurve(MOON_SCALE, t) * MOON_BASE_SCALE;
  const second = moon2Fraction(day, t);
  celestialDirection(skyKeyCurve(MOON_POLAR, second), skyKeyCurve(MOON2_AZIMUTH, second), out.moon2);
  out.moon2.scale = skyKeyCurve(MOON_SCALE, second) * MOON2_BASE_SCALE;
  out.stars = starAlpha(t);
  return out;
}

/** 0x7ee0d0: the stars' alpha byte (curve × 254 + 1, rounded) over 255; drawn above 1/255. */
export function starAlpha(fraction: number): number {
  return Math.round(skyKeyCurve(STAR_ALPHA, fraction) * 254 + 1) / 255;
}

/** Whether the stars model is drawn at all for this alpha (the client tests the byte for > 1). */
export function starsDrawn(alpha: number): boolean {
  return Math.round(alpha * 255) > 1;
}

/**
 * Whether a loaded LightSkybox model hides the procedural sky's bodies, stars and clouds
 * (0x7f09b0): a model that is actually loaded, and `Flags & 2` clear. A flag-2 model is an overlay
 * (auroras, Dalaran's «Scarlet» sky) and the bodies show under it.
 */
export function skyboxCoversSky(skyboxLoaded: boolean, flags: number): boolean {
  return skyboxLoaded && ((Number.isFinite(flags) ? flags : 0) & 2) === 0;
}

/**
 * The time a LightSkybox clip is posed at (0x7ecf20). `Flags & 1`: laid over the game day — what
 * the renderer has always done. Otherwise the clip loops on the wall clock. A body without the v5
 * channels (an old gateway) carries no flags, so it keeps the day-synced behaviour exactly.
 */
export function skyboxClipTimeMs(
  lightTime: number,
  durationMs: number,
  wallMs: number,
  flags: number,
  skyChannels: boolean,
): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  if (!skyChannels || ((Number.isFinite(flags) ? flags : 0) & 1) !== 0) {
    return skyDayFraction(lightTime) * durationMs;
  }
  const wall = Number.isFinite(wallMs) ? wallMs : 0;
  return ((wall % durationMs) + durationMs) % durationMs;
}

/**
 * The noise level clouds start at (0x7efd00): the client keeps `round((1 − band3) × 255)` as an
 * unsigned value and compares its low byte, so a band above 1 wraps rather than clamping.
 */
export function cloudCoverThreshold(density: number): number {
  const safe = Number.isFinite(density) ? density : 0;
  const byte = ((Math.round((1 - safe) * 255) % 256) + 256) % 256;
  return byte / 255;
}

/**
 * 05.10: ревью A7b-6. Whether another pass draws a sun at the renderer's own sun direction, so the
 * client-placed sun quad must give way («one sun»). Under the cinematic chain the disc is injected
 * by the bloom leaf only, scaled by the strength slider; the classic radial shafts are skipped there.
 * Without it the classic shafts draw their source at `godRaySunDirection` while their slider is up.
 */
export function skyPostDrawsSun(
  cinematicActive: boolean,
  cinematicBloom: boolean,
  cinematicStrength: number,
  godRaysActive: boolean,
  godRayScale: number,
): boolean {
  if (cinematicActive) return cinematicBloom && cinematicStrength > 0;
  return godRaysActive && godRayScale > 0;
}

/** Which body lights the clouds at this fraction of the day (0x7efae0). */
export function cloudLightIsSun(fraction: number): boolean {
  return fraction >= CLOUD_SUN_FROM && fraction < CLOUD_SUN_UNTIL;
}

// --- GPU side --------------------------------------------------------------------------------

/** Radius the sky's bodies are drawn at: inside the 800-unit dome, inside the far plane. */
export const SKY_LAYER_RADIUS = 700;
const CLOUD_RADIUS = 760;

/** Billboard a unit quad at its object origin, rolled to the horizon like the client's basis (0x9abb60). */
export const CELESTIAL_VERTEX_SHADER = `
uniform float celestialSize;
varying vec2 vCelestialUv;
varying vec3 vCelestialDirection;
void main() {
  vec3 centre = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 facing = normalize(centre - cameraPosition);
  vec3 side = cross(facing, vec3(0.0, 1.0, 0.0));
  float sideLength = length(side);
  side = sideLength > 0.0001 ? side / sideLength : vec3(1.0, 0.0, 0.0);
  vec3 lift = cross(side, facing);
  vec3 world = centre + (side * position.x + lift * position.y) * celestialSize;
  vCelestialUv = uv;
  vCelestialDirection = world - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

export const CELESTIAL_FRAGMENT_SHADER = `
uniform sampler2D celestialMap;
uniform vec3 celestialColour;
uniform float celestialOpacity;
uniform float celestialHorizon;
varying vec2 vCelestialUv;
varying vec3 vCelestialDirection;
void main() {
  float height = normalize(vCelestialDirection).y * celestialHorizon;
  if (height <= 0.0) discard;
  vec4 texel = texture2D(celestialMap, vCelestialUv);
  float alpha = texel.a * celestialOpacity * clamp(height, 0.0, 1.0);
  if (alpha <= 0.0) discard;
  gl_FragColor = vec4(texel.rgb * celestialColour, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export const CLOUD_VERTEX_SHADER = `
varying vec3 vCloudDirection;
void main() {
  vCloudDirection = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const CLOUD_FRAGMENT_SHADER = `
uniform vec3 cloudBase;
uniform vec3 cloudBody;
uniform vec3 cloudLit;
uniform vec3 cloudLight;
uniform float cloudThreshold;
uniform float cloudLitScale;
uniform float cloudOpacity;
uniform vec2 cloudOffset;
varying vec3 vCloudDirection;
float cloudHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float cloudNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 into = fract(p);
  vec2 ease = into * into * (3.0 - 2.0 * into);
  float bottom = mix(cloudHash(cell), cloudHash(cell + vec2(1.0, 0.0)), ease.x);
  float top = mix(cloudHash(cell + vec2(0.0, 1.0)), cloudHash(cell + vec2(1.0, 1.0)), ease.x);
  return mix(bottom, top, ease.y);
}
float cloudField(vec2 p) {
  return (cloudNoise(p) * 0.6667 + cloudNoise(p * 2.0 + vec2(5.2, 1.3)) * 0.3333);
}
vec3 cloudToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
void main() {
  vec3 direction = normalize(vCloudDirection);
  if (direction.y <= 0.0) discard;
  vec2 plane = direction.xz / (direction.y + 0.15) * 1.5 + cloudOffset;
  float density = cloudField(plane);
  float alpha = clamp((density - cloudThreshold) * 4.0, 0.0, 1.0);
  alpha *= smoothstep(0.0, 0.12, direction.y) * cloudOpacity;
  if (alpha <= 0.0) discard;
  float shade = (1.0 - alpha) * 0.5 + 0.25;
  vec3 colour = cloudBase + cloudBody * shade;
  float slopeX = cloudField(plane + vec2(0.05, 0.0)) - density;
  float slopeY = cloudField(plane + vec2(0.0, 0.05)) - density;
  vec3 surface = normalize(vec3(-slopeX * 20.0, -slopeY * 20.0, 1.0));
  vec3 toLight = normalize(vec3(cloudLight.x, cloudLight.z, max(cloudLight.y, 0.0) + 0.05));
  float lit = dot(surface, toLight);
  if (lit > 0.0) colour += cloudLit * (lit * cloudLitScale);
  colour = min(colour, vec3(1.0));
  gl_FragColor = vec4(cloudToLinear(colour), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** What the renderer hands over each frame; owned and mutated by the renderer, never reallocated. */
export interface SkyCelestialInput {
  /** The v5 channels exist, the sky is on screen and no LightSkybox model covers it. */
  enabled: boolean;
  /** Light.dbc time in half-minutes. */
  time: number;
  /** Day number for the second moon's cycle. */
  day: number;
  /** Packed 0xRRGGBB display-space colours: band 9 (bodies), 10/11/12 (clouds). */
  sunColour: number;
  sunHalo: number;
  cloudA: number;
  cloudB: number;
  /** Light float band 3. */
  cloudDensity: number;
  /** 0..1 storm blend (`WeatherFade.storm`, the client's 0xd38b88). */
  storm: number;
  /**
   * Another pass draws the sun (the cinematic post's HDR disc, the shafts' synthetic disc) at the
   * renderer's own sun direction; the client-placed sun quad then stays hidden so there is one sun.
   */
  postSun: boolean;
  /** Seconds, for the clouds' drift. */
  seconds: number;
}

export function createSkyCelestialInput(): SkyCelestialInput {
  return {
    enabled: false, time: 0, day: 0, sunColour: 0, sunHalo: 0, cloudA: 0, cloudB: 0,
    cloudDensity: 0, storm: 0, postSun: false, seconds: 0,
  };
}

/** Texture fetch and its readiness, supplied by the renderer (a failed fetch must draw nothing). */
export interface SkyTextureSource {
  load(path: string): THREE.Texture;
  ready(texture: THREE.Texture): boolean;
}

/** The client textures through the gateway's `/texture` route and a loader the caller owns. */
export function skyTextureSource(
  baseUrl: string,
  loader: { load(url: string): THREE.Texture; status(texture: THREE.Texture): ModelTextureStatus },
): SkyTextureSource {
  return {
    load: (path) => loader.load(textureUrl(baseUrl, path)),
    ready: (texture) => loader.status(texture) === "ready",
  };
}

interface BodyMesh {
  mesh: THREE.Mesh;
  uniforms: {
    celestialMap: { value: THREE.Texture | null };
    celestialColour: { value: THREE.Color };
    celestialOpacity: { value: number };
    celestialSize: { value: number };
    celestialHorizon: { value: number };
  };
  path: string;
  texture: THREE.Texture | undefined;
}

/** Drift of the cloud field per second (calibration; the client's own wind term is not traced). */
const CLOUD_DRIFT_X = 0.006;
const CLOUD_DRIFT_Y = 0.0025;

/**
 * The procedural sky's bodies, stars and clouds, as one camera-centred group for the sky scene.
 * Nothing in `update` allocates: three quads, one cloud dome, an optional stars node.
 */
export class SkyCelestials {
  readonly group = new THREE.Group();
  readonly frame = createCelestialFrame();
  readonly #quad = new THREE.PlaneGeometry(1, 1);
  readonly #bodies: BodyMesh[];
  readonly #cloud: THREE.Mesh;
  readonly #cloudUniforms = {
    cloudBase: { value: new THREE.Color() },
    cloudBody: { value: new THREE.Color() },
    cloudLit: { value: new THREE.Color() },
    cloudLight: { value: new THREE.Vector3(0, 1, 0) },
    cloudThreshold: { value: 1 },
    cloudLitScale: { value: 1 },
    cloudOpacity: { value: 1 },
    cloudOffset: { value: new THREE.Vector2() },
  };
  #stars: THREE.Object3D | undefined;
  #starMaterials: readonly THREE.Material[] = [];
  #starBaseOpacity: readonly number[] = [];
  #source: SkyTextureSource | undefined;

  constructor() {
    this.group.name = "skyCelestials";
    this.group.visible = false;
    this.#bodies = [SKY_SUN_TEXTURE, SKY_MOON_TEXTURE, SKY_MOON2_TEXTURE].map((path, index) => {
      const uniforms = {
        celestialMap: { value: null as THREE.Texture | null },
        celestialColour: { value: new THREE.Color(1, 1, 1) },
        celestialOpacity: { value: 1 },
        celestialSize: { value: 1 },
        celestialHorizon: { value: SKY_CELESTIAL_DISTANCE / SKY_HORIZON_FADE },
      };
      const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: CELESTIAL_VERTEX_SHADER,
        fragmentShader: CELESTIAL_FRAGMENT_SHADER,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        fog: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.#quad, material);
      mesh.name = index === 0 ? "skySun" : index === 1 ? "skyMoon" : "skyMoon2";
      mesh.frustumCulled = false;
      // Drawn after the dome (−1) and the stars, before the clouds and any LightSkybox (−0.5).
      mesh.renderOrder = -0.85 + index * 0.01;
      mesh.visible = false;
      this.group.add(mesh);
      return { mesh, uniforms, path, texture: undefined };
    });
    const cloudMaterial = new THREE.ShaderMaterial({
      uniforms: this.#cloudUniforms,
      vertexShader: CLOUD_VERTEX_SHADER,
      fragmentShader: CLOUD_FRAGMENT_SHADER,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
      side: THREE.BackSide,
    });
    // The upper half only: the clouds are never under the horizon.
    this.#cloud = new THREE.Mesh(new THREE.SphereGeometry(CLOUD_RADIUS, 32, 8, 0, Math.PI * 2, 0, Math.PI / 2), cloudMaterial);
    this.#cloud.name = "skyClouds";
    this.#cloud.frustumCulled = false;
    this.#cloud.renderOrder = -0.75;
    this.#cloud.visible = false;
    this.group.add(this.#cloud);
  }

  /** Where the textures come from; set once the gateway is known. */
  setTextureSource(source: SkyTextureSource): void {
    this.#source = source;
  }

  /** Whether the stars model should be asked for (and kept resident) this frame. */
  get wantsStars(): boolean {
    return this.group.visible && starsDrawn(this.frame.stars) && this.#stars === undefined;
  }

  get hasStars(): boolean {
    return this.#stars !== undefined;
  }

  /**
   * Hands over the built stars node with its sky materials (already depth- and fog-free). Opacity
   * is the client's star alpha times each material's own.
   */
  setStars(node: THREE.Object3D, materials: readonly THREE.Material[]): void {
    this.clearStars();
    this.#stars = node;
    this.#starMaterials = materials;
    this.#starBaseOpacity = materials.map((material) => material.opacity);
    for (const material of materials) material.transparent = true;
    node.renderOrder = -0.9;
    node.traverse((child) => { child.renderOrder = -0.9; });
    this.group.add(node);
  }

  clearStars(): void {
    const node = this.#stars;
    if (!node) return;
    this.group.remove(node);
    for (const material of this.#starMaterials) material.dispose();
    this.#stars = undefined;
    this.#starMaterials = [];
    this.#starBaseOpacity = [];
  }

  /** One frame. `camera` is the world camera position in scene space. */
  update(input: SkyCelestialInput, camera: THREE.Vector3): void {
    if (!input.enabled) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.group.position.copy(camera);
    const fraction = skyDayFraction(input.time);
    const frame = computeCelestialFrame(fraction, input.day, this.frame);
    const storm = Math.max(0, Math.min(1, Number.isFinite(input.storm) ? input.storm : 0));
    const bodies = this.#bodies;
    for (let index = 0; index < bodies.length; index++) {
      const body = bodies[index]!;
      const at = index === 0 ? frame.sun : index === 1 ? frame.moon : frame.moon2;
      const texture = this.#texture(body);
      // The client clips the quad at the horizon (0x7edee0); it is gone once its top edge is under.
      const shown = texture !== undefined && at.y * SKY_CELESTIAL_DISTANCE + at.scale * 0.5 > 0 && storm < 1
        && !(index === 0 && input.postSun);
      body.mesh.visible = shown;
      if (!shown) continue;
      body.mesh.position.set(at.x * SKY_LAYER_RADIUS, at.y * SKY_LAYER_RADIUS, at.z * SKY_LAYER_RADIUS);
      body.uniforms.celestialSize.value = at.scale * SKY_LAYER_RADIUS / SKY_CELESTIAL_DISTANCE;
      body.uniforms.celestialColour.value.setHex(input.sunColour & 0xffffff, THREE.SRGBColorSpace);
      body.uniforms.celestialOpacity.value = 1 - storm;
    }
    if (this.#stars) {
      const alpha = frame.stars;
      const drawn = starsDrawn(alpha);
      this.#stars.visible = drawn;
      if (drawn) {
        for (let index = 0; index < this.#starMaterials.length; index++) {
          this.#starMaterials[index]!.opacity = (this.#starBaseOpacity[index] ?? 1) * alpha;
        }
      }
    }
    this.#updateClouds(input, fraction, storm);
  }

  #updateClouds(input: SkyCelestialInput, fraction: number, storm: number): void {
    const threshold = cloudCoverThreshold(input.cloudDensity);
    const shown = input.cloudDensity > 0 && threshold < 1;
    this.#cloud.visible = shown;
    if (!shown) return;
    const u = this.#cloudUniforms;
    // Display-space values: the client adds and clamps them as bytes, then the shader decodes once.
    setDisplay(u.cloudBase.value, input.cloudB);
    setDisplay(u.cloudBody.value, input.cloudA);
    setDisplay(u.cloudLit.value, input.sunHalo);
    const light = cloudLightIsSun(fraction) ? this.frame.sun : this.frame.moon;
    u.cloudLight.value.set(light.x, light.y, light.z);
    u.cloudThreshold.value = threshold;
    u.cloudLitScale.value = 1 - 0.75 * storm;
    u.cloudOpacity.value = 1;
    const seconds = Number.isFinite(input.seconds) ? input.seconds : 0;
    u.cloudOffset.value.set((seconds * CLOUD_DRIFT_X) % 1024, (seconds * CLOUD_DRIFT_Y) % 1024);
  }

  #texture(body: BodyMesh): THREE.Texture | undefined {
    if (!body.texture) {
      if (!this.#source) return undefined;
      body.texture = this.#source.load(body.path);
      body.uniforms.celestialMap.value = body.texture;
    }
    return this.#source?.ready(body.texture) ? body.texture : undefined;
  }

  /** Every material the group can draw, for program warm-up. */
  materials(): THREE.Material[] {
    return [...this.#bodies.map((body) => body.mesh.material as THREE.Material), this.#cloud.material as THREE.Material];
  }

  dispose(): void {
    this.clearStars();
    for (const body of this.#bodies) {
      (body.mesh.material as THREE.Material).dispose();
      // The textures belong to the loader that made them (`SkyTextureSource`).
      body.texture = undefined;
    }
    this.#quad.dispose();
    this.#cloud.geometry.dispose();
    (this.#cloud.material as THREE.Material).dispose();
    this.group.clear();
  }
}

function setDisplay(target: THREE.Color, packed: number): void {
  const value = Number.isFinite(packed) ? packed & 0xffffff : 0;
  target.r = ((value >> 16) & 0xff) / 255;
  target.g = ((value >> 8) & 0xff) / 255;
  target.b = (value & 0xff) / 255;
}

/**
 * The sky copy of an M2 node's materials, as `#updateSkybox` makes them: unlit, fog-free, no
 * depth, the authored blend kept. Returns the new materials so the caller can drive their opacity.
 */
export function skyBasicMaterials(node: THREE.Object3D): THREE.Material[] {
  const made: THREE.Material[] = [];
  node.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const source = Array.isArray(child.material) ? child.material : [child.material];
    const next = source.map((value: THREE.Material) => {
      const standard = value as THREE.MeshStandardMaterial;
      const material = new THREE.MeshBasicMaterial({
        map: standard.map ?? null,
        color: standard.color?.clone() ?? new THREE.Color(0xffffff),
        transparent: value.transparent, opacity: value.opacity, alphaTest: value.alphaTest,
        side: value.side, depthTest: false, depthWrite: false,
        vertexColors: value.vertexColors,
      });
      material.blending = value.blending;
      material.premultipliedAlpha = value.premultipliedAlpha;
      material.fog = false;
      made.push(material);
      return material;
    });
    child.material = Array.isArray(child.material) ? next : next[0]!;
    child.frustumCulled = false;
  });
  return made;
}
