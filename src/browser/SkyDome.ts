// 13.10 (7.04): the classic sky dome — Wow.exe 3.3.5a's own mesh and its per-vertex colours,
// HighlightSky included — for the faithful look (`lightingClassicLook`). The enhanced preset keeps
// the smooth band shader (`buildSky`); this mesh replaces it only on the classic path.
//
// Read out of Wow.exe 12340 (`.runtime/re-2026-10-13/704/dome.txt`, `s704-*.txt` in
// `re-2026-10-11/glue-1110/`); the behaviour is described in our own words, nothing is copied:
//   * 0x007f2470 builds the dome once: 24 segments (0x18), seven rings whose polar angles are the
//     table 0x00a41a90 × π (0, 0.17, 0.20, 0.23, 0.24, 0.25, 1), vertex (sin θ·sin P, cos θ·sin P,
//     cos P − cos(π/4)) with θ = 2π·j/24 — a shallow cap whose 45° ring sits on the camera's horizon
//     (the π/4 is the double at 0x009eaf48). The top and bottom rings are single vertices.
//   * 0x007f0530 recolours it every frame from the sampled light block (0x00d38bd4, layout from
//     0x007ebff0): the top is band 2 (`skyTop`, through an HSV round trip with factor 1 at
//     0x007ed790 — an identity here), rings 1–4 are bands 3–6, ring 5 and the bottom band 7 (fog).
//     h = curve 0x00af4b7c(time of day) × `HighlightSky` (block +0x54, 0x00d38c28): 0 at 03:00,
//     1 at 06:30, 0 by 07:00 and again 0 at 20:30, 1 at 21:30, 0 at midnight.
//     Each ring's highlighted colour is `lerp(band, band 3, h)`; per vertex w = curve 0x00af4bac
//     (azimuth): 1 at 0.125 of a turn, 0 at 0.375 and 0.875, −0.5/−0.7/−0.5 at 0.5/0.625/0.75.
//     w ≥ 0: lerp(band, highlighted, (1 − w)·h); w < 0: lerp(highlighted, lerp(highlighted,
//     band 2, 0.7·h), −w·h). All of it byte arithmetic (0x007ed2d0: `round(a + (b − a)·t − 0.5)`
//     with the FPU's round-half-even, alpha 0xff).
//   * The curve is indexed by the camera's yaw plus each vertex's own angle (t = yaw/2π + 0.25 −
//     j/24, 0x007f063d; yaw from the view vector at 0x007f3920) — the azimuth, in the world, of the
//     sky the vertex shows. The peak (0.125 of a turn) is 45°, the bearing the sun and the moons
//     rise and set on (`SkyCelestials.ts` SUN_AZIMUTH): with HighlightSky the horizon bands keep
//     their sunrise colours toward the sun and fade to bands 3 and 2 away from it.
// Not taken: the fade toward 0x00d38d44 under `0x00d38184 & 1` and the 0x006acc50 overrides
// (0x00d38b50/51) — screen effects whose source was not traced; they change no ordinary frame.

import * as THREE from "three";

import { skyKeyCurve, type SkyKeys } from "./SkyCelestials.js";

/** 0x007f2470: segments around each ring. */
export const CLASSIC_DOME_SEGMENTS = 24;
/** 0x00a41a90 (× π, 0x00a41b14): the rings' polar angles as fractions of π, top to bottom. */
export const CLASSIC_DOME_POLAR: readonly number[] = [
  0, 0.17000000178813934, 0.20000000298023224, 0.23000000417232513, 0.23999999463558197, 0.25, 1,
];
/** 0x009eaf48 (a double, π/4): the cap is lowered by cos(π/4), so the 45° ring is the horizon. */
export const CLASSIC_DOME_LIFT = Math.cos(Math.PI / 4);
/** 0x00af4b7c, 6 keys: HighlightSky strength over the day. */
export const HIGHLIGHT_TIME_KEYS: SkyKeys = [
  0.125, 0, 0.2708333432674408, 1, 0.2916666865348816, 0, 0.8541666269302368, 0, 0.8958333134651184, 1,
  0.9993055462837219, 0,
];
/** 0x00af4bac, 6 keys: the highlight around the horizon, over the fraction of a turn. */
export const HIGHLIGHT_AZIMUTH_KEYS: SkyKeys = [
  0.125, 1, 0.375, 0, 0.5, -0.5, 0.625, -0.699999988079071, 0.75, -0.5, 0.875, 0,
];

/** Vertices: the top, five rings of 24, the bottom. */
export const CLASSIC_DOME_VERTICES = 2 + 5 * CLASSIC_DOME_SEGMENTS;

/** The FPU's `fistp` of `x − 0.5` (round half to even), as 0x007ed2d0 stores each byte. */
export function domeByte(value: number): number {
  const x = value - 0.5;
  const floor = Math.floor(x);
  const fraction = x - floor;
  const rounded = fraction > 0.5 ? floor + 1 : fraction < 0.5 ? floor : (floor % 2 === 0 ? floor : floor + 1);
  return Math.max(0, Math.min(255, rounded));
}

/** 0x007ed2d0 on one packed 0xRRGGBB pair: `a` toward `b` by `t`, alpha dropped. */
export function domeLerp(a: number, b: number, t: number): number {
  let result = 0;
  for (let shift = 16; shift >= 0; shift -= 8) {
    const from = (a >> shift) & 0xff;
    const to = (b >> shift) & 0xff;
    result |= domeByte(from + (to - from) * t) << shift;
  }
  return result;
}

/** The six bands the dome reads, packed display-space 0xRRGGBB: Light bands 2–7. */
export interface ClassicDomeBands {
  top: number;
  upper: number;
  middle: number;
  lower: number;
  horizon: number;
  fog: number;
}

/** h: the highlight strength at a fraction of the day for a profile's `HighlightSky`. */
export function highlightStrength(fraction: number, highlightSky: number): number {
  const sky = Number.isFinite(highlightSky) ? highlightSky : 0;
  return skyKeyCurve(HIGHLIGHT_TIME_KEYS, fraction) * sky;
}

/** World azimuth (radians, atan2 of the world's y over x) of ring vertex j: π/2 − 2πj/24. */
export function domeVertexAzimuth(j: number): number {
  return Math.PI / 2 - (2 * Math.PI * j) / CLASSIC_DOME_SEGMENTS;
}

/**
 * Writes the dome's 122 packed colours (top, rings 1–5 × 24, bottom) into `out`; no allocation.
 * `h` is {@link highlightStrength}.
 */
export function classicDomeColours(bands: ClassicDomeBands, h: number, out: Uint32Array): Uint32Array {
  const strength = Number.isFinite(h) ? h : 0;
  out[0] = bands.top & 0xffffff;
  const ringBands = [bands.upper, bands.middle, bands.lower, bands.horizon];
  for (let ring = 0; ring < 4; ring++) {
    const band = ringBands[ring]! & 0xffffff;
    const highlighted = domeLerp(band, bands.upper & 0xffffff, strength);
    for (let j = 0; j < CLASSIC_DOME_SEGMENTS; j++) {
      let turn = domeVertexAzimuth(j) / (2 * Math.PI);
      turn -= Math.floor(turn);
      const w = skyKeyCurve(HIGHLIGHT_AZIMUTH_KEYS, turn);
      out[1 + ring * CLASSIC_DOME_SEGMENTS + j] = w >= 0
        ? domeLerp(band, highlighted, (1 - w) * strength)
        : domeLerp(highlighted, domeLerp(highlighted, bands.top & 0xffffff, 0.699999988079071 * strength), -w * strength);
    }
  }
  for (let j = 0; j < CLASSIC_DOME_SEGMENTS; j++) out[1 + 4 * CLASSIC_DOME_SEGMENTS + j] = bands.fog & 0xffffff;
  out[CLASSIC_DOME_VERTICES - 1] = bands.fog & 0xffffff;
  return out;
}

/**
 * The dome's geometry in scene space (world (x, y, z) → scene (x, z, −y)), unit size: positions,
 * a display-space `color` attribute the caller rewrites, and the ring triangles.
 */
export function buildClassicDomeGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array(CLASSIC_DOME_VERTICES * 3);
  const put = (index: number, x: number, y: number, z: number): void => {
    positions[index * 3] = x;
    positions[index * 3 + 1] = z;
    positions[index * 3 + 2] = -y;
  };
  put(0, 0, 0, 1 - CLASSIC_DOME_LIFT);
  for (let ring = 1; ring <= 5; ring++) {
    const polar = CLASSIC_DOME_POLAR[ring]! * Math.PI;
    for (let j = 0; j < CLASSIC_DOME_SEGMENTS; j++) {
      const theta = (2 * Math.PI * j) / CLASSIC_DOME_SEGMENTS;
      put(1 + (ring - 1) * CLASSIC_DOME_SEGMENTS + j,
        Math.sin(theta) * Math.sin(polar), Math.cos(theta) * Math.sin(polar), Math.cos(polar) - CLASSIC_DOME_LIFT);
    }
  }
  put(CLASSIC_DOME_VERTICES - 1, 0, 0, -1 - CLASSIC_DOME_LIFT);
  const indices: number[] = [];
  const ringStart = (ring: number) => 1 + (ring - 1) * CLASSIC_DOME_SEGMENTS;
  for (let j = 0; j < CLASSIC_DOME_SEGMENTS; j++) {
    const next = (j + 1) % CLASSIC_DOME_SEGMENTS;
    indices.push(0, ringStart(1) + j, ringStart(1) + next);
    for (let ring = 1; ring < 5; ring++) {
      const a = ringStart(ring) + j, b = ringStart(ring) + next;
      const c = ringStart(ring + 1) + j, d = ringStart(ring + 1) + next;
      indices.push(a, c, b, b, c, d);
    }
    indices.push(ringStart(5) + j, CLASSIC_DOME_VERTICES - 1, ringStart(5) + next);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(CLASSIC_DOME_VERTICES * 3), 3));
  geometry.setIndex(indices);
  return geometry;
}

/** Packed colours into the geometry's display-space `color` attribute (0–1). */
export function writeClassicDomeColours(geometry: THREE.BufferGeometry, packed: Uint32Array): void {
  const attribute = geometry.getAttribute("color") as THREE.BufferAttribute;
  const array = attribute.array as Float32Array;
  for (let index = 0; index < CLASSIC_DOME_VERTICES; index++) {
    const value = packed[index]!;
    array[index * 3] = ((value >> 16) & 0xff) / 255;
    array[index * 3 + 1] = ((value >> 8) & 0xff) / 255;
    array[index * 3 + 2] = (value & 0xff) / 255;
  }
  attribute.needsUpdate = true;
}

/** Gouraud in display space, as the client blends vertex bytes; decoded once per fragment. */
export const CLASSIC_DOME_VERTEX_SHADER = /* glsl */ `
varying vec3 vDomeColour;
void main() {
  vDomeColour = color;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const CLASSIC_DOME_FRAGMENT_SHADER = /* glsl */ `
varying vec3 vDomeColour;
vec3 domeToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
void main() {
  gl_FragColor = vec4(domeToLinear(vDomeColour), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** The classic dome mesh: unit geometry (its parent, the sky dome, scales and centres it). */
export function buildClassicDome(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    vertexShader: CLASSIC_DOME_VERTEX_SHADER,
    fragmentShader: CLASSIC_DOME_FRAGMENT_SHADER,
    vertexColors: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(buildClassicDomeGeometry(), material);
  mesh.name = "classicSkyDome";
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}

/** A packed 0xRRGGBB display-space colour from a 0–1 display-space triple, rounded per byte. */
export function packDisplayColour(colour: { r: number; g: number; b: number }): number {
  const byte = (value: number) => Math.max(0, Math.min(255, Math.round((Number.isFinite(value) ? value : 0) * 255)));
  return (byte(colour.r) << 16) | (byte(colour.g) << 8) | byte(colour.b);
}
