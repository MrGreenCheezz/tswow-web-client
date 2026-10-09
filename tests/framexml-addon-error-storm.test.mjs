import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// The live mount loads the client's eager add-ons (gateway /client/addons: AnyIDTooltip and
// MikScrollingBattleText). On the canned route — which has a pet, like many live sessions —
// MSBTParser.lua:767-769 raised «table index is nil» once per rendered frame while UnitGUID was
// unanswered (4,007 of 4,237 handled errors in the diagnosis census, enough for stock
// TOO_MANY_LUA_ERRORS), and AnyIDTooltip's captured-nil UnitGUID raised on every
// GameTooltip:SetUnit (core.lua:212). Both add-ons are read from the client's own loose
// Interface/AddOns, the same files the gateway serves.
let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const ADDONS = ["AnyIDTooltip", "MikScrollingBattleText"];
const available = clientDirectory !== undefined
  && ADDONS.every((name) => existsSync(join(clientDirectory, "Interface", "AddOns", name)));
const withAddons = { skip: available ? false : "the client's AnyIDTooltip/MikScrollingBattleText are not installed" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");

test("eager client add-ons run frames and unit tooltips without a per-frame Lua error", withAddons, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: { read: async (path) => { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam,
    installedAddons: [...ADDONS, "MSBTOptions"], eagerAddons: ADDONS,
    screen: () => ({ width: 1024, height: 768 }),
  });
  const handled = [];
  try {
    await boot.load();
    assert.deepEqual(boot.addonResults.filter((result) => !result.ok).map((result) => result.name), [],
      "both add-ons load");
    boot.vm.registerGlobal("__stormNote", (args) => { handled.push(String(args[0])); return []; });
    assert.equal(boot.vm.execute(
      "local note = __fxNoteError; __fxNoteError = function(m) __stormNote(m) return note(m) end",
      "@storm/hook").ok, true);
    const frames = (count) => {
      for (let index = 0; index < count; index += 1) {
        boot.bridge.runInMutationBatch(() => {
          boot.tickSeam(boot.pump.now());
          boot.bridge.tick(1 / 60);
        });
      }
    };
    frames(120);
    const player = boot.bridge.getFrame("PlayerFrame");
    boot.bridge.fireScript(player, "OnEnter", false);
    frames(60);
    boot.bridge.fireScript(player, "OnLeave");
    frames(2);
    // MSBTTriggers.lua:711 divides UnitMana by UnitManaMax on every player UNIT_MANA; with the
    // 3.3.5 alias unanswered that raised msbttriggers.lua:526 on each mana change.
    for (let index = 0; index < 3; index += 1) {
      boot.pump.fire("UNIT_MANA", "player");
      frames(1);
    }

    const storm = handled.filter((message) => /msbtparser\.lua|msbttriggers\.lua|anyidtooltip\/core\.lua/i.test(message));
    assert.deepEqual(storm, [], `per-frame add-on errors: ${storm.slice(0, 3).join(" | ")}`);
    const chunk = boot.vm.compileFunction("return UnitGUID('pet'), UnitGUID('player')", "@storm/guid", []);
    try {
      assert.deepEqual(boot.vm.call(chunk, [], 2), ["0xF140000000000104", "0x0000000000000001"]);
    } finally {
      boot.vm.release(chunk);
    }
    const mana = boot.vm.compileFunction(
      "return UnitMana('player') == UnitPower('player'), type(UnitMana('player')), UnitManaMax('player') == UnitPowerMax('player')",
      "@storm/mana", []);
    try {
      assert.deepEqual(boot.vm.call(mana, [], 3), [true, "number", true],
        "UnitMana/UnitManaMax answer like the client's UnitPower/UnitPowerMax");
    } finally {
      boot.vm.release(mana);
    }
  } finally {
    boot.close();
  }
});
