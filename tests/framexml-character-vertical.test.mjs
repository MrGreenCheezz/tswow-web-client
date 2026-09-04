import assert from "node:assert/strict";
import test from "node:test";

// This regression is MPQ-backed on purpose: the Character/PaperDoll roots, templates and Lua
// sidecars must come from the retail 3.3.5a client rather than a fixture that repeats their names.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const {
  FRAMEXML_TOC_PATH,
  FRAMEXML_VERTICAL_TOC,
} = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");

const CHARACTER_ENTRIES = Object.freeze([
  "CharacterFrameTemplates.xml",
  "CharacterFrame.xml",
  "PaperDollFrame.xml",
]);
const EQUIPMENT_BUTTONS = Object.freeze([
  "CharacterHeadSlot",
  "CharacterNeckSlot",
  "CharacterShoulderSlot",
  "CharacterBackSlot",
  "CharacterChestSlot",
  "CharacterShirtSlot",
  "CharacterTabardSlot",
  "CharacterWristSlot",
  "CharacterHandsSlot",
  "CharacterWaistSlot",
  "CharacterLegsSlot",
  "CharacterFeetSlot",
  "CharacterFinger0Slot",
  "CharacterFinger1Slot",
  "CharacterTrinket0Slot",
  "CharacterTrinket1Slot",
  "CharacterMainHandSlot",
  "CharacterSecondaryHandSlot",
  "CharacterRangedSlot",
]);
const OPTIONAL_SUBFRAMES = Object.freeze([
  "PetPaperDollFrame",
  "TokenFrame",
]);
const EXPECTED_DELTA = Object.freeze({
  files: 5,
  bytes: 176_173,
  widgets: 727,
  lua: 2,
  luaFailed: 0,
  templates: 9,
  models: 1,
});
const decoder = new TextDecoder("utf-8");

function normalized(path) {
  return path.replaceAll("\\", "/").toLowerCase();
}

async function loadFromMpq(chain, subset) {
  const requests = [];
  const provider = {
    async read(path) {
      requests.push(normalized(path));
      const data = await chain.read(path);
      return data ? decoder.decode(data) : undefined;
    },
  };
  const boot = new FrameXmlBoot({
    provider,
    locale: "ruRU",
    subset,
    screen: () => ({ width: 1024, height: 768 }),
  });
  const inventory = await boot.load();
  return { boot, inventory, requests: new Set(requests) };
}

function metrics(inventory) {
  return {
    files: inventory.files.total,
    bytes: inventory.files.bytes,
    widgets: inventory.widgets.total,
    lua: inventory.lua.executed,
    luaFailed: inventory.lua.failed,
    templates: inventory.widgets.templates,
    models: inventory.widgets.models,
  };
}

function errorKey(error) {
  return `${error.file}:${error.line}:${error.message}`;
}

test("MPQ Character/PaperDoll vertical reaches stock roots and equipment slots", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  let baseline;
  let candidate;
  try {
    // Pin ownership and stock order against the actual FrameXML.toc. CharacterFrameTemplates sits
    // directly after GameMenuFrame; the two concrete windows follow SpellBookFrame in order, with
    // their relative Lua sidecars discovered by XML Script nodes.
    const toc = await chain.read(FRAMEXML_TOC_PATH);
    assert.ok(toc, "FrameXML.toc is present in the MPQ chain");
    const realEntries = parseGlueToc(decoder.decode(toc), "interface/framexml/");
    const realPaths = realEntries.map((entry) => normalized(entry.path));
    const verticalPositions = FRAMEXML_VERTICAL_TOC.map((entry) => realPaths.indexOf(
      normalized(`interface/framexml/${entry}`),
    ));
    assert.ok(verticalPositions.every((position) => position >= 0),
      `every vertical entry is in the stock TOC: ${JSON.stringify(verticalPositions)}`);
    assert.ok(verticalPositions.every((position, index) => index === 0
      || position > verticalPositions[index - 1]),
    "vertical entries preserve stock TOC order");
    assert.equal(realPaths.indexOf("interface/framexml/characterframetemplates.xml"),
      realPaths.indexOf("interface/framexml/gamemenuframe.xml") + 1,
    "CharacterFrameTemplates.xml occupies its stock slot after GameMenuFrame.xml");
    assert.ok(realPaths.indexOf("interface/framexml/characterframe.xml")
      > realPaths.indexOf("interface/framexml/spellbookframe.xml"));
    assert.ok(realPaths.indexOf("interface/framexml/paperdollframe.xml")
      > realPaths.indexOf("interface/framexml/characterframe.xml"));

    const characterEntries = new Set(CHARACTER_ENTRIES.map(normalized));
    const baselineSubset = FRAMEXML_VERTICAL_TOC.filter(
      (entry) => !characterEntries.has(normalized(entry)),
    );
    baseline = await loadFromMpq(chain, baselineSubset);
    candidate = await loadFromMpq(chain, FRAMEXML_VERTICAL_TOC);

    // The baseline is intentionally red until this vertical promotes the three stock XML files.
    assert.equal(baseline.boot.bridge.getFrame("CharacterFrame"), undefined,
      "baseline does not have CharacterFrame");
    assert.equal(baseline.boot.bridge.getFrame("PaperDollFrame"), undefined,
      "baseline does not have PaperDollFrame");

    for (const entry of CHARACTER_ENTRIES) {
      assert.ok(candidate.requests.has(normalized(`interface/framexml/${entry}`)),
        `${entry} was read from MPQ`);
    }
    assert.ok(candidate.requests.has("interface/framexml/characterframe.lua"),
      "CharacterFrame.lua was read through CharacterFrame.xml's relative Script");
    assert.ok(candidate.requests.has("interface/framexml/paperdollframe.lua"),
      "PaperDollFrame.lua was read through PaperDollFrame.xml's relative Script");
    assert.equal(candidate.inventory.files.missing.length, 0,
      "Character/PaperDoll vertical has no missing files");
    assert.equal(candidate.inventory.xml.failed.length, 0,
      "Character/PaperDoll XML parses without refusal");
    assert.equal(candidate.inventory.lua.failed, 0,
      "CharacterFrame.lua and PaperDollFrame.lua execute successfully");

    const characterFrame = candidate.boot.bridge.getFrame("CharacterFrame");
    const paperDollFrame = candidate.boot.bridge.getFrame("PaperDollFrame");
    assert.ok(characterFrame, "CharacterFrame exists in the MPQ candidate");
    assert.ok(paperDollFrame, "PaperDollFrame exists in the MPQ candidate");
    assert.equal(characterFrame.type, "Frame");
    assert.equal(paperDollFrame.type, "Frame");
    assert.equal(candidate.boot.bridge.getFrame("CharacterFramePortrait")?.type, "Texture");
    assert.equal(candidate.boot.bridge.getFrame("CharacterFrameCloseButton")?.type, "Button");
    assert.equal(candidate.boot.bridge.getFrame("CharacterModelFrame")?.type, "PlayerModel");
    assert.equal(candidate.boot.bridge.getFrame("SkillFrame")?.type, "Frame",
      "SkillFrame is now the concrete Character tab 4, not a placeholder");
    for (const name of EQUIPMENT_BUTTONS) {
      assert.equal(candidate.boot.bridge.getFrame(name)?.type, "Button", `${name} exists`);
    }
    assert.equal(candidate.boot.bridge.getFrame("CharacterAmmoSlot")?.type, "Button");
    // The compat floor supplies the stock C-side slot IDs before the real PaperDoll OnLoad runs.
    assert.equal(candidate.boot.bridge.getFrame("CharacterHeadSlot")?.id, 1);
    assert.equal(candidate.boot.bridge.getFrame("CharacterTabardSlot")?.id, 19);
    assert.equal(candidate.boot.bridge.getFrame("CharacterRangedSlot")?.id, 18);
    assert.deepEqual(
      [0, 1, 2, 3].map((index) => candidate.boot.bridge.getFrame(`CharacterBag${index}Slot`)?.id),
      [20, 21, 22, 23],
      "the full PaperDoll seam keeps carried-bag inventory IDs after TabardSlot",
    );

    for (const name of [
      "CharacterFrameTabButtonTemplate",
      "PaperDollFrameFlyoutTexture",
      "PaperDollItemSlotButtonTemplate",
      "PaperDollFrameItemFlyoutButtonTemplate",
      "PlayerTitleButtonTemplate",
      "GearSetButtonTemplate",
      "GearSetPopupButtonTemplate",
      "StatFrameTemplate",
      "MagicResistanceFrameTemplate",
    ]) {
      assert.ok(candidate.boot.bridge.registry.get(name), `${name} template exists`);
    }

    // Optional panes outside this bounded closure are represented by plain hidden Lua objects.
    // ReputationFrame and SkillFrame are now concrete Character tabs rather than compatibility
    // placeholders.
      for (const name of OPTIONAL_SUBFRAMES) {
      assert.equal(candidate.boot.bridge.getFrame(name), undefined,
        `${name} is not a synthetic bridge widget`);
      const global = candidate.boot.vm.getGlobal(name);
      assert.equal(global?.type, "table", `${name} placeholder is a Lua table`);
      if (global) candidate.boot.vm.release(global);
    }
    const placeholderProbe = candidate.boot.vm.execute(`
      for _, name in ipairs({ "PetPaperDollFrame", "TokenFrame" }) do
        assert(_G[name].hidden == true)
        _G[name]:Show()
        assert(_G[name].hidden == true and _G[name]:IsShown() == false)
      end
    `, "@framexml-character-vertical:test");
    assert.equal(placeholderProbe.ok, true, placeholderProbe.error);
    assert.equal(candidate.boot.bridge.getFrame("ReputationFrame")?.id, 3,
      "ReputationFrame occupies the concrete Character tab 3 slot");
    for (const index of [2, 5]) {
      assert.equal(candidate.boot.bridge.getFrame(`CharacterFrameTab${index}`)?.visible, false,
        `optional CharacterFrameTab${index} is hidden`);
    }

    const slotApi = candidate.inventory.api.find((entry) => entry.name === "GetInventorySlotInfo");
    assert.ok((slotApi?.calls ?? 0) >= EQUIPMENT_BUTTONS.length,
      "PaperDoll reaches the structural inventory-slot API");

    const before = metrics(baseline.inventory);
    const after = metrics(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
    assert.deepEqual(delta, EXPECTED_DELTA,
      `exact Character/PaperDoll dependency-closure delta: ${JSON.stringify(delta)}`);

    const baselineErrors = new Set(baseline.inventory.errors.map(errorKey));
    const candidateSpecificUnhandled = candidate.inventory.errors.filter(
      (error) => !baselineErrors.has(errorKey(error)) && !error.handled,
    );
    assert.deepEqual(candidateSpecificUnhandled, [],
      "Character/PaperDoll adds no candidate-specific unhandled Lua errors");

    console.log(`[framexml Character/PaperDoll] MPQ delta ${JSON.stringify({
      baseline: before,
      candidate: after,
      delta,
      candidateSpecificUnhandled: candidateSpecificUnhandled.length,
    })}`);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
    chain.close();
  }
});
