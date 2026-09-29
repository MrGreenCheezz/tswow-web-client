import assert from "node:assert/strict";
import test from "node:test";

const { GlueBrowserAudio, isSoundPath } = await import("../dist/code/browser/glue/GlueAudio.js");

/**
 * The glue screens' sound is addressed by `SoundEntries.Name`, not by path.
 *
 * `GlueParent.lua` has `CurrentGlueMusic = "GS_LichKing"` and
 * `GlueAmbienceTracks["HUMAN"] = "GlueScreenHuman"`, and `SetBackgroundModel` hands the second one
 * to `PlayGlueAmbience(track, 4.0)`. `/sound` takes a path and answered 400 to every one of them.
 * The rows below are what the running gateway returns for those names — measured, not invented.
 */
const KITS = {
  GlueScreenHuman: {
    id: 9903, type: 50, name: "GlueScreenHuman", volume: 0.30000001192092896,
    files: ["Sound\\Ambience\\ZoneAmbience\\ForestNormalDay.wav"],
  },
  GS_LichKing: {
    id: 12765, type: 28, name: "GS_LichKing", volume: 1,
    files: ["Sound\\Music\\GlueScreenMusic\\WotLK_main_title.mp3"],
  },
  gsCharacterCreationLook: {
    id: 817, type: 2, name: "gsCharacterCreationLook", volume: 0.75,
    files: ["Sound\\Interface\\uChatScrollButton.wav"],
  },
};

function fakeGateway() {
  const calls = [];
  const fetch = async (href) => {
    const url = new URL(href);
    calls.push(url.pathname + "?" + url.searchParams.toString());
    const names = (url.searchParams.get("names") ?? "").split(",").filter(Boolean);
    const named = names.filter((name) => KITS[name]).map((name) => ({ name, id: KITS[name].id }));
    return {
      ok: true,
      json: async () => ({ kits: named.map((entry) => KITS[entry.name]), named }),
    };
  };
  return { calls, fetch };
}

/** No `Audio` in node, so nothing plays — what is under test is the resolution, not the mixer. */
function audio(gateway) {
  return new GlueBrowserAudio({
    gatewayOrigin: "http://127.0.0.1:8090",
    fetch: gateway.fetch,
    gestureTarget: { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } },
  });
}

test("a path is told from a sound kit name without asking anybody", () => {
  assert.equal(isSoundPath("Sound\\Music\\GlueScreenMusic\\WotLK_main_title.mp3"), true);
  assert.equal(isSoundPath("Sound/Ambience/ZoneAmbience/ForestNormalDay.wav"), true);
  // The owner's `AccountLogin.lua` passes a bare path with no directory; the extension settles it.
  assert.equal(isSoundPath("WotLK_main_title.mp3"), true);
  assert.equal(isSoundPath("GlueScreenHuman"), false);
  assert.equal(isSoundPath("GS_LichKing"), false);
  assert.equal(isSoundPath("gsCharacterCreationLook"), false);
});

test("a kit name is resolved through /dbc/sounds and reported as its file", async () => {
  const gateway = fakeGateway();
  const sink = audio(gateway);
  sink.playMusic("GS_LichKing");
  sink.playAmbience("GlueScreenHuman", 4);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sink.report.music, "Sound\\Music\\GlueScreenMusic\\WotLK_main_title.mp3");
  assert.equal(sink.report.ambience, "Sound\\Ambience\\ZoneAmbience\\ForestNormalDay.wav");
  assert.deepEqual(sink.report.unresolvedKits, []);
  // Both names asked for in the same tick go out as one request.
  assert.equal(gateway.calls.length, 1, gateway.calls.join(" | "));
  assert.equal(gateway.calls[0], "/dbc/sounds?names=GS_LichKing%2CGlueScreenHuman");
});

test("a name the dataset has no row for is remembered once and reported, not re-asked", async () => {
  const gateway = fakeGateway();
  const sink = audio(gateway);
  sink.playSound("gsNoSuchKitAtAll");
  await new Promise((resolve) => setTimeout(resolve, 5));
  sink.playSound("gsNoSuchKitAtAll");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(sink.report.unresolvedKits, ["gsNoSuchKitAtAll"]);
  assert.equal(gateway.calls.length, 1, "the second ask is answered from the cache");
});

test("a name the route could not accept is refused here rather than turned into a 400", async () => {
  const gateway = fakeGateway();
  const sink = audio(gateway);
  // `/dbc/sounds` matches `names` against `^[A-Za-z0-9_]{1,64}$` and 400s the whole request
  // otherwise, which would take the legitimate names in the same batch down with it.
  sink.playSound("gs-Bad Name!");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(gateway.calls, []);
  assert.deepEqual(sink.report.unresolvedKits, ["gs-Bad Name!"]);
});

test("a path still goes straight to /sound, and stop clears what it started", async () => {
  const gateway = fakeGateway();
  const sink = audio(gateway);
  sink.playMusic("Sound\\Music\\GlueScreenMusic\\WotLK_main_title.mp3");
  assert.equal(sink.report.music, "Sound\\Music\\GlueScreenMusic\\WotLK_main_title.mp3");
  assert.deepEqual(gateway.calls, [], "a path needs no lookup");
  sink.stopMusic();
  assert.equal(sink.report.music, "");
  sink.stopAmbience(0);
  assert.equal(sink.report.ambience, "");
});

test("a screen change while a name is in flight does not start the track it left", async () => {
  const gateway = fakeGateway();
  const sink = audio(gateway);
  sink.playAmbience("GlueScreenHuman", 4);
  // The corpus' own order on a screen change: stop, then ask for the next one.
  sink.stopAmbience(0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sink.report.ambience, "", "the answer for the abandoned screen was dropped");
});
