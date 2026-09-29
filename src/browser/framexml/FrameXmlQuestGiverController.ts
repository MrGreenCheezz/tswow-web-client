import type { QuestDialog, QuestList } from "../../world/NpcProtocol.js";
import {
  captureFrameXmlQuestSnapshot,
  frameXmlQuestLifecycleEvent,
  type FrameXmlQuestLifecycleEvent,
  type FrameXmlQuestSnapshot,
} from "./FrameXmlQuestLifecycle.js";

export interface FrameXmlQuestGiverWorld extends FrameXmlQuestSnapshot {
  readonly questMessage?: { readonly text: string; readonly error: boolean } | undefined;
}

/** The mount owns the VM and DOM; this controller owns the single world callback route. */
export interface FrameXmlQuestGiverOwner {
  readonly world: FrameXmlQuestGiverWorld;
  currentWorld(): FrameXmlQuestGiverWorld | undefined;
  isOpen(): boolean;
  render(event: FrameXmlQuestLifecycleEvent | "QUEST_ITEM_UPDATE"): boolean;
  hideNative(): void;
  prefetch(page: QuestDialog | QuestList): void;
  message(text: string, error: boolean): void;
  close(): void;
  /** Forced release preserves the authoritative page for a native fallback. */
  dispose(): void;
  onFailure(): void;
}

interface PublishedOwner {
  readonly owner: FrameXmlQuestGiverOwner;
  previous: FrameXmlQuestSnapshot | undefined;
  previousMessage: FrameXmlQuestGiverWorld["questMessage"];
  metadataRevision: number | undefined;
}

let published: PublishedOwner | undefined;

/** Stock XML has exactly 32 greeting rows, six required-item rows and ten reward rows. */
export function frameXmlQuestGiverPageSupported(page: FrameXmlQuestSnapshot): boolean {
  if (page.questList && page.questDialog) return false;
  if (page.questList) return page.questList.quests.length <= 32;
  const dialog = page.questDialog;
  if (!dialog) return true;
  if (dialog.kind === "request-items") return dialog.items.length <= 6;
  return dialog.rewards.items.length + dialog.rewards.choices.length
    + (dialog.rewards.displaySpell > 0 ? 1 : 0) <= 10
    && dialog.rewards.choices.length <= 6;
}

function fail(current: PublishedOwner): void {
  if (published === current) published = undefined;
  try { current.owner.dispose(); } catch { /* the native fallback still gets its route */ }
  try { current.owner.onFailure(); } catch { /* a failed callback must not revive the owner */ }
}

/** Return false only when the native quest dialog owns this update. */
export function notifyFrameXmlQuestGiver(world: FrameXmlQuestGiverWorld): boolean {
  const current = published;
  if (!current || current.owner.world !== world || current.owner.currentWorld() !== world) return false;
  const page = captureFrameXmlQuestSnapshot(world);
  if (!frameXmlQuestGiverPageSupported(page)) {
    fail(current);
    return false;
  }
  const event = frameXmlQuestLifecycleEvent(current.previous, page);
  // WorldClient.closeQuest can synchronously reenter this callback from QuestFrame_OnHide.
  // Advance the snapshot before invoking any Lua handler.
  current.previous = page;
  const message = world.questMessage;
  const report = message !== undefined && message !== current.previousMessage;
  current.previousMessage = message;
  try {
    if (event && !current.owner.render(event)) throw new Error(`QuestFrame ${event} failed`);
    if (page.questList || page.questDialog) {
      current.owner.hideNative();
      if (event) {
        current.metadataRevision = undefined;
        current.owner.prefetch(page.questDialog ?? page.questList!);
      }
    } else if (event === "QUEST_FINISHED" || message) current.owner.hideNative();
    if (report && message) current.owner.message(message.text, message.error);
    return true;
  } catch {
    fail(current);
    return false;
  }
}

/** Item metadata is a separate edge: an ordinary page repaint never invents this stock event. */
export function notifyFrameXmlQuestGiverItemUpdate(
  world: FrameXmlQuestGiverWorld,
  metadataRevision?: number,
): boolean {
  const current = published;
  if (!current || current.owner.world !== world || current.owner.currentWorld() !== world
    || (!world.questList && !world.questDialog)) return false;
  try {
    if (!current.owner.isOpen()) return false;
    if (metadataRevision !== undefined && current.metadataRevision === metadataRevision) return true;
    current.metadataRevision = metadataRevision;
    if (!current.owner.render("QUEST_ITEM_UPDATE")) throw new Error("QuestFrame item update failed");
    return true;
  } catch {
    fail(current);
    return false;
  }
}

export function frameXmlQuestGiverOpen(): boolean {
  const current = published;
  if (!current || current.owner.currentWorld() !== current.owner.world) return false;
  try { return current.owner.isOpen(); } catch { return false; }
}

/** The stock OnHide sends CloseQuest once; its resulting FINISHED event cannot resend it. */
export function closeFrameXmlQuestGiver(): boolean {
  const current = published;
  if (!current || current.owner.currentWorld() !== current.owner.world) return false;
  try {
    if (!current.owner.isOpen()) return false;
    current.owner.close();
    return true;
  } catch {
    fail(current);
    return false;
  }
}

export function publishFrameXmlQuestGiver(owner: FrameXmlQuestGiverOwner): () => void {
  const prior = published;
  if (prior) {
    published = undefined;
    try { prior.owner.dispose(); } catch { /* next owner remains eligible */ }
  }
  const current: PublishedOwner = {
    owner, previous: undefined, previousMessage: undefined, metadataRevision: undefined,
  };
  published = current;
  // Mount may complete while a packet-backed quest page is already open.
  if (owner.world.questList || owner.world.questDialog || owner.world.questMessage) {
    notifyFrameXmlQuestGiver(owner.world);
  }
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    if (published !== current) return;
    published = undefined;
    try { owner.dispose(); } catch { /* cleanup continues through the mount */ }
  };
}
