import { game } from "../game/Context.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { Panel, confirmPanel } from "./Widgets.js";

interface Parts {
  panel: Panel;
  status: HTMLElement;
  text: HTMLTextAreaElement;
  response: HTMLElement;
  send: HTMLButtonElement;
  remove: HTMLButtonElement;
  resolve: HTMLButtonElement;
  refresh: HTMLButtonElement;
  needMoreBox: HTMLInputElement;
}
let parts: Parts | undefined;
let owner: WorldClient | undefined;
let unsubscribe: (() => void) | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
let loaded = false;
let dirty = false;
let pending = false;
let message = "";

/**
 * 8.17: the stock help frame's «Сообщить о задержке» page (HelpFrame.xml, the BUTTON_LAG_* buttons,
 * ruRU GlobalStrings.lua:1153-1168), in STATIC_CONSTANTS order Loot = 1 … Spell = 6; HelpReportLag
 * (HelpFrame.lua:455) sends GMReportLag and shows LAG_SUCCESS (HELPFRAME_REPORTLAG_TEXT1).
 */
const LAG_KINDS: readonly (readonly [kind: number, label: string])[] = [
  [1, "Добыча"], [2, "Аукционный дом"], [3, "Почта"], [4, "Чат"], [5, "Движение"], [6, "Заклинания и способности"],
];

function button(id: string, label: string, action: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.id = id; element.type = "button"; element.textContent = label;
  element.addEventListener("click", action);
  return element;
}

function finish(): void {
  pending = false;
  clearTimeout(timeout);
  timeout = undefined;
}

function begin(): void {
  pending = true;
  message = "Ожидание ответа сервера…";
  timeout = setTimeout(() => {
    finish();
    loaded = false;
    message = "Сервер не ответил. Обновите состояние обращения перед повторной отправкой.";
    render();
  }, 15_000);
  render();
}

function refresh(): void {
  if (!owner || pending) return;
  loaded = false;
  message = "Загрузка обращения…";
  owner.requestTicket();
  owner.requestTicketSystemStatus();
  render();
}

function build(): Parts {
  const panel = new Panel({ id: "gm-ticket-window", title: "Помощь игрового мастера" });
  panel.root.style.width = "min(480px, 90vw)";
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const label = document.createElement("label"); label.textContent = "Описание проблемы";
  const text = document.createElement("textarea");
  text.id = "gm-ticket-text"; text.rows = 8; text.maxLength = 2000; text.style.width = "100%";
  text.addEventListener("input", () => { dirty = true; render(); });
  label.append(text);
  const response = document.createElement("p"); response.style.whiteSpace = "pre-wrap";
  const needMore = document.createElement("label");
  const needMoreBox = document.createElement("input");
  needMoreBox.type = "checkbox"; needMoreBox.checked = true;
  const needMoreText = document.createElement("span");
  needMoreText.textContent = " Нужна помощь ГМ";
  needMore.append(needMoreBox, needMoreText);
  const send = button("gm-ticket-send", "Отправить", () => { void submit(); });
  const remove = button("gm-ticket-delete", "Отозвать обращение", () => {
    const world = owner;
    if (!world?.gmTicket || pending) return;
    confirmPanel(remove, { title: "Отозвать обращение?", lines: ["Оно будет закрыто на сервере."],
      confirm: "Отозвать", danger: true, onConfirm: () => {
        if (owner !== world || !world.gmTicket || pending) return;
        begin(); world.abandonTicket();
      } });
  });
  const resolve = button("gm-ticket-resolve", "Проблема решена", () => {
    if (!owner?.gmResponse || pending) return;
    begin(); owner.resolveGmResponse();
  });
  const reload = button("gm-ticket-refresh", "Обновить", refresh);
  const lagTitle = document.createElement("p"); lagTitle.textContent = "Сообщить о задержке";
  const lag = LAG_KINDS.map(([kind, title]) => button(`gm-lag-${kind}`, title, () => {
    if (!owner?.reportLag(kind)) return;
    message = "Ваше сообщение о задержке отправлено."; render();
  }));
  panel.body.append(status, label, needMore, response, send, remove, resolve, reload, lagTitle, ...lag);
  return { panel, status, text, response, send, remove, resolve, refresh: reload, needMoreBox };
}

async function submit(): Promise<void> {
  const world = owner;
  const text = parts?.text.value.trim() ?? "";
  if (!world || pending || !loaded || !world.ticketsEnabled || !text) return;
  if (text.length > 2000 || text.includes("\0")) {
    message = "Введите до 2000 символов без нулевого символа."; render(); return;
  }
  const position = world.state.objects.get(world.state.selfGuid ?? 0n)?.position;
  if (!world.gmTicket && (!position || world.mapId === undefined)) {
    message = "Дождитесь загрузки персонажа в мир."; render(); return;
  }
  begin();
  try {
    if (world.gmTicket) world.updateTicket(text);
    else {
      // Attach the recent chat window so a GM sees the context: the last 20 lines with
      // timestamps gate the server reading the log at all (`count && decompressedSize`).
      const lines = world.chatLog.slice(-20);
      const chatLog = lines.map((line) => line.text).join("\n").slice(0, 4000);
      const chatTimes = lines.map((line) => Math.floor((line.at ?? Date.now()) / 1000));
      await world.createTicket({ mapId: world.mapId!, ...position!, message: text,
        needResponse: true, needMoreHelp: parts?.needMoreBox.checked ?? true,
        ...(chatTimes.length > 0 && chatLog ? { chatTimes, chatLog } : {}) });
    }
  } catch {
    if (owner !== world) return;
    finish(); message = "Не удалось отправить обращение. Текст сохранён."; render();
  }
}

function render(): void {
  if (!parts) return;
  const survey = owner?.ticketSurveyPending === true;
  parts.status.textContent = survey
    ? "Обратите внимание: сервер просит оценить помощь (опрос). Он закроется сам; это напоминание, а не блок."
    : message || (owner?.ticketsEnabled === false
      ? "Сервер сейчас не принимает обращения." : owner?.gmTicket ? "У вас есть открытое обращение." : "Открытых обращений нет.");
  parts.send.textContent = owner?.gmTicket ? "Сохранить изменения" : "Отправить";
  parts.send.disabled = pending || !loaded || !owner?.ticketsEnabled || !!owner.gmResponse || !parts.text.value.trim();
  parts.text.disabled = pending;
  parts.remove.disabled = pending || !owner?.gmTicket;
  parts.resolve.hidden = !owner?.gmResponse;
  parts.resolve.disabled = pending;
  parts.refresh.disabled = pending;
  parts.response.textContent = owner?.gmResponse ? `Ответ игрового мастера:\n${owner.gmResponse.response}` : "";
}

export function toggleGmTickets(): void {
  const world = game.world;
  if (!world) return;
  parts ??= build();
  if (owner !== world) {
    resetGmTickets(); owner = world;
    unsubscribe = world.events.on("GM_TICKET_CHANGED", (event) => {
      if (event.kind === "snapshot") {
        loaded = true;
        if (!dirty && !pending) parts!.text.value = world.gmTicket?.message ?? "";
        if (!pending) message = "";
      } else if (event.kind === "response") {
        finish(); loaded = true;
        if (!dirty) parts!.text.value = world.gmResponse?.message ?? "";
        message = "Получен ответ игрового мастера.";
      } else if (event.kind === "result" && pending) {
        finish(); message = world.ticketMessage?.text ?? "";
        if (!world.ticketMessage?.error) {
          dirty = false; loaded = false;
          world.requestTicket();
        }
      } else if (event.kind === "resolved") {
        finish(); dirty = false; loaded = false;
        world.requestTicket();
      }
      render();
    });
  }
  parts.panel.toggle();
  if (parts.panel.visible) { refresh(); parts.text.focus(); }
}

export function gmTicketsOpen(): boolean { return parts?.panel.visible ?? false; }
export function closeGmTickets(): void { parts?.panel.hide(); }
export function resetGmTickets(): void {
  finish(); unsubscribe?.(); unsubscribe = undefined; owner = undefined;
  loaded = false; dirty = false; message = "";
  if (parts) { parts.panel.hide(); parts.text.value = ""; parts.response.textContent = ""; }
}
