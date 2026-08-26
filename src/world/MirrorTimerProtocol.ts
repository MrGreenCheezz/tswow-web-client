import { PacketReader } from "../protocol/PacketReader.js";

/**
 * The bars that count down while the world is doing something to you.
 *
 * Three of them, and the server owns all three: it decides from its own `GetLiquidStatus` whether
 * the character is under water, in fatigue-inducing deep water or standing in lava, and pushes a
 * timer. Nothing about them is computable in the client — which is why the drowning breath bar
 * could not exist until these three opcodes were read.
 *
 * `MirrorTimerType`, `Player.h:450`.
 */
export const MIRROR_TIMER_FATIGUE = 0;
export const MIRROR_TIMER_BREATH = 1;
export const MIRROR_TIMER_FIRE = 2;

/** What each one is called on screen. */
export const MIRROR_TIMER_NAMES: Readonly<Record<number, string>> = {
  [MIRROR_TIMER_FATIGUE]: "Усталость",
  [MIRROR_TIMER_BREATH]: "Дыхание",
  [MIRROR_TIMER_FIRE]: "Огонь",
};

export interface MirrorTimer {
  timer: number;
  /** Milliseconds left when the packet was sent. */
  value: number;
  maxValue: number;
  /**
   * How fast the value moves, and in which direction: -1 while the breath runs out, +1 while it
   * comes back on dry land. Signed, and read as signed — a regenerating timer sent as unsigned is
   * four billion milliseconds a second.
   */
  scale: number;
  paused: boolean;
  spellId: number;
}

/** `WorldPackets::Misc::StartMirrorTimer::Write`, `MiscPackets.cpp:44`. */
export function parseStartMirrorTimer(payload: Uint8Array): MirrorTimer {
  const reader = new PacketReader(payload);
  const timer = { timer: reader.u32(), value: reader.u32(), maxValue: reader.u32(), scale: reader.i32(), paused: reader.u8() !== 0, spellId: reader.u32() };
  reader.assertFinished();
  return timer;
}

/** `PauseMirrorTimer`: the same timer, held where it stands. */
export function parsePauseMirrorTimer(payload: Uint8Array): { timer: number; paused: boolean } {
  const reader = new PacketReader(payload);
  const paused = { timer: reader.u32(), paused: reader.u8() !== 0 };
  reader.assertFinished();
  return paused;
}

/** `StopMirrorTimer`: which one to take off the screen. */
export function parseStopMirrorTimer(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const timer = reader.u32();
  reader.assertFinished();
  return timer;
}

/**
 * How much is left now, run forward from when the packet arrived.
 *
 * The server sends one packet and expects the bar to keep moving; sending a packet a frame for
 * three separate timers is not something it does. `scale` is what it moves by, in milliseconds
 * per millisecond.
 */
export function mirrorTimerRemaining(timer: MirrorTimer, receivedAt: number, now: number): number {
  if (timer.paused) return timer.value;
  const elapsed = Math.max(0, now - receivedAt);
  return Math.max(0, Math.min(timer.maxValue, timer.value + elapsed * timer.scale));
}
