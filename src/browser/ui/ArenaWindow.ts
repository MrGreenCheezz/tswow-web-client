/**
 * The arena team window.
 *
 * Eleven senders and six state fields existed and nothing read any of them. Creating a team is
 * deliberately absent: `CMSG_ARENA_TEAM_CREATE` is declared `Handle_NULL` in this core, and the
 * real route — buying and offering a charter — has no builder at either end. Offering a button
 * that the server answers with silence would be worse than not offering one.
 *
 * An invitation names no team, because `SMSG_ARENA_TEAM_INVITE` carries only the inviter and the
 * team's *name*, so the prompt says what it knows rather than inventing a bracket.
 */

import { game } from "../game/Context.js";
import { arenaTeamRows, bracketName, memberLine, sortRoster, statsLine } from "./ArenaModel.js";
import { Panel, confirmPanel, showMenu, type MenuItem } from "./Widgets.js";
import { frameXmlPopupsPublished } from "../framexml/FrameXmlPopupsController.js";

interface Parts {
  panel: Panel;
  invite: HTMLElement;
  list: HTMLElement;
}

let parts: Parts | undefined;

function build(): Parts {
  const panel = new Panel({ id: "arena-window", title: "Арена", className: "arena-window" });
  const invite = document.createElement("div");
  invite.className = "arena-invite";
  invite.hidden = true;
  const list = document.createElement("div");
  list.className = "arena-teams";
  panel.body.append(invite, list);
  return { panel, invite, list };
}

export function arenaWindowOpen(): boolean {
  return parts?.panel.visible ?? false;
}

export function closeArenaWindow(): void {
  parts?.panel.hide();
}

export function resetArenaWindow(): void {
  parts?.panel.hide();
}

export function toggleArenaWindow(): void {
  parts ??= build();
  if (parts.panel.visible) {
    parts.panel.hide();
    return;
  }
  parts.panel.show();
  // Nothing pushes a roster: each team has to be asked for by id, and the ids come from the
  // team info the server volunteers on login and after a rated match.
  for (const info of game.world?.arenaTeams.values() ?? []) {
    game.world?.requestArenaTeamRoster(info.teamId);
  }
  showArenaWindow();
}

export function showArenaWindow(): void {
  const world = game.world;
  if (!parts?.panel.visible) return;
  const { invite, list } = parts;

  // The stock ARENA_TEAM_INVITE dialog asks while the popup owner is published (FrameXmlPopups.ts).
  const pending = frameXmlPopupsPublished() ? undefined : world?.arenaTeamInvite;
  invite.hidden = pending === undefined;
  if (pending) {
    invite.replaceChildren();
    const text = document.createElement("p");
    text.textContent = `${pending.playerName} зовёт вас в команду «${pending.teamName}».`;
    const accept = document.createElement("button");
    accept.type = "button";
    accept.textContent = "Принять";
    accept.addEventListener("click", () => { world?.answerArenaTeamInvite(true); showArenaWindow(); });
    const decline = document.createElement("button");
    decline.type = "button";
    decline.textContent = "Отказаться";
    decline.addEventListener("click", () => { world?.answerArenaTeamInvite(false); showArenaWindow(); });
    invite.append(text, accept, decline);
  }

  if (!world) {
    list.replaceChildren();
    return;
  }
  const rows = arenaTeamRows(world.arenaTeams, world.arenaTeamStats, world.arenaTeamRosters);
  list.replaceChildren(...rows.map((row) => {
    const box = document.createElement("section");
    box.className = "arena-team";
    const title = document.createElement("strong");
    title.textContent = row.info ? `${bracketName(row.type)} · «${row.info.name}»` : `${bracketName(row.type)} · нет команды`;
    box.append(title);
    if (!row.info) {
      const hint = document.createElement("p");
      hint.className = "muted";
      // Said plainly rather than offered as a dead button.
      hint.textContent = "Создание команды идёт через хартию у арены и в этом клиенте пока не сделано.";
      box.append(hint);
      return box;
    }
    const stats = document.createElement("span");
    stats.className = "arena-meta";
    stats.textContent = statsLine(row.stats);
    box.append(stats);

    for (const member of sortRoster(row.roster)) {
      const line = document.createElement("div");
      line.className = member.online ? "arena-member" : "arena-member offline";
      const name = document.createElement("strong");
      name.textContent = member.name;
      const meta = document.createElement("span");
      meta.className = "arena-meta";
      meta.textContent = memberLine(member);
      line.append(name, meta);
      line.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openMemberMenu(line, row.info!.teamId, member.name, member.captain);
      });
      box.append(line);
    }

    const actions = document.createElement("div");
    actions.className = "arena-actions";
    const inviteButton = document.createElement("button");
    inviteButton.type = "button";
    inviteButton.textContent = "Пригласить";
    inviteButton.addEventListener("click", () => {
      const name = window.prompt("Кого пригласить в команду?");
      if (name) world.inviteToArenaTeam(row.info!.teamId, name);
    });
    const leave = document.createElement("button");
    leave.type = "button";
    leave.className = "danger";
    leave.textContent = "Покинуть";
    leave.addEventListener("click", () => confirmPanel(leave, {
      title: `Покинуть команду «${row.info!.name}»?`,
      lines: ["Личный рейтинг в этой сетке будет потерян."],
      confirm: "Покинуть",
      danger: true,
      onConfirm: () => world.leaveArenaTeam(row.info!.teamId),
    }));
    const disband = document.createElement("button");
    disband.type = "button";
    disband.className = "danger";
    disband.textContent = "Распустить";
    disband.addEventListener("click", () => confirmPanel(disband, {
      title: `Распустить команду «${row.info!.name}»?`,
      lines: ["Это необратимо, и её рейтинг исчезнет вместе с ней."],
      confirm: "Распустить",
      danger: true,
      onConfirm: () => world.disbandArenaTeam(row.info!.teamId),
    }));
    actions.append(inviteButton, leave, disband);
    box.append(actions);
    return box;
  }));
}

function openMemberMenu(anchor: HTMLElement, teamId: number, name: string, captain: boolean): void {
  const world = game.world;
  if (!world) return;
  const items: MenuItem[] = [
    { label: "Сделать капитаном", enabled: !captain, run: () => world.promoteArenaTeamCaptain(teamId, name) },
    {
      label: "Исключить",
      danger: true,
      run: () => confirmPanel(anchor, {
        title: `Исключить ${name} из команды?`,
        confirm: "Исключить",
        danger: true,
        onConfirm: () => world.removeFromArenaTeam(teamId, name),
      }),
    },
  ];
  showMenu(anchor, name, items);
}
