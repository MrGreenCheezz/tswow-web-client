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
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");

const EXPECTED_ERROR_KEYS = Object.freeze([
  "interface/framexml/chatframe.lua:3108",
  "interface/framexml/minimap.lua:429",
  "interface/framexml/pvpframe.lua:548",
  "interface/framexml/spellbookframe.lua:221",
  "interface/framexml/voicechat.lua:238",
  "PartyMemberBackground:OnEvent:4",
]);

function errorKey(error) {
  return `${error.file}:${error.line}`;
}

test("vertical CannedWorldSeam journeys do not raise the six known missing-dependency errors", withClient, async () => {
  const { openClientArchives } = await import("../tools/mpq.mjs");
  const chain = await openClientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam: new CannedWorldSeam(),
    screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    const inventory = await boot.load();
    const known = new Set(EXPECTED_ERROR_KEYS);
    assert.deepEqual(
      inventory.errors.filter((error) => known.has(errorKey(error))),
      [],
      "the vertical must not continue through a missing concrete dependency",
    );
    assert.equal(boot.bridge.getFrame("ChatMenu")?.type, "Frame");
    assert.equal(boot.bridge.getFrame("ChannelFrameAutoJoin")?.type, "Frame");
    assert.equal(boot.bridge.getFrame("ShowAllSpellRanksCheckBox")?.type, "CheckButton");
    assert.equal(boot.bridge.getFrame("OpacityFrameSlider")?.type, "Slider");
    assert.equal(inventory.errors.length, 0, "the supported canned vertical journey is error-free");
  } finally {
    boot.close();
    await chain.close();
  }
});

test("a UIParent-only slice gates the absent container-frame owner", withClient, async () => {
  const { openClientArchives } = await import("../tools/mpq.mjs");
  const chain = await openClientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU",
    subset: ["GlobalStrings.lua", "Constants.lua", "Fonts.xml", "FontStyles.xml", "BasicControls.xml", "UIParent.xml"],
    seam: new CannedWorldSeam(),
    screen: () => ({ width: 320, height: 240 }),
  });
  try {
    const inventory = await boot.load();
    assert.equal(
      inventory.errors.some((error) => error.file.endsWith("/uiparent.lua") && error.line === 2173),
      false,
      "UIParent must not iterate a missing NUM_CONTAINER_FRAMES owner",
    );
    assert.equal(inventory.errors.length, 0, "the supported UIParent-only journey is error-free");
  } finally {
    boot.close();
    await chain.close();
  }
});
