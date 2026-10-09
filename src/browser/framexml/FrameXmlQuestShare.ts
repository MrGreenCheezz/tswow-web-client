/**
 * Sharing a quest with the party: `GetQuestLogPushable`, `QuestLogPushQuest` and the sharer's
 * lines for `MSG_QUEST_PUSH_RESULT`.
 *
 * Stock callers: `QuestLogFrame.lua:871` enables «Поделиться» by
 * `GetQuestLogPushable() and (GetNumPartyMembers() > 0 or GetNumRaidMembers() > 0)`,
 * `WatchFrame.lua:1089` asks with the watched quest's log index, and the button and the tracker menu
 * call `QuestLogPushQuest()`.
 *
 * The original client (Wow.exe 3.3.5a build 12340, read-only Ghidra), in this file's words:
 * * Both functions read their argument as a number (nil is 0) and round it. 0 means the selected
 *   quest; otherwise it is a 1-based log line, and a line out of range or a zone header names no
 *   quest.
 * * `GetQuestLogPushable` (0x5df520) looks the quest up in the quest cache and answers 1 when its
 *   Flags word (cache offset 0x50, `QUEST_FLAGS_SHARABLE` 0x8 — `QuestDef.h:139`) has 0x8, and
 *   **no value** otherwise, not nil and not false; a quest not in the cache answers nothing too.
 * * `QuestLogPushQuest` (0x5e4ed0) sends `CMSG_PUSHQUESTTOPARTY` with the quest id (0x6d4f00) only
 *   when the player exists, the quest is cached and sharable, and the player has a party member (the
 *   first party slot's guid, 0xbd1948, which `GetNumPartyMembers` 0x52c110 counts) or raid members
 *   (0xbeb608, `GetNumRaidMembers` 0x572b40). Otherwise nothing happens.
 * * `MSG_QUEST_PUSH_RESULT` (handler 0x6e2e90, case 0x276) reads the receiver's guid and a code byte,
 *   takes the receiver's name from the name cache without querying it — no cached name, no line —
 *   and shows game message 0x19b + code for codes 0..11, `ERR_QUEST_PUSH_SUCCESS_S` through
 *   `ERR_QUEST_PUSH_DIFFERENT_SERVER_DAILY_S` (codes: `QuestDef.h:72-83`). All twelve are type 0 in
 *   the message table (0xac8af0, 20 bytes a row), which 0x5216f0 prints as a system chat line
 *   (0x509dd0) after formatting the string with the name; types 1 and 2 would have been
 *   UI_INFO_MESSAGE and UI_ERROR_MESSAGE. The `|3-N(...)` case markup stays in the line: the font
 *   string declines it when it draws (`ui/framexml_compat/FrameXmlDeclension.ts`).
 */
import { globalString } from "../../generated/globalStrings.js";
import { frameXmlLuaNumber, frameXmlRoundToInt } from "./FrameXmlPvpFlag.js";

/** `QUEST_FLAGS_SHARABLE` (`QuestDef.h:139`), the bit the client tests at quest cache offset 0x50. */
export const QUEST_FLAG_SHARABLE = 0x8;

/** Game messages 0x19b..0x1a6, indexed by `MSG_QUEST_PUSH_RESULT`'s code (`QUEST_PARTY_MSG_*`). */
export const FRAMEXML_QUEST_PUSH_MESSAGES: readonly string[] = Object.freeze([
  "ERR_QUEST_PUSH_SUCCESS_S", "ERR_QUEST_PUSH_INVALID_S", "ERR_QUEST_PUSH_ACCEPTED_S",
  "ERR_QUEST_PUSH_DECLINED_S", "ERR_QUEST_PUSH_BUSY_S", "ERR_QUEST_PUSH_LOG_FULL_S",
  "ERR_QUEST_PUSH_ONQUEST_S", "ERR_QUEST_PUSH_ALREADY_DONE_S", "ERR_QUEST_PUSH_NOT_DAILY_S",
  "ERR_QUEST_PUSH_TIMER_EXPIRED_S", "ERR_QUEST_PUSH_NOT_IN_PARTY_S", "ERR_QUEST_PUSH_DIFFERENT_SERVER_DAILY_S",
]);

export interface FrameXmlQuestShareContext {
  /** The quest on 1-based log line `index`, or the selected one for 0; undefined for none. */
  questIdAt(index: number): number | undefined;
  /** The cached quest template's Flags; undefined when the template is not cached. */
  questFlags(questId: number): number | undefined;
  hasPlayer(): boolean;
  partyMemberCount(): number;
  raidMemberCount(): number;
  share(questId: number): void;
  /** The name cache's entry; undefined when the name was never answered. */
  cachedName(guid: bigint): string | undefined;
  /** GlobalStrings by name; the generated table by default. */
  globalString?(name: string): string | undefined;
}

interface FrameXmlQuestSharePump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/** The template's first `%s` (or `%1$s`) filled with `value`, `%%` read as `%`. */
function formatOne(pattern: string, value: string): string {
  const match = /%(?:1\$)?s/.exec(pattern);
  if (!match) return pattern.replace(/%%/g, "%");
  return pattern.slice(0, match.index).replace(/%%/g, "%") + value
    + pattern.slice(match.index + match[0].length).replace(/%%/g, "%");
}

export class FrameXmlQuestShareModel {
  readonly #context: FrameXmlQuestShareContext;
  #pump: FrameXmlQuestSharePump | undefined;

  constructor(context: FrameXmlQuestShareContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlQuestSharePump): void {
    this.#pump = pump;
  }

  detach(): void {
    this.#pump = undefined;
  }

  /** The quest a Lua argument names: 0 or nil the selection, else a log line. */
  #quest(value: unknown): number | undefined {
    const number = frameXmlLuaNumber(value) ?? 0;
    if (!Number.isFinite(number)) return undefined;
    return this.#context.questIdAt(frameXmlRoundToInt(number));
  }

  #sharable(questId: number | undefined): questId is number {
    if (questId === undefined) return false;
    const flags = this.#context.questFlags(questId);
    return flags !== undefined && (flags & QUEST_FLAG_SHARABLE) !== 0;
  }

  /** `GetQuestLogPushable([index])`: true for 1, false for no value. */
  pushable(value: unknown): boolean {
    return this.#sharable(this.#quest(value));
  }

  /** `QuestLogPushQuest([index])`. */
  push(value: unknown): void {
    const questId = this.#quest(value);
    if (!this.#context.hasPlayer() || !this.#sharable(questId)) return;
    if (this.#context.partyMemberCount() <= 0 && this.#context.raidMemberCount() <= 0) return;
    this.#context.share(questId);
  }

  /** `MSG_QUEST_PUSH_RESULT` for the sharer: one system line, or nothing. */
  result(guid: bigint, code: number): void {
    const key = FRAMEXML_QUEST_PUSH_MESSAGES[code];
    if (key === undefined) return;
    const name = this.#context.cachedName(guid);
    if (name === undefined) return;
    const template = (this.#context.globalString ?? globalString)(key);
    if (!template) return;
    this.#pump?.fire("CHAT_MSG_SYSTEM", formatOne(template, name), "", "", "", "", "", 0, 0, "", 0, 0, "");
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlQuestShareHost {
  readonly questShare?: FrameXmlQuestShareModel | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);
const ONE: readonly unknown[] = Object.freeze([1]);

export const FRAMEXML_QUEST_SHARE_BINDINGS: Readonly<Record<string,
  (host: FrameXmlQuestShareHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  GetQuestLogPushable: (host, args) => (host.questShare?.pushable(args[0]) ? ONE : NOTHING),
  QuestLogPushQuest: (host, args) => {
    host.questShare?.push(args[0]);
    return NOTHING;
  },
});
