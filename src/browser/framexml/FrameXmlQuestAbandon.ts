/**
 * The stock quest log's abandon flow over `WorldClient.abandonQuest` (CMSG_QUESTLOG_REMOVE_QUEST).
 *
 * How stock drives it, measured in the 3.3.5 corpus:
 *
 * * `QuestLog_SetSelection` calls `SelectQuestLogEntry(index)` and then `SetAbandonQuest()`
 *   (QuestLogFrame.lua:612-615): the abandon quest is whatever is selected at that moment.
 * * `QuestLogControlPanel_UpdateState` enables «Отказаться» only while `GetAbandonQuestName()` is
 *   non-nil (QuestLogFrame.lua:863-867); the button's OnClick calls `SetAbandonQuest()` again and
 *   shows ABANDON_QUEST_WITH_ITEMS when `GetAbandonQuestItems()` answers, else ABANDON_QUEST, both
 *   titled with `GetAbandonQuestName()` (QuestLogFrame.xml:146-153). Either popup's OnAccept is
 *   `AbandonQuest()` (StaticPopup.lua:1691, :1707).
 * * The core takes the quest's source item and destroys its quest-bound required items on the
 *   remove (`Player::TakeQuestSourceItem`, `Player::AbandonQuest` in QuestHandler.cpp), which is
 *   what the WITH_ITEMS confirmation warns about: the answer is whether any of those entries is
 *   carried right now.
 *
 * The pending quest is remembered by id, not by row: a log that moved underneath it (a shared quest
 * accepted, a turn-in) is re-read at every answer, and a quest no longer in the log answers nil and
 * is forgotten, so a stale confirmation can never remove somebody else's row.
 */

export interface FrameXmlQuestAbandonEntry {
  /** The wire log slot `CMSG_QUESTLOG_REMOVE_QUEST` names. */
  readonly slot: number;
  readonly questId: number;
}

export interface FrameXmlQuestAbandonContext {
  /** The stock quest log selection, 1-based; 0 when nothing is selected. */
  selection(): number;
  /** The quest in one 1-based row. */
  entry(index: number): FrameXmlQuestAbandonEntry | undefined;
  /** Where a quest sits now, whatever row it had when it was remembered. */
  locate(questId: number): FrameXmlQuestAbandonEntry | undefined;
  /** The title as the quest template names it; undefined until the template has arrived. */
  title(questId: number): string | undefined;
  /** The item entries the server takes with the quest: its source item and its required items. */
  questItems(questId: number): readonly number[] | undefined;
  /** Every item entry in the backpack, the carried bags and the keyring; undefined without a player. */
  carriedItems(): ReadonlySet<number> | undefined;
  abandon(entry: FrameXmlQuestAbandonEntry): void;
}

export class FrameXmlQuestAbandonModel {
  readonly #context: FrameXmlQuestAbandonContext;
  #pending: number | undefined;

  constructor(context: FrameXmlQuestAbandonContext) {
    this.#context = context;
  }

  /** `SetAbandonQuest()`: remember the selected quest, or nothing when nothing is selected. */
  set(): void {
    const entry = this.#context.entry(this.#context.selection());
    this.#pending = entry?.questId;
  }

  /** The remembered quest as the log holds it now; forgotten once it left the log. */
  #current(): FrameXmlQuestAbandonEntry | undefined {
    if (this.#pending === undefined) return undefined;
    const entry = this.#context.locate(this.#pending);
    if (!entry) this.#pending = undefined;
    return entry;
  }

  /** `GetAbandonQuestName()`. */
  name(): string | undefined {
    const entry = this.#current();
    return entry ? this.#context.title(entry.questId) : undefined;
  }

  /** `GetAbandonQuestItems()`: whether abandoning would take items out of the bags. */
  hasItems(): boolean {
    const entry = this.#current();
    if (!entry) return false;
    const items = this.#context.questItems(entry.questId);
    const carried = this.#context.carriedItems();
    if (!items || !carried) return false;
    return items.some((itemId) => itemId > 0 && carried.has(itemId));
  }

  /** `AbandonQuest()`: one packet for the remembered quest's current slot, then nothing is pending. */
  abandon(): void {
    const entry = this.#current();
    this.#pending = undefined;
    if (entry) this.#context.abandon(entry);
  }

  /** For the report and tests: the quest id waiting for a confirmation. */
  get pendingQuestId(): number | undefined {
    return this.#pending;
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlQuestAbandonHost {
  readonly questAbandon?: FrameXmlQuestAbandonModel | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

export const FRAMEXML_QUEST_ABANDON_BINDINGS: Readonly<Record<string,
  (host: FrameXmlQuestAbandonHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  SetAbandonQuest: (host) => {
    host.questAbandon?.set();
    return NOTHING;
  },
  GetAbandonQuestName: (host) => {
    const name = host.questAbandon?.name();
    return name === undefined ? NOTHING : [name];
  },
  // The client answers 1 or nil; QuestLogFrame.xml:148 only tests truthiness.
  GetAbandonQuestItems: (host) => (host.questAbandon?.hasItems() ? [1] : NOTHING),
  AbandonQuest: (host) => {
    host.questAbandon?.abandon();
    return NOTHING;
  },
});
