/**
 * The calendar: a month of events, the invitations waiting for an answer, and the raid saves.
 *
 * Eighteen packets of it have been parsed since slice P5 and none of them reached anything. Eleven
 * are still parsed and discarded by the handler — the alert stream that says "this event moved",
 * "you were uninvited", "somebody answered" — so this window does not trust the alerts to update
 * it: on every `CALENDAR_CHANGED` it asks for the snapshot again. That is one request per change
 * and the packet is small.
 *
 * Raid saves come through `INSTANCE_CHANGED` rather than `CALENDAR_CHANGED`, which is its own
 * subscription below.
 */

import { game } from "../game/Context.js";
import {
  RSVP_CHOICES, eventLine, formatWowDate, inviteStatusText, lockoutLines, monthGrid, monthName,
  serverMonth, stepMonth,
} from "./CalendarModel.js";
import { Panel, confirmPanel } from "./Widgets.js";

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

interface Parts {
  panel: Panel;
  header: HTMLElement;
  grid: HTMLElement;
  detail: HTMLElement;
  lockouts: HTMLElement;
}

let parts: Parts | undefined;
let shown: { year: number; month: number } | undefined;
let openEvent: bigint | undefined;

function build(): Parts {
  const panel = new Panel({ id: "calendar-window", title: "Календарь", className: "calendar-window" });
  const header = document.createElement("div");
  header.className = "calendar-header";
  const grid = document.createElement("div");
  grid.className = "calendar-grid";
  const detail = document.createElement("div");
  detail.className = "calendar-detail";
  const lockouts = document.createElement("div");
  lockouts.className = "calendar-lockouts";
  panel.body.append(header, grid, detail, lockouts);
  return { panel, header, grid, detail, lockouts };
}

export function calendarOpen(): boolean {
  return parts?.panel.visible ?? false;
}

export function closeCalendar(): void {
  parts?.panel.hide();
}

export function resetCalendar(): void {
  parts?.panel.hide();
  shown = undefined;
  openEvent = undefined;
}

export function toggleCalendar(): void {
  parts ??= build();
  if (parts.panel.visible) {
    parts.panel.hide();
    return;
  }
  parts.panel.show();
  game.world?.requestCalendar();
  showCalendar();
}

/** Called on every `CALENDAR_CHANGED`, because the alerts themselves are discarded. */
export function refreshCalendar(): void {
  if (!parts?.panel.visible) return;
  game.world?.requestCalendar();
  if (openEvent !== undefined) game.world?.requestCalendarEvent(openEvent);
}

export function showCalendar(): void {
  const world = game.world;
  if (!parts?.panel.visible) return;
  const { panel, header, grid, detail, lockouts } = parts;
  if (!world) {
    grid.replaceChildren();
    return;
  }
  const snapshot = world.calendar;
  shown ??= serverMonth(snapshot);
  panel.title = world.calendarPending > 0
    ? `Календарь · ${world.calendarPending} приглашений`
    : "Календарь";

  header.replaceChildren();
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "◀";
  back.addEventListener("click", () => { shown = stepMonth(shown!.year, shown!.month, -1); showCalendar(); });
  const label = document.createElement("strong");
  label.textContent = `${monthName(shown.month)} ${shown.year}`;
  const forward = document.createElement("button");
  forward.type = "button";
  forward.textContent = "▶";
  forward.addEventListener("click", () => { shown = stepMonth(shown!.year, shown!.month, 1); showCalendar(); });
  header.append(back, label, forward);

  const cells: HTMLElement[] = WEEKDAYS.map((day) => {
    const box = document.createElement("span");
    box.className = "calendar-weekday";
    box.textContent = day;
    return box;
  });
  for (const cell of monthGrid(snapshot?.events ?? [], shown.year, shown.month)) {
    const box = document.createElement("div");
    box.className = cell.day === 0 ? "calendar-day calendar-blank" : "calendar-day";
    if (cell.day > 0) {
      const number = document.createElement("span");
      number.className = "calendar-number";
      number.textContent = String(cell.day);
      box.append(number);
      for (const event of cell.events) {
        const entry = document.createElement("button");
        entry.type = "button";
        entry.className = "calendar-event";
        entry.textContent = eventLine(event);
        entry.addEventListener("click", () => {
          openEvent = event.eventId;
          world.requestCalendarEvent(event.eventId);
          showCalendar();
        });
        box.append(entry);
      }
    }
    cells.push(box);
  }
  grid.replaceChildren(...cells);

  drawDetail();
  drawLockouts();

  function drawDetail(): void {
    const event = world!.calendarEvent;
    if (!event || (openEvent !== undefined && event.eventId !== openEvent)) {
      detail.replaceChildren();
      return;
    }
    const title = document.createElement("strong");
    title.textContent = event.name;
    const when = document.createElement("p");
    when.className = "muted";
    when.textContent = `${formatWowDate(event.date)} · мест: ${event.maxInvites}`;
    const description = document.createElement("p");
    description.textContent = event.description;

    const answers = document.createElement("div");
    answers.className = "calendar-answers";
    // The invite id is per invitation, and only the player's own row can be answered.
    const selfGuid = world!.state.selfGuid;
    const mine = event.invites.find((invite) => invite.guid === selfGuid);
    if (mine) {
      for (const [status, label] of RSVP_CHOICES) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.disabled = mine.status === status;
        button.addEventListener("click", () => {
          world!.answerCalendarInvite(event.eventId, mine.inviteId, status);
          refreshCalendar();
        });
        answers.append(button);
      }
    } else {
      const signUp = document.createElement("button");
      signUp.type = "button";
      signUp.textContent = "Записаться";
      signUp.addEventListener("click", () => {
        world!.signUpForCalendarEvent(event.eventId);
        refreshCalendar();
      });
      answers.append(signUp);
    }
    if (event.ownerGuid === selfGuid) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "Удалить событие";
      remove.addEventListener("click", () => confirmPanel(remove, {
        title: `Удалить «${event.name}»?`,
        lines: ["Приглашённые получат уведомление, и событие исчезнет у всех."],
        confirm: "Удалить",
        danger: true,
        onConfirm: () => { world!.removeCalendarEvent(event.eventId); refreshCalendar(); },
      }));
      answers.append(remove);
    }

    const roster = document.createElement("div");
    roster.className = "calendar-invites";
    for (const invite of event.invites) {
      const row = document.createElement("div");
      const name = document.createElement("span");
      name.textContent = world!.displayName(invite.guid);
      const status = document.createElement("span");
      status.className = "muted";
      status.textContent = inviteStatusText(invite.status);
      row.append(name, status);
      roster.append(row);
    }
    detail.replaceChildren(title, when, description, answers, roster);
  }

  function drawLockouts(): void {
    const lines = lockoutLines(world!.calendarLockouts.values(), (mapId) => `Карта ${mapId}`);
    if (lines.length === 0) {
      lockouts.replaceChildren();
      return;
    }
    const title = document.createElement("strong");
    title.textContent = "Сохранения рейдов";
    lockouts.replaceChildren(title, ...lines.map((line) => {
      const row = document.createElement("p");
      row.className = "muted";
      row.textContent = line;
      return row;
    }));
  }
}
