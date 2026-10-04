/**
 * Plan item 3.22a: two server questions the stock UIParent asks through StaticPopup, as Wow.exe 3.3.5a
 * 12340 raises them (read 2026-10-02).
 *
 * - `INSTANCE_BOOT_START` / `INSTANCE_BOOT_STOP` (UIParent.lua:864-871 → StaticPopup INSTANCE_BOOT):
 *   the SMSG_RAID_GROUP_ONLY handler (0x6e3c10, case 0x286) reads the homebind delay and a reason; a
 *   delay of 0 with reason 1..4 also prints a system line (not modelled here: chat is out of scope),
 *   and every packet goes to 0x513ad0 — a delay above 0 stores «now + delay» and signals event 0x1be,
 *   0 clears it and signals 0x1bf. The core sends 60000/1 when the player stands in a raid instance
 *   without a raid group and 0/0 when that is mended (Player::UpdateHomebindTime, Player.cpp:22413).
 *   `GetInstanceBootTimeRemaining()` (0x5162e0) is the stored deadline less now in whole seconds,
 *   0 when none or past. The UI's own load (0x52a980) zeroes the deadline, so the model keeps it:
 *   a new FrameXML mount (a /reload) starts with none, as the client's does.
 * - `QUEST_ACCEPT_CONFIRM(name, title)` (UIParent.lua:618-626 → QUEST_ACCEPT / QUEST_ACCEPT_LOG_FULL):
 *   SMSG_QUEST_CONFIRM_ACCEPT (0x6cbc50: quest id, title, the sharer's guid) goes to 0x58bc50, which
 *   stores the quest id and signals event 0x151 with the sharer's name and the title — only when the
 *   name is already in the client's name cache (0x67d770 with no callback: an unknown name raises no
 *   event at all). `ConfirmAcceptQuest()` (0x58c910) sends CMSG_QUEST_CONFIRM_ACCEPT with the stored
 *   id; stock's «No» calls nothing. Here the stored id answers through `answerSharedQuest(true)` while
 *   the world still holds that share; once it is gone the core would drop the answer too
 *   (HandleQuestConfirmAccept needs the sharing player), so nothing is sent.
 *
 * The quest question is raised only while the stock popups own the server's questions
 * (FrameXmlPopupsController.ts). The native prompt (InteractionPrompts.ts) steps aside only for a share
 * stock was asked (`frameXmlSharedQuestAskedByStock`): one that arrived before publication, or whose
 * sharer had no cached name (Wow.exe raises nothing then), stays native so it can still be answered.
 */

import { frameXmlPopupsPublished } from "./FrameXmlPopupsController.js";

export const INSTANCE_BOOT_START = "INSTANCE_BOOT_START";
export const INSTANCE_BOOT_STOP = "INSTANCE_BOOT_STOP";
export const QUEST_ACCEPT_CONFIRM = "QUEST_ACCEPT_CONFIRM";

/** The world's share objects stock QUEST_ACCEPT_CONFIRM was raised for; a new packet is a new object. */
const askedByStock = new WeakSet<object>();

/** Whether stock was asked this share, so the native prompt need not ask it too (InteractionPrompts.ts). */
export function frameXmlSharedQuestAskedByStock(quest: object | undefined): boolean {
  return quest !== undefined && askedByStock.has(quest);
}

interface SharedQuest {
  readonly questId: number;
  readonly title: string;
  readonly initiatorGuid: bigint;
}

/** The world facts the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlServerPromptsWorld {
  readonly events?: {
    on(name: "INSTANCE_BOOT", listener: (payload: { milliseconds: number }) => void): () => void;
    on(name: "QUEST_SHARED", listener: (payload: { quest: SharedQuest | undefined }) => void): () => void;
  } | undefined;
  readonly sharedQuest?: SharedQuest | undefined;
  /** The name cache only: undefined while the name is not known. */
  readonly names?: { get(guid: bigint): string | undefined } | undefined;
  answerSharedQuest?(accept: boolean): void;
}

export interface FrameXmlServerPromptsContext {
  world(): FrameXmlServerPromptsWorld | undefined;
  /** Monotonic milliseconds (`performance.now`). */
  monotonic(): number;
  /** Whether the stock popups own the server's questions; defaults to FrameXmlPopupsController's edge. */
  popupsOwned?(): boolean;
}

export interface FrameXmlServerPromptsPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

export class FrameXmlServerPromptsModel {
  readonly #context: FrameXmlServerPromptsContext;
  #pump: FrameXmlServerPromptsPump | undefined;
  #unsubscribe: (() => void)[] = [];
  /** DAT_00c0d6a8: the last shared quest's id, kept until the next share. */
  #questId = 0;
  /** DAT_00bd0854: when the homebind delay runs out; undefined without one. */
  #bootDeadline: number | undefined;

  constructor(context: FrameXmlServerPromptsContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlServerPromptsPump): void {
    this.detach();
    this.#pump = pump;
    const events = this.#context.world()?.events;
    if (!events) return;
    this.#unsubscribe.push(events.on("INSTANCE_BOOT", ({ milliseconds }) => {
      this.#bootDeadline = milliseconds > 0 ? this.#context.monotonic() + milliseconds : undefined;
      this.#pump?.fire(milliseconds > 0 ? INSTANCE_BOOT_START : INSTANCE_BOOT_STOP);
    }));
    this.#unsubscribe.push(events.on("QUEST_SHARED", ({ quest }) => {
      if (!quest) return;
      this.#questId = quest.questId;
      const name = this.#context.world()?.names?.get(quest.initiatorGuid);
      const owned = this.#context.popupsOwned?.() ?? frameXmlPopupsPublished();
      if (!name || !owned || !this.#pump) return;
      askedByStock.add(quest);
      this.#pump.fire(QUEST_ACCEPT_CONFIRM, name, quest.title);
    }));
  }

  detach(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#pump = undefined;
  }

  /** `GetInstanceBootTimeRemaining()`: whole seconds left, 0 with none (0x5162e0). */
  instanceBootTimeRemaining(): number {
    const deadline = this.#bootDeadline;
    if (deadline === undefined) return 0;
    const left = deadline - this.#context.monotonic();
    return left > 0 ? Math.floor(left / 1000) : 0;
  }

  /** `ConfirmAcceptQuest()`: accept the stored share (0x58c910). */
  confirmAcceptQuest(): void {
    const world = this.#context.world();
    if (this.#questId > 0 && world?.sharedQuest?.questId === this.#questId) world.answerSharedQuest?.(true);
  }
}

export interface FrameXmlServerPromptsHost {
  readonly serverPrompts?: FrameXmlServerPromptsModel | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

export const FRAMEXML_SERVER_PROMPTS_BINDINGS: Readonly<Record<string,
  (host: FrameXmlServerPromptsHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  GetInstanceBootTimeRemaining: (host) => [host.serverPrompts?.instanceBootTimeRemaining() ?? 0],
  ConfirmAcceptQuest: (host) => { host.serverPrompts?.confirmAcceptQuest(); return NOTHING; },
});
