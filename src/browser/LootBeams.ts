/**
 * 26.10: «Лучи над добычей» — a small golden beam over every body the server marks as lootable for this viewer.
 *
 * Owner, 26.10: «тела что можно обыскать выглядят не броско». The mark is `UNIT_DYNFLAG_LOOTABLE` (`isLootable`,
 * Fields.ts), which the core already writes per viewer, so a beam shows exactly where the loot cursor would: a
 * body someone else may loot shows nothing. Indication only, like the bit itself — the click never reads it.
 *
 * Two open cylinders per body, drawn instanced in one pass each: a soft outer glow and a thin bright core, both
 * fading upward and toward their silhouette, with a slow shimmer rising through them. A beam fades in when the
 * mark arrives and out when it leaves (the body looted, or out of sight), never cuts. Not Wow.exe's: off in the
 * comparison profile.
 */
import * as THREE from "three";

/** Bodies with a beam at once; past it the nearest ones keep theirs. */
export const LOOT_BEAM_LIMIT = 32;
/** The beam's height above the body, in yards. */
export const LOOT_BEAM_HEIGHT = 2.6;
/** Seconds a beam takes to appear and to fade. */
export const LOOT_BEAM_FADE_IN = 0.35;
export const LOOT_BEAM_FADE_OUT = 0.5;
/** Its colour: warm gold, the loot cursor's. */
export const LOOT_BEAM_COLOUR = new THREE.Color(1, 0.78, 0.32);

const VERTEX = /* glsl */ `
attribute float beamLevel;
attribute float beamPhase;
varying float vHeight;
varying float vFacing;
varying float vLevel;
varying float vPhase;
void main() {
  vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vec3 normalView = normalize(mat3(viewMatrix) * mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vec4 view = viewMatrix * world;
  vFacing = abs(dot(normalView, normalize(-view.xyz)));
  vHeight = uv.y;
  vLevel = beamLevel;
  vPhase = beamPhase;
  gl_Position = projectionMatrix * view;
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 colour;
uniform float time;
uniform float strength;
uniform float whiten;
varying float vHeight;
varying float vFacing;
varying float vLevel;
varying float vPhase;
void main() {
  // Fading up from nothing at the foot, so where the beam enters the body and the ground leaves no hard ring.
  float rise = pow(1.0 - vHeight, 1.6) * smoothstep(0.0, 0.12, vHeight);
  float edge = pow(vFacing, 1.4);
  float shimmer = 0.78 + 0.22 * sin(vHeight * 11.0 - time * 2.6 + vPhase);
  float breathe = 0.85 + 0.15 * sin(time * 1.7 + vPhase);
  float a = vLevel * strength * rise * edge * shimmer * breathe;
  gl_FragColor = vec4(mix(colour, vec3(1.0), whiten) * a, 1.0);
}`;

interface Beam {
  level: number;
  wanted: boolean;
  readonly phase: number;
  readonly position: THREE.Vector3;
}

function beamMesh(radiusTop: number, radiusBottom: number, strength: number, whiten: number, time: { value: number },
  levels: THREE.InstancedBufferAttribute, phases: THREE.InstancedBufferAttribute): THREE.InstancedMesh {
  const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, LOOT_BEAM_HEIGHT, 20, 6, true);
  geometry.translate(0, LOOT_BEAM_HEIGHT / 2, 0);
  geometry.setAttribute("beamLevel", levels);
  geometry.setAttribute("beamPhase", phases);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX, fragmentShader: FRAGMENT,
    uniforms: { colour: { value: LOOT_BEAM_COLOUR }, time, strength: { value: strength }, whiten: { value: whiten } },
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, LOOT_BEAM_LIMIT);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3; // with the particles: transparent, after the world
  mesh.count = 0;
  return mesh;
}

export class LootBeams {
  readonly group = new THREE.Group();
  readonly #beams = new Map<bigint, Beam>();
  readonly #time = { value: 0 };
  readonly #levels = new THREE.InstancedBufferAttribute(new Float32Array(LOOT_BEAM_LIMIT), 1);
  readonly #phases = new THREE.InstancedBufferAttribute(new Float32Array(LOOT_BEAM_LIMIT), 1);
  readonly #glow: THREE.InstancedMesh;
  readonly #core: THREE.InstancedMesh;
  readonly #matrix = new THREE.Matrix4();
  readonly #order: Beam[] = [];
  #enabled = false;
  #lastSeconds: number | undefined;

  constructor() {
    this.#levels.setUsage(THREE.DynamicDrawUsage);
    this.#phases.setUsage(THREE.DynamicDrawUsage);
    this.#glow = beamMesh(0.22, 0.42, 0.55, 0, this.#time, this.#levels, this.#phases);
    this.#core = beamMesh(0.05, 0.09, 0.9, 0.45, this.#time, this.#levels, this.#phases);
    this.#glow.name = "lootBeamGlow";
    this.#core.name = "lootBeamCore";
    this.group.name = "lootBeams";
    this.group.add(this.#glow, this.#core);
    this.group.visible = false;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled) {
      this.#beams.clear();
      this.group.visible = false;
    }
  }

  /** How many beams are drawn (tests, diagnostics). */
  get count(): number {
    return this.#glow.count;
  }

  /** The level (0..1) of the beam over `guid`, or 0 (tests). */
  levelOf(guid: bigint): number {
    return this.#beams.get(guid)?.level ?? 0;
  }

  /** Starts a frame: every beam is unwanted until `mark` names its body again. */
  begin(): void {
    for (const beam of this.#beams.values()) beam.wanted = false;
  }

  /** A lootable body `guid` lies at scene `position` this frame. */
  mark(guid: bigint, position: THREE.Vector3): void {
    if (!this.#enabled) return;
    let beam = this.#beams.get(guid);
    if (!beam) {
      // Each beam breathes on its own phase, so a pack's bodies do not pulse in step.
      beam = { level: 0, wanted: true, phase: Number(guid % 997n) * 0.37, position: new THREE.Vector3() };
      this.#beams.set(guid, beam);
    }
    beam.wanted = true;
    beam.position.copy(position);
  }

  /** Ends the frame: fades every beam toward its mark and writes the nearest `LOOT_BEAM_LIMIT` to the GPU. */
  end(nowMs: number, camera: THREE.Vector3): void {
    if (!this.#enabled) return;
    const seconds = nowMs / 1000;
    const elapsed = this.#lastSeconds === undefined ? 0 : Math.max(0, Math.min(0.25, seconds - this.#lastSeconds));
    this.#lastSeconds = seconds;
    this.#time.value = seconds % 3600;
    this.#order.length = 0;
    for (const [guid, beam] of this.#beams) {
      beam.level = beam.wanted
        ? Math.min(1, beam.level + elapsed / LOOT_BEAM_FADE_IN)
        : Math.max(0, beam.level - elapsed / LOOT_BEAM_FADE_OUT);
      if (!beam.wanted && beam.level <= 0) {
        this.#beams.delete(guid);
        continue;
      }
      if (beam.level > 0) this.#order.push(beam);
    }
    if (this.#order.length > LOOT_BEAM_LIMIT) {
      this.#order.sort((left, right) => left.position.distanceToSquared(camera) - right.position.distanceToSquared(camera));
      this.#order.length = LOOT_BEAM_LIMIT;
    }
    const levels = this.#levels.array as Float32Array;
    const phases = this.#phases.array as Float32Array;
    this.#order.forEach((beam, index) => {
      this.#matrix.makeTranslation(beam.position.x, beam.position.y, beam.position.z);
      this.#glow.setMatrixAt(index, this.#matrix);
      this.#core.setMatrixAt(index, this.#matrix);
      // Eased, so a beam swells in rather than ramping.
      levels[index] = beam.level * beam.level * (3 - 2 * beam.level);
      phases[index] = beam.phase;
    });
    const count = this.#order.length;
    this.#glow.count = this.#core.count = count;
    if (count > 0) {
      this.#glow.instanceMatrix.needsUpdate = true;
      this.#core.instanceMatrix.needsUpdate = true;
      this.#levels.needsUpdate = true;
      this.#phases.needsUpdate = true;
    }
    this.group.visible = count > 0;
  }

  dispose(): void {
    for (const mesh of [this.#glow, this.#core]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
  }
}
