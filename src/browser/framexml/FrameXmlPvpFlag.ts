/**
 * The player's PvP flag as the stock unit menu and PlayerFrame see it: `GetPVPDesired`, `SetPVP`,
 * `TogglePVP`, `IsPVPTimerRunning` and `GetPVPTimer`.
 *
 * Callers in the 3.3.5 corpus: UnitPopup.lua:352-358 ticks «PvP on/off» by `GetPVPDesired() == 1`
 * and `== 0` — a number, not a boolean — and :1319/:1321 send `SetPVP(1)` and `SetPVP(nil)`;
 * PlayerFrame.lua:152-157 and :235-240 show PlayerPVPTimerText on PLAYER_ENTERING_WORLD and
 * PLAYER_FLAGS_CHANGED while `IsPVPTimerRunning()`, seeded with `GetPVPTimer()` in milliseconds, and
 * :413-421 count it down by the frame time.
 *
 * What the original client does (Wow.exe 3.3.5a build 12340, read-only Ghidra project; the Lua C
 * functions found through their registration entries in .data):
 * * `GetPVPDesired` (0x51bca0) answers the `PLAYER_FLAGS_IN_PVP` bit of the player's own PLAYER_FLAGS
 *   as the number 1 or 0, and 0 with no player object.
 * * `IsPVPTimerRunning` (0x51bd60) answers 1 while `PLAYER_FLAGS_PVP_TIMER` is set, nil otherwise.
 * * `GetPVPTimer` (0x51bd00) adds 1000 to what the player object's timer
 *   helper (0x6de7a0) gives: 300000 while the timer bit is clear; while it is set, the milliseconds
 *   left to a deadline the client keeps itself, or -1 once it passed or was never set. 0 without a
 *   player. The server sends no deadline: the client sets its own to «now + 300000» whenever
 *   PLAYER_FLAGS changes and the timer bit was not already up both before and after (0x6de750), and
 *   clears it while `IN_PVP` is set. On entering the world (0x6e7f50) it is set only when the timer
 *   bit is clear — a character logging in with the timer already running has no deadline and reads
 *   999 ms.
 * * `TogglePVP` (0x516840) sends CMSG_TOGGLE_PVP with no body; `SetPVP` (0x5168b0) sends it with one
 *   byte: the argument rounded to an integer when Lua sees a number (a numeric string too), else 0.
 *   So `SetPVP(nil)` and `SetPVP(true)` both switch the flag off. TrinityCore reads the byte as a
 *   bool (`HandleTogglePvP`, MiscHandler.cpp:560-572).
 */
import { PLAYER_FLAGS_IN_PVP, PLAYER_FLAGS_PVP_TIMER } from "../../world/Fields.js";

/** The five minutes TrinityCore keeps the flag after it was switched off (Player.cpp's `EndTimer + 300`). */
export const FRAMEXML_PVP_TIMER_MS = 300_000;
/** What the client's `GetPVPTimer` adds to its helper's answer (0x51bd00). */
const PVP_TIMER_BIAS_MS = 1000;

/** Lua's `lua_isnumber`/`lua_tonumber` for a host value: a number, or a string that reads as one. */
export function frameXmlLuaNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isNaN(value) ? undefined : value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The x87 `FISTP` the client converts Lua numbers with: round to nearest, ties to even. */
export function frameXmlRoundToInt(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** `GetPVPDesired`'s number. */
export function frameXmlPvpDesired(flags: number | undefined): 0 | 1 {
  return flags !== undefined && (flags & PLAYER_FLAGS_IN_PVP) !== 0 ? 1 : 0;
}

export function frameXmlPvpTimerRunning(flags: number | undefined): boolean {
  return flags !== undefined && (flags & PLAYER_FLAGS_PVP_TIMER) !== 0;
}

/** `SetPVP(value)`'s wire byte, read as TrinityCore reads it: anything but a zero byte is «on». */
export function frameXmlSetPvpEnable(value: unknown): boolean {
  const number = frameXmlLuaNumber(value);
  if (number === undefined || !Number.isFinite(number)) return false;
  return (frameXmlRoundToInt(number) & 0xff) !== 0;
}

export interface FrameXmlPvpFlagContext {
  /** PLAYER_FLAGS of the player's own object; undefined while there is none. */
  flags(): number | undefined;
  /** A millisecond clock that keeps running (the seam's `monotonic`). */
  now(): number;
  /** `WorldClient.togglePvp`: no argument toggles, a boolean sets. */
  togglePvp?(enable?: boolean): void;
}

export class FrameXmlPvpFlagModel {
  readonly #context: FrameXmlPvpFlagContext;
  /** The flags the deadline was last decided on; undefined before the first look. */
  #flags: number | undefined;
  /** The client's own deadline for the timer, on `now()`'s clock; 0 is «none». */
  #deadline = 0;

  constructor(context: FrameXmlPvpFlagContext) {
    this.#context = context;
  }

  /**
   * Entering the world (0x6e7f50's rule): a deadline only when the timer bit is clear, none while
   * `IN_PVP` is set; a timer already running keeps no deadline.
   */
  enterWorld(): void {
    const flags = this.#context.flags();
    this.#flags = flags;
    this.#deadline = 0;
    if (flags === undefined) return;
    if ((flags & PLAYER_FLAGS_IN_PVP) === 0 && (flags & PLAYER_FLAGS_PVP_TIMER) === 0) {
      this.#deadline = this.#context.now() + FRAMEXML_PVP_TIMER_MS;
    }
  }

  /** PLAYER_FLAGS changed (0x6de750's rule, the previous word against the new one). */
  flagsChanged(): void {
    const next = this.#context.flags();
    const previous = this.#flags;
    // The first word of a player object that did not exist yet is its entering the world.
    if (previous === undefined) {
      this.enterWorld();
      return;
    }
    this.#flags = next;
    if (next === undefined) return;
    if ((next & PLAYER_FLAGS_IN_PVP) !== 0) {
      this.#deadline = 0;
      return;
    }
    const wasRunning = previous !== undefined && (previous & PLAYER_FLAGS_PVP_TIMER) !== 0;
    if ((next & PLAYER_FLAGS_PVP_TIMER) === 0 || !wasRunning) this.#deadline = this.#context.now() + FRAMEXML_PVP_TIMER_MS;
  }

  desired(): 0 | 1 {
    return frameXmlPvpDesired(this.#context.flags());
  }

  timerRunning(): boolean {
    return frameXmlPvpTimerRunning(this.#context.flags());
  }

  /** `GetPVPTimer()`: milliseconds, with the client's own +1000. */
  timer(): number {
    const flags = this.#context.flags();
    if (flags === undefined) return 0;
    if (!frameXmlPvpTimerRunning(flags)) return FRAMEXML_PVP_TIMER_MS + PVP_TIMER_BIAS_MS;
    const now = this.#context.now();
    const left = this.#deadline !== 0 && this.#deadline > now ? this.#deadline - now : -1;
    return left + PVP_TIMER_BIAS_MS;
  }

  set(value: unknown): void {
    this.#context.togglePvp?.(frameXmlSetPvpEnable(value));
  }

  toggle(): void {
    this.#context.togglePvp?.();
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlPvpFlagHost {
  readonly pvpFlag?: FrameXmlPvpFlagModel | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);
const NIL: readonly unknown[] = Object.freeze([undefined]);

export const FRAMEXML_PVP_FLAG_BINDINGS: Readonly<Record<string,
  (host: FrameXmlPvpFlagHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  GetPVPDesired: (host) => [host.pvpFlag?.desired() ?? 0],
  IsPVPTimerRunning: (host) => (host.pvpFlag?.timerRunning() ? [1] : NIL),
  GetPVPTimer: (host) => [host.pvpFlag?.timer() ?? 0],
  SetPVP: (host, args) => {
    host.pvpFlag?.set(args[0]);
    return NOTHING;
  },
  TogglePVP: (host) => {
    host.pvpFlag?.toggle();
    return NOTHING;
  },
});
