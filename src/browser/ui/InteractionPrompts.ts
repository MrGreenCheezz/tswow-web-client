/** Native responses for server invitations. Server packets remain authoritative for BG state. */
import { game } from "../game/Context.js";
import { globalString } from "../../generated/globalStrings.js";
import { STATUS_IN_PROGRESS, STATUS_WAIT_JOIN, STATUS_WAIT_QUEUE } from "../../world/PvpProtocol.js";
import { LFG_ROLE_TANK, LFG_ROLE_HEALER, LFG_ROLE_DAMAGE } from "../../world/LfgProtocol.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { canAfford, playerAlive } from "../../world/ConfirmationProtocol.js";
import { formatMoney } from "./Format.js";
import { Panel } from "./Widgets.js";
import { frameXmlLfdPublished } from "../framexml/FrameXmlLfdController.js";
import {
  frameXmlPopupsLeftToNative, frameXmlPopupsOwnBattlefieldEntry, frameXmlPopupsPublished,
} from "../framexml/FrameXmlPopupsController.js";

let panel: Panel | undefined;
let pending = new WeakSet<object>();
let roles = 0;
let lastTick = 0;
let countdowns: Array<{ node: HTMLElement; deadline: number }> = [];
let labels: Array<{ node: HTMLElement; text: () => string }> = [];
let requestsUnchanged = (): boolean => false;
/**
 * The innkeeper's, the trainer's and the instance lock's questions as last rendered (М1,
 * world/ConfirmationProtocol.ts), with whether the stock model left each of the last two here: no
 * EnterWorld subscription repaints this panel for them, so the frame tick compares these — five
 * reads — and renders on a change, a hidden panel included.
 */
type Confirmations = readonly [object | undefined, object | undefined, boolean, object | undefined, boolean];
const NO_CONFIRMATIONS: Confirmations = [undefined, undefined, false, undefined, false];
let confirmations: Confirmations = NO_CONFIRMATIONS;

/** Whether the stock model left this question to this panel (FrameXmlPopupsController.ts). */
function leftHere(request: object | undefined): boolean {
  return frameXmlPopupsLeftToNative(request) === true;
}

function confirmationsMoved(world: WorldClient): boolean {
  return world.binderConfirm !== confirmations[0] || world.talentWipeConfirm !== confirmations[1]
    || leftHere(world.talentWipeConfirm) !== confirmations[2] || world.instanceLock !== confirmations[3]
    || leftHere(world.instanceLock) !== confirmations[4];
}

/**
 * CONFIRM_BINDER's place: the terrain's area under the player (the core binds there), else the zone —
 * not SMSG_INIT_WORLD_STATES' area, which is where the zone was entered — else «Это место».
 */
function bindPlaceName(world: WorldClient): string {
  const self = world.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  const areaId = self?.position ? game.terrain?.areaAt(world.mapId, self.position.x, self.position.y) ?? 0 : 0;
  const zoneId = world.worldStateContext?.zoneId ?? 0;
  return (areaId > 0 ? game.areas?.area(areaId)?.name : undefined)
    ?? (zoneId > 0 ? game.areas?.area(zoneId)?.name : undefined)
    ?? "Это место";
}

function killedBosses(mask: number): number {
  let count = 0;
  for (let rest = mask >>> 0; rest !== 0; rest >>>= 1) count += rest & 1;
  return count;
}

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
  confirmations = NO_CONFIRMATIONS;
}

export function showInteractionPrompts(now = performance.now()): void {
  const world = game.world;
  if (!world) return resetInteractionPrompts();
  world.expireInteractionRequests(now);
  confirmations = [world.binderConfirm, world.talentWipeConfirm, leftHere(world.talentWipeConfirm),
    world.instanceLock, leftHere(world.instanceLock)];
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
  // Stock CONFIRM_BINDER, CONFIRM_TALENT_WIPE and INSTANCE_LOCK answer these while published — except
  // a question the stock model left here (Blizzard_TalentUI not loaded for UIParent's
  // TalentFrame_LoadUI; no DungeonEncounter table for the lock's boss line), which this panel keeps.
  const binder = stockPopups ? undefined : world.binderConfirm;
  // The core ignores the innkeeper's answer from a dead player or a ghost (NPCHandler.cpp:292).
  const alive = playerAlive(world.state);
  const talentQuote = world.talentWipeConfirm;
  const talentLeftHere = leftHere(talentQuote);
  const talentWipe = stockPopups && !talentLeftHere ? undefined : talentQuote;
  // The core ignores an answer it cannot charge for without a word, so the shortfall is said here.
  const talentAffordable = !talentWipe || canAfford(world.state, talentWipe.cost);
  const lockQuestion = world.instanceLock;
  const lockLeftHere = leftHere(lockQuestion);
  const lock = stockPopups && !lockLeftHere ? undefined : lockQuestion;
  requestsUnchanged = () => game.world === world && frameXmlPopupsPublished() === stockPopups
    && frameXmlPopupsOwnBattlefieldEntry() === stockEntry
    && (stockPopups || world.binderConfirm === binder) && (!binder || playerAlive(world.state) === alive)
    && world.talentWipeConfirm === talentQuote && leftHere(talentQuote) === talentLeftHere
    && world.instanceLock === lockQuestion && leftHere(lockQuestion) === lockLeftHere
    && (!talentWipe || canAfford(world.state, talentWipe.cost) === talentAffordable)
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
  if (!summon && !binder && !talentWipe && !lock && !shared && queues.length === 0 && !check && !boot && !proposal && !reward
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
  if (binder) {
    // Stock CONFIRM_BINDER's own sentence (GlobalStrings CONFIRM_BINDER).
    const row = section(() => `${bindPlaceName(world)} станет вашим новым домом. Согласны?`);
    if (!alive) {
      const reason = document.createElement("p");
      reason.textContent = "Сделать это место домом можно после воскрешения.";
      row.append(reason);
    }
    button(row, "Сделать домом", binder, () => world.binderConfirm === binder, () => { world.confirmBinder(); }, !alive);
    button(row, "Не менять дом", binder, () => world.binderConfirm === binder, () => world.declineBinder());
  }
  if (talentWipe) {
    const notEnoughMoney = globalString("ERR_NOT_ENOUGH_MONEY") ?? "У вас недостаточно денег.";
    const row = section(`Отказаться от всех талантов? Стоимость: ${formatMoney(talentWipe.cost)}.`);
    if (!talentAffordable) {
      const short = document.createElement("p");
      short.textContent = notEnoughMoney;
      row.append(short);
    }
    button(row, "Сбросить таланты", talentWipe, () => world.talentWipeConfirm === talentWipe, () => {
      // The money can go between this repaint and the click: the refusal is said, not swallowed.
      if (world.answerTalentWipe(true) === "unaffordable") world.onSpellStatus?.(notEnoughMoney, true);
    }, !talentAffordable);
    button(row, "Не сбрасывать", talentWipe, () => world.talentWipeConfirm === talentWipe,
      () => { world.answerTalentWipe(false); });
  }
  if (lock) {
    const name = game.areas?.map(lock.mapId)?.name ?? "подземелье";
    const row = section(`Вы вошли в подземелье, в котором уже шли сражения. «${name}» сохранится за вами, когда время выйдет.`);
    const killed = killedBosses(lock.encounterMask);
    if (killed > 0) {
      const bosses = document.createElement("p");
      bosses.textContent = `Убито боссов: ${killed}`;
      row.append(bosses);
    }
    countdown(row, lock.expiresAt);
    button(row, "Принять сохранение", lock, () => world.instanceLock === lock, () => { world.respondInstanceLock(true); });
    button(row, "Выйти из подземелья", lock, () => world.instanceLock === lock, () => { world.respondInstanceLock(false); });
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
  const world = game.world;
  if (world) {
    // The M1 questions end on the world's own terms — out of the NPC's reach, the server's deadline
    // — which also closes the stock dialogs (CheckBinderDist, CheckTalentMasterDist, the lock's own
    // clock): checked each frame only while one is pending, repainted the moment one moves.
    if (world.binderConfirm || world.talentWipeConfirm || world.instanceLock) world.expireInteractionRequests(now);
    if (confirmationsMoved(world)) {
      showInteractionPrompts(now);
      return;
    }
  }
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
