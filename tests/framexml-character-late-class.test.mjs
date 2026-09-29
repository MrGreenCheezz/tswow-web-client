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

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");

const decoder = new TextDecoder("utf-8");

// The live mount can boot before the server has sent the player's own object: UnitClass("player")
// is nil while the stock VARIABLES_LOADED handler runs strupper() on it.
test("the stat panels fill in when the player's class arrives after VARIABLES_LOADED", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const provider = {
    async read(path) {
      const data = await chain.read(path);
      return data ? decoder.decode(data) : undefined;
    },
  };
  const seam = new CannedWorldSeam();
  let classKnown = false;
  seam.unitClass = (unit) => classKnown && unit === "player" ? ["Маг", "MAGE"] : undefined;
  const boot = new FrameXmlBoot({
    provider, locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam,
    screen: () => ({ width: 1024, height: 768 }),
  });
  const read = (source) => {
    const chunk = boot.vm.compileFunction(source, "@late-class", []);
    try { return boot.vm.call(chunk, [], 1)[0]; } finally { boot.vm.release(chunk); }
  };
  try {
    await boot.load();
    const errors = boot.vm.errors.filter((error) => /PaperDoll|strupper/i.test(String(error)));
    assert.deepEqual(errors, [], "VARIABLES_LOADED does not fail without a class");
    assert.equal(read(`return GetCVar("playerStatLeftDropdown")`), "PLAYERSTAT_BASE_STATS");
    assert.equal(read(`return GetCVar("playerStatRightDropdown")`), "PLAYERSTAT_MELEE_COMBAT",
      "before the class is known the right panel answers the stock fallback");
    // The stock stat setters themselves read the class on every update (strupper(UnitClass(...))),
    // so nothing can be drawn until it arrives; what must not happen is the panels staying empty
    // after it has. Before, the failed VARIABLES_LOADED left both choices "" for the session.
    classKnown = true;
    assert.equal(read(`return GetCVar("playerStatRightDropdown")`), "PLAYERSTAT_SPELL_COMBAT",
      "a caster gets the spell panel once its class is known");
    read("PaperDollFrame_UpdateStats() return true");
    for (const side of ["Left", "Right"]) {
      for (let index = 1; index <= 5; index++) {
        const label = boot.bridge.getFrame(`PlayerStatFrame${side}${index}Label`).text;
        assert.ok(label.length > 0, `PlayerStatFrame${side}${index} is filled after the class arrived`);
      }
    }
    assert.notEqual(boot.bridge.getFrame("PlayerStatFrameRight1Label").text, "Урон:", "the right panel is the spell one");

    read(`SetCVar("playerStatRightDropdown", "PLAYERSTAT_DEFENSES") return true`);
    assert.equal(read(`return GetCVar("playerStatRightDropdown")`), "PLAYERSTAT_DEFENSES", "an explicit choice wins");
  } finally {
    boot.close();
  }
});
