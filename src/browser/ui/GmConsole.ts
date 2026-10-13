import { game } from "../game/Context.js";
import { gatewayOrigin as defaultGatewayOrigin } from "../Environment.js";
import { withGeneration } from "../GatewayGeneration.js";
import { readField } from "../../world/Fields.js";
import { CHAT_MSG_SYSTEM, type ChatMessage } from "../../world/ChatProtocol.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { submitChat } from "./Chat.js";
import { setIconSource, spellIconUrl } from "./IconImage.js";
import { ensureSpellNames, spellName } from "./SpellNames.js";
import { unitDisplayName } from "./Frames.js";
import { setTip } from "./Tooltip.js";
import { Panel, Tabs } from "./Widgets.js";
import {
  GM_KINDS, GM_QUALITY_COLOURS, GM_QUICK_GROUPS, GM_TARGET_ACTIONS, GmFavorites, GmHistory, gmRowActions,
  itemCount, normaliseCommand, type GmAction, type GmKind, type GmRow, type GmStorage,
} from "./GmCommands.js";

/**
 * The GM console: a developer's window (DeveloperMode.ts) that finds items, creatures, spells,
 * quests, teleport points and game objects by name or id and sends the GM command for each with
 * one press, so testing does not start with a trip to a wiki for an id.
 *
 * The search is the gateway's (`/data/gm-search`, src/gateway/GmSearch.ts) over the tables it
 * already holds; the commands are ordinary chat (`submitChat`), so the server decides who may run
 * them and its answers — «нет такой команды» included — come back into the log at the bottom.
 */

type PaneId = "search" | "target" | "quick";

const PAGE = 50;
/** How long after a command a system line counts as its answer. */
const ANSWER_WINDOW_MS = 5_000;
const LOG_LIMIT = 200;

function storage(): GmStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label: string, run: () => void, hint?: string): HTMLButtonElement {
  const node = element("button", "gm-button", label);
  node.type = "button";
  if (hint) setTip(node, hint);
  node.addEventListener("click", run);
  return node;
}

function gateway(): string {
  return game.gatewayOrigin ?? defaultGatewayOrigin(window.location);
}

class GmConsole {
  readonly panel: Panel;
  readonly #history = new GmHistory(storage());
  readonly #favorites = new GmFavorites(storage());
  readonly #tabs = new Tabs();
  readonly #panes: Record<PaneId, HTMLElement>;

  // Search
  #kind: GmKind = "item";
  #showFavorites = false;
  readonly #kindStrip = element("div", "gm-kinds");
  readonly #query = element("input", "gm-query");
  readonly #count = element("input", "gm-count");
  readonly #status = element("p", "gm-status muted");
  readonly #results = element("div", "gm-results");
  readonly #more = button("Ещё", () => { void this.#search(true); });
  #rows: GmRow[] = [];
  #total = 0;
  #debounce: ReturnType<typeof setTimeout> | undefined;
  #abort: AbortController | undefined;

  // Target
  readonly #targetInfo = element("div", "gm-target-info");
  readonly #auraList = element("div", "gm-auras");
  #targetTimer: ReturnType<typeof setInterval> | undefined;
  #targetSignature = "";

  // Command line and log
  readonly #line = element("input", "gm-line");
  readonly #log = element("div", "gm-log");
  #historyCursor = -1;
  #lastSentAt = Number.NEGATIVE_INFINITY;
  #watchedWorld: WorldClient | undefined;
  #unwatch: (() => void) | undefined;

  constructor() {
    this.panel = new Panel({
      id: "gm-console", title: "GM-консоль", className: "gm-console-window",
      onClose: () => this.#stopTarget(),
    });
    this.#panes = { search: this.#buildSearch(), target: this.#buildTarget(), quick: this.#buildQuick() };
    this.#tabs.set([
      { id: "search", title: "Поиск" },
      { id: "target", title: "Цель" },
      { id: "quick", title: "Быстрые" },
    ], "search");
    this.#tabs.onSelect = (id) => this.#showPane(id as PaneId);
    const commandRow = element("div", "gm-command-row");
    this.#line.type = "text";
    this.#line.placeholder = ".команда — Enter отправить, ↑/↓ история";
    this.#line.setAttribute("aria-label", "GM-команда");
    this.#line.addEventListener("keydown", (event) => this.#lineKey(event));
    commandRow.append(this.#line, button("Отправить", () => this.#sendLine()));
    this.#log.setAttribute("aria-live", "polite");
    this.panel.body.append(this.#tabs.root, this.#panes.search, this.#panes.target, this.#panes.quick, commandRow, this.#log);
    this.#showPane("search");
  }

  toggle(): void {
    if (this.panel.visible) {
      this.panel.hide();
      this.#stopTarget();
      return;
    }
    this.panel.show();
    this.#watchChat();
    if (this.#tabs.active === "target") this.#startTarget();
    if (this.#tabs.active === "search") this.#query.focus();
  }

  /* --- sending ------------------------------------------------------------------------------ */

  #send(action: GmAction): void {
    if (action.confirm && !window.confirm(action.confirm)) return;
    this.#sendText(action.command);
  }

  #sendText(command: string): void {
    if (!game.world) {
      this.#print("Нет соединения с миром: команда не отправлена.", "error");
      return;
    }
    this.#watchChat();
    this.#history.add(command);
    this.#historyCursor = -1;
    this.#lastSentAt = performance.now();
    this.#print(`› ${command}`, "sent");
    submitChat(command);
  }

  #sendLine(): void {
    const command = normaliseCommand(this.#line.value);
    if (!command) return;
    this.#line.value = "";
    this.#sendText(command);
  }

  #lineKey(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      this.#sendLine();
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const lines = this.#history.lines;
    if (lines.length === 0) return;
    event.preventDefault();
    if (event.key === "ArrowUp") this.#historyCursor = this.#historyCursor < 0 ? lines.length - 1 : Math.max(0, this.#historyCursor - 1);
    else this.#historyCursor = this.#historyCursor < 0 ? -1 : this.#historyCursor + 1;
    if (this.#historyCursor >= lines.length) this.#historyCursor = -1;
    this.#line.value = this.#historyCursor < 0 ? "" : lines[this.#historyCursor]!;
  }

  /** System lines while a command is fresh: the server's answer, shown under the command. */
  #watchChat(): void {
    const world = game.world;
    if (world === this.#watchedWorld) return;
    this.#unwatch?.();
    this.#watchedWorld = world;
    this.#unwatch = world?.events.on("CHAT_MESSAGE", (message: ChatMessage) => {
      if (message.type !== CHAT_MSG_SYSTEM || message.local) return;
      if (performance.now() - this.#lastSentAt > ANSWER_WINDOW_MS) return;
      this.#print(message.text.replace(/\|c[0-9a-fA-F]{8}|\|r|\|H[^|]*\|h|\|h/g, ""), "answer");
    });
  }

  #print(text: string, kind: "sent" | "answer" | "error"): void {
    const line = element("p", `gm-log-${kind}`, text);
    if (kind === "sent") {
      setTip(line, "Нажмите, чтобы вставить в строку команды");
      line.addEventListener("click", () => {
        this.#line.value = text.replace(/^› /, "");
        this.#line.focus();
      });
    }
    this.#log.append(line);
    while (this.#log.childElementCount > LOG_LIMIT) this.#log.firstElementChild?.remove();
    this.#log.scrollTop = this.#log.scrollHeight;
  }

  #showPane(id: PaneId): void {
    for (const [name, pane] of Object.entries(this.#panes)) pane.hidden = name !== id;
    if (id === "target") this.#startTarget();
    else this.#stopTarget();
  }

  /* --- search ------------------------------------------------------------------------------- */

  #buildSearch(): HTMLElement {
    const pane = element("div", "gm-pane");
    this.#drawKinds();
    this.#query.type = "search";
    this.#query.placeholder = "Название или ID";
    this.#query.setAttribute("aria-label", "Поиск");
    this.#query.addEventListener("input", () => {
      this.#showFavorites = false;
      this.#drawKinds();
      clearTimeout(this.#debounce);
      this.#debounce = setTimeout(() => { void this.#search(false); }, 200);
    });
    this.#query.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      clearTimeout(this.#debounce);
      void this.#search(false);
    });
    this.#count.type = "number";
    this.#count.min = "1";
    this.#count.max = "10000";
    this.#count.value = "1";
    setTip(this.#count, "Сколько предметов выдавать");
    this.#count.setAttribute("aria-label", "Количество");
    this.#count.addEventListener("input", () => this.#drawRows());
    const bar = element("div", "gm-search-bar");
    bar.append(this.#query, this.#count, button("★", () => {
      this.#showFavorites = !this.#showFavorites;
      this.#drawKinds();
      this.#drawRows();
    }, "Избранное этого раздела"));
    this.#more.hidden = true;
    pane.append(this.#kindStrip, bar, this.#status, this.#results, this.#more);
    this.#status.textContent = "Введите название или ID.";
    return pane;
  }

  #drawKinds(): void {
    this.#count.hidden = this.#kind !== "item";
    this.#kindStrip.replaceChildren(...GM_KINDS.map(({ kind, title }) => {
      const node = button(title, () => {
        if (this.#kind === kind) return;
        this.#kind = kind;
        this.#rows = [];
        this.#total = 0;
        this.#drawKinds();
        if (this.#showFavorites) this.#drawRows();
        else void this.#search(false);
      });
      node.classList.toggle("is-active", kind === this.#kind);
      return node;
    }), ...this.#kind === "tele" ? [button("+ Это место", () => this.#rememberPlace(), "Запомнить, где вы стоите")] : []);
  }

  async #search(more: boolean): Promise<void> {
    if (this.#showFavorites) return;
    const query = this.#query.value.trim();
    this.#abort?.abort();
    if (!query) {
      this.#rows = [];
      this.#total = 0;
      this.#status.textContent = "Введите название или ID.";
      this.#drawRows();
      return;
    }
    const abort = new AbortController();
    this.#abort = abort;
    const offset = more ? this.#rows.length : 0;
    const url = `${gateway()}/data/gm-search?kind=${this.#kind}&q=${encodeURIComponent(query)}&limit=${PAGE}&offset=${offset}`;
    this.#status.textContent = "Ищу…";
    try {
      const response = await fetch(url, { signal: abort.signal });
      if (response.status === 404) {
        this.#status.textContent = "Шлюз не знает поиска: он запущен до этой версии — перезапустите шлюз (restart-gateway.bat).";
        return;
      }
      if (!response.ok) {
        this.#status.textContent = `Шлюз ответил ${response.status}.`;
        return;
      }
      const body = await response.json() as { total: number; rows: GmRow[]; missing?: boolean };
      if (abort.signal.aborted) return;
      if (body.missing) {
        this.#rows = [];
        this.#total = 0;
        this.#status.textContent = this.#kind === "tele"
          ? "Нет data/gm-catalog.json: выполните npm run assets:gm-catalog (нужен MySQL). Свои точки — «+ Это место»."
          : "Нет data/gm-catalog.json: выполните npm run assets:gm-catalog (нужен MySQL).";
        this.#drawRows();
        return;
      }
      this.#rows = more ? [...this.#rows, ...body.rows] : body.rows;
      this.#total = body.total;
      this.#status.textContent = body.total === 0 ? "Ничего не найдено." : `Найдено: ${body.total}`;
      this.#drawRows();
    } catch (error) {
      if (abort.signal.aborted) return;
      this.#status.textContent = `Шлюз недоступен: ${(error as Error).message}`;
    }
  }

  #drawRows(): void {
    const rows = this.#showFavorites ? [...this.#favorites.list(this.#kind)] : this.#rows;
    if (this.#showFavorites) this.#status.textContent = rows.length ? `Избранное: ${rows.length}` : "В избранном пусто: отметьте строку звёздочкой.";
    this.#more.hidden = this.#showFavorites || this.#rows.length >= this.#total;
    const count = itemCount(this.#count.value);
    this.#results.replaceChildren(...rows.map((row) => this.#row(row, count)));
  }

  #row(row: GmRow, count: number): HTMLElement {
    const kind = this.#kind;
    const node = element("div", "gm-row");
    const icon = this.#icon(kind, row);
    const text = element("div", "gm-row-text");
    const name = element("span", "gm-row-name", row.name || "(без имени)");
    if (kind === "item" && row.quality !== undefined) name.style.color = GM_QUALITY_COLOURS[row.quality] ?? "";
    const id = element("span", "gm-row-id", row.id > 0 ? String(row.id) : "своя");
    setTip(id, "Нажмите, чтобы скопировать ID");
    id.addEventListener("click", () => { void navigator.clipboard?.writeText(String(row.id)).catch(() => {}); });
    const title = element("div", "gm-row-title");
    title.append(name, id);
    text.append(title);
    const detail = this.#detail(kind, row);
    if (detail) {
      const line = element("div", "gm-row-detail muted", detail);
      setTip(line, detail);
      text.append(line);
    }
    const star = button(this.#favorites.has(kind, row.id) ? "★" : "☆", () => {
      star.textContent = this.#favorites.toggle(kind, row) ? "★" : "☆";
      if (this.#showFavorites) this.#drawRows();
    }, "В избранное");
    star.classList.add("gm-star");
    const actions = element("div", "gm-row-actions");
    actions.append(...gmRowActions(kind, row, { count }).map((action) => button(action.label, () => this.#send(action), action.hint ?? action.command)));
    node.append(...icon ? [icon] : [], text, actions, star);
    return node;
  }

  #icon(kind: GmKind, row: GmRow): HTMLImageElement | undefined {
    let url: string | undefined;
    if (kind === "spell") url = spellIconUrl(row.iconId ?? 0, gateway());
    else if (kind === "item") {
      url = spellIconUrl(row.iconId ?? 0, gateway())
        ?? (row.displayId ? withGeneration(`${gateway()}/item-icon/${row.displayId}`) : undefined);
    }
    if (!url) return undefined;
    const image = element("img", "gm-icon");
    image.alt = "";
    image.addEventListener("error", () => { image.style.visibility = "hidden"; });
    setIconSource(image, url);
    return image;
  }

  #detail(kind: GmKind, row: GmRow): string {
    switch (kind) {
      case "spell": {
        const flags = [row.rank, row.passive ? "пассивное" : "", row.hidden ? "скрытое" : ""].filter(Boolean).join(", ");
        const text = row.description || row.auraDescription || "";
        return [flags, text].filter(Boolean).join(" · ");
      }
      case "creature": return [row.subname ? `<${row.subname}>` : "", row.rank ? `ранг ${row.rank}` : ""].filter(Boolean).join(" · ");
      case "quest": return `уровень ${row.level ?? "?"}${row.minLevel ? `, с ${row.minLevel}` : ""}`;
      case "tele": return `карта ${row.map} · ${Math.round(row.x ?? 0)}, ${Math.round(row.y ?? 0)}, ${Math.round(row.z ?? 0)}`;
      case "gameobject": return `тип ${row.type ?? "?"}`;
      case "item": return row.stackable && row.stackable > 1 ? `стопка ${row.stackable}` : "";
    }
  }

  #rememberPlace(): void {
    const world = game.world;
    const self = world?.state.selfGuid;
    const position = self === undefined ? undefined : world?.state.objects.get(self)?.position;
    if (!world || position === undefined || world.mapId === undefined) {
      this.#print("Позиция персонажа неизвестна.", "error");
      return;
    }
    const name = window.prompt("Название точки", `Карта ${world.mapId}: ${Math.round(position.x)}, ${Math.round(position.y)}`);
    if (!name) return;
    this.#favorites.rememberPlace(name, { map: world.mapId, x: position.x, y: position.y, z: position.z });
    this.#showFavorites = true;
    this.#drawKinds();
    this.#drawRows();
  }

  /* --- target ------------------------------------------------------------------------------- */

  #buildTarget(): HTMLElement {
    const pane = element("div", "gm-pane");
    const actions = element("div", "gm-button-grid");
    actions.append(...GM_TARGET_ACTIONS.map((action) => button(action.label, () => this.#send(action), action.hint ?? action.command)));
    pane.append(this.#targetInfo, actions, element("h4", "gm-heading", "Ауры"), this.#auraList);
    return pane;
  }

  #startTarget(): void {
    this.#targetSignature = "";
    this.#drawTarget();
    this.#targetTimer ??= setInterval(() => this.#drawTarget(), 500);
  }

  #stopTarget(): void {
    clearInterval(this.#targetTimer);
    this.#targetTimer = undefined;
  }

  #drawTarget(): void {
    if (!this.panel.visible) return;
    const world = game.world;
    const guid = world?.targetGuid ?? world?.state.selfGuid;
    const object = guid === undefined ? undefined : world?.state.objects.get(guid);
    const auras = world?.aurasFor(guid) ?? [];
    ensureSpellNames(auras.map((aura) => aura.spellId));
    const now = performance.now();
    const signature = [guid, object?.fields.size, object ? readField(object, "UNIT_FIELD_HEALTH") : undefined,
      ...auras.map((aura) => `${aura.spellId}:${aura.applications}:${Math.ceil(((aura.expiresAt ?? now) - now) / 1000)}:${game.spells.has(aura.spellId)}`)].join("|");
    if (signature === this.#targetSignature) return;
    this.#targetSignature = signature;
    if (!world || guid === undefined || !object) {
      this.#targetInfo.textContent = "Нет цели.";
      this.#auraList.replaceChildren();
      return;
    }
    const self = guid === world.state.selfGuid;
    const entry = readField(object, "OBJECT_FIELD_ENTRY");
    const level = readField(object, "UNIT_FIELD_LEVEL");
    const health = readField(object, "UNIT_FIELD_HEALTH");
    const maxHealth = readField(object, "UNIT_FIELD_MAXHEALTH");
    const position = object.position;
    const lines = [
      `${unitDisplayName(object)}${self ? " (вы — цели нет)" : ""}`,
      `GUID 0x${guid.toString(16).toUpperCase()}${entry && !self ? ` · entry ${entry}` : ""}${level ? ` · уровень ${level}` : ""}`,
      health !== undefined ? `Здоровье ${health} / ${maxHealth ?? "?"}` : "",
      position ? `Карта ${world.mapId ?? "?"} · ${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}` : "",
    ].filter(Boolean);
    this.#targetInfo.replaceChildren(...lines.map((line, index) => element("p", index === 0 ? "gm-target-name" : "muted", line)));
    if (entry && !self) {
      this.#targetInfo.append(button("Найти в существах", () => {
        this.#kind = "creature";
        this.#query.value = String(entry);
        this.#showFavorites = false;
        this.#tabs.select("search");
        this.#drawKinds();
        void this.#search(false);
      }));
    }
    this.#auraList.replaceChildren(...auras.length ? auras.map((aura) => {
      const row = element("div", "gm-row");
      const metadata = game.spells.get(aura.spellId);
      const icon = metadata ? spellIconUrl(metadata.iconId, gateway()) : undefined;
      if (icon) {
        const image = element("img", "gm-icon");
        image.alt = "";
        setIconSource(image, icon);
        row.append(image);
      }
      const remaining = aura.expiresAt === undefined ? "" : ` · ${Math.max(0, Math.ceil((aura.expiresAt - now) / 1000))} с`;
      const stacks = aura.applications > 1 ? ` ×${aura.applications}` : "";
      const text = element("div", "gm-row-text");
      const title = element("div", "gm-row-title");
      title.append(element("span", "gm-row-name", `${spellName(aura.spellId)}${stacks}`), element("span", "gm-row-id", String(aura.spellId)));
      text.append(title, element("div", "gm-row-detail muted", `слот ${aura.slot}${remaining}`));
      const actions = element("div", "gm-row-actions");
      actions.append(button("Снять", () => this.#sendText(`.unaura ${aura.spellId}`), `.unaura ${aura.spellId}`));
      row.append(text, actions);
      return row;
    }) : [element("p", "muted", "Аур нет.")]);
  }

  /* --- quick -------------------------------------------------------------------------------- */

  #buildQuick(): HTMLElement {
    const pane = element("div", "gm-pane");
    for (const group of GM_QUICK_GROUPS) {
      const grid = element("div", "gm-button-grid");
      for (const toggle of group.toggles ?? []) {
        const chip = element("span", "gm-toggle");
        setTip(chip, toggle.hint ?? `${toggle.on} / ${toggle.off}`);
        chip.append(element("span", "gm-toggle-label", toggle.label),
          button("вкл", () => this.#sendText(toggle.on), toggle.on),
          button("выкл", () => this.#sendText(toggle.off), toggle.off));
        grid.append(chip);
      }
      grid.append(...(group.actions ?? []).map((action) => button(action.label, () => this.#send(action), action.hint ?? action.command)));
      pane.append(element("h4", "gm-heading", group.title), grid);
    }
    return pane;
  }
}

let instance: GmConsole | undefined;

/** Opens the console, or closes it. Built on first use. */
export function toggleGmConsole(): void {
  instance ??= new GmConsole();
  instance.toggle();
}

export function gmConsoleOpen(): boolean {
  return instance?.panel.visible ?? false;
}
