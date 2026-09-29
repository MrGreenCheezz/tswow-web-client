/**
 * Holidays on the stock calendar's month grid: which days of a month a `Holidays.dbc` row covers,
 * and where each day sits in its run («начало», the days between, «окончание»).
 *
 * The rows are the client's own table (the gateway's `/dbc/calendar`, src/gateway/CalendarCatalog.ts);
 * CalendarHandler.cpp sends only the holidays the server re-dated (`GameEventMgr::modifiedHolidays`),
 * and those dates replace the table's for the same id. The fields, measured on this dataset's 26 rows:
 *
 * * `dates[]` are packed WowTime words in which a field of all ones means «any»: year 31, month 15,
 *   day 63, weekday 7. Brewfest is «any year, 13 September 00:00» (every year); the fishing contest is
 *   «any year, any month, any day, Sunday 14:00» (every week); Noblegarden lists each year's Sunday.
 * * `durations[]` are hours per stage, and `flags[]` say which stages the calendar shows: Brewfest is
 *   168 hidden hours (preparation) and 384 shown, the Darkmoon Faire 48 hidden and 168 shown.
 * * A looping row (Call to Arms) repeats its stages back to back from its first date: 96 shown hours,
 *   912 hidden, i.e. four days in every 42.
 * * `filterType` pairs a row with one of the calendar's filter CVars: 0 weekly holidays, 1 Darkmoon
 *   Faire, 2 battleground holidays; -1 is always shown.
 *
 * The client's own day walk is not in any readable source; this reconstruction follows those fields
 * and the stock Lua's reading of them (CALENDAR_CALENDARTYPE_NAMEFORMAT: START and END days are
 * named, ONGOING days are not; a run of one day is plain). Checked in the live client only by eye.
 */

/** One `Holidays.dbc` row with its `HolidayNames`/`HolidayDescriptions` text, as the gateway serves it. */
export interface FrameXmlCalendarHoliday {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  /** `TextureFilename`, e.g. `Calendar_Brewfest`; stock appends Start/Ongoing/End. Empty for some. */
  readonly texture: string;
  readonly region: number;
  readonly looping: number;
  readonly priority: number;
  readonly filterType: number;
  /** Hours per stage, the table's ten slots. */
  readonly durations: readonly number[];
  /** Packed WowTime words, the table's twenty-six slots; zero is an unused slot. */
  readonly dates: readonly number[];
  /** Per stage: non-zero is a stage the calendar shows. */
  readonly flags: readonly number[];
}

export type FrameXmlCalendarSequenceType = "" | "START" | "ONGOING" | "END";

/** One holiday on one day of the month. */
export interface FrameXmlCalendarHolidayDay {
  readonly holiday: FrameXmlCalendarHoliday;
  readonly sequenceType: FrameXmlCalendarSequenceType;
  /** 1-based day of the run, and the run's length in days. */
  readonly sequenceIndex: number;
  readonly numSequenceDays: number;
  readonly hour: number;
  readonly minute: number;
}

/** The filter CVars of the stock calendar (Blizzard_Calendar.lua CALENDAR_FILTER_CVARS) by filterType. */
export const FRAMEXML_CALENDAR_HOLIDAY_FILTER_CVARS: Readonly<Record<number, string>> = Object.freeze({
  0: "calendarShowWeeklyHolidays",
  1: "calendarShowDarkmoon",
  2: "calendarShowBattlegrounds",
});

const MINUTES_PER_DAY = 1440;

/**
 * Minutes since 1970 of a realm wall-clock time. Every calendar time here is a wall clock — the server
 * adds the session's timezone before packing — so UTC arithmetic keeps days whole.
 */
export function frameXmlCalendarWall(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute) / 60_000;
}

export interface FrameXmlCalendarWallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0 = Sunday. */
  readonly weekday: number;
}

export function frameXmlCalendarWallTime(minutes: number): FrameXmlCalendarWallTime {
  const date = new Date(Math.floor(minutes) * 60_000);
  return {
    year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
    hour: date.getUTCHours(), minute: date.getUTCMinutes(), weekday: date.getUTCDay(),
  };
}

/**
 * A packed WowTime word as wall minutes; undefined for a word with an «any» field or an impossible
 * date (a sentinel is not a date, however plausible its unpacked numbers look).
 */
export function frameXmlCalendarPackedWall(packed: number): number | undefined {
  const minute = packed & 0x3f;
  const hour = (packed >>> 6) & 0x1f;
  const day = ((packed >>> 14) & 0x3f) + 1;
  const month = ((packed >>> 20) & 0x0f) + 1;
  const year = ((packed >>> 24) & 0x1f) + 2000;
  if (year === 2031 || month > 12 || day > 31 || hour > 23 || minute > 59) return undefined;
  const wall = frameXmlCalendarWall(year, month, day, hour, minute);
  const check = frameXmlCalendarWallTime(wall);
  return check.year === year && check.month === month && check.day === day ? wall : undefined;
}

interface DatePattern {
  /** Undefined fields match anything. */
  readonly year: number | undefined;
  readonly month: number | undefined;
  readonly day: number | undefined;
  readonly weekday: number | undefined;
  readonly hour: number;
  readonly minute: number;
}

function pattern(packed: number): DatePattern {
  const year = (packed >>> 24) & 0x1f;
  const month = (packed >>> 20) & 0x0f;
  const day = (packed >>> 14) & 0x3f;
  const weekday = (packed >>> 11) & 0x07;
  const hour = (packed >>> 6) & 0x1f;
  const minute = packed & 0x3f;
  return {
    year: year === 31 ? undefined : 2000 + year,
    month: month === 15 ? undefined : month + 1,
    day: day === 63 ? undefined : day + 1,
    weekday: weekday === 7 ? undefined : weekday,
    hour: hour === 31 ? 0 : hour,
    minute: minute === 63 ? 0 : minute,
  };
}

/** Stage intervals in minutes from an occurrence's start: [start, end) of each shown stage. */
function shownStages(holiday: FrameXmlCalendarHoliday): { readonly from: number; readonly to: number }[] {
  const stages: { from: number; to: number }[] = [];
  let offset = 0;
  for (let index = 0; index < holiday.durations.length; index += 1) {
    const hours = holiday.durations[index] ?? 0;
    if (hours <= 0) {
      // A row with no duration at all (the Wrath launch marker) is a one-day note at its start.
      if (index === 0) stages.push({ from: 0, to: 0 });
      break;
    }
    if ((holiday.flags[index] ?? 0) !== 0) stages.push({ from: offset * 60, to: (offset + hours) * 60 });
    offset += hours;
  }
  return stages;
}

function cycleMinutes(holiday: FrameXmlCalendarHoliday): number {
  let hours = 0;
  for (const value of holiday.durations) {
    if (value <= 0) break;
    hours += value;
  }
  return hours * 60;
}

/** Every occurrence start (wall minutes) of `holiday` whose shown stages can touch [lo, hi). */
function occurrenceStarts(holiday: FrameXmlCalendarHoliday, lo: number, hi: number): number[] {
  const starts: number[] = [];
  const span = cycleMinutes(holiday);
  if (holiday.looping !== 0 && span > 0) {
    // Back to back from the first dated entry: the cycle, not the dates, decides.
    const first = holiday.dates.map(frameXmlCalendarPackedWall).find((wall) => wall !== undefined);
    if (first === undefined) return starts;
    let k = Math.max(0, Math.floor((lo - span - first) / span));
    for (let start = first + k * span; start < hi; k += 1, start = first + k * span) starts.push(start);
    return starts;
  }
  const firstDay = Math.floor((lo - span) / MINUTES_PER_DAY) - 1;
  const lastDay = Math.floor(hi / MINUTES_PER_DAY);
  for (const packed of holiday.dates) {
    if (packed === 0) continue;
    const when = pattern(packed);
    if (when.year !== undefined && when.month !== undefined && when.day !== undefined) {
      // A fixed date: no walk needed.
      const wall = frameXmlCalendarWall(when.year, when.month, when.day, when.hour, when.minute);
      const day = Math.floor(wall / MINUTES_PER_DAY);
      if (day >= firstDay && day <= lastDay && !starts.includes(wall)) starts.push(wall);
      continue;
    }
    for (let day = firstDay; day <= lastDay; day += 1) {
      const date = frameXmlCalendarWallTime(day * MINUTES_PER_DAY);
      if ((when.year !== undefined && when.year !== date.year) || (when.month !== undefined && when.month !== date.month)
        || (when.day !== undefined && when.day !== date.day) || (when.weekday !== undefined && when.weekday !== date.weekday)) continue;
      const wall = day * MINUTES_PER_DAY + when.hour * 60 + when.minute;
      if (!starts.includes(wall)) starts.push(wall);
    }
  }
  return starts;
}

export interface FrameXmlCalendarHolidayOptions {
  /** Regions this client shows besides 0 («every region»). */
  readonly regions: readonly number[];
  /** Whether a filterType is shown (its CVar); unknown types are shown. */
  readonly shown: (filterType: number) => boolean;
}

/**
 * The holidays of one month, by day of the month (1-based), each day's list in the holidays' order.
 * Runs that started in an earlier month continue into this one, so the walk starts early enough to
 * reach back over the longest cycle.
 */
export function frameXmlCalendarHolidayMonth(
  holidays: readonly FrameXmlCalendarHoliday[],
  year: number,
  month: number,
  options: FrameXmlCalendarHolidayOptions,
): Map<number, FrameXmlCalendarHolidayDay[]> {
  const days = new Map<number, FrameXmlCalendarHolidayDay[]>();
  const lo = frameXmlCalendarWall(year, month, 1);
  const hi = frameXmlCalendarWall(year, month + 1, 1);
  const monthFirstDay = Math.floor(lo / MINUTES_PER_DAY);
  const monthLastDay = Math.floor(hi / MINUTES_PER_DAY) - 1;
  for (const holiday of holidays) {
    if (holiday.region !== 0 && !options.regions.includes(holiday.region)) continue;
    const filter = FRAMEXML_CALENDAR_HOLIDAY_FILTER_CVARS[holiday.filterType];
    if (filter !== undefined && !options.shown(holiday.filterType)) continue;
    const stages = shownStages(holiday);
    if (stages.length === 0) continue;
    const seen = new Set<number>();
    for (const start of occurrenceStarts(holiday, lo, hi)) {
      for (const stage of stages) {
        const from = start + stage.from;
        const to = start + stage.to;
        if (seen.has(from)) continue;
        seen.add(from);
        const first = Math.floor(from / MINUTES_PER_DAY);
        const last = to > from ? Math.floor((to - 1) / MINUTES_PER_DAY) : first;
        if (last < monthFirstDay || first > monthLastDay) continue;
        const count = last - first + 1;
        const begin = frameXmlCalendarWallTime(from);
        const end = frameXmlCalendarWallTime(to);
        for (let day = Math.max(first, monthFirstDay); day <= Math.min(last, monthLastDay); day += 1) {
          const sequenceType: FrameXmlCalendarSequenceType = count === 1 ? ""
            : day === first ? "START" : day === last ? "END" : "ONGOING";
          const time = sequenceType === "END" ? end : sequenceType === "ONGOING" ? undefined : begin;
          const dayOfMonth = day - monthFirstDay + 1;
          const list = days.get(dayOfMonth) ?? [];
          list.push({
            holiday, sequenceType, sequenceIndex: day - first + 1, numSequenceDays: count,
            hour: time?.hour ?? 0, minute: time?.minute ?? 0,
          });
          days.set(dayOfMonth, list);
        }
      }
    }
  }
  return days;
}

/**
 * The catalog's rows with the server's re-dated copies laid over them: a snapshot holiday keeps the
 * catalog's name and description (the packet has none) and brings its own dates, stages and flags.
 */
export function frameXmlCalendarMergeHolidays(
  catalog: readonly FrameXmlCalendarHoliday[],
  server: readonly {
    readonly holidayId: number; readonly region: number; readonly looping: number; readonly priority: number;
    readonly filterType: number; readonly dates: readonly number[]; readonly durations: readonly number[];
    readonly flags: readonly number[]; readonly textureFilename: string;
  }[],
): readonly FrameXmlCalendarHoliday[] {
  if (server.length === 0) return catalog;
  const overrides = new Map(server.map((row) => [row.holidayId, row]));
  return catalog.map((row) => {
    const override = overrides.get(row.id);
    return override ? {
      ...row,
      region: override.region, looping: override.looping, priority: override.priority,
      filterType: override.filterType, dates: override.dates, durations: override.durations,
      flags: override.flags, texture: override.textureFilename || row.texture,
    } : row;
  });
}
