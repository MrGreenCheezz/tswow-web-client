import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

let sharedChain;
async function verticalProvider() {
  if (!sharedChain) {
    const { clientArchives } = await import("../tools/mpq.mjs");
    sharedChain = await clientArchives(clientDirectory);
  }
  const decoder = new TextDecoder("utf-8");
  return {
    async read(path) {
      const data = await sharedChain.read(path.replaceAll("/", "\\"));
      return data ? decoder.decode(data) : undefined;
    },
  };
}

const {
  FrameXmlBoot,
  FRAMEXML_VERTICAL_EXERCISE_EVENTS,
} = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");

function callLua(boot, name, args, results = 1) {
  const ref = boot.vm.globalFunction(name);
  assert.ok(ref, `${name} must be installed by the neutral API`);
  try {
    return boot.vm.call(ref, args, results);
  } finally {
    boot.vm.release(ref);
  }
}

test("vertical PLAYER_ENTERING_WORLD keeps the empty GM CVar neutral", withClient, async () => {
  const boot = new FrameXmlBoot({
    provider: await verticalProvider(),
    subset: FRAMEXML_VERTICAL_TOC,
    locale: "ruRU",
    screen: () => ({ width: 1024, height: 768 }),
    exercise: true,
    exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS,
  });
  try {
    const inventory = await boot.load();
    assert.deepEqual(inventory.exercise.events, [...FRAMEXML_VERTICAL_EXERCISE_EVENTS],
      "the vertical exercise raises the session edges in order; PLAYER_LOGIN finds CombatLog_LoadUI refused");

    assert.deepEqual(callLua(boot, "GetCVar", ["lastTalkedToGM"]), [""],
      "the measured default CVar must be an empty string");
    assert.deepEqual(callLua(boot, "GetCVar", ["framexml_unknown_cvar"]), [undefined],
      "an arbitrary unregistered CVar must remain nil");
    assert.deepEqual(callLua(boot, "SetCVar", ["framexml_test_cvar", "42"]), [true]);
    assert.deepEqual(callLua(boot, "GetCVar", ["framexml_test_cvar"]), ["42"],
      "stateful SetCVar/GetCVar round-trip must remain intact");

    const addonCalls = [];
    boot.vm.registerGlobal("__framexmlRecordLoadAddOn", (args) => {
      addonCalls.push(String(args[0] ?? ""));
      return [];
    });
    const wrapper = boot.vm.execute(`
      do
        local originalLoadAddOn = LoadAddOn
        LoadAddOn = function(name)
          __framexmlRecordLoadAddOn(name)
          return originalLoadAddOn(name)
        end
      end
    `, "@framexml-cvar-test");
    assert.equal(wrapper.ok, true, wrapper.error);

    boot.bridge.dispatchEvent("PLAYER_ENTERING_WORLD");
    assert.ok(!addonCalls.includes("Blizzard_GMChatUI"),
      "an empty lastTalkedToGM must not load Blizzard_GMChatUI");

    const errorFrame = boot.bridge.getFrame("BasicScriptErrors");
    const errorText = boot.bridge.getFrame("BasicScriptErrorsText");
    assert.ok(errorFrame, "the vertical must still instantiate BasicScriptErrors");
    assert.doesNotMatch(errorText?.text ?? "", /Blizzard_GMChatUI|Blizzard_CombatLog/,
      "BasicScriptErrors must not mention addons outside the vertical subset");
    assert.equal(boot.bridge.getFrame("PlayerFrame")?.visible, true,
      "PLAYER_ENTERING_WORLD must initialize PlayerFrame");
    assert.equal(boot.bridge.getFrame("MainMenuBar")?.visible, true,
      "PLAYER_ENTERING_WORLD must initialize MainMenuBar");
    assert.ok(boot.bridge.getFrame("CastingBarFrame"),
      "the vertical must reach the player cast bar frame");
  } finally {
    boot.close();
    sharedChain?.close();
    sharedChain = undefined;
  }
});
