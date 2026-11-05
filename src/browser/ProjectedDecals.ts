/**
 * 05.11 (6.45): the M2 batches Wow.exe never draws as a mesh, only projects down onto the ground.
 *
 * `M2Batch.flags & 4` marks them: 208 models under `Spells\` and 61 others, the ground circles of Flamestrike, Blizzard, Consecration and
 * the auras, drawn flat and level by this renderer, so they hung in the air over any slope. In Wow.exe a world scene hands
 * such a batch to a callback (`CM2Scene` +0x104, 0x0077F500, while the setting `projectedTextures` is on):
 *
 * - 0x008292A0 runs the section's vertices through their bones. Their box is the decal's box, and the first three give the
 *   plane that turns a point's x and y into the texture's u and v. Under four vertices, or with three in a line, nothing draws.
 * - The box grows two yards up and two down (0x00820803). A second texture of 64 by 8 fades the decal by height across it:
 *   full strength through the middle two thirds, nothing at the box's top and bottom (0x007E36E0).
 * - 0x007E3AA0 collects the triangles in the box, whole, and draws them with the batch's texture: 0x007A6AF0 with the flags
 *   0x200122 asks for the terrain and the WMO groups only. On the stand a rune lay on a slope and on an inn's floor, in 8 and
 *   28 triangles, and left a wooden dock (an M2) bare. Units get none either. No culling, no depth write, a small depth bias.
 *
 * So here: the same box and plane each frame, and a list of the same triangles, read again when the box leaves what was
 * read or every two seconds for tiles and groups that have come in since. Frost Nova on the stand streaks a house's wall
 * as it does the ground: nothing is asked of a triangle's facing.
 */

import * as THREE from "three";
import { TERRAIN_GRID_SIZE } from "./Terrain.js";

export const BATCH_FLAG_PROJECTED = 4;

/** What a projected batch keeps instead of a group in its model's geometry. */
export interface ProjectedBatch {
  readonly material: THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
  /** The section's vertices in file order: the first three are the plane's. */
  readonly vertices: Uint32Array;
}

/** How far the decal's box is grown, up and down (0xA4040C). */
export const DECAL_BOX_GROWTH = 2;
/** The fade texture runs 12 steps over the box's height, two of them rising and two falling (0x007E36E0). */
export const DECAL_FADE_STEPS = 6;
const MIN_VERTICES = 4;
const MIN_SPAN = 2.384185791015625e-7;
/** How much more than the box a reading takes, so a slow mover is not read again every frame. */
const READ_MARGIN = 1.5;
const READ_AGAIN_SECONDS = 2;
const MAX_TRIANGLES = 16384;
const TERRAIN_CELLS_PER_TILE = 128;
const TERRAIN_GRID_CENTER = 32;

/** The section's distinct vertices, ascending, out of its stretch of the index list. */
export function sectionVertices(index: ArrayLike<number>, start: number, count: number): Uint32Array {
  const seen = new Set<number>();
  for (let at = start; at < start + count; at++) seen.add(index[at]!);
  return Uint32Array.from(seen).sort();
}

/** u = a x + b y + c, v = d x + e y + f. */
export interface PlanarMapping {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** The plane through three vertices, in `[x, y, u, v]` fours; `false` when they lie in a line. */
export function planarMapping(points: ArrayLike<number>, out: PlanarMapping): boolean {
  const ax = points[0]!, ay = points[1]!, au = points[2]!, av = points[3]!;
  const bx = points[4]! - ax, by = points[5]! - ay, bu = points[6]! - au, bv = points[7]! - av;
  const cx = points[8]! - ax, cy = points[9]! - ay, cu = points[10]! - au, cv = points[11]! - av;
  const determinant = bx * cy - by * cx;
  if (Math.abs(determinant) < MIN_SPAN) return false;
  out.a = (bu * cy - cu * by) / determinant;
  out.b = (cu * bx - bu * cx) / determinant;
  out.c = au - out.a * ax - out.b * ay;
  out.d = (bv * cy - cv * by) / determinant;
  out.e = (cv * bx - bv * cx) / determinant;
  out.f = av - out.d * ax - out.e * ay;
  return true;
}

/** Strength at a fraction of the grown box's height. */
export function decalHeightFade(fraction: number): number {
  return Math.max(0, Math.min(1, DECAL_FADE_STEPS * fraction, DECAL_FADE_STEPS * (1 - fraction)));
}

/** A box in world axes, z up. */
export interface WorldBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export type FacetSink = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) => void;

/** The terrain a decal reads: what is already resident, never a download. */
export interface DecalTerrain {
  height(x: number, y: number): number | undefined;
  isHole(x: number, y: number): boolean;
}

/** Every terrain triangle touching the box, whole: a cell is four, round its centre. */
export function terrainFacets(box: WorldBox, terrain: DecalTerrain, sink: FacetSink): void {
  const step = TERRAIN_GRID_SIZE / TERRAIN_CELLS_PER_TILE;
  const cellOf = (world: number): number => TERRAIN_CELLS_PER_TILE * (TERRAIN_GRID_CENTER - world / TERRAIN_GRID_SIZE);
  const fromI = Math.floor(cellOf(box.maxX)), toI = Math.ceil(cellOf(box.minX));
  const fromJ = Math.floor(cellOf(box.maxY)), toJ = Math.ceil(cellOf(box.minY));
  const worldOf = (cell: number): number => TERRAIN_GRID_SIZE * (TERRAIN_GRID_CENTER - cell / TERRAIN_CELLS_PER_TILE);
  for (let i = fromI; i < toI; i++) {
    for (let j = fromJ; j < toJ; j++) {
      const x0 = worldOf(i), x1 = x0 - step, y0 = worldOf(j), y1 = y0 - step;
      const mx = x0 - step / 2, my = y0 - step / 2;
      if (terrain.isHole(mx, my)) continue;
      const h00 = terrain.height(x0, y0), h10 = terrain.height(x1, y0), h01 = terrain.height(x0, y1), h11 = terrain.height(x1, y1);
      const hm = terrain.height(mx, my);
      if (h00 === undefined || h10 === undefined || h01 === undefined || h11 === undefined || hm === undefined) continue;
      if (Math.max(h00, h10, h01, h11, hm) < box.minZ || Math.min(h00, h10, h01, h11, hm) > box.maxZ) continue;
      sink(mx, my, hm, x0, y0, h00, x1, y0, h10);
      sink(mx, my, hm, x1, y0, h10, x1, y1, h11);
      sink(mx, my, hm, x1, y1, h11, x0, y1, h01);
      sink(mx, my, hm, x0, y1, h01, x0, y0, h00);
    }
  }
}

const _inverse = new THREE.Matrix4();
const _corner = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Every triangle of a placed mesh touching the box, whole, in world axes. */
export function meshFacets(box: WorldBox, mesh: THREE.Mesh, sink: FacetSink): void {
  const position = mesh.geometry.getAttribute("position");
  if (position === undefined) return;
  mesh.updateWorldMatrix(true, false);
  _inverse.copy(mesh.matrixWorld).invert();
  // The box in the mesh's own axes, then a triangle's own test only for those that pass it.
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    _corner.set(corner & 1 ? box.maxX : box.minX, corner & 4 ? box.maxZ : box.minZ, -(corner & 2 ? box.maxY : box.minY)).applyMatrix4(_inverse);
    minX = Math.min(minX, _corner.x);
    minY = Math.min(minY, _corner.y);
    minZ = Math.min(minZ, _corner.z);
    maxX = Math.max(maxX, _corner.x);
    maxY = Math.max(maxY, _corner.y);
    maxZ = Math.max(maxZ, _corner.z);
  }
  // Read straight out of the arrays: a city's group runs to tens of thousands of triangles, nearly all of them out of the box.
  const interleaved = position as Partial<THREE.InterleavedBufferAttribute>;
  const array = (interleaved.data ? interleaved.data.array : position.array) as ArrayLike<number>;
  const stride = interleaved.data ? interleaved.data.stride : 3;
  const offset = interleaved.data ? interleaved.offset ?? 0 : 0;
  const indices = mesh.geometry.index?.array;
  const count = indices ? indices.length : position.count;
  for (let at = 0; at + 2 < count; at += 3) {
    const i0 = (indices ? indices[at]! : at) * stride + offset;
    const i1 = (indices ? indices[at + 1]! : at + 1) * stride + offset;
    const i2 = (indices ? indices[at + 2]! : at + 2) * stride + offset;
    const ax = array[i0]!, bx = array[i1]!, cx = array[i2]!;
    if ((ax < minX && bx < minX && cx < minX) || (ax > maxX && bx > maxX && cx > maxX)) continue;
    const ay = array[i0 + 1]!, by = array[i1 + 1]!, cy = array[i2 + 1]!;
    if ((ay < minY && by < minY && cy < minY) || (ay > maxY && by > maxY && cy > maxY)) continue;
    const az = array[i0 + 2]!, bz = array[i1 + 2]!, cz = array[i2 + 2]!;
    if ((az < minZ && bz < minZ && cz < minZ) || (az > maxZ && bz > maxZ && cz > maxZ)) continue;
    _a.set(ax, ay, az).applyMatrix4(mesh.matrixWorld);
    _b.set(bx, by, bz).applyMatrix4(mesh.matrixWorld);
    _c.set(cx, cy, cz).applyMatrix4(mesh.matrixWorld);
    if (Math.max(_a.x, _b.x, _c.x) < box.minX || Math.min(_a.x, _b.x, _c.x) > box.maxX) continue;
    if (Math.max(-_a.z, -_b.z, -_c.z) < box.minY || Math.min(-_a.z, -_b.z, -_c.z) > box.maxY) continue;
    if (Math.max(_a.y, _b.y, _c.y) < box.minZ || Math.min(_a.y, _b.y, _c.y) > box.maxZ) continue;
    sink(_a.x, -_a.z, _a.y, _b.x, -_b.z, _b.y, _c.x, -_c.z, _c.y);
  }
}

const VERTEX = /* glsl */ `
uniform vec3 decalU;
uniform vec3 decalV;
uniform mat3 decalUvTransform;
uniform vec2 decalHeights;
varying vec2 vDecalUv;
varying vec2 vDecalGround;
varying float vDecalHeight;
#include <fog_pars_vertex>
void main() {
  vDecalGround = position.xz;
  vec3 plane = vec3(dot(decalU.xy, position.xz) + decalU.z, dot(decalV.xy, position.xz) + decalV.z, 1.0);
  vDecalUv = (decalUvTransform * plane).xy;
  vDecalHeight = (position.y - decalHeights.x) / (decalHeights.y - decalHeights.x);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D decalMap;
uniform vec3 decalTint;
uniform float decalOpacity;
uniform vec4 decalBox;
varying vec2 vDecalUv;
varying vec2 vDecalGround;
varying float vDecalHeight;
#include <common>
#include <fog_pars_fragment>
void main() {
  if (vDecalGround.x < decalBox.x || vDecalGround.y < decalBox.y || vDecalGround.x > decalBox.z || vDecalGround.y > decalBox.w) discard;
  vec4 texel = texture2D(decalMap, vDecalUv);
  float fade = clamp(${DECAL_FADE_STEPS.toFixed(1)} * min(vDecalHeight, 1.0 - vDecalHeight), 0.0, 1.0);
  gl_FragColor = vec4(texel.rgb * decalTint, texel.a * decalOpacity * fade);
  if (gl_FragColor.a < 1.0 / 255.0) discard;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
  #include <premultiplied_alpha_fragment>
}`;

interface Decal {
  readonly batch: ProjectedBatch;
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  /** What the triangles were read for, in world axes; undefined until they are. */
  read: WorldBox | undefined;
  readAt: number;
  triangles: number;
}

function createDecal(batch: ProjectedBatch): Decal {
  const source = batch.material;
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      decalU: { value: new THREE.Vector3() },
      decalV: { value: new THREE.Vector3() },
      decalUvTransform: { value: new THREE.Matrix3() },
      decalHeights: { value: new THREE.Vector2(0, 1) },
      decalTint: { value: new THREE.Color(1, 1, 1) },
      decalOpacity: { value: 1 },
      decalBox: { value: new THREE.Vector4() },
    }]),
    fog: source.fog,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
    blending: source.blending,
    blendSrc: source.blendSrc,
    blendDst: source.blendDst,
    blendEquation: source.blendEquation,
    blendSrcAlpha: source.blendSrcAlpha,
    blendDstAlpha: source.blendDstAlpha,
    blendEquationAlpha: source.blendEquationAlpha,
    premultipliedAlpha: source.premultipliedAlpha,
    toneMapped: source.toneMapped,
  });
  material.uniforms["decalMap"] = { value: source.map };
  const geometry = new THREE.BufferGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  return { batch, mesh, material, read: undefined, readAt: -Infinity, triangles: 0 };
}

const _point = new THREE.Vector3();
const _plane = new Float64Array(12);
const _mapping: PlanarMapping = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 };

/** Where the world's geometry for a decal comes from this frame. */
export interface DecalWorld {
  readonly terrain: DecalTerrain | undefined;
  /** The placed WMO groups near a box. */
  readonly groups: (box: WorldBox, visit: (mesh: THREE.Mesh) => void) => void;
}

export class ProjectedDecals {
  readonly group = new THREE.Group();
  readonly #sources = new Map<THREE.Mesh, Decal[]>();
  #scratch = new Float32Array(9 * 256);
  #scratchLength = 0;

  constructor() {
    this.group.name = "projected-decals";
  }

  get activeSources(): number {
    return this.#sources.size;
  }

  /** The model drawing these batches: it has no mesh of its own for them, and a decal for as long as it stands in the scene. */
  track(mesh: THREE.Mesh, batches: readonly ProjectedBatch[] | undefined): void {
    if (batches === undefined || batches.length === 0 || this.#sources.has(mesh)) return;
    const decals = batches.map(createDecal);
    for (const decal of decals) this.group.add(decal.mesh);
    this.#sources.set(mesh, decals);
  }

  update(world: DecalWorld, now: number): void {
    const scene = this.group.parent;
    for (const [source, decals] of this.#sources) {
      let shown = true;
      let top: THREE.Object3D = source;
      for (let node: THREE.Object3D | null = source; node !== null; node = node.parent) {
        if (!node.visible) shown = false;
        top = node;
      }
      if (top !== scene) {
        for (const decal of decals) this.#dispose(decal);
        this.#sources.delete(source);
        continue;
      }
      for (const decal of decals) {
        if (!shown || !this.#place(decal, source, world, now)) decal.mesh.visible = false;
      }
    }
  }

  dispose(): void {
    for (const decals of this.#sources.values()) for (const decal of decals) this.#dispose(decal);
    this.#sources.clear();
  }

  #dispose(decal: Decal): void {
    this.group.remove(decal.mesh);
    decal.mesh.geometry.dispose();
    decal.material.dispose();
  }

  #place(decal: Decal, source: THREE.Mesh, world: DecalWorld, now: number): boolean {
    const { batch, material } = decal;
    const vertices = batch.vertices;
    if (vertices.length < MIN_VERTICES) return false;
    const geometry = source.geometry;
    const uvName = (batch.material.map?.channel ?? 0) === 1 ? "uv1" : "uv";
    const uv = geometry.getAttribute(uvName) ?? geometry.getAttribute("uv");
    if (uv === undefined) return false;
    source.updateWorldMatrix(true, false);
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let at = 0; at < vertices.length; at++) {
      const vertex = vertices[at]!;
      source.getVertexPosition(vertex, _point);
      _point.applyMatrix4(source.matrixWorld);
      const x = _point.x, y = -_point.z, z = _point.y;
      if (!Number.isFinite(x + y + z)) return false;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
      if (at < 3) {
        _plane[at * 4] = x;
        _plane[at * 4 + 1] = y;
        _plane[at * 4 + 2] = uv.getX(vertex);
        _plane[at * 4 + 3] = uv.getY(vertex);
      }
    }
    minZ -= DECAL_BOX_GROWTH;
    maxZ += DECAL_BOX_GROWTH;
    if (maxX - minX < MIN_SPAN || maxY - minY < MIN_SPAN) return false;
    // The plane's frame: the box's centre, so the small numbers stay small on the way through the shader.
    const originX = (minX + maxX) / 2, originY = (minY + maxY) / 2;
    for (let at = 0; at < 3; at++) {
      _plane[at * 4] = _plane[at * 4]! - originX;
      _plane[at * 4 + 1] = _plane[at * 4 + 1]! - originY;
    }
    if (!planarMapping(_plane, _mapping)) return false;
    const read = decal.read;
    if (read === undefined || now - decal.readAt > READ_AGAIN_SECONDS * 1000 || minX < read.minX || maxX > read.maxX
      || minY < read.minY || maxY > read.maxY || minZ < read.minZ || maxZ > read.maxZ) {
      this.#read(decal, {
        minX: minX - READ_MARGIN, minY: minY - READ_MARGIN, minZ: minZ - READ_MARGIN,
        maxX: maxX + READ_MARGIN, maxY: maxY + READ_MARGIN, maxZ: maxZ + READ_MARGIN,
      }, originX, originY, world, now);
    }
    if (decal.triangles === 0) return false;
    // The triangles sit relative to where they were read: the plane is carried over to that frame.
    const position = decal.mesh.position;
    const shiftX = position.x - originX, shiftY = -position.z - originY;
    const u = material.uniforms;
    // In the shader `position.xz` is (x, −y) from the read's frame.
    (u["decalU"]!.value as THREE.Vector3).set(_mapping.a, -_mapping.b, _mapping.a * shiftX + _mapping.b * shiftY + _mapping.c);
    (u["decalV"]!.value as THREE.Vector3).set(_mapping.d, -_mapping.e, _mapping.d * shiftX + _mapping.e * shiftY + _mapping.f);
    (u["decalHeights"]!.value as THREE.Vector2).set(minZ, maxZ);
    (u["decalBox"]!.value as THREE.Vector4).set(minX - position.x, -maxY - position.z, maxX - position.x, -minY - position.z);
    const sourceMaterial = batch.material;
    const map = sourceMaterial.map;
    u["decalMap"]!.value = map;
    if (map) (u["decalUvTransform"]!.value as THREE.Matrix3).copy(map.matrix);
    (u["decalTint"]!.value as THREE.Color).copy(sourceMaterial.color);
    u["decalOpacity"]!.value = sourceMaterial.opacity;
    decal.mesh.visible = true;
    return true;
  }

  #read(decal: Decal, box: WorldBox, originX: number, originY: number, world: DecalWorld, now: number): void {
    decal.read = box;
    decal.readAt = now;
    this.#scratchLength = 0;
    const sink: FacetSink = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
      if (this.#scratchLength >= MAX_TRIANGLES * 9) return;
      if (this.#scratchLength + 9 > this.#scratch.length) {
        const grown = new Float32Array(this.#scratch.length * 2);
        grown.set(this.#scratch);
        this.#scratch = grown;
      }
      const s = this.#scratch;
      let at = this.#scratchLength;
      s[at++] = ax - originX; s[at++] = az; s[at++] = -(ay - originY);
      s[at++] = bx - originX; s[at++] = bz; s[at++] = -(by - originY);
      s[at++] = cx - originX; s[at++] = cz; s[at++] = -(cy - originY);
      this.#scratchLength = at;
    };
    if (world.terrain) terrainFacets(box, world.terrain, sink);
    world.groups(box, (mesh) => meshFacets(box, mesh, sink));
    decal.triangles = this.#scratchLength / 9;
    const geometry = decal.mesh.geometry;
    const attribute = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (attribute === undefined || attribute.array.length < this.#scratchLength) {
      geometry.dispose();
      const capacity = Math.max(9 * 64, Math.min(MAX_TRIANGLES * 9, this.#scratchLength * 2));
      const fresh = new THREE.BufferAttribute(new Float32Array(capacity), 3).setUsage(THREE.DynamicDrawUsage);
      fresh.array.set(this.#scratch.subarray(0, this.#scratchLength));
      geometry.setAttribute("position", fresh);
    } else {
      (attribute.array as Float32Array).set(this.#scratch.subarray(0, this.#scratchLength));
      attribute.needsUpdate = true;
    }
    geometry.setDrawRange(0, this.#scratchLength / 3);
    decal.mesh.position.set(originX, 0, -originY);
  }
}
