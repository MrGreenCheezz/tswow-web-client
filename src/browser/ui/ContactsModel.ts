/**
 * Friends, the ignore list and the answers to `/who`.
 *
 * Two things here are easy to get wrong. `Contact.flags` is a bitmask, so the same character can
 * be a friend and ignored at the same time and appears in both lists — splitting the list by
 * position instead of by bit loses one of the two. And a `/who` row carries **no guid at all**, so
 * every action on one has to go by name; a row builder keyed on guids simply cannot work.
 */

import {
  FRIEND_STATUS_AFK, FRIEND_STATUS_DND, FRIEND_STATUS_OFFLINE, FRIEND_STATUS_ONLINE,
  SOCIAL_FLAG_FRIEND, SOCIAL_FLAG_IGNORED,
  type Contact, type ContactList, type WhoEntry, type WhoRequest, type WhoResult,
} from "../../world/ContactProtocol.js";

export function friendRows(list: ContactList | undefined): Contact[] {
  return (list?.contacts ?? [])
    .filter((contact) => (contact.flags & SOCIAL_FLAG_FRIEND) !== 0)
    .sort((left, right) =>
      Number(right.status !== FRIEND_STATUS_OFFLINE) - Number(left.status !== FRIEND_STATUS_OFFLINE)
      || Number(right.level) - Number(left.level));
}

export function ignoreRows(list: ContactList | undefined): Contact[] {
  return (list?.contacts ?? []).filter((contact) => (contact.flags & SOCIAL_FLAG_IGNORED) !== 0);
}

export function contactStatusText(status: number): string {
  if (status === FRIEND_STATUS_OFFLINE) return "не в сети";
  if ((status & FRIEND_STATUS_AFK) !== 0) return "отошёл";
  if ((status & FRIEND_STATUS_DND) !== 0) return "не беспокоить";
  if ((status & FRIEND_STATUS_ONLINE) !== 0) return "в сети";
  return "в сети";
}

export function whoRows(result: WhoResult | undefined): WhoEntry[] {
  return result?.entries ?? [];
}

/** «Показано 12 из 40» — the row cap is the server's, and it reports both numbers. */
export function whoSummary(result: WhoResult | undefined): string {
  if (!result) return "Поиск ещё не выполнялся";
  if (result.matched === 0) return "Никого не найдено";
  return result.displayed < result.matched
    ? `Показано ${result.displayed} из ${result.matched}`
    : `Найдено: ${result.matched}`;
}

export interface WhoFormFields {
  name?: string | undefined;
  guild?: string | undefined;
  levelMin?: number | undefined;
  levelMax?: number | undefined;
  words?: readonly string[] | undefined;
  zones?: readonly number[] | undefined;
}

export interface WhoFormResult {
  request?: WhoRequest | undefined;
  /** What is wrong with the form, in Russian, or nothing when it is fine. */
  error?: string | undefined;
}

/**
 * Turns the form into a request, or says why it cannot.
 *
 * `buildWhoQuery` **throws** past ten zones or four words, so the caps are checked here rather
 * than discovered by an exception in the middle of a click handler.
 */
export function whoRequestFromForm(fields: WhoFormFields): WhoFormResult {
  const zones = [...(fields.zones ?? [])];
  const words = (fields.words ?? []).filter((word) => word.length > 0);
  if (zones.length > 10) return { error: "Не больше десяти зон в одном запросе" };
  if (words.length > 4) return { error: "Не больше четырёх слов в одном запросе" };
  const levelMin = fields.levelMin ?? 1;
  const levelMax = fields.levelMax ?? 80;
  if (levelMin > levelMax) return { error: "Нижняя граница уровня выше верхней" };

  const request: WhoRequest = { levelMin, levelMax };
  if (fields.name) request.name = fields.name;
  if (fields.guild) request.guild = fields.guild;
  if (zones.length > 0) request.zones = zones;
  if (words.length > 0) request.words = words;
  return { request };
}
