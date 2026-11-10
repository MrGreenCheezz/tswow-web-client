import assert from "node:assert/strict";
import test from "node:test";

// Plan item 4.04 (11.11): GameTooltip:AddTexture as Wow.exe 3.3.5a 12340 draws it (0x0061d810 → 0x0061c8b0, undone by
// ClearLines' 0x0061c620; glue/GlueTooltipTextures.ts), and the threat row's icon SetUnit puts on its line, over the
// offline FrameXML fixture of the tooltip tests: the template's `GameTooltipTexture<i>` (12 × 12), the line indent
// and the anchors read back from the bridge.
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const { glueTooltipTextureGap } = await import("../dist/code/browser/glue/GlueTooltipTextures.js");

async function bootTooltip(extraLua = "") {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "TooltipFonts.xml\nTooltip.xml\nTooltip.lua",
      "interface/framexml/tooltipfonts.xml": `<Ui>
        <Font name="GameTooltipHeaderText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="14"/></FontHeight></Font>
        <Font name="GameTooltipText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="12"/></FontHeight></Font>
      </Ui>`,
      "interface/framexml/tooltip.xml": `<Ui>
        <Frame name="UIParent"><Size><AbsDimension x="1024" y="768"/></Size></Frame>
        <GameTooltip name="GameTooltip" parent="UIParent"><Layers><Layer level="ARTWORK">
          ${Array.from({ length: 10 }, (_, index) => `<Texture name="$parentTexture${index + 1}" hidden="true">
            <Size><AbsDimension x="12" y="12"/></Size></Texture>`).join("\n")}
        </Layer></Layers></GameTooltip>
      </Ui>`,
      "interface/framexml/tooltip.lua": `
THREAT_TOOLTIP = "%d%% угрозы"
TOOLTIP_UNIT_LEVEL = "Уровень %s"
function GetScreenWidth() return 1024 end
function GetScreenHeight() return 768 end
function IsThreatWarningEnabled() return true end
function UnitDetailedThreatSituation() return true, 3, 100, 100, 5000 end
function UnitExists(unit) return unit == "target" end
function UnitName(unit) if unit == "target" then return "Волк" end end
function UnitIsPlayer() return false end
function UnitLevel() return 80 end
function UnitIsDead() return false end
function UnitIsPVP() return false end
function UnitReaction() return 2 end
function GetCVarBool() return false end
${extraLua}
`,
    }),
    subset: ["TooltipFonts.xml", "Tooltip.xml", "Tooltip.lua"],
    exercise: false,
    gameTooltipAdapter: { inventoryItem: () => undefined, containerItem: () => undefined, item: () => undefined, spell: () => undefined },
  });
  await boot.load();
  const run = (source, results = 0) => {
    const chunk = boot.vm.compileFunction(source, "@tooltip-textures", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
  };
  const frame = (name) => boot.bridge.getFrame(name);
  const anchor = (name) => {
    const point = frame(name).points[0];
    return [point.point, point.relativeTo?.name, point.relativePoint, Math.round((point.x ?? 0) * 100) / 100, point.y ?? 0];
  };
  return { boot, run, frame, anchor };
}

test("AddTexture: the last line moves right by the icon, the texture sits left of it, the next line is put back", async () => {
  const { boot, run, frame, anchor } = await bootTooltip();
  const gap = glueTooltipTextureGap(4 / 3);
  assert.equal(Math.round(gap * 100) / 100, 6.4, "0.005 diagonal units at 4:3");
  const shift = Math.round((12 + gap) * 100) / 100;
  try {
    run(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE") GameTooltip:AddLine("Один") GameTooltip:AddTexture("Interface\\\\Icons\\\\A")`);
    assert.equal(frame("GameTooltipTexture1").visible, false, "never on the first line");
    run(`GameTooltip:AddLine("Два") GameTooltip:AddTexture("Interface\\\\Icons\\\\B")`);
    const texture = frame("GameTooltipTexture1");
    assert.equal(texture.visible, true);
    assert.equal(texture.texture.toLowerCase(), "interface\\icons\\b");
    assert.deepEqual(texture.texCoords, { left: 0, right: 1, top: 0, bottom: 1 });
    assert.deepEqual(anchor("GameTooltipTextLeft2"), ["TOPLEFT", "GameTooltipTextLeft1", "BOTTOMLEFT", shift, -2]);
    assert.deepEqual(anchor("GameTooltipTexture1"), ["TOPRIGHT", "GameTooltipTextLeft2", "TOPLEFT", -6.4, 0]);
    // A second on the next line: that line is under an indented one already, so it is not moved again.
    run(`GameTooltip:AddLine("Три") GameTooltip:AddTexture("Interface\\\\Icons\\\\C", 0.1, 0.9, 0.2, 0.8)`);
    assert.deepEqual(anchor("GameTooltipTextLeft3"), ["TOPLEFT", "GameTooltipTextLeft2", "BOTTOMLEFT", 0, -2]);
    assert.deepEqual(frame("GameTooltipTexture2").texCoords, { left: 0.1, right: 0.9, top: 0.2, bottom: 0.8 });
    // ClearLines: the lines back under each other, the line after a texture at (0, 0), the textures hidden.
    run(`GameTooltip:ClearLines()`);
    assert.equal(frame("GameTooltipTexture1").visible, false);
    assert.equal(frame("GameTooltipTexture2").visible, false);
    assert.deepEqual(anchor("GameTooltipTextLeft2"), ["TOPLEFT", "GameTooltipTextLeft1", "BOTTOMLEFT", 0, -2]);
    // Lines written again reuse the slots from 1; one on a line whose next line exists puts that one back.
    run(`GameTooltip:AddLine("А") GameTooltip:AddLine("Б") GameTooltip:AddLine("В")`);
    run(`GameTooltip:ClearLines() GameTooltip:AddLine("А") GameTooltip:AddLine("Б") GameTooltip:AddTexture("X")`);
    assert.deepEqual(anchor("GameTooltipTextLeft3"), ["TOPLEFT", "GameTooltipTextLeft2", "BOTTOMLEFT", -shift, -2],
      "the existing line below is put back");
    assert.equal(frame("GameTooltipTexture1").visible, true);
    run(`GameTooltip:Hide()`);
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("AddTexture: ten at most; a number without the other three is refused", async () => {
  const { boot, run, frame } = await bootTooltip();
  try {
    run(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE") GameTooltip:AddLine("0")`);
    run(`for i = 1, 12 do GameTooltip:AddLine(tostring(i)) GameTooltip:AddTexture("X") end`);
    assert.equal(Array.from({ length: 10 }, (_, index) => frame(`GameTooltipTexture${index + 1}`).visible).every(Boolean), true);
    run(`GameTooltip:ClearLines() GameTooltip:AddLine("0") GameTooltip:AddLine("1") GameTooltip:AddTexture("X", 0.5)`);
    assert.equal(frame("GameTooltipTexture1").visible, false, "usage error: nothing added");
  } finally { boot.close(); }
});

test("SetUnit: the threat line carries UI-RaidFrame-Threat tinted red at status 3", async () => {
  const { boot, run, frame, anchor } = await bootTooltip();
  try {
    run(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE") GameTooltip:SetUnit("target")`);
    const count = run(`return GameTooltip:NumLines()`, 1)[0];
    assert.equal(frame(`GameTooltipTextLeft${count}`).text, "100% угрозы");
    const texture = frame("GameTooltipTexture1");
    assert.equal(texture.visible, true);
    assert.equal(texture.texture.toLowerCase(), "interface\\raidframe\\ui-raidframe-threat");
    assert.deepEqual([texture.vertexColor.r, texture.vertexColor.g, texture.vertexColor.b], [1, 0, 0]);
    assert.deepEqual(anchor("GameTooltipTexture1").slice(0, 3), ["TOPRIGHT", `GameTooltipTextLeft${count}`, "TOPLEFT"]);
    run(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE")`);
    assert.equal(frame("GameTooltipTexture1").visible, false, "SetOwner clears the lines and their textures");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});
