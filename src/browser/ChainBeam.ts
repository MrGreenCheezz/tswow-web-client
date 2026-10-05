// 05.10-A7a-E (6.13): chain beams — SpellChainEffects rows named by a kit's CharProc 0/12 slots — drawn as
// a straight textured band between two attachment points (the first slice of 6.13: no joints, waves,
// noise or pulses; those wait for the joint/wave slice).
//
// What is from the data: the texture, the width (yards), the colour bytes, BlendMode, TextureLength (yards
// one texture repeat covers). What is a hypothesis (listed in the plan, checked against frames of the
// original in 14.25): the first colour byte is alpha and the next three R, G, B; TexCoordScale is a scroll
// speed in texture repeats a second (its sign — −2 on the drain beams, which flow towards the caster — is
// what suggests it); BlendMode 2 alpha, 3/4 additive, 5/6 multiplicative (the M2 blend numbering); the
// endpoints (the caster's spell hand for a cast, its chest for a channel; the target's chest).
//
// The band always faces the camera: its side vector is perpendicular to both the beam and the line to the
// camera. One pooled mesh (4 vertices) per live beam, positions and UVs rewritten in place each frame; the
// texture is a lease on the renderer's spell texture cache, released with the beam.

import * as THREE from "three";
import type { SpellChainEffect } from "../gateway/SpellVisual.js";
import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { WorldState } from "../world/WorldState.js";

export type { SpellChainEffect };

export interface BeamPoint {
  x: number;
  y: number;
  z: number;
}

/** One planned beam, in server coordinates with absolute times. */
export interface VisualBeam {
  readonly effect: SpellChainEffect;
  /** The unit it leaves from; `point` is where it was when planned. */
  readonly from: { readonly guid: bigint; readonly attachment: number; readonly point: BeamPoint };
  /**
   * Where it goes: a unit (`guid`), the caster's channel object read every frame (`channelOf`, for a channel:
   * MSG_CHANNEL_START names no target and TrinityCore sets UNIT_FIELD_CHANNEL_OBJECT just after it,
   * Spell.cpp SendChannelStart), or a fixed point.
   */
  readonly to: { readonly guid?: bigint; readonly channelOf?: bigint; readonly attachment: number; readonly point?: BeamPoint };
  readonly startedAt: number;
  endsAt: number;
}

/** Where the renderer finds a unit's attachment now (server coordinates). */
export interface BeamPoints {
  point(guid: bigint, attachment: number, out: BeamPoint): boolean;
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

/** The blend of a BlendMode byte (hypothesis: the M2 numbering). */
export function beamBlending(mode: number): THREE.Blending {
  if (mode === 3 || mode === 4) return THREE.AdditiveBlending;
  if (mode === 5 || mode === 6) return THREE.MultiplyBlending;
  return THREE.NormalBlending;
}

/** Colour and opacity from the four colour bytes (hypothesis: alpha first). */
export function beamColour(color: readonly number[], out: THREE.Color): number {
  out.setRGB((color[1] ?? 255) / 255, (color[2] ?? 255) / 255, (color[3] ?? 255) / 255, THREE.SRGBColorSpace);
  return (color[0] ?? 255) / 255;
}

/**
 * The band's four corners (scene coordinates, `positions` 12 floats) and UVs (`uvs` 8 floats) for a beam
 * from `a` to `b` (scene) seen from `eye`. Returns the beam's length; 0 draws nothing.
 */
export function beamQuad(
  a: THREE.Vector3, b: THREE.Vector3, eye: THREE.Vector3, width: number, textureLength: number, scroll: number,
  positions: Float32Array, uvs: Float32Array,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dy, dz);
  if (!(length > 1e-4)) return 0;
  // side = normalize(beam × (eye − midpoint)) · width / 2
  const mx = (a.x + b.x) / 2 - eye.x;
  const my = (a.y + b.y) / 2 - eye.y;
  const mz = (a.z + b.z) / 2 - eye.z;
  let sx = dy * mz - dz * my;
  let sy = dz * mx - dx * mz;
  let sz = dx * my - dy * mx;
  let side = Math.hypot(sx, sy, sz);
  if (!(side > 1e-8)) {
    // Looking straight down the beam: any perpendicular will do.
    sx = -dy; sy = dx; sz = 0;
    side = Math.hypot(sx, sy, sz) || 1;
  }
  const half = width / 2 / side;
  sx *= half; sy *= half; sz *= half;
  positions[0] = a.x - sx; positions[1] = a.y - sy; positions[2] = a.z - sz;
  positions[3] = a.x + sx; positions[4] = a.y + sy; positions[5] = a.z + sz;
  positions[6] = b.x - sx; positions[7] = b.y - sy; positions[8] = b.z - sz;
  positions[9] = b.x + sx; positions[10] = b.y + sy; positions[11] = b.z + sz;
  const repeats = textureLength > 0 ? length / textureLength : 1;
  uvs[0] = scroll; uvs[1] = 0;
  uvs[2] = scroll; uvs[3] = 1;
  uvs[4] = scroll + repeats; uvs[5] = 0;
  uvs[6] = scroll + repeats; uvs[7] = 1;
  return length;
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
  readonly positions: Float32Array;
  readonly uvs: Float32Array;
}

interface LiveBeam {
  readonly handle: unknown;
  readonly beam: VisualBeam;
  pooled: PooledBeam | undefined;
  lease: BeamTextureLease | undefined;
}

const _a = { x: 0, y: 0, z: 0 };
const _b = { x: 0, y: 0, z: 0 };
const _sceneA = new THREE.Vector3();
const _sceneB = new THREE.Vector3();

/** The live beams of the renderer, keyed by the spell-visual handle that owns them. */
export class ChainBeams {
  readonly #group: THREE.Object3D;
  readonly #texture: (path: string) => BeamTextureLease | undefined;
  readonly #live: LiveBeam[] = [];
  readonly #pool: PooledBeam[] = [];

  constructor(group: THREE.Object3D, texture: (path: string) => BeamTextureLease | undefined) {
    this.#group = group;
    this.#texture = texture;
  }

  get size(): number {
    return this.#live.length;
  }

  add(handle: unknown, beams: readonly VisualBeam[]): void {
    for (const beam of beams) {
      if (this.#live.length >= BEAM_CAPACITY) this.#release(0);
      this.#live.push({ handle, beam, pooled: undefined, lease: undefined });
    }
  }

  cancel(handle: unknown): void {
    for (let index = this.#live.length - 1; index >= 0; index--) {
      if (this.#live[index]!.handle === handle) this.#release(index);
    }
  }

  /** A channel or cast whose end moved: the beams it owns end then. */
  retime(handle: unknown, endsAt: number): void {
    for (const live of this.#live) if (live.handle === handle) live.beam.endsAt = endsAt;
  }

  clear(): void {
    for (let index = this.#live.length - 1; index >= 0; index--) this.#release(index);
  }

  /** Places every live beam for this frame; drops the finished ones. */
  update(now: number, points: BeamPoints, state: WorldState | undefined, eye: THREE.Vector3): void {
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
        continue;
      }
      const pooled = live.pooled ?? this.#attach(live);
      // 05.10 review E: drawn only once its texture has an image — a pending or missing texture would
      // sample black and show an opaque dark band; the wrap is set then, so no upload is asked for early.
      if (!this.#textureReady(live)) {
        pooled.mesh.visible = false;
        continue;
      }
      const effect = beam.effect;
      _sceneA.set(_a.x, _a.z, -_a.y);
      _sceneB.set(_b.x, _b.z, -_b.y);
      const scroll = ((now - beam.startedAt) / 1000) * effect.texCoordScale;
      const length = beamQuad(_sceneA, _sceneB, eye, effect.width, effect.textureLength, scroll % 1,
        pooled.positions, pooled.uvs);
      pooled.mesh.visible = length > 0;
      if (length > 0) {
        const geometry = pooled.mesh.geometry;
        geometry.attributes["position"]!.needsUpdate = true;
        geometry.attributes["uv"]!.needsUpdate = true;
      }
    }
  }

  /** Both ends now, into `_a` and `_b`; false when the far end is unknown (a channel with no object yet). */
  #ends(beam: VisualBeam, points: BeamPoints, state: WorldState | undefined): boolean {
    if (!points.point(beam.from.guid, beam.from.attachment, _a)) {
      _a.x = beam.from.point.x; _a.y = beam.from.point.y; _a.z = beam.from.point.z;
    }
    const to = beam.to;
    const guid = to.channelOf !== undefined ? channelObjectOf(state, to.channelOf) : to.guid;
    if (guid !== undefined && guid !== 0n && points.point(guid, to.attachment, _b)) return true;
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
    material.opacity = beamColour(effect.color, material.color);
    material.blending = beamBlending(effect.blendMode);
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

function createPooledBeam(): PooledBeam {
  const positions = new Float32Array(12);
  const uvs = new Float32Array(8);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2).setUsage(THREE.DynamicDrawUsage));
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  const material = new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.name = "chain-beam";
  return { mesh, positions, uvs };
}
