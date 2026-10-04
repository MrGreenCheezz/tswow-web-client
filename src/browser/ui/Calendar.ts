/**
 * The calendar: a month of events, the invitations waiting for an answer, and the raid saves.
 *
 * Alert payloads such as "this event moved" are discarded by the protocol handler, so those
 * notifications request a snapshot. Snapshot, detail and pending-count replies only redraw;
 * querying again from those replies would create an unbounded request loop.
 *
 * Raid saves come through `INSTANCE_CHANGED` rather than `CALENDAR_CHANGED`, which is its own
 * subscription below.
 */

import { game } from "../game/Context.js";
import type { WorldPacketEvents } from "../../world/EventBus.js";
import type { WorldClient } from "../../world/WorldClient.js";
import {
  CALENDAR_RANK_OWNER, CALENDAR_STATUS_ACCEPTED, CALENDAR_SEND_ADD, CALENDAR_SEND_COPY,
  type CalendarEventDetail, type CalendarEventFields,
} from "../../world/CalendarProtocol.js";
import {
  RSVP_CHOICES, eventLine, formatWowDate, inviteStatusText, lockoutLines, monthGrid, monthName,
  serverMonth, stepMonth,
} from "./CalendarModel.js";
import { setTip, Panel, confirmPanel } from "./Widgets.js";
import { calendarDateInput, calendarEventFields, calendarInputDate } from "./CalendarEditor.js";
import {
  closeFrameXmlCalendar, frameXmlCalendarOpen, frameXmlCalendarOwnsErrors, openFrameXmlCalendar, toggleFrameXmlCalendar,
} from "../framexml/FrameXmlCalendarController.js";

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

interface Parts {
  panel: Panel;
  header: HTMLElement;
  grid: HTMLElement;
  detail: HTMLElement;
  lockouts: HTMLElement;
  editor: HTMLElement;
  message: HTMLElement;
}

let parts: Parts | undefined;
let shown: { year: number; month: number } | undefined;
let openEvent: bigint | undefined;
let pending: { world: WorldClient; kind: "add" | "update" | "copy" | "invite"; eventId?: bigint; fields?: CalendarEventFields } | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
let draft: { world: WorldClient; root: HTMLFormElement; submit: HTMLButtonElement } | undefined;
let invitationName = "";

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
  const editor = document.createElement("div");
  const message = document.createElement("p");
  message.setAttribute("role", "status");
  panel.body.append(header, message, grid, detail, editor, lockouts);
  return { panel, header, grid, detail, lockouts, editor, message };
}

/** Either window: the stock CalendarFrame once the world mount published it, else the native Panel. */
export function calendarOpen(): boolean {
  return frameXmlCalendarOpen() || (parts?.panel.visible ?? false);
}

export function closeCalendar(): void {
  closeFrameXmlCalendar();
  parts?.panel.hide();
}

export function resetCalendar(): void {
  closeFrameXmlCalendar();
  parts?.panel.hide();
  shown = undefined;
  openEvent = undefined;
  clearTimeout(timeout);
  pending = undefined;
  draft = undefined;
  invitationName = "";
  parts?.editor.replaceChildren();
  if (parts) parts.message.textContent = "";
}

/**
 * GameTimeFrame, `/calendar`, the game menu and the HUD button: the stock CalendarFrame
 * (FrameXmlCalendarController.ts) when published, else this window.
 */
export function toggleCalendar(): void {
  // A native window up — opened before the stock owner was published (the mount lands seconds after
  // world entry), or as its fallback — is what the player sees: the toggle closes it rather than
  // opening the stock one beneath it.
  if (parts?.panel.visible) {
    parts.panel.hide();
    return;
  }
  if (toggleFrameXmlCalendar()) return;
  toggleNativeCalendar();
}

/** Open (or keep open) the calendar: stock first, like {@link toggleCalendar}; the native one steps aside. */
export function openCalendar(): void {
  if (openFrameXmlCalendar()) {
    parts?.panel.hide();
    return;
  }
  openNativeCalendar();
}

/** The native window alone: the stock owner's fallback when its load or gate fails. */
export function openNativeCalendar(): void {
  if (!(parts?.panel.visible ?? false)) toggleNativeCalendar();
}

function toggleNativeCalendar(): void {
  parts ??= build();
  if (parts.panel.visible) {
    parts.panel.hide();
    return;
  }
  parts.panel.show();
  game.world?.requestCalendar();
  showCalendar();
}

/** Snapshot replies redraw; only the discarded alert payload needs a fresh query. */
export function refreshCalendar(change?: WorldPacketEvents["CALENDAR_CHANGED"]): void {
  const world = game.world;
  if (!world) return;
  const reason = change?.reason ?? "alert";
  const event = world.calendarEvent;
  if (reason === "error") {
    finishCalendarRequest(world.calendarMessage?.text ?? "Сервер отклонил действие.", true);
    // The loaded stock add-on raises its CALENDAR_ERROR popup for this packet (FrameXmlCalendarModel's
    // CALENDAR_UPDATE_ERROR): the message is consumed here so EnterWorld's notice, which reads it
    // right after this call, does not show it a second time.
    if (frameXmlCalendarOwnsErrors()) world.calendarMessage = undefined;
  } else if (pending?.world === world) {
    const added = reason === "event" && event?.sendType === CALENDAR_SEND_ADD && pending.kind === "add";
    const copied = reason === "event" && event?.sendType === CALENDAR_SEND_COPY && pending.kind === "copy";
    const updated = reason === "event" && event !== undefined && event.eventId === pending.eventId && pending.kind === "update"
      && event.name === pending.fields?.title && event.description === pending.fields.description
      && event.date === pending.fields.time && event.eventType === pending.fields.eventType;
    const invited = reason === "invite" && pending.kind === "invite" && change?.eventId === pending.eventId;
    if (added || copied || updated || invited) {
      if (event && (added || copied)) openEvent = event.eventId;
      if (invited) invitationName = "";
      finishCalendarRequest(invited ? "Приглашение отправлено." : "Событие сохранено.", false);
      if (!invited) world.requestCalendar();
    }
  }
  if (parts?.panel.visible && (reason === "alert" || reason === "invite")) {
    world.requestCalendar();
    const eventId = openEvent ?? event?.eventId;
    if (eventId !== undefined && event) world.requestCalendarEvent(eventId);
  }
  showCalendar();
}

function calendarMessage(message: string, error = false): void {
  if (!parts) return;
  parts.message.textContent = message;
  parts.message.className = error ? "error" : "muted";
}

function finishCalendarRequest(message: string, error: boolean): void {
  clearTimeout(timeout);
  pending = undefined;
  calendarMessage(message, error);
  if (draft) draft.submit.disabled = false;
  if (!error) {
    draft = undefined;
    parts?.editor.replaceChildren();
  }
}

function sendCalendarRequest(request: NonNullable<typeof pending>, send: () => void): void {
  if (pending || game.world !== request.world) return;
  pending = request;
  request.world.calendarMessage = undefined;
  if (draft) draft.submit.disabled = true;
  calendarMessage("Запрос отправлен. Ожидаем подтверждения сервера…");
  try {
    send();
  } catch (error) {
    finishCalendarRequest(error instanceof Error ? error.message : "Не удалось отправить запрос.", true);
    return;
  }
  timeout = setTimeout(() => {
    if (pending !== request) return;
    finishCalendarRequest("Сервер не подтвердил действие. Обновите календарь перед повторной отправкой.", true);
    showCalendar();
  }, 15_000);
  showCalendar();
}

function ownerEvent(world: WorldClient, eventId: bigint): CalendarEventDetail | undefined {
  const event = world.calendarEvent;
  const self = world.state.selfGuid;
  return self !== undefined && self !== 0n && game.world === world
    && event?.eventId === eventId && event.ownerGuid === self ? event : undefined;
}

function editCalendar(mode: "add" | "update" | "copy", event?: CalendarEventDetail): void {
  const world = game.world;
  if (!world || !parts || pending) return;
  const form = document.createElement("form");
  form.className = "calendar-editor";
  const title = document.createElement("input");
  title.name = "title";
  title.value = event?.name ?? "";
  title.maxLength = 128;
  const description = document.createElement("textarea");
  description.name = "description";
  description.value = event?.description ?? "";
  description.maxLength = 4096;
  const date = document.createElement("input");
  date.name = "date";
  date.type = "datetime-local";
  date.value = event ? calendarDateInput(event.date) : "";
  const type = document.createElement("select");
  type.name = "eventType";
  for (const [index, name] of ["Рейд", "Подземелье", "PvP", "Встреча", "Другое"].entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = name;
    type.append(option);
  }
  type.value = String(event?.eventType ?? 4);
  function field(labelText: string, input: HTMLElement): void {
    const label = document.createElement("label");
    label.textContent = labelText;
    label.append(input);
    form.append(label);
  }
  if (mode !== "copy") {
    field("Название", title);
    field("Описание", description);
    field("Тип события", type);
  }
  field(mode === "copy" ? "Дата копии (время календаря)" : "Дата и время (время календаря)", date);
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = mode === "copy" ? "Создать копию" : "Сохранить событие";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Отмена";
  cancel.addEventListener("click", () => {
    if (pending) return;
    draft = undefined;
    parts?.editor.replaceChildren();
  });
  form.append(save, cancel);
  draft = { world, root: form, submit: save };
  form.addEventListener("submit", (submit) => {
    submit.preventDefault();
    if (pending || draft?.root !== form || game.world !== world) return;
    const current = event ? ownerEvent(world, event.eventId) : undefined;
    if (event && !current) { calendarMessage("Изменять событие может только его владелец.", true); return; }
    if (!world.calendar || world.state.selfGuid === undefined || world.state.selfGuid === 0n) { calendarMessage("Дождитесь данных календаря.", true); return; }
    try {
      if (mode === "copy" && current) {
        const packed = calendarInputDate(date.value, world.calendar.serverTime);
        const moderator = current.invites.find((invite) => invite.guid === world.state.selfGuid)?.inviteId ?? 0n;
        sendCalendarRequest({ world, kind: "copy", eventId: current.eventId }, () => world.copyCalendarEvent(current.eventId, moderator, packed));
      } else {
        const fields = calendarEventFields(title.value, description.value, date.value, Number(type.value), world.calendar.serverTime, current);
        if (current) {
          const moderator = current.invites.find((invite) => invite.guid === world.state.selfGuid)?.inviteId ?? 0n;
          sendCalendarRequest({ world, kind: "update", eventId: current.eventId, fields }, () => world.updateCalendarEvent(current.eventId, moderator, fields));
        } else {
          const guid = world.state.selfGuid;
          sendCalendarRequest({ world, kind: "add", fields }, () => world.addCalendarEvent(fields,
            [{ guid, status: CALENDAR_STATUS_ACCEPTED, moderator: CALENDAR_RANK_OWNER }]));
        }
      }
    } catch (error) {
      calendarMessage(error instanceof Error ? error.message : "Проверьте поля события.", true);
    }
  });
  parts.editor.replaceChildren(form);
  calendarMessage("");
  (mode === "copy" ? date : title).focus();
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
  const create = document.createElement("button");
  create.type = "button";
  create.textContent = "Создать событие";
  create.disabled = !snapshot || pending !== undefined;
  create.addEventListener("click", () => editCalendar("add"));
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Обновить";
  reload.addEventListener("click", () => refreshCalendar());
  header.append(back, label, forward, create, reload);

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
          invitationName = "";
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
      for (const [mode, label] of [["update", "Изменить"], ["copy", "Копировать"]] as const) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.textContent = label;
        edit.disabled = pending !== undefined;
        edit.addEventListener("click", () => { if (ownerEvent(world!, event.eventId)) editCalendar(mode, event); });
        answers.append(edit);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "Удалить событие";
      remove.addEventListener("click", () => confirmPanel(remove, {
        title: `Удалить «${event.name}»?`,
        lines: ["Приглашённые получат уведомление, и событие исчезнет у всех."],
        confirm: "Удалить",
        danger: true,
        onConfirm: () => {
          const current = ownerEvent(world!, event.eventId);
          if (!current || pending) return;
          world!.removeCalendarEvent(current.eventId, mine?.inviteId ?? 0n);
          refreshCalendar();
        },
      }));
      answers.append(remove);
    }

    const roster = document.createElement("div");
    roster.className = "calendar-invites";
    const selfIsOwner = event.ownerGuid === selfGuid;
    const selfInvite = event.invites.find((row) => row.guid === selfGuid);
    const selfIsModerator = selfIsOwner || (selfInvite?.moderator ?? 0) !== 0;
    for (const invite of event.invites) {
      const row = document.createElement("div");
      const name = document.createElement("span");
      name.textContent = world!.displayName(invite.guid);
      const status = document.createElement("span");
      status.className = "muted";
      status.textContent = inviteStatusText(invite.status);
      row.append(name, status);
      // Moderation: owner/moderator may remove, toggle moderator, or complain.
      // Senders exist in WorldClient; the server validates rights.
      if (selfIsModerator && invite.guid !== selfGuid && selfGuid !== undefined) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Снять";
        remove.addEventListener("click", () => world!.removeCalendarInvite(
          invite.guid, invite.inviteId, event.eventId, selfGuid));
        const mod = document.createElement("button");
        mod.type = "button";
        mod.textContent = (invite.moderator ?? 0) !== 0 ? "Разжаловать" : "Модератор";
        mod.addEventListener("click", () => world!.setCalendarModerator(
          invite.guid, event.eventId, invite.inviteId, (invite.moderator ?? 0) === 0 ? 1 : 0, selfGuid));
        const complain = document.createElement("button");
        complain.type = "button";
        complain.textContent = "Жалоба";
        complain.addEventListener("click", () => world!.complainAboutCalendarInvite(
          event.ownerGuid, event.eventId, invite.inviteId));
        row.append(remove, mod, complain);
      }
      roster.append(row);
    }
    const inviteForm = document.createElement("form");
    inviteForm.className = "calendar-answers";
    if (event.ownerGuid === selfGuid) {
      const name = document.createElement("input");
      name.name = "inviteName";
      name.value = invitationName;
      name.addEventListener("input", () => { invitationName = name.value; });
      name.placeholder = "Имя персонажа";
      name.setAttribute("aria-label", "Кого пригласить");
      const invite = document.createElement("button");
      invite.type = "submit";
      invite.textContent = "Пригласить";
      invite.disabled = pending !== undefined;
      inviteForm.append(name, invite);
      inviteForm.addEventListener("submit", (submit) => {
        submit.preventDefault();
        if (pending) return;
        const current = ownerEvent(world!, event.eventId);
        if (!current) { calendarMessage("Приглашать может только владелец события.", true); return; }
        const value = name.value.trim();
        invitationName = name.value;
        if (!value || value.length > 48 || /[\s\0-\x1f]/u.test(value)) {
          calendarMessage("Укажите имя персонажа без пробелов.", true);
          return;
        }
        const moderator = current.invites.find((row) => row.guid === selfGuid)?.inviteId ?? 0n;
        sendCalendarRequest({ world: world!, kind: "invite", eventId: current.eventId }, () => world!.inviteToCalendarEvent(current.eventId, value, moderator));
      });
    }
    // Mass invites for the owner: the guild filter and the arena roster answer with
    // candidates, which are then invited one by one like any typed name. The server
    // validates each invite; unresolved (hex) rows wait for their name query.
    const mass = document.createElement("div");
    mass.className = "calendar-answers";
    if (event.ownerGuid === selfGuid) {
      const guild = document.createElement("button");
      guild.type = "button";
      guild.textContent = "Гильдия…";
      setTip(guild, "Запросить состав гильдии для массового приглашения");
      guild.addEventListener("click", () => {
        const min = Number(window.prompt("Минимальный уровень (0–80):", "1") ?? "");
        const max = Number(window.prompt("Максимальный уровень (0–80):", "80") ?? "");
        const rank = Number(window.prompt("Звания до (0 — все):", "0") ?? "");
        if (![min, max, rank].every((value) => Number.isInteger(value) && value >= 0)) {
          calendarMessage("Уровни и звание — целые числа от нуля.", true);
          return;
        }
        world!.requestCalendarGuildFilter(Math.min(min, 80), Math.min(max, 80), rank, event.eventId);
      });
      const arena = document.createElement("button");
      arena.type = "button";
      arena.textContent = "Арена…";
      setTip(arena, "Запросить состав команды арены для массового приглашения");
      arena.addEventListener("click", () => {
        const team = Number(window.prompt("ID команды арены:", "") ?? "");
        if (!Number.isInteger(team) || team <= 0) {
          calendarMessage("ID команды — целое число больше нуля.", true);
          return;
        }
        world!.requestCalendarArenaTeam(team, event.eventId);
      });
      mass.append(guild, arena);
      const candidates = world!.calendarCandidates;
      if (candidates && (candidates.eventId === undefined || candidates.eventId === event.eventId)
        && candidates.invites.length > 0) {
        const head = document.createElement("p");
        head.className = "muted";
        head.textContent = `Кандидаты (${candidates.source === "guild" ? "гильдия" : "арена"}): ${candidates.invites.length}`;
        mass.append(head);
        const moderator = event.invites.find((row) => row.guid === selfGuid)?.inviteId ?? 0n;
        for (const candidate of candidates.invites.slice(0, 50)) {
          const candidateName = world!.displayName(candidate.guid);
          if (candidateName.startsWith("0x")) world!.requestName(candidate.guid);
          const row = document.createElement("div");
          const label = document.createElement("span");
          label.textContent = candidate.level > 0 ? `${candidateName} · ур. ${candidate.level}` : candidateName;
          const inviteOne = document.createElement("button");
          inviteOne.type = "button";
          inviteOne.textContent = "Пригласить";
          inviteOne.disabled = candidateName.startsWith("0x") || pending !== undefined;
          inviteOne.addEventListener("click", () => {
            const current = ownerEvent(world!, event.eventId);
            if (!current) { calendarMessage("Приглашать может только владелец события.", true); return; }
            const resolved = world!.displayName(candidate.guid);
            if (resolved.startsWith("0x")) return;
            sendCalendarRequest({ world: world!, kind: "invite", eventId: current.eventId },
              () => world!.inviteToCalendarEvent(current.eventId, resolved, moderator));
          });
          row.append(label, inviteOne);
          mass.append(row);
        }
        if (candidates.invites.length > 50) {
          const more = document.createElement("p");
          more.className = "muted";
          more.textContent = `…и ещё ${candidates.invites.length - 50}`;
          mass.append(more);
        }
      }
    }
    detail.replaceChildren(title, when, description, answers, inviteForm, mass, roster);
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
