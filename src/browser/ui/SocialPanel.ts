/**
 * Friends, ignore and `/who`.
 *
 * All three have been on the wire and unreachable: seven senders with no caller and three state
 * fields nothing read. The client could not add a friend, could not see who was online, and could
 * not search the realm.
 *
 * Notes on the two halves that are not symmetric. A friend is removed by guid and added by name,
 * because that is what the two opcodes take. And a `/who` row has no guid at all, so every action
 * on one — invite, whisper, look up — goes by the name in the row.
 */

import { SOCIAL_FLAG_ALL } from "../../world/ContactProtocol.js";
import { game } from "../game/Context.js";
import { systemLine } from "./Chat.js";
import {
  contactStatusText, friendRows, ignoreRows, whoRequestFromForm, whoRows, whoSummary,
} from "./ContactsModel.js";
import { Panel, Tabs, confirmPanel, showMenu, type MenuItem } from "./Widgets.js";

const TABS = [
  { id: "friends", title: "Друзья" },
  { id: "ignore", title: "Игнор" },
  { id: "who", title: "Кто" },
];

interface Parts {
  panel: Panel;
  tabs: Tabs;
  form: HTMLElement;
  list: HTMLElement;
  status: HTMLElement;
}

let parts: Parts | undefined;

function build(): Parts {
  const panel = new Panel({ id: "social-window", title: "Социальное", className: "social-window" });
  const tabs = new Tabs();
  tabs.set(TABS, "friends");
  const form = document.createElement("div");
  form.className = "social-form";
  const status = document.createElement("p");
  status.className = "muted";
  status.setAttribute("role", "status");
  const list = document.createElement("div");
  list.className = "social-list";
  panel.body.append(tabs.root, form, status, list);
  tabs.onSelect = () => showSocialPanel();
  return { panel, tabs, form, list, status };
}

export function socialPanelOpen(): boolean {
  return parts?.panel.visible ?? false;
}

export function closeSocialPanel(): void {
  parts?.panel.hide();
}

export function resetSocialPanel(): void {
  parts?.panel.hide();
}

/** Opens the panel on a named tab, for the slash commands that name one. */
export function openSocialPanel(tab: string): void {
  parts ??= build();
  if (!parts.panel.visible) {
    game.world?.requestContacts(SOCIAL_FLAG_ALL);
    parts.panel.show();
  }
  parts.tabs.select(tab);
  showSocialPanel();
}

export function toggleSocialPanel(): void {
  parts ??= build();
  if (parts.panel.visible) {
    parts.panel.hide();
    return;
  }
  // The list is not pushed: it arrives once, when asked for.
  game.world?.requestContacts(SOCIAL_FLAG_ALL);
  parts.panel.show();
  showSocialPanel();
}

function textInput(placeholder: string, width = "120px"): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.style.width = width;
  return input;
}

function emptyLine(text: string): HTMLElement {
  const line = document.createElement("p");
  line.className = "muted";
  line.textContent = text;
  return line;
}

export function showSocialPanel(): void {
  const world = game.world;
  if (!parts?.panel.visible) return;
  const { tabs, form, list, status } = parts;
  if (!world) {
    list.replaceChildren(emptyLine("Нет соединения"));
    return;
  }
  if (tabs.active === "who") drawWho();
  else if (tabs.active === "ignore") drawIgnore();
  else drawFriends();

  function drawFriends(): void {
    form.replaceChildren();
    const name = textInput("Имя");
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Добавить в друзья";
    add.addEventListener("click", () => {
      if (!name.value.trim()) return;
      world!.addFriend(name.value.trim());
      name.value = "";
    });
    form.append(name, add);

    const rows = friendRows(world!.contacts);
    status.textContent = rows.length === 0
      ? (world!.contacts ? "Список друзей пуст" : "Запрашиваем список…")
      : `Друзей: ${rows.length}`;
    list.replaceChildren(...rows.map((contact) => {
      const row = document.createElement("div");
      row.className = "social-row";
      const who = document.createElement("strong");
      who.textContent = world!.displayName(contact.guid);
      const meta = document.createElement("span");
      meta.className = "social-meta";
      const parts2 = [contactStatusText(contact.status)];
      if (contact.level > 0) parts2.push(`ур. ${contact.level}`);
      if (contact.note) parts2.push(`«${contact.note}»`);
      meta.textContent = parts2.join(" · ");
      row.append(who, meta);
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const name2 = world!.displayName(contact.guid);
        const items: MenuItem[] = [
          { label: "Написать", run: () => systemLine(`Использование: /w ${name2} текст`) },
          { label: "Пригласить в группу", run: () => world!.inviteToGroup(name2) },
          { label: "Подробнее", run: () => world!.requestWhois(name2) },
          {
            label: "Удалить из друзей",
            danger: true,
            run: () => confirmPanel(row, {
              title: `Удалить ${name2} из друзей?`,
              confirm: "Удалить",
              danger: true,
              onConfirm: () => world!.removeFriend(contact.guid),
            }),
          },
        ];
        showMenu(row, name2, items);
      });
      return row;
    }));
    if (rows.length === 0) list.replaceChildren(emptyLine(world!.contacts ? "Никого нет" : "Загружается…"));
  }

  function drawIgnore(): void {
    form.replaceChildren();
    const name = textInput("Имя");
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "В игнор";
    add.addEventListener("click", () => {
      if (!name.value.trim()) return;
      world!.addIgnore(name.value.trim());
      name.value = "";
    });
    form.append(name, add);

    const rows = ignoreRows(world!.contacts);
    status.textContent = `В игноре: ${rows.length}`;
    list.replaceChildren(...(rows.length > 0 ? rows.map((contact) => {
      const row = document.createElement("div");
      row.className = "social-row";
      const who = document.createElement("strong");
      who.textContent = world!.displayName(contact.guid);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Убрать";
      remove.addEventListener("click", () => world!.removeIgnore(contact.guid));
      row.append(who, remove);
      return row;
    }) : [emptyLine("Список пуст")]));
  }

  function drawWho(): void {
    form.replaceChildren();
    const name = textInput("Имя");
    const guild = textInput("Гильдия");
    const min = textInput("1", "48px");
    const max = textInput("80", "48px");
    const search = document.createElement("button");
    search.type = "button";
    search.textContent = "Искать";
    search.addEventListener("click", () => {
      const built = whoRequestFromForm({
        name: name.value.trim() || undefined,
        guild: guild.value.trim() || undefined,
        levelMin: Number(min.value) || 1,
        levelMax: Number(max.value) || 80,
      });
      if (built.error) {
        status.className = "error";
        status.textContent = built.error;
        return;
      }
      status.className = "muted";
      if (built.request) world!.requestWho(built.request);
    });
    form.append(name, guild, min, max, search);

    status.textContent = whoSummary(world!.whoResult);
    const rows = whoRows(world!.whoResult);
    list.replaceChildren(...(rows.length > 0 ? rows.map((entry) => {
      const row = document.createElement("div");
      row.className = "social-row";
      const who = document.createElement("strong");
      who.textContent = entry.name;
      const meta = document.createElement("span");
      meta.className = "social-meta";
      const zone = game.areas?.area(entry.zoneId)?.name;
      meta.textContent = [`ур. ${entry.level}`, entry.guild ? `«${entry.guild}»` : "", zone ?? ""]
        .filter(Boolean).join(" · ");
      row.append(who, meta);
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        // A who row has no guid, so everything offered here is by name.
        showMenu(row, entry.name, [
          { label: "Написать", run: () => systemLine(`Использование: /w ${entry.name} текст`) },
          { label: "Пригласить в группу", run: () => world!.inviteToGroup(entry.name) },
          { label: "В друзья", run: () => world!.addFriend(entry.name) },
          { label: "Подробнее", run: () => world!.requestWhois(entry.name) },
        ]);
      });
      return row;
    }) : [emptyLine(whoSummary(world!.whoResult))]));
  }
}
