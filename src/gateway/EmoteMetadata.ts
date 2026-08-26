// `EmotesText.dbc` joined to `EmotesTextData.dbc`, whole.
//
// 252 rows, five short sentences each. Sent in one piece because the question it answers — what
// does `/dance` mean, and what do I print when someone does it near me — is asked the moment a
// player types a slash and cannot wait for a round trip, and because the whole table is smaller
// than one icon.
//
// The command list is the table's own `Name` column. Nothing about which emotes exist, what they
// are called or what they say is written down in this client.

import { openDbcFile } from "./Dbc.js";
import type { EmoteData, EmoteEntry } from "../world/EmoteRules.js";

/** `EmotesText.EmoteText[16]` — sixteen row ids into `EmotesTextData`, most of them zero. */
const EMOTE_TEXT_SLOTS = 16;

export async function loadEmoteData(dbcDirectory: string): Promise<EmoteData> {
  const [texts, sentences] = await Promise.all([
    openDbcFile(dbcDirectory, "EmotesText"),
    openDbcFile(dbcDirectory, "EmotesTextData"),
  ]);

  const words = new Map<number, string>();
  for (const row of sentences.rows()) {
    const value = sentences.locstring(row, "Text_lang");
    if (value) words.set(sentences.id(row), value);
  }

  const emotes: EmoteEntry[] = [];
  for (const row of texts.rows()) {
    const command = texts.string(row, "Name").toLowerCase();
    if (!command) continue;
    const text: Record<number, string> = {};
    for (let slot = 0; slot < EMOTE_TEXT_SLOTS; slot++) {
      const sentence = words.get(texts.int(row, "EmoteText", slot));
      if (sentence) text[slot] = sentence;
    }
    emotes.push({ id: texts.id(row), command, emoteId: texts.int(row, "EmoteID"), text });
  }
  return { emotes };
}
