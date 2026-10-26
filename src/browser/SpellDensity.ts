import type { WvmParticleEmitter } from "./Wvm.js";
import { PARTICLE_FLAG_SPAWN_ON_GROUND, PARTICLE_FLAG_XY_QUAD } from "./Particles.js";

/**
 * 26.10 (6.27, test version for the owner: «подумай как улучшить заклинания по визуалу и сделай тестовую версию»):
 * «Плотные эффекты заклинаний».
 *
 * A 2008 spell effect is a handful of large sprites a second: Seal of Righteousness's sparks, a Frostbolt's trail and
 * a Fireball's flame read as separate cards that pop in and out. This makes a spell's own emitters spawn
 * {@link SPELL_DENSITY_EMISSION} times as many particles, each at {@link SPELL_DENSITY_ALPHA} of its authored opacity: the
 * same shapes, sizes, colours and timing, but a cloud instead of a few cards. The light it adds over the authored
 * effect (emission × alpha) is held at about a fifth more, so the bloom and the spell lights stay where they were
 * tuned. Only spell models (the renderer's spell effect builds), only in the enhanced profile, off by default.
 *
 * A burst emitter (record 0x40: Frost Nova's ring, a Hammer of Justice impact) fires its burst at the same density.
 * A ground-lying quad (XY quad, spawned on the ground) is left as authored: those are runes and rings meant to be
 * read as one shape, and doubling them only thickens their edge.
 */

/** How many times the authored emission a dense spell emitter spawns. */
export const SPELL_DENSITY_EMISSION = 2;
/** The share of the authored opacity each of those particles keeps (2 × 0.6 = 1.2 × the authored light). */
export const SPELL_DENSITY_ALPHA = 0.6;

/** The density a spell emitter gets, or undefined for one left as authored (a rune or ring on the ground). */
export function spellDensityFor(emitter: Pick<WvmParticleEmitter, "flags">): { readonly emission: number; readonly alpha: number } | undefined {
  if ((emitter.flags & (PARTICLE_FLAG_XY_QUAD | PARTICLE_FLAG_SPAWN_ON_GROUND)) !== 0) return undefined;
  return { emission: SPELL_DENSITY_EMISSION, alpha: SPELL_DENSITY_ALPHA };
}
