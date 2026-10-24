/**
 * 25.10 (perf): a casting crowd for the timed city scenes — the owner's «нагрузка всех объектов, NPC и эффекты».
 * `config.city.casts` (bench/city-spells.json, bench/dalaran.json) names the spells and how many units cast them;
 * every `everySeconds` each caster plays the next spell of the list as SMSG_SPELL_GO would (a missile spell flies to
 * the caster's neighbour, the rest land on the caster). The schedule reads only the renderer's frame clock, so the
 * in-page harness and the render worker play the same casts at the same moments. Before the first measured cast
 * every spell is played once (during the harness's warm-up), so its models and textures load outside the timing.
 */

import { planSpellVisual, type SpellVisualPlan } from "../SpellVisuals.js";
import type { SpellVisualMetadata } from "../../gateway/SpellVisual.js";

export interface BenchCastsConfig {
  /** Spell.dbc ids, played in turn by every caster. */
  readonly spells: readonly number[];
  /** How many units of the crowd cast (spread over the crowd). */
  readonly casters: number;
  /** Each caster's period, seconds; the casters are staggered evenly inside it. */
  readonly everySeconds: number;
}

type Point = { x: number; y: number; z: number };

/** The crowd index of caster `k` (index 0 is the player). */
export function benchCasterIndex(k: number, casters: number, population: number): number {
  const step = Math.max(1, Math.floor((population - 1) / Math.max(1, casters)));
  return 1 + ((k * step) % Math.max(1, population - 1));
}

export class BenchSpellCasts {
  readonly #visuals: readonly SpellVisualMetadata[];
  #lastSeconds = Number.NEGATIVE_INFINITY;
  #prewarmed = false;
  /** Casts played since construction (a run reads it to report the load). */
  played = 0;

  constructor(readonly casts: BenchCastsConfig, visuals: readonly SpellVisualMetadata[], readonly population: number,
    readonly warmupSeconds: number) {
    const byId = new Map(visuals.map((visual) => [visual.id, visual]));
    this.#visuals = casts.spells.map((id) => {
      const visual = byId.get(id);
      if (!visual) throw new Error(`Bench cast: spell ${id} has no visual`);
      return visual;
    });
  }

  /** Fetches the spells' visual rows the gateway serves (the route SpellVisualClient reads). */
  static async load(baseUrl: string, casts: BenchCastsConfig, population: number, warmupSeconds: number):
    Promise<BenchSpellCasts> {
    const response = await fetch(`${baseUrl}/dbc/spell-visuals?v=9&ids=${casts.spells.join(",")}`);
    if (!response.ok) throw new Error(`Bench cast: spell visuals ${response.status}`);
    return new BenchSpellCasts(casts, await response.json() as SpellVisualMetadata[], population, warmupSeconds);
  }

  /** The renderer's clock went back (a run's reset): the schedule starts over. */
  reset(): void { this.#lastSeconds = Number.NEGATIVE_INFINITY; }

  /**
   * Plays every cast due between the previous call and this frame's clock (`nowMs`, the bench frame time).
   * `pointOf` answers where a unit stands; a caster not in the world yet (city-arrival) skips its cast.
   */
  step(nowMs: number, pointOf: (guid: bigint) => Point | undefined, play: (plan: SpellVisualPlan) => void): void {
    const seconds = nowMs / 1000 - this.warmupSeconds;
    if (seconds < this.#lastSeconds) this.#lastSeconds = Number.NEGATIVE_INFINITY;
    if (seconds < 0) return; // preparation: the crowd's clock stands at zero
    const { casters, everySeconds } = this.casts;
    const spells = this.#visuals;
    if (!this.#prewarmed) {
      this.#prewarmed = true;
      for (let index = 0; index < spells.length; index++) this.#cast(index % casters, index, nowMs, pointOf, play);
    }
    const from = this.#lastSeconds;
    this.#lastSeconds = seconds;
    for (let k = 0; k < casters; k++) {
      const offset = (k / casters) * everySeconds;
      // The casts n with from < offset + n·every <= seconds.
      const first = Number.isFinite(from) ? Math.floor((from - offset) / everySeconds) + 1 : Math.ceil(-offset / everySeconds);
      const last = Math.floor((seconds - offset) / everySeconds);
      for (let n = Math.max(0, first); n <= last; n++) this.#cast(k, k + n, nowMs, pointOf, play);
    }
  }

  #cast(k: number, spellIndex: number, nowMs: number, pointOf: (guid: bigint) => Point | undefined,
    play: (plan: SpellVisualPlan) => void): void {
    const casters = this.casts.casters;
    const index = benchCasterIndex(k, casters, this.population);
    const caster = BigInt(index + 1);
    const casterPoint = pointOf(caster);
    if (!casterPoint) return;
    const visual = this.#visuals[spellIndex % this.#visuals.length]!;
    let target = caster, targetPoint: Point = casterPoint;
    if (visual.missile) {
      const other = BigInt(benchCasterIndex((k + 1) % casters, casters, this.population) + 1);
      const point = pointOf(other);
      if (point && other !== caster) { target = other; targetPoint = point; }
    }
    // The units' cast poses are left out: a pose queued on a unit outlives `clearSpellVisuals` until its next pose
    // pass, and the harness's replay reset refuses while one is queued. The models, emitters and lights stay.
    const plan = planSpellVisual(visual, { caster, casterPoint: { ...casterPoint },
      targets: [{ guid: target, point: { ...targetPoint } }] }, nowMs);
    plan.animations.length = 0;
    play(plan);
    this.played++;
  }
}
