/**
 * What `/dance` means, and what the client says when someone else does it.
 *
 * `SMSG_TEXT_EMOTE` carries three numbers and, sometimes, a name: which emote, which variant, who
 * it was aimed at. Not one word of the sentence is on the wire — every client writes it from
 * `EmotesText.dbc`, which holds a row id per point of view into `EmotesTextData.dbc`, which holds
 * the words. This client was parsing the packet and throwing it away, so `/dance` produced silence
 * from both ends: nothing was sent, and nothing would have been said if it had been.
 *
 * The table itself comes from the gateway, the same arrangement as `FactionRules.ts`: the shape
 * lives here, the rows are loaded once, and nothing about an emote is written down in code.
 */

import { UNIT_STAND_STATE_KNEEL, UNIT_STAND_STATE_SIT, UNIT_STAND_STATE_SLEEP } from "./CharacterProgressProtocol.js";

/**
 * Which sentence to use, by who is reading it.
 *
 * The sixteen `EmoteText` slots of a row are sparse and their meaning is positional. Measured
 * across the whole table and corroborated by the reference client, which reads fields 3, 5, 7 and
 * 9 — that is, slots 0, 2, 4 and 6.
 */
export const EMOTE_SLOT_OTHERS_TARGET = 0;
export const EMOTE_SLOT_TARGET = 1;
export const EMOTE_SLOT_SELF_TARGET = 2;
export const EMOTE_SLOT_OTHERS = 4;
export const EMOTE_SLOT_SELF = 6;
/** Slots 8..15 repeat the block for `emoteNum` 1, which a few emotes use to vary the wording. */
export const EMOTE_VARIANT_OFFSET = 8;

export interface EmoteEntry {
  /** `EmotesText.ID` — the number `CMSG_TEXT_EMOTE` carries. */
  readonly id: number;
  /** `EmotesText.Name` lowercased. The table *is* the command list; nothing here is invented. */
  readonly command: string;
  /** `Emotes.ID`. Zero when the row names no animation at all. */
  readonly emoteId: number;
  /** Sentences by slot, sparse — most rows fill five of the sixteen. */
  readonly text: Readonly<Record<number, string>>;
}

export interface EmoteData {
  readonly emotes: readonly EmoteEntry[];
  /** Client-media rows only; the dataset intentionally does not supply this overlay. */
  readonly sounds?: readonly EmoteSound[];
}

/** One strict `EmotesTextSound.dbc` row, keyed by the source's text-emote/race/sex tuple. */
export interface EmoteSound {
  /** `EmotesTextSound.ID`, retained to audit an active client-media delta. */
  readonly id: number;
  readonly textEmoteId: number;
  readonly raceId: number;
  readonly gender: number;
  readonly soundId: number;
}

/** Typed lookup for the source-specific client sound, with no fallback to a gameplay table. */
export function emoteSoundId(data: EmoteData | undefined, textEmoteId: number,
  raceId: number, gender: number): number | undefined {
  const row = data?.sounds?.find((sound) =>
    sound.textEmoteId === textEmoteId && sound.raceId === raceId && sound.gender === gender);
  return row?.soundId;
}

/**
 * The three emotes the server deliberately refuses to broadcast.
 *
 * `HandleTextEmoteOpcode` breaks out of its switch for sleep, sit and kneel and sends no
 * `SMSG_EMOTE` at all: they are poses, and a pose is a stand state the client asks for separately.
 * Without this the packet goes out, the sentence appears, and the character keeps standing.
 */
const STAND_STATE_BY_EMOTE: Readonly<Record<number, number>> = {
  12: UNIT_STAND_STATE_SLEEP,
  13: UNIT_STAND_STATE_SIT,
  68: UNIT_STAND_STATE_KNEEL,
};

export function emoteStandState(entry: EmoteEntry): number | undefined {
  return STAND_STATE_BY_EMOTE[entry.emoteId];
}

/** The row a slash command names, by the table's own `Name` column. */
export function findEmote(data: EmoteData | undefined, command: string): EmoteEntry | undefined {
  if (!data) return undefined;
  const wanted = command.toLowerCase();
  return data.emotes.find((entry) => entry.command === wanted);
}

/** The row `SMSG_TEXT_EMOTE` names. */
export function emoteById(data: EmoteData | undefined, id: number): EmoteEntry | undefined {
  return data?.emotes.find((entry) => entry.id === id);
}

/** A name and, when the player bothered to fill them in at creation, its five Russian cases. */
export interface EmoteName {
  readonly name: string;
  /** Genitive, dative, accusative, instrumental, prepositional — `MAX_DECLINED_NAME_CASES`. */
  readonly declined?: readonly string[] | undefined;
}

/**
 * Which slot to read, and which names fill its `%s` holes, from who is watching.
 *
 * The order is the client's own: a line written for bystanders names the emoter first and the
 * target second; a line written for the emoter names only the target, because it starts with «Вы».
 */
function slotFor(selfIsEmoter: boolean, selfIsTarget: boolean, hasTarget: boolean): {
  slot: number; fill: ReadonlyArray<"emoter" | "target">;
} {
  if (selfIsEmoter) {
    return hasTarget
      ? { slot: EMOTE_SLOT_SELF_TARGET, fill: ["target"] }
      : { slot: EMOTE_SLOT_SELF, fill: [] };
  }
  if (selfIsTarget) return { slot: EMOTE_SLOT_TARGET, fill: ["emoter"] };
  return hasTarget
    ? { slot: EMOTE_SLOT_OTHERS_TARGET, fill: ["emoter", "target"] }
    : { slot: EMOTE_SLOT_OTHERS, fill: ["emoter"] };
}

/**
 * `|3-N(word)` — decline `word` into Russian case N.
 *
 * The dataset is ruRU and every sentence with a target carries one. The cases are the five the
 * name query can carry; a player who never filled them in keeps the nominative, which is exactly
 * what the original client falls back to.
 */
function decline(name: EmoteName, grammaticalCase: number): string {
  const declined = name.declined?.[grammaticalCase - 1];
  return declined && declined.length > 0 ? declined : name.name;
}

const DECLENSION = /\|3-(\d)\(([^)]*)\)/g;

/**
 * One emote, written out for one reader.
 *
 * Returns an empty string when the row has no sentence for that point of view — `/sit` is the
 * example: it is a pose, and the table leaves its text rows blank on purpose.
 */
export function emoteSentence(entry: EmoteEntry, options: {
  emoter: EmoteName;
  target?: EmoteName | undefined;
  selfIsEmoter: boolean;
  selfIsTarget: boolean;
  variant?: number | undefined;
}): string {
  const hasTarget = options.target !== undefined && options.target.name.length > 0;
  const { slot, fill } = slotFor(options.selfIsEmoter, options.selfIsTarget, hasTarget);
  const variant = options.variant ?? 0;
  const template = (variant > 0 ? entry.text[slot + EMOTE_VARIANT_OFFSET] : undefined) ?? entry.text[slot];
  if (!template) return "";

  let used = 0;
  const nextName = (): EmoteName => {
    const which = fill[used] ?? fill[fill.length - 1] ?? "emoter";
    used++;
    return which === "target" ? options.target ?? options.emoter : options.emoter;
  };
  // The declensions are resolved first so that the `%s` inside one is filled by the same walk as
  // the `%s` outside it, in the order they appear.
  const parts: Array<{ at: number; length: number; grammaticalCase: number; inner: string }> = [];
  for (const match of template.matchAll(DECLENSION)) {
    parts.push({ at: match.index, length: match[0].length, grammaticalCase: Number(match[1]), inner: match[2] ?? "" });
  }

  let out = "";
  let at = 0;
  for (const part of parts) {
    out += template.slice(at, part.at).replace(/%s/g, () => nextName().name);
    out += part.inner.includes("%s") ? decline(nextName(), part.grammaticalCase) : part.inner;
    at = part.at + part.length;
  }
  out += template.slice(at).replace(/%s/g, () => nextName().name);
  return out;
}
