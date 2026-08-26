/**
 * One place for everything the server refused.
 *
 * Over the middle of the screen, above the character's head, where the original client puts it and
 * where a player looking at a fight is already looking. Nothing else in this interface is allowed
 * to be the only home for an error: a message that can only be read inside an open window is a
 * message that is only read by accident.
 */

import { expireNotices, noticeText, pushNotice, type Notice, type NoticeKind } from "./NoticeModel.js";
import { settingOn } from "./Settings.js";
import { playUiSound } from "../game/GameSounds.js";

const notices: Notice[] = [];
let container: HTMLElement | undefined;
let dirty = false;

function root(): HTMLElement | undefined {
  if (container?.isConnected) return container;
  const viewport = document.getElementById("world-viewport");
  if (!viewport) return undefined;
  container = document.createElement("div");
  container.id = "notices";
  container.className = "notices";
  viewport.append(container);
  return container;
}

export function resetNotices(): void {
  notices.length = 0;
  container?.replaceChildren();
}

/** Says something once. Repeats collapse into a count rather than into a wall. */
export function notice(text: string, kind: NoticeKind = "error"): void {
  // A refusal the player can hear as well as read. `InterfaceError` is not in this client's table;
  // `igQuestFailed` is the flat negative tone it ships instead.
  if (kind === "error") playUiSound("questFailed");
  if (!settingOn("notices")) return;
  pushNotice(notices, text, kind, performance.now());
  dirty = true;
  drawNotices();
}

export function drawNotices(): void {
  const box = root();
  if (!box) return;
  box.replaceChildren(...notices.map((entry) => {
    const line = document.createElement("p");
    line.className = `notice notice-${entry.kind}`;
    line.setAttribute("role", "status");
    line.textContent = noticeText(entry);
    return line;
  }));
  box.hidden = notices.length === 0;
}

/** Called once a frame: each notice expires on its own clock and nothing else removes it. */
export function updateNotices(now: number): void {
  const before = notices.length;
  expireNotices(notices, now);
  if (notices.length === before && !dirty) return;
  dirty = false;
  drawNotices();
}
