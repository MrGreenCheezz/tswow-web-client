import {
  packWowTime, unpackWowTime, type CalendarEventDetail, type CalendarEventFields,
} from "../../world/CalendarProtocol.js";

/** datetime-local represents the calendar's displayed wall clock, without a browser-zone shift. */
export function calendarDateInput(packed: number): string {
  const value = unpackWowTime(packed);
  const two = (number: number) => String(number).padStart(2, "0");
  return `${value.year}-${two(value.month)}-${two(value.day)}T${two(value.hour)}:${two(value.minute)}`;
}

export function calendarInputDate(value: string, now: number): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Укажите дату и время события.");
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (year < 2000 || year > 2031 || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day || hour > 23 || minute > 59) {
    throw new Error("Дата или время некорректны; календарь поддерживает 2000–2031 годы.");
  }
  const packed = packWowTime({ year, month, day, hour, minute });
  // Numeric packed order includes weekday bits; compare normalized wall clocks instead.
  if (calendarDateInput(packed) <= calendarDateInput(now)) throw new Error("Выберите время в будущем.");
  return packed;
}

export function calendarEventFields(
  title: string, description: string, date: string, type: number, now: number,
  previous?: CalendarEventDetail,
): CalendarEventFields {
  title = title.trim();
  if (!title) throw new Error("Укажите название события.");
  if (title.length > 128 || description.length > 4096 || /\0/.test(title + description)) {
    throw new Error("Название — до 128 символов, описание — до 4096, без нулевых символов.");
  }
  if (!Number.isInteger(type) || type < 0 || type > 4) throw new Error("Выберите тип события.");
  return {
    title, description, eventType: type, time: calendarInputDate(date, now),
    maxSize: previous?.maxInvites ?? 100, textureId: previous?.textureId ?? -1,
    flags: previous?.flags ?? 0, lockDate: previous?.lockDate ?? 0,
  };
}
