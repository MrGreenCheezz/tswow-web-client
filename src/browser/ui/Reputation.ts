/**
 * The reputation window: every faction the character has met, with its standing and its war switch.
 *
 * The character sheet keeps its top-20 summary; this is the full list with search. Rows come from
 * `resolveFrameXmlReputationRows` — the same resolver the stock reputation frame reads — so the
 * native window and the FrameXML one can never disagree about a rank, a bar or who may be fought.
 */

import { game } from "../game/Context.js";
import { frameXmlReputationBase, resolveFrameXmlReputationRows } from "../framexml/FrameXmlReputationResolver.js";
import { reputationRankName } from "./Format.js";
import { Bar, Panel, textLine } from "./Widgets.js";

let panel: Panel | undefined;
let reputationQuery = "";

function build(): Panel {
  return new Panel({ id: "reputation-window", title: "Репутация", className: "reputation-window" });
}

export function reputationOpen(): boolean {
  return panel?.visible ?? false;
}

export function closeReputation(): void {
  panel?.hide();
}

export function toggleReputation(): void {
  panel ??= build();
  panel.toggle();
  if (panel.visible) showReputation();
}

/** Repaints when open. Called from the `REPUTATION_CHANGED` subscription the world owns. */
export function showReputation(): void {
  const world = game.world;
  panel ??= build();
  if (!panel.visible) return;
  if (!world) {
    panel.body.replaceChildren(textLine("Нет соединения", "Откройте окно в мире."));
    return;
  }
  const rows = resolveFrameXmlReputationRows(world, game.factions);
  panel.title = `Репутация · ${rows.length}`;
  panel.body.replaceChildren();

  const toolbar = document.createElement("div");
  toolbar.className = "reputation-toolbar";
  const search = document.createElement("input");
  search.type = "search";
  search.value = reputationQuery;
  search.placeholder = "Поиск фракций";
  search.setAttribute("aria-label", "Поиск фракций");
  search.addEventListener("input", () => {
    reputationQuery = search.value.trim().toLocaleLowerCase();
    showReputation();
    const next = panel?.body.querySelector<HTMLInputElement>(".reputation-toolbar input[type=\"search\"]");
    next?.focus();
  });
  toolbar.append(search);
  panel.body.append(toolbar);

  if (!game.factions?.ready) {
    panel.body.append(textLine("Загрузка…", "Названия фракций ещё в пути."));
    return;
  }
  const query = reputationQuery;
  const filtered = rows.filter((row) => !query || row.name.toLocaleLowerCase().includes(query));
  if (filtered.length === 0) {
    panel.body.append(textLine("Пусто", rows.length > 0 ? "Поиск ничего не нашёл" : "Встреченных фракций пока нет."));
    return;
  }
  for (const row of filtered) {
    const block = document.createElement("div");
    block.className = "reputation-row";
    const head = document.createElement("div");
    head.className = "reputation-head";
    const name = document.createElement("strong");
    name.textContent = row.name;
    const rank = document.createElement("span");
    rank.className = "muted";
    rank.textContent = reputationRankName(row.standingId);
    head.append(name, rank);
    block.append(head);
    const bar = new Bar({ kind: "skill", text: true });
    const span = Math.max(1, row.barMax - row.barMin);
    bar.set(row.barValue - row.barMin, span, `${row.barValue - row.barMin} / ${span}`);
    block.append(bar.root);
    const foot = document.createElement("div");
    foot.className = "reputation-foot";
    const state = document.createElement("span");
    state.className = "muted";
    state.textContent = row.atWarWith ? "Война" : row.isInactive ? "Неактивна" : "";
    foot.append(state);
    // War is the one thing this window changes, and only where the row says so. The server
    // answers nothing: WorldClient.setFactionAtWar flips the world's copy of the flag as it sends
    // (Wow.exe 0x005d0a10) and REPUTATION_CHANGED repaints this list at once. Peace below -3000
    // or in combat is refused on the client and the row stays as it was.
    if (row.canToggleAtWar) {
      const war = document.createElement("button");
      war.type = "button";
      war.textContent = row.atWarWith ? "Заключить мир" : "Объявить войну";
      war.setAttribute("aria-pressed", String(row.atWarWith));
      war.addEventListener("click", () => world.setFactionAtWar(row.listId, !row.atWarWith,
        frameXmlReputationBase(world, game.factions?.reputationCatalog, row.listId)));
      foot.append(war);
    }
    block.append(foot);
    panel.body.append(block);
  }
}

/** Forgets the search for a character that is no longer the one being played. */
export function clearReputation(): void {
  reputationQuery = "";
  panel?.hide();
}
