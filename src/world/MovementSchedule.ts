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
 * they come. While a packet is held the unit glides toward it ({@link MoveGlide}, 0x006EA6A0 / 0x006EA7E0).
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

/*
 * The glide toward the first held packet — Wow.exe 0x006EA6A0 (set up) and 0x006EA7E0 (each step), read-only Ghidra
 * `.runtime/re-2026-10-11/glue-1110/s504-1.txt` (0x006EA6A0), `.runtime/re-2026-11-04/unit-sweep.txt` (0x006EA7E0's
 * listing), `.runtime/re-2026-11-11/moves/m2.c`, `m3.c` (0x004C5090, 0x004C50C0, 0x004829A0, 0x006E9F50, 0x006E9E20).
 *
 * Set up when a packet is held into an empty queue (0x006EC950) and after every held packet is applied (0x006EF860),
 * toward whatever then heads the queue: the mover's glide bits (+0x48 & 0x1c00) and length (+0x130) are cleared, and
 * when the head carries a movement (+0x50), is not a teleport ack (kind 0x2c), rides the same transport as the mover
 * and is due at another moment than now:
 * * 0x400 (position) if the mover's flags as last applied move it (`& 0xc0100f`: the four direction bits, falling,
 *   ascending, descending);
 * * 0x800 (facing) if its facing and the head's differ by 2^-20 rad or more (0x006E9320, threshold 0x009F1224);
 * * 0x1000 (pitch) if it swims or flies (`& 0x2200000`) and the pitches differ likewise;
 * * the offsets head − mover (+0xd4, position), wrapped to (−π, π] (0x004C50C0: +0xe0 facing, +0xe4 pitch), and the
 *   length: the head's moment − now (+0x130).
 *
 * Each step of the movement engine (0x006EAC40 → 0x006EA7E0, only while the unit moves) at the step's start t0, with
 * `f` = (head's moment − t0) / length and `g` = 1 − f (no head, or t0 past it: the bits are cleared):
 * * position: the line point `head − offset·f`, blended `point·g + engine·f` with where the engine puts the unit this
 *   step (its packet base plus the closed-form travel, +0x4c + 0x00987D00, run on by 0x006E9E20) — unless that moves it
 *   horizontally more than 60 yards a second (step ms × 0.001 × 60, 0x009E1134 × 0x009EC218, compared squared with
 *   2^-20 added) from where it stands, which ends the position glide for good (the engine's point is kept);
 * * facing: target `head − offset·f` in [0, 2π) (0x004C5090), and the unit turns `g` of the short way to it from its
 *   facing; the pitch alike.
 * So the picture leaves the extrapolation gradually and reaches the held packet's place as its moment comes.
 */

/** 0x006EA6A0's bits in the mover's +0x48: position, facing, pitch. */
export const GLIDE_POSITION = 0x400;
export const GLIDE_FACING = 0x800;
export const GLIDE_PITCH = 0x1000;
const GLIDE_ANY = GLIDE_POSITION | GLIDE_FACING | GLIDE_PITCH;
/** 0x006EA6A0: the flags of a mover whose position glides — directions, falling, ascending, descending. */
export const GLIDE_MOVING = 0x00c0_100f;
/** 0x006EA6A0: swimming (0x200000) or flying (0x2000000) — the pitch glides too. */
export const GLIDE_PITCHED = 0x0220_0000;
/** 0x006EA7E0: the farthest a glide may move a unit horizontally, yards a second (0.001 × 60). */
export const GLIDE_MAX_SPEED = 60;
/** 0x009F1224: 2^-20, the angle threshold of 0x006E9320 and the slack of 0x006EA7E0's speed test. */
export const GLIDE_EPSILON = 2 ** -20;

const TWO_PI = Math.PI * 2;

/** 0x004C5090: an angle in [0, 2π). */
function positiveAngle(angle: number): number {
  const value = angle % TWO_PI;
  return value < 0 ? value + TWO_PI : value;
}

/** 0x004C50C0: an angle in [−π, π]. */
function signedAngle(angle: number): number {
  const value = angle % TWO_PI;
  return value < -Math.PI ? value + TWO_PI : value > Math.PI ? value - TWO_PI : value;
}

/** A unit's place for the glide: position, facing, pitch. */
export interface GlidePose {
  x: number;
  y: number;
  z: number;
  orientation: number;
  pitch: number;
}

/** One mover's glide (0x006EA6A0's +0x48 bits, +0xd4…+0xe4 and +0x130). Allocation-free after construction. */
export class MoveGlide {
  /** GLIDE_* bits still running. */
  bits = 0;
  #at = 0;
  #length = 0;
  #x = 0;
  #y = 0;
  #z = 0;
  #orientation = 0;
  #pitch = 0;
  #dx = 0;
  #dy = 0;
  #dz = 0;
  #dOrientation = 0;
  #dPitch = 0;

  /** No glide (0x006EA6A0 with nothing to glide to). */
  clear(): void {
    this.bits = 0;
    this.#length = 0;
  }

  /**
   * 0x006EA6A0 at `now`: the mover at `from` with flags `flags` as last applied, toward `head`, due at `at`; the
   * caller has checked the head is a movement on the mover's transport. Returns the bits that run.
   */
  setup(now: number, from: Readonly<GlidePose>, flags: number, head: Readonly<GlidePose>, at: number): number {
    this.clear();
    const length = at - now;
    if (length === 0 || !Number.isFinite(length)) return 0;
    let bits = 0;
    if ((flags & GLIDE_MOVING) !== 0) bits |= GLIDE_POSITION;
    if (Math.abs(from.orientation - head.orientation) >= GLIDE_EPSILON) bits |= GLIDE_FACING;
    if ((flags & GLIDE_PITCHED) !== 0 && Math.abs(from.pitch - head.pitch) >= GLIDE_EPSILON) bits |= GLIDE_PITCH;
    this.#x = head.x;
    this.#y = head.y;
    this.#z = head.z;
    this.#orientation = head.orientation;
    this.#pitch = head.pitch;
    this.#dx = head.x - from.x;
    this.#dy = head.y - from.y;
    this.#dz = head.z - from.z;
    this.#dOrientation = signedAngle(head.orientation - from.orientation);
    this.#dPitch = signedAngle(head.pitch - from.pitch);
    this.#at = at;
    this.#length = length;
    this.bits = bits;
    return bits;
  }

  /**
   * 0x006EA7E0, one engine step starting at `t0` and lasting `stepMs`: `pose` comes in as the engine's place for the
   * step's end (its facing and pitch: what the unit has) and leaves glided; `standing` is where the unit stood before
   * the step (the speed test). Returns whether the position glided.
   */
  step(t0: number, stepMs: number, standing: { readonly x: number; readonly y: number }, pose: GlidePose): boolean {
    if ((this.bits & GLIDE_ANY) === 0) return false;
    const left = this.#at - t0;
    if (left < 0) {
      this.bits = 0;
      return false;
    }
    const f = left / this.#length;
    const g = 1 - f;
    if ((this.bits & GLIDE_POSITION) !== 0) {
      const x = (this.#x - this.#dx * f) * g + pose.x * f;
      const y = (this.#y - this.#dy * f) * g + pose.y * f;
      const z = (this.#z - this.#dz * f) * g + pose.z * f;
      const moveX = x - standing.x;
      const moveY = y - standing.y;
      const reach = stepMs * (GLIDE_MAX_SPEED / 1000);
      if (moveX * moveX + moveY * moveY + GLIDE_EPSILON <= reach * reach) {
        pose.x = x;
        pose.y = y;
        pose.z = z;
      } else {
        this.bits &= ~GLIDE_POSITION;
      }
    }
    if ((this.bits & GLIDE_FACING) !== 0) {
      const target = positiveAngle(this.#orientation - this.#dOrientation * f);
      pose.orientation = positiveAngle(pose.orientation + signedAngle(target - pose.orientation) * g);
    }
    if ((this.bits & GLIDE_PITCH) !== 0) {
      const target = positiveAngle(this.#pitch - this.#dPitch * f);
      pose.pitch = positiveAngle(pose.pitch + signedAngle(target - pose.pitch) * g);
    }
    return (this.bits & GLIDE_POSITION) !== 0;
  }
}

/** One mover's glide without a field on its object (the unit is the key). */
const GLIDES = new WeakMap<object, MoveGlide>();

export function moverGlide(owner: object): MoveGlide {
  let glide = GLIDES.get(owner);
  if (glide === undefined) {
    glide = new MoveGlide();
    GLIDES.set(owner, glide);
  }
  return glide;
}

/** The glide of a mover that has one, without creating it. */
export function existingMoverGlide(owner: object): MoveGlide | undefined {
  return GLIDES.get(owner);
}
