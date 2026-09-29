/** Native responses for server invitations. Server packets remain authoritative for BG state. */
import { game } from "../game/Context.js";
import { STATUS_IN_PROGRESS, STATUS_WAIT_JOIN, STATUS_WAIT_QUEUE } from "../../world/PvpProtocol.js";
import { LFG_ROLE_TANK, LFG_ROLE_HEALER, LFG_ROLE_DAMAGE } from "../../world/LfgProtocol.js";
import { Panel } from "./Widgets.js";
import { frameXmlLfdPublished } from "../framexml/FrameXmlLfdController.js";
import { frameXmlPopupsOwnBattlefieldEntry, frameXmlPopupsPublished } from "../framexml/FrameXmlPopupsController.js";

let panel: Panel | undefined;
let pending = new WeakSet<object>();
let roles = 0;
let lastTick = 0;
let countdowns: Array<{ node: HTMLElement; deadline: number }> = [];
let labels: Array<{ node: HTMLElement; text: () => string }> = [];
let requestsUnchanged = (): boolean => false;

/** `M:SS` for queue waits and battle clocks. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * One queue row's live line, from a packet snapshot rebased to the local clock.
 *
 * `waitBase`/`playBase` are `renderedAt - snapshotMs`: the packet says how long had passed when
 * the server wrote it, and the label keeps counting from there on the one-second tick.
 */
export function battlefieldQueueStatus(
  queued: { status: number; timeInQueue: number; averageWaitTime: number; elapsedTime: number; inviteSecondsLeft: number },
  bases: { waitBase: number; playBase: number },
  now: number,
  serverWait: boolean,
): string {
  if (serverWait) return "ожидание ответа сервера";
  if (queued.status === STATUS_IN_PROGRESS) return `бой идёт ${formatDuration(now - bases.playBase)}`;
  if (queued.status === STATUS_WAIT_JOIN) {
    return queued.inviteSecondsLeft > 0 ? "приглашение" : "приглашение истекло";
  }
  const average = queued.averageWaitTime > 0 ? ` · среднее ${formatDuration(queued.averageWaitTime)}` : "";
  return `в очереди ${formatDuration(now - bases.waitBase)}${average}`;
}

export function resetInteractionPrompts(): void {
  panel?.hide();
  pending = new WeakSet();
  roles = 0;
  lastTick = 0;
  countdowns = [];
  labels = [];
  requestsUnchanged = () => false;
}

export function showInteractionPrompts(now = performance.now()): void {
  const world = game.world;
  if (!world) return resetInteractionPrompts();
  world.expireInteractionRequests(now);
  // Stock CONFIRM_SUMMON and CONFIRM_BATTLEFIELD_ENTRY (the invitation to enter, STATUS_WAIT_JOIN)
  // answer these while the stock popup owner is published; queue and match rows stay native. The
  // entry only when the gate also verified BattlefieldFrame, the frame that shows that dialog.
  const stockPopups = frameXmlPopupsPublished();
  const stockEntry = frameXmlPopupsOwnBattlefieldEntry();
  const summon = stockPopups ? undefined : world.summonRequest;
  const summonBlocked = summon ? world.summonBlockReason() : undefined;
  const shared = world.sharedQuest;
  const allQueues = [...world.battlefieldQueues.values()];
  const queues = stockEntry ? allQueues.filter((queued) => queued.status !== STATUS_WAIT_JOIN) : allQueues;
  // Stock LFDDungeonReadyPopup, LFDRoleCheckPopup and the VOTE_BOOT_PLAYER/LFG_OFFER_CONTINUE
  // StaticPopups answer these four while the stock finder is published; two prompts for one server
  // question would let the player answer twice. The reward keeps its native line (no stock owner).
  const stockLfg = frameXmlLfdPublished();
  const roleCheck = world.lfgRoleCheck;
  const check = !stockLfg && roleCheck?.state === 2 ? roleCheck : undefined;
  const boot = stockLfg ? undefined : world.lfgBoot;
  const proposal = stockLfg ? undefined : world.lfgProposal;
  const reward = world.lfgReward;
  const offerContinue = stockLfg ? undefined : world.lfgOfferContinue;
  const outdoorQueue = world.battlefieldQueueInvite;
  const outdoorWar = world.battlefieldWarInvite;
  const outdoorQueuedId = world.battlefieldQueuedId;
  const outdoorBattleId = world.battlefieldBattleId;
  requestsUnchanged = () => game.world === world && frameXmlPopupsPublished() === stockPopups
    && frameXmlPopupsOwnBattlefieldEntry() === stockEntry
    && (stockPopups || world.summonRequest === summon) && world.sharedQuest === shared
    && (!summon || world.summonBlockReason() === summonBlocked)
    && frameXmlLfdPublished() === stockLfg
    && world.lfgRoleCheck === roleCheck && (stockLfg || world.lfgBoot === boot)
    && (stockLfg || world.lfgProposal === proposal) && world.lfgReward === reward
    && (stockLfg || world.lfgOfferContinue === offerContinue)
    && world.battlefieldQueueInvite === outdoorQueue && world.battlefieldWarInvite === outdoorWar
    && world.battlefieldQueuedId === outdoorQueuedId && world.battlefieldBattleId === outdoorBattleId
    && world.battlefieldQueues.size === allQueues.length
    && allQueues.every((queued) => world.battlefieldQueues.get(queued.queueSlot) === queued);
  countdowns = [];
  labels = [];
  if (!summon && !shared && queues.length === 0 && !check && !boot && !proposal && !reward
    && offerContinue === undefined
    && !outdoorQueue && !outdoorWar && !outdoorQueuedId && !outdoorBattleId) {
    panel?.hide();
    return;
  }
  panel ??= new Panel({ id: "interaction-prompts", title: "Приглашения и очередь", closeButton: false });
  const rows: HTMLElement[] = [];
  const section = (title: string | (() => string)): HTMLElement => {
    const row = document.createElement("div");
    const text = document.createElement("p");
    text.textContent = typeof title === "string" ? title : title();
    if (typeof title === "function") labels.push({ node: text, text: title });
    row.append(text);
    rows.push(row);
    return row;
  };
  const button = (row: HTMLElement, label: string, state: object, current: () => boolean,
    run: () => void, disabled = false, wait = false): HTMLButtonElement => {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = label;
    node.disabled = disabled || pending.has(state);
    node.addEventListener("click", () => {
      if (game.world !== world || !current() || node.disabled || pending.has(state)) return;
      if (wait) pending.add(state);
      run();
      showInteractionPrompts();
    });
    row.append(node);
    return node;
  };
  const seconds = (deadline: number): number => Math.max(0, Math.ceil((deadline - now) / 1000));
  const countdown = (row: HTMLElement, deadline: number): void => {
    if (deadline <= now) return;
    const node = document.createElement("p");
    node.className = "muted";
    node.textContent = `Осталось ${seconds(deadline)} с`;
    row.append(node);
    countdowns.push({ node, deadline });
  };

  if (summon) {
    const zone = game.areas?.area(summon.zoneId)?.name ?? `зону ${summon.zoneId}`;
    const row = section(() => `${world.displayName(summon.summoner)} призывает вас в ${zone}.`);
    countdown(row, world.summonExpiresAt);
    if (summonBlocked) {
      const reason = document.createElement("p");
      reason.textContent = summonBlocked === "combat" ? "Призыв можно принять после выхода из боя." : "Призыв можно принять после воскрешения.";
      row.append(reason);
    }
    button(row, "Принять призыв", summon, () => world.summonRequest === summon,
      () => world.answerSummon(true), summonBlocked !== undefined);
    button(row, "Отклонить призыв", summon, () => world.summonRequest === summon, () => world.answerSummon(false));
  }
  if (shared) {
    const row = section(() => `${world.displayName(shared.initiatorGuid)} предлагает задание «${shared.title}».`);
    button(row, "Принять задание", shared, () => world.sharedQuest === shared, () => world.answerSharedQuest(true));
    button(row, "Отклонить задание", shared, () => world.sharedQuest === shared, () => world.answerSharedQuest(false));
  }
  for (const queued of queues) {
    const current = (): boolean => world.battlefieldQueues.get(queued.queueSlot) === queued;
    const prefix = queued.isArena ? `Арена ${queued.arenaType}×${queued.arenaType}` : `Поле боя ${queued.bgTypeId}`;
    // Packet snapshots rebased to the local clock at render: the tick below refreshes the label
    // without rebuilding the row, so the wait and the battle clocks keep running on screen.
    const bases = { waitBase: now - queued.timeInQueue, playBase: now - queued.elapsedTime };
    const inviteSecondsLeft = (): number =>
      seconds(world.battlefieldInviteDeadlines.get(queued.queueSlot) ?? 0);
    const liveStatus = (): string => battlefieldQueueStatus(
      { ...queued, inviteSecondsLeft: inviteSecondsLeft() }, bases, performance.now(), pending.has(queued),
    );
    const remaining = seconds(world.battlefieldInviteDeadlines.get(queued.queueSlot) ?? 0);
    const row = section(() => `${prefix} · ${liveStatus()}`);
    if (queued.status === STATUS_WAIT_JOIN) countdown(row, world.battlefieldInviteDeadlines.get(queued.queueSlot) ?? 0);
    if (queued.status === STATUS_WAIT_JOIN) {
      button(row, "Войти в бой", queued, current, () => world.portToBattleground(queued.queueSlot, true), remaining === 0, true);
    }
    if (queued.status === STATUS_WAIT_JOIN || queued.status === STATUS_WAIT_QUEUE) {
      button(row, "Покинуть очередь", queued, current, () => world.portToBattleground(queued.queueSlot, false), false, true);
    }
    if (queued.status === STATUS_IN_PROGRESS) {
      button(row, "Покинуть поле боя", queued, current, () => world.leaveBattleground(), false, true);
    }
    if (pending.has(queued)) {
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.textContent = "Обновить состояние";
      refresh.addEventListener("click", () => { if (game.world === world && current()) world.requestBattlefieldStatus(); });
      row.append(refresh);
    }
  }
  if (outdoorQueue) {
    const row = section("Приглашение в очередь на битву в открытом мире.");
    const current = (): boolean => world.battlefieldQueueInvite === outdoorQueue;
    button(row, "Встать в очередь на битву", outdoorQueue, current,
      () => world.answerBattlefieldQueueInvite(outdoorQueue.battleId, true));
    button(row, "Отклонить очередь на битву", outdoorQueue, current,
      () => world.answerBattlefieldQueueInvite(outdoorQueue.battleId, false));
  }
  if (outdoorWar) {
    const zone = game.areas?.area(outdoorWar.zoneId)?.name ?? "Битва в открытом мире";
    const row = section(`${zone}: битва начинается. При отказе сервер может вывести вас из зоны.`);
    const serverTime = world.currentServerTime(now);
    if (serverTime !== undefined) countdown(row, now + (outdoorWar.expiresAt - serverTime) * 1000);
    else {
      const note = document.createElement("p");
      note.textContent = "Уточнение времени приглашения…";
      row.append(note);
    }
    const current = (): boolean => world.battlefieldWarInvite === outdoorWar;
    button(row, "Вступить в битву", outdoorWar, current,
      () => world.answerBattlefieldWarInvite(outdoorWar.battleId, true), serverTime === undefined);
    button(row, "Отклонить битву", outdoorWar, current,
      () => world.answerBattlefieldWarInvite(outdoorWar.battleId, false));
  }
  if (outdoorQueuedId) {
    const row = section("Вы в очереди на битву в открытом мире.");
    button(row, "Выйти из очереди на битву", world, () => world.battlefieldQueuedId === outdoorQueuedId,
      () => world.leaveBattlefieldQueue(outdoorQueuedId));
  }
  if (outdoorBattleId) {
    const row = section("Вы участвуете в битве в открытом мире. Выход переместит вас из зоны битвы.");
    button(row, "Покинуть зону битвы", world, () => world.battlefieldBattleId === outdoorBattleId,
      () => world.leaveBattlefield());
  }
  if (check) {
    const own = check.members.find((member) => member.guid === world.state.selfGuid);
    const row = section(own?.ready ? "Ваша роль подтверждена. Ждём остальных." : "Подтвердите роль для поиска подземелья.");
    // Who already picked: `SMSG_LFG_ROLE_CHOSEN` arrives per member while the check runs. A
    // live label rather than a rebuilt row, so the one-second tick refreshes names without
    // detaching the focused role checkbox.
    const chosen = world.lfgRolesChosen?.size ?? 0;
    if (chosen > 0) {
      section(() => `Выбрали роли (${world.lfgRolesChosen.size}): ${
        [...world.lfgRolesChosen.keys()].map((guid) => world.displayName(guid)).join(", ")}`);
      for (const guid of world.lfgRolesChosen.keys()) {
        if (world.displayName(guid).startsWith("0x")) world.requestName(guid);
      }
    }
    if (!own?.ready) {
      let confirmRole: HTMLButtonElement;
      for (const [value, label] of [[LFG_ROLE_TANK, "Танк"], [LFG_ROLE_HEALER, "Лекарь"], [LFG_ROLE_DAMAGE, "Боец"]] as const) {
        const wrapper = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = (roles & value) !== 0;
        input.disabled = pending.has(check);
        input.addEventListener("change", () => {
          if (game.world !== world || world.lfgRoleCheck !== check) return;
          roles = input.checked ? roles | value : roles & ~value;
          confirmRole.disabled = roles === 0 || pending.has(check);
        });
        wrapper.append(input, document.createTextNode(label));
        row.append(wrapper);
      }
      confirmRole = button(row, "Подтвердить роль", check, () => world.lfgRoleCheck === check,
        () => world.setLfgRoles(roles), roles === 0, true);
    }
    button(row, "Отменить поиск", check, () => world.lfgRoleCheck === check, () => world.leaveLfg());
  }
  if (boot) {
    const row = section(() => `Исключить ${world.displayName(boot.victimGuid)}? ${boot.reason} · за: ${boot.agree}/${boot.votesNeeded}${boot.voted ? " · голос отправлен" : ""}`);
    countdown(row, world.lfgBootExpiresAt);
    button(row, "За исключение", boot, () => world.lfgBoot === boot, () => world.voteToRemove(true), boot.voted);
    button(row, "Против исключения", boot, () => world.lfgBoot === boot, () => world.voteToRemove(false), boot.voted);
  }
  if (proposal) {
    const answered = proposal.players.filter((player) => player.answered).length;
    const accepted = proposal.players.filter((player) => player.accepted).length;
    const row = section(`Подземелье ${proposal.dungeonEntry}: группа готова (${accepted}/${proposal.players.length}, ответили ${answered}). Войти?`);
    button(row, "Принять вход", proposal, () => world.lfgProposal === proposal, () => world.answerLfgProposal(true));
    button(row, "Отклонить вход", proposal, () => world.lfgProposal === proposal, () => world.answerLfgProposal(false));
  }
  if (offerContinue !== undefined) {
    const row = section(`Подземелье ${offerContinue} пройдено. Продолжить с этой группой?`);
    button(row, "Остаться в группе", world, () => world.lfgOfferContinue === offerContinue,
      () => world.dismissLfgContinue());
    button(row, "Покинуть подземелье", world, () => world.lfgOfferContinue === offerContinue,
      () => world.answerLfgContinue(false));
  }
  if (reward) {
    const row = section("Награда за подземелье выдана сервером. Подробности — в окне поиска подземелий.");
    button(row, "Понятно", world, () => world.lfgReward === reward, () => world.dismissLfgReward());
  }
  panel.body.replaceChildren(...rows);
  panel.show();
}

export function updateInteractionPrompts(now: number): void {
  if (!panel?.visible || now - lastTick < 1000) return;
  lastTick = now;
  if (!requestsUnchanged() || countdowns.some(({ deadline }) => deadline <= now)) {
    showInteractionPrompts(now);
    return;
  }
  // Keep focused checkboxes/buttons in the DOM while the clock advances.
  for (const { node, deadline } of countdowns) node.textContent = `Осталось ${Math.ceil((deadline - now) / 1000)} с`;
  for (const { node, text } of labels) node.textContent = text();
}
