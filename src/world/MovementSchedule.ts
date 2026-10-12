/**
 * 5.04: when another unit's relayed movement packet takes effect — Wow.exe 3.3.5a 12340's own schedule, per unit.
 * Ghidra read-only: 0x006EB730 (`.runtime/re-2026-10-02/a4-67-review/r2.c`), 0x006E97D0
 * (`.runtime/re-2026-10-11/glue-1110/s533-1.txt`), 0x006EC950 / 0x006EC090 / 0x006EA6A0 (`s504-1.txt`), 0x006EF860
 * (`s504-3.txt`).
 *
 * The core stamps every relayed `MSG_MOVE_*` with the server's time of the move (MovementHandler.cpp:362-372). Wow.exe
 * keeps, on each mover, the local moment its last packet was applied (+0xc0) and that packet's stamp (+0xc4), set from
 * its first packet, and applies the next one at
 *
 *     A = last A + (stamp − last stamp),                       held to arrival − 500 … arrival + 1000 ms;
 *
 * the sender's own spacing, not the network's. 0x006E97D0 keeps a window on the network: each packet adds
 * `smoothed − (stamp − last stamp) + (arrival − last A)` — how late it came against that schedule, on top of the
 * smoothing already taken — to a ring of the last 32 (int16, mover+0xe8, cursor +0x128), and the smoothing is the
 * largest of them. Only while the unit stands still (no move, turn, pitch, fall, rise or sink bit, `& 0xc010ff`) and
 * nothing of it is waiting does the schedule take up the smoothing's change (+0x12c, `A += new − old`, and never
 * before the last A) — so a unit's packets end up applied the worst recent delay after they were sent, and the
 * schedule only moves while it stands, where a shift cannot be seen.
 *
 * A packet whose A is still ahead is held (0x006EC950 into the mover's queue at +0x140, in order of A, 0x006EC090) and
 * applied by the frame that reaches it (0x006EF860, which drains every entry whose A has come); one whose A has passed
 * is applied at once and run on from A to now (0x006EA550). A unit on a server spline (+0xbc) takes its packets as
 * they come. Not ported: 0x006EA6A0's glide toward the first held packet (position, facing and pitch, over the time
 * left until it); here the unit runs on what its last applied packet declared until the held one is due.
 */

/** 0x006EB730: application − arrival is held in −500 … +1000 ms. */
export const MOVE_SCHEDULE_LATE_MS = 500;
export const MOVE_SCHEDULE_EARLY_MS = 1000;
/** 0x006E97D0: how many deliveries the smoothing remembers. */
export const MOVE_SMOOTHING_SAMPLES = 32;
/** 0x006EB730 `& 0xc010ff`: the bits that make a unit not «standing» — the moves, turns and pitch keys, falling, rising, sinking. */
export const MOVE_SCHEDULE_UNSETTLED = 0x00c0_10ff;

function window(offset: number): number {
  return offset < -MOVE_SCHEDULE_LATE_MS ? -MOVE_SCHEDULE_LATE_MS
    : offset > MOVE_SCHEDULE_EARLY_MS ? MOVE_SCHEDULE_EARLY_MS : offset;
}

/** One mover's schedule (0x006EB730's +0xc0, +0xc4, +0x12c and 0x006E97D0's ring). Allocation-free after construction. */
export class MoverClock {
  #started = false;
  /** +0xc0: the local moment (ms) the last packet was applied at. */
  #applied = 0;
  /** +0xc4: that packet's stamp (ms, the server's clock). */
  #stamp = 0;
  /** +0x12c: the smoothing the schedule has taken up. */
  #smoothed = 0;
  /** int16 there (the samples are clamped to its range here); milliseconds are fractional on this clock. */
  readonly #ring = new Float64Array(MOVE_SMOOTHING_SAMPLES);
  #cursor = 0;

  /** The smoothing 0x006E97D0 would answer now (the largest delay in the window), for tests and diagnostics. */
  get smoothing(): number {
    let largest = -32_768;
    for (let index = 0; index < MOVE_SMOOTHING_SAMPLES; index++) if (this.#ring[index]! > largest) largest = this.#ring[index]!;
    return largest;
  }

  /**
   * The local moment (ms) a packet stamped `stamp` (server ms) that arrived at `arrival` (local ms) is applied at;
   * `settled`: the unit stands (no `MOVE_SCHEDULE_UNSETTLED` bit as last applied) and has nothing held.
   */
  schedule(stamp: number, arrival: number, settled: boolean, onSpline = false): number {
    const now = arrival;
    if (!this.#started) {
      this.#started = true;
      this.#applied = now;
      this.#stamp = stamp;
    }
    let sent = stamp - this.#stamp;
    if (sent < 1) sent = 0;
    else this.#stamp = stamp;
    const local = now - this.#applied;
    let offset = sent - local;
    const smoothed = this.#smooth(sent, local);
    // A unit on a server spline (0x006EB730's param_6, mover+0xbc): the schedule runs on, unheld and unclamped,
    // and the packet is taken as it comes.
    if (onSpline) {
      this.#applied = now + offset;
      return arrival;
    }
    if (settled) {
      offset = window(offset + smoothed - this.#smoothed);
      // Never before the packet applied last.
      if (offset - this.#applied + now < 0) offset = this.#applied - now;
      this.#smoothed = smoothed;
    }
    offset = window(offset);
    this.#applied = now + offset;
    return this.#applied;
  }

  /** 0x006E97D0: the delivery's sample into the ring, and the ring's largest. */
  #smooth(sent: number, local: number): number {
    let sample = this.#smoothed - sent + local;
    if (sample < -32_768) sample = -32_768;
    else if (sample > 32_767) sample = 32_767;
    this.#ring[this.#cursor] = sample;
    this.#cursor = (this.#cursor + 1) & (MOVE_SMOOTHING_SAMPLES - 1);
    let largest = sample;
    for (let index = 0; index < MOVE_SMOOTHING_SAMPLES; index++) if (this.#ring[index]! > largest) largest = this.#ring[index]!;
    return largest;
  }
}

/** One mover's clock without a field on its object (the unit is the key). */
const CLOCKS = new WeakMap<object, MoverClock>();

export function moverClock(owner: object): MoverClock {
  let clock = CLOCKS.get(owner);
  if (clock === undefined) {
    clock = new MoverClock();
    CLOCKS.set(owner, clock);
  }
  return clock;
}

/** A packet held until its moment (0x006EC950's queue entry). */
export interface HeldMove<Movement> {
  readonly movement: Movement;
  readonly at: number;
  /** Speed changes that arrived behind it (a relayed speed packet carries its own movement), applied with it. */
  speeds: Array<{ name: string; value: number }> | undefined;
}

/** 0x006EC090: into the queue before the first entry due later than it (equal moments keep their order). */
export function holdMove<Movement>(queue: Array<HeldMove<Movement>>, entry: HeldMove<Movement>): void {
  let index = queue.length;
  while (index > 0 && queue[index - 1]!.at > entry.at) index--;
  queue.splice(index, 0, entry);
}
