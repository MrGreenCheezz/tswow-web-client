import assert from "node:assert/strict";
import test from "node:test";

// This regression is MPQ-backed on purpose: the candidate has to reach the stock SpellBookFrame
// and its relative Lua script through the real client data, not through a fixture that repeats the
// names that the test expects to see.
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
const { frameXmlStubPlan } = await import("../dist/code/browser/framexml/FrameXmlStubPlan.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");

const SPELLBOOK_XML = "interface/framexml/spellbookframe.xml";
const SPELLBOOK_LUA = "interface/framexml/spellbookframe.lua";
const SPELLBOOK_ENTRY = "SpellBookFrame.xml";
const EXPECTED_DELTA = Object.freeze({
  files: 2,
  bytes: 42_269,
  // OptionsPanelTemplates.xml supplies the concrete ShowAllSpellRanksCheckBox owner.
  widgets: 227,
  lua: 1,
  luaFailed: 0,
  // Adding the concrete SpellBook owner closes one baseline microbutton dependency. The typed
  // empty spell-tab contract no longer contributes the old handled SpellBook arithmetic error.
  errors: -1,
  distinctErrors: 0,
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
    errors: inventory.lua.errorsRaised,
    distinctErrors: inventory.errors.length,
  };
}

function errorKey(error) {
  return `${error.file}:${error.line}:${error.message}`;
}

test("MPQ SpellBookFrame vertical reaches the stock window and templates", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  let baseline;
  let candidate;
  try {
    assert.equal(FRAMEXML_VERTICAL_TOC.includes(SPELLBOOK_ENTRY), true,
      "SpellBookFrame.xml is promoted into the bounded vertical");

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

    const spellbookEntries = new Set([SPELLBOOK_ENTRY.toLowerCase()]);
    const baselineSubset = FRAMEXML_VERTICAL_TOC.filter(
      (entry) => !spellbookEntries.has(entry.toLowerCase()),
    );
    baseline = await loadFromMpq(chain, baselineSubset);
    candidate = await loadFromMpq(chain, FRAMEXML_VERTICAL_TOC);

    assert.equal(baseline.boot.bridge.getFrame("SpellBookFrame")?.name, undefined,
      "current vertical baseline does not have SpellBookFrame");
    assert.ok(candidate.requests.has(SPELLBOOK_XML), "SpellBookFrame.xml was read from MPQ");
    assert.ok(candidate.requests.has(SPELLBOOK_LUA),
      "SpellBookFrame.lua was read through XML's relative Script");
    assert.equal(candidate.inventory.files.missing.length, 0,
      "SpellBook vertical has no missing files");
    assert.equal(candidate.inventory.xml.failed.length, 0,
      "SpellBookFrame XML parses without refusal");
    assert.equal(candidate.inventory.lua.failed, 0,
      "SpellBookFrame.lua executes successfully");

    const before = metrics(baseline.inventory);
    const after = metrics(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
    assert.deepEqual(delta, EXPECTED_DELTA,
      `exact SpellBookFrame delta versus the current vertical: ${JSON.stringify(delta)}`);

    const frame = (name) => candidate.boot.bridge.getFrame(name);
    const spellbook = frame("SpellBookFrame");
    assert.ok(spellbook, "SpellBookFrame exists in the MPQ candidate");
    assert.equal(spellbook.type, "Frame");
    for (const name of [
      "SpellBookShineTemplate",
      "SpellBookSkillLineTabTemplate",
      "SpellBookFrameTabButtonTemplate",
      "SpellButtonTemplate",
    ]) {
      assert.ok(candidate.boot.bridge.registry.get(name), `${name} template exists`);
    }
    for (const name of [
      "SpellBookFrame",
      "SpellBookFrameTabButton1",
      "SpellBookFrameTabButton2",
      "SpellBookFrameTabButton3",
      "SpellBookPrevPageButton",
      "SpellBookNextPageButton",
      "SpellBookCloseButton",
      ...Array.from({ length: 12 }, (_, index) => `SpellButton${index + 1}`),
    ]) {
      assert.ok(frame(name), `${name} exists in the stock spellbook`);
    }

    // The static plan is the API census for this vertical. Keep the list exact: if a future XML
    // dependency silently changes, the test should force the next adapter decision into the open.
    const plan = frameXmlStubPlan((await candidate.boot.corpus.scan(candidate.inventory.toc)).chunks);
    const expectedSpellApiSites = Object.freeze({
      UpdateSpells: 6,
      HasPetSpells: 3,
      PickupSpell: 3,
      CastSpell: 2,
      GetSpellName: 2,
      GetSpellTabInfo: 2,
      IsPassiveSpell: 2,
      ToggleSpellAutocast: 2,
      GetKnownSlotFromHighestRankSlot: 1,
      GetNumSpellTabs: 1,
      GetSpellAutocast: 1,
      GetSpellCooldown: 1,
      // Two since PetPaperDollFrame.xml joined the vertical: the book's chat link and the pet
      // page's CompanionButton_OnModifiedClick (PetPaperDollFrame.lua) both call GetSpellLink.
      GetSpellLink: 2,
      GetSpellTexture: 1,
      IsSelectedSpell: 1,
    });
    assert.deepEqual(
      Object.fromEntries(Object.keys(expectedSpellApiSites).map((name) => [
        name,
        plan.apiCallSites.get(name) ?? 0,
      ])),
      expectedSpellApiSites,
      "SpellBookFrame contributes the measured host API census",
    );
    const runtimeApi = new Map(candidate.inventory.api.map((entry) => [entry.name, entry]));
    assert.ok((runtimeApi.get("GetSpellTabInfo")?.calls ?? 0) > 0,
      "SpellBookFrame reaches GetSpellTabInfo during load");
    assert.ok((runtimeApi.get("HasPetSpells")?.calls ?? 0) > 0,
      "SpellBookFrame reaches HasPetSpells during load");

    // This deliberately seam-less inventory still reaches the known neutral SpellBook arithmetic
    // diagnostic. Pin it explicitly: the production Canned/Live seam paths are covered separately
    // with a strict zero-error contract.
    const baselineErrors = new Set(baseline.inventory.errors.map(errorKey));
    const candidateSpecificErrors = candidate.inventory.errors.filter(
      (error) => !baselineErrors.has(errorKey(error)),
    );
    assert.equal(candidateSpecificErrors.length, 1, "only the known neutral spellbook raise exists");
    assert.equal(candidateSpecificErrors[0].file, SPELLBOOK_LUA);
    assert.equal(candidateSpecificErrors[0].handled, true);
    assert.match(candidateSpecificErrors[0].message, /compare number with nil/);

    console.log(`[framexml SpellBookFrame] MPQ delta ${JSON.stringify({
      baseline: before,
      candidate: after,
      delta,
      api: Object.fromEntries(Object.keys(expectedSpellApiSites).map((name) => [
        name,
        plan.apiCallSites.get(name) ?? 0,
      ])),
      candidateSpecificErrors,
    })}`);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
    chain.close();
  }
});
