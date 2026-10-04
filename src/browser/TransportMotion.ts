// Ships and zeppelins that sail (plan item 11.01, slice A1; M7-3).
//
// The server tells a client two things about a `GAMEOBJECT_TYPE_MO_TRANSPORT` and then falls silent:
// the create block's `UPDATEFLAG_TRANSPORT` word is its `PathProgress` — milliseconds since the
// transport was created, never reduced (Object.cpp:442-454; `PathProgress += diff`,
// Transport.cpp:133-134) — and `GAMEOBJECT_LEVEL` is its period (`SetPeriod(pathTime)`,
// Transport.cpp:95). Every values update of a game object also carries `GAMEOBJECT_DYNAMIC`
// (`_fieldNotifyFlags = UF_FLAG_DYNAMIC`, Object.cpp:85; GAMEOBJECT_DYNAMIC is UF_FLAG_DYNAMIC,
// UpdateFieldFlags.cpp:1508), whose high half is the phase as `int16(timer / period × 65535)`
// (GameObject.cpp:2866-2873). The position itself is never sent again (`Transport::UpdatePosition`
// has no network output), so this file keeps the clock and asks the gateway for the path the core
// runs it on (`gateway/TransportShipPaths.ts`, `GET /dbc/ship-paths`).
//
// The clock starts when the create block was read (`WorldObjectState.transportTimeAt`), not at the
// first frame after it, which may come much later in a hidden page.
//
// Degrades to what was there before: until the track lands — and for good against a gateway older
// than the route, which answers 404 — the ship stays where its create block put it. A track whose
// period disagrees with `GAMEOBJECT_LEVEL` is never used: a ship standing still is a smaller lie
// than one sailing on the wrong timetable.
//
// L16: a transport that can be stopped (template data8, `canBeStopped`: the gunships) is held at a
// stop while its GO state is READY, as Wow.exe's path clock holds it (`ShipMotion.#holdPhase`); the
// state of any other transport means nothing to its clock (the core keeps it READY for good).

import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";
import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { GameObjectTemplate } from "../world/GameObjectProtocol.js";
import type { WorldObjectState, WorldState } from "../world/WorldState.js";

/** gateway/TransportShipPaths.ts `SHIP_PATHS_VERSION`; tests/transport-motion.test.mjs pins the two. */
export const SHIP_PATH_ROUTE_VERSION = 1;
/** Sample flags, as the gateway writes them (`SHIP_SAMPLE_STOP`, `SHIP_SAMPLE_CUT`). */
export const SHIP_SAMPLE_STOP = 1;
export const SHIP_SAMPLE_CUT = 2;
/** `GAMEOBJECT_TYPE_MO_TRANSPORT`, byte 1 of `GAMEOBJECT_BYTES_1`. */
export const GO_TYPE_MO_TRANSPORT = 15;
/**
 * How far the baked period may be from `GAMEOBJECT_LEVEL`. The gateway reproduces the core's
 * single-precision arithmetic, so the two should be equal; a millisecond either way is rounding,
 * anything more is another path or another speed, and the ship then stays still.
 */
export const SHIP_PERIOD_TOLERANCE_MS = 2;
/**
 * A `GAMEOBJECT_DYNAMIC` phase this far outside the running clock re-anchors it. Below it the clock
 * is trusted: the word is quantised to period / 65535 and is as late as the packet.
 */
export const SHIP_CLOCK_SLACK_MS = 250;
/** A transport's dynamic word carries −1 when it has no period (GameObject.cpp:2849). */
const NO_PHASE = 0xffff;
/**
 * L16: `GO_STATE_READY`, byte 0 of `GAMEOBJECT_BYTES_1` (SharedDefines.h:1658). A transport that can
 * be stopped is READY while the core holds it at a stop and ACTIVE while it sails (Transport.cpp:98,
 * 157-179); one that cannot is READY for good, and the state means nothing to its clock.
 */
export const GO_STATE_READY = 1;
/** L16: `GO_DYNFLAG_LO_STOPPED` (SharedDefines.h:1651), the low half of `GAMEOBJECT_DYNAMIC`. */
export const GO_DYNFLAG_LO_STOPPED = 0x10;
/** L16: `moTransport.canBeStopped`, data8 of the template (GameObjectData.h:255). */
const TEMPLATE_CAN_BE_STOPPED = 8;

const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;
const LEVEL = UPDATE_FIELDS.GAMEOBJECT_LEVEL.offset;
const DYNAMIC = UPDATE_FIELDS.GAMEOBJECT_DYNAMIC.offset;
const BYTES_1 = UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset;

export interface ShipTrack {
  readonly path: number;
  readonly speed: number;
  readonly accel: number;
  readonly period: number;
  readonly step: number;
  readonly map: readonly number[];
  readonly x: readonly number[];
  readonly y: readonly number[];
  readonly z: readonly number[];
  readonly o: readonly number[];
  readonly flags: readonly number[];
}

function finiteArray(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

/**
 * Validates a route answer: the track, `null` when the gateway says the path cannot be built (an
 * answer, not a failure — asking again would get the same), or undefined for a body of another shape.
 */
export function shipTrackFrom(data: unknown, version = SHIP_PATH_ROUTE_VERSION): ShipTrack | null | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as Record<string, unknown>;
  if (value.version !== version) return undefined;
  if (typeof value.error === "string") return null;
  const { path, speed, accel, period, step } = value;
  if (typeof path !== "number" || typeof speed !== "number" || typeof accel !== "number") return undefined;
  if (typeof period !== "number" || !Number.isSafeInteger(period) || period <= 0) return undefined;
  if (typeof step !== "number" || !Number.isSafeInteger(step) || step <= 0) return undefined;
  const samples = Math.ceil(period / step);
  for (const key of ["map", "x", "y", "z", "o", "flags"]) {
    if (!finiteArray(value[key], samples)) return undefined;
  }
  return value as unknown as ShipTrack;
}

export interface ShipPoseSample {
  map: number;
  x: number;
  y: number;
  z: number;
  orientation: number;
  stop: boolean;
}

/**
 * The ship at `phaseMs` into its cycle, written into `out`: the two samples around it, linear in
 * position and along the shorter arc in facing. A sample marked as a cut is held until the next
 * sample's moment — across a jump there is nothing to interpolate. Allocates nothing.
 */
export function shipPoseAt(track: ShipTrack, phaseMs: number, out: ShipPoseSample): ShipPoseSample {
  const samples = track.x.length;
  const period = track.period;
  let phase = phaseMs % period;
  if (phase < 0) phase += period;
  if (!(phase >= 0)) phase = 0;
  let i = Math.floor(phase / track.step);
  if (i >= samples) i = samples - 1;
  out.map = track.map[i]!;
  out.stop = (track.flags[i]! & SHIP_SAMPLE_STOP) !== 0;
  const fraction = (phase - i * track.step) / track.step;
  const j = i + 1;
  if (j >= samples || (track.flags[i]! & SHIP_SAMPLE_CUT) !== 0 || fraction <= 0) {
    out.x = track.x[i]!;
    out.y = track.y[i]!;
    out.z = track.z[i]!;
    out.orientation = track.o[i]!;
    return out;
  }
  const f = Math.min(fraction, 1);
  out.x = track.x[i]! + (track.x[j]! - track.x[i]!) * f;
  out.y = track.y[i]! + (track.y[j]! - track.y[i]!) * f;
  out.z = track.z[i]! + (track.z[j]! - track.z[i]!) * f;
  const turn = Math.PI * 2;
  let delta = (track.o[j]! - track.o[i]!) % turn;
  if (delta > Math.PI) delta -= turn;
  else if (delta < -Math.PI) delta += turn;
  let orientation = (track.o[i]! + delta * f) % turn;
  if (orientation < 0) orientation += turn;
  out.orientation = orientation;
  return out;
}

/**
 * L16: where a stoppable transport asked to stop at `phaseMs` holds — the end of the wait of the stop
 * at or after it, the way Wow.exe's path clock finds it (0x007f7d30: the first stop whose arrival
 * plus wait is past the phase; 0x007f8000 keeps that as the hold point). The track knows a wait as
 * its run of `SHIP_SAMPLE_STOP` samples, so the point is the moment after the run's last one —
 * within one step after the core's `DepartureTime`, where the ship has not yet moved off the node.
 * Undefined for a path without a stop. Walks the samples: for a state change, not for a frame.
 */
export function shipHoldPhase(track: ShipTrack, phaseMs: number): number | undefined {
  const samples = track.flags.length;
  const period = track.period;
  let phase = phaseMs % period;
  if (phase < 0) phase += period;
  if (!(phase >= 0)) phase = 0;
  let first = Math.floor(phase / track.step);
  if (first >= samples) first = samples - 1;
  for (let n = 0; n < samples; n++) {
    const index = (first + n) % samples;
    if ((track.flags[index]! & SHIP_SAMPLE_STOP) === 0) continue;
    let last = index;
    // L16-review: a wait ends at a cut — the cycle's end or a teleport: the core sends ACTIVE as its timer
    // leaves the held frame, and a stop past the jump is the next frame's (Transport.cpp:174-193).
    for (let m = 1; m < samples && (track.flags[last]! & SHIP_SAMPLE_CUT) === 0
      && (track.flags[(last + 1) % samples]! & SHIP_SAMPLE_STOP) !== 0; m++) {
      last = (last + 1) % samples;
    }
    return Math.min((last + 1) * track.step, period) % period;
  }
  return undefined;
}

/** L16-review: the distance between two phases of a cycle of `period`, either way round. */
function circularDistance(a: number, b: number, period: number): number {
  let distance = Math.abs(a - b) % period;
  if (distance > period / 2) distance = period - distance;
  return distance;
}

/** Whether the gateway's timetable is the server's: `pathTime` against `GAMEOBJECT_LEVEL`. */
export function shipPeriodAgrees(trackPeriod: number, level: number): boolean {
  return level > 0 && Math.abs(trackPeriod - level) <= SHIP_PERIOD_TOLERANCE_MS;
}

/** The high half of `GAMEOBJECT_DYNAMIC`, or undefined when absent or −1. */
export function dynamicPhaseWord(dynamic: number | undefined): number | undefined {
  if (dynamic === undefined) return undefined;
  const word = (dynamic >>> 16) & 0xffff;
  return word === NO_PHASE ? undefined : word;
}

/**
 * The transport clock as this client keeps it: `progressMs` was the server's `PathProgress` at `at`
 * (the client's frame clock). Owned per create block — a new one replaces the object in the state,
 * and the clock with it.
 */
export interface ShipClock {
  /** The `WorldObjectState` this clock was anchored to; a re-CREATE is a different object. */
  readonly object: object;
  progressMs: number;
  at: number;
  /** The last dynamic phase word seen, so only a changed one counts as news. */
  dynamic: number | undefined;
  corrections: number;
}

/**
 * Anchors a clock on a create block: `PathProgress` when the block carried one, else the dynamic
 * word's phase (quantised, but a phase), else zero.
 */
export function anchorShipClock(
  object: object, transportTime: number | undefined, dynamic: number | undefined, period: number, now: number,
): ShipClock {
  const word = dynamicPhaseWord(dynamic);
  let progressMs = 0;
  if (transportTime !== undefined && Number.isFinite(transportTime)) progressMs = transportTime;
  else if (word !== undefined && period > 0) progressMs = ((word + 0.5) / 65535) * period;
  return { object, progressMs, at: now, dynamic: word, corrections: 0 };
}

/** Where in its cycle the transport is at `now`, in [0, period). */
export function shipClockPhase(clock: ShipClock, now: number, period: number): number {
  if (!(period > 0)) return 0;
  const phase = (clock.progressMs + (now - clock.at)) % period;
  return phase < 0 ? phase + period : phase;
}

/**
 * Checks the clock against a fresh `GAMEOBJECT_DYNAMIC`; true when it was re-anchored.
 *
 * The word `q` says the server's timer was in [q, q + 1) × period / 65535 when it wrote the packet.
 * A clock inside that window, or within `SHIP_CLOCK_SLACK_MS` of it, is left alone — it is the more
 * precise of the two. Further out (a transport a script stopped, a client that slept) the window's
 * middle wins.
 */
export function correctShipClock(clock: ShipClock, dynamic: number | undefined, period: number, now: number): boolean {
  const word = dynamicPhaseWord(dynamic);
  if (word === clock.dynamic) return false;
  clock.dynamic = word;
  if (word === undefined || !(period > 0)) return false;
  const lo = (word / 65535) * period;
  const hi = ((word + 1) / 65535) * period;
  const phase = shipClockPhase(clock, now, period);
  let distance = 0;
  if (phase < lo) distance = Math.min(lo - phase, phase + period - hi);
  else if (phase >= hi) distance = Math.min(phase - hi, lo + period - phase);
  if (distance <= SHIP_CLOCK_SLACK_MS) return false;
  clock.progressMs = (lo + hi) / 2;
  clock.at = now;
  clock.corrections++;
  return true;
}

// ---------------------------------------------------------------------------------------------

/** The tracks, one gateway request per (path, speed, accel), each retried on its own schedule. */
export class ShipPathClient {
  readonly origin: string;
  readonly #options: RetryingCatalogOptions;
  readonly #tracks = new Map<string, RetryingCatalogClient<ShipTrack | null>>();

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#options = options;
  }

  /** The track; `null` when the gateway cannot build it; undefined while it loads or has failed. */
  track(path: number, speed: number, accel: number): ShipTrack | null | undefined {
    const key = `${path}:${speed}:${accel}`;
    let client = this.#tracks.get(key);
    if (!client) {
      if (!(path > 0) || !(speed > 0) || !(accel > 0)) return null;
      client = new RetryingCatalogClient(
        this.origin,
        `/dbc/ship-paths?v=${SHIP_PATH_ROUTE_VERSION}&path=${path}&speed=${speed}&accel=${accel}`,
        (data) => shipTrackFrom(data),
        this.#options,
      );
      this.#tracks.set(key, client);
      void client.load();
    }
    return client.value;
  }

  state(path: number, speed: number, accel: number): CatalogState | undefined {
    return this.#tracks.get(`${path}:${speed}:${accel}`)?.state;
  }

  /**
   * A world mount revives every request that gave up (a gateway restarted in between) and every one
   * the last world leave cut short: `stop()` puts a request still loading — an answer on the way, a
   * retry scheduled — back to `idle`, and `track()` never asks again for a key it already holds.
   * `retry()` is a no-op for a track that is loading or loaded.
   */
  retry(): void {
    for (const client of this.#tracks.values()) void client.retry();
  }

  stop(): void {
    for (const client of this.#tracks.values()) client.stop();
  }
}

export interface ShipTrackSource {
  track(path: number, speed: number, accel: number): ShipTrack | null | undefined;
}

export interface ShipMotionOptions {
  readonly paths: ShipTrackSource;
  /** `WorldClient.gameObjectTemplate`: asks the server once per entry. */
  template(entry: number, guid: bigint): Pick<GameObjectTemplate, "type" | "data"> | undefined;
  /** The map the character is on; a ship whose timetable is elsewhere is left where it is. */
  mapId(): number | undefined;
  log?(message: string): void;
}

interface ShipEntry {
  readonly guid: bigint;
  clock: ShipClock | undefined;
  /** The one warning per create block. */
  warned: object | undefined;
  /** The track once the source has answered, kept per create block so a frame builds no key. */
  track: ShipTrack | null | undefined;
  trackFor: object | undefined;
  /** 11.01-C: since when the clock has put the ship on another map than the character's. */
  offMapSince?: number | undefined;
  /** L16: `canBeStopped` of the template, read with the track. */
  stoppable: boolean;
  /** L16: the create block the hold below belongs to; a new one starts it over. */
  holdFor: object | undefined;
  /** L16: the GO state last acted on (byte 0 of BYTES_1); −1 before the first look. */
  goState: number;
  /** L16: a stop was asked for (READY): the ship sails on to `holdPhase`. */
  holdRequested: boolean;
  /** L16: and has reached it: the phase is `holdPhase` until ACTIVE. */
  held: boolean;
  /** L16: where it holds (`shipHoldPhase`); NaN for a path without a stop. */
  holdPhase: number;
  /** L16: the frame clock of the last look, the window a crossing of the hold point is caught in. */
  lastSeen: number;
  /** L16-review: the dynamic phase word when the hold was asked for; the core's timer stands still under it. */
  holdWord: number | undefined;
}

/**
 * L16-review: how far from its hold point a released ship's word-corrected clock may be and still be
 * the departure from that stop (a server tick, the clock slack and a sample are far less); further,
 * states were missed between two frames and the word is the server's.
 */
export const SHIP_HOLD_STALE_MS = 1000;

/**
 * 11.01-C: how long the clock may disagree with the server about the map before it is logged. A
 * crossing is a moment of disagreement either way — the clock passes the teleport frame a little
 * before or after the core does — and is not news; a ship stuck on a wrong timetable is.
 */
export const SHIP_OFF_MAP_WARN_MS = 2000;

const POSE: ShipPoseSample = { map: 0, x: 0, y: 0, z: 0, orientation: 0, stop: false };

/** Every MO transport in view, moved to this frame's pose: `WorldState.poseProvider`. */
export class ShipMotion {
  readonly #options: ShipMotionOptions;
  readonly #ships = new Map<bigint, ShipEntry>();
  #revision = -1;

  constructor(options: ShipMotionOptions) {
    this.#options = options;
  }

  get ships(): number {
    return this.#ships.size;
  }

  clock(guid: bigint): ShipClock | undefined {
    return this.#ships.get(guid)?.clock;
  }

  update(state: Pick<WorldState, "objects" | "revision">, now: number): void {
    if (state.revision !== this.#revision) {
      this.#revision = state.revision;
      this.#rescan(state.objects);
    }
    for (const ship of this.#ships.values()) {
      const object = state.objects.get(ship.guid);
      if (object) this.#move(ship, object, now);
    }
  }

  #rescan(objects: ReadonlyMap<bigint, WorldObjectState>): void {
    for (const guid of this.#ships.keys()) if (!objects.has(guid)) this.#ships.delete(guid);
    for (const object of objects.values()) {
      if (object.typeId !== 5 || ((object.fields.get(BYTES_1) ?? 0) >>> 8 & 0xff) !== GO_TYPE_MO_TRANSPORT) continue;
      if (!this.#ships.has(object.guid)) this.#ships.set(object.guid, {
        guid: object.guid, clock: undefined, warned: undefined, track: undefined, trackFor: undefined, offMapSince: undefined,
        // L16: the hold of a stoppable transport.
        stoppable: false, holdFor: undefined, goState: -1, holdRequested: false, held: false, holdPhase: Number.NaN, lastSeen: 0,
        holdWord: undefined, // L16-review
      });
    }
  }

  #move(ship: ShipEntry, object: WorldObjectState, now: number): void {
    const position = object.position;
    const level = object.fields.get(LEVEL) ?? 0;
    if (!position || !(level > 0)) return;
    const dynamic = object.fields.get(DYNAMIC);
    // The clock first and always, so it starts at the frame the create block landed in rather than
    // whenever the template and the track arrive.
    // Anchored at the moment the create block was read, not at this frame: a page hidden through a
    // loading screen gets no frames, and the ship would otherwise run late by the whole wait.
    if (ship.clock?.object !== object) {
      const at = object.transportTime !== undefined && object.transportTimeAt !== undefined ? object.transportTimeAt : now;
      ship.clock = anchorShipClock(object, object.transportTime, dynamic, level, at);
    }
    else correctShipClock(ship.clock, dynamic, level, now);

    const entry = object.fields.get(ENTRY) ?? 0;
    if (ship.trackFor !== object) {
      ship.track = undefined;
      const template = this.#options.template(entry, object.guid);
      if (!template || template.type !== GO_TYPE_MO_TRANSPORT) return;
      // L16: Wow.exe's state handler 0x007101c0 acts only when data8 is set.
      ship.stoppable = (template.data[TEMPLATE_CAN_BE_STOPPED] ?? 0) !== 0;
      // `moTransport`: taxiPathId, moveSpeed, accelRate (GameObjectData.h).
      ship.track = this.#options.paths.track(template.data[0] ?? 0, template.data[1] ?? 0, template.data[2] ?? 0);
      if (ship.track === undefined) return;
      ship.trackFor = object;
    }
    const track = ship.track;
    if (track === undefined) return;
    if (track === null) {
      this.#warn(ship, object, `transport ${entry}: the gateway cannot build its path; it stays where it was created`);
      return;
    }
    if (!shipPeriodAgrees(track.period, level)) {
      this.#warn(ship, object, `transport ${entry}: path ${track.path} at ${track.speed}/${track.accel} lasts `
        + `${track.period} ms, the server says ${level} ms; it stays where it was created`);
      return;
    }
    // L16: a stoppable transport's phase goes through its hold; any other's is the clock's, as before.
    shipPoseAt(track, ship.stoppable ? this.#holdPhase(ship, object, track, level, dynamic, now)
      : shipClockPhase(ship.clock, now, level), POSE);
    const map = this.#options.mapId();
    if (map !== undefined && POSE.map !== map) {
      // 11.01-C: the server only shows a client the transports of its own map, so the clock is wrong.
      ship.offMapSince ??= now;
      if (now - ship.offMapSince >= SHIP_OFF_MAP_WARN_MS) {
        this.#warn(ship, object, `transport ${entry}: its clock puts it on map ${POSE.map}, the server on map ${map}; `
          + "it stays where it is");
      }
      return;
    }
    ship.offMapSince = undefined;
    position.x = POSE.x;
    position.y = POSE.y;
    position.z = POSE.z;
    position.orientation = POSE.orientation;
  }

  /**
   * L16: the phase of a stoppable transport this frame (Wow.exe's path clock, notes
   * .runtime/re-2026-10-04/l16-transport/). READY asks for a hold: the ship sails on to the end of the
   * wait of the stop at or after its phase (0x007f8000 → 0x007f7d30) and holds there once its clock
   * crosses that point within a frame (0x007f7840 / 0x007f77d0); ACTIVE lets it go from the hold point
   * at that moment (0x007f78c0), or cancels a hold not yet reached. Each create block starts over
   * (0x007100d0), and one whose GAMEOBJECT_DYNAMIC carries GO_DYNFLAG_LO_STOPPED holds at once at the
   * stop around its phase (0x007f80a0) — the core never sends that flag for a transport. The clock
   * underneath runs on through a hold; allocates nothing.
   */
  #holdPhase(ship: ShipEntry, object: WorldObjectState, track: ShipTrack, level: number, dynamic: number | undefined,
    now: number): number {
    const clock = ship.clock!;
    if (ship.holdFor !== object) {
      ship.holdFor = object;
      ship.goState = -1;
      ship.holdRequested = false;
      ship.held = false;
      ship.holdPhase = Number.NaN;
      ship.lastSeen = now;
      if (((dynamic ?? 0) & GO_DYNFLAG_LO_STOPPED) !== 0) {
        const hold = shipHoldPhase(track, shipClockPhase(clock, now, level) + level - 1);
        if (hold !== undefined) {
          ship.holdPhase = hold;
          ship.holdRequested = true;
          ship.held = true;
          // The state the block came with is where this hold starts; its later changes act.
          ship.goState = (object.fields.get(BYTES_1) ?? 0) & 0xff;
          ship.holdWord = dynamicPhaseWord(dynamic); // L16-review
        }
      }
    }
    const state = (object.fields.get(BYTES_1) ?? 0) & 0xff;
    // L16-review: the core's timer stands still while it holds a transport (Transport.cpp:133), so a
    // phase word that moves under a hold we keep means a departure and an arrival went by between two
    // frames (a hidden page gets none, its packets still land) — Wow.exe sees every state as it comes.
    const word = dynamicPhaseWord(dynamic);
    if (state !== ship.goState) {
      ship.goState = state;
      const stop = state === GO_STATE_READY;
      if (stop && !ship.holdRequested) {
        ship.holdPhase = shipHoldPhase(track, shipClockPhase(clock, now, level)) ?? Number.NaN;
        ship.holdRequested = true;
        ship.held = false;
        ship.lastSeen = now;
        ship.holdWord = word; // L16-review
      } else if (!stop && ship.holdRequested) {
        // L16-review: from the hold point (0x007f78c0) — unless the word just put the clock a stop or more away.
        if (ship.held && !(word !== ship.holdWord
          && circularDistance(shipClockPhase(clock, now, level), ship.holdPhase, level) > SHIP_HOLD_STALE_MS)) {
          clock.progressMs = ship.holdPhase;
          clock.at = now;
        }
        ship.holdRequested = false;
        ship.held = false;
      }
    } else if (ship.holdRequested && word !== ship.holdWord) {
      // L16-review: still READY, but at another stop by the word: the hold is asked for again from the
      // clock `correctShipClock` has just put there.
      ship.holdWord = word;
      ship.holdPhase = shipHoldPhase(track, shipClockPhase(clock, now, level)) ?? Number.NaN;
      ship.held = false;
      ship.lastSeen = now;
    }
    if (ship.holdRequested && !ship.held && ship.holdPhase === ship.holdPhase) {
      let past = (shipClockPhase(clock, now, level) - ship.holdPhase) % level;
      if (past < 0) past += level;
      if (past <= now - ship.lastSeen) ship.held = true;
    }
    ship.lastSeen = now;
    return ship.held ? ship.holdPhase : shipClockPhase(clock, now, level);
  }

  #warn(ship: ShipEntry, object: object, message: string): void {
    if (ship.warned === object) return;
    ship.warned = object;
    this.#options.log?.(message);
  }
}

// ---------------------------------------------------------------------------------------------
// The page's wiring (EnterWorld.ts): one track client per gateway, one motion per world session.

export interface ShipMotionWorld {
  readonly state: WorldState;
  readonly mapId: number | undefined;
  gameObjectTemplate(entry: number, guid: bigint): GameObjectTemplate | undefined;
}

let currentPaths: ShipPathClient | undefined;
let currentWorld: ShipMotionWorld | undefined;

/** Every world mount: ships in this world sail on tracks from this gateway. */
export function startShipMotion(gatewayUrl: string, world: ShipMotionWorld, options: RetryingCatalogOptions = {}): ShipMotion {
  const origin = new URL(gatewayUrl.replace(/^ws/, "http")).origin;
  if (currentPaths?.origin !== origin) {
    currentPaths?.stop();
    currentPaths = new ShipPathClient(origin, options);
  }
  currentPaths.retry();
  const motion = new ShipMotion({
    paths: currentPaths,
    template: (entry, guid) => world.gameObjectTemplate(entry, guid),
    mapId: () => world.mapId,
    log: (message) => console.warn(`Transport: ${message}`),
  });
  world.state.poseProvider = (state, now) => motion.update(state, now);
  currentWorld = world;
  return motion;
}

/** The world session is retired: no retry asks behind the character screen. */
export function stopShipMotion(): void {
  currentPaths?.stop();
  if (currentWorld) currentWorld.state.poseProvider = undefined;
  currentWorld = undefined;
}
