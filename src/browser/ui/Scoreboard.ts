/**
 * The battleground and arena scoreboard.
 *
 * `MSG_PVP_LOG_DATA` has been parsed since slice P7 and had no reader; `requestPvpScores` had no
 * caller. The refresh button is disabled inside an arena on purpose — the core refuses the query
 * outright until the match ends, so a button that looked live would simply do nothing.
 */

import { game } from "../game/Context.js";
import { inArena } from "./UnitFrames.js";
import {
  objectiveCount, objectiveHeaders, scoreColumns, scoreGroups, winnerText,
} from "./ScoreboardModel.js";
import { Panel, attachTooltip, confirmPanel } from "./Widgets.js";

interface Parts {
  panel: Panel;
  status: HTMLElement;
  table: HTMLElement;
  refresh: HTMLButtonElement;
}

let parts: Parts | undefined;

function build(): Parts {
  const panel = new Panel({ id: "scoreboard-window", title: "Таблица боя", className: "scoreboard" });
  const status = document.createElement("p");
  status.className = "muted";
  status.setAttribute("role", "status");
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "Обновить";
  refresh.addEventListener("click", () => {
    // The button is marked rather than disabled, so it refuses here instead of in the browser.
    if (refresh.getAttribute("aria-disabled") === "true") return;
    game.world?.requestPvpScores();
    game.world?.requestFlagCarriers();
    showScoreboard();
  });
  attachTooltip(refresh, () => refresh.getAttribute("aria-disabled") === "true"
    ? { title: "Обновить", footer: ["Внутри арены сервер не отдаёт таблицу до конца боя"] }
    : { title: "Обновить", footer: ["Запросить таблицу у сервера заново"] });
  const table = document.createElement("div");
  table.className = "scoreboard-table";
  panel.body.append(status, refresh, table);
  return { panel, status, table, refresh };
}

export function scoreboardOpen(): boolean {
  return parts?.panel.visible ?? false;
}

export function closeScoreboard(): void {
  parts?.panel.hide();
}

export function resetScoreboard(): void {
  parts?.panel.hide();
}

export function toggleScoreboard(): void {
  parts ??= build();
  if (parts.panel.visible) {
    parts.panel.hide();
    return;
  }
  parts.panel.show();
  const world = game.world;
  if (world && !inArena(world)) {
    world.requestPvpScores();
    world.requestFlagCarriers();
  }
  showScoreboard();
}

/** Live refresh while the window is open: re-ask every 10s outside arenas. */
let lastScoreRequest = 0;
export function updateScoreboard(now: number): void {
  if (!scoreboardOpen() || now - lastScoreRequest < 10_000) return;
  const world = game.world;
  if (!world || inArena(world)) return;
  lastScoreRequest = now;
  world.requestPvpScores();
  world.requestFlagCarriers();
}

/** Active sort: column id + direction. Default is damage, as before. */
let sortColumn = "damageDone";
let sortDescending = true;

export function showScoreboard(): void {
  const world = game.world;
  if (!parts?.panel.visible) return;
  const { status, table, refresh } = parts;
  const log = world?.pvpScores;

  // The core refuses MSG_PVP_LOG_DATA inside an arena until the match is over.
  // Marked rather than `disabled`, so the one sentence explaining the refusal can be hovered: a
  // disabled button takes no pointer events and its `title` is invisible by construction.
  const blocked = world !== undefined && inArena(world);
  if (blocked) refresh.setAttribute("aria-disabled", "true");
  else refresh.removeAttribute("aria-disabled");
  refresh.title = "";

  if (!world || !log) {
    status.textContent = world ? "Таблица ещё не запрашивалась" : "Нет соединения";
    table.replaceChildren();
    return;
  }
  status.textContent = winnerText(log);

  const columns = scoreColumns(log);
  const objectives = objectiveCount(log);
  const headers = [...columns.map((column) => column.title), ...objectiveHeaders(objectives, world.mapId)];

  const rows: HTMLElement[] = [];
  // Flag carriers (Warsong Gulch / Twin Peaks): asked with the scores and refreshed on the
  // answer. Guids with no name yet read as hex until the name query lands.
  const carriers = world.flagCarriers ?? [];
  if (!log.arena && carriers.length > 0) {
    const line = document.createElement("p");
    line.className = "muted";
    line.textContent = `С флагами: ${carriers.map((carrier) => world.displayName(carrier.guid)).join(", ")}`;
    rows.push(line);
    for (const carrier of carriers) {
      if (world.displayName(carrier.guid).startsWith("0x")) world.requestName(carrier.guid);
    }
  }
  const sort = { column: sortColumn, descending: sortDescending };
  for (const group of scoreGroups(log, (guid) => world.displayName(guid), sort)) {
    if (group.title) {
      const heading = document.createElement("div");
      heading.className = "scoreboard-team";
      heading.textContent = group.title;
      rows.push(heading);
    }
    const head = document.createElement("div");
    head.className = "scoreboard-row scoreboard-head";
    head.append(cell("Игрок"));
    for (const column of columns) {
      const header = cell(column.title + (sortColumn === column.id ? (sortDescending ? " ▼" : " ▲") : ""));
      header.className = "scoreboard-sortable";
      header.addEventListener("click", () => {
        if (sortColumn === column.id) sortDescending = !sortDescending;
        else { sortColumn = column.id; sortDescending = true; }
        showScoreboard();
      });
      head.append(header);
    }
    for (const title of objectiveHeaders(objectives, world.mapId)) head.append(cell(title));
    rows.push(head);

    for (const row of group.rows) {
      const line = document.createElement("div");
      line.className = "scoreboard-row";
      const name = cell(row.name);
      name.className = "scoreboard-name";
      line.append(name);
      for (const column of columns) line.append(cell(column.value(row.score)));
      for (let index = 0; index < objectives; index++) {
        line.append(cell(String(row.score.objectives[index] ?? 0)));
      }
      // Reporting somebody for standing still is destructive enough to ask about: the server
      // counts the reports and removes the player from the battleground on the third.
      line.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        confirmPanel(line, {
          title: `Пожаловаться на бездействие: ${row.name}?`,
          lines: ["Сервер считает жалобы; по трём игрока выкидывает с поля боя."],
          confirm: "Пожаловаться",
          danger: true,
          onConfirm: () => world.reportPvpAfk(row.score.guid),
        });
      });
      rows.push(line);
    }
  }
  table.replaceChildren(...rows);
  table.style.setProperty("--scoreboard-columns", String(headers.length + 1));
}

function cell(text: string): HTMLElement {
  const box = document.createElement("span");
  box.textContent = text;
  return box;
}
