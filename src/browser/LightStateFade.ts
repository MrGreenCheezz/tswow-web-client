// 05.10-A7b-5 (7.15): how far the world light has turned into the death light.
//
// `Light.dbc` slot 4 is a different sky altogether — six sets across the 715 rows, four of them
// carrying `DeathSkybox` — so switching it on the frame the ghost flag arrives would snap the
// whole screen. The fade is a rendering clock, like the storm weight and SMSG_OVERRIDE_LIGHT's
// transition, rather than a fact the server states. Its length (two seconds) is the plan's choice
// and is not taken from Wow.exe; the live check 14.05 judges it.
//
// Allocation-free: one instance lives for the session and is asked once a frame.

/** Milliseconds for a full turn between the living light and the death light. */
export const GHOST_LIGHT_FADE_MS = 2000;

export class GhostLightFade {
  #settled = false;
  #target = 0;
  /** The weight at `#since`, from which it walks towards `#target` at a constant rate. */
  #from = 0;
  #since = 0;
  /** 05.10-A7b-5 review: when the world light was last asked for, to notice a gap in drawing. */
  #askedAt = 0;

  /**
   * The death light's weight, 0 (alive) to 1 (ghost), for this frame.
   *
   * The first answer is settled rather than faded: a character that logs in or loads in as a ghost
   * was never seen alive. A reversal half way walks back from where it stands, at the same rate, so
   * a release-then-resurrect inside two seconds never jumps.
   */
  weight(ghost: boolean, now: number): number {
    const target = ghost ? 1 : 0;
    // 05.10-A7b-5 review: a gap of a whole fade in which nobody asked (a relog through the
    // character screen, a hidden tab) settles again. Any turn begun before it would have finished
    // in the meantime, and one that began during it was never seen — so a character that logs out
    // alive and back in as a ghost does not fade in from a life it never showed.
    const gap = now - this.#askedAt;
    this.#askedAt = now;
    if (!this.#settled || gap > GHOST_LIGHT_FADE_MS) {
      this.#settled = true;
      this.#target = target;
      this.#from = target;
      this.#since = now;
      return target;
    }
    if (target !== this.#target) {
      this.#from = this.#current(now);
      this.#target = target;
      this.#since = now;
    }
    return this.#current(now);
  }

  /** Forgets the state, so the next answer is settled again (a new world, a reconnect). */
  reset(): void {
    this.#settled = false;
  }

  #current(now: number): number {
    const step = Math.max(0, now - this.#since) / GHOST_LIGHT_FADE_MS;
    return this.#target > this.#from
      ? Math.min(this.#target, this.#from + step)
      : Math.max(this.#target, this.#from - step);
  }
}
