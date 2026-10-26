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
 * keeps a flickering emitter from strobing the street. At most `SPELL_LIGHT_LIMIT` lights at once, the
 * brightest ones.
 *
 * 26.10 (owner: «множество вспышек выглядит как светошоу»): a crowd hitting one monster gave every impact a
 * light of its own, each rising from nothing in a tenth of a second while the brightest two swapped places — a
 * strobe. Impacts and held effects within `SPELL_LIGHT_GATHER` yards of each other are now one light: their
 * intensities combine as coverages do (1 − Π(1 − i/peak)), so ten hits are no brighter than one saturated
 * one, and the light lets go over `SPELL_LIGHT_RELEASE` instead of the rise's tenth, so a stream of hits reads
 * as one steady glow on the fight. A lone impact still flashes as before. A missile keeps its own light.
 */
import * as THREE from "three";
import type { ParticleGlow } from "./Particles.js";
import type { LocalLightSample } from "./LocalLighting.js";

/** Lights in the world at once; the rest are drawn but cast nothing. */
export const SPELL_LIGHT_LIMIT = 2;
/** Energy (alpha × brightness × yd²) at which a spell light reaches 63 % of its peak. */
export const SPELL_LIGHT_ENERGY = 6;
/**
 * Intensity of a saturated spell light, in the fixture lights' units (a lamp is ~1.1). 23.10 (6.27 review): 0.6,
 * not 1.25 — at 1.25 Seal of Righteousness washed the paladin's legs gold; a spell lights its surroundings, it
 * is not a lamp held at the knee.
 */
export const SPELL_LIGHT_PEAK = 0.6;
/** Reach of a spell light's soft pool, in yards. */
export const SPELL_LIGHT_RADIUS = 9;
/** Time constant of the smoothing, in seconds: a missile's both ways, a gathered light's rise. */
export const SPELL_LIGHT_SMOOTHING = 0.1;
/** 26.10: time constant of a gathered light's fall, in seconds. */
export const SPELL_LIGHT_RELEASE = 0.4;
/** 26.10: impacts and held effects closer than this, in yards, light as one. */
export const SPELL_LIGHT_GATHER = 4;
/** 26.10: time constant with which a gathered light's place and colour follow its effects, in seconds. */
const SPELL_LIGHT_DRIFT = 0.15;
/**
 * 25.10 (6.27): how strongly each kind of spell model lights its surroundings, × `SPELL_LIGHT_PEAK`: a missile is the
 * light moving through the scene (and its light sits on the bolt, not on the trail it leaves), an impact or a cast
 * flash the ordinary one, an aura's held model a faint one — it stands on its unit for minutes.
 */
export const SPELL_LIGHT_KIND_SCALE = { missile: 1.5, burst: 1, aura: 0.5 } as const;
export type SpellLightKind = keyof typeof SPELL_LIGHT_KIND_SCALE;
/** Below this smoothed intensity a light is dropped. */
const SPELL_LIGHT_FLOOR = 0.01;
/** The yd² one fully opaque additive mesh batch counts for (a spell's mesh is a handful of cards). */
export const SPELL_MESH_BATCH_AREA = 1.5;

/** CPU curve: intensity from energy, saturating rather than unbounded. */
export function spellLightIntensity(energy: number): number {
  if (!(energy > 0) || !Number.isFinite(energy)) return 0;
  return SPELL_LIGHT_PEAK * (1 - Math.exp(-energy / SPELL_LIGHT_ENERGY));
}

/** 26.10: the combined intensity of lights `intensities` in one place: as coverages, never past the peak. */
export function gatheredSpellLight(intensities: readonly number[]): number {
  let dark = 1;
  for (const intensity of intensities) {
    if (intensity > 0) dark *= 1 - Math.min(0.999, intensity / SPELL_LIGHT_PEAK);
  }
  return SPELL_LIGHT_PEAK * (1 - dark);
}

/** One effect's glow this frame, accumulated over its emitters and batches. */
interface Candidate {
  glow: ParticleGlow;
  seen: boolean;
  /** 25.10 (6.27): its kind's scale and, for a missile, the point it is pinned to this frame. */
  scale: number;
  missile: boolean;
  pinned: boolean;
  pinX: number; pinY: number; pinZ: number;
}

/** 26.10: a light in the world — one missile's, or every impact and held effect gathered around one place. */
interface Light {
  smoothed: number;
  fed: boolean;
  fresh: boolean;
  /** This frame's target: a missile's own intensity, or the product of a gathered light's darkness. */
  target: number;
  dark: number;
  /** This frame's place and colour, accumulated weighted by intensity. */
  weight: number;
  x: number; y: number; z: number;
  red: number; green: number; blue: number;
  readonly position: THREE.Vector3;
  readonly colour: THREE.Vector3;
}

function emptyGlow(): ParticleGlow {
  return { energy: 0, red: 0, green: 0, blue: 0, x: 0, y: 0, z: 0 };
}

function newLight(): Light {
  return { smoothed: 0, fed: false, fresh: true, target: 0, dark: 1, weight: 0, x: 0, y: 0, z: 0,
    red: 0, green: 0, blue: 0, position: new THREE.Vector3(), colour: new THREE.Vector3() };
}

function resetFrame(light: Light): void {
  light.fed = false;
  light.target = 0;
  light.dark = 1;
  light.weight = light.x = light.y = light.z = light.red = light.green = light.blue = 0;
}

const _target = new THREE.Vector3();

/** Collects the frame's spell glow per effect and offers the brightest lights as fixture lights. */
export class SpellLights {
  // 25.10 (6.27): one candidate per spell model (its RenderedVisual), not per cast: a cast's hand flare, bolt and
  // impact are different lights in different places.
  readonly #byEffect = new Map<object, Candidate>();
  /** 26.10: each missile's light, by its spell model. */
  readonly #missiles = new Map<object, Light>();
  /** 26.10: the gathered lights of impacts and held effects. */
  readonly #gathered: Light[] = [];
  readonly #ranked: Light[] = [];

  /** Starts a frame: every effect is unseen until it offers glow again. */
  begin(): void {
    for (const candidate of this.#byEffect.values()) {
      candidate.seen = false;
      const glow = candidate.glow;
      glow.energy = glow.red = glow.green = glow.blue = glow.x = glow.y = glow.z = 0;
    }
  }

  /** The accumulator one effect's emitters write into this frame (`updateModelEffects({ glow })`). */
  glowOf(effect: object, kind: SpellLightKind = "burst"): ParticleGlow {
    return this.#candidate(effect, kind).glow;
  }

  #candidate(effect: object, kind: SpellLightKind): Candidate {
    let candidate = this.#byEffect.get(effect);
    if (!candidate) {
      candidate = { glow: emptyGlow(), seen: false, scale: 1, missile: false, pinned: false, pinX: 0, pinY: 0, pinZ: 0 };
      this.#byEffect.set(effect, candidate);
    }
    if (!candidate.seen) candidate.pinned = false;
    candidate.seen = true;
    candidate.scale = SPELL_LIGHT_KIND_SCALE[kind];
    candidate.missile = kind === "missile";
    return candidate;
  }

  /** 25.10 (6.27): a missile's light sits on the bolt (scene x, y, z), whatever its trail adds up to. */
  pin(effect: object, x: number, y: number, z: number): void {
    const candidate = this.#candidate(effect, "missile");
    candidate.pinned = true;
    candidate.pinX = x; candidate.pinY = y; candidate.pinZ = z;
  }

  /** An additive mesh batch of the effect at `opacity` and colour, centred at (x, y, z) in the scene. */
  addBatch(effect: object, x: number, y: number, z: number, red: number, green: number, blue: number, opacity: number,
    kind: SpellLightKind = "burst"): void {
    const area = SPELL_MESH_BATCH_AREA * Math.max(0, Math.min(1, opacity));
    const brightness = Math.max(red, green, blue);
    const energy = area * brightness;
    if (!(energy > 0) || !Number.isFinite(energy)) return;
    const glow = this.glowOf(effect, kind);
    glow.energy += energy;
    glow.red += red * area;
    glow.green += green * area;
    glow.blue += blue * area;
    glow.x += x * energy;
    glow.y += y * energy;
    glow.z += z * energy;
  }

  /** Ends the frame: gathers the effects into lights, smooths each over `elapsed` seconds, forgets the dark ones. */
  end(elapsed: number): void {
    const blend = (constant: number): number => (elapsed > 0 ? 1 - Math.exp(-elapsed / constant) : 1);
    for (const light of this.#missiles.values()) resetFrame(light);
    for (const light of this.#gathered) resetFrame(light);
    for (const [effect, candidate] of this.#byEffect) {
      if (!candidate.seen) {
        this.#byEffect.delete(effect);
        continue;
      }
      const glow = candidate.glow;
      const intensity = spellLightIntensity(glow.energy) * candidate.scale;
      if (!(intensity > 0)) continue;
      const x = candidate.pinned ? candidate.pinX : glow.x / glow.energy;
      const y = candidate.pinned ? candidate.pinY : glow.y / glow.energy;
      const z = candidate.pinned ? candidate.pinZ : glow.z / glow.energy;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      let light: Light;
      if (candidate.missile) {
        light = this.#missiles.get(effect) ?? newLight();
        this.#missiles.set(effect, light);
        // A missile's light is its own and may pass the peak (×1.5): its intensity is its target.
        light.target = intensity;
      } else {
        light = this.#nearest(x, y, z);
        light.dark *= 1 - Math.min(0.999, intensity / SPELL_LIGHT_PEAK);
        light.target = SPELL_LIGHT_PEAK * (1 - light.dark);
      }
      light.fed = true;
      light.weight += intensity;
      light.x += x * intensity; light.y += y * intensity; light.z += z * intensity;
      const peak = Math.max(glow.red, glow.green, glow.blue);
      if (peak > 0) {
        light.red += glow.red / peak * intensity;
        light.green += glow.green / peak * intensity;
        light.blue += glow.blue / peak * intensity;
      }
    }
    this.#ranked.length = 0;
    for (const [effect, light] of this.#missiles) {
      light.smoothed += (light.target - light.smoothed) * blend(SPELL_LIGHT_SMOOTHING);
      if (light.fed) this.#place(light, 1);
      if (!light.fed && light.smoothed < SPELL_LIGHT_FLOOR) this.#missiles.delete(effect);
      else if (light.smoothed >= SPELL_LIGHT_FLOOR) this.#ranked.push(light);
    }
    let kept = 0;
    for (const light of this.#gathered) {
      const rising = light.target > light.smoothed;
      light.smoothed += (light.target - light.smoothed) * blend(rising ? SPELL_LIGHT_SMOOTHING : SPELL_LIGHT_RELEASE);
      if (light.fed) this.#place(light, light.fresh ? 1 : blend(SPELL_LIGHT_DRIFT));
      light.fresh = false;
      if (!light.fed && light.smoothed < SPELL_LIGHT_FLOOR) continue;
      this.#gathered[kept++] = light;
      if (light.smoothed >= SPELL_LIGHT_FLOOR) this.#ranked.push(light);
    }
    this.#gathered.length = kept;
    this.#ranked.sort((left, right) => right.smoothed - left.smoothed);
    if (this.#ranked.length > SPELL_LIGHT_LIMIT) this.#ranked.length = SPELL_LIGHT_LIMIT;
  }

  /** The gathered light within `SPELL_LIGHT_GATHER` yards of (x, y, z), or a new one there. */
  #nearest(x: number, y: number, z: number): Light {
    let best: Light | undefined;
    let bestDistance = SPELL_LIGHT_GATHER * SPELL_LIGHT_GATHER;
    for (const light of this.#gathered) {
      // A light already fed this frame is where its effects are now; an unfed one where it was.
      const fed = light.fed && light.weight > 0;
      const dx = (fed ? light.x / light.weight : light.position.x) - x;
      const dy = (fed ? light.y / light.weight : light.position.y) - y;
      const dz = (fed ? light.z / light.weight : light.position.z) - z;
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance <= bestDistance) {
        best = light;
        bestDistance = distance;
      }
    }
    if (best) return best;
    const light = newLight();
    light.position.set(x, y, z);
    this.#gathered.push(light);
    return light;
  }

  /** Moves a fed light's place and colour toward this frame's, by `follow` (1: at once). */
  #place(light: Light, follow: number): void {
    if (!(light.weight > 0)) return;
    light.position.lerp(_target.set(light.x / light.weight, light.y / light.weight, light.z / light.weight), follow);
    const peak = Math.max(light.red, light.green, light.blue);
    if (peak > 0) light.colour.lerp(_target.set(light.red / peak, light.green / peak, light.blue / peak), follow);
  }

  /** The lights `end` kept, written one at a time into `sample` for the fixture selection. */
  forEach(sample: LocalLightSample, visit: (sample: LocalLightSample) => void): void {
    for (const light of this.#ranked) {
      const at = light.position;
      if (!Number.isFinite(at.x) || !Number.isFinite(at.y) || !Number.isFinite(at.z)) continue;
      sample.position.copy(light.position);
      sample.colour.copy(light.colour);
      sample.radius = SPELL_LIGHT_RADIUS;
      sample.intensity = light.smoothed;
      sample.client = false;
      sample.halo = false;
      visit(sample);
    }
  }

  /** How many lights would light this frame (diagnostics and tests). */
  get count(): number {
    return this.#ranked.length;
  }

  clear(): void {
    this.#byEffect.clear();
    this.#missiles.clear();
    this.#gathered.length = 0;
    this.#ranked.length = 0;
  }
}
