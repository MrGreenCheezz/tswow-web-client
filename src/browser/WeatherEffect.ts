/**
 * What falls out of the sky: rain, snow, blown sand and fog.
 *
 * Deliberately not the R1 particle system. That one is a faithful simulation of an M2 emitter and
 * is driven by `WvmParticleEmitter` records read out of a model file — to reuse it here a model
 * would have to be fabricated around one synthetic emitter, its capacity of 256 raised for
 * everything in the client at once, and the result put into a distance-ranked budget of 32 sets
 * where a brazier could evict the weather. Every one of those is a change to code that thirty
 * thousand real emitters depend on, in order to compute a constant colour and a constant size
 * eleven track samples at a time.
 *
 * So this is its own thing, and it is small because all of the motion is in the vertex shader:
 * a fixed cloud of quads, two uniforms written per frame, and the count changed by the draw range
 * rather than by rebuilding anything. Intensity is therefore free.
 *
 * The cloud is anchored on the camera, but the drops are not: each one's position is taken modulo
 * the box *after* the camera's own position is subtracted, so walking through rain moves the rain
 * past you and only wraps a drop when it leaves the box.
 */

import * as THREE from "three";
import type { WeatherKind } from "../world/WorldMessageProtocol.js";

/**
 * The five weather textures the client ships, and it ships exactly five:
 * `RainDrop01`, `RainDropSplash01`, `Snowflake01`, `SNOWMIST01` and `WEATHERMISTGRAINY01`.
 * There is no sand texture and no fog texture of its own — the two mists are what the original
 * uses for both, and the splash is for the ground, which this does not draw.
 */
export const RAIN_TEXTURE = "textures\\WEATHER\\RainDrop01.blp";
export const SNOW_TEXTURE = "textures\\WEATHER\\Snowflake01.blp";
export const SAND_TEXTURE = "textures\\WEATHER\\WEATHERMISTGRAINY01.BLP";
export const FOG_TEXTURE = "textures\\WEATHER\\SNOWMIST01.BLP";

export interface WeatherPreset {
  texture: string;
  /** Yards. `RainDrop01` is 16×128, which is why a drop is a streak and a flake is a square. */
  width: number;
  height: number;
  /** Yards per second, downwards. */
  fall: number;
  /** Yards per second, sideways — what makes sand a storm rather than a slow fall. */
  drift: number;
  /** Yards of wander around that line. */
  sway: number;
  /** The box the cloud fills: how wide across, and how tall. */
  spread: number;
  ceiling: number;
  /** How many quads at full density. */
  maxCount: number;
  opacity: number;
  tint: number;
}

/**
 * How each kind falls.
 *
 * The counts are the visible half of the slice's cost and are the numbers most likely to move: a
 * raindrop is three pixels wide and a sand mote is a sixth of the screen, so they are not the same
 * budget at all. Slice R8 is where they stop being flat.
 */
export const WEATHER_PRESETS: Record<Exclude<WeatherKind, "fine">, WeatherPreset> = {
  rain: {
    texture: RAIN_TEXTURE,
    width: 0.09, height: 0.72, fall: 22, drift: 1.4, sway: 0.12,
    spread: 46, ceiling: 26, maxCount: 2200, opacity: 0.55, tint: 0xa9bcca,
  },
  snow: {
    texture: SNOW_TEXTURE,
    width: 0.15, height: 0.15, fall: 2.4, drift: 0.7, sway: 0.55,
    spread: 40, ceiling: 22, maxCount: 1400, opacity: 0.85, tint: 0xffffff,
  },
  sand: {
    texture: SAND_TEXTURE,
    width: 6, height: 4, fall: 1.1, drift: 15, sway: 1.4,
    spread: 72, ceiling: 30, maxCount: 260, opacity: 0.3, tint: 0xc9a86e,
  },
  fog: {
    texture: FOG_TEXTURE,
    width: 20, height: 14, fall: 0.1, drift: 1.2, sway: 1.1,
    spread: 80, ceiling: 26, maxCount: 110, opacity: 0.22, tint: 0xd7dde4,
  },
};

/** The largest cloud any preset asks for, which is the one buffer that gets built. */
export const WEATHER_CAPACITY = Math.max(...Object.values(WEATHER_PRESETS).map((preset) => preset.maxCount));

/** How long a weather takes to arrive or leave, in seconds. */
export const WEATHER_FADE_SECONDS = 5;

export interface WeatherFade {
  /** What is being drawn now. Lags the target across a change of kind, because it fades out first. */
  kind: WeatherKind;
  /** How much of the maximum is falling, 0 to 1. */
  density: number;
  /** How far the storm sky has rolled in, 0 to 1. */
  storm: number;
}

/**
 * How thick the weather is, from the packet.
 *
 * The intensity is the same number the server derived the state from: below 0.27 it sends `FINE`,
 * and the three rains split at 0.40 and 0.70. So reading it linearly agrees with the state rather
 * than contradicting it, and the floor is there because the lightest weather the server can send
 * still has to be visible.
 *
 * Fog is the exception, and not by taste: both scripts in this core that call for it —
 * the Trial of the Crusader and Icecrown Citadel — call for it with an intensity of exactly zero.
 */
export function weatherDensity(kind: WeatherKind, intensity: number): number {
  if (kind === "fine") return 0;
  const clamped = Math.max(0, Math.min(1, intensity));
  if (kind === "fog") return Math.max(0.6, clamped);
  return Math.max(0.15, clamped);
}

/**
 * Moves what is drawn towards what the server asked for.
 *
 * A change of kind fades the old one out before the new one starts, because rain crossfading into
 * snow is two clouds and one texture. The storm sky does not follow that dip: it is driven by the
 * target and not by what is on screen, so a zone that goes from rain to snow does not brighten in
 * the middle of the change.
 *
 * `abrupt` is the packet's own flag, and it exists for the moment the player zones in. Without it
 * the first five seconds in a rainy zone are a clear sky dissolving into rain, which is the one
 * thing the flag is there to prevent.
 */
export function advanceWeather(
  shown: WeatherFade,
  target: { kind: WeatherKind; density: number },
  elapsed: number,
  abrupt = false,
): WeatherFade {
  const stormTarget = target.kind === "fine" ? 0 : target.density;
  if (abrupt) return { kind: target.kind, density: target.density, storm: stormTarget };
  const step = (Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0) / WEATHER_FADE_SECONDS;
  const towards = (from: number, to: number) =>
    from < to ? Math.min(to, from + step) : Math.max(to, from - step);
  const storm = towards(shown.storm, stormTarget);
  // Nothing on screen means nothing to fade out, so the new kind is adopted and the same call
  // spends its time fading it *in*. Without this, going from clear weather to rain spent its whole
  // first step switching a kind that had no particles behind it, and the rain arrived a step late
  // — which at a five-second fade and one call per frame is most of a second of nothing.
  if (shown.kind === target.kind || shown.density <= 0) {
    return { kind: target.kind, density: towards(shown.density, target.density), storm };
  }
  const density = towards(shown.density, 0);
  return density <= 0
    ? { kind: target.kind, density: 0, storm }
    : { kind: shown.kind, density, storm };
}

/**
 * The cloud, built once at the largest capacity any preset asks for.
 *
 * `position` is not a position: it is the particle's seed, three numbers in 0..1 that decide where
 * in the box it sits and how far through its fall it starts. The shader turns it into a place. It
 * is called `position` because three wants an attribute of that name to size a draw and to build a
 * bounding sphere, and giving it a second name for the same buffer would only be a second name.
 */
export function buildWeatherGeometry(capacity = WEATHER_CAPACITY): THREE.BufferGeometry {
  const seeds = new Float32Array(capacity * 4 * 3);
  const corners = new Float32Array(capacity * 4 * 2);
  const indices = new Uint32Array(capacity * 6);
  // A fixed hash rather than a random number: the cloud has to be the same one every session, or
  // a reload is a visibly different rain, and the tests could not assert anything about it.
  let state = 0x9e3779b1;
  const next = () => {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x1b873593) >>> 0;
    return (state >>> 8) / 0x1000000;
  };
  const cornerX = [-0.5, 0.5, 0.5, -0.5];
  const cornerY = [-0.5, -0.5, 0.5, 0.5];
  for (let particle = 0; particle < capacity; particle++) {
    const sx = next();
    const sy = next();
    const sz = next();
    for (let corner = 0; corner < 4; corner++) {
      const vertex = particle * 4 + corner;
      seeds[vertex * 3] = sx;
      seeds[vertex * 3 + 1] = sy;
      seeds[vertex * 3 + 2] = sz;
      corners[vertex * 2] = cornerX[corner]!;
      corners[vertex * 2 + 1] = cornerY[corner]!;
    }
    const base = particle * 4;
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], particle * 6);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(seeds, 3));
  geometry.setAttribute("corner", new THREE.BufferAttribute(corners, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, 0);
  return geometry;
}

/** How many indices to draw for a density, rounded to whole quads. */
export function weatherDrawCount(preset: WeatherPreset, density: number, capacity = WEATHER_CAPACITY): number {
  const wanted = Math.round(Math.max(0, Math.min(1, density)) * preset.maxCount);
  return Math.min(wanted, capacity) * 6;
}

const VERTEX_SHADER = `
  attribute vec2 corner;
  uniform vec3 uOrigin;
  uniform vec3 uBox;
  uniform float uTime;
  uniform float uFall;
  uniform float uDrift;
  uniform float uSway;
  uniform vec2 uSize;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    // The camera's own position is subtracted before the wrap, so the box travels with the camera
    // while the drops inside it stand still in the world.
    float x = mod(position.x * uBox.x + uDrift * uTime - uOrigin.x, uBox.x) - uBox.x * 0.5;
    float z = mod(position.z * uBox.z - uOrigin.z, uBox.z) - uBox.z * 0.5;
    float y = uBox.y * 0.5 - mod(position.y * uBox.y + uFall * uTime + uOrigin.y, uBox.y);
    x += sin(uTime * 0.7 + position.y * 31.4) * uSway;
    z += cos(uTime * 0.5 + position.x * 27.2) * uSway;
    vec4 view = modelViewMatrix * vec4(x, y, z, 1.0);
    // Upright rather than screen-aligned: a raindrop is a streak, and a streak that rolls with the
    // camera reads as a scratch on the lens. World up in view space, and the quad's width across
    // the line from the camera to it.
    vec3 up = normalize((modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    vec3 right = normalize(cross(up, view.xyz));
    view.xyz += right * (corner.x * uSize.x) + up * (corner.y * uSize.y);
    vUv = corner + vec2(0.5);
    // Faded towards the wall of the box, so nothing appears or vanishes at a hard edge.
    float radial = length(vec2(x, z)) / (0.5 * min(uBox.x, uBox.z));
    vFade = 1.0 - smoothstep(0.72, 1.0, radial);
    gl_Position = projectionMatrix * view;
  }`;

const FRAGMENT_SHADER = `
  uniform sampler2D uMap;
  uniform vec3 uTint;
  uniform float uOpacity;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    vec4 texel = texture2D(uMap, vUv);
    float alpha = texel.a * uOpacity * vFade;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(texel.rgb * uTint, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

/**
 * One cloud over the camera, whatever the weather happens to be.
 *
 * One mesh and one material for every kind, because only one kind falls at a time: the texture and
 * the uniforms are swapped, and the geometry — the expensive part — is never rebuilt.
 */
export class WeatherEffect {
  readonly object: THREE.Mesh;
  readonly #material: THREE.ShaderMaterial;
  readonly #geometry: THREE.BufferGeometry;
  readonly #textures = new Map<string, THREE.Texture>();
  readonly #load: (path: string) => THREE.Texture | undefined;
  #clock = 0;
  #kind: WeatherKind = "fine";

  constructor(load: (path: string) => THREE.Texture | undefined) {
    this.#load = load;
    this.#geometry = buildWeatherGeometry();
    this.#material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: null },
        uOrigin: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(1, 1, 1) },
        uTime: { value: 0 },
        uFall: { value: 0 },
        uDrift: { value: 0 },
        uSway: { value: 0 },
        uSize: { value: new THREE.Vector2(1, 1) },
        uTint: { value: new THREE.Color(0xffffff) },
        uOpacity: { value: 0 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      // Ordinary alpha, not additive: the raindrop's texture is opaque where it is drawn and the
      // flake's peaks at two thirds, so adding them to the sky would make grey rain glow.
      blending: THREE.NormalBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.object = new THREE.Mesh(this.#geometry, this.#material);
    // No bounding volume worth having: `position` is a seed and the cloud is wherever the camera
    // is. Drawn after the world's own particles so a torch is not painted over the rain in front
    // of it, and before nothing.
    this.object.frustumCulled = false;
    this.object.renderOrder = 4;
    this.object.visible = false;
  }

  /** Whatever is falling this frame, and how much of it. */
  set(fade: WeatherFade, tinted: boolean): void {
    if (fade.kind === "fine" || fade.density <= 0) {
      this.object.visible = false;
      this.#geometry.setDrawRange(0, 0);
      return;
    }
    const preset = WEATHER_PRESETS[fade.kind];
    if (this.#kind !== fade.kind) {
      this.#kind = fade.kind;
      const texture = this.#texture(preset.texture);
      this.#material.uniforms["uMap"]!.value = texture ?? null;
    }
    // No wait for the texture to arrive: `TextureLoader.load` hands back the `Texture` object at
    // once and fills it in later, so there is never a frame where this is missing. A download that
    // fails leaves it empty, three binds its 1×1 transparent stand-in, and every fragment is
    // discarded by the alpha gate below — invisible rather than a screenful of white squares.
    const uniforms = this.#material.uniforms;
    (uniforms["uBox"]!.value as THREE.Vector3).set(preset.spread, preset.ceiling, preset.spread);
    (uniforms["uSize"]!.value as THREE.Vector2).set(preset.width, preset.height);
    uniforms["uFall"]!.value = preset.fall;
    uniforms["uDrift"]!.value = preset.drift;
    uniforms["uSway"]!.value = preset.sway;
    uniforms["uOpacity"]!.value = preset.opacity;
    // Black rain and black snow are the ordinary two with the light taken out of them. They are
    // the only two states that tint, and both of them come from a script rather than the timer.
    (uniforms["uTint"]!.value as THREE.Color).setHex(tinted ? 0x39373f : preset.tint);
    this.#geometry.setDrawRange(0, weatherDrawCount(preset, fade.density));
    this.object.visible = true;
  }

  /** One frame: the clock the fall runs on, and where the box has to be. */
  update(cameraPosition: THREE.Vector3, seconds: number): void {
    this.#clock += Math.max(0, seconds);
    this.#material.uniforms["uTime"]!.value = this.#clock;
    (this.#material.uniforms["uOrigin"]!.value as THREE.Vector3).copy(cameraPosition);
    this.object.position.copy(cameraPosition);
  }

  #texture(path: string): THREE.Texture | undefined {
    const cached = this.#textures.get(path);
    if (cached) return cached;
    const loaded = this.#load(path);
    if (loaded) this.#textures.set(path, loaded);
    return loaded;
  }

  dispose(): void {
    this.#geometry.dispose();
    this.#material.dispose();
    for (const texture of this.#textures.values()) texture.dispose();
    this.#textures.clear();
  }
}
