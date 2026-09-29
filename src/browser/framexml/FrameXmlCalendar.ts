import { unpackWowTime, type CalendarSnapshot } from "../../world/CalendarProtocol.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { FrameXmlCalendarLive, frameXmlCalendarLiveNow, type FrameXmlCalendarLiveWorld } from "./FrameXmlCalendarLive.js";
import {
  FRAMEXML_CALENDAR_UI_BINDINGS, type FrameXmlCalendarBinding, type FrameXmlCalendarModel,
} from "./FrameXmlCalendarModel.js";

export type FrameXmlCalendarDate = readonly [weekday: number, month: number, day: number, year: number];
export type FrameXmlCalendarResult = readonly unknown[];

export interface FrameXmlCalendar {
  /** CalendarGetDate: Sunday=1, then month/day/year, as stock Blizzard_Calendar.lua indexes it. */
  date(): FrameXmlCalendarDate | undefined;
  /** Last server-known pending count; undefined means no count can be established. */
  pendingInvites(): number | undefined;
  /** The stock Blizzard_Calendar's C API (FrameXmlCalendarModel.ts); absent, the window stays native. */
  readonly ui?: FrameXmlCalendarModel | undefined;
}

export interface FrameXmlCalendarPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

export const FRAMEXML_CALENDAR_EVENTS = Object.freeze({
  pendingInvites: "CALENDAR_UPDATE_PENDING_INVITES",
});

const NOTHING: readonly [] = Object.freeze([]);

/** The two stock GameTime C APIs, kept separate from the large world seam binding table. */
export const FRAMEXML_CALENDAR_BINDINGS: Readonly<Record<
  "CalendarGetDate" | "CalendarGetNumPendingInvites",
  (calendar: FrameXmlCalendar | undefined) => FrameXmlCalendarResult
>> = Object.freeze({
  CalendarGetDate: (calendar) => calendar?.date() ?? NOTHING,
  CalendarGetNumPendingInvites: (calendar) => {
    const count = calendar?.pendingInvites();
    return count === undefined ? NOTHING : [count];
  },
});

/**
 * Every calendar name of the world seam, spread into FRAMEXML_SEAM_BINDINGS: GameTime's two above
 * (the clock and the invite badge, which work without the add-on) and the stock window's API.
 */
export const FRAMEXML_CALENDAR_SEAM_BINDINGS: Readonly<Record<string, FrameXmlCalendarBinding>> = Object.freeze({
  CalendarGetDate: (host) => FRAMEXML_CALENDAR_BINDINGS.CalendarGetDate(host.calendar as FrameXmlCalendar | undefined),
  CalendarGetNumPendingInvites: (host) =>
    FRAMEXML_CALENDAR_BINDINGS.CalendarGetNumPendingInvites(host.calendar as FrameXmlCalendar | undefined),
  ...FRAMEXML_CALENDAR_UI_BINDINGS,
});

/** A measured local clock for the offline canned world, which has no realm or calendar packets. */
export class LocalFrameXmlCalendar implements FrameXmlCalendar {
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) { this.#now = now; }

  date(): FrameXmlCalendarDate {
    const now = this.#now();
    return [now.getDay() + 1, now.getMonth() + 1, now.getDate(), now.getFullYear()];
  }

  pendingInvites(): number { return 0; }
}

/** GameTime's clock and badge, and everything the stock window's live model reads and sends. */
type CalendarWorld = Pick<WorldClient,
  "currentGameTime" | "calendar" | "calendarPending" | "events" | "requestCalendar"> & FrameXmlCalendarLiveWorld;

function dateFromPacked(snapshot: CalendarSnapshot): Date | undefined {
  // WowTime.cpp reserves year=31, month=15 and day=63 as "unknown". A sentinel is not a
  // calendar date, even though unpackWowTime would turn it into a plausible-looking number.
  const packed = snapshot.serverTime;
  if (((packed >>> 24) & 0x1f) === 31 || ((packed >>> 20) & 0x0f) >= 12
    || ((packed >>> 14) & 0x3f) >= 31 || ((packed >>> 6) & 0x1f) >= 24
    || (packed & 0x3f) >= 60) return undefined;
  const value = unpackWowTime(packed);
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute));
  return date.getUTCFullYear() === value.year && date.getUTCMonth() + 1 === value.month
    && date.getUTCDate() === value.day ? date : undefined;
}

function dateTuple(date: Date): FrameXmlCalendarDate {
  return [date.getUTCDay() + 1, date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCFullYear()];
}

/**
 * Bridges existing WorldClient calendar state to GameTime.lua. Player.cpp sends full WowTime in
 * SMSG_LOGIN_SET_TIME_SPEED; CalendarHandler.cpp sends the same realm clock in a calendar snapshot.
 * The login clock wins because WorldClient advances it continuously, including midnight. The
 * snapshot is a fallback calibrated from its arrival; an unknown live realm date stays unknown.
 */
export class LiveFrameXmlCalendar implements FrameXmlCalendar {
  readonly #getWorld: () => CalendarWorld | undefined;
  readonly #monotonic: () => number;
  readonly #offline: LocalFrameXmlCalendar;
  #pump: FrameXmlCalendarPump | undefined;
  #world: CalendarWorld | undefined;
  #unsubscribe: (() => void) | undefined;
  #lastPending: number | undefined;
  #snapshot: CalendarSnapshot | undefined;
  #snapshotObservedAt = 0;
  readonly #live: FrameXmlCalendarLive;

  constructor(
    getWorld: () => CalendarWorld | undefined,
    monotonic: () => number = () => performance.now(),
    offline: LocalFrameXmlCalendar = new LocalFrameXmlCalendar(),
  ) {
    this.#getWorld = getWorld;
    this.#monotonic = monotonic;
    this.#offline = offline;
    // The stock window's model shares this clock: its grid's «today» is GameTime's day.
    this.#live = new FrameXmlCalendarLive(
      getWorld, monotonic,
      () => {
        const world = getWorld();
        if (world?.calendar && world.calendar !== this.#snapshot) {
          this.#snapshot = world.calendar;
          this.#snapshotObservedAt = this.#monotonic();
        }
        return frameXmlCalendarLiveNow(world, this.#monotonic(), this.#snapshotObservedAt);
      },
    );
  }

  get ui(): FrameXmlCalendarModel {
    return this.#live.model;
  }

  date(): FrameXmlCalendarDate | undefined {
    const world = this.#getWorld();
    if (!world) return this.#offline.date();
    const current = world.currentGameTime?.(this.#monotonic());
    if (current?.date) {
      const { year, month, day } = current.date;
      if (Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)) {
        const date = new Date(Date.UTC(year, month - 1, day));
        if (date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month
          && date.getUTCDate() === day) return dateTuple(date);
      }
    }
    const snapshot = world.calendar;
    if (!snapshot) return undefined;
    if (snapshot !== this.#snapshot) {
      this.#snapshot = snapshot;
      this.#snapshotObservedAt = this.#monotonic();
    }
    const base = dateFromPacked(snapshot);
    return base ? dateTuple(new Date(base.getTime()
      + Math.max(0, this.#monotonic() - this.#snapshotObservedAt))) : undefined;
  }

  pendingInvites(): number | undefined {
    const world = this.#getWorld();
    if (!world) return this.#offline.pendingInvites();
    // WorldClient zeroes `calendarPending` on every SMSG_CALENDAR_CLEAR_PENDING_ACTION, which answers
    // any calendar command (TrinityCore sends no NUM_PENDING after an RSVP): answering one of two
    // invitations would put the badge out. Once a snapshot has listed the invitations, the model's
    // count is the core's own rule over them.
    const counted = this.#live.model.pendingInviteCount();
    if (counted !== undefined) return counted;
    const pending = world.calendarPending;
    return Number.isSafeInteger(pending) && pending >= 0 ? pending : undefined;
  }

  attach(pump: FrameXmlCalendarPump): void {
    this.detach();
    this.#pump = pump;
    this.#syncWorld();
    this.#live.attach(pump);
  }

  detach(): void {
    this.#live.detach();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#world = undefined;
    this.#pump = undefined;
    this.#lastPending = undefined;
    this.#snapshot = undefined;
  }

  /** Call from the host's existing bounded world poll to catch a world/session replacement. */
  tick(): void {
    if (!this.#pump) return;
    this.#syncWorld();
    this.#publishPending();
    this.#live.tick();
  }

  #syncWorld(): void {
    const world = this.#getWorld();
    if (world === this.#world) return;
    this.#unsubscribe?.();
    this.#world = world;
    this.#snapshot = undefined;
    this.#unsubscribe = world?.events?.on("CALENDAR_CHANGED", (event) => {
      if (event.reason === "snapshot" && world.calendar) {
        this.#snapshot = world.calendar;
        this.#snapshotObservedAt = this.#monotonic();
      }
      // The initial count may match WorldClient's zero-valued cache. The server's answer must
      // still wake GameTime.lua, which captured these C functions when its chunk was loaded.
      this.#publishPending(event.reason === "pending");
    });
    // The native calendar asks only when opened; GameTime's invite badge needs its own initial
    // server answer. One query per attached world uses WorldClient's existing pair of CMSG packets.
    world?.requestCalendar?.();
    this.#publishPending();
  }

  #publishPending(force = false): void {
    const pending = this.pendingInvites();
    if (pending === undefined || (!force && pending === this.#lastPending)) return;
    this.#lastPending = pending;
    this.#pump?.fire(FRAMEXML_CALENDAR_EVENTS.pendingInvites);
  }
}
