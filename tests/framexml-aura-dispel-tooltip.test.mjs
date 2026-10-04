import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");

// 5.20: the aura tooltip's dispel name. Wow.exe SetUnitAura (0x00626240 → 0x00625f00 → 0x00625350)
// writes the aura's title with, on its right, the SpellDispelType row's localised Name when the
// spell's DispelType is not 0 and that row's ImmunityPossible is set — both halves in one colour
// (one 0x0061fec0 call). The name comes with `/dbc/spells?v=15` (`dispelName`); none, none drawn.
const FIXTURE = `
UIParent = CreateFrame("Frame", "UIParent")
UIParent:SetSize(1024, 768)
Owner = CreateFrame("Button", "Owner", UIParent)
Owner:SetSize(40, 20)
GameTooltip = CreateFrame("GameTooltip", "GameTooltip", UIParent)
Auras = {}
function UnitAura(unit, index, filter)
  local a = Auras[index]
  if a then return a[1], "", "", 0, nil, 0, 0, "player", nil, nil, a[2] end
end
`;

test("SetUnitAura writes the dispel type's name right of the title, in the title's colour", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "TooltipFonts.xml\nTooltip.lua",
      "interface/framexml/tooltipfonts.xml": `<Ui>
        <Font name="GameTooltipHeaderText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="14"/></FontHeight></Font>
        <Font name="GameTooltipText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="12"/></FontHeight></Font>
      </Ui>`,
      "interface/framexml/tooltip.lua": FIXTURE,
    }),
    subset: ["TooltipFonts.xml", "Tooltip.lua"],
    exercise: false,
    gameTooltipAdapter: {
      inventoryItem: () => undefined,
      containerItem: () => undefined,
      item: () => undefined,
      spell: () => undefined,
      aura: (id) => ({ title: `Аура ${id}`, lines: [{ text: "Описание.", tone: "description", wrap: true }] }),
      auraDispelName: (id) => (id === 118 ? "Магия" : undefined),
    },
  });
  await boot.load();
  const run = (source, results = 0) => {
    const chunk = boot.vm.compileFunction(source, "@aura-dispel-tooltip", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
  };
  const line = (side, index) => boot.bridge.getFrame(`GameTooltipText${side}${index}`);
  try {
    run(`Auras[1] = { "Превращение", 118 } Auras[2] = { "Боевой крик", 6673 }`);
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_BOTTOMLEFT")`);
    assert.deepEqual(run(`return GameTooltip:SetUnitAura("player", 1, "HARMFUL")`, 1), [true]);
    assert.equal(line("Left", 1).text, "Превращение");
    assert.equal(line("Right", 1).text, "Магия");
    assert.equal(line("Right", 1).visible, true);
    const [left, right] = [line("Left", 1).textColor, line("Right", 1).textColor];
    assert.deepEqual([right.r, right.g, right.b], [left.r, left.g, left.b], "one colour for the whole title row");
    assert.equal(line("Left", 2).text, "Описание.");

    assert.deepEqual(run(`return GameTooltip:SetUnitAura("player", 2, "HELPFUL")`, 1), [true]);
    assert.equal(line("Left", 1).text, "Боевой крик");
    assert.ok(!line("Right", 1)?.visible || line("Right", 1).text === "", "no type, no name");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});
