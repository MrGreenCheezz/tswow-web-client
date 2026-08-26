/**
 * How long frames are taking, and what they cost.
 *
 * Every budget in the renderer carries a comment saying slice R8 is where its number stops being
 * guessed at, and none of them could be: nothing in the client measured a frame. This is the
 * instrument — a ring of the last two seconds of frame times, and the draw calls and triangles the
 * WebGL renderer reports — and it is a module of its own because a ring buffer and a percentile are
 * exactly the kind of thing that is wrong by one and never noticed.
 *
 * The worst frame matters more than the mean. Sixty frames a second with one frame of eighty
 * milliseconds in every hundred reads as a stutter, and a mean of 17 ms hides it completely.
 */

/** Two seconds at sixty frames, which is long enough for one hitch to still be in the window. */
export const FRAME_WINDOW = 120;

export class FrameClock {
  readonly #samples: Float64Array;
  #at = 0;
  #filled = 0;
  #total = 0;

  constructor(window = FRAME_WINDOW) {
    this.#samples = new Float64Array(Math.max(1, Math.floor(window)));
  }

  /** One frame, in milliseconds. Anything not finite is dropped rather than poisoning the mean. */
  add(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    const size = this.#samples.length;
    this.#total += milliseconds - (this.#filled === size ? this.#samples[this.#at]! : 0);
    this.#samples[this.#at] = milliseconds;
    this.#at = (this.#at + 1) % size;
    if (this.#filled < size) this.#filled++;
  }

  get count(): number {
    return this.#filled;
  }

  /** The mean frame time over the window, or zero before the first frame. */
  get average(): number {
    return this.#filled === 0 ? 0 : this.#total / this.#filled;
  }

  /** Frames a second at that mean. Zero rather than infinity when nothing has been measured. */
  get fps(): number {
    const average = this.average;
    return average > 0 ? 1000 / average : 0;
  }

  /**
   * The longest frame in the window, which is the one the player feels.
   *
   * The maximum rather than a high percentile, and that is a deliberate choice: a run that stutters
   * five times a second has a ninety-fifth percentile of exactly its good frame, because 95% of its
   * frames *are* good. The window is two seconds, so this is "the worst frame in the last two
   * seconds" and not a lifetime record that never recovers.
   */
  get worst(): number {
    let worst = 0;
    for (let index = 0; index < this.#filled; index++) worst = Math.max(worst, this.#samples[index]!);
    return worst;
  }

  reset(): void {
    this.#samples.fill(0);
    this.#at = 0;
    this.#filled = 0;
    this.#total = 0;
  }
}

/**
 * Whether the environment ranking has to run again.
 *
 * It costs 1.26 milliseconds a frame in Stormwind — 42,797 placements over the nine tiles around
 * the city, ranked from scratch every frame, standing still included — which is 7.6% of a sixteen
 * millisecond budget spent to arrive at the answer it already had. That measurement was at the
 * former 230-yard leash; the live leash is now 300 yards, while the selected placement budget is
 * unchanged. Four yards is still small enough that nothing is ever drawn late.
 *
 * The generation is the other half: a tile landing adds placements, and the cache has to notice.
 */
export const RESELECT_DISTANCE = 4;

export function shouldReselect(
  last: { x: number; y: number; generation: number } | undefined,
  player: { x: number; y: number },
  generation: number,
  distance = RESELECT_DISTANCE,
): boolean {
  if (!last || last.generation !== generation) return true;
  return Math.hypot(player.x - last.x, player.y - last.y) >= distance;
}
