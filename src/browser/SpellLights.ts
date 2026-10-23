/**
 * 23.10 (6.27): light from spell effects — the enhanced profile's «Живые эффекты заклинаний».
 *
 * A fireball or a seal's flash lights what is around it through the same fixture-light path the 7.36
 * cinematic lamps use (`LocalLightSelection`, `WORLD_LIGHT_BODY`): no new pass, no shader variant. Wow.exe
 * has nothing like it — a spell model's own M2 lights are the only light a 3.3.5a effect gives (6.17) — so
 * this exists only behind the leaf; the faithful frame never offers a spell light.
 *
 * The light is read off what the effect actually draws this frame: its particles' summed visible energy
 * (alpha × brightness × area, `ParticleGlow` from `writeParticleQuads`) and its additive mesh batches'
 * opacity, weighted to a centre and a colour. So it brightens as the effect blooms and fades exactly as the
 * effect fades — no timing of its own to drift from the picture — and a smoothing of a tenth of a second
 * keeps a flickering emitter from strobing the street. At most `SPELL_LIGHT_LIMIT` effects light at once,
 * the brightest ones.
 */
import * as THREE from "three";
import type { ParticleGlow } from "./Particles.js";
import type { LocalLightSample } from "./LocalLighting.js";

/** Effects that light the world at once; the rest are drawn but cast nothing. */
export const SPELL_LIGHT_LIMIT = 2;
/** Energy (alpha × brightness × yd²) at which a spell light reaches 63 % of its peak. */
export const SPELL_LIGHT_ENERGY = 3;
/** Intensity of a saturated spell light, in the fixture lights' units (a lamp is ~1.1). */
export const SPELL_LIGHT_PEAK = 1.25;
/** Reach of a spell light's soft pool, in yards. */
export const SPELL_LIGHT_RADIUS = 9;
/** Time constant of the smoothing, in seconds. */
export const SPELL_LIGHT_SMOOTHING = 0.1;
/** Below this smoothed intensity a light is dropped. */
const SPELL_LIGHT_FLOOR = 0.01;
/** The yd² one fully opaque additive mesh batch counts for (a spell's mesh is a handful of cards). */
export const SPELL_MESH_BATCH_AREA = 1.5;

/** CPU curve: intensity from energy, saturating rather than unbounded. */
export function spellLightIntensity(energy: number): number {
  if (!(energy > 0) || !Number.isFinite(energy)) return 0;
  return SPELL_LIGHT_PEAK * (1 - Math.exp(-energy / SPELL_LIGHT_ENERGY));
}

/** One effect's light this frame, accumulated over its emitters and batches. */
interface Candidate {
  glow: ParticleGlow;
  seen: boolean;
  smoothed: number;
  position: THREE.Vector3;
  colour: THREE.Vector3;
}

function emptyGlow(): ParticleGlow {
  return { energy: 0, red: 0, green: 0, blue: 0, x: 0, y: 0, z: 0 };
}

/** Collects the frame's spell glow per effect and offers the brightest as fixture lights. */
export class SpellLights {
  readonly #byEffect = new Map<number, Candidate>();
  readonly #ranked: Candidate[] = [];

  /** Starts a frame: every effect is unseen until it offers glow again. */
  begin(): void {
    for (const candidate of this.#byEffect.values()) {
      candidate.seen = false;
      const glow = candidate.glow;
      glow.energy = glow.red = glow.green = glow.blue = glow.x = glow.y = glow.z = 0;
    }
  }

  /** The accumulator one effect's emitters write into this frame (`updateModelEffects({ glow })`). */
  glowOf(effect: number): ParticleGlow {
    let candidate = this.#byEffect.get(effect);
    if (!candidate) {
      candidate = { glow: emptyGlow(), seen: false, smoothed: 0, position: new THREE.Vector3(), colour: new THREE.Vector3() };
      this.#byEffect.set(effect, candidate);
    }
    candidate.seen = true;
    return candidate.glow;
  }

  /** An additive mesh batch of the effect at `opacity` and colour, centred at (x, y, z) in the scene. */
  addBatch(effect: number, x: number, y: number, z: number, red: number, green: number, blue: number, opacity: number): void {
    const area = SPELL_MESH_BATCH_AREA * Math.max(0, Math.min(1, opacity));
    const brightness = Math.max(red, green, blue);
    const energy = area * brightness;
    if (!(energy > 0) || !Number.isFinite(energy)) return;
    const glow = this.glowOf(effect);
    glow.energy += energy;
    glow.red += red * area;
    glow.green += green * area;
    glow.blue += blue * area;
    glow.x += x * energy;
    glow.y += y * energy;
    glow.z += z * energy;
  }

  /** Ends the frame: smooths every effect's intensity over `elapsed` seconds and forgets the dark ones. */
  end(elapsed: number): void {
    const blend = 1 - Math.exp(-Math.max(0, elapsed) / SPELL_LIGHT_SMOOTHING);
    this.#ranked.length = 0;
    for (const [effect, candidate] of this.#byEffect) {
      const glow = candidate.glow;
      const target = candidate.seen ? spellLightIntensity(glow.energy) : 0;
      candidate.smoothed += (target - candidate.smoothed) * (elapsed > 0 ? blend : 1);
      if (candidate.seen && glow.energy > 0) {
        candidate.position.set(glow.x / glow.energy, glow.y / glow.energy, glow.z / glow.energy);
        const peak = Math.max(glow.red, glow.green, glow.blue);
        if (peak > 0) candidate.colour.set(glow.red / peak, glow.green / peak, glow.blue / peak);
      }
      if (candidate.smoothed < SPELL_LIGHT_FLOOR && !candidate.seen) {
        this.#byEffect.delete(effect);
        continue;
      }
      if (candidate.smoothed >= SPELL_LIGHT_FLOOR) this.#ranked.push(candidate);
    }
    this.#ranked.sort((left, right) => right.smoothed - left.smoothed);
    if (this.#ranked.length > SPELL_LIGHT_LIMIT) this.#ranked.length = SPELL_LIGHT_LIMIT;
  }

  /** The lights `end` kept, written one at a time into `sample` for the fixture selection. */
  forEach(sample: LocalLightSample, visit: (sample: LocalLightSample) => void): void {
    for (const candidate of this.#ranked) {
      const at = candidate.position;
      if (!Number.isFinite(at.x) || !Number.isFinite(at.y) || !Number.isFinite(at.z)) continue;
      sample.position.copy(candidate.position);
      sample.colour.copy(candidate.colour);
      sample.radius = SPELL_LIGHT_RADIUS;
      sample.intensity = candidate.smoothed;
      sample.client = false;
      sample.halo = false;
      visit(sample);
    }
  }

  /** How many effects would light this frame (diagnostics and tests). */
  get count(): number {
    return this.#ranked.length;
  }

  clear(): void {
    this.#byEffect.clear();
    this.#ranked.length = 0;
  }
}
