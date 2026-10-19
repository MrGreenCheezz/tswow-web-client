// 19.10: the quest tracker's CVars as Wow.exe registers them (0x0051d9b0: trackerFilter "7", trackerSorting "0",
// watchFrameWidth "0", autoQuestWatch "1", autoQuestProgress "1"). WatchFrame copies trackerFilter into
// WATCHFRAME_FILTER_TYPE at VARIABLES_LOADED (WatchFrame.lua:280); unanswered, the filter had no REMOTE_ZONES bit
// and the tracker listed only quests whose POI the displayed map placed — a TSWoW quest without quest_poi rows, or
// any quest in another zone, never showed.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";

const { FRAMEXML_NEUTRAL_PRELUDE } = await import("../dist/code/browser/framexml/FrameXmlNeutralApi.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");

let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

test("the neutral CVar map answers the tracker's registered defaults", () => {
  const vm = new GlueLuaVm();
  vm.setGlobal("__fxNeutralImpl", {});
  vm.setGlobal("__fxAddonModules", []);
  vm.setGlobal("__fxLocale", "ruRU");
  const loaded = vm.execute(FRAMEXML_NEUTRAL_PRELUDE, "@cvar:neutral");
  assert.equal(loaded.ok, true, loaded.error);
  const result = vm.execute(`
    local impl = __fxNeutralImpl
    assert(impl.GetCVar("trackerFilter") == "7", tostring(impl.GetCVar("trackerFilter")))
    assert(impl.GetCVarDefault("trackerFilter") == "7")
    assert(impl.GetCVar("trackerSorting") == "0")
    assert(impl.GetCVar("watchFrameWidth") == "0")
    assert(impl.GetCVar("autoQuestWatch") == "1")
    assert(impl.GetCVar("autoQuestProgress") == "1")
  `, "@tracker-cvars");
  assert.equal(result.ok, true, result.error);
});

test("MPQ WatchFrame lists a watched quest off the displayed map once VARIABLES_LOADED has read trackerFilter",
  withClient, async () => {
    const restore = installFakeUiDocument();
    try {
      const { clientArchives } = await import("../tools/mpq.mjs");
      const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
      const { CannedWorldSeam, CANNED_QUESTS, CANNED_ACTION_BAR, CANNED_CONTAINERS, CANNED_EQUIPMENT } =
        await import("../dist/code/browser/framexml/CannedWorldSeam.js");
      const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
      const chain = await clientArchives(clientDirectory);
      const decoder = new TextDecoder("utf-8");
      // The canned quest, watched, but with no POI on the displayed map (CURRENT_MAP_QUESTS stays empty).
      const quests = CANNED_QUESTS.map((quest) => ({ ...quest, currentMap: false }));
      const seam = new CannedWorldSeam(CANNED_ACTION_BAR, undefined, CANNED_CONTAINERS, CANNED_EQUIPMENT, quests);
      const boot = new FrameXmlBoot({
        provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
        locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false, screen: () => ({ width: 1024, height: 768 }),
      });
      await boot.load();
      assert.equal(seam.questNumWatches(), 1);
      assert.equal(seam.questMapUpdateAllQuests(), 0, "no quest of the log is on this map");
      // Before: the filter as the client left it (FrameXmlAchievementOwner's achievement bit alone) hides the quest.
      const before = boot.vm.execute(`
        WATCHFRAME_FILTER_TYPE = 1
        WatchFrame_Update(WatchFrame)
        assert(#VISIBLE_WATCHES == 0, "visible " .. #VISIBLE_WATCHES)
      `, "@tracker-before");
      assert.equal(before.ok, true, `no REMOTE_ZONES bit: nothing listed — ${before.error}`);
      const result = boot.vm.execute(`
        WatchFrame_OnEvent(WatchFrame, "VARIABLES_LOADED")
        assert(WATCHFRAME_FILTER_TYPE == 7, "filter " .. tostring(WATCHFRAME_FILTER_TYPE))
        WatchFrame_Update(WatchFrame)
        assert(#VISIBLE_WATCHES == 1, "visible " .. #VISIBLE_WATCHES)
      `, "@tracker-remote");
      assert.equal(result.ok, true, `the watched quest is listed — ${result.error}`);
      const title = boot.bridge.getFrame("WatchFrameTitle");
      assert.match(title.text, /\(\s*1\s*\)/, `the tracker counts the watched quest: ${title.text}`);
    } finally {
      restore?.();
    }
  });
