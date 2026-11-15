import assert from "node:assert/strict";
import test, { after } from "node:test";

// plates12 (15.11, plan items 6.37 and 3.21): the plate frames under the stock WorldFrame of the production vertical,
// booted from the client's MPQs as the world mount boots it: NAMEPLATE_FONT is the client's own GlobalString, the
// stock WorldFrame keeps ActionStatus first among its children, and a scanner add-on (the shape of every plate add-on:
// WorldFrame:GetChildren() in OnUpdate, unnamed Frames with regions) finds and restyles the plates with the stock
// widget methods.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

const { FrameXmlBoot, FRAMEXML_VERTICAL_EXERCISE_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { createNamePlateFrameHost } = await import("../dist/code/browser/ui/NamePlateFrames.js");
const { REACTION_HOSTILE } = await import("../dist/code/world/FactionRules.js");
const decoder = new TextDecoder("utf-8");
const SCREEN = Object.freeze({ width: 1365, height: 768 });

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "nameplate-frames-vertical", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

test("the stock vertical's WorldFrame takes the plates, and a scanner add-on restyles them", withClient, async () => {
  const errors = [];
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam: new CannedWorldSeam(), exercise: true,
    exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS, screen: () => SCREEN,
    lua: { onError: (message) => errors.push(message) },
  });
  try {
    await boot.load();
    boot.bridge.setMeasure((frame) => (frame.name === "UIParent" ? SCREEN : undefined));
    const font = boot.vm.getGlobal("NAMEPLATE_FONT");
    assert.equal(typeof font, "string", "the client's GlobalStrings answer NAMEPLATE_FONT");
    const worldFrame = boot.bridge.getFrame("WorldFrame");
    assert.ok(worldFrame);
    const host = createNamePlateFrameHost({ bridge: boot.bridge, worldFrame, fontFile: font, uiScale: () => 100 });
    lua(boot, `
      PlateScan = { found = 0, names = {} }
      local known = 0
      local scanner = CreateFrame("Frame")
      scanner:SetScript("OnUpdate", function()
        local count = WorldFrame:GetNumChildren()
        if count == known then return end
        known = count
        for _, plate in ipairs({ WorldFrame:GetChildren() }) do
          if not PlateScan[plate] and not plate:GetName() and plate:GetNumRegions() >= 8 then
            PlateScan[plate] = true
            PlateScan.found = PlateScan.found + 1
            local _, border, _, _, _, _, name = plate:GetRegions()
            border:Hide()
            local bar = plate:GetChildren()
            bar:GetStatusBarTexture():SetTexture("Interface\\TargetingFrame\\UI-StatusBar")
            local r, g, b = bar:GetStatusBarColor()
            PlateScan.names[#PlateScan.names + 1] = name:GetText() .. (r > g and " hostile" or " friendly")
          end
        end
      end)
    `, 0);
    const data = (guid, name) => ({
      guid, name, level: 80, playerLevel: 80, reaction: REACTION_HOSTILE, classColour: undefined, health: 0.5,
      healthValue: 500, healthMax: 1000, raidMark: undefined, rank: 0, cast: undefined, target: false,
    });
    host.present([
      { box: { x: 100, y: 200, width: 156.651, height: 39.163, scale: 1 }, data: data(11n, "Гоблин") },
      { box: { x: 400, y: 260, width: 156.651, height: 39.163, scale: 1 }, data: data(12n, "Кобольд") },
    ], SCREEN.width, SCREEN.height);
    const errorsBefore = errors.length;
    boot.bridge.tick(0.016);
    assert.deepEqual(errors.slice(errorsBefore), []);
    assert.deepEqual(lua(boot, "return WorldFrame:GetNumChildren(), (WorldFrame:GetChildren()):GetName(), PlateScan.found", 3),
      [3, "ActionStatus", 2], "ActionStatus, then the two plates");
    assert.deepEqual(lua(boot, "return PlateScan.names[1], PlateScan.names[2]", 2), ["Гоблин hostile", "Кобольд hostile"]);
    const plate = host.pool.frameFor(11n);
    const nameString = plate.children.find((child) => child.type === "FontString");
    assert.equal(nameString.attributes.fontFile, font);
    // Alt+Z: UIParent hides, the plates stay (WorldFrame's children are not under UIParent).
    assert.deepEqual(lua(boot, "UIParent:Hide() local p = select(2, WorldFrame:GetChildren()) return p:IsVisible()"), [true]);
    lua(boot, "UIParent:Show()", 0);
  } finally {
    boot.close();
  }
});
