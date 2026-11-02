/**
 * Where the HTML windows that still exist follow the logic that outlives them: the spell book, the
 * action rows and the craft windows register here, and the logic asks only "is there one".
 *
 * A leaf on purpose. Those windows register while they evaluate, and the logic reaches them through
 * its own imports (Notices and Settings, the macro runner's chat), so a variable in the logic's module
 * could still be in its temporal dead zone at that moment.
 */

import type { ChatMessage } from "../../world/ChatProtocol.js";

/**
 * The spell book window's half of the spell data: its list and the status line under its header,
 * which only it can see. Nothing reaches the player through it under the stock interface; a refusal
 * the player must read goes through `notice` beside the call.
 */
export interface SpellBookHost {
  redraw(): void;
  status(message: string, tone: "muted" | "error"): void;
}

/** The HTML craft windows' half of the craft queue. */
export interface ProfessionWindows {
  /** The queue moved; `force` throws away what the windows drew last, for a change their signature misses. */
  changed(force: boolean): void;
  /** The queue and its tracking are gone: every window closes. */
  closed(): void;
  /** One line's craft window. */
  open(skillId: number): boolean;
}

/**
 * The HTML chat dock's half of the chat commands. Nothing the stock chat shows comes through here: a
 * line written in a world reaches it through `WorldClient.chatLog` and the `CHAT_MESSAGE` event.
 */
export interface ChatDockHost {
  /** A line written with no world to keep it. */
  append(message: ChatMessage): void;
  /** Switches by id or by the title the player can see. False when neither names a tab. */
  selectTab(name: string): boolean;
  /** The channel the active tab shows, if it is a channel tab. */
  activeChannel(): string | undefined;
}

/** The HTML quest log and tracker's half of the quest data. */
export interface QuestLogWindows {
  /** The log's fields moved. */
  changed(): void;
  /** An objective's or a reward's name has arrived. */
  objectivesChanged(): void;
  /** A character was left: what they drew goes with it. */
  cleared(): void;
}

let spellBook: SpellBookHost | undefined;
let actionBarRedraw: (() => void) | undefined;
let craftWindows: ProfessionWindows | undefined;
let chatDock: ChatDockHost | undefined;
let questWindows: QuestLogWindows | undefined;

export function setSpellBookHost(host: SpellBookHost | undefined): void {
  spellBook = host;
}

export function spellBookHost(): SpellBookHost | undefined {
  return spellBook;
}

export function setActionBarRedraw(redraw: (() => void) | undefined): void {
  actionBarRedraw = redraw;
}

export function redrawActionBar(): void {
  actionBarRedraw?.();
}

export function setProfessionWindows(windows: ProfessionWindows | undefined): void {
  craftWindows = windows;
}

export function professionWindows(): ProfessionWindows | undefined {
  return craftWindows;
}

export function setChatDockHost(host: ChatDockHost | undefined): void {
  chatDock = host;
}

export function chatDockHost(): ChatDockHost | undefined {
  return chatDock;
}

export function setQuestLogWindows(windows: QuestLogWindows | undefined): void {
  questWindows = windows;
}

export function questLogWindows(): QuestLogWindows | undefined {
  return questWindows;
}
