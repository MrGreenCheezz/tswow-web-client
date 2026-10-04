/**
 * `GetAutoCompleteResults` — the stock AutoComplete's name list (plan item 3.18, L5c 04.10).
 *
 * Stock callers: AutoComplete.lua:127 (the drop-down under a whisper, invite, mail or add-friend box,
 * one more result than it shows), :237 (the inline completion, one result at the UTF-8 cursor) and
 * ChatFrame.lua:4125/4134 (`/w` target extraction, `allowFullMatch`). The flag bits are
 * AutoComplete.lua:3-10: IN_GROUP 0x1, IN_GUILD 0x2, FRIEND 0x4, BNET 0x8, INTERACTED_WITH 0x10,
 * ONLINE 0x20.
 *
 * Wow.exe 3.3.5a 12340 (read-only Ghidra, notes .runtime/re-2026-10-04/l5c/):
 *
 * * The list (head 0x00aceb78) holds one node per character: name, flags, a «last interacted» time
 *   and the guid. Its sources: SMSG_CONTACT_LIST / SMSG_FRIEND_STATUS (0x006b7dd0, 0x006b73a0) set
 *   FRIEND and ONLINE; SMSG_GUILD_ROSTER (0x005cc5d0) and SMSG_GUILD_EVENT (0x006d92d0: joined, left,
 *   removed, disbanded, signed on/off) IN_GUILD and ONLINE; SMSG_GROUP_LIST (0x006d8870 → 0x0052d6e0
 *   clears IN_GROUP from all, then 0x0052d410 per member) IN_GROUP and ONLINE; SMSG_PARTY_MEMBER_STATS
 *   (0x006cf9b0) ONLINE; a chat line of type 7 (whisper) or 9 (whisper inform) in any language but
 *   the add-on one (0x00509dd0) INTERACTED_WITH|ONLINE and stamps the time; SMSG_CHAT_PLAYER_NOT_FOUND
 *   (0x006e2e90, opcode 0x2a9) clears ONLINE by name. A node goes when no bit but ONLINE is left.
 * * Order (insert 0x0057b130): with the CVar `autoCompleteResortNamesOnRecency` (default "1") the most
 *   recent interaction first, then the name; otherwise the name. Names compare with 0x0076ea40: per
 *   UTF-8 character, folded by 0x0076e8d0 — ASCII and Latin-1 letters upper-cased, Cyrillic case-
 *   insensitive with Ё/ё between Е and Ж, everything else as is.
 * * The query (0x0057b3a0 → 0x0057b250 → 0x0057aca0): the character itself never; with
 *   `autoCompleteUseContext` (default "1") a node needs `flags & include ≠ 0` and `flags & exclude = 0`;
 *   a name equal to the text is left out unless `allowFullMatch`; with `autoCompleteWhenEditingFromCenter`
 *   (default "1") the text before the cursor must start the name and the text after it must appear
 *   later in the name; otherwise the whole text starts the name. The cursor is in UTF-8 characters and
 *   defaults to the text's end; results stop at `numReturns` (none at or below zero: all).
 *
 * This client keeps the same facts as state (contacts, the guild roster, the group, the name cache),
 * so the list is built from them at each query; only what has no state — the whispers' times and a
 * «not found» — is recorded from the world's events. Differences: ONLINE is the structured sources'
 * when any of them knows the character, which equals the client's except when a whisper arrives
 * between a friend's or member's offline status and its next update.
 */

import { CHAT_MSG_WHISPER, CHAT_MSG_WHISPER_INFORM, type ChatMessage } from "../../world/ChatProtocol.js";
import { FRIEND_STATUS_OFFLINE, SOCIAL_FLAG_FRIEND, type ContactList } from "../../world/ContactProtocol.js";
import type { GroupState } from "../../world/GroupProtocol.js";
import type { GuildRoster } from "../../world/GuildProtocol.js";
import type { FrameXmlSeamBinding } from "./FrameXmlWorldSeam.js";

export const AUTOCOMPLETE_FLAG_IN_GROUP = 0x01;
export const AUTOCOMPLETE_FLAG_IN_GUILD = 0x02;
export const AUTOCOMPLETE_FLAG_FRIEND = 0x04;
export const AUTOCOMPLETE_FLAG_INTERACTED_WITH = 0x10;
export const AUTOCOMPLETE_FLAG_ONLINE = 0x20;

/** `LANG_ADDON`: an add-on whisper interacts with nobody (0x00509dd0 skips language -1). */
const LANG_ADDON = 0xffffffff;

/** Wow.exe 0x0076e8d0's fold of one code point (the comparison key, not a display form). */
export function frameXmlAutoCompleteFold(cp: number): number {
  if (cp > 0xffff) return 0xfffd;
  if (cp < 0x80) return cp >= 0x61 && cp <= 0x7a ? cp - 0x20 : cp;
  if (cp >= 0x800) return cp;
  if (cp >= 0xe0 && cp <= 0xfe) return cp - 0x20;
  if (cp === 0x153) return 0x152;
  if (cp === 0x401 || cp === 0x451) return 0x415;
  if (cp > 0x40f && cp < 0x416) return cp - 1;
  if (cp > 0x42f && cp < 0x450) return cp - (cp < 0x436 ? 1 : 0) - 0x20;
  return cp;
}

function keys(text: string): number[] {
  const out: number[] = [];
  for (const char of text) out.push(frameXmlAutoCompleteFold(char.codePointAt(0)!));
  return out;
}

/** 0x0076ea40 over folded keys: the first `count` characters (or to the ends), negative/0/positive. */
function compareKeys(left: readonly number[], leftAt: number, right: readonly number[], rightAt: number, count: number): number {
  for (let index = 0; index < count; index += 1) {
    const a = left[leftAt + index] ?? 0;
    const b = right[rightAt + index] ?? 0;
    if (a !== b) return a - b;
    if (a === 0) return 0;
  }
  return 0;
}

interface Candidate {
  readonly guid: bigint;
  readonly name: string;
  readonly key: readonly number[];
  readonly flags: number;
  readonly at: number;
}

/** The world facts the list is built from; WorldClient has them all. */
export interface FrameXmlAutoCompleteWorld {
  readonly state: { readonly selfGuid?: bigint | undefined };
  readonly contacts?: ContactList | undefined;
  readonly guildRoster?: GuildRoster | undefined;
  readonly group?: GroupState | undefined;
  readonly names?: { get(guid: bigint): string | undefined } | undefined;
  readonly events?: {
    on(name: "CHAT_MESSAGE", listener: (message: ChatMessage) => void): () => void;
    on(name: "CHAT_PLAYER_NOT_FOUND", listener: (payload: { name: string }) => void): () => void;
  } | undefined;
}

export interface FrameXmlAutoCompleteContext {
  world(): FrameXmlAutoCompleteWorld | undefined;
  /** The player is in a guild now (PLAYER_GUILDID ≠ 0); a roster of a guild left is not read. Absent: yes. */
  inGuild?(): boolean;
  /** Monotonic milliseconds: the whispers' order. */
  now(): number;
  /** A CVar's value; absent or undefined, the client's default "1" for all three autocomplete CVars. */
  cvar?(name: string): string | undefined;
}

interface Whisper {
  at: number;
  /** INTERACTED_WITH came with ONLINE; a «not found» for the name takes it back. */
  online: boolean;
}

function truthyCvar(value: string | undefined): boolean {
  if (value === undefined) return true;
  const number = Number(value);
  return Number.isFinite(number) ? number !== 0 : value.length > 0;
}

function uint32(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.round(number) >>> 0 : undefined;
}

export class FrameXmlAutoCompleteModel {
  readonly #context: FrameXmlAutoCompleteContext;
  readonly #whispers = new Map<bigint, Whisper>();
  #unsubscribe: (() => void)[] = [];

  constructor(context: FrameXmlAutoCompleteContext) {
    this.#context = context;
  }

  /** Listen to the world's whispers and «not found» answers. */
  attach(): void {
    this.detach();
    const events = this.#context.world()?.events;
    if (!events) return;
    this.#unsubscribe = [
      events.on("CHAT_MESSAGE", (message) => this.#chat(message)),
      events.on("CHAT_PLAYER_NOT_FOUND", ({ name }) => this.#notFound(name)),
    ];
  }

  detach(): void {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
  }

  #chat(message: ChatMessage): void {
    if (message.type !== CHAT_MSG_WHISPER && message.type !== CHAT_MSG_WHISPER_INFORM) return;
    if ((message.language >>> 0) === LANG_ADDON || message.senderGuid === 0n) return;
    this.#whispers.set(message.senderGuid, { at: this.#context.now(), online: true });
  }

  #notFound(name: string): void {
    const wanted = keys(name);
    const world = this.#context.world();
    for (const [guid, whisper] of this.#whispers) {
      const known = world?.names?.get(guid);
      if (known !== undefined && compareKeys(keys(known), 0, wanted, 0, Number.MAX_SAFE_INTEGER) === 0) whisper.online = false;
    }
  }

  /** The list as the client would hold it now, in its order. */
  #candidates(world: FrameXmlAutoCompleteWorld): Candidate[] {
    const nodes = new Map<bigint, { name: string | undefined; flags: number; structured: boolean; online: boolean }>();
    const node = (guid: bigint, name: string | undefined) => {
      let entry = nodes.get(guid);
      if (!entry) nodes.set(guid, entry = { name: undefined, flags: 0, structured: false, online: false });
      if (name) entry.name ??= name;
      return entry;
    };
    for (const contact of world.contacts?.contacts ?? []) {
      if ((contact.flags & SOCIAL_FLAG_FRIEND) === 0) continue;
      const entry = node(contact.guid, undefined);
      entry.flags |= AUTOCOMPLETE_FLAG_FRIEND;
      entry.structured = true;
      if (contact.status !== FRIEND_STATUS_OFFLINE) entry.online = true;
    }
    if (this.#context.inGuild?.() !== false) {
      for (const member of world.guildRoster?.members ?? []) {
        const entry = node(member.guid, member.name);
        entry.flags |= AUTOCOMPLETE_FLAG_IN_GUILD;
        entry.structured = true;
        if (member.online) entry.online = true;
      }
    }
    for (const member of world.group?.members ?? []) {
      const entry = node(member.guid, member.name);
      entry.flags |= AUTOCOMPLETE_FLAG_IN_GROUP;
      entry.structured = true;
      if (member.online) entry.online = true;
    }
    for (const [guid, whisper] of this.#whispers) {
      const entry = node(guid, undefined);
      entry.flags |= AUTOCOMPLETE_FLAG_INTERACTED_WITH;
      if (!entry.structured && whisper.online) entry.online = true;
    }
    const self = world.state.selfGuid;
    const recency = truthyCvar(this.#context.cvar?.("autoCompleteResortNamesOnRecency"));
    const out: Candidate[] = [];
    for (const [guid, entry] of nodes) {
      if (guid === self) continue;
      // The source's own name first (roster, group list), as 0x0057b7c0 stores it; else the name cache.
      const name = entry.name ?? world.names?.get(guid) ?? "";
      out.push({
        guid, name, key: keys(name),
        flags: entry.flags | (entry.online ? AUTOCOMPLETE_FLAG_ONLINE : 0),
        at: recency ? this.#whispers.get(guid)?.at ?? 0 : 0,
      });
    }
    out.sort((a, b) => (b.at - a.at) || compareKeys(a.key, 0, b.key, 0, Number.MAX_SAFE_INTEGER));
    return out;
  }

  /** `GetAutoCompleteResults(text, include, exclude, numReturns[, cursorPosition[, allowFullMatch]])`. */
  results(args: readonly unknown[]): readonly string[] {
    const text = typeof args[0] === "string" ? args[0] : typeof args[0] === "number" ? String(args[0]) : undefined;
    const include = uint32(args[1]);
    const exclude = uint32(args[2]);
    const wantedValue = uint32(args[3]);
    if (text === undefined || include === undefined || exclude === undefined || wantedValue === undefined) return [];
    const wanted = wantedValue | 0;
    const world = this.#context.world();
    if (!world) return [];
    const textKey = keys(text);
    let cursor = textKey.length;
    const cursorValue = typeof args[4] === "number" && Number.isFinite(args[4]) ? Math.round(args[4]) : undefined;
    if (cursorValue !== undefined && cursorValue >= 0 && cursorValue <= textKey.length) cursor = cursorValue;
    const allowFullMatch = args[5] !== undefined && args[5] !== null && args[5] !== false;
    const useContext = truthyCvar(this.#context.cvar?.("autoCompleteUseContext"));
    const fromCenter = truthyCvar(this.#context.cvar?.("autoCompleteWhenEditingFromCenter"));
    const out: string[] = [];
    for (const candidate of this.#candidates(world)) {
      if (useContext && ((candidate.flags & exclude) !== 0 || (candidate.flags & include) === 0)) continue;
      if (!allowFullMatch && compareKeys(textKey, 0, candidate.key, 0, Number.MAX_SAFE_INTEGER) === 0) continue;
      if (!matches(textKey, candidate.key, fromCenter ? cursor : textKey.length)) continue;
      out.push(candidate.name);
      if (out.length === wanted) break;
    }
    return out;
  }
}

/** 0x0057aca0's name test: the text before the cursor starts the name, the rest appears after it. */
function matches(text: readonly number[], name: readonly number[], cursor: number): boolean {
  if (compareKeys(text, 0, name, 0, cursor) !== 0) return false;
  if (text.length > name.length) return false;
  if (text.length === cursor) return true;
  const tail = text.length - cursor;
  for (let start = cursor, left = name.length - tail - cursor; left !== 0; start += 1, left -= 1) {
    if (compareKeys(name, start, text, cursor, tail) === 0) return true;
  }
  return false;
}

/** The seam surface the binding reads. */
export interface FrameXmlAutoCompleteHost {
  readonly autoComplete?: FrameXmlAutoCompleteModel | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

export const FRAMEXML_AUTOCOMPLETE_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  GetAutoCompleteResults: (seam, args) => seam.autoComplete?.results(args) ?? NOTHING,
});
