// 05.10-A7a-E (6.13): chain beams — SpellChainEffects rows named by a kit's CharProc 0/12 slots — drawn between
// two attachment points. 13.10: the whole of Wow.exe's CLightning (LightningBeam.ts: joints, majors and minors,
// waves, arcs, flicker, pulses, the texture's scroll and repeat, the pinched ends) replaces the first slice's
// straight band; the plan (which segments, when, between which attachments) is ChainBeamPlan.ts.
//
// Settled 13.10 against Wow.exe (0x009a9900, 0x009aa210, 0x00ad8b7c; the old hypotheses checked): the first
// colour byte is alpha and the next three red, green, blue; TexCoordScale is the scroll in texture repeats a
// second, subtracted (u' = u · S − (phase + scroll) — a negative scale flows from the far end to the near one,
// the drain beams to their caster); TextureLength repeats the texture only with Flags 0x100 (else it spans the
// beam once); BlendMode is the engine's GxBlend — 2 alpha, 3 add, 4 mod, 5 mod2x, 6 modAdd — with an alpha
// test of 1/255 (224/255 for 1); the band is ±Width wide (twice the old width).
//
// One pooled mesh per live beam, its vertices rewritten in place each frame (grown, never shrunk, up to
// 2 · LIGHTNING_MAX_JOINTS); the texture is a lease on the renderer's spell texture cache, released with the
// beam.

import * as THREE from "three";
import type { SpellChainEffect } from "../gateway/SpellVisual.js";
import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { WorldState } from "../world/WorldState.js";
import { LightningBeam, lightningAlphaReference } from "./LightningBeam.js";

export type { SpellChainEffect };

export interface BeamPoint {
  x: number;
  y: number;
  z: number;
}

/** One end of a planned beam: a unit's attachment (moved by `offset` in its frame), else `point`. */
export interface VisualBeamEnd {
  readonly guid?: bigint;
  /** The caster whose UNIT_FIELD_CHANNEL_OBJECT this end is, read every frame (MSG_CHANNEL_START names none). */
  readonly channelOf?: bigint;
  /** −1: none (0.75 of the unit's height). */
  readonly attachment: number;
  readonly offset?: readonly [number, number, number];
  readonly point?: BeamPoint;
}

/** One planned beam segment, in server coordinates with absolute times. */
export interface VisualBeam {
  readonly effect: SpellChainEffect;
  readonly from: VisualBeamEnd & { readonly guid: bigint; readonly point: BeamPoint };
  readonly to: VisualBeamEnd;
  readonly startedAt: number;
  endsAt: number;
  /** Shown for as long as its kit (CharParamTwo); `endsAt` is the kit's end. */
  readonly persistent?: boolean;
}

/** Where the renderer finds a unit's attachment now (server coordinates). */
export interface BeamPoints {
  point(guid: bigint, attachment: number, out: BeamPoint, offset?: readonly [number, number, number]): boolean;
}

/** A texture lease from the renderer's cache. */
export interface BeamTextureLease {
  readonly texture: THREE.Texture;
  release(): void;
}

/** Beams never drawn at once beyond this (the oldest is dropped), and pooled meshes kept beyond it are freed. */
export const BEAM_CAPACITY = 64;

/**
 * 05.10 review E: the path a beam texture loads from. Six SpellChainEffects rows name a `.tga`; the client
 * loads every texture as `.blp` (FrameXmlTextures.ts records the same substitution), and the gateway's
 * `/texture` answers 400 to anything else — `SummonGhoulsLightning.tga` exists only as `.blp`.
 */
export function beamTexturePath(path: string): string {
  return /\.tga$/i.test(path) ? `${path.slice(0, -4)}.blp` : path;
}

/** 13.10: a GxBlend onto a material (0x009aa210 render state 6; 0x00ad8b7c alpha reference). */
export function applyBeamBlend(material: THREE.Material, mode: number): void {
  material.blendSrc = THREE.SrcAlphaFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  if (mode === 0 || mode === 1) material.blending = THREE.NoBlending;
  else if (mode === 3) material.blending = THREE.AdditiveBlending; // GxBlend_Add: src · α + dst
  else if (mode === 4) {
    material.blending = THREE.CustomBlending; // GxBlend_Mod: src · dst
    material.blendSrc = THREE.DstColorFactor;
    material.blendDst = THREE.ZeroFactor;
  } else if (mode === 5) {
    material.blending = THREE.CustomBlending; // GxBlend_Mod2x: src · dst + dst · src
    material.blendSrc = THREE.DstColorFactor;
    material.blendDst = THREE.SrcColorFactor;
  } else if (mode === 6) {
    material.blending = THREE.CustomBlending; // GxBlend_ModAdd: src · dst + dst
    material.blendSrc = THREE.DstColorFactor;
    material.blendDst = THREE.OneFactor;
  } else material.blending = THREE.NormalBlending; // GxBlend_Alpha
  material.alphaTest = lightningAlphaReference(mode) / 255;
}

/** The blend of a BlendMode byte, as three names it (CustomBlending for 4, 5 and 6). */
export function beamBlending(mode: number): THREE.Blending {
  if (mode === 0 || mode === 1) return THREE.NoBlending;
  if (mode === 3) return THREE.AdditiveBlending;
  if (mode >= 4 && mode <= 6) return THREE.CustomBlending;
  return THREE.NormalBlending;
}

/** Colour and opacity from the four colour bytes: alpha, red, green, blue (0x009a9900). */
export function beamColour(color: readonly number[], out: THREE.Color): number {
  out.setRGB((color[1] ?? 255) / 255, (color[2] ?? 255) / 255, (color[3] ?? 255) / 255, THREE.SRGBColorSpace);
  return (color[0] ?? 255) / 255;
}

/** The caster's channel object (UNIT_FIELD_CHANNEL_OBJECT), or undefined. */
export function channelObjectOf(state: WorldState | undefined, guid: bigint): bigint | undefined {
  const fields = state?.objects.get(guid)?.fields;
  if (!fields) return undefined;
  const offset = UPDATE_FIELDS.UNIT_FIELD_CHANNEL_OBJECT.offset;
  const low = fields.get(offset) ?? 0;
  const high = fields.get(offset + 1) ?? 0;
  const value = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
  return value === 0n ? undefined : value;
}

interface PooledBeam {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  /** Vertices the buffers hold. */
  capacity: number;
  positions: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
}

interface LiveBeam {
  readonly handle: unknown;
  readonly beam: VisualBeam;
  pooled: PooledBeam | undefined;
  lease: BeamTextureLease | undefined;
  lightning: LightningBeam | undefined;
  lastAt: number;
}

const _a = { x: 0, y: 0, z: 0 };
const _b = { x: 0, y: 0, z: 0 };
const _eye = { x: 0, y: 0, z: 0 };
/** Server-frame scratch for one beam's vertices (grown on demand). */
let _positions = new Float32Array(0);
let _uvs = new Float32Array(0);
let _alphas = new Float32Array(0);

/** The live beams of the renderer, keyed by the spell-visual handle that owns them. */
export class ChainBeams {
  readonly #group: THREE.Object3D;
  readonly #texture: (path: string) => BeamTextureLease | undefined;
  readonly #live: LiveBeam[] = [];
  readonly #pool: PooledBeam[] = [];
  readonly #random: () => number;

  constructor(group: THREE.Object3D, texture: (path: string) => BeamTextureLease | undefined, random: () => number = Math.random) {
    this.#group = group;
    this.#texture = texture;
    this.#random = random;
  }

  get size(): number {
    return this.#live.length;
  }

  add(handle: unknown, beams: readonly VisualBeam[]): void {
    for (const beam of beams) {
      if (this.#live.length >= BEAM_CAPACITY) this.#release(0);
      this.#live.push({ handle, beam, pooled: undefined, lease: undefined, lightning: undefined, lastAt: Number.NaN });
    }
  }

  cancel(handle: unknown): void {
    for (let index = this.#live.length - 1; index >= 0; index--) {
      if (this.#live[index]!.handle === handle) this.#release(index);
    }
  }

  /** A channel or cast whose end moved: its persistent beams end then (a timed segment keeps its window). */
  retime(handle: unknown, endsAt: number): void {
    for (const live of this.#live) {
      if (live.handle !== handle) continue;
      if (live.beam.persistent || endsAt < live.beam.endsAt) live.beam.endsAt = endsAt;
    }
  }

  clear(): void {
    for (let index = this.#live.length - 1; index >= 0; index--) this.#release(index);
  }

  /** Places every live beam for this frame (`eye` in scene coordinates); drops the finished ones. */
  update(now: number, points: BeamPoints, state: WorldState | undefined, eye: THREE.Vector3): void {
    _eye.x = eye.x;
    _eye.y = -eye.z;
    _eye.z = eye.y;
    for (let index = this.#live.length - 1; index >= 0; index--) {
      const live = this.#live[index]!;
      const beam = live.beam;
      if (now >= beam.endsAt) {
        this.#release(index);
        continue;
      }
      const visible = now >= beam.startedAt && this.#ends(beam, points, state);
      if (!visible) {
        if (live.pooled) live.pooled.mesh.visible = false;
        live.lastAt = Number.NaN; // 0x009ab3b0 runs only while shown
        continue;
      }
      const pooled = live.pooled ?? this.#attach(live);
      // 05.10 review E: drawn only once its texture has an image — a pending or missing texture would
      // sample black and show an opaque dark band; the wrap is set then, so no upload is asked for early.
      if (!this.#textureReady(live)) {
        pooled.mesh.visible = false;
        continue;
      }
      const lightning = live.lightning ??= new LightningBeam(beam.effect, this.#random);
      const dt = Number.isNaN(live.lastAt) ? 0 : Math.max(0, now - live.lastAt) / 1000;
      live.lastAt = now;
      lightning.update(dt, _a, _b);
      const vertices = this.#build(lightning, pooled);
      pooled.mesh.visible = vertices > 0;
    }
  }

  /** The band into the mesh (server → scene); the vertex count drawn. */
  #build(lightning: LightningBeam, pooled: PooledBeam): number {
    const needed = Math.max(4, lightning.joints.length * 2);
    if (_positions.length < needed * 3) {
      _positions = new Float32Array(needed * 3);
      _uvs = new Float32Array(needed * 2);
      _alphas = new Float32Array(needed);
    }
    const vertices = lightning.build(_a, _b, _eye, _positions, _uvs, _alphas);
    if (vertices < 4) return 0;
    if (pooled.capacity < vertices) growPooledBeam(pooled, vertices);
    const positions = pooled.positions;
    const uvs = pooled.uvs;
    const colors = pooled.colors;
    for (let vertex = 0; vertex < vertices; vertex++) {
      positions[vertex * 3] = _positions[vertex * 3]!;
      positions[vertex * 3 + 1] = _positions[vertex * 3 + 2]!;
      positions[vertex * 3 + 2] = -_positions[vertex * 3 + 1]!;
      uvs[vertex * 2] = _uvs[vertex * 2]!;
      uvs[vertex * 2 + 1] = _uvs[vertex * 2 + 1]!;
      colors[vertex * 4 + 3] = _alphas[vertex]!;
    }
    const geometry = pooled.mesh.geometry;
    geometry.attributes["position"]!.needsUpdate = true;
    geometry.attributes["uv"]!.needsUpdate = true;
    geometry.attributes["color"]!.needsUpdate = true;
    geometry.setDrawRange(0, (vertices / 2 - 1) * 6);
    return vertices;
  }

  /** Both ends now, into `_a` and `_b`; false when the far end is unknown (a channel with no object yet). */
  #ends(beam: VisualBeam, points: BeamPoints, state: WorldState | undefined): boolean {
    const from = beam.from;
    if (!points.point(from.guid, from.attachment, _a, from.offset)) {
      _a.x = from.point.x; _a.y = from.point.y; _a.z = from.point.z;
    }
    const to = beam.to;
    const guid = to.channelOf !== undefined ? channelObjectOf(state, to.channelOf) : to.guid;
    if (guid !== undefined && guid !== 0n && points.point(guid, to.attachment, _b, to.offset)) return true;
    if (to.channelOf !== undefined || !to.point) return false;
    _b.x = to.point.x; _b.y = to.point.y; _b.z = to.point.z;
    return true;
  }

  #attach(live: LiveBeam): PooledBeam {
    const pooled = this.#pool.pop() ?? createPooledBeam();
    const effect = live.beam.effect;
    const material = pooled.mesh.material;
    live.lease = this.#texture(beamTexturePath(effect.texture)); // 05.10 review E: .tga → .blp
    material.map = live.lease?.texture ?? null;
    beamColour(effect.color, material.color); // the alpha rides the vertices (LightningBeam #alphas)
    applyBeamBlend(material, effect.blendMode);
    material.needsUpdate = true;
    pooled.mesh.visible = false;
    this.#group.add(pooled.mesh);
    live.pooled = pooled;
    return pooled;
  }

  /** 05.10 review E: the lease's image has landed (wrap set once it has); no lease draws untextured. */
  #textureReady(live: LiveBeam): boolean {
    const texture = live.lease?.texture;
    if (!texture) return true; // no lease at all: drawn untextured, as before
    const image = texture.image as { width?: number } | null | undefined;
    if (!image || !(Number(image.width) > 0)) return false;
    if (texture.wrapS !== THREE.RepeatWrapping) {
      texture.wrapS = THREE.RepeatWrapping;
      texture.needsUpdate = true;
    }
    return true;
  }

  #release(index: number): void {
    const live = this.#live[index]!;
    this.#live.splice(index, 1);
    live.lease?.release();
    live.lease = undefined;
    const pooled = live.pooled;
    live.pooled = undefined;
    if (!pooled) return;
    this.#group.remove(pooled.mesh);
    pooled.mesh.material.map = null;
    if (this.#pool.length < BEAM_CAPACITY) this.#pool.push(pooled);
    else {
      pooled.mesh.geometry.dispose();
      pooled.mesh.material.dispose();
    }
  }
}

/** Vertex pairs (strip) as indexed triangles: pair i, i + 1 → (2i, 2i+1, 2i+2), (2i+2, 2i+1, 2i+3). */
function stripIndex(vertices: number): THREE.BufferAttribute {
  const pairs = vertices / 2 - 1;
  const index = new Uint16Array(Math.max(0, pairs) * 6);
  for (let pair = 0; pair < pairs; pair++) {
    const a = pair * 2;
    index.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], pair * 6);
  }
  return new THREE.BufferAttribute(index, 1);
}

function growPooledBeam(pooled: PooledBeam, vertices: number): void {
  let capacity = Math.max(4, pooled.capacity);
  while (capacity < vertices) capacity *= 2;
  const geometry = pooled.mesh.geometry;
  pooled.capacity = capacity;
  pooled.positions = new Float32Array(capacity * 3);
  pooled.uvs = new Float32Array(capacity * 2);
  pooled.colors = new Float32Array(capacity * 4).fill(1);
  geometry.setAttribute("position", new THREE.BufferAttribute(pooled.positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("uv", new THREE.BufferAttribute(pooled.uvs, 2).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("color", new THREE.BufferAttribute(pooled.colors, 4).setUsage(THREE.DynamicDrawUsage));
  geometry.setIndex(stripIndex(capacity));
}

function createPooledBeam(): PooledBeam {
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, vertexColors: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.name = "chain-beam";
  const pooled: PooledBeam = { mesh, capacity: 0, positions: new Float32Array(0), uvs: new Float32Array(0), colors: new Float32Array(0) };
  growPooledBeam(pooled, 64);
  return pooled;
}
