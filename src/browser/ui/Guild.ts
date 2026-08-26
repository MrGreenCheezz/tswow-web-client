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
import { systemLine } from "./Chat.js";
import {
  guildInviteText, guildInviteWindow, guildMessage, guildMotd, guildRoster, guildTitle, guildWindow,
} from "./Dom.js";
import {
  GUILD_RIGHT_LABELS, eventLogLines, hasGuildRight, lastSeenText, rankLabel, rankRows, sortRoster,
} from "./GuildModel.js";
import { Tabs, confirmPanel, showMenu, type MenuItem } from "./Widgets.js";
import { className } from "./UnitSnapshot.js";

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

/** Opening it deliberately clears the flag and asks for what the window shows. */
export function openGuildWindow(): void {
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
  guildInviteWindow.hidden = !invite;
  if (invite) guildInviteText.textContent = `${invite.inviterName} приглашает вас в гильдию «${invite.guildName}».`;

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
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Ранги ещё не пришли";
    guildRoster.replaceChildren(empty);
    return;
  }
  guildRoster.replaceChildren(...rows.map((row) => {
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
    box.append(name, rights, gold);
    return box;
  }));
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
