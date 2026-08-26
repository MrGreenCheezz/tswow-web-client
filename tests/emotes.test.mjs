import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { emoteById, emoteSentence, emoteStandState, findEmote } from "../dist/code/world/EmoteRules.js";
import { loadEmoteData } from "../dist/code/gateway/EmoteMetadata.js";
import { dbcDirectory } from "../tools/paths.mjs";
import {
  UNIT_STAND_STATE_KNEEL, UNIT_STAND_STATE_SIT, UNIT_STAND_STATE_SLEEP,
} from "../dist/code/world/CharacterProgressProtocol.js";

// Fixtures shaped like the rows the gateway builds. The slots are the table's own: 0 is what
// bystanders read when there is a target, 1 what the target reads, 2 what the emoter reads with a
// target, 4 and 6 the same two without one.
const wave = {
  id: 101, command: "wave", emoteId: 3,
  text: {
    0: "%s машет рукой |3-2(%s).",
    1: "%s машет вам рукой.",
    2: "Вы машете рукой |3-2(%s).",
    4: "%s машет рукой.",
    6: "Вы машете рукой.",
    12: "%s приветственно машет рукой.",
  },
};
const sit = { id: 86, command: "sit", emoteId: 13, text: {} };
const data = { emotes: [wave, sit] };

const named = (name, declined) => (declined ? { name, declined } : { name });

test("a command finds its row, and an unknown one finds nothing", () => {
  assert.equal(findEmote(data, "wave")?.id, 101);
  assert.equal(findEmote(data, "WAVE")?.id, 101, "commands are matched case-insensitively");
  assert.equal(findEmote(data, "чтоугодно"), undefined,
    "so the chat box still reaches its «Неизвестная команда» answer");
  assert.equal(findEmote(undefined, "wave"), undefined, "before the table lands there is no emote");
  assert.equal(emoteById(data, 101)?.command, "wave");
});

test("the emoter, the target and a bystander each read a different sentence", () => {
  const emoter = named("Иван");
  const target = named("Пётр", ["Петра", "Петру", "Петра", "Петром", "Петре"]);
  assert.equal(
    emoteSentence(wave, { emoter, target, selfIsEmoter: true, selfIsTarget: false }),
    "Вы машете рукой Петру.");
  assert.equal(
    emoteSentence(wave, { emoter, target, selfIsEmoter: false, selfIsTarget: true }),
    "Иван машет вам рукой.");
  assert.equal(
    emoteSentence(wave, { emoter, target, selfIsEmoter: false, selfIsTarget: false }),
    "Иван машет рукой Петру.");
});

test("with no target the wording changes and the name moves", () => {
  assert.equal(
    emoteSentence(wave, { emoter: named("Иван"), selfIsEmoter: false, selfIsTarget: false }),
    "Иван машет рукой.");
  assert.equal(
    emoteSentence(wave, { emoter: named("Иван"), selfIsEmoter: true, selfIsTarget: false }),
    "Вы машете рукой.");
});

test("a name with no declensions stays in the nominative rather than disappearing", () => {
  // Almost nobody fills them in, and the original client falls back the same way.
  assert.equal(
    emoteSentence(wave, { emoter: named("Иван"), target: named("Пётр"), selfIsEmoter: true, selfIsTarget: false }),
    "Вы машете рукой Пётр.");
});

test("the variant block is used only when the server echoes a variant", () => {
  const options = { emoter: named("Иван"), selfIsEmoter: false, selfIsTarget: false };
  assert.equal(emoteSentence(wave, options), "Иван машет рукой.");
  assert.equal(emoteSentence(wave, { ...options, variant: 1 }), "Иван приветственно машет рукой.");
});

test("a row with no sentence produces no line at all", () => {
  // `/sit` is a pose: the table leaves its text rows blank and the client is meant to say nothing.
  assert.equal(emoteSentence(sit, { emoter: named("Иван"), selfIsEmoter: true, selfIsTarget: false }), "");
});

test("sit, sleep and kneel also ask for a stand state, or nothing moves", () => {
  // HandleTextEmoteOpcode breaks out of its switch for these three and broadcasts no animation,
  // so the emote alone leaves the character standing while the sentence says otherwise.
  assert.equal(emoteStandState({ id: 86, command: "sit", emoteId: 13, text: {} }), UNIT_STAND_STATE_SIT);
  assert.equal(emoteStandState({ id: 87, command: "sleep", emoteId: 12, text: {} }), UNIT_STAND_STATE_SLEEP);
  assert.equal(emoteStandState({ id: 59, command: "kneel", emoteId: 68, text: {} }), UNIT_STAND_STATE_KNEEL);
  assert.equal(emoteStandState(wave), undefined, "waving is not a pose");
});

test("the real table names the commands and fills the sentences", async (t) => {
  let directory;
  try {
    directory = dbcDirectory();
  } catch {
    return t.skip("no dataset on this machine");
  }
  if (!existsSync(directory)) return t.skip("no dataset on this machine");
  const real = await loadEmoteData(directory);
  assert.equal(real.emotes.length > 200, true, "252 rows in this build");

  const dance = findEmote(real, "dance");
  assert.ok(dance, "«/dance» is a row in EmotesText, not a constant in this client");
  assert.equal(dance.emoteId, 10, "Emotes.dbc STATE_DANCE");
  assert.equal(dance.text[6].length > 0, true, "and it has something to say");

  // Sit's animation is a stand state, and the table says so by leaving the emote id at 13.
  assert.equal(emoteStandState(findEmote(real, "sit")), UNIT_STAND_STATE_SIT);
});
