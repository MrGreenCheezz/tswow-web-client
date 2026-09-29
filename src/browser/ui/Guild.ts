/**
 * The guild window: who is in it, what the ranks may do, and what has been happening.
 *
 * What was here before was a title, the message of the day and a flat list of names — the roster
 * packet's other two thirds went nowhere. The ranks were in it all along, and so were the notes,
 * the officer notes and the guild's own description. The event log was fetched by a sender with no
 * caller into a field nothing read.
 *
 * Three things about the guild packets shape this window. Rank *names* live in a different packet
 * from the ranks, and the one carrying them always writes ten whatever the guild has. A successful
 * command is answered by a result with the command discarded and the roster re-requested, so the
 * window has to be told "the player closed me" or it reopens on its own. And the event log arrives
 * through the plain callback rather than through the bus, unlike its five siblings.
 */

import { game } from "../game/Context.js";
import { frameXmlFriendsPublished, openFrameXmlFriends } from "../framexml/FrameXmlFriendsController.js";
import { systemLine } from "./Chat.js";
import {
  guildInviteText, guildInviteWindow, guildMessage, guildMotd, guildRoster, guildTitle, guildWindow,
} from "./Dom.js";
import {
  GUILD_RIGHT_LABELS, eventLogLines, hasGuildRight, lastSeenText, rankLabel, rankRows, sortRoster,
} from "./GuildModel.js";
import { Tabs, confirmPanel, showMenu, type MenuItem } from "./Widgets.js";
import { className } from "./UnitSnapshot.js";
import { frameXmlPopupsPublished } from "../framexml/FrameXmlPopupsController.js";

const TABS = [
  { id: "roster", title: "Состав" },
  { id: "ranks", title: "Ранги" },
  { id: "log", title: "Журнал" },
];

let tabs: Tabs | undefined;
let closedByPlayer = false;
let logRequested = false;

function ensureTabs(): Tabs {
  if (tabs) return tabs;
  tabs = new Tabs();
  tabs.set(TABS, "roster");
  tabs.onSelect = (id) => {
    // The log is a separate query and there is no point asking for it before it is looked at.
    if (id === "log" && !logRequested) {
      logRequested = true;
      game.world?.requestGuildEventLog();
    }
    showGuild();
  };
  guildWindow.insertBefore(tabs.root, guildRoster);
  return tabs;
}

export function guildWindowOpen(): boolean {
  return !guildWindow.hidden;
}

export function closeGuildWindow(): void {
  closedByPlayer = true;
  guildWindow.hidden = true;
}

/**
 * Opening it deliberately clears the flag and asks for what the window shows. The stock
 * FriendsFrame's Guild tab answers first once published (it asks for the roster itself, and opens
 * only in a guild, as stock does); this window is the fallback.
 */
export function openGuildWindow(): void {
  if (openFrameXmlFriends("guild")) return;
  const world = game.world;
  if (!world) return;
  closedByPlayer = false;
  world.requestGuildRoster();
  world.requestGuildInfo();
  showGuild();
}

export function resetGuildWindow(): void {
  closedByPlayer = false;
  logRequested = false;
}

export function showGuild(): void {
  const world = game.world;
  const invite = world?.guildInvite;
  // The stock GUILD_INVITE dialog asks while the popup owner is published (FrameXmlPopups.ts).
  guildInviteWindow.hidden = !invite || frameXmlPopupsPublished();
  if (invite) guildInviteText.textContent = `${invite.inviterName} приглашает вас в гильдию «${invite.guildName}».`;

  // While the stock FriendsFrame owns the guild tab, every guild packet still arrives here through
  // `onGuildChanged`; this window must not open beside the stock one. A refused command is said in
  // chat, where the client prints ERR_GUILD_*; the invitation above is not this window's.
  if (frameXmlFriendsPublished()) {
    if (world?.guildMessage) {
      if (world.guildMessage.error) systemLine(world.guildMessage.text);
      world.guildMessage = undefined;
    }
    guildWindow.hidden = true;
    return;
  }
  // The result of a command goes into the window that caused it rather than into chat, where it
  // used to be shouted at a player who might not have the guild open at all.
  if (world?.guildMessage) {
    guildMessage.textContent = world.guildMessage.text;
    guildMessage.className = world.guildMessage.error ? "error" : "success";
    world.guildMessage = undefined;
  }

  const roster = world?.guildRoster;
  if (!world || !roster || closedByPlayer) {
    guildWindow.hidden = true;
    return;
  }
  guildWindow.hidden = false;
  const strip = ensureTabs();
  const info = world.guildInfo;
  guildTitle.textContent = world.guildQuery?.name
    ? `Гильдия «${world.guildQuery.name}»${info ? ` · ${info.memberCount} чел.` : ""}`
    : "Гильдия";
  guildMotd.textContent = roster.welcomeText ? `Объявление: ${roster.welcomeText}` : "";

  if (strip.active === "ranks") drawRanks();
  else if (strip.active === "log") drawLog();
  else drawRoster();
}

function drawRoster(): void {
  const world = game.world;
  const roster = world?.guildRoster;
  if (!world || !roster) return;
  const query = world.guildQuery;
  guildRoster.replaceChildren(...sortRoster(roster.members).map((member) => {
    const row = document.createElement("div");
    row.className = member.online ? "guild-member" : "guild-member offline";
    const name = document.createElement("strong");
    name.textContent = member.name;
    const meta = document.createElement("span");
    meta.className = "guild-meta";
    const parts = [
      rankLabel(member.rankId, query),
      `ур. ${member.level} ${className(member.classId)}`.trim(),
      lastSeenText(member),
    ];
    if (member.note) parts.push(`«${member.note}»`);
    if (member.officerNote) parts.push(`оф.: «${member.officerNote}»`);
    meta.textContent = parts.join(" · ");
    row.append(name, meta);
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openMemberMenu(row, member.name, member.guid);
    });
    return row;
  }));
}

function openMemberMenu(anchor: HTMLElement, name: string, guid: bigint): void {
  const world = game.world;
  if (!world) return;
  const items: MenuItem[] = [
    { label: "Написать", run: () => systemLine(`Использование: /w ${name} текст`) },
    { label: "Пригласить в группу", run: () => world.inviteToGroup(name) },
    { label: "Повысить", run: () => world.promoteGuildMember(name) },
    { label: "Понизить", run: () => world.demoteGuildMember(name) },
    {
      label: "Заметка",
      run: () => {
        const note = window.prompt(`Заметка для ${name}:`);
        if (note !== null) world.setGuildMemberNote(name, note);
      },
    },
    {
      label: "Заметка офицера",
      run: () => {
        const note = window.prompt(`Заметка офицера для ${name}:`);
        if (note !== null) world.setGuildMemberNote(name, note, true);
      },
    },
    {
      label: "Передать гильдию",
      danger: true,
      run: () => confirmPanel(anchor, {
        title: `Сделать ${name} главой гильдии?`,
        lines: ["Вы станете обычным участником и не сможете отменить это сами."],
        confirm: "Передать",
        danger: true,
        onConfirm: () => world.setGuildLeader(name),
      }),
    },
    {
      label: "Исключить",
      danger: true,
      run: () => confirmPanel(anchor, {
        title: `Исключить ${name} из гильдии?`,
        confirm: "Исключить",
        danger: true,
        onConfirm: () => world.removeGuildMember(name),
      }),
    },
  ];
  showMenu(anchor, name, items);
}

function drawRanks(): void {
  const world = game.world;
  if (!world) return;
  const rows = rankRows(world.guildRoster, world.guildQuery);
  const boxes: HTMLElement[] = [];
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Ранги ещё не пришли";
    boxes.push(empty);
  } else {
    for (const row of rows) {
      const box = document.createElement("div");
      box.className = "guild-rank";
      const name = document.createElement("strong");
      name.textContent = `${row.rankId}. ${row.name}`;
      const rights = document.createElement("span");
      rights.className = "guild-meta";
      const granted = GUILD_RIGHT_LABELS
        .filter(([flag]) => hasGuildRight(row.rank.flags, flag))
        .map(([, label]) => label);
      rights.textContent = granted.length > 0 ? granted.join(", ") : "нет прав";
      const gold = document.createElement("span");
      gold.className = "guild-meta";
      gold.textContent = row.rank.withdrawGoldLimit < 0
        ? "снятие золота без ограничений"
        : `лимит золота: ${row.rank.withdrawGoldLimit}`;
      const rename = document.createElement("button");
      rename.type = "button";
      rename.textContent = "Переименовать";
      rename.addEventListener("click", () => {
        const next = window.prompt(`Новое имя ранга «${row.name}»:`, row.name);
        if (next !== null && next.trim()) {
          world.setGuildRank(row.rankId, row.rank.flags, next.trim(), row.rank.withdrawGoldLimit, row.rank.tabs);
        }
      });
      box.append(name, rights, gold, rename);
      boxes.push(box);
    }
  }
  // Rank + MOTD/info/disband management: senders exist in WorldClient, the server validates
  // leader rights and refuses the rest. Keep them as plain prompts/confirms, not inline editors.
  const actions = document.createElement("div");
  actions.className = "guild-rank-actions";
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "Добавить ранг";
  add.addEventListener("click", () => {
    const name = window.prompt("Имя нового ранга:");
    if (name !== null && name.trim()) world.addGuildRank(name.trim());
  });
  const removeLowest = document.createElement("button");
  removeLowest.type = "button";
  removeLowest.textContent = "Удалить низший ранг";
  removeLowest.className = "danger";
  removeLowest.addEventListener("click", () => confirmPanel(removeLowest, {
    title: "Удалить низший ранг?",
    confirm: "Удалить",
    danger: true,
    onConfirm: () => world.removeLowestGuildRank(),
  }));
  const motd = document.createElement("button");
  motd.type = "button";
  motd.textContent = "Объявление";
  motd.addEventListener("click", () => {
    const text = window.prompt("Объявление гильдии (MOTD):");
    if (text !== null) world.setGuildMotd(text);
  });
  const info = document.createElement("button");
  info.type = "button";
  info.textContent = "Инфо гильдии";
  info.addEventListener("click", () => {
    const text = window.prompt("Информация о гильдии:");
    if (text !== null) world.setGuildInfoText(text);
  });
  const disband = document.createElement("button");
  disband.type = "button";
  disband.textContent = "Распустить";
  disband.className = "danger";
  disband.addEventListener("click", () => confirmPanel(disband, {
    title: "Распустить гильдию?",
    lines: ["Это необратимо."],
    confirm: "Распустить",
    danger: true,
    onConfirm: () => world.disbandGuild(),
  }));
  actions.append(add, removeLowest, motd, info, disband);
  boxes.push(actions);
  guildRoster.replaceChildren(...boxes);
}

function drawLog(): void {
  const world = game.world;
  if (!world) return;
  const lines = eventLogLines(world.guildEventLog ?? [], (guid) => world.displayName(guid), world.guildQuery);
  if (lines.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = logRequested ? "Журнал пуст" : "Запрашиваем журнал…";
    guildRoster.replaceChildren(empty);
    return;
  }
  guildRoster.replaceChildren(...lines.map((line) => {
    const row = document.createElement("p");
    row.className = "guild-log-line";
    row.textContent = line;
    return row;
  }));
}
