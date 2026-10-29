// 29.10: a ranged shot's release and its ammo in flight (owner: «у охотника не проигрывается анимация стрельбы»).
//
// The release: every SMSG_SPELL_GO with CAST_FLAG_AMMO and an ammo display is a ranged weapon release — the core
// sets the flag exactly for SPELL_ATTR0_REQ_AMMO spells (Spell.cpp:4487-4488, world/SpellAmmo.ts). Before this only
// Auto Shot 75 and wand Shoot 5019 played the caster's "shoot" action; Arcane, Steady, Aimed and Multi-Shot and the
// stings carry a missile but no caster animation in their SpellVisual, so the bow was never drawn. The rule is the
// one those two had: the shot plays unless the visual plan authors a caster animation itself.
//
// The ammo in flight: Wow.exe's missile launcher 0x00732ff0 takes the cast's ammo display as the missile model when
// the SpellVisual names no MissileModel (.runtime/re-2026-10-11/glue-1110/1013-m1.txt:590-597 → 0x004eab50,
// gateway/AmmoModels.ts). The gateway marks such a visual's missile, and the missile of a REQ_AMMO spell with no
// SpellVisualID at all (Auto Shot), `ammoMissile` (gateway/SpellVisual.ts); here it
// becomes an ordinary missile with the ammo's model — the same planner and MissileFlight flight as any bolt, at
// scale 1 (0x00732ff0 leaves its scale at 1.0 for that branch) and with the ammo texture in the object-skin slot.

import type { AmmoModel } from "../gateway/AmmoModels.js";
import type { SpellVisualMetadata } from "../gateway/SpellVisual.js";
import { castCarriesAmmo, castFlightAmmo, type SpellAmmo } from "../world/SpellAmmo.js";
import type { SpellVisualPlan } from "./SpellVisuals.js";

/** Where the ammo model of a pair comes from (AmmoModelClient): the model, null for none, undefined while coming. */
export interface AmmoModelSource {
  model(ammo: SpellAmmo): AmmoModel | null | undefined;
}

/**
 * The only stock 3.3.5 SPELL_GO rows whose missing visual is itself the ranged release, known before the ammo pair
 * was read: Auto Shot 75 and wand Shoot 5019 (`SPELL_ATTR2_AUTOREPEAT_FLAG` alone is broader — 1485, 31317, 38196).
 */
const STOCK_RANGED_RELEASES: ReadonlySet<number> = new Set([75, 5019]);

/** Whether a SPELL_GO releases a ranged weapon: the ammo pair, or one of the stock auto-repeat rows. */
export function castReleasesRangedWeapon(
  cast: { spellId: number; castFlags: number; ammo?: SpellAmmo | undefined },
  metadata: SpellVisualMetadata | undefined,
): boolean {
  if (castCarriesAmmo(cast)) return true;
  return metadata?.autoRepeat === true && STOCK_RANGED_RELEASES.has(cast.spellId);
}

/** The ammo a cast flies with this visual, when the visual's missile is the ammo and the pair names one. */
export function castAmmoForVisual(
  cast: { castFlags: number; ammo?: SpellAmmo | undefined },
  metadata: SpellVisualMetadata,
): SpellAmmo | undefined {
  if (metadata.missile || !metadata.ammoMissile) return undefined;
  return castFlightAmmo(cast);
}

/** The visual with its ammo missile given the ammo's model; unchanged without one. */
export function withAmmoMissile(metadata: SpellVisualMetadata, model: AmmoModel | null | undefined): SpellVisualMetadata {
  if (!model || !model.model || metadata.missile || !metadata.ammoMissile) return metadata;
  return { ...metadata, missile: { ...metadata.ammoMissile, path: model.model, scale: 1 } };
}

/** Puts the ammo's texture in the object-skin slot of the plan's ammo missiles (0x004eab50: `FUN_00825260(2, …)`). */
export function skinAmmoMissiles(plan: SpellVisualPlan, model: AmmoModel | null | undefined): SpellVisualPlan {
  if (!model || !model.model || !model.texture) return plan;
  for (const instance of plan.instances) {
    if (instance.flight && instance.path === model.model) instance.objectSkin = model.texture;
  }
  return plan;
}

/** A SPELL_GO waiting for its ammo's model; replayed once, whatever the answer. */
interface AmmoWait {
  epoch: number;
  receivedAt: number;
  replay: (now: number) => void;
}

/** At most this many casts wait for an ammo answer; the oldest is dropped (it plays without its ammo). */
const AMMO_WAIT_CAP = 64;

/** The casts waiting for an ammo answer, by the coordinator's epoch and TTL. */
export class AmmoMissileWaits {
  #waits: AmmoWait[] = [];

  get size(): number {
    return this.#waits.length;
  }

  add(epoch: number, receivedAt: number, replay: (now: number) => void): void {
    if (this.#waits.length >= AMMO_WAIT_CAP) this.#waits.shift();
    this.#waits.push({ epoch, receivedAt, replay });
  }

  /** Every wait of this epoch younger than `ttl`; the rest are dropped. All leave the queue. */
  take(epoch: number, now: number, ttl: number): Array<(now: number) => void> {
    const due = this.#waits.filter((wait) => wait.epoch === epoch && now - wait.receivedAt <= ttl).map((wait) => wait.replay);
    this.#waits = [];
    return due;
  }

  clear(): void {
    this.#waits = [];
  }
}
