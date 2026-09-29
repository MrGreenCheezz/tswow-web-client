import {
  CHANNEL_MEMBER_MODERATOR, CHANNEL_MEMBER_MUTED, CHANNEL_MEMBER_OWNER, CHANNEL_MEMBER_VOICED,
} from "../../world/ChannelProtocol.js";
import { game } from "../game/Context.js";
import {
  openFrameXmlFriendsChannel, toggleFrameXmlFriendsChannel,
} from "../framexml/FrameXmlFriendsController.js";
import { activeChannelTab } from "./ChatDock.js";
import { systemLine } from "./Chat.js";
import { Panel, confirmPanel } from "./Widgets.js";

/**
 * Who is in a channel, and what a moderator can do about it.
 *
 * The roster arrives on `SMSG_CHANNEL_LIST` (asked for with `CMSG_CHANNEL_LIST`) and is kept
 * per channel on the world client; joins, leaves and mode changes patch it in place. Every
 * button below has a sender since the moderation slice, and the server answers refusals in
 * chat — a greyed-out guess at the player's rights would be wrong half the time, because the
 * client is never told its own flags.
 */

let parts: { panel: Panel; title: HTMLElement; list: HTMLElement; status: HTMLElement } | undefined;
let channel: string | undefined;

function build(): { panel: Panel; title: HTMLElement; list: HTMLElement; status: HTMLElement } {
  const panel = new Panel({ id: "channel-roster", title: "Канал", className: "channel-roster" });
  const title = document.createElement("strong");
  const status = document.createElement("p");
  status.className = "muted";
  status.setAttribute("role", "status");
  const list = document.createElement("div");
  list.className = "channel-roster-list";
  panel.body.append(title, status, list);
  return { panel, title, list, status };
}

function flagText(flags: number): string {
  const marks: string[] = [];
  if (flags & CHANNEL_MEMBER_OWNER) marks.push("владелец");
  if (flags & CHANNEL_MEMBER_MODERATOR) marks.push("модератор");
  if (flags & CHANNEL_MEMBER_VOICED) marks.push("голос");
  if (flags & CHANNEL_MEMBER_MUTED) marks.push("заглушен");
  return marks.join(", ");
}

export function channelRosterOpen(): boolean {
  return parts?.panel.visible ?? false;
}

export function closeChannelRoster(): void {
  parts?.panel.hide();
  channel = undefined;
}

export function resetChannelRoster(): void {
  closeChannelRoster();
}

/**
 * Opens the roster for a channel, asking the server for a fresh list. Once the FrameXML mount
 * published stock FriendsFrame, its Chat tab is the roster (FrameXmlFriendsController.ts): it opens
 * on that channel's row, which asks the server itself, and this window stays closed.
 */
export function openChannelRoster(name: string): void {
  if (name && openFrameXmlFriendsChannel(name)) return;
  const world = game.world;
  if (!world || !name) return;
  channel = name;
  world.requestChannelList(name);
  showChannelRoster();
}

/**
 * Opens the roster for the named channel, or for the active chat tab's channel (`/roster`). The
 * stock Chat tab answers first while published, with the same toggle; this window is the fallback.
 */
export function toggleChannelRoster(name?: string): void {
  if (toggleFrameXmlFriendsChannel(name, name?.trim() ? undefined : activeChannelTab())) return;
  if (channelRosterOpen()) {
    closeChannelRoster();
    return;
  }
  const target = name?.trim() || activeChannelTab();
  if (!target) {
    systemLine("Откройте вкладку канала или укажите его: /roster Название");
    return;
  }
  openChannelRoster(target);
}

export function showChannelRoster(): void {
  const world = game.world;
  if (!world || channel === undefined) {
    closeChannelRoster();
    return;
  }
  parts ??= build();
  const { panel, title, list, status } = parts;
  const state = world.channels.get(channel);
  title.textContent = `Канал ${channel}`;
  if (!state) {
    status.textContent = "Запрашиваем список…";
    list.replaceChildren();
    panel.show();
    return;
  }
  const total = state.count > 0 ? ` · всего ${state.count}` : "";
  status.textContent = `Участников в списке: ${state.members.length}${total}`;
  const rows: HTMLElement[] = [];
  for (const member of [...state.members].sort((left, right) =>
    world.displayName(left.guid).localeCompare(world.displayName(right.guid), "ru"))) {
    const name = world.displayName(member.guid);
    // Unknown guids read as hex: ask once (the cache dedupes) and repaint when it lands.
    if (name.startsWith("0x")) world.requestName(member.guid);
    const row = document.createElement("div");
    row.className = "channel-roster-row";
    const label = document.createElement("span");
    const marks = flagText(member.flags);
    label.textContent = marks ? `${name} · ${marks}` : name;
    row.append(label);
    const actions: Array<[string, () => void, boolean?]> = [
      ["Кик", () => world.kickChannelMember(channel!, name), true],
      ["Бан", () => world.banChannelMember(channel!, name), true],
      [(member.flags & CHANNEL_MEMBER_MUTED) ? "Разглушить" : "Заглушить",
        () => (member.flags & CHANNEL_MEMBER_MUTED)
          ? world.unmuteChannelMember(channel!, name)
          : world.muteChannelMember(channel!, name)],
      [(member.flags & CHANNEL_MEMBER_MODERATOR) ? "Разжаловать" : "Модератор",
        () => (member.flags & CHANNEL_MEMBER_MODERATOR)
          ? world.unsetChannelModerator(channel!, name)
          : world.setChannelModerator(channel!, name)],
    ];
    for (const [text, run, danger] of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      if (danger) button.className = "danger";
      button.addEventListener("click", () => confirmPanel(button, {
        title: `${text}: ${name}?`,
        lines: ["Сервер проверит ваши права и ответит в чат."],
        confirm: text,
        danger,
        onConfirm: run,
      }));
      row.append(button);
    }
    rows.push(row);
  }
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Список пуст";
    rows.push(empty);
  }
  const footer = document.createElement("div");
  footer.className = "channel-roster-actions";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "Обновить";
  refresh.addEventListener("click", () => { if (channel) game.world?.requestChannelList(channel); });
  const announce = document.createElement("button");
  announce.type = "button";
  announce.textContent = "Объявления вкл/выкл";
  announce.addEventListener("click", () => { if (channel) game.world?.toggleChannelAnnounce(channel); });
  const leave = document.createElement("button");
  leave.type = "button";
  leave.textContent = "Покинуть канал";
  leave.className = "danger";
  leave.addEventListener("click", () => { if (channel) game.world?.leaveChannel(channel); });
  footer.append(refresh, announce, leave);
  rows.push(footer);
  list.replaceChildren(...rows);
  panel.show();
}
