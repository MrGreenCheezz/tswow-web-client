/**
 * The raid's ready check: the prompt, the answers, and the timer nobody else keeps.
 *
 * The packets have been handled since slice P5 and had no reader at all. Two things about this one
 * are the client's own responsibility and are easy to get wrong. There is no timeout anywhere —
 * `startedAt` was written into the state and never read, and the server sends nothing when a check
 * goes unanswered — so the prompt runs its own clock. And `Group::OfflineReadyCheck` answers for
 * every absent member the moment the check starts, so the answer list is usually already partly
 * full before the prompt is drawn: it is painted from the state, never accumulated from events.
 */

import { game } from "../game/Context.js";
import { MEMBER_FLAG_ASSISTANT } from "../../world/GroupProtocol.js";
import { Panel } from "./Widgets.js";

/** How long the prompt waits before it gives up. The original client uses the same figure. */
export const READY_CHECK_TIMEOUT_MS = 35_000;

interface Parts {
  panel: Panel;
  status: HTMLElement;
  answers: HTMLElement;
  actions: HTMLElement;
}

let parts: Parts | undefined;
let shownFor: bigint | undefined;

function build(): Parts {
  const panel = new Panel({ id: "ready-check-window", title: "Проверка готовности", className: "ready-check" });
  const status = document.createElement("p");
  status.className = "muted";
  status.setAttribute("role", "status");
  const answers = document.createElement("div");
  answers.className = "ready-check-answers";
  const actions = document.createElement("div");
  actions.className = "ready-check-actions";
  panel.body.append(status, actions, answers);
  return { panel, status, answers, actions };
}

export function readyCheckOpen(): boolean {
  return parts?.panel.visible ?? false;
}

export function closeReadyCheck(): void {
  parts?.panel.hide();
  shownFor = undefined;
}

export function resetReadyCheck(): void {
  closeReadyCheck();
}

/** Whether this character may start one: the leader and the assistants, as the server checks. */
function mayStart(): boolean {
  const group = game.world?.group;
  if (!group) return false;
  const selfGuid = game.world?.state.selfGuid;
  return group.leaderGuid === selfGuid || (group.ownFlags & MEMBER_FLAG_ASSISTANT) !== 0;
}

export function startReadyCheck(): void {
  game.world?.startReadyCheck();
}

/**
 * Draws the prompt from the current state.
 *
 * Called on every `READY_CHECK` event and once a second while it is up. `initiatorGuid` coming
 * back undefined means the check finished — dismiss, rather than treat it as a new check nobody
 * started.
 */
export function showReadyCheck(): void {
  const world = game.world;
  const check = world?.readyCheck;
  if (!world || !check) {
    closeReadyCheck();
    return;
  }
  parts ??= build();
  const { panel, status, answers, actions } = parts;

  const elapsed = Date.now() - check.startedAt;
  if (elapsed > READY_CHECK_TIMEOUT_MS) {
    closeReadyCheck();
    return;
  }
  if (shownFor !== check.initiatorGuid) {
    shownFor = check.initiatorGuid;
    panel.show();
  }

  const seconds = Math.max(0, Math.ceil((READY_CHECK_TIMEOUT_MS - elapsed) / 1000));
  panel.title = `Проверка готовности · ${seconds} с`;
  status.textContent = `${world.displayName(check.initiatorGuid)} спрашивает, все ли готовы.`;

  const own = world.state.selfGuid;
  const answered = own !== undefined && check.answers.has(own);
  actions.replaceChildren();
  if (!answered) {
    const ready = document.createElement("button");
    ready.type = "button";
    ready.textContent = "Готов";
    ready.addEventListener("click", () => {
      world.answerReadyCheck(true);
      showReadyCheck();
    });
    const notReady = document.createElement("button");
    notReady.type = "button";
    notReady.className = "danger";
    notReady.textContent = "Не готов";
    notReady.addEventListener("click", () => {
      world.answerReadyCheck(false);
      showReadyCheck();
    });
    actions.append(ready, notReady);
  }
  if (check.initiatorGuid === own || mayStart()) {
    const finish = document.createElement("button");
    finish.type = "button";
    finish.textContent = "Завершить";
    finish.addEventListener("click", () => {
      world.finishReadyCheck();
      closeReadyCheck();
    });
    actions.append(finish);
  }

  // Everyone in the group, whether or not they have answered: a check is read by who is missing
  // from it, and a list of only the answers hides exactly that.
  const members = [...(world.group?.members ?? [])];
  const rows = members.map((member) => {
    const row = document.createElement("div");
    row.className = "ready-check-row";
    const name = document.createElement("span");
    name.textContent = member.name;
    const mark = document.createElement("span");
    const answer = check.answers.get(member.guid);
    mark.className = answer === undefined ? "muted" : answer ? "ready-yes" : "ready-no";
    mark.textContent = answer === undefined ? "ждём" : answer ? "готов" : "не готов";
    row.append(name, mark);
    return row;
  });
  answers.replaceChildren(...rows);
}

/** The prompt counts down on its own, so the frame loop nudges it once a second. */
let lastTick = 0;
export function updateReadyCheck(now: number): void {
  if (!readyCheckOpen() || now - lastTick < 1000) return;
  lastTick = now;
  showReadyCheck();
}
