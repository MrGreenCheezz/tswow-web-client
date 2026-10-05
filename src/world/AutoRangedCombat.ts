import { unit } from "./Fields.js";
import type { WorldObjectState } from "./WorldState.js";

/*
 * L15 5.05: the client's autoRangedCombat controller — Wow.exe 3.3.5a 12340, Ghidra read-only
 * (.runtime/re-2026-10-04/l15-combat/g1.c, g2.c; .runtime/re-2026-10-01/a4-world/d2.c-d4.c,
 * a9-combat/e2.c).
 *
 * The CVar autoRangedCombat (registered with "1" at 0x0051dbd3, pointer 0x00bd091c; the stock Combat
 * panel's «Ближний/дальний бой») and the spellbook's one spell with SPELL_ATTR4 0x01000000 (0x00542030
 * writes it to 0x00be5d84; in the dataset that is Auto Shot 75 alone — the wand's Shoot 5019 has no such
 * bit) make an attack a mode rather than a swing:
 * * StartAttack 0x006e4950, with both: the mount rules read the spell's range (0x00802c30) instead of
 *   melee reach; when CanAttack (0x00729a70) refuses the unit, a running mode stops (0x006e1660);
 *   otherwise the controller 0x006e2be0 is registered as a per-frame callback (0x0047d770(6, …)) and the
 *   player's +0x1858 bit 2 is set. No swing is sent from there.
 * * The controller, each frame, for the selection: CVar off or no such spell — the wanted spell
 *   (0x00d397cc) is cleared and nothing else. Within melee reach (0x0071b820: max(5, both combat reaches
 *   + 4/3), strict) — the swing (0x006e2610, which cancels the repeat) unless one runs. Otherwise, only
 *   while no spell repeats (0x00d397d0): CanAttack refusing stops everything (0x006e1660); inside the
 *   spell's minimum range a running swing goes on; else the swing stops (0x006d5f70, the mode stays), the
 *   spell becomes the wanted one (0x007fe140, START_AUTOREPEAT_SPELL when nothing repeats), and it is
 *   cast (0x0080da40) when the target is in front (the facing vector's dot product with the way to it is
 *   above 0.0, 0x009e418c), the player is not moving forward, backward or turning (movement flags & 0x33,
 *   the test at 0x006e2dbf — strafing is not in it) and the target is inside the maximum range.
 * * StopAttack 0x006e1660: the swing's CMSG_ATTACK_STOP; when a spell is wanted, it is dropped and the
 *   repeat is cancelled (0x00807560(1), CMSG_CANCEL_AUTO_REPEAT_SPELL) if it is that spell; the
 *   controller is unregistered (0x0047d790) and bits 2/4/8 cleared. A repeat the player started by hand
 *   is left to run.
 * * A hand-cast of that spell while no mode runs enters it (0x0080cce0 → 0x0072c2b0 → 0x006e4950), so a
 *   target that walks into melee reach is met with the swing.
 *
 * Bits 4 and 8 have no reader that matters here: 8 is set only for an attack on a unit other than the
 * selection, which this client's StartAttack never makes. Wow.exe ticks every frame; this client ticks
 * every {@link AUTO_RANGED_COMBAT_TICK_MS} — and once at the start, the frame Wow.exe would wait for.
 */

/** SPELL_ATTR4_UNK24 in TrinityCore (SharedDefines.h:579) — the spell 0x00542030 hands the controller. */
export const SPELL_ATTR4_AUTO_RANGED_COMBAT = 0x0100_0000;
/** MOVEMENTFLAG_FORWARD | BACKWARD | LEFT | RIGHT (UnitDefines.h:271-276): no shot while any is set. */
export const AUTO_RANGED_STILL_MASK = 0x0000_0033;
/** How often this client runs the controller while it is registered. */
export const AUTO_RANGED_COMBAT_TICK_MS = 100;

const NOMINAL_MELEE_RANGE = 5;
const MELEE_REACH_BONUS = 4 / 3;

/** The spell's range for the player against the target (0x00802c30). */
export interface AutoRangedLimits {
  readonly min: number;
  readonly max: number;
}

/** What the controller asks of the world client; every member is read at tick time. */
export interface AutoRangedCombatHost {
  /** 0x006d71e0: the CVar on and the book's SPELL_ATTR4 0x01000000 spell, else undefined. */
  rangedSpell(): number | undefined;
  player(): WorldObjectState | undefined;
  /** The selection (0x00bd07b0), when it is in view. */
  selection(): WorldObjectState | undefined;
  /** 0x0071af90: a swing runs or is requested (+0xa20). */
  meleeAttacking(): boolean;
  /** 0x007fe130: the spell repeating now (0x00d397d0). */
  repeatingSpell(): number | undefined;
  /** 0x00729a70: alive, CanAttack, the mount rules. */
  canAttack(target: WorldObjectState): boolean;
  /** 0x00802c30; undefined when the spell's row is not known (Wow.exe reads 0 and 0 then). */
  limits(spellId: number, player: WorldObjectState, target: WorldObjectState): AutoRangedLimits | undefined;
  /**
   * 0x006e2610: CMSG_ATTACK_SWING at the selection, the repeat cancelled. L18-review: the character is not
   * turned (no MSG_MOVE_SET_FACING) — Wow.exe's swing turns nobody, and a hunter running from a mob at his back
   * would be sent into it (tests/auto-ranged-fight-rate.test.mjs).
   */
  swing(): void;
  /** 0x006d5f70: CMSG_ATTACK_STOP; the mode stays. */
  stopSwing(): void;
  /**
   * 0x006e1660: everything stops — the client's StopAttack, which calls {@link AutoRangedCombat.stop}.
   * L18 5.05: its only packet of its own is 0x007559e0's CMSG_ATTACK_STOP (while a swing runs or is asked
   * for) — no CMSG_SET_SHEATHED.
   */
  stopAttack(): void;
  /**
   * 0x0080da40: the repeating cast at the target. L18-review: without turning the character either.
   * 05.10-5.05: false when nothing went out (0x0080da40's own false — no 0x007fe190 then).
   */
  shoot(spellId: number, target: WorldObjectState): boolean | void;
  /**
   * 0x00807560(1): CMSG_CANCEL_AUTO_REPEAT_SPELL and the repeat forgotten. L18 5.05: no CMSG_SET_SHEATHED
   * either — 0x00715ac0(0) only clears a local flag (+0xa38 bit 0x200), 0x0072afe0 resets an animation
   * (.runtime/re-2026-10-04/l18-wiring/h1.c, .runtime/re-2026-10-02/a9-p2/r4.c).
   */
  cancelRepeat(): void;
}

/** Starts and stops the periodic tick; replaceable for tests. */
export interface AutoRangedSchedule {
  start(tick: () => void): unknown;
  stop(handle: unknown): void;
}

const INTERVAL: AutoRangedSchedule = {
  start: (tick) => setInterval(tick, AUTO_RANGED_COMBAT_TICK_MS),
  stop: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** 0x0071b820: the target is within melee reach of the player (strictly inside it). */
export function withinAutoRangedMelee(player: WorldObjectState, target: WorldObjectState): boolean {
  const reach = Math.max(NOMINAL_MELEE_RANGE, (unit.combatReach(player) ?? 0) + (unit.combatReach(target) ?? 0) + MELEE_REACH_BONUS);
  return distanceSquared(player, target) < reach * reach;
}

/** The target lies in the half-plane the player faces (dot product above 0.0). */
export function facesForShot(player: WorldObjectState, target: WorldObjectState): boolean {
  const from = player.position;
  const to = target.position;
  if (!from || !to) return false;
  return Math.cos(from.orientation) * (to.x - from.x) + Math.sin(from.orientation) * (to.y - from.y) > 0;
}

function distanceSquared(player: WorldObjectState, target: WorldObjectState): number {
  const from = player.position;
  const to = target.position;
  if (!from || !to) return Number.POSITIVE_INFINITY;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  return dx * dx + dy * dy + dz * dz;
}

export class AutoRangedCombat {
  readonly #host: AutoRangedCombatHost;
  /** Replaced by tests that tick by hand. */
  schedule: AutoRangedSchedule = INTERVAL;
  #active = false;
  #wanted: number | undefined;
  #handle: unknown;
  readonly #tick = (): void => this.tick();

  constructor(host: AutoRangedCombatHost) {
    this.#host = host;
  }

  /** The mode runs (+0x1858 bit 2): the controller is registered. */
  get active(): boolean {
    return this.#active;
  }

  /** The spell the controller wants repeated (0x00d397cc), cast or about to be. */
  get wantedSpellId(): number | undefined {
    return this.#wanted;
  }

  /**
   * 05.10-3.01: how many times 0x007fe190 has run — the wanted spell's remembered refusal (0x00d397c8)
   * forgotten, read by the combat log's SPELL_CAST_FAILED rules (FrameXmlCombatLogCasts.ts). Its three
   * callers: StopAttack 0x006e1660 ({@link stop}), the swing 0x006e2610 (WorldClient.startAttack) and this
   * controller's shot ({@link tick}).
   */
  get failureResets(): number {
    return this.#failureResets;
  }

  /** 05.10-3.01: one more 0x007fe190. */
  noteFailureReset(): void {
    this.#failureResets++;
  }

  #failureResets = 0; // 05.10-3.01

  /**
   * 0x006e4950's ranged branch, after the mount rules: a unit CanAttack refuses stops a running mode;
   * otherwise the controller is registered and, unless `tickNow` is false (a hand-cast shot entering the
   * mode, 0x0080cce0), runs once at once.
   */
  begin(target: WorldObjectState, tickNow = true): void {
    const host = this.#host;
    if (!host.canAttack(target)) {
      // 0x005140e0: bit 2, or a swing — then 0x006e1660.
      if (this.#active || host.meleeAttacking()) host.stopAttack();
      return;
    }
    if (!this.#active) {
      this.#active = true;
      this.#handle = this.schedule.start(this.#tick);
    }
    if (tickNow) this.tick();
  }

  /** 0x006e2be0. Allocation-free: it runs every tick of a fight. */
  tick(): void {
    if (!this.#active) return;
    const host = this.#host;
    const player = host.player();
    const target = host.selection();
    if (!player || !target) return;
    const spell = host.rangedSpell();
    if (spell === undefined) {
      this.#wanted = undefined;
      return;
    }
    if (withinAutoRangedMelee(player, target)) {
      // 0x006e2610 refuses an unattackable unit without a word; a running swing is left alone.
      if (!host.meleeAttacking() && host.canAttack(target)) {
        this.#wanted = undefined;
        host.swing();
      }
      return;
    }
    if (host.repeatingSpell() !== undefined) return;
    if (!host.canAttack(target)) {
      host.stopAttack();
      return;
    }
    const limits = host.limits(spell, player, target);
    const min = limits?.min ?? 0;
    const max = limits?.max ?? 0;
    const distance = distanceSquared(player, target);
    if (distance <= min * min && host.meleeAttacking()) return;
    if (host.meleeAttacking()) host.stopSwing();
    if (this.#wanted === undefined) this.#wanted = spell;
    if (facesForShot(player, target) && (player.movementFlags & AUTO_RANGED_STILL_MASK) === 0 && distance < max * max
      && host.shoot(spell, target) !== false) { // 05.10-5.05: only a shot that went out
      // 05.10-3.01: 0x006e2df3 — 0x007fe190 once 0x0080da40 has cast the shot (here: once it is asked for).
      this.#failureResets++;
    }
  }

  /** 0x006e1660's half: the wanted spell dropped — its repeat cancelled when that is what runs — and the mode left. */
  stop(): void {
    this.#failureResets++; // 05.10-3.01: 0x006e16d2 — 0x006e1660 calls 0x007fe190 every time
    if (this.#wanted !== undefined) {
      this.#wanted = undefined;
      const spell = this.#host.rangedSpell();
      if (spell !== undefined && this.#host.repeatingSpell() === spell) this.#host.cancelRepeat();
    }
    this.end();
  }

  /** 0x006cf2a0: the wanted spell cleared, the controller unregistered. */
  end(): void {
    this.#wanted = undefined;
    if (!this.#active) return;
    this.#active = false;
    this.schedule.stop(this.#handle);
    this.#handle = undefined;
  }
}
