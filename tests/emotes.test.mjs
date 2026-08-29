import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emoteById, emoteSentence, emoteSoundId, emoteStandState, findEmote } from "../dist/code/world/EmoteRules.js";
import { loadEmoteData } from "../dist/code/gateway/EmoteMetadata.js";
import { EMOTE_ROUTE_VERSION, EmoteClient } from "../dist/code/browser/EmoteClient.js";
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

function intDbc(rows, fields) {
  const result = new Uint8Array(20 + rows.length * fields * 4);
  result.set(new TextEncoder().encode("WDBC"));
  const view = new DataView(result.buffer);
  view.setUint32(4, rows.length, true);
  view.setUint32(8, fields, true);
  view.setUint32(12, fields * 4, true);
  for (let row = 0; row < rows.length; row++) {
    for (let field = 0; field < fields; field++) {
      view.setUint32(20 + (row * fields + field) * 4, rows[row][field] ?? 0, true);
    }
  }
  return result;
}

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

test("the typed emote sound lookup is exact and has no race/sex fallback", () => {
  const sounds = {
    emotes: [],
    sounds: [
      { id: 1, textEmoteId: 101, raceId: 1, gender: 0, soundId: 2942 },
      { id: 2, textEmoteId: 101, raceId: 1, gender: 1, soundId: 2943 },
    ],
  };
  assert.equal(emoteSoundId(sounds, 101, 1, 0), 2942);
  assert.equal(emoteSoundId(sounds, 101, 1, 1), 2943);
  assert.equal(emoteSoundId(sounds, 101, 2, 0), undefined, "unknown race stays silent");
  assert.equal(emoteSoundId(sounds, 999, 1, 0), undefined, "unknown text emote stays silent");
  assert.equal(emoteSoundId({ emotes: [] }, 101, 1, 0), undefined, "old payloads have no overlay");
});

test("EmoteClient cache-busts the client-media route", async () => {
  const previous = globalThis.fetch;
  let requested;
  let loaded;
  globalThis.fetch = async (url) => {
    requested = String(url);
    return { ok: true, async json() { return { emotes: [], sounds: [] }; } };
  };
  try {
    const client = new EmoteClient("ws://127.0.0.1:8090");
    const done = new Promise((resolve) => { client.onLoaded = resolve; });
    client.load();
    loaded = await done;
    assert.equal(requested, `http://127.0.0.1:8090/dbc/emotes?v=${EMOTE_ROUTE_VERSION}`);
    assert.deepEqual(loaded.sounds, []);
  } finally {
    globalThis.fetch = previous;
  }
});

test("EmotesTextSound is read only from the active media override", async (t) => {
  let directory;
  try {
    directory = dbcDirectory();
  } catch {
    return t.skip("no dataset on this machine");
  }
  if (!existsSync(directory)) return t.skip("no dataset on this machine");
  const media = await mkdtemp(join(tmpdir(), "webclient-emote-media-"));
  try {
    await writeFile(join(media, "EmotesTextSound.dbc"), intDbc([
      [1, 101, 1, 0, 2942],
      [2, 101, 1, 1, 2943],
    ], 5));
    const datasetOnly = await loadEmoteData(directory);
    assert.deepEqual(datasetOnly.sounds, [], "dataset EmotesTextSound is not a gameplay fallback");
    const active = await loadEmoteData(directory, media);
    assert.equal(active.sounds.length, 2);
    assert.equal(emoteSoundId(active, 101, 1, 0), 2942);
    assert.equal(emoteSoundId(active, 101, 1, 1), 2943);
    await writeFile(join(media, "EmotesTextSound.dbc"), intDbc([[1, 101, 1, 0]], 4));
    await assert.rejects(loadEmoteData(directory, media), /EmotesTextSound/,
      "a present audio overlay with the wrong layout must fail loudly");
  } finally {
    await rm(media, { recursive: true, force: true });
  }
});

test("active patch-W EmotesTextSound keeps its 240-row client-media delta", async (t) => {
  let directory;
  try {
    directory = dbcDirectory();
  } catch {
    return t.skip("no dataset on this machine");
  }
  if (!existsSync(directory)) return t.skip("no dataset on this machine");
  const media = resolve(process.env.VISUAL_DBC_DIR ?? join(process.cwd(), "data", "visual-dbc"));
  const mediaFile = join(media, "EmotesTextSound.dbc");
  if (!existsSync(mediaFile)) return t.skip("active client-media EmotesTextSound.dbc is absent");
  try {
    const stamp = JSON.parse(readFileSync(`${mediaFile}.src`, "utf8"));
    if (!stamp.sources?.some((source) => /^patch-w\.mpq$/i.test(source.name))) {
      return t.skip("active client-media DBCs are not sourced from patch-W");
    }
  } catch {
    return t.skip("active client-media DBC provenance is unavailable");
  }

  const active = await loadEmoteData(directory, media);
  assert.equal(active.sounds.length, 782, "patch-W has 542 base rows plus 240 additions");
  const added = active.sounds.filter((sound) => sound.id >= 600 && sound.id <= 839);
  assert.equal(added.length, 240);
  assert.deepEqual(
    added.map((sound) => sound.id).toSorted((left, right) => left - right),
    Array.from({ length: 240 }, (_, index) => index + 600),
    "the added IDs are the contiguous patch-W range 600..839",
  );
  assert.equal(new Set(added.map((sound) =>
    `${sound.textEmoteId}:${sound.raceId}:${sound.gender}`)).size, 240,
    "each added row has a distinct text-emote/race/sex tuple");
  const expectedTextEmotes = [20, 22, 23, 31, 45, 47, 52, 58, 60, 65, 76, 136];
  const expectedRaces = [1, 2, 3, 4, 5, 6, 7, 8, 10, 11];
  assert.deepEqual([...new Set(added.map((sound) => sound.textEmoteId))].toSorted((a, b) => a - b), expectedTextEmotes);
  assert.deepEqual([...new Set(added.map((sound) => sound.raceId))].toSorted((a, b) => a - b), expectedRaces);
  assert.deepEqual([...new Set(added.map((sound) => sound.gender))].toSorted((a, b) => a - b), [0, 1]);
  for (const textEmoteId of expectedTextEmotes) {
    for (const raceId of expectedRaces) {
      for (const gender of [0, 1]) {
        assert.ok(added.some((sound) =>
          sound.textEmoteId === textEmoteId && sound.raceId === raceId && sound.gender === gender),
        `${textEmoteId}/${raceId}/${gender} is present in the active delta`);
      }
    }
  }
  const soundIds = added.map((sound) => sound.soundId);
  assert.ok(soundIds.every((soundId) => soundId > 0), "all added rows point at a positive SoundEntries id");
  assert.equal(new Set(soundIds).size, 80, "the active delta resolves to 80 unique sounds");
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
