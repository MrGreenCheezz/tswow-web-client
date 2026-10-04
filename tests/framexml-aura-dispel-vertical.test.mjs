import assert from "node:assert/strict";
import test from "node:test";

// 5.20 through the stock BuffFrame.lua (MPQ): the debuffType strings UnitAura hands out are the
// DebuffTypeColor keys, so every debuff border takes its stock colour and nothing raises — ""
// (Enrage) included, which the stock table aliases to "none" (BuffFrame.lua:16-21).
let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");

const TYPES = ["Magic", "Curse", "Disease", "Poison", "", undefined];
const EXPECTED = [
  [0.2, 0.6, 1], [0.6, 0, 1], [0.6, 0.4, 0], [0, 0.6, 0], [0.8, 0, 0], [0.8, 0, 0],
];

test("MPQ BuffFrame colours each debuff border by the UnitAura debuffType", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  let boot;
  try {
    const seam = new CannedWorldSeam();
    const canned = seam.unitAura.bind(seam);
    seam.unitAura = (unit, index, filter) => {
      if (unit !== "player" || filter !== "HARMFUL") return canned(unit, index, filter);
      if (index < 1 || index > TYPES.length) return undefined;
      return [`Дебафф ${index}`, "", "Interface\\Icons\\Spell_Shadow_Abomination", 1, TYPES[index - 1],
        0, 0, undefined, false, false, 1000 + index];
    };
    boot = new FrameXmlBoot({
      provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
      locale: "ruRU",
      subset: FRAMEXML_VERTICAL_TOC,
      seam,
      screen: () => ({ width: 1024, height: 768 }),
    });
    const inventory = await boot.load();
    const errorsBefore = inventory.lua.errorsRaised;
    boot.bridge.dispatchEvent(FRAMEXML_SEAM_EVENTS.aura, "player");
    boot.bridge.tick(0.1);
    for (let index = 1; index <= TYPES.length; index++) {
      const border = boot.bridge.getFrame(`DebuffButton${index}Border`);
      assert.ok(border, `DebuffButton${index}Border exists`);
      const color = border.vertexColor;
      assert.ok(color, `border ${index} is coloured`);
      assert.deepEqual([color.r, color.g, color.b].map((value) => Math.round(value * 100) / 100), EXPECTED[index - 1],
        `debuffType ${JSON.stringify(TYPES[index - 1])}`);
    }
    assert.equal(boot.inventory?.lua?.errorsRaised ?? errorsBefore, errorsBefore, "no Lua error on any type");
  } finally {
    boot?.close();
    chain.close();
  }
});
