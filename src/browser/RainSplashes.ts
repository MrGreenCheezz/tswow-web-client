/**
 * Raindrops landing (`experimentalRainSplashes`): the client's own `RainDropSplash01` flipbook,
 * which the faithful weather never draws, played on the ground around the character.
 *
 * The flipbook is a 4×4 atlas: each row is one kind of splash (ring, crown, crown with droplet,
 * jet) and its four columns are that splash's life. Every quad here is one splash slot that
 * re-rolls its place and its row each cycle from a hash of (slot, cycle), so the whole field
 * lives in the vertex shader: the CPU writes a few uniforms per frame and, only when the
 * character has moved a few yards, a height grid (no allocation, a few rows a frame).
 *
 * The field is wide — `RAIN_SPLASH_RADIUS` yards around the character, past where a splash is
 * still a few pixels — and it thins out towards its rim rather than stopping: a fifteen-yard disc
 * that ended in a soft edge was a circle of splashes walking along with the character, which is
 * the one thing rain on the ground must never look like. Density is highest under the character,
 * where the eye is, and the rim is out among the mid-distance streaks where nothing is read one
 * splash at a time.
 *
 * 12.10-7.21: and a splash stays where it landed. Each slot's place used to be an offset from the
 * character, so every ring on the ground slid along with a running character (owner, 12.10: «дождь
 * буквально следует за персонажем, а не оставляет капли на земле»). It is now a point of a lattice
 * laid over the world with the period of the field's window (`splashWindowOffset`), drawn at the
 * copy nearest the character: moving shifts the window, not the splash, and a slot only reappears
 * on the far side where the window's edge crosses it — where the rim fade has it at zero alpha.
 * The denser middle is a second, smaller window over its own share of the slots.
 *
 * The ground the splashes stand on is the terrain height grid, sampled bilinearly so a splash on
 * a slope sits on it rather than on a step. A character on a WMO floor (a city street, a bridge,
 * a dock) is detected by their own height disagreeing with the terrain under them, and the field
 * then lies flat at their feet — right for a plaza, and the depth test hides any splash that
 * would land inside a wall.
 *
 * 22.10 (7.45): unless the character is flying. A flyer's feet disagree with the terrain too, and
 * the field used to lie flat through them — rings on an invisible floor in mid-air (owner, 22.10).
 * In flight the grid samples the ground (and the water) under each cell; past 64 yards of view
 * depth the distance fade already has every splash at zero.
 */

import * as THREE from "three";
import type { IUniform } from "three";
import type { HeightSampler } from "./SimpleScene.js";

export const RAIN_SPLASH_TEXTURE = "textures\\WEATHER\\RainDropSplash01.blp";
export const RAIN_SPLASH_CAPACITY = 1400;
export const RAIN_SPLASH_GRID = 48;
/** Yards between grid samples; the grid covers GRID × CELL yards centred on the character. */
export const RAIN_SPLASH_CELL = 2;
/** Splashes land within this many yards of the character (the grid reaches 6 yards further). */
export const RAIN_SPLASH_RADIUS = 42;
/**
 * 12.10-7.21: the inner window's half-width and the share of slots in it. A fifth of the slots in a
 * 32-yard window under the character keeps the middle as dense as the former field's (~0.44 a
 * square yard within ten yards of the feet) now that the outer window's slots are spread evenly.
 */
export const RAIN_SPLASH_INNER_RADIUS = 16;
export const RAIN_SPLASH_INNER_SHARE = 0.2;

/**
 * 12.10-7.21: where a slot's splash stands relative to the window's centre, for one axis: the
 * slot's lattice point `seed · 2·half` (`seed` in 0..1, re-rolled per cycle) has one copy every
 * `2·half` yards over the world, and the one inside [-half, half) of `centre` is drawn. The GLSL
 * `mod( seed * 2.0 * reach - centre + reach, 2.0 * reach ) - reach` is this function (`half` is a
 * reserved word in GLSL ES); tested.
 */
export function splashWindowOffset(seed: number, centre: number, half: number): number {
  const period = 2 * half;
  if (!(period > 0) || !Number.isFinite(seed) || !Number.isFinite(centre)) return 0;
  const value = seed * period - centre + half;
  return value - period * Math.floor(value / period) - half;
}
/** Rebuild the height grid once the character is this far from its centre. */
export const RAIN_SPLASH_REGRID_YARDS = 5;
/** Grid rows sampled per frame while a rebuild is under way (384 height queries a frame). */
export const RAIN_SPLASH_ROWS_PER_FRAME = 8;
/** A character this far above/below the terrain is standing on something else (a WMO floor). */
export const RAIN_SPLASH_FLOOR_TOLERANCE = 1.2;

/**
 * Whether the character stands on the terrain (the grid samples it) or on something else (the
 * grid lies flat at `floorY`). Scene (x, y, z) is WoW (x, z, -y), so the sampler is asked at
 * (sceneX, -sceneZ).
 */
export function splashesOnTerrain(
  centreX: number, centreZ: number, floorY: number, heightAt: HeightSampler | undefined, flying = false,
): boolean {
  const underFeet = heightAt?.(centreX, -centreZ);
  if (underFeet === undefined || !Number.isFinite(underFeet)) return false;
  // 22.10 (7.45): a flyer above the ground is not standing on a WMO floor at their own height.
  if (flying && floorY >= underFeet - RAIN_SPLASH_FLOOR_TOLERANCE) return true;
  return Math.abs(underFeet - floorY) <= RAIN_SPLASH_FLOOR_TOLERANCE;
}

/**
 * Fills rows `rowStart` to `rowEnd` (exclusive) of `heights` (GRID² floats, row-major z then x in
 * scene space) around a scene-space centre; `onTerrain` false writes `floorY` everywhere.
 */
export function fillSplashHeightRows(
  heights: Float32Array, centreX: number, centreZ: number, floorY: number,
  heightAt: HeightSampler | undefined, onTerrain: boolean, rowStart: number, rowEnd: number,
): void {
  const n = RAIN_SPLASH_GRID;
  const originX = centreX - (n * RAIN_SPLASH_CELL) / 2;
  const originZ = centreZ - (n * RAIN_SPLASH_CELL) / 2;
  const first = Math.max(0, Math.floor(rowStart));
  const last = Math.min(n, Math.ceil(rowEnd));
  for (let row = first; row < last; row++) {
    const z = originZ + (row + 0.5) * RAIN_SPLASH_CELL;
    for (let column = 0; column < n; column++) {
      let h = floorY;
      if (onTerrain && heightAt) {
        const sampled = heightAt(originX + (column + 0.5) * RAIN_SPLASH_CELL, -z);
        if (sampled !== undefined && Number.isFinite(sampled)) h = sampled;
      }
      heights[row * n + column] = h;
    }
  }
}

/**
 * Fills the whole grid at once. Returns whether terrain was used (false: flat at `floorY`).
 */
export function fillSplashHeights(
  heights: Float32Array, centreX: number, centreZ: number, floorY: number,
  heightAt: HeightSampler | undefined, flying = false,
): boolean {
  const onTerrain = splashesOnTerrain(centreX, centreZ, floorY, heightAt, flying);
  fillSplashHeightRows(heights, centreX, centreZ, floorY, heightAt, onTerrain, 0, RAIN_SPLASH_GRID);
  return onTerrain;
}

const VERTEX_SHADER = `
  attribute vec2 corner;
  uniform float uTime;
  uniform float uRate;
  uniform float uRadius;
  uniform float uInnerRadius;
  uniform float uInnerShare;
  uniform float uSize;
  uniform vec2 uCentre;
  uniform vec2 uGridOrigin;
  uniform float uGridSize;
  uniform float uCell;
  uniform sampler2D uHeights;
  varying vec2 vUv;
  varying float vAlpha;
  float splashHash( vec2 p ) {
    return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  }
  float heightAt( vec2 cell ) {
    return texture2D( uHeights, ( cell + 0.5 ) / uGridSize ).r;
  }
  void main() {
    float cycle = uTime * uRate * ( 0.85 + 0.3 * position.y ) + position.z;
    float index = floor( cycle );
    float life = fract( cycle );
    float a = splashHash( vec2( position.x * 91.7 + index * 0.731, position.y * 17.3 ) );
    float b = splashHash( vec2( position.y * 53.1 - index * 1.371, position.x * 7.9 + index * 0.113 ) );
    float c = splashHash( vec2( a * 13.7 + index, b * 29.3 ) );
    // 12.10-7.21: a lattice point over the world, not an offset from the character
    // (splashWindowOffset): the window follows the feet, the splash stays where it landed. A fifth
    // of the slots (their own fixed seed) fill a smaller window, so the middle stays the densest.
    float reach = mix( uRadius, uInnerRadius, step( position.y, uInnerShare ) );
    vec2 offset = mod( vec2( a, b ) * 2.0 * reach - uCentre + reach, 2.0 * reach ) - reach;
    vec2 xz = uCentre + offset;
    float radius = length( offset );
    // Bilinear over the four surrounding samples: on a slope the splash sits on the ground, not on
    // a two-yard step of it.
    vec2 grid = clamp( ( xz - uGridOrigin ) / uCell - 0.5, vec2( 0.0 ), vec2( uGridSize - 1.001 ) );
    vec2 cell = floor( grid );
    vec2 t = grid - cell;
    float height = mix(
      mix( heightAt( cell ), heightAt( cell + vec2( 1.0, 0.0 ) ), t.x ),
      mix( heightAt( cell + vec2( 0.0, 1.0 ) ), heightAt( cell + vec2( 1.0, 1.0 ) ), t.x ),
      t.y );
    vec4 view = viewMatrix * vec4( xz.x, height + 0.03, xz.y, 1.0 );
    vec3 up = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
    vec3 side = cross( up, view.xyz );
    float sideLength = length( side );
    vec3 right = sideLength > 1e-5 ? side / sideLength : vec3( 1.0, 0.0, 0.0 );
    float size = uSize * ( 0.75 + 0.5 * c );
    view.xyz += right * ( corner.x * size ) + up * ( ( corner.y + 0.5 ) * size );
    // Mostly rings and low crowns; the tall jets are the rarer, heavier drops.
    float variant = floor( c * c * 3.999 );
    float frame = min( floor( life * 4.0 ), 3.0 );
    // Row 0 of the atlas is the top of the image (flipY is off, as for every client texture).
    vUv = vec2( ( frame + corner.x + 0.5 ) / 4.0, ( variant + 0.5 - corner.y ) / 4.0 );
    // The rim thins over its outer forty percent, and the far ones fade with distance from the eye
    // — by then they are a few pixels among the mid-distance streaks, and never a boundary. Zero
    // from the inscribed circle out, so a slot crossing the window's edge is never seen to jump.
    float depth = -view.z;
    float edge = ( 1.0 - smoothstep( 0.6, 1.0, radius / reach ) ) * ( 1.0 - smoothstep( 32.0, 64.0, depth ) );
    // A splash right at the lens would be a blurred disc across the frame; fade the closest out.
    vAlpha = smoothstep( 0.0, 0.06, life ) * ( 1.0 - smoothstep( 0.55, 1.0, life ) ) * edge
      * smoothstep( 1.2, 3.0, depth );
    gl_Position = projectionMatrix * view;
  }`;

const FRAGMENT_SHADER = `
  uniform sampler2D uMap;
  uniform vec3 uLight;
  uniform float uOpacity;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    vec4 texel = texture2D( uMap, vUv );
    float alpha = texel.a * uOpacity * vAlpha;
    if ( alpha < 0.01 ) discard;
    // Lit like the rain above it (sky light), a little brighter than the ground it lands on.
    gl_FragColor = vec4( texel.rgb * uLight * 1.3, alpha );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

function buildSplashGeometry(capacity: number): THREE.BufferGeometry {
  const seeds = new Float32Array(capacity * 12);
  const corners = new Float32Array(capacity * 8);
  const indices = new Uint16Array(capacity * 6);
  let state = 0x2545f491;
  const next = () => {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x1b873593) >>> 0;
    return (state >>> 8) / 0x1000000;
  };
  const cx = [-0.5, 0.5, 0.5, -0.5];
  const cy = [-0.5, -0.5, 0.5, 0.5];
  for (let i = 0; i < capacity; i++) {
    const sx = next();
    const sy = next();
    const phase = next() * 17;
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      seeds[v * 3] = sx;
      seeds[v * 3 + 1] = sy;
      seeds[v * 3 + 2] = phase;
      corners[v * 2] = cx[k]!;
      corners[v * 2 + 1] = cy[k]!;
    }
    const base = i * 4;
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], i * 6);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(seeds, 3));
  geometry.setAttribute("corner", new THREE.BufferAttribute(corners, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, 0);
  return geometry;
}

/** A height-grid rebuild in progress: where it is centred and how many rows are done. */
interface SplashRegrid {
  centreX: number;
  centreZ: number;
  floorY: number;
  onTerrain: boolean;
  row: number;
}

export class RainSplashes {
  readonly object: THREE.Mesh;
  readonly #geometry: THREE.BufferGeometry;
  readonly #material: THREE.ShaderMaterial;
  readonly #heights = new Float32Array(RAIN_SPLASH_GRID * RAIN_SPLASH_GRID);
  readonly #staging = new Float32Array(RAIN_SPLASH_GRID * RAIN_SPLASH_GRID);
  readonly #heightTexture: THREE.DataTexture;
  readonly #uniforms: Record<string, IUniform>;
  #gridX = Number.NaN;
  #gridZ = Number.NaN;
  #gridFloor = Number.NaN;
  #gridOnTerrain = false;
  #regrid: SplashRegrid | undefined;
  #clock = 0;

  constructor() {
    this.#geometry = buildSplashGeometry(RAIN_SPLASH_CAPACITY);
    this.#heightTexture = new THREE.DataTexture(
      this.#heights, RAIN_SPLASH_GRID, RAIN_SPLASH_GRID, THREE.RedFormat, THREE.FloatType,
    );
    this.#heightTexture.minFilter = THREE.NearestFilter;
    this.#heightTexture.magFilter = THREE.NearestFilter;
    this.#heightTexture.generateMipmaps = false;
    this.#heightTexture.needsUpdate = true;
    this.#uniforms = {
      uMap: { value: null },
      uHeights: { value: this.#heightTexture },
      uTime: { value: 0 },
      uRate: { value: 2.8 },
      uRadius: { value: RAIN_SPLASH_RADIUS },
      uInnerRadius: { value: RAIN_SPLASH_INNER_RADIUS },
      uInnerShare: { value: RAIN_SPLASH_INNER_SHARE },
      uSize: { value: 0.46 },
      uCentre: { value: new THREE.Vector2() },
      uGridOrigin: { value: new THREE.Vector2() },
      uGridSize: { value: RAIN_SPLASH_GRID },
      uCell: { value: RAIN_SPLASH_CELL },
      uLight: { value: new THREE.Color(1, 1, 1) },
      uOpacity: { value: 0 },
    };
    this.#material = new THREE.ShaderMaterial({
      uniforms: this.#uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      // The billboard's winding depends on which side of it the camera is; never cull it.
      side: THREE.DoubleSide,
    });
    this.object = new THREE.Mesh(this.#geometry, this.#material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 4;
    this.object.visible = false;
    this.object.matrixAutoUpdate = false;
  }

  get geometry(): THREE.BufferGeometry { return this.#geometry; }
  get material(): THREE.ShaderMaterial { return this.#material; }
  get heightTexture(): THREE.DataTexture { return this.#heightTexture; }
  /** Whether a height-grid rebuild is under way (diagnostics and tests). */
  get regridding(): boolean { return this.#regrid !== undefined; }
  /** Scene-space centre of the grid in use. */
  get gridCentre(): { x: number; z: number } { return { x: this.#gridX, z: this.#gridZ }; }

  /**
   * `feet` is the character in scene space; `density` 0..1 of rain landing (0 hides the field);
   * `quality` 0.25..1 scales the count; `flying` (22.10, 7.45) lays the field on the ground below.
   */
  update(
    feet: THREE.Vector3, heightAt: HeightSampler | undefined, elapsed: number, density: number,
    texture: THREE.Texture | null, light: THREE.Color, quality: number, flying = false,
  ): void {
    const d = Math.max(0, Math.min(1, density));
    if (d <= 0 || !texture) {
      this.object.visible = false;
      this.#geometry.setDrawRange(0, 0);
      return;
    }
    this.#advanceGrid(feet, heightAt, flying);
    this.#clock += Math.max(0, Math.min(0.25, elapsed));
    const u = this.#uniforms;
    u["uMap"]!.value = texture;
    u["uTime"]!.value = this.#clock;
    (u["uCentre"]!.value as THREE.Vector2).set(feet.x, feet.z);
    (u["uLight"]!.value as THREE.Color).copy(light);
    u["uOpacity"]!.value = 0.6 + 0.35 * d;
    const count = Math.round(RAIN_SPLASH_CAPACITY * (0.25 + 0.75 * d) * Math.max(0.25, Math.min(1, quality)));
    this.#geometry.setDrawRange(0, count * 6);
    this.object.visible = count > 0;
  }

  /**
   * The first grid is built at once; later ones a few rows a frame into the staging buffer while
   * the grid in use — six yards wider than the field — keeps serving, then swapped in whole.
   */
  #advanceGrid(feet: THREE.Vector3, heightAt: HeightSampler | undefined, flying: boolean): void {
    if (Number.isNaN(this.#gridX)) {
      const onTerrain = fillSplashHeights(this.#heights, feet.x, feet.z, feet.y, heightAt, flying);
      this.#adoptGrid(feet.x, feet.z, feet.y, onTerrain);
      return;
    }
    // 22.10 (7.45): the character's height only matters to a flat grid (or when the field moves
    // between flat and terrain). A grid on the terrain is the same at any height of the feet, so a
    // climbing flyer no longer restarts the rebuild every frame and never finishes it.
    const onTerrain = splashesOnTerrain(feet.x, feet.z, feet.y, heightAt, flying);
    const away = (x: number, z: number, floorY: number, terrain: boolean): boolean =>
      !(Math.hypot(feet.x - x, feet.z - z) < RAIN_SPLASH_REGRID_YARDS) || terrain !== onTerrain
      || (!onTerrain && !(Math.abs(feet.y - floorY) < 0.6));
    const regrid = this.#regrid;
    if (away(this.#gridX, this.#gridZ, this.#gridFloor, this.#gridOnTerrain)
      && (!regrid || away(regrid.centreX, regrid.centreZ, regrid.floorY, regrid.onTerrain))) {
      // Start (or restart, if the character has outrun the one under way) a rebuild here.
      this.#regrid = { centreX: feet.x, centreZ: feet.z, floorY: feet.y, onTerrain, row: 0 };
    }
    const job = this.#regrid;
    if (!job) return;
    const end = Math.min(RAIN_SPLASH_GRID, job.row + RAIN_SPLASH_ROWS_PER_FRAME);
    fillSplashHeightRows(this.#staging, job.centreX, job.centreZ, job.floorY, heightAt, job.onTerrain, job.row, end);
    job.row = end;
    if (job.row < RAIN_SPLASH_GRID) return;
    this.#heights.set(this.#staging);
    this.#adoptGrid(job.centreX, job.centreZ, job.floorY, job.onTerrain);
    this.#regrid = undefined;
  }

  #adoptGrid(centreX: number, centreZ: number, floorY: number, onTerrain: boolean): void {
    this.#gridOnTerrain = onTerrain;
    this.#gridX = centreX;
    this.#gridZ = centreZ;
    this.#gridFloor = floorY;
    this.#heightTexture.needsUpdate = true;
    const half = (RAIN_SPLASH_GRID * RAIN_SPLASH_CELL) / 2;
    (this.#uniforms["uGridOrigin"]!.value as THREE.Vector2).set(centreX - half, centreZ - half);
  }

  reset(): void {
    this.#clock = 0;
    this.#gridX = Number.NaN;
    this.#gridZ = Number.NaN;
    this.#gridFloor = Number.NaN;
    this.#regrid = undefined;
    this.object.visible = false;
    this.#geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.object.visible = false;
    this.#uniforms["uMap"]!.value = null;
    this.#geometry.dispose();
    this.#material.dispose();
    this.#heightTexture.dispose();
  }
}
