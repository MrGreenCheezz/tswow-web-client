// When a melee victim reacts, and with what (6.06, line A7a, 05.10-A7a-D2).
//
// Wow.exe does not react the victim when SMSG_ATTACKERSTATEUPDATE arrives. The opcode switch
// (`0x756800`, case 0x14A) parses the packet (`0x755630`), plays the attacker's swing (`0x755130`) and
// stores the whole record on the attacker (`+0xb98`). The victim's half is played from the
// attacker's own model events, in the unit's M2 event handler `0x756240`:
// * `$CPP` — parry (by the victim's main hand, `0x73b050`), dodge for DODGE and DEFLECTS, else a
//   shield block whenever the record carries a blocked amount; skipped for a feigning victim;
//   Each of the three branches then clears HITINFO_AFFECTS_VICTIM in the stored record (05.10 review
//   D2: `and [+0xba8], ~2` at 0x75650d / 0x756552 / 0x756580) — a parried, dodged or blocked blow
//   never flinches afterwards, partial blocks included;
// * `$AH0`..`$AH3` and `$CAH` — the impact sound, then `0x755e40` on the victim: combat text, then,
//   with HITINFO_AFFECTS_VICTIM, the wound `0x736640` — CombatCritical for a crit, CombatWound when
//   the victim has a melee target of its own (`+0xa20`, written by SMSG_ATTACK_START, cleared by
//   SMSG_ATTACK_STOP), StandWound otherwise. The damage is not read.
// A record whose events never fired is flushed without any animation by the attacker's next swing
// (`0x756180` → `0x755a60`: text and sounds only) or by SMSG_ATTACK_STOP (`0x756770`). An attacker
// the client does not know gets no record: `0x755e40` runs at once — the wound, never the parry.
//
// The events are per model and per sequence; the visual model artifact does not carry M2 event
// tracks, so the moments here are the medians measured over 14 models (114 `$CPP` and 116 `$CAH`
// keys on Attack* sequences, `.runtime/re-2026-10-05/A7a-D2/probe-events.mjs`), read against the
// attacker's real swing clock: the renderer reports how far the swing it queued has played.
//
// 05.10-A7a-D3: Wow.exe plays the swing whether or not our renderer draws it — an attacker over the
// unit budget, a running quadruped whose rig has no upper-body cut (the swing yields), a cast above
// the melee layer refusing it, a clip still on the wire — and the events fire on its clock. So a
// record with no drawn swing to read runs on a nominal clock started at the first tick after
// arrival: the attacker's own Attack clip length when the host knows it (the renderer resolved the
// clip but could not draw it), else SWING_NOMINAL_MS; with no knowable length both cues fire at once.
// A swing that the renderer did draw takes the clock over. Only an attacker that is gone (despawned,
// dead) or a drawn swing cut short drops the record unfired, as before.
//
// Pure. Records are pooled and the per-frame walk is a `forEach` with a bound step: no allocation
// per frame, one pooled record per attacker per swing.

import {
  HITINFO_AFFECTS_VICTIM, HITINFO_CRITICAL, VICTIMSTATE_DEFLECTS, VICTIMSTATE_DODGE, VICTIMSTATE_PARRY,
} from "../../world/CombatProtocol.js";
import type { CombatReaction } from "./CombatAnimations.js";

/** `$CPP` as a fraction of the attack sequence: median 0.13 (quartiles 0.10–0.20). */
export const CUE_PARRY = 0.13;
/** `$CAH` as a fraction of the attack sequence: median 0.43 (quartiles 0.40–0.51). */
export const CUE_HIT = 0.43;
/** `HITINFO_NO_ANIMATION` (`UnitDefines.h:378`): `0x755130` draws no swing, so no event follows. */
export const HITINFO_NO_ANIMATION = 0x00040000;
/**
 * 05.10-A7a-D3: the length of a swing nobody drew, in ms. The median sequence length of the attack
 * sequences carrying `$CAH` in `probe-events.out.txt` (14 models): 1000 ms (quartiles 1000–1233,
 * range 900–1500; HumanMale Attack1H/AttackUnarmed/AttackOff 1000, Attack2HL 1333).
 */
export const SWING_NOMINAL_MS = 1_000;

/** The part of SMSG_ATTACKERSTATEUPDATE the cues read (`AttackerState` is wider). */
export interface CuedSwing {
  attacker: bigint;
  victim: bigint;
  hitInfo: number;
  victimState: number;
  /** The blocked amount; present only with HITINFO_BLOCK, 0 otherwise. */
  blocked: number;
}

/** What `$CPP` plays on the victim (`0x756240`): parry, dodge (DEFLECTS too), or a raised shield. */
export function parryCueReaction(swing: { victimState: number; blocked: number }): "parry" | "dodge" | "block" | undefined {
  if (swing.victimState === VICTIMSTATE_PARRY) return "parry";
  if (swing.victimState === VICTIMSTATE_DODGE || swing.victimState === VICTIMSTATE_DEFLECTS) return "dodge";
  return swing.blocked !== 0 ? "block" : undefined;
}

/** What `$CAH` plays on the victim (`0x755e40` → `0x736640`): by the bit and the crit, never by damage. */
export function hitCueReaction(swing: { hitInfo: number }, victimAttacking: boolean): "critical" | "wound" | "standWound" | undefined {
  if ((swing.hitInfo & HITINFO_AFFECTS_VICTIM) === 0) return undefined;
  if ((swing.hitInfo & HITINFO_CRITICAL) !== 0) return "critical";
  return victimAttacking ? "wound" : "standWound";
}

/** The renderer and the world, as the cues need them. */
export interface SwingCueHost {
  /**
   * How far the swing queued as `token` has played on `attacker`: a fraction (1 once it ran out);
   * undefined when there is no drawn swing to read but the attacker is still there (waiting, never
   * drawn, refused: `token` undefined) — the cues then run the nominal clock (05.10-A7a-D3); null
   * when the attacker is gone or dead, or a drawn swing was cut short: the record goes unfired.
   */
  swingProgress(attacker: bigint, token: object | undefined, now: number): number | undefined | null;
  /** 05.10-A7a-D3: the attacker's swing length in ms for the nominal clock; SWING_NOMINAL_MS without it. */
  swingDuration?(attacker: bigint, token: object | undefined): number;
  /**
   * 05.10-A7a-D3: whether `unit` is still the object whose SMSG_ATTACK_START left `stamp` — `+0xa20`
   * lives on the unit object and goes with it. Without it every stamp counts.
   */
  sameUnit?(unit: bigint, stamp: object): boolean;
  /** Alive and not feigning death (`0x71f560`), and known to the client. */
  canReact(victim: bigint): boolean;
  /** `SHEATH_STATE_UNARMED` in `UNIT_FIELD_BYTES_2` byte 0: `0x73b050` parries unarmed. */
  sheathed(victim: bigint): boolean;
  react(victim: bigint, reaction: CombatReaction): void;
}

const CUE_PARRY_BIT = 1;
const CUE_HIT_BIT = 2;

interface PendingSwing {
  victim: bigint;
  hitInfo: number;
  victimState: number;
  blocked: number;
  token: object | undefined;
  cues: number;
  /** 05.10-A7a-D3: the nominal clock's start, the first tick after arrival; NaN until then. */
  at: number;
}

export class SwingReactionCues {
  readonly #pending = new Map<bigint, PendingSwing>();
  readonly #spare: PendingSwing[] = [];
  /**
   * Units with a melee target of their own (`+0xa20`): attacker → the unit object the start was
   * written on (05.10-A7a-D3), or undefined when the host gave none.
   */
  readonly #meleeTargets = new Map<bigint, object | undefined>();
  #host: SwingCueHost | undefined;
  #now = 0;
  readonly #step = (pending: PendingSwing, attacker: bigint): void => this.#advance(pending, attacker);

  /** Records waiting for their attacker's events. */
  get pending(): number {
    return this.#pending.size;
  }

  /** Pooled records (tests). */
  get spare(): number {
    return this.#spare.length;
  }

  /**
   * SMSG_ATTACK_START (`0x756800` case 0x143 writes the attacker's `+0xa20`). `stamp` names the
   * attacker's unit object, so a destroyed and recreated unit starts without it (05.10-A7a-D3).
   */
  attackStarted(attacker: bigint, _victim: bigint, stamp?: object): void {
    this.#meleeTargets.set(attacker, stamp);
  }

  /** SMSG_ATTACK_STOP (`0x756770`): the target is cleared and an unfired record goes unseen. */
  attackStopped(attacker: bigint): void {
    this.#meleeTargets.delete(attacker);
    this.#drop(attacker);
  }

  /**
   * A swing arrived. `token` is the swing the renderer queued on the attacker (undefined when none
   * was: refused, no renderer, or HITINFO_NO_ANIMATION); `attackerKnown` whether the client has the attacker.
   */
  swing(swing: CuedSwing, token: object | undefined, attackerKnown: boolean, host: SwingCueHost): void {
    // 0x756180: the previous record of this attacker leaves without an animation.
    this.#drop(swing.attacker);
    if (!attackerKnown) {
      this.#fireHit(swing.victim, swing, host);
      return;
    }
    // 0x755130 draws no swing for HITINFO_NO_ANIMATION: no model event, the record waits for a flush
    // that animates nothing. 05.10-A7a-D3: a swing merely not drawn by us (no token) still cues.
    if ((swing.hitInfo & HITINFO_NO_ANIMATION) !== 0) return;
    // A record that can play nothing (a miss, an evade, an immunity) is not kept.
    if ((swing.hitInfo & HITINFO_AFFECTS_VICTIM) === 0 && parryCueReaction(swing) === undefined) return;
    const pending = this.#spare.pop()
      ?? { victim: 0n, hitInfo: 0, victimState: 0, blocked: 0, token: undefined, cues: 0, at: Number.NaN };
    pending.victim = swing.victim;
    pending.hitInfo = swing.hitInfo;
    pending.victimState = swing.victimState;
    pending.blocked = swing.blocked;
    pending.token = token;
    pending.cues = CUE_PARRY_BIT | CUE_HIT_BIT;
    pending.at = Number.NaN;
    this.#pending.set(swing.attacker, pending);
  }

  /** Once per frame, after the units have animated. */
  tick(now: number, host: SwingCueHost): void {
    if (this.#pending.size === 0) return;
    this.#host = host;
    this.#now = now;
    this.#pending.forEach(this.#step);
    this.#host = undefined;
  }

  /** Leaving the world. */
  clear(): void {
    for (const attacker of [...this.#pending.keys()]) this.#drop(attacker);
    this.#meleeTargets.clear();
  }

  #advance(pending: PendingSwing, attacker: bigint): void {
    const host = this.#host!;
    const now = this.#now;
    if (Number.isNaN(pending.at)) pending.at = now;
    let progress = host.swingProgress(attacker, pending.token, now);
    if (progress === null) {
      this.#drop(attacker);
      return;
    }
    if (progress === undefined) {
      // 05.10-A7a-D3: no drawn swing to read — Wow.exe's own swing runs on regardless.
      const duration = host.swingDuration?.(attacker, pending.token) ?? SWING_NOMINAL_MS;
      progress = duration > 0 && Number.isFinite(duration) ? (now - pending.at) / duration : 1;
    }
    if ((pending.cues & CUE_PARRY_BIT) !== 0 && progress >= CUE_PARRY) {
      pending.cues &= ~CUE_PARRY_BIT;
      const reaction = parryCueReaction(pending);
      if (reaction !== undefined && host.canReact(pending.victim)) {
        host.react(pending.victim, reaction === "parry" && host.sheathed(pending.victim) ? "parryUnarmed" : reaction);
        // 05.10 review D2: every branch of `$CPP` that ran clears AFFECTS_VICTIM in the stored record
        // (0x75650d / 0x756552 / 0x756580), so `$CAH` has no wound to play after a parry, dodge or block.
        pending.hitInfo &= ~HITINFO_AFFECTS_VICTIM;
      }
    }
    if ((pending.cues & CUE_HIT_BIT) !== 0 && progress >= CUE_HIT) {
      pending.cues &= ~CUE_HIT_BIT;
      this.#fireHit(pending.victim, pending, host);
    }
    if (pending.cues === 0) this.#drop(attacker);
  }

  #fireHit(victim: bigint, swing: { hitInfo: number }, host: SwingCueHost): void {
    const reaction = hitCueReaction(swing, this.#hasMeleeTarget(victim, host));
    if (reaction !== undefined && host.canReact(victim)) host.react(victim, reaction);
  }

  /** 05.10-6.21: `+0xa20` for a kit's wound (Wow.exe 0x736640 via 0x73b140), same rule as a swing's. */
  hasMeleeTarget(unit: bigint, host: Pick<SwingCueHost, "sameUnit">): boolean {
    return this.#hasMeleeTarget(unit, host);
  }

  /** 05.10-A7a-D3: `+0xa20` of the unit as it is now — a start left on an object since destroyed does not count. */
  #hasMeleeTarget(unit: bigint, host: Pick<SwingCueHost, "sameUnit">): boolean { // 05.10-6.21: Pick
    if (!this.#meleeTargets.has(unit)) return false;
    const stamp = this.#meleeTargets.get(unit);
    if (stamp === undefined || host.sameUnit === undefined || host.sameUnit(unit, stamp)) return true;
    this.#meleeTargets.delete(unit);
    return false;
  }

  #drop(attacker: bigint): void {
    const pending = this.#pending.get(attacker);
    if (pending === undefined) return;
    this.#pending.delete(attacker);
    pending.token = undefined;
    this.#spare.push(pending);
  }
}
