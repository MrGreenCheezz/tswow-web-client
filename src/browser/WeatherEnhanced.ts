/**
 * The enhanced look of what falls out of the sky (`experimentalRainStreaks`).
 *
 * The faithful WeatherEffect material stays exactly as it is; this is a second material over the
 * same seed cloud, swapped in by `WeatherEffect.setMaterialOverride`. It reads the same uniforms
 * object references (fall, box, sway, size, tint, opacity, map, time, origin) plus its own:
 *
 * - `uWind`: the shared wind field as a horizontal velocity. Drops travel with it and each quad is
 *   aligned to its own velocity, so rain slants into the wind instead of falling as plumb lines.
 * - `uStreak` / `uWidth`: rain is stretched along that velocity — a 22 yd/s drop seen for a 60 Hz
 *   frame is a streak, not a dot — and flakes are drawn a little larger than the faithful ones.
 * - `uNear`: drops that pass within a yard of the lens are faded out rather than drawn as a
 *   screen-sized smear.
 * - `uLight` / `uGain`: the scene's own light (sky-lit for rain), so rain is dim at night and bright
 *   in a sunset. The client's drop texture is a mid grey line; `uGain` lifts it to what a lit
 *   drop looks like against the storm fog behind it.
 * - `uSun` / `uBacklight`: a drop between the eye and a low sun lights up (forward scattering),
 *   which is what makes rain read in the haze of a rainy sunset.
 *
 * Plus two PrecipitationLayers built from the same seed geometry: a dense mid-distance layer of thin
 * procedural streaks (or soft flakes for snow) and, for rain, a sparse distant curtain of long faint
 * streaks — the thing that makes a storm look like weather rather than particles.
 */

import * as THREE from "three";
import type { IUniform } from "three";
import type { WeatherKind } from "../world/WorldMessageProtocol.js";
import { buildWeatherGeometry } from "./WeatherEffect.js";
import { WIND_RAIN_SPEED } from "./WindField.js";

export const WEATHER_ENHANCED_MARKER = "weather-enhanced-v2";

export interface EnhancedWeatherUniforms {
  /** Horizontal velocity of the precipitation, scene yards per second: what the quads align to. */
  readonly uWind: IUniform<THREE.Vector2>;
  /**
   * Where the cloud has travelled: the integral of that velocity (x, z) and of the fall speed (y),
   * each wrapped to the box (`advancePrecipitationOffset`). Positions read this, never
   * `velocity × time`: a wind that eases or wanders would otherwise move every drop by the change
   * times the whole elapsed time at once, which after ten minutes of rain is a sideways jump of
   * dozens of yards a frame, streaks sliding across the view while drawn as if falling straight.
   */
  readonly uOffset: IUniform<THREE.Vector3>;
  /** The sway clock, wrapped to its own period so a long session keeps float precision. */
  readonly uPhase: IUniform<number>;
  readonly uNear: IUniform<THREE.Vector2>;
  readonly uStreak: IUniform<number>;
  /** Multiplies the quad's width (and a flake's size, together with `uStreak`). */
  readonly uWidth: IUniform<number>;
  readonly uLight: IUniform<THREE.Color>;
  /** Multiplies the texel colour (the client's drop is a mid grey; a lit drop is brighter). */
  readonly uGain: IUniform<number>;
  /** Multiplies the preset opacity (streaks are thinner than the faithful drops, so they need it). */
  readonly uAlphaScale: IUniform<number>;
  /** 0: the texture; 1: a soft procedural streak (sub-pixel texels far away); 2: a soft round flake. */
  readonly uProcedural: IUniform<number>;
  /** Scene-space unit vector towards the sun. */
  readonly uSun: IUniform<THREE.Vector3>;
  /** How much brighter a drop straight between the eye and the sun is (0: none). */
  readonly uBacklight: IUniform<number>;
}

export function createEnhancedWeatherUniforms(): EnhancedWeatherUniforms {
  return {
    uWind: { value: new THREE.Vector2() },
    uOffset: { value: new THREE.Vector3() },
    uPhase: { value: 0 },
    uNear: { value: new THREE.Vector2(0.8, 3) },
    uStreak: { value: 1 },
    uWidth: { value: 1 },
    uLight: { value: new THREE.Color(1, 1, 1) },
    uGain: { value: 1 },
    uAlphaScale: { value: 1 },
    uProcedural: { value: 0 },
    uSun: { value: new THREE.Vector3(0, 1, 0) },
    uBacklight: { value: 0 },
  };
}

export interface EnhancedWeatherParams {
  windX: number;
  windZ: number;
  nearStart: number;
  nearEnd: number;
  streak: number;
  width: number;
  alphaScale: number;
  gain: number;
}

/**
 * How one kind of weather rides the wind. `direction` is the field's scene-space unit vector,
 * `strength` 0..1 and `gust` 0..1. Written into `out` — called once per frame, no allocation.
 */
export function enhancedWeatherParams(
  kind: WeatherKind, directionX: number, directionZ: number, strength: number, gust: number,
  out: EnhancedWeatherParams,
): EnhancedWeatherParams {
  const s = Math.max(0, Math.min(1, Number.isFinite(strength) ? strength : 0));
  const g = Math.max(0, Math.min(1, Number.isFinite(gust) ? gust : 0));
  let speed = 0;
  out.nearStart = 0.4;
  out.nearEnd = 1.4;
  out.streak = 1;
  out.width = 1;
  out.alphaScale = 1;
  out.gain = 1;
  switch (kind) {
    case "rain":
      speed = WIND_RAIN_SPEED * s * (0.75 + 0.25 * g);
      out.nearStart = 1.2;
      out.nearEnd = 3.6;
      // 0.72 yd × 1.9: about the distance a 22 yd/s drop falls in a sixteenth of a second, which is
      // how long the eye smears a drop into a line.
      out.streak = 1.9;
      out.width = 1;
      out.alphaScale = 1.5;
      out.gain = 2.3;
      break;
    case "snow":
      speed = 0.6 + 5.4 * s * (0.6 + 0.4 * g);
      out.nearStart = 0.35;
      out.nearEnd = 1.2;
      out.streak = 1.3;
      out.width = 1.3;
      out.alphaScale = 1.35;
      out.gain = 1.1;
      break;
    case "sand":
      speed = 7 + 12 * s * (0.7 + 0.3 * g);
      out.nearStart = 2;
      out.nearEnd = 7;
      break;
    case "fog":
      speed = 0.4 + 1.6 * s;
      out.nearStart = 3;
      out.nearEnd = 9;
      break;
    case "fine":
      speed = 0;
      break;
  }
  out.windX = directionX * speed;
  out.windZ = directionZ * speed;
  return out;
}

/**
 * The sway terms run on `sin(phase * 0.7)` and `cos(phase * 0.5)`; both are periodic in 20π
 * seconds, so the clock wraps there without a jump in either.
 */
export const PRECIPITATION_SWAY_PERIOD = 20 * Math.PI;

export interface PrecipitationOffset {
  x: number;
  y: number;
  z: number;
}

/**
 * Advances the cloud's travel by one frame: `offset` gains this frame's wind on x and z and the fall
 * on y, and each is wrapped to the box it is taken modulo in the shader (the same value modulo the
 * box, so nothing moves at the wrap). Integrated on the CPU, never `velocity × time`, so a change
 * of wind changes how fast the drops drift and nothing else. Pure; tested.
 */
export function advancePrecipitationOffset(
  offset: PrecipitationOffset, windX: number, windZ: number, fall: number, step: number,
  box: Readonly<PrecipitationOffset>,
): PrecipitationOffset {
  const dt = Number.isFinite(step) ? Math.max(0, Math.min(0.25, step)) : 0;
  const wrap = (value: number, size: number): number => {
    if (!(size > 0) || !Number.isFinite(size)) return value;
    const wrapped = value % size;
    return wrapped < 0 ? wrapped + size : wrapped;
  };
  offset.x = wrap(offset.x + (Number.isFinite(windX) ? windX : 0) * dt, box.x);
  offset.y = wrap(offset.y + (Number.isFinite(fall) ? fall : 0) * dt, box.y);
  offset.z = wrap(offset.z + (Number.isFinite(windZ) ? windZ : 0) * dt, box.z);
  return offset;
}

/** The sway clock after one frame, wrapped to its period. */
export function advancePrecipitationPhase(phase: number, step: number): number {
  const dt = Number.isFinite(step) ? Math.max(0, Math.min(0.25, step)) : 0;
  return (phase + dt) % PRECIPITATION_SWAY_PERIOD;
}

/**
 * How much a drop between the eye and the sun brightens, from the sun's height above the horizon
 * (scene-space direction y) and how strong its light is (luminance of the diffuse colour). Strongest
 * for a low sun — the rainy sunset — and nothing once it has set. Pure; tested.
 */
export function rainBacklight(sunHeight: number, sunLuminance: number): number {
  const h = Number.isFinite(sunHeight) ? sunHeight : -1;
  const lum = Math.max(0, Math.min(1.5, Number.isFinite(sunLuminance) ? sunLuminance : 0));
  const up = Math.max(0, Math.min(1, (h + 0.02) / 0.1));
  const low = 1 - Math.max(0, Math.min(1, (h - 0.2) / 0.45));
  return 3.2 * up * (0.35 + 0.65 * low) * lum;
}

const VERTEX_SHADER = `
  // ${WEATHER_ENHANCED_MARKER}
  attribute vec2 corner;
  uniform vec3 uOrigin;
  uniform vec3 uBox;
  uniform vec3 uOffset;
  uniform float uPhase;
  uniform float uFall;
  uniform float uSway;
  uniform vec2 uSize;
  uniform vec2 uWind;
  uniform vec2 uNear;
  uniform float uStreak;
  uniform float uWidth;
  uniform vec3 uSun;
  varying vec2 vUv;
  varying float vFade;
  varying float vBack;
  void main() {
    // The same world-anchored wrap as the faithful cloud, but the travel is the integrated wind on
    // both horizontal axes (and the integrated fall), not a velocity times the clock: see uOffset.
    float x = mod(position.x * uBox.x + uOffset.x - uOrigin.x, uBox.x) - uBox.x * 0.5;
    float z = mod(position.z * uBox.z + uOffset.z - uOrigin.z, uBox.z) - uBox.z * 0.5;
    float y = uBox.y * 0.5 - mod(position.y * uBox.y + uOffset.y + uOrigin.y, uBox.y);
    x += sin(uPhase * 0.7 + position.y * 31.4) * uSway;
    z += cos(uPhase * 0.5 + position.x * 27.2) * uSway;
    vec4 view = modelViewMatrix * vec4(x, y, z, 1.0);
    // Aligned to the drop's own velocity (fall plus wind), so a slanted streak is slanted along
    // its motion. The quad's width is across the line from the camera to it.
    vec3 velocity = vec3(uWind.x, -max(uFall, 0.05), uWind.y);
    vec3 axis = normalize((modelViewMatrix * vec4(velocity, 0.0)).xyz);
    vec3 side = cross(axis, view.xyz);
    float sideLength = length(side);
    vec3 right = sideLength > 1e-5 ? side / sideLength : vec3(1.0, 0.0, 0.0);
    view.xyz += right * (corner.x * uSize.x * uWidth) - axis * (corner.y * uSize.y * uStreak);
    vUv = corner + vec2(0.5);
    float radial = length(vec2(x, z)) / (0.5 * min(uBox.x, uBox.z));
    vFade = (1.0 - smoothstep(0.72, 1.0, radial)) * smoothstep(uNear.x, uNear.y, -view.z);
    // The cloud sits on the camera, so (x, y, z) is already the direction from the eye.
    vBack = pow(max(dot(normalize(vec3(x, y, z) + vec3(0.0, 1e-4, 0.0)), uSun), 0.0), 6.0);
    gl_Position = projectionMatrix * view;
  }`;

const FRAGMENT_SHADER = `
  uniform sampler2D uMap;
  uniform vec3 uTint;
  uniform vec3 uLight;
  uniform float uGain;
  uniform float uOpacity;
  uniform float uAlphaScale;
  uniform float uProcedural;
  uniform float uBacklight;
  varying vec2 vUv;
  varying float vFade;
  varying float vBack;
  void main() {
    vec4 texel;
    if (uProcedural > 1.5) {
      float d = length(vUv - 0.5) * 2.0;
      texel = vec4(1.0, 1.0, 1.0, 1.0 - smoothstep(0.2, 1.0, d));
    } else if (uProcedural > 0.5) {
      float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
      texel = vec4(1.0, 1.0, 1.0, across * across * sin(vUv.y * 3.14159265));
    } else {
      texel = texture2D(uMap, vUv);
    }
    float back = 1.0 + uBacklight * vBack;
    float alpha = min(1.0, texel.a * uOpacity * uAlphaScale * vFade * (1.0 + 0.35 * uBacklight * vBack));
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(texel.rgb * uTint * uLight * uGain * back, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

/**
 * The enhanced material for the shared seed cloud. `shared` is the faithful material's uniforms
 * object: its entries are reused by reference so every value WeatherEffect writes reaches both.
 */
export function createEnhancedWeatherMaterial(
  shared: Record<string, IUniform>, extra: EnhancedWeatherUniforms,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: shared["uMap"]!,
      uOrigin: shared["uOrigin"]!,
      uBox: shared["uBox"]!,
      uFall: shared["uFall"]!,
      uSway: shared["uSway"]!,
      uSize: shared["uSize"]!,
      uTint: shared["uTint"]!,
      uOpacity: shared["uOpacity"]!,
      uWind: extra.uWind,
      uOffset: extra.uOffset,
      uPhase: extra.uPhase,
      uNear: extra.uNear,
      uStreak: extra.uStreak,
      uWidth: extra.uWidth,
      uLight: extra.uLight,
      uGain: extra.uGain,
      uAlphaScale: extra.uAlphaScale,
      uProcedural: extra.uProcedural,
      uSun: extra.uSun,
      uBacklight: extra.uBacklight,
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** One procedural layer's look for one kind of weather. */
export interface PrecipitationLayerPreset {
  /** The box the layer fills around the camera (yards): across, tall, across. */
  readonly box: readonly [number, number, number];
  /** Faded in between these view distances (yards), so it never doubles the near cloud. */
  readonly near: readonly [number, number];
  /** Quad width and length (yards). */
  readonly size: readonly [number, number];
  readonly fall: number;
  readonly sway: number;
  /** Opacity at the lightest and at the heaviest weather. */
  readonly opacity: readonly [number, number];
  /** 1: a soft streak; 2: a soft round flake. */
  readonly shape: 1 | 2;
  readonly tint: number;
  /** Share of the layer's capacity drawn at full density. */
  readonly share: number;
}

/** Thin streaks from twelve yards out to the edge of a 110-yard box: the body of a downpour. */
export const RAIN_MID_LAYER: PrecipitationLayerPreset = Object.freeze<PrecipitationLayerPreset>({
  box: [110, 44, 110], near: [9, 20], size: [0.06, 1.8], fall: 24, sway: 0.1,
  opacity: [0.3, 0.6], shape: 1, tint: 0xc3ced8, share: 1,
});
/** Long faint streaks far out: the veil over a valley or a bay. */
export const RAIN_FAR_LAYER: PrecipitationLayerPreset = Object.freeze<PrecipitationLayerPreset>({
  box: [230, 90, 230], near: [26, 60], size: [0.5, 12], fall: 26, sway: 0,
  opacity: [0.08, 0.22], shape: 1, tint: 0xb4c3cf, share: 0.22,
});
/** Soft flakes beyond the faithful cloud's forty yards, so a snowfall has depth. */
export const SNOW_MID_LAYER: PrecipitationLayerPreset = Object.freeze<PrecipitationLayerPreset>({
  box: [96, 40, 96], near: [8, 18], size: [0.16, 0.16], fall: 2.4, sway: 0.6,
  opacity: [0.5, 0.85], shape: 2, tint: 0xffffff, share: 0.6,
});

/** Quads in each procedural layer's buffer. */
export const PRECIPITATION_LAYER_CAPACITY = 5000;

/**
 * A procedural layer of rain or snow around the camera: one draw of at most
 * `PRECIPITATION_LAYER_CAPACITY` quads, only while something is falling outdoors.
 */
export class PrecipitationLayer {
  readonly object: THREE.Mesh;
  readonly #geometry: THREE.BufferGeometry;
  readonly #material: THREE.ShaderMaterial;
  readonly #uniforms: Record<string, IUniform>;
  readonly #extra: EnhancedWeatherUniforms;
  readonly #capacity: number;
  readonly #offset: PrecipitationOffset = { x: 0, y: 0, z: 0 };
  #phase = 0;

  constructor(capacity = PRECIPITATION_LAYER_CAPACITY) {
    this.#capacity = capacity;
    this.#geometry = buildWeatherGeometry(capacity);
    this.#uniforms = {
      uMap: { value: null },
      uOrigin: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(1, 1, 1) },
      uFall: { value: 0 },
      uSway: { value: 0 },
      uSize: { value: new THREE.Vector2(1, 1) },
      uTint: { value: new THREE.Color(0xffffff) },
      uOpacity: { value: 0 },
    };
    this.#extra = createEnhancedWeatherUniforms();
    this.#material = createEnhancedWeatherMaterial(this.#uniforms, this.#extra);
    this.object = new THREE.Mesh(this.#geometry, this.#material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 4;
    this.object.visible = false;
  }

  get geometry(): THREE.BufferGeometry { return this.#geometry; }
  get material(): THREE.ShaderMaterial { return this.#material; }
  /** Quads drawn this frame. */
  get drawn(): number { return this.object.visible ? (this.#geometry.drawRange.count / 6) : 0; }

  /**
   * `preset` undefined (or `density` 0) hides the layer. `windX/Z` is the precipitation's horizontal
   * velocity, `light` the scene light multiplier, `sun` the scene-space sun direction with its
   * `backlight` strength, `quality` 0.25..1 scales the count.
   */
  update(
    camera: THREE.Vector3, elapsed: number, preset: PrecipitationLayerPreset | undefined, density: number,
    windX: number, windZ: number, light: THREE.Color, sun: THREE.Vector3, backlight: number, quality: number,
  ): void {
    const d = Math.max(0, Math.min(1, Number.isFinite(density) ? density : 0));
    if (!preset || d <= 0) {
      this.object.visible = false;
      this.#geometry.setDrawRange(0, 0);
      return;
    }
    const u = this.#uniforms;
    const x = this.#extra;
    const box = (u["uBox"]!.value as THREE.Vector3).set(preset.box[0], preset.box[1], preset.box[2]);
    advancePrecipitationOffset(this.#offset, windX, windZ, preset.fall, elapsed, box);
    this.#phase = advancePrecipitationPhase(this.#phase, elapsed);
    x.uOffset.value.set(this.#offset.x, this.#offset.y, this.#offset.z);
    x.uPhase.value = this.#phase;
    (u["uOrigin"]!.value as THREE.Vector3).copy(camera);
    (u["uSize"]!.value as THREE.Vector2).set(preset.size[0], preset.size[1]);
    (u["uTint"]!.value as THREE.Color).setHex(preset.tint);
    u["uFall"]!.value = preset.fall;
    u["uSway"]!.value = preset.sway;
    u["uOpacity"]!.value = preset.opacity[0] + (preset.opacity[1] - preset.opacity[0]) * d;
    x.uWind.value.set(windX, windZ);
    x.uNear.value.set(preset.near[0], preset.near[1]);
    x.uProcedural.value = preset.shape;
    x.uLight.value.copy(light);
    x.uSun.value.copy(sun);
    x.uBacklight.value = backlight;
    // Denser weather adds drops faster than it thickens them: most of a downpour's look is count.
    const count = Math.round(this.#capacity * preset.share * Math.pow(d, 0.8)
      * Math.max(0.25, Math.min(1, quality)));
    this.#geometry.setDrawRange(0, count * 6);
    this.object.position.copy(camera);
    this.object.visible = count > 0;
  }

  reset(): void {
    this.#offset.x = 0;
    this.#offset.y = 0;
    this.#offset.z = 0;
    this.#phase = 0;
    this.#extra.uOffset.value.set(0, 0, 0);
    this.#extra.uPhase.value = 0;
    this.object.visible = false;
    this.#geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.object.visible = false;
    this.#uniforms["uMap"]!.value = null;
    this.#geometry.dispose();
    this.#material.dispose();
  }
}
