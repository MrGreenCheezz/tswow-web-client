import type { MissileShot } from "./MissileTrajectory.js";
import type { SpellMissileEntry } from "./SpellMissileDbc.js";

/**
 * 11.02-E: the two halves of a trajectory cast that `WorldClient` cannot do by itself — knowing the
 * spell's SpellMissile row and solving the shot over the world's geometry — and the note Wow.exe keeps
 * between a cast and its re-aim (MissileTrajectory.ts has the addresses).
 *
 * The page registers the source (browser/game/MissileShot.ts: the missile tables, the vehicle tables,
 * the mover's pitch, the terrain and the collision world); without it — or before the tables land, or
 * against a gateway without the route — no spell is a trajectory spell and every cast is the packet it
 * was before this slice.
 */
export interface MissileShotSource {
  /** Starts fetching the tables when they are not here yet; cheap when they are. */
  prime?(): void;
  /** The spell's SpellMissile row when it makes it a trajectory cast (Flags bit 0); undefined otherwise or unknown. */
  trajectoryMissile(spellId: number): SpellMissileEntry | undefined;
  /** 0x006fcd60 for a cast: where a missile of `spellId` fired by `casterGuid` goes with the aim as it is now. */
  shot(casterGuid: bigint, spellId: number): MissileShot | undefined;
}

let registered: MissileShotSource | undefined;

/** The page's source (one per page; the tables belong to the gateway, not to a world session). */
export function setMissileShotSource(source: MissileShotSource | undefined): void {
  registered = source;
}

export function missileShotSource(): MissileShotSource | undefined {
  return registered;
}

/**
 * A vehicle's bar (`Player::VehicleSpellInitialize`, Player.cpp:21469-21491: slot i carries state i + 8, empty or
 * not): the page fetches the missile tables when one arrives, before the vehicle's first shot. A pet's or a
 * charmed unit's bar (states 1, 6, 7 under `& 0x3F`) asks nothing.
 */
export function isVehicleSpellBar(bar: readonly { readonly packed: number }[]): boolean {
  for (const button of bar) {
    const state = (button.packed >>> 24) & 0x3f;
    if (state >= 8 && state <= 15) return true;
  }
  return false;
}

/** SpellCastResult (SharedDefines.h:1009, 1082): 0x00809f80's two refusals. */
export const SPELL_FAILED_ERROR = 32;
export const SPELL_FAILED_SPELL_IN_PROGRESS = 105;

/**
 * How a cast goes out (0x0080ac90 → 0x00809f80): undefined — not a trajectory spell (or nothing known
 * about it): the packet as before; `refused` — nothing is sent (0 silently: the caster is not the active
 * mover; else the SpellCastResult the client reports itself); `shot` — flag 2 with the shot.
 */
export type MissileCastPlan = undefined | { readonly refused: number } | { readonly shot: MissileShot };

export function missileCastPlan(source: MissileShotSource | undefined, tracker: MissileTrajectoryTracker, spellId: number,
  casterGuid: bigint, moverGuid: bigint | undefined): MissileCastPlan {
  if (source === undefined || source.trajectoryMissile(spellId) === undefined) return undefined;
  // 0x0080b3ad: "Missile trajectory does not have active mover caster" — the cast is dropped.
  if (casterGuid !== moverGuid) return { refused: 0 };
  // 0x00809f80 → 0x006fbeb0: the last trajectory cast has started and not been re-aimed yet.
  if (tracker.inProgress(casterGuid)) return { refused: SPELL_FAILED_SPELL_IN_PROGRESS };
  const shot = source.shot(casterGuid, spellId);
  // "Could not compute missile trajectory" (0x0080a1d6) → SPELL_FAILED_ERROR. 11.02-E-review: so is a shot with a number
  // that is not finite — no packet can carry it (SpellTargets.ts refuses the point), and a cast must not be tracked as sent.
  return shot === undefined || !finiteShot(shot) ? { refused: SPELL_FAILED_ERROR } : { shot };
}

/** 11.02-E-review: every number a trajectory packet writes is finite. */
function finiteShot(shot: MissileShot): boolean {
  const { fire, impact } = shot;
  return Number.isFinite(shot.elevation) && Number.isFinite(shot.speed)
    && Number.isFinite(fire.x) && Number.isFinite(fire.y) && Number.isFinite(fire.z)
    && Number.isFinite(impact.x) && Number.isFinite(impact.y) && Number.isFinite(impact.z);
}

/** What Wow.exe keeps on the casting unit: +0xf68 spell, +0xf6c sent at, +0xf70 started at, +0xf74 cast time. */
interface TrajectoryNote {
  readonly guid: bigint;
  readonly spellId: number;
  readonly sentAt: number;
  startedAt: number;
  castTime: number;
}

export interface MissileTimers {
  set(callback: () => void, delay: number): unknown;
  clear(handle: unknown): void;
}

const SYSTEM_TIMERS: MissileTimers = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The note between a trajectory cast and its one re-aim. Wow.exe tests the due time every frame
 * (0x006fe7e0 from 0x004fa5f0); a timer armed at SMSG_SPELL_START fires at the same moment.
 */
export class MissileTrajectoryTracker {
  readonly #onDue: (guid: bigint, spellId: number) => void;
  readonly #timers: MissileTimers;
  #note: TrajectoryNote | undefined;
  #timer: unknown;

  constructor(onDue: (guid: bigint, spellId: number) => void, timers: MissileTimers = SYSTEM_TIMERS) {
    this.#onDue = onDue;
    this.#timers = timers;
  }

  /** 0x006fbeb0: a trajectory cast of this unit has started and has not been re-aimed yet. */
  inProgress(guid: bigint): boolean {
    const note = this.#note;
    return note !== undefined && note.guid === guid && note.startedAt !== 0;
  }

  /** 0x006fbe30, after the cast went out: the spell and when. */
  cast(guid: bigint, spellId: number, now: number): void {
    this.#cancel();
    this.#note = { guid, spellId, sentAt: now > 0 ? now : 1, startedAt: 0, castTime: 0 };
  }

  /**
   * 0x006fbe50 from SMSG_SPELL_START (0x00806700: the active mover's cast with a cast time): the start and
   * the cast time of the noted spell; the re-aim falls due `castTime` after the cast was sent.
   */
  spellStart(guid: bigint, spellId: number, castTime: number, now: number): boolean {
    const note = this.#note;
    if (note === undefined || note.guid !== guid || note.spellId !== spellId || !(castTime > 0)) return false;
    note.startedAt = now > 0 ? now : 1;
    note.castTime = castTime;
    this.#cancel();
    const delay = note.sentAt + castTime - now;
    this.#timer = this.#timers.set(() => this.#fire(note), delay > 0 ? delay : 0);
    return true;
  }

  /** 0x006fe7e0's test: started, and `now − castTime − sentAt` is not negative. */
  isDue(now: number): boolean {
    const note = this.#note;
    return note !== undefined && note.startedAt !== 0 && now - note.castTime - note.sentAt >= 0;
  }

  /**
   * 0x006fbe80: forgets the note of `spellId` (or any) — of the unit `guid` when one is named (the function is the
   * unit's own). 11.02-E-review: also what a failed or interrupted cast does (0x007fecc0 → 0x007fec00, whose last
   * call at 0x007fecb6 is 0x006fbe80 for the ended cast's spell).
   */
  clear(spellId?: number, guid?: bigint): void {
    const note = this.#note;
    if (note === undefined || (spellId !== undefined && note.spellId !== spellId) || (guid !== undefined && note.guid !== guid)) return;
    this.#cancel();
    this.#note = undefined;
  }

  /** The session ends: no timer outlives it. */
  dispose(): void {
    this.#cancel();
    this.#note = undefined;
  }

  #fire(note: TrajectoryNote): void {
    this.#timer = undefined;
    if (this.#note !== note) return;
    this.#note = undefined;
    this.#onDue(note.guid, note.spellId);
  }

  #cancel(): void {
    if (this.#timer === undefined) return;
    this.#timers.clear(this.#timer);
    this.#timer = undefined;
  }
}
