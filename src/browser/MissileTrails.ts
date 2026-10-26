import * as THREE from "three";
import type { WvmModel } from "./Wvm.js";

/**
 * 26.10 (6.27, test version, owner: «Шлейфы снарядов… Интересно»): «Шлейфы снарядов (опыт)».
 *
 * A Fireball, a Frostbolt or a Shadow Bolt is a small sprite cluster in flight; whatever trail it has is what its
 * own emitters leave, which at speed is a few separate puffs. This draws behind each glowing missile a soft
 * additive ribbon through the points it passed in the last {@link MISSILE_TRAIL_SECONDS}: widest at the head,
 * narrowing and fading to nothing at the tail, in the colour of the missile's own particles. A missile that lands
 * leaves its trail to fade out over the same time. Missiles without particles (arrows, bullets, thrown weapons) get
 * none — they keep the client's look. Only the enhanced profile, off by default.
 *
 * One mesh for every trail, rebuilt on the CPU each frame (a missile is a handful of points), camera-facing: each
 * point's side vector is the trail's direction crossed with the view direction.
 */

/** How long a point of the trail lives. */
export const MISSILE_TRAIL_SECONDS = 0.25;
/** Half the trail's width at the head, in yards, before the missile's own scale. */
export const MISSILE_TRAIL_HALF_WIDTH = 0.24;
/** The trail's light at the head, over its colour (additive). */
export const MISSILE_TRAIL_INTENSITY = 0.9;
/** A new point only when the missile has moved this far, in yards (a slow missile keeps a short trail). */
const MIN_STEP = 0.12;
const MAX_POINTS = 40;
const MAX_TRAILS = 48;

interface Point { x: number; y: number; z: number; t: number }

interface Trail {
  readonly points: Point[];
  readonly colour: THREE.Color;
  readonly halfWidth: number;
}

/**
 * The colour a missile's trail takes: the mean of its particle emitters' colour ramps, weighted by their opacity
 * ramps, normalised so its brightest channel is 1. Undefined for a model without emitters (no trail).
 */
export function missileTrailColour(model: Pick<WvmModel, "particleEmitters">): THREE.Color | undefined {
  let red = 0, green = 0, blue = 0, weight = 0;
  for (const emitter of model.particleEmitters) {
    const colours = emitter.color.values;
    const alphas = emitter.opacity.values;
    const count = Math.floor(colours.length / 3);
    for (let index = 0; index < count; index++) {
      const alpha = alphas.length > 0 ? alphas[Math.min(index, alphas.length - 1)]! : 1;
      red += colours[index * 3]! * alpha;
      green += colours[index * 3 + 1]! * alpha;
      blue += colours[index * 3 + 2]! * alpha;
      weight += alpha;
    }
  }
  if (model.particleEmitters.length === 0) return undefined;
  if (!(weight > 0)) return new THREE.Color(1, 0.95, 0.85);
  const peak = Math.max(red, green, blue);
  if (!(peak > 0)) return undefined;
  return new THREE.Color(red / peak, green / peak, blue / peak);
}

const VERTEX = `
attribute vec4 trailColour;
attribute float trailEdge;
varying vec4 vColour;
varying float vEdge;
void main() {
  vColour = trailColour;
  vEdge = trailEdge;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAGMENT = `
varying vec4 vColour;
varying float vEdge;
void main() {
  // A soft cross-section, full at the middle and nothing at the edges, with a hot core that whitens toward the
  // centre (a burning trail is brightest along its axis).
  float across = exp(-vEdge * vEdge * 3.0);
  float core = exp(-vEdge * vEdge * 14.0);
  vec3 colour = mix(vColour.rgb, vec3(1.0), 0.55 * core);
  gl_FragColor = vec4(colour * vColour.a * across, 1.0);
}`;

export class MissileTrails {
  readonly mesh: THREE.Mesh;
  readonly #trails = new Map<object, Trail>();
  readonly #positions = new Float32Array(MAX_TRAILS * MAX_POINTS * 2 * 3);
  readonly #colours = new Float32Array(MAX_TRAILS * MAX_POINTS * 2 * 4);
  readonly #edges = new Float32Array(MAX_TRAILS * MAX_POINTS * 2);
  readonly #geometry = new THREE.BufferGeometry();
  #enabled = false;

  constructor() {
    this.#geometry.setAttribute("position", new THREE.BufferAttribute(this.#positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.#geometry.setAttribute("trailColour", new THREE.BufferAttribute(this.#colours, 4).setUsage(THREE.DynamicDrawUsage));
    this.#geometry.setAttribute("trailEdge", new THREE.BufferAttribute(this.#edges, 1).setUsage(THREE.DynamicDrawUsage));
    const indices = new Uint32Array(MAX_TRAILS * (MAX_POINTS - 1) * 6);
    let at = 0;
    for (let trail = 0; trail < MAX_TRAILS; trail++) {
      for (let point = 0; point < MAX_POINTS - 1; point++) {
        const a = (trail * MAX_POINTS + point) * 2;
        indices.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], at);
        at += 6;
      }
    }
    this.#geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.#geometry.setDrawRange(0, 0);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.#geometry, material);
    this.mesh.name = "missileTrails";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3; // with the particles: transparent, after the world
    this.mesh.visible = false;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled) {
      this.#trails.clear();
      this.mesh.visible = false;
      this.#geometry.setDrawRange(0, 0);
    }
  }

  /** The missile `key` is at scene `position` now; `colour` undefined: no trail for it. */
  sample(key: object, position: THREE.Vector3, nowMs: number, colour: THREE.Color | undefined, scale: number): void {
    if (!this.#enabled || !colour) return;
    let trail = this.#trails.get(key);
    if (!trail) {
      if (this.#trails.size >= MAX_TRAILS) return;
      trail = { points: [], colour, halfWidth: MISSILE_TRAIL_HALF_WIDTH * Math.min(2.5, Math.max(0.5, scale)) };
      this.#trails.set(key, trail);
    }
    const points = trail.points;
    const head = points[points.length - 1];
    if (head && Math.hypot(position.x - head.x, position.y - head.y, position.z - head.z) < MIN_STEP) {
      // Too close for a new point: the head follows the missile.
      head.x = position.x; head.y = position.y; head.z = position.z; head.t = nowMs;
      return;
    }
    points.push({ x: position.x, y: position.y, z: position.z, t: nowMs });
    if (points.length > MAX_POINTS) points.shift();
  }

  /** Ages the trails and rebuilds the mesh for this frame's camera. */
  update(nowMs: number, camera: THREE.Camera): void {
    if (!this.#enabled) return;
    const life = MISSILE_TRAIL_SECONDS * 1000;
    let quads = 0;
    let slot = 0;
    const eye = camera.position;
    for (const [key, trail] of this.#trails) {
      const points = trail.points;
      // A landed missile is sampled no more: its points age out over the trail's life, and then it goes.
      while (points.length > 0 && nowMs - points[0]!.t > life) points.shift();
      if (points.length === 0) {
        this.#trails.delete(key);
        continue;
      }
      if (points.length < 2) continue;
      const base = slot * MAX_POINTS * 2;
      for (let index = 0; index < points.length; index++) {
        const point = points[index]!;
        const before = points[Math.max(0, index - 1)]!;
        const after = points[Math.min(points.length - 1, index + 1)]!;
        const dx = after.x - before.x, dy = after.y - before.y, dz = after.z - before.z;
        const vx = eye.x - point.x, vy = eye.y - point.y, vz = eye.z - point.z;
        let sx = dy * vz - dz * vy, sy = dz * vx - dx * vz, sz = dx * vy - dy * vx;
        const length = Math.hypot(sx, sy, sz) || 1;
        const age = Math.min(1, Math.max(0, (nowMs - point.t) / life));
        const fresh = 1 - age;
        const half = trail.halfWidth * (0.25 + 0.75 * fresh);
        sx = (sx / length) * half; sy = (sy / length) * half; sz = (sz / length) * half;
        const alpha = MISSILE_TRAIL_INTENSITY * fresh * fresh;
        const at = base + index * 2;
        this.#positions.set([point.x + sx, point.y + sy, point.z + sz, point.x - sx, point.y - sy, point.z - sz], at * 3);
        const { r, g, b } = trail.colour;
        this.#colours.set([r, g, b, alpha, r, g, b, alpha], at * 4);
        this.#edges[at] = -1;
        this.#edges[at + 1] = 1;
      }
      // Indices are laid out per slot: only the first points.length - 1 quads of this slot are drawn, so the slot's
      // unused quads must collapse — their vertices are written onto the last point.
      const last = base + (points.length - 1) * 2;
      for (let index = points.length; index < MAX_POINTS; index++) {
        const at = base + index * 2;
        this.#positions.copyWithin(at * 3, last * 3, last * 3 + 6);
        this.#colours.fill(0, at * 4, at * 4 + 8);
      }
      quads = (slot + 1) * (MAX_POINTS - 1);
      slot++;
      if (slot >= MAX_TRAILS) break;
    }
    this.#geometry.setDrawRange(0, quads * 6);
    for (const name of ["position", "trailColour", "trailEdge"]) {
      (this.#geometry.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
    this.mesh.visible = quads > 0;
  }

  /** Trails alive (tests and diagnostics). */
  get count(): number {
    return this.#trails.size;
  }

  dispose(): void {
    this.#geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
