import { MOVEMENT_FLAGS } from "./MovementProtocol.js";
import type { MovementInfo } from "./MovementProtocol.js";
import { fallDistance } from "./SplineModel.js";
import type { SplineSpeedName } from "./SplineStateProtocol.js";

/**
 * Where somebody else is between two of their movement packets (5.04, docs/implementation/
 * line-A4.ru.md М-A4-2).
 *
 * A player's client reports a change of movement the moment it happens and a heartbeat every half
 * second while it lasts; the core relays each one straight on. Between them the unit is carrying
 * on with what its last packet declared — running, strafing, turning, swimming up a slope, falling
 * along a jump — so that is what is drawn: the packet's position plus the motion its flags state,
 * for at most `EXTRAPOLATION_HORIZON_MS`, so a lost STOP cannot carry anybody through a wall. Wow.exe
 * routes every relayed `MSG_MOVE_*` through one handler (0x00740D30) into the same movement engine
 * that moves the player's own character (0x006F0CF0 → 0x00988A20 for START_FORWARD), and the knock
 * back relay hands its four numbers to it too (0x007187F0 → 0x006F0E30): a remote unit is simulated,
 * not tweened.
 *
 * The packet that corrects the guess does not jump the picture: the difference between where the
 * unit was drawn and where the packet puts it is carried as an error that fades out over
 * `CORRECTION_MS`, so what is seen is continuous while what is true is `packet + v·t`.
 *
 * Everything here runs per frame for every visible moving player, so nothing allocates: `Drift` is
 * one record per unit, refilled by each packet, and `advanceDrift` writes into a caller's sample.
 */

/** How long a declared motion is trusted without a new packet: four missed heartbeats. */
export const EXTRAPOLATION_HORIZON_MS = 2000;
/** How long the gap between the drawn and the reported position takes to close. */
export const CORRECTION_MS = 180;
/** Further than this from where it was drawn, a unit is put at its packet at once. */
export const CORRECTION_SNAP_DISTANCE = 25;
/**
 * A unit whose packet put it this close to the terrain is walking on it, and follows the slope
 * between packets; further above it is on a bridge, a roof or a ledge, and below it is in a cave or
 * under a city (Undercity is under Lordaeron's ground), where the terrain says nothing.
 */
const ON_TERRAIN_TOLERANCE = 1.5;

/** `baseMoveSpeed` (Unit.cpp:99-110): the rates of a unit nothing has hasted or slowed. */
export const DEFAULT_SPEEDS: Readonly<Record<SplineSpeedName, number>> = {
  walk: 2.5, run: 7, runBack: 4.5, swim: 4.722222, swimBack: 2.5,
  turnRate: 3.141594, flight: 7, flightBack: 4.5, pitchRate: 3.14,
};

export interface SpeedLookup {
  get(name: SplineSpeedName): number | undefined;
}

/** Height of the ground at a point, or undefined where nothing is known (tile not loaded). */
export type GroundProbe = (x: number, y: number) => number | undefined;

/** One unit's last packet and the motion it declared. Refilled in place by every packet. */
export interface Drift {
  /** The packet's position and the moment it arrived. */
  x: number;
  y: number;
  z: number;
  orientation: number;
  at: number;
  /** Ground speed along `orientation + heading`, yards a second. */
  speed: number;
  /** Direction of travel relative to the facing: 0 forward, π back, ±π/2 strafing. */
  heading: number;
  /** Climb rate of a swimmer or flyer, yards a second, up positive. */
  climb: number;
  /** Radians a second, left positive. */
  turn: number;
  /** A fall: the jump block's ground velocity (world frame) and the fall clock at the packet. */
  ballistic: boolean;
  jumpX: number;
  jumpY: number;
  /** Yards a second downwards at the start of the fall (the wire's sign: negative is up). */
  fallStartVelocity: number;
  fallSeconds: number;
  safeFall: boolean;
  /** Drawn minus reported at the packet, fading over `CORRECTION_MS`. */
  errorX: number;
  errorY: number;
  errorZ: number;
  errorOrientation: number;
  /** Packet height above the terrain under it when it is walking on it, else NaN. */
  groundOffset: number;
  /** Whether the terrain is a floor this unit cannot be drawn under (it was above it). */
  aboveGround: boolean;
  /**
   * L8 5.04: a swimmer's or flier's pitch keys (PITCH_UP 0x40 / PITCH_DOWN 0x80) turn its pitch at `pitchRate`
   * between packets, and its forward travel follows the pitch: the forward and strafe parts before the pitch
   * splits the first (yards a second), the rise/sink keys' own climb, the packet's pitch and its rate of change
   * (radians a second, up positive; 0 without the keys), and the moment that pitch stood (NaN: `at`).
   */
  along: number;
  across: number;
  rise: number;
  pitch: number;
  pitchTurn: number;
  pitchAt: number;
  /** L8 5.04: when the correction began fading — the packet's arrival — once `at` is its sender's moment. */
  fadeAt: number;
}

export interface DriftSample {
  x: number;
  y: number;
  z: number;
  orientation: number;
}

export function emptyDrift(): Drift {
  return {
    x: 0, y: 0, z: 0, orientation: 0, at: 0, speed: 0, heading: 0, climb: 0, turn: 0,
    ballistic: false, jumpX: 0, jumpY: 0, fallStartVelocity: 0, fallSeconds: 0, safeFall: false,
    errorX: 0, errorY: 0, errorZ: 0, errorOrientation: 0, groundOffset: Number.NaN, aboveGround: false,
    along: 0, across: 0, rise: 0, pitch: 0, pitchTurn: 0, pitchAt: Number.NaN, fadeAt: 0, // L8 5.04
  };
}

const F = MOVEMENT_FLAGS;
/** L8 5.04: a pitching drift's travel, refilled per sample. */
const PITCH_TRAVEL: DriftSample = { x: 0, y: 0, z: 0, orientation: 0 };

function rate(speeds: SpeedLookup | undefined, name: SplineSpeedName): number {
  const value = speeds?.get(name);
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : DEFAULT_SPEEDS[name];
}

/**
 * The speed a movement word moves at, in the core's own order (`Movement::SelectSpeedType`,
 * MoveSplineInit.cpp:30-55): flying, then swimming, then walking, then backwards, else running.
 * Walking backwards is therefore walk speed, not run-back speed.
 */
export function travelSpeed(flags: number, speeds: SpeedLookup | undefined): number {
  const backward = (flags & F.backward) !== 0;
  if (flags & F.flying) return rate(speeds, backward ? "flightBack" : "flight");
  if (flags & F.swimming) return rate(speeds, backward ? "swimBack" : "swim");
  if (flags & F.walking) return rate(speeds, "walk");
  return rate(speeds, backward ? "runBack" : "run");
}

/**
 * Fills `drift` with the motion a movement packet declares. Leaves the base position, the clock and
 * the error to the caller. Returns whether the unit is going anywhere at all — false for a STOP, a
 * root, a passenger (the transport carries it) or a unit standing still.
 */
export function kinematicsFor(info: {
  flags: number; pitch?: number | undefined; fallTime?: number | undefined; jump?: MovementInfo["jump"] | undefined;
},
  speeds: SpeedLookup | undefined, drift: Drift): boolean {
  const flags = info.flags;
  drift.speed = 0;
  drift.heading = 0;
  drift.climb = 0;
  drift.turn = 0;
  drift.ballistic = false;
  drift.jumpX = 0;
  drift.jumpY = 0;
  drift.fallStartVelocity = 0;
  drift.fallSeconds = 0;
  drift.safeFall = false;
  // L8 5.04: the pitch keys' part, refilled by every packet.
  drift.along = 0;
  drift.across = 0;
  drift.rise = 0;
  drift.pitch = 0;
  drift.pitchTurn = 0;
  drift.pitchAt = Number.NaN;
  // A passenger's position is its transport's business; a rooted unit is going nowhere whatever
  // else the word still says (the core never sets the two together, Unit.cpp:12299).
  if (flags & (F.onTransport | F.root)) return false;
  // A heartbeat built from a server-moved unit's own movement info (`Unit::BuildHeartBeatMsg`)
  // keeps its spline's FORWARD|SPLINE_ENABLED: that unit is on a path, not running straight on.
  if (flags & F.splineEnabled) return false;
  const turnRate = rate(speeds, "turnRate");
  if (flags & F.turnLeft) drift.turn += turnRate;
  if (flags & F.turnRight) drift.turn -= turnRate;

  const forward = ((flags & F.forward) !== 0 ? 1 : 0) - ((flags & F.backward) !== 0 ? 1 : 0);
  const side = ((flags & F.strafeLeft) !== 0 ? 1 : 0) - ((flags & F.strafeRight) !== 0 ? 1 : 0);
  const flying = (flags & F.flying) !== 0;
  if ((flags & F.falling) !== 0 && !flying && info.jump) {
    // A fall is the jump block's and nothing else's: the keys do not steer it. The ground velocity
    // is in the world frame (`Unit::KnockbackFrom` and a jump both write the direction of travel),
    // the vertical one is the wire's, negative up (`Unit.cpp:13237` writes `-speedZ`).
    drift.ballistic = true;
    drift.jumpX = info.jump.cosAngle * info.jump.speed;
    drift.jumpY = info.jump.sinAngle * info.jump.speed;
    drift.fallStartVelocity = info.jump.velocity;
    drift.fallSeconds = Math.max(0, info.fallTime ?? 0) / 1000;
    drift.safeFall = (flags & F.fallingSlow) !== 0;
    return true;
  }
  if (forward !== 0 || side !== 0) {
    const speed = travelSpeed(flags, speeds);
    // Diagonal travel is at the speed, not √2 of it.
    const length = Math.hypot(forward, side);
    let along = (forward / length) * speed;
    const across = (side / length) * speed;
    const pitch = info.pitch ?? 0;
    drift.along = along; // L8 5.04
    drift.across = across; // L8 5.04
    drift.pitch = pitch; // L8 5.04
    if ((flags & (F.swimming | F.flying)) !== 0 && pitch !== 0) {
      // Pitch tilts only the forward part: a strafe stays level.
      drift.climb = along * Math.sin(pitch);
      along *= Math.cos(pitch);
    }
    drift.speed = Math.hypot(along, across);
    drift.heading = Math.atan2(across, along);
  }
  if ((flags & (F.swimming | F.flying)) !== 0) {
    const vertical = rate(speeds, flying ? "flight" : "swim");
    if (flags & F.ascending) drift.climb += vertical;
    if (flags & F.descending) drift.climb -= vertical;
    // L8 5.04: the rise/sink part on its own, and the pitch keys (Wow.exe runs a relayed packet through the
    // engine that moves the character, 0x00740D30 → 0x00988A20, and pitch keys there turn the pitch at
    // pitchRate — Movement.updateCharacterPitch here; both keys cancel, as ReadMovementInfo has it).
    if (flags & F.ascending) drift.rise += vertical;
    if (flags & F.descending) drift.rise -= vertical;
    const pitchKeys = flags & (F.pitchUp | F.pitchDown);
    if (pitchKeys === F.pitchUp) drift.pitchTurn = rate(speeds, "pitchRate");
    else if (pitchKeys === F.pitchDown) drift.pitchTurn = -rate(speeds, "pitchRate");
  }
  return drift.speed !== 0 || drift.climb !== 0 || drift.turn !== 0;
}

/**
 * L8 5.04: how far the pitch keys may turn a remote swimmer's or flier's pitch: ±π/2, the band Wow.exe holds a
 * unit's pitch to where it is read (0x009f1ff4/0x009e8d88: a spline's pitch in 0x0098ca00, a unit without a
 * Vehicle row in 0x005fb3a0). Where the engine clamps a pitch turned by keys was not read.
 */
export const REMOTE_PITCH_LIMIT = Math.PI / 2;
/** L8 5.04: Simpson intervals over a pitching drift's elapsed time (only such a drift integrates). */
const PITCH_STEPS = 8;

/** L8 5.04: the pitch a drift has `seconds` after `at`, clamped to {@link REMOTE_PITCH_LIMIT}. */
function driftPitchAt(drift: Drift, seconds: number): number {
  const base = drift.pitchAt === drift.pitchAt ? drift.at - drift.pitchAt : 0;
  const pitch = drift.pitch + drift.pitchTurn * (base / 1000 + seconds);
  return pitch > REMOTE_PITCH_LIMIT ? REMOTE_PITCH_LIMIT : pitch < -REMOTE_PITCH_LIMIT ? -REMOTE_PITCH_LIMIT : pitch;
}

/** L8 5.04: the pitch a drift's unit has `now` — what a tilted model would be drawn at (render lane). */
export function driftPitch(drift: Drift, now: number): number {
  return driftPitchAt(drift, Math.min(Math.max(0, now - drift.at), EXTRAPOLATION_HORIZON_MS) / 1000);
}

/**
 * L8 5.04: the travel of a pitching drift over `seconds` into `out` (x, y, z offsets): Simpson's rule, split where
 * the pitch reaches its band so neither half has the clamp's kink in it.
 */
function integratePitching(drift: Drift, seconds: number, out: DriftSample): void {
  out.x = 0;
  out.y = 0;
  out.z = 0;
  const start = driftPitchAt(drift, 0);
  const limit = drift.pitchTurn > 0 ? REMOTE_PITCH_LIMIT : -REMOTE_PITCH_LIMIT;
  const clamped = (limit - start) / drift.pitchTurn;
  if (clamped > 0 && clamped < seconds) {
    simpsonPitching(drift, 0, clamped, out);
    simpsonPitching(drift, clamped, seconds, out);
  } else {
    simpsonPitching(drift, 0, seconds, out);
  }
}

/** L8 5.04: adds the travel between `from` and `to` seconds to `out`, by Simpson's rule. */
function simpsonPitching(drift: Drift, from: number, to: number, out: DriftSample): void {
  const step = (to - from) / PITCH_STEPS;
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  for (let index = 0; index <= PITCH_STEPS; index++) {
    const t = from + index * step;
    const weight = index === 0 || index === PITCH_STEPS ? 1 : index % 2 === 1 ? 4 : 2;
    const facing = drift.orientation + drift.turn * t;
    const pitch = driftPitchAt(drift, t);
    const forward = drift.along * Math.cos(pitch);
    const cos = Math.cos(facing);
    const sin = Math.sin(facing);
    sumX += weight * (cos * forward - sin * drift.across);
    sumY += weight * (sin * forward + cos * drift.across);
    sumZ += weight * (drift.along * Math.sin(pitch) + drift.rise);
  }
  out.x += (sumX * step) / 3;
  out.y += (sumY * step) / 3;
  out.z += (sumZ * step) / 3;
}

/**
 * Where a drift puts its unit `now`, written into `out`; returns false once there is nothing left
 * to animate (the horizon has passed and the correction has faded), so the caller can drop it.
 */
export function advanceDrift(drift: Drift, now: number, out: DriftSample, ground?: GroundProbe): boolean {
  const elapsed = Math.max(0, now - drift.at);
  const seconds = Math.min(elapsed, EXTRAPOLATION_HORIZON_MS) / 1000;
  let x: number;
  let y: number;
  let z: number;
  const orientation = drift.orientation + drift.turn * seconds;
  if (drift.ballistic) {
    x = drift.x + drift.jumpX * seconds;
    y = drift.y + drift.jumpY * seconds;
    // The same curve the core puts a falling spline on (`computeFallElevation`), from the point of
    // the fall the packet was written at.
    const start = drift.fallSeconds;
    z = drift.z - (fallDistance(start + seconds, drift.safeFall, drift.fallStartVelocity)
      - fallDistance(start, drift.safeFall, drift.fallStartVelocity));
  } else if (drift.pitchTurn !== 0 && drift.along !== 0) {
    // L8 5.04: the pitch keys turn the pitch the forward travel follows; integrated, as nothing closes it.
    integratePitching(drift, seconds, PITCH_TRAVEL);
    x = drift.x + PITCH_TRAVEL.x;
    y = drift.y + PITCH_TRAVEL.y;
    z = drift.z + PITCH_TRAVEL.z;
  } else {
    const heading = drift.orientation + drift.heading;
    if (drift.turn === 0 || drift.speed === 0) {
      x = drift.x + Math.cos(heading) * drift.speed * seconds;
      y = drift.y + Math.sin(heading) * drift.speed * seconds;
    } else {
      // Running while turning is an arc, not the chord the first heading points along.
      const radius = drift.speed / drift.turn;
      const swept = heading + drift.turn * seconds;
      x = drift.x + radius * (Math.sin(swept) - Math.sin(heading));
      y = drift.y - radius * (Math.cos(swept) - Math.cos(heading));
    }
    z = drift.z + drift.climb * seconds;
  }
  if (ground !== undefined && (drift.aboveGround || drift.groundOffset === drift.groundOffset)) {
    const floor = ground(x, y);
    if (floor !== undefined) {
      // Walking on the terrain follows it; anything else above it may not sink through it.
      if (drift.groundOffset === drift.groundOffset && !drift.ballistic) z = floor + drift.groundOffset;
      else if (z < floor) z = floor;
    }
  }
  // L8 5.04: the correction fades from the packet's arrival (`fadeAt`) once `at` is its sender's moment.
  const fading = drift.fadeAt > drift.at ? Math.max(0, now - drift.fadeAt) : elapsed;
  const fade = fading >= CORRECTION_MS ? 0 : 1 - fading / CORRECTION_MS; // L8 5.04: was `elapsed`
  out.x = x + drift.errorX * fade;
  out.y = y + drift.errorY * fade;
  out.z = z + drift.errorZ * fade;
  out.orientation = orientation + drift.errorOrientation * fade;
  return elapsed < EXTRAPOLATION_HORIZON_MS || fade > 0;
}

/**
 * Settles the relation of a drift's base to the ground once per packet: walking on it (follow the
 * slope), above it (a floor), or under it (ignore it). Swimmers and flyers are never walking.
 */
export function anchorDrift(drift: Drift, flags: number, ground: GroundProbe | undefined): void {
  drift.groundOffset = Number.NaN;
  drift.aboveGround = false;
  if (!ground) return;
  const floor = ground(drift.x, drift.y);
  if (floor === undefined) return;
  const offset = drift.z - floor;
  drift.aboveGround = offset >= -ON_TERRAIN_TOLERANCE;
  const grounded = (flags & (F.swimming | F.flying | F.falling | F.disableGravity | F.hover)) === 0;
  if (grounded && Math.abs(offset) <= ON_TERRAIN_TOLERANCE) drift.groundOffset = offset;
}

/**
 * L8 5.04: the sender's moment of a relayed packet, on this client's clock.
 *
 * The core stamps every relayed `MSG_MOVE_*` with the server's time of the move — the sender's own time plus
 * its clock delta from CMSG_TIME_SYNC_RESP (MovementHandler.cpp:362-372, 939-990) — and Wow.exe applies a
 * remote packet at that moment rather than at its arrival, catching up packets that arrive late and holding
 * early ones (0x006EB730: a window of −500…+1000 ms, early packets queued by 0x006EC8B0). This client has no
 * estimate of the server's clock of its own, so it takes the fastest delivery it has seen as on time: the
 * smallest (arrival − stamp) is the clock offset plus the shortest trip, every later excess is the packet's
 * lateness. The smallest is relaxed upwards slowly ({@link PACKET_CLOCK_RELAX}), so a server or a sender
 * whose clock steps does not leave a stale best behind; a lateness over {@link PACKET_LATE_WINDOW_MS} is
 * not trusted and the packet is taken at its arrival. Early packets are not held: by construction none is.
 *
 * L8-review 5.04: two corrections from 0x006EB730 itself (.runtime/re-2026-10-02/a4-67-review/r2.c). The time
 * relation is the unit's own — mover+0xc0 (the local moment its last packet was applied) and +0xc4 (that
 * packet's stamp), set from its first packet; each next one is applied at the last plus the stamps' difference
 * — so `WorldState.move` keys the clock by the unit, not the world: a sender's steady latency is never caught
 * up, only a packet later than that sender's usual (one clock for all took the fastest sender as on time and
 * drew every slower one ahead of its packets, pulled back at each of its stops). And application − arrival is
 * clamped into −500…+1000 ms (late is the negative side): a packet later than 500 ms is caught up by 500, not
 * taken at its arrival.
 */
export const PACKET_LATE_WINDOW_MS = 500; // L8-review 5.04: was 1000
/** How fast the best delivery is forgotten: milliseconds of offset a second of arrivals. */
export const PACKET_CLOCK_RELAX = 0.002;

export class PacketClock {
  #offset = Number.NaN;
  #lastArrival = Number.NaN;

  /** How late a packet stamped `stamp` (server ms) that arrived at `arrival` (local ms) is; 0 for none. */
  lateness(stamp: number | undefined, arrival: number): number {
    if (stamp === undefined || !Number.isFinite(stamp) || !Number.isFinite(arrival)) return 0;
    const sample = arrival - stamp;
    if (this.#offset !== this.#offset) {
      this.#offset = sample;
      this.#lastArrival = arrival;
      return 0;
    }
    if (arrival > this.#lastArrival) {
      this.#offset += (arrival - this.#lastArrival) * PACKET_CLOCK_RELAX;
      this.#lastArrival = arrival;
    }
    if (sample <= this.#offset) {
      this.#offset = sample;
      return 0;
    }
    const late = sample - this.#offset;
    return late > PACKET_LATE_WINDOW_MS ? PACKET_LATE_WINDOW_MS : late; // L8-review 5.04: was `? 0 : late`
  }
}

/** One clock per owner — the unit (L8-review 5.04; was the world state) — without a field on it. */
const PACKET_CLOCKS = new WeakMap<object, PacketClock>();
/** The sample `realignDrift` measures with, refilled per packet. */
const REALIGN_SAMPLE: DriftSample = { x: 0, y: 0, z: 0, orientation: 0 };

/**
 * L8 5.04: puts a drift `WorldState.move` has just filled (base, motion, `at` = arrival, errors = drawn −
 * packet) at its sender's moment: `at` moves back by the packet's lateness, the correction starts fading at the
 * arrival (`fadeAt`) and is re-measured against where the motion has carried the unit by now, so the picture
 * stays continuous while what is true becomes `packet + v·(now − sent)`. `owner` keys the clock (the unit —
 * L8-review 5.04; was the world state). Allocates nothing once the owner's clock exists.
 */
export function realignDrift(owner: object, drift: Drift, stamp: number | undefined, now: number,
  ground?: GroundProbe): void {
  let clock = PACKET_CLOCKS.get(owner);
  if (clock === undefined) {
    clock = new PacketClock();
    PACKET_CLOCKS.set(owner, clock);
  }
  const late = clock.lateness(stamp, now);
  drift.fadeAt = now;
  drift.pitchAt = now - late;
  if (!(late > 0)) return;
  drift.at = now - late;
  const drawnX = drift.x + drift.errorX;
  const drawnY = drift.y + drift.errorY;
  const drawnZ = drift.z + drift.errorZ;
  const drawnOrientation = drift.orientation + drift.errorOrientation;
  drift.errorX = drift.errorY = drift.errorZ = drift.errorOrientation = 0;
  advanceDrift(drift, now, REALIGN_SAMPLE, ground);
  drift.errorX = drawnX - REALIGN_SAMPLE.x;
  drift.errorY = drawnY - REALIGN_SAMPLE.y;
  drift.errorZ = drawnZ - REALIGN_SAMPLE.z;
  // The short way round, as the packet's own correction is measured.
  const turn = drawnOrientation - REALIGN_SAMPLE.orientation;
  drift.errorOrientation = turn - Math.PI * 2 * Math.round(turn / (Math.PI * 2));
}
