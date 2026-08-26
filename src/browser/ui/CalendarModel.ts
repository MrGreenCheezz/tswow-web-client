/**
 * The calendar month, its events and the raid saves beside them.
 *
 * Every date in this family is a packed `WowTime` word rather than a unix second — minute, hour,
 * weekday, day, month and a two-digit year crammed into 32 bits — and the snapshot writes the one
 * exception, a raw unix `serverNow`, immediately before a packed `serverTime`. Two adjacent words
 * of the same width in different units is exactly the kind of thing that reads as working.
 */

import {
  CALENDAR_STATUS_ACCEPTED, CALENDAR_STATUS_CONFIRMED, CALENDAR_STATUS_DECLINED,
  CALENDAR_STATUS_INVITED, CALENDAR_STATUS_OUT, CALENDAR_STATUS_SIGNED_UP, CALENDAR_STATUS_STANDBY,
  CALENDAR_STATUS_TENTATIVE, unpackWowTime,
  type CalendarEventSummary, type CalendarSnapshot, type RaidLockoutChange,
} from "../../world/CalendarProtocol.js";

const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

export function monthName(month: number): string {
  return MONTHS[month - 1] ?? String(month);
}

/** «21.08.2026 19:30» from the packed word, which is the only form these dates come in. */
export function formatWowDate(packed: number): string {
  const date = unpackWowTime(packed);
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${two(date.day)}.${two(date.month)}.${date.year} ${two(date.hour)}:${two(date.minute)}`;
}

export function formatWowTimeOnly(packed: number): string {
  const date = unpackWowTime(packed);
  return `${String(date.hour).padStart(2, "0")}:${String(date.minute).padStart(2, "0")}`;
}

export interface CalendarDay {
  /** Day of the month, or zero for the blank cells before the first. */
  day: number;
  events: CalendarEventSummary[];
}

/**
 * One month as a grid of weeks, Monday first.
 *
 * The leading blanks are real cells rather than an offset, because a calendar drawn with a
 * `grid-column-start` on the first day silently loses the offset the moment the grid wraps.
 */
export function monthGrid(
  events: readonly CalendarEventSummary[], year: number, month: number,
): CalendarDay[] {
  const byDay = new Map<number, CalendarEventSummary[]>();
  for (const event of events) {
    const when = unpackWowTime(event.date);
    if (when.year !== year || when.month !== month) continue;
    const bucket = byDay.get(when.day) ?? [];
    bucket.push(event);
    byDay.set(when.day, bucket);
  }
  // `getUTCDay` counts from Sunday; the Russian week starts on Monday.
  const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: CalendarDay[] = [];
  for (let blank = 0; blank < firstWeekday; blank++) cells.push({ day: 0, events: [] });
  for (let day = 1; day <= days; day++) {
    const list = (byDay.get(day) ?? []).sort((left, right) => left.date - right.date);
    cells.push({ day, events: list });
  }
  while (cells.length % 7 !== 0) cells.push({ day: 0, events: [] });
  return cells;
}

/** The month the snapshot's own clock is in, so the window opens on the right page. */
export function serverMonth(snapshot: CalendarSnapshot | undefined): { year: number; month: number } {
  if (!snapshot) {
    const now = new Date();
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  }
  const when = unpackWowTime(snapshot.serverTime);
  return { year: when.year, month: when.month };
}

export function stepMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = (year * 12) + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

const STATUS_NAMES: Record<number, string> = {
  [CALENDAR_STATUS_INVITED]: "приглашён",
  [CALENDAR_STATUS_ACCEPTED]: "придёт",
  [CALENDAR_STATUS_DECLINED]: "отказался",
  [CALENDAR_STATUS_CONFIRMED]: "подтверждён",
  [CALENDAR_STATUS_OUT]: "не приглашён",
  [CALENDAR_STATUS_STANDBY]: "в запасе",
  [CALENDAR_STATUS_SIGNED_UP]: "записался",
  [CALENDAR_STATUS_TENTATIVE]: "возможно",
};

export function inviteStatusText(status: number): string {
  return STATUS_NAMES[status] ?? `статус ${status}`;
}

/** The answers an invitation offers, which is not every status the wire can carry. */
export const RSVP_CHOICES: ReadonlyArray<readonly [number, string]> = [
  [CALENDAR_STATUS_ACCEPTED, "Приду"],
  [CALENDAR_STATUS_TENTATIVE, "Возможно"],
  [CALENDAR_STATUS_DECLINED, "Не приду"],
];

export function eventLine(event: CalendarEventSummary): string {
  return `${formatWowTimeOnly(event.date)} ${event.name}`;
}

/**
 * Raid saves, worded.
 *
 * The standalone lockout packets do **not** clamp the remaining time, so an expired save arrives
 * as a negative number; the snapshot's own copy of the same thing does clamp. Both end up here.
 */
export function lockoutLines(lockouts: Iterable<RaidLockoutChange>, mapName: (mapId: number) => string): string[] {
  const lines: string[] = [];
  for (const lockout of lockouts) {
    const remaining = lockout.timeRemaining;
    const text = remaining <= 0 ? "истекло" : `осталось ${formatDuration(remaining)}`;
    lines.push(`${mapName(lockout.mapId)} · сложность ${lockout.difficulty} · ${text}`);
  }
  return lines;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (days > 0) return `${days} д ${hours} ч`;
  const minutes = Math.floor((seconds % 3_600) / 60);
  return hours > 0 ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
}
