/**
 * Small life in the air (`experimentalAmbientMotes`): dust and pollen glinting in the sun by day,
 * fireflies over meadows and forests at night, and leaves drifting down where trees stand.
 *
 * Pollen is an occasional sight, not a filter over the world: it needs a sunlit open meadow or
 * clearing, it is strongest in the low sun of morning and evening, and it drifts through in
 * patches — `moteDustPatch` opens and closes a window over time and across the map (the owner
 * found it lovely but far too constant), and inside the box the motes gather into slowly drifting
 * clumps rather than filling the air evenly.
 *
 * Three GPU point clouds in the style of WeatherEffect: fixed seeds, camera-anchored boxes whose
 * contents stand still in the world (the camera is subtracted before the wrap), all motion in the
 * vertex shader, and the visible count set by the draw range. The CPU decides only how much of
 * each layer the moment calls for — from daylight, vegetation around the character, rain and
 * wind — and eases towards it.
 */

import * as THREE from "three";
import type { IUniform } from "three";

export const MOTE_DUST_CAPACITY = 360;
export const MOTE_FIREFLY_CAPACITY = 140;
export const MOTE_LEAF_CAPACITY = 110;

export type MoteLayerKind = "dust" | "firefly" | "leaf";

export interface MoteConditions {
  /** 0 night … 1 day (WorldLighting's smoothed daylight). */
  daylight: number;
  /** 0 … 1: grass and flowers around the character. */
  meadow: number;
  /** 0 … 1: trees around the character. */
  forest: number;
  /** 0 … 1 of falling weather on screen (any kind). */
  precipitation: number;
  /** Whether the falling weather is snow (no leaves, no fireflies). */
  snowing: boolean;
  /** 0 … 1 wind strength. */
  wind: number;
  outdoors: boolean;
  /** Scene-space sun direction's height, -1 … 1 (below 0 the sun has set). */
  sunHeight: number;
  /** 0 … 1: whether a drifting patch of pollen is passing (`moteDustPatch`). */
  patch: number;
}

export interface MoteAmounts { dust: number; firefly: number; leaf: number }

/** How much of each layer the moment calls for, 0..1 each. Pure; tested. */
export function moteAmounts(c: MoteConditions, out: MoteAmounts): MoteAmounts {
  const clamp = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  const day = clamp(c.daylight);
  const dry = 1 - clamp(c.precipitation);
  const outdoors = c.outdoors ? 1 : 0;
  const green = Math.max(clamp(c.meadow), clamp(c.forest));
  // Pollen: a sunlit open meadow or clearing, while a drifting patch passes. Dense forest shades it
  // and bare ground, cities and deserts have none. Strongest in the low sun of morning and evening,
  // a trace at noon; rain washes it out.
  const sun = Number.isFinite(c.sunHeight) ? c.sunHeight : 1;
  const sunlit = clamp((day - 0.35) / 0.4) * clamp((sun - 0.02) / 0.1);
  const golden = 1 - clamp((sun - 0.22) / 0.4);
  const open = clamp((clamp(c.meadow) - 0.25) / 0.45) * (1 - 0.5 * clamp((clamp(c.forest) - 0.75) / 0.25));
  out.dust = outdoors * dry * sunlit * open * clamp(c.patch) * (0.4 + 0.6 * golden);
  // Fireflies: dusk into night, only over vegetation, never in rain or snow.
  out.firefly = outdoors * clamp((0.55 - day) / 0.4) * green * dry * (c.snowing ? 0 : 1);
  // Leaves need trees; wind shakes more loose. Snow means bare branches.
  out.leaf = outdoors * clamp(c.forest) * (0.35 + 0.65 * clamp(c.wind)) * (c.snowing ? 0 : 1)
    * (1 - 0.5 * clamp(c.precipitation));
  return out;
}

/**
 * Whether a drifting patch of pollen is passing, 0..1, at frame-clock `seconds` and scene-space
 * position (x, z). Three incommensurate slow waves over time and across the map: measured over ten
 * simulated hours it is open about a fifth of the time, in visits of roughly 25 seconds (6..40),
 * and most minutes see a patch arrive or leave. Deterministic and allocation-free; tested.
 */
export function moteDustPatch(seconds: number, x: number, z: number): number {
  const t = Number.isFinite(seconds) ? seconds : 0;
  const px = Number.isFinite(x) ? x : 0;
  const pz = Number.isFinite(z) ? z : 0;
  const v = 0.55 * Math.sin(t * 0.07 + px * 0.011 + 1.3)
    + 0.3 * Math.sin(t * 0.031 - pz * 0.013 + 4.2)
    + 0.15 * Math.sin(t * 0.17 + (px + pz) * 0.009 + 0.7);
  const k = Math.max(0, Math.min(1, (v - 0.28) / 0.3));
  return k * k * (3 - 2 * k);
}

const COMMON_VERTEX = `
  uniform vec3 uOrigin;
  uniform vec3 uBox;
  uniform vec3 uWind;
  uniform vec3 uSun;
  uniform float uTime;
  uniform float uSize;
  uniform float uPixelScale;
  uniform float uFeetY;
  varying float vAlpha;
  varying vec3 vSeed;
  varying float vSpin;
  float moteWrap( float seed, float extent, float offset ) {
    return mod( seed * extent + offset, extent ) - extent * 0.5;
  }
`;

const VERTEX_BODY: Record<MoteLayerKind, string> = {
  dust: `
    float t = uTime;
    vec3 p;
    p.x = moteWrap( position.x, uBox.x, uWind.x * t - uOrigin.x );
    p.z = moteWrap( position.z, uBox.z, uWind.z * t - uOrigin.z );
    p.y = moteWrap( position.y, uBox.y, 0.12 * t - uOrigin.y );
    p += vec3( sin( t * 0.31 + position.y * 40.0 ), 0.5 * sin( t * 0.23 + position.z * 37.0 ),
      cos( t * 0.27 + position.x * 29.0 ) ) * 0.45;
    vec3 toMote = normalize( p + vec3( 1e-4 ) );
    float phase = 0.5 + 1.8 * pow( max( dot( toMote, normalize( uSun ) ), 0.0 ), 6.0 );
    float twinkle = 0.55 + 0.45 * sin( t * ( 1.3 + 2.0 * position.x ) + position.z * 61.0 );
    // Clumps ~15 yd across that drift slowly through the box, so pollen hangs in the air in places
    // rather than filling it evenly. World position, so the clumps stay put as the camera moves.
    vec3 w = p + uOrigin;
    float clump = 0.5 + 0.5 * sin( w.x * 0.21 + t * 0.05 ) * sin( w.z * 0.17 - t * 0.04 + 1.3 );
    vAlpha = phase * twinkle * smoothstep( 0.35, 0.8, clump );
  `,
  firefly: `
    float t = uTime;
    vec3 p;
    vec3 wander = vec3( sin( t * 0.21 + position.y * 23.0 ) + 0.5 * sin( t * 0.53 + position.x * 11.0 ),
      0.0, cos( t * 0.17 + position.x * 19.0 ) + 0.5 * cos( t * 0.47 + position.z * 13.0 ) ) * 1.6;
    p.x = moteWrap( position.x, uBox.x, -uOrigin.x ) + wander.x;
    p.z = moteWrap( position.z, uBox.z, -uOrigin.z ) + wander.z;
    p.y = uFeetY - uOrigin.y + 0.25 + position.y * 2.4 + 0.35 * sin( t * 0.7 + position.z * 17.0 );
    float blink = sin( t * ( 0.55 + 0.6 * position.x ) + position.z * 60.0 );
    vAlpha = smoothstep( 0.15, 0.9, blink );
  `,
  leaf: `
    float t = uTime;
    vec3 p;
    float fall = 0.55 + 0.35 * position.x;
    float band = 11.0;
    float drop = mod( position.y * band + fall * t, band );
    float sway = sin( t * ( 1.1 + position.z ) + position.x * 30.0 );
    p.x = moteWrap( position.x, uBox.x, uWind.x * t - uOrigin.x ) + sway * 0.7;
    p.z = moteWrap( position.z, uBox.z, uWind.z * t - uOrigin.z ) + cos( t * 0.9 + position.y * 21.0 ) * 0.5;
    p.y = uFeetY - uOrigin.y + 9.5 - drop;
    vSpin = t * ( 1.5 + 2.5 * position.z ) + position.x * 40.0;
    // Fade in high in the canopy and out as it reaches the ground.
    vAlpha = smoothstep( 0.0, 1.5, drop ) * ( 1.0 - smoothstep( band - 1.6, band - 0.2, drop ) );
  `,
};

const VERTEX_TAIL = `
    vSeed = position;
    vec4 view = modelViewMatrix * vec4( p, 1.0 );
    float depth = max( -view.z, 0.05 );
    float radial = length( p.xz ) / ( 0.5 * min( uBox.x, uBox.z ) );
    vAlpha *= ( 1.0 - smoothstep( 0.7, 1.0, radial ) ) * smoothstep( 0.4, 1.6, depth );
    gl_PointSize = clamp( uSize * uPixelScale / depth, 1.5, 48.0 );
    gl_Position = projectionMatrix * view;
  }`;

const FRAGMENT: Record<MoteLayerKind, string> = {
  dust: `
    uniform vec3 uColour;
    uniform float uAmount;
    varying float vAlpha;
    void main() {
      float d = length( gl_PointCoord - 0.5 ) * 2.0;
      float a = min( 1.0, ( 1.0 - smoothstep( 0.15, 1.0, d ) ) * vAlpha * uAmount * 1.4 );
      if ( a < 0.004 ) discard;
      gl_FragColor = vec4( uColour, a );
    }`,
  firefly: `
    uniform vec3 uColour;
    uniform float uAmount;
    varying float vAlpha;
    void main() {
      float d = length( gl_PointCoord - 0.5 ) * 2.0;
      float core = 1.0 - smoothstep( 0.0, 0.3, d );
      float halo = 1.0 - smoothstep( 0.1, 1.0, d );
      float a = min( 1.0, ( core + 0.6 * halo * halo ) * vAlpha * uAmount );
      if ( a < 0.004 ) discard;
      gl_FragColor = vec4( uColour * 1.8, a );
    }`,
  leaf: `
    uniform vec3 uColour;
    uniform vec3 uLight;
    uniform float uAmount;
    varying float vAlpha;
    varying vec3 vSeed;
    varying float vSpin;
    void main() {
      vec2 q = gl_PointCoord - 0.5;
      float c = cos( vSpin );
      float s = sin( vSpin );
      q = vec2( c * q.x - s * q.y, s * q.x + c * q.y );
      // Tumbling: the leaf's width breathes as it turns over.
      float width = 0.12 + 0.2 * abs( sin( vSpin * 0.7 ) );
      float shape = ( q.x * q.x ) / 0.2 + ( q.y * q.y ) / ( width * width );
      if ( shape > 1.0 ) discard;
      vec3 autumn = mix( vec3( 0.36, 0.42, 0.14 ), vec3( 0.62, 0.42, 0.12 ), vSeed.z );
      vec3 colour = mix( autumn, uColour, 0.35 ) * uLight * ( 0.8 + 0.2 * sign( sin( vSpin * 0.7 ) ) );
      float a = vAlpha * uAmount * ( 1.0 - smoothstep( 0.7, 1.0, shape ) * 0.6 );
      if ( a < 0.01 ) discard;
      gl_FragColor = vec4( colour, a );
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

function seedGeometry(capacity: number, salt: number): THREE.BufferGeometry {
  const seeds = new Float32Array(capacity * 3);
  let state = (0x51ed27 ^ salt) >>> 0;
  for (let i = 0; i < seeds.length; i++) {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x1b873593) >>> 0;
    seeds[i] = (state >>> 8) / 0x1000000;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(seeds, 3));
  geometry.setDrawRange(0, 0);
  return geometry;
}

interface MoteLayer {
  readonly kind: MoteLayerKind;
  readonly capacity: number;
  readonly points: THREE.Points;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.ShaderMaterial;
  readonly uniforms: Record<string, IUniform>;
  shown: number;
}

const LAYER_BOX: Record<MoteLayerKind, readonly [number, number, number]> = {
  dust: [30, 12, 30],
  firefly: [40, 4, 40],
  leaf: [34, 12, 34],
};
const LAYER_SIZE: Record<MoteLayerKind, number> = { dust: 0.06, firefly: 0.24, leaf: 0.18 };

export class AmbientMotes {
  readonly group = new THREE.Group();
  readonly #layers: MoteLayer[] = [];
  readonly #target: MoteAmounts = { dust: 0, firefly: 0, leaf: 0 };
  #clock = 0;

  constructor() {
    const kinds: readonly [MoteLayerKind, number][] = [
      ["dust", MOTE_DUST_CAPACITY], ["firefly", MOTE_FIREFLY_CAPACITY], ["leaf", MOTE_LEAF_CAPACITY],
    ];
    let salt = 1;
    for (const [kind, capacity] of kinds) {
      const geometry = seedGeometry(capacity, salt++ * 0x9e3779b1);
      const box = LAYER_BOX[kind];
      const uniforms: Record<string, IUniform> = {
        uOrigin: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(box[0], box[1], box[2]) },
        uWind: { value: new THREE.Vector3() },
        uSun: { value: new THREE.Vector3(0, 1, 0) },
        uTime: { value: 0 },
        uSize: { value: LAYER_SIZE[kind] },
        uPixelScale: { value: 500 },
        uFeetY: { value: 0 },
        uColour: { value: new THREE.Color(kind === "firefly" ? 0xc8ff5a : kind === "leaf" ? 0x8a7a3a : 0xfff0c8) },
        uLight: { value: new THREE.Color(1, 1, 1) },
        uAmount: { value: 0 },
      };
      const additive = kind !== "leaf";
      const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: `${COMMON_VERTEX}\n  void main() {\n${VERTEX_BODY[kind]}\n${VERTEX_TAIL}`,
        fragmentShader: FRAGMENT[kind],
        transparent: true,
        depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      const points = new THREE.Points(geometry, material);
      points.frustumCulled = false;
      points.renderOrder = 4;
      points.visible = false;
      this.group.add(points);
      this.#layers.push({ kind, capacity, points, geometry, material, uniforms, shown: 0 });
    }
  }

  get layers(): readonly { readonly kind: MoteLayerKind; readonly points: THREE.Points; readonly shown: number }[] {
    return this.#layers;
  }

  /**
   * One frame. `camera`/`feetY` in scene space; `sunDirection` scene-space towards the sun;
   * `sunColour`/`light` linear colours; `pixelScale` = projection[1][1] × half the drawing-buffer
   * height; `quality` 0.25..1 scales counts.
   */
  update(
    camera: THREE.Vector3, feetY: number, elapsed: number, conditions: MoteConditions,
    windX: number, windZ: number, sunDirection: THREE.Vector3, sunColour: THREE.Color,
    light: THREE.Color, pixelScale: number, quality: number,
  ): void {
    const step = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.25, elapsed)) : 0;
    this.#clock += step;
    moteAmounts(conditions, this.#target);
    const ease = 1 - Math.exp(-step / 2.5);
    const q = Math.max(0.25, Math.min(1, quality));
    for (const layer of this.#layers) {
      const target = this.#target[layer.kind];
      layer.shown += (target - layer.shown) * ease;
      if (layer.shown < 0.003 && target <= 0) layer.shown = 0;
      // Dust is drawn at its own amount; the other two reach their full count a little early.
      const boost = layer.kind === "dust" ? 1 : 1.4;
      const count = Math.round(layer.capacity * Math.min(1, layer.shown * boost) * q);
      if (count <= 0) {
        layer.points.visible = false;
        layer.geometry.setDrawRange(0, 0);
        continue;
      }
      const u = layer.uniforms;
      (u["uOrigin"]!.value as THREE.Vector3).copy(camera);
      u["uTime"]!.value = this.#clock;
      u["uFeetY"]!.value = feetY;
      u["uPixelScale"]!.value = pixelScale;
      u["uAmount"]!.value = Math.min(1, layer.shown * 1.2);
      const windScale = layer.kind === "dust" ? 0.35 : layer.kind === "leaf" ? 0.9 : 0;
      (u["uWind"]!.value as THREE.Vector3).set(windX * windScale, 0, windZ * windScale);
      (u["uSun"]!.value as THREE.Vector3).copy(sunDirection);
      if (layer.kind === "dust") {
        (u["uColour"]!.value as THREE.Color).copy(sunColour).multiplyScalar(0.8).addScalar(0.15);
      } else if (layer.kind === "leaf") {
        (u["uLight"]!.value as THREE.Color).copy(light);
      }
      layer.points.position.copy(camera);
      layer.geometry.setDrawRange(0, count);
      layer.points.visible = true;
    }
  }

  reset(): void {
    this.#clock = 0;
    for (const layer of this.#layers) {
      layer.shown = 0;
      layer.points.visible = false;
      layer.geometry.setDrawRange(0, 0);
    }
  }

  dispose(): void {
    for (const layer of this.#layers) {
      layer.points.visible = false;
      layer.geometry.dispose();
      layer.material.dispose();
    }
  }
}
