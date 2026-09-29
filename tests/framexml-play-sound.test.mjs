import assert from "node:assert/strict";
import test from "node:test";

import { FRAMEXML_SEAM_BINDINGS } from "../dist/code/browser/framexml/FrameXmlWorldSeam.js";
import { CannedWorldSeam } from "../dist/code/browser/framexml/CannedWorldSeam.js";
import { LiveWorldSeam } from "../dist/code/browser/framexml/LiveWorldSeam.js";
import { game } from "../dist/code/browser/game/Context.js";
import {
  forgetGameSounds, playNamedUiSound, retryPendingSounds,
} from "../dist/code/browser/game/GameSounds.js";
import { SoundClient } from "../dist/code/browser/SoundClient.js";

test("stock PlaySound binding forwards valid names and no value", () => {
  const canned = new CannedWorldSeam();
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.PlaySound(canned, ["igQuestListOpen"]), []);
  assert.deepEqual(canned.playedSoundNames, ["igQuestListOpen"]);
  for (const value of [undefined, 875, "", "bad/name", "x".repeat(65)]) {
    assert.deepEqual(FRAMEXML_SEAM_BINDINGS.PlaySound(canned, [value]), []);
  }
  assert.deepEqual(canned.playedSoundNames, ["igQuestListOpen"]);

  const requested = [];
  const live = new LiveWorldSeam({
    world: () => undefined, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell() {},
    playSound: (name) => requested.push(name),
  });
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.PlaySound(live, ["WriteQuest"]), []);
  assert.deepEqual(requested, ["WriteQuest"]);
});

test("named FrameXML sound plays the first click after metadata loads and caches absence", async () => {
  const previous = { fetch: globalThis.fetch, sound: game.sound, soundKits: game.soundKits };
  const requested = [];
  const played = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const names = (url.searchParams.get("names") ?? "").split(",").filter(Boolean);
    requested.push(names);
    return {
      ok: true, json: async () => ({
        kits: names.includes("igQuestListOpen") ? [{
          id: 875, type: 6, name: "igQuestListOpen", files: ["Sound\\Interface\\iQuestLogOpenA.wav"],
          volume: 1, minDistance: 8, maxDistance: 45, flags: 0,
        }] : [],
        named: names.includes("igQuestListOpen") ? [{ name: "igQuestListOpen", id: 875 }] : [],
        music: [], intro: [], ambience: [], creatures: [],
      }),
    };
  };
  try {
    const kits = new SoundClient("ws://127.0.0.1:8090/auth");
    kits.onLoaded = retryPendingSounds;
    game.soundKits = kits;
    game.sound = { play: (kit, options) => played.push([kit.id, options.channel]) };
    forgetGameSounds();

    playNamedUiSound("igQuestListOpen");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(requested, [["igQuestListOpen"]]);
    assert.deepEqual(played, [[875, "interface"]]);
    assert.equal(kits.namedAnswered("igQuestListOpen"), true);

    playNamedUiSound("NoSuchQuestSound");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(requested, [["igQuestListOpen"], ["NoSuchQuestSound"]]);
    assert.equal(kits.namedAnswered("NoSuchQuestSound"), true);
    playNamedUiSound("NoSuchQuestSound");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requested.length, 2);
    assert.deepEqual(played, [[875, "interface"]]);
  } finally {
    forgetGameSounds();
    globalThis.fetch = previous.fetch;
    game.sound = previous.sound;
    game.soundKits = previous.soundKits;
  }
});

test("selected QuestFrame sound names resolve in its SoundEntries.dbc", async (t) => {
  let clientDirectory;
  let dbcDirectory;
  try {
    const paths = await import("../tools/paths.mjs");
    clientDirectory = paths.clientDirectory();
    dbcDirectory = paths.dbcDirectory();
  } catch {
    t.skip("selected client or dataset unavailable");
    return;
  }
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { openDbcFile } = await import("../tools/dbc.mjs");
  const archives = await clientArchives(clientDirectory);
  try {
    const decoder = new TextDecoder();
    const source = await Promise.all(["QuestFrame.lua", "QuestInfo.lua"].map(async (file) => {
      const bytes = await archives.read(`Interface\\FrameXML\\${file}`);
      assert.ok(bytes, `${file} must come from the selected client`);
      return decoder.decode(bytes);
    }));
    const names = new Set([...source.join("\n").matchAll(/^\s*PlaySound\("([^"]+)"\)/gm)]
      .map((match) => match[1]));
    assert.deepEqual([...names].sort(), [
      "WriteQuest", "igQuestCancel", "igQuestListClose", "igQuestListOpen", "igQuestListSelect",
    ]);
    const dbc = await openDbcFile(dbcDirectory, "SoundEntries");
    const ids = new Map([...dbc.rows()].map((row) => [dbc.string(row, "Name"), dbc.id(row)]));
    assert.deepEqual([...names].map((name) => ids.get(name)).sort((a, b) => a - b),
      [875, 876, 877, 879, 3093]);
  } finally {
    archives.close();
  }
});
