import * as THREE from "three";
import "./ShapedFogChunk.js"; // the stock fog chunks this material includes call `wowFogFactor`; installed on import
import type { ZoneTerrainProbe } from "./ZoneAtmosphereKinds.js";

/**
 * 7.40 «Атмосфера зон»: low mist round the player — three soft sheets laid over the ground and the water, each a few
 * yards higher than the one below, drawn with drifting noise. Not in Wow.exe; the enhanced levels only.
 *
 * The sheets follow the surface (the ground, or terrain liquid above it) on a 33 × 33 grid four yards apart, rebuilt
 * when the player crosses an eight-yard cell. Each vertex carries what the ground there is: how far it lies below
 * the ground round it (a hollow), inland water, ocean. The kinds' densities (`MistKinds`) weigh those, so a marsh's
 * mist pools in the hollows and over the water, a coast's lies over the sea, blown snow covers everything and a
 * forest's thin evening mist keeps to the low ground. A sheet is seen only from above (a lid seen from under it reads
 * as a ceiling), fades out at the grid's rim and right at the camera, and takes the scene's own fog, so far mist
 * melts into the zone's distance.
 */

/** Vertices per side and their spacing (yards): a 128-yard square. */
export const MIST_GRID = 33;
export const MIST_SPACING = 4;
/** The grid is rebuilt when its centre would move by this much (yards). */
export const MIST_SNAP = 8;
/** Sheet heights above the surface (yards), lowest first. */
export const MIST_LAYERS = 6;
/** Follow-up 15.11: six thin sheets 0.35–2.6 yd up instead of three, each fainter than the one below, so where they
 * pass a trunk or a wall the mist thins in small steps instead of ending on one edge. */
export const MIST_LAYER_HEIGHTS: readonly number[] = Object.freeze(
  Array.from({ length: MIST_LAYERS }, (_, layer) => 0.35 + 0.45 * layer));
/** Each sheet's share of the mist: falls off with height (the particles' soft ground, upside down). */
export function mistLayerWeight(layer: number): number {
  const t = 1 - layer / MIST_LAYERS;
  return t * Math.sqrt(t);
}
/** Box half-width (vertices) of the mean the hollows are measured against: 12 yards. */
const HOLLOW_RADIUS = 3;

/** The map file's liquid flags (Water.ts). */
const LIQUID_OCEAN = 0x02;

/** Per-kind density 0..~2 this frame (already times the setting's strength, the hour and the weather). */
export interface MistKinds {
  marsh: number;
  coast: number;
  cold: number;
  forest: number;
}

export interface MistFrame {
  /** Scene-space position the grid is centred on (the character's feet). */
  readonly centre: THREE.Vector3;
  readonly probe: ZoneTerrainProbe | undefined;
  readonly kinds: Readonly<MistKinds>;
  readonly seconds: number;
  /** Wind drift in yards per second, scene x and z. */
  readonly windX: number;
  readonly windZ: number;
  /** Linear colours: the light the mist is lit by, the sun's, and the scene-space direction to the sun. */
  readonly light: THREE.Color;
  readonly sunColour: THREE.Color;
  readonly sunDirection: THREE.Vector3;
  /** How much the low sun lights the mist from behind (0 at night or noon-overhead, 1 at a golden hour). */
  readonly glow: number;
}

/** Hollowness 0..1 of a ground height below the mean round it (yards). Pure; tested. */
export function mistHollow(ground: number, mean: number): number {
  const below = mean - ground;
  if (!(below > 0.4)) return 0;
  const t = Math.min(1, (below - 0.4) / 3.6);
  return t * t * (3 - 2 * t);
}

/** Scene-space grid centre for a feet position: snapped so the grid does not swim. Pure. */
export function mistCentre(value: number): number {
  return Math.round(value / MIST_SNAP) * MIST_SNAP;
}

const VERTEX = /* glsl */ `
attribute vec3 aMist;
attribute vec3 aNormal;
attribute vec3 aLayer; // x index, y height above the surface (yards), z share of the mist
uniform vec4 uKinds;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vDensity;
varying float vLayer;
#include <fog_pars_vertex>
void main() {
  float layerHeight = aLayer.y;
  float known = step( -0.5, aMist.x );
  float hollow = max( aMist.x, 0.0 );
  float inland = aMist.y;
  float ocean = aMist.z;
  // Marsh: in hollows and over standing water. Coast: over the sea and a little inland. Snow: everywhere.
  // Forest: thin, in the hollows. The mist thins with height above the ground under it (the particles' soft
  // ground, upside down): the top sheet is faint, so the mist has no level upper edge.
  float height = aLayer.z;
  vDensity = ( uKinds.x * ( 0.35 + 1.0 * hollow + 1.4 * inland )
    + uKinds.y * ( 0.05 + 0.35 * ocean )
    + uKinds.w * ( 0.2 + 0.7 * hollow )
    + uKinds.z * ( 0.25 + 0.2 * hollow ) ) * height;
  vDensity *= known;
  vLayer = aLayer.x;
  vNormal = aNormal;
  vec3 transformed = position + vec3( 0.0, layerHeight, 0.0 );
  vec4 world = modelMatrix * vec4( transformed, 1.0 );
  vWorld = world.xyz;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uLight;
uniform vec3 uSunColour;
uniform vec3 uSunDirection;
uniform float uGlow;
uniform vec4 uDrift; // xy drift (yards), z blown-snow share, w the clock
uniform vec4 uCentre; // xyz grid centre, w fade radius
varying vec3 vWorld;
varying vec3 vNormal;
varying float vDensity;
varying float vLayer;
#include <fog_pars_fragment>
float wowMistHash( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}
float wowMistNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( wowMistHash( i ), wowMistHash( i + vec2( 1.0, 0.0 ) ), u.x ),
    mix( wowMistHash( i + vec2( 0.0, 1.0 ) ), wowMistHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
void main() {
  if ( vDensity < 0.004 ) discard;
  vec3 toEye = cameraPosition - vWorld;
  float eye = length( toEye );
  vec3 view = toEye / max( eye, 0.001 );
  // Seen from the side the ground faces: by the surface's own normal, not by world height, so a hillside rising
  // before the camera keeps its mist and no level edge is drawn where the slope passes the camera's height.
  float facingGround = dot( normalize( vNormal ), view );
  float side = smoothstep( 0.02, 0.22, facingGround );
  float rim = 1.0 - smoothstep( uCentre.w * 0.35, uCentre.w, length( vWorld.xz - uCentre.xz ) );
  // Clear right round the camera: a sheet passing a trunk or a wall nearby would show where it meets it.
  // Ground mist reads in the middle distance; at the feet it would only be a veil over the player's own view.
  float nearFade = smoothstep( 5.0, 24.0, eye );
  float fade = side * rim * nearFade;
  if ( fade < 0.004 ) discard;
  // Each sheet drifts on its own offset; blown snow streams faster along the wind. Large, slow patches.
  vec2 drift = uDrift.xy * ( 1.0 + 0.35 * vLayer );
  vec2 p = ( vWorld.xz + drift + vec2( 17.3, 41.1 ) * vLayer ) / 13.0;
  float n = 0.55 * wowMistNoise( p ) + 0.3 * wowMistNoise( p * 2.3 + vec2( uDrift.w * 0.03, 0.0 ) )
    + 0.15 * wowMistNoise( p * 5.1 - drift * 0.05 );
  float shape = smoothstep( 0.3, 0.75, n );
  // Seen edge-on a sheet stands for more air along the ray; never so much that it turns into a wall.
  float slant = 1.0 + 0.6 * ( 1.0 - clamp( facingGround, 0.0, 1.0 ) );
  // Distance: the zone's fog already holds the far air, so far mist adds nothing on top of it.
  #ifdef USE_FOG
  float fogAmount = wowFogFactor( fogNear, fogFar, vFogDepth );
  #else
  float fogAmount = 0.0;
  #endif
  // 0.6: six sheets share what three held.
  float alpha = clamp( 0.6 * vDensity * shape * fade * slant * ( 1.0 - fogAmount ), 0.0, 0.3 );
  if ( alpha < 0.003 ) discard;
  // The frame's fog colour, and toward a low sun bright with its colour (forward scattering). Blended additively
  // (src·alpha + dst): mist only ever lightens and tints what lies behind it, it never darkens it.
  float sunward = max( dot( -view, normalize( uSunDirection ) ), 0.0 );
  vec3 colour = uLight + uSunColour * uGlow * ( 0.2 * pow( sunward, 3.0 ) + 0.45 * pow( sunward, 12.0 ) );
  gl_FragColor = vec4( colour, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class GroundMist {
  readonly object: THREE.Mesh;
  readonly geometry: THREE.InstancedBufferGeometry;
  readonly material: THREE.ShaderMaterial;
  readonly #positions: Float32Array;
  readonly #mist: Float32Array;
  /** The surface's normal at each vertex (scene space), which side a sheet is seen from. */
  readonly #normals: Float32Array;
  readonly #ground = new Float32Array(MIST_GRID * MIST_GRID);
  readonly #known = new Uint8Array(MIST_GRID * MIST_GRID);
  readonly #sums = new Float64Array((MIST_GRID + 1) * (MIST_GRID + 1));
  readonly #counts = new Float64Array((MIST_GRID + 1) * (MIST_GRID + 1));
  #centreX = Number.NaN;
  #centreZ = Number.NaN;
  #probe: ZoneTerrainProbe | undefined;
  #drift = new THREE.Vector2();
  /** Grid rebuilds so far, and the vertices whose ground was known at the last one (diagnostics, tests). */
  rebuilds = 0;
  knownVertices = 0;

  constructor() {
    const count = MIST_GRID * MIST_GRID;
    this.#positions = new Float32Array(count * 3);
    this.#mist = new Float32Array(count * 3);
    this.#normals = new Float32Array(count * 3);
    const indices: number[] = [];
    for (let row = 0; row < MIST_GRID - 1; row++) {
      for (let column = 0; column < MIST_GRID - 1; column++) {
        const a = row * MIST_GRID + column;
        const b = a + 1;
        const c = a + MIST_GRID;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(indices);
    geometry.setAttribute("position", new THREE.BufferAttribute(this.#positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aMist", new THREE.BufferAttribute(this.#mist, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aNormal", new THREE.BufferAttribute(this.#normals, 3).setUsage(THREE.DynamicDrawUsage));
    const layers = new Float32Array(MIST_LAYERS * 3);
    for (let layer = 0; layer < MIST_LAYERS; layer++) {
      layers.set([layer, MIST_LAYER_HEIGHTS[layer]!, mistLayerWeight(layer)], layer * 3);
    }
    geometry.setAttribute("aLayer", new THREE.InstancedBufferAttribute(layers, 3));
    geometry.instanceCount = MIST_LAYERS;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    this.geometry = geometry;
    this.material = new THREE.ShaderMaterial({
      name: "zone-ground-mist",
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uKinds: { value: new THREE.Vector4() },
        uLight: { value: new THREE.Color(1, 1, 1) },
        uSunColour: { value: new THREE.Color(1, 1, 1) },
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uGlow: { value: 0 },
        uDrift: { value: new THREE.Vector4() },
        uCentre: { value: new THREE.Vector4(0, 0, 0, MIST_SPACING * (MIST_GRID - 1) * 0.5) },
      }]),
      transparent: true,
      depthWrite: false,
      fog: true,
      // Additive by the sheet's alpha: mist lightens and tints, it never darkens what is behind it. The target's
      // alpha (the opaque surfaces' sun shadow for the screen-space pools, 7.50) is left as it is.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.object = new THREE.Mesh(geometry, this.material);
    this.object.name = "zone-ground-mist";
    // Over the water surfaces and the scenery's own blended leaves.
    this.object.renderOrder = 3;
    this.object.visible = false;
  }

  /** Draws nothing this frame (indoors, under water, every kind at zero). */
  hide(): void {
    this.object.visible = false;
  }

  update(frame: MistFrame, elapsed: number): void {
    const k = frame.kinds;
    const any = k.marsh + k.coast + k.cold + k.forest;
    if (!(any > 0.004) || !frame.probe) {
      this.object.visible = false;
      return;
    }
    const cx = mistCentre(frame.centre.x);
    const cz = mistCentre(frame.centre.z);
    if (cx !== this.#centreX || cz !== this.#centreZ || frame.probe !== this.#probe) {
      this.#rebuild(frame.probe, cx, cz, frame.centre.y);
    }
    const step = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.25, elapsed)) : 0;
    // Wrapped so the noise coordinates stay small; the period is far larger than any one noise cell repeats.
    this.#drift.x = (this.#drift.x + frame.windX * step) % 4096;
    this.#drift.y = (this.#drift.y + frame.windZ * step) % 4096;
    const u = this.material.uniforms;
    (u["uKinds"]!.value as THREE.Vector4).set(k.marsh, k.coast, k.cold, k.forest);
    (u["uLight"]!.value as THREE.Color).copy(frame.light);
    (u["uSunColour"]!.value as THREE.Color).copy(frame.sunColour);
    (u["uSunDirection"]!.value as THREE.Vector3).copy(frame.sunDirection);
    u["uGlow"]!.value = frame.glow;
    (u["uDrift"]!.value as THREE.Vector4).set(-this.#drift.x, -this.#drift.y, k.cold, frame.seconds % 4096);
    this.object.visible = true;
  }

  /** The surface under each vertex, its hollowness and its water; once per eight-yard cell. */
  #rebuild(probe: ZoneTerrainProbe, cx: number, cz: number, fallbackY: number): void {
    this.#centreX = cx;
    this.#centreZ = cz;
    this.#probe = probe;
    this.rebuilds++;
    const half = (MIST_GRID - 1) * 0.5 * MIST_SPACING;
    const ground = this.#ground;
    const known = this.#known;
    const positions = this.#positions;
    const mist = this.#mist;
    let lowest = Infinity;
    let highest = -Infinity;
    let knownCount = 0;
    for (let row = 0; row < MIST_GRID; row++) {
      for (let column = 0; column < MIST_GRID; column++) {
        const i = row * MIST_GRID + column;
        const sx = cx - half + column * MIST_SPACING;
        const sz = cz - half + row * MIST_SPACING;
        // Scene (x, y, z) is world (x, z, -y).
        const wx = sx;
        const wy = -sz;
        const height = probe.groundAt(wx, wy);
        const liquid = probe.liquidAt(wx, wy);
        const known1 = height !== undefined && Number.isFinite(height);
        known[i] = known1 ? 1 : 0;
        knownCount += known[i]!;
        ground[i] = known1 ? height : fallbackY;
        const water = liquid !== undefined && Number.isFinite(liquid.height) && (!known1 || liquid.height > height);
        const surface = water ? Math.max(liquid.height, ground[i]!) : ground[i]!;
        const ocean = water && (liquid.type & LIQUID_OCEAN) !== 0;
        positions[i * 3] = sx;
        positions[i * 3 + 1] = surface;
        positions[i * 3 + 2] = sz;
        // A vertex over unknown ground (a tile not in yet) carries no mist at all.
        mist[i * 3 + 1] = known1 && water && !ocean ? 1 : 0;
        mist[i * 3 + 2] = ocean ? 1 : 0;
        lowest = Math.min(lowest, surface);
        highest = Math.max(highest, surface);
      }
    }
    this.knownVertices = knownCount;
    // Summed-area tables of the known ground, for the mean round each vertex.
    const side = MIST_GRID + 1;
    const sums = this.#sums;
    const counts = this.#counts;
    for (let row = 0; row < MIST_GRID; row++) {
      for (let column = 0; column < MIST_GRID; column++) {
        const i = row * MIST_GRID + column;
        const at = (row + 1) * side + column + 1;
        const h = known[i] ? ground[i]! : 0;
        sums[at] = h + sums[at - 1]! + sums[at - side]! - sums[at - side - 1]!;
        counts[at] = known[i]! + counts[at - 1]! + counts[at - side]! - counts[at - side - 1]!;
      }
    }
    for (let row = 0; row < MIST_GRID; row++) {
      const r0 = Math.max(0, row - HOLLOW_RADIUS);
      const r1 = Math.min(MIST_GRID - 1, row + HOLLOW_RADIUS) + 1;
      for (let column = 0; column < MIST_GRID; column++) {
        const c0 = Math.max(0, column - HOLLOW_RADIUS);
        const c1 = Math.min(MIST_GRID - 1, column + HOLLOW_RADIUS) + 1;
        const n = counts[r1 * side + c1]! - counts[r0 * side + c1]! - counts[r1 * side + c0]! + counts[r0 * side + c0]!;
        const s = sums[r1 * side + c1]! - sums[r0 * side + c1]! - sums[r1 * side + c0]! + sums[r0 * side + c0]!;
        const i = row * MIST_GRID + column;
        // -1 marks ground not in yet (a tile still loading): the vertex draws no mist.
        mist[i * 3] = !known[i] && mist[i * 3 + 2] === 0 ? -1 : n > 0 && known[i] ? mistHollow(ground[i]!, s / n) : 0;
      }
    }
    // The surface's normal from its neighbours (scene x along a row, scene z down the columns).
    const normals = this.#normals;
    for (let row = 0; row < MIST_GRID; row++) {
      const up = Math.max(0, row - 1);
      const down = Math.min(MIST_GRID - 1, row + 1);
      for (let column = 0; column < MIST_GRID; column++) {
        const left = Math.max(0, column - 1);
        const right = Math.min(MIST_GRID - 1, column + 1);
        const dx = (positions[(row * MIST_GRID + right) * 3 + 1]! - positions[(row * MIST_GRID + left) * 3 + 1]!)
          / ((right - left) * MIST_SPACING);
        const dz = (positions[(down * MIST_GRID + column) * 3 + 1]! - positions[(up * MIST_GRID + column) * 3 + 1]!)
          / ((down - up) * MIST_SPACING);
        const length = Math.hypot(dx, 1, dz);
        const i = (row * MIST_GRID + column) * 3;
        normals[i] = -dx / length;
        normals[i + 1] = 1 / length;
        normals[i + 2] = -dz / length;
      }
    }
    (this.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("aMist") as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("aNormal") as THREE.BufferAttribute).needsUpdate = true;
    const sphere = this.geometry.boundingSphere!;
    const midY = Number.isFinite(lowest) ? (lowest + highest) * 0.5 : fallbackY;
    sphere.center.set(cx, midY, cz);
    sphere.radius = Math.hypot(half, half, (Number.isFinite(lowest) ? highest - lowest : 0) * 0.5 + MIST_LAYER_HEIGHTS[MIST_LAYERS - 1]!);
    (this.material.uniforms["uCentre"]!.value as THREE.Vector4).set(cx, midY, cz, half);
  }

  /** Forget the grid (a map change, a replay restart): the next frame rebuilds it. */
  reset(): void {
    this.#centreX = Number.NaN;
    this.#centreZ = Number.NaN;
    this.#drift.set(0, 0);
    this.object.visible = false;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
