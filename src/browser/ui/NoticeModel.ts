/**
 * What the server refused, in words.
 *
 * Sixteen places in this interface could show a message and not one of them was shared, so an
 * error had to be born inside whichever window happened to be open. A cast refusal went to a line
 * inside the spellbook; "you cannot attack that" went to the diagnostics panel, which is hidden
 * unless somebody pressed the gear. Most of the rest — every arena, calendar, petition, ticket and
 * pet refusal — reached a field with no reader at all.
 *
 * This is the model behind one surface that shows all of them: a short queue with the newest at
 * the bottom, a repeat collapsed into a count, and each entry expiring on its own.
 *
 * The words themselves are never invented here. A refusal is a number, and the strings for those
 * numbers are the realm's own, generated out of the dataset's `GlobalStrings.lua`.
 */

export type NoticeKind = "error" | "info" | "success";

export interface Notice {
  text: string;
  kind: NoticeKind;
  bornAt: number;
  expiresAt: number;
  /** How many times in a row the same words arrived. Shown as «×3» rather than as three lines. */
  count: number;
}

/** Long enough to read a sentence, short enough not to sit over the fight. */
export const NOTICE_LIFE_MS = 6_000;
/** More than this and the oldest goes, whatever its clock says. */
export const NOTICE_MAX = 4;

/**
 * Adds a notice, or bumps the one already saying the same thing.
 *
 * A refusal usually arrives in a burst — a key held down against a target out of range sends one
 * per attempt — and four identical lines say nothing that one line and a count does not.
 */
export function pushNotice(list: Notice[], text: string, kind: NoticeKind, now: number): void {
  if (!text) return;
  const last = list[list.length - 1];
  if (last && last.text === text && last.kind === kind) {
    list[list.length - 1] = { ...last, count: last.count + 1, expiresAt: now + NOTICE_LIFE_MS };
    return;
  }
  list.push({ text, kind, bornAt: now, expiresAt: now + NOTICE_LIFE_MS, count: 1 });
  if (list.length > NOTICE_MAX) list.splice(0, list.length - NOTICE_MAX);
}

export function expireNotices(list: Notice[], now: number): void {
  for (let index = list.length - 1; index >= 0; index--) {
    if ((list[index] as Notice).expiresAt <= now) list.splice(index, 1);
  }
}

/** «Вне зоны действия. ×3» */
export function noticeText(notice: Notice): string {
  return notice.count > 1 ? `${notice.text} ×${notice.count}` : notice.text;
}
