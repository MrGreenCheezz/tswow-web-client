import { MAIL_AUCTION, MAIL_CALENDAR, MAIL_NORMAL, type MailEntry } from "../../world/MailProtocol.js";

/**
 * 5.28 (15.11): the first value of GetInboxText as Wow.exe 3.3.5a 12340 gives it (0x00570bd0, read-only Ghidra,
 * .runtime/re-2026-11-11/api4/d1.c; the filter 0x00509a50 in d2.c; its helpers in .runtime/re-2026-11-15/misc8):
 *
 * - An empty body: the MailTemplate row of the letter's template id through the quest text parser (0x0065c290, then
 *   0x00579590 for the player); no template id, or no row — nil.
 * - A body, by the letter's type: an auction letter (2) — nil (its invoice is GetInboxInvoiceInfo's); a player's
 *   letter (0) — the text through the profanity filter; a calendar letter (5) — the calendar's own text (not this
 *   file's); any other (a creature's, a game object's, an item's) — through the quest text parser.
 *
 * The profanity filter (0x00509a50(text, 0, 0)) works only while the CVar `profanityFilter` (0x00bd095c, registered
 * by 0x0051d9b0 with "1", flag 0x10) reads non-zero. It runs the client locale's ChatProfanity list (0xd37ea0 + 4/8 —
 * the patterns 0x7e2250 compiled with the bundled PCRE's UTF8 | CASELESS, GlueNameFilters.ts) over the text: for each
 * pattern in turn it finds a match, replaces each of its bytes with the next character of "!@#$%^&*" — a counter kept
 * across calls (0x00bcfb84) — and searches again after the match. A match is left, and that pattern given up, when
 * 0x004fcf40 finds it inside a colour escape: it walks the text from its very beginning for as many bytes as the match
 * starts after the current search position (as Wow.exe passes them), `|c`/`|C` opening and `|r`/`|R` closing, any
 * other `|x` pair skipped.
 */

export interface FrameXmlMailTextSource {
  /** 0x00579590 for the player: `$N`, `$C`, `$G…;` and the rest (FrameXmlQuestText.ts). */
  questText?(text: string): string;
  /** MailTemplate.dbc's body of a template id; undefined — no row (or the table has not landed). */
  templateBody?(id: number): string | undefined;
  /** The filter's switch and the chat list; undefined — no filter (no lists built for this realm). */
  profanity?(): { readonly enabled: boolean; readonly chat: readonly RegExp[] } | undefined;
}

const SYMBOLS = "!@#$%^&*";
let symbolAt = 0;

/** For a test: the cycle's position (0x00bcfb84). */
export function resetFrameXmlMailProfanityCycle(at = 0): void {
  symbolAt = at;
}

const encoder = new TextEncoder();

function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** 0x004fcf40: whether `bytes` bytes into the text sit inside an open `|c` colour. */
function insideColour(text: string, bytes: number): boolean {
  const data = encoder.encode(text);
  let inside = false;
  let at = 0;
  let left = bytes;
  while (left > 0) {
    left -= 1;
    if (data[at++] !== 0x7c) continue; // '|'
    if (left === 0) break;
    const next = data[at];
    if (next === 0x63 || next === 0x43) inside = true;
    else if ((next === 0x72 || next === 0x52) && inside) inside = false;
    at += 1;
    left -= 1;
  }
  return inside;
}

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** 0x00509a50(text, 0, 0) with the filter on: every chat pattern's matches masked byte by byte. */
export function frameXmlMailProfanityFiltered(text: string, chat: readonly RegExp[]): string {
  if (text === "") return text;
  let out = text;
  for (const pattern of chat) {
    let from = 0;
    for (;;) {
      const match = pattern.exec(asciiLower(out.slice(from)));
      if (!match) break;
      const start = from + match.index;
      const relativeBytes = utf8Length(out.slice(from, start));
      if (insideColour(out, relativeBytes)) break;
      const matched = match[0];
      // A pattern that matches nothing would search the same place for ever in Wow.exe; here it ends the pattern.
      if (matched.length === 0) break;
      let mask = "";
      for (let count = utf8Length(out.slice(start, start + matched.length)); count > 0; count--) {
        mask += SYMBOLS[symbolAt]!;
        symbolAt = symbolAt + 1 > 7 ? 0 : symbolAt + 1;
      }
      out = out.slice(0, start) + mask + out.slice(start + matched.length);
      from = start + mask.length;
    }
  }
  return out;
}

/** `MAIL_CHECK_MASK_COPIED` (Mail.h:49): the letter was already made into a text item. */
const MAIL_COPIED = 0x04;
/** `MAIL_STATIONERY_GM` (Mail.h:59). */
const GM_STATIONERY = 61;

/**
 * 5.28 (follow-up, 15.11): GetInboxText's third value, isTakeable (0x00570bd0, the block after the stationery): nil
 * when the letter has neither a body nor a template, was already copied (flags & 4), is on GM stationery (61), is a
 * calendar letter (5), or is an auction letter (2) whose invoice field (+0x216c) is not set; 1 otherwise — an
 * auction invoice can be made into a text item, as TrinityCore's HandleMailCreateTextItem also allows
 * (MailHandler.cpp:574: it refuses only a letter with no body and no template, a copied one, or an undelivered one).
 */
export function frameXmlMailTakeable(
  entry: Pick<MailEntry, "senderType" | "body" | "mailTemplateId" | "flags" | "stationeryId">, invoice: boolean,
): boolean {
  if (entry.body.length === 0 && entry.mailTemplateId === 0) return false;
  if ((entry.flags & MAIL_COPIED) !== 0 || entry.stationeryId === GM_STATIONERY || entry.senderType === MAIL_CALENDAR) return false;
  if (entry.senderType === MAIL_AUCTION && !invoice) return false;
  return true;
}

/** GetInboxText's body (0x00570bd0); undefined is nil. */
export function frameXmlMailBody(
  entry: Pick<MailEntry, "senderType" | "body" | "mailTemplateId">, source: FrameXmlMailTextSource,
): string | undefined {
  const parse = (text: string): string => source.questText?.(text) ?? text;
  if (entry.body.length === 0) {
    if (entry.mailTemplateId === 0) return undefined;
    const body = source.templateBody?.(entry.mailTemplateId);
    return body === undefined ? undefined : parse(body);
  }
  if (entry.senderType === MAIL_AUCTION) return undefined;
  if (entry.senderType === MAIL_NORMAL) {
    const profanity = source.profanity?.();
    return profanity?.enabled ? frameXmlMailProfanityFiltered(entry.body, profanity.chat) : entry.body;
  }
  if (entry.senderType === MAIL_CALENDAR) return entry.body;
  return parse(entry.body);
}
