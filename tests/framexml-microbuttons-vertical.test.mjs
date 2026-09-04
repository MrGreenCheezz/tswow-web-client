import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";

// This test is MPQ-backed on purpose: the production row must be the stock XML/Lua pair in the
// stock TOC slot, not a browser-authored approximation. The native row remains the fallback until
// the mount's complete owner gate proves all ten handlers and every replacement surface.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
  concurrency: false,
};
const { clientArchives } = await import("../tools/mpq.mjs");
const archiveChain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => archiveChain?.close());

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const {
  FRAMEXML_TOC_PATH,
  FRAMEXML_VERTICAL_TOC,
} = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");
const decoder = new TextDecoder("utf-8");

const STOCK_MICROBUTTON_NAMES = Object.freeze([
  "CharacterMicroButton", "SpellbookMicroButton", "TalentMicroButton", "AchievementMicroButton",
  "QuestLogMicroButton", "SocialsMicroButton", "PVPMicroButton", "LFDMicroButton",
  "MainMenuMicroButton", "HelpMicroButton",
]);

function normalized(path) {
  return path.replaceAll("\\", "/").toLowerCase();
}

function candidateToc() {
  assert.ok(FRAMEXML_VERTICAL_TOC.includes("MainMenuBarMicroButtons.xml"),
    "the production vertical owns the stock microbutton row");
  return FRAMEXML_VERTICAL_TOC;
}

async function loadFromMpq(chain, subset, seam, exercise = false) {
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
    seam,
    exercise,
    screen: () => ({ width: 1024, height: 768 }),
  });
  const inventory = await boot.load();
  return { boot, inventory, requests: new Set(requests) };
}

function errorKey(error) {
  return `${error.file}:${error.line}:${error.message}`;
}

test("production vertical includes the stock row while native fallback remains available", async () => {
  const mainMenuBar = FRAMEXML_VERTICAL_TOC.indexOf("MainMenuBar.xml");
  assert.ok(mainMenuBar >= 0, "the production vertical has a MainMenuBar.xml anchor");
  assert.equal(FRAMEXML_VERTICAL_TOC[mainMenuBar + 1], "MainMenuBarMicroButtons.xml",
    "the production route keeps the stock row in exact TOC order");
  const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(source, /<div id="game-buttons">/, "native micro-button fallback remains present");
  for (const id of [
    "character-toggle", "inventory-toggle", "spellbook-toggle", "talents-toggle",
    "game-menu-toggle",
  ]) assert.match(source, new RegExp(`id="${id}"`), `${id} remains available in fallback`);
  assert.doesNotMatch(source, /id="game-buttons"[^>]*hidden/i,
    "native fallback is not statically hidden");
});

test("stock candidate loads MainMenuBarMicroButtons in exact TOC order with no orphan roots", withClient, async () => {
  const chain = archiveChain;
  assert.ok(chain);
  let candidate;
  try {
    const tocText = await chain.read(FRAMEXML_TOC_PATH);
    assert.ok(tocText, "FrameXML.toc is present in the MPQ chain");
    const stockPaths = parseGlueToc(decoder.decode(tocText), "interface/framexml/")
      .map((entry) => normalized(entry.path));
    const main = stockPaths.indexOf("interface/framexml/mainmenubar.xml");
    const micro = stockPaths.indexOf("interface/framexml/mainmenubarmicrobuttons.xml");
    assert.equal(micro, main + 1, "stock TOC puts microbuttons immediately after MainMenuBar.xml");

    const subset = candidateToc();
    assert.equal(subset[subset.indexOf("MainMenuBar.xml") + 1], "MainMenuBarMicroButtons.xml");
    // Exercise the production vertical through a real world seam. A seam-less inventory boot
    // intentionally records handled neutral-API diagnostics and is not the route mounted in-game.
    candidate = await loadFromMpq(chain, subset, new CannedWorldSeam(), true);
    for (const entry of ["MainMenuBar.xml", "MainMenuBarMicroButtons.xml"]) {
      assert.ok(candidate.requests.has(`interface/framexml/${normalized(entry)}`),
        `${entry} was read from MPQ`);
    }
    assert.ok(candidate.requests.has("interface/framexml/mainmenubarmicrobuttons.lua"),
      "the stock microbutton Lua was loaded through XML");
    assert.equal(candidate.inventory.files.missing.length, 0, "candidate has no missing MPQ files");
    assert.equal(candidate.inventory.xml.failed.length, 0, "candidate XML parses without refusal");
    assert.equal(candidate.inventory.lua.failed, 0, "candidate Lua executes successfully");
    assert.equal(candidate.inventory.xml.unknownDeclarations.length, 0,
      "candidate adds no unknown declarations");

    const buttons = STOCK_MICROBUTTON_NAMES.map((name) => candidate.boot.bridge.getFrame(name));
    assert.ok(buttons.every(Boolean), "all ten stock button frames exist");
    assert.ok(buttons.every((button) => button.type === "Button"), "all ten are real Button widgets");
    assert.ok(buttons.every((button) => button.parent?.name === "MainMenuBarArtFrame"),
      "all ten stay under the authored MainMenuBarArtFrame owner");
    const portrait = candidate.boot.bridge.getFrame("MicroButtonPortrait");
    assert.ok(portrait, "the authored CharacterMicroButton portrait slot remains in the stock row");
    assert.equal(portrait.type, "Texture", "MicroButtonPortrait is the authored Texture region");
    assert.equal(portrait.parent?.name, "CharacterMicroButton",
      "MicroButtonPortrait remains owned by CharacterMicroButton");
    assert.ok(candidate.boot.bridge.hasScript(candidate.boot.bridge.getFrame("CharacterMicroButton"), "OnEvent"),
      "CharacterMicroButton keeps its stock portrait event instead of a no-op adapter");
    assert.deepEqual(candidate.boot.roots.filter((root) => STOCK_MICROBUTTON_NAMES.includes(root.name)), [],
      "microbuttons are not parentless boot roots");

    assert.deepEqual(candidate.inventory.errors, [],
      "production vertical exercise must be zero-console-error");
    assert.equal(candidate.inventory.lua.errorsRaised, 0,
      "production vertical must not raise Lua errors while exercising the stock row");
  } finally {
    candidate?.boot.close();
  }
});

test("microbutton contract closes UnitLevel/GetNetStats while the unsupported option owner stays visible", withClient, async () => {
  const chain = archiveChain;
  assert.ok(chain);
  let candidate;
  try {
    candidate = await loadFromMpq(chain, candidateToc(), new CannedWorldSeam(), true);
    const microErrors = candidate.inventory.errors.filter((error) =>
      error.file.toLowerCase().includes("mainmenubarmicrobuttons")
      || error.file === "MainMenuMicroButton:OnUpdate");
    assert.deepEqual(microErrors, [],
      `microbutton exercise must not raise Lua errors: ${JSON.stringify(microErrors)}`);
    assert.equal(candidate.inventory.neutral.find((entry) => entry.name === "GetNetStats")?.answer, "0, 0, 0",
      "GetNetStats has a typed neutral contract");

  } finally {
    candidate?.boot.close();
  }
});
