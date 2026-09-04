import assert from "node:assert/strict";
import test from "node:test";

// This regression is MPQ-backed on purpose: PetFrame must come from the client's own
// PetFrame.xml and its relative PetFrame.lua, not from a fixture that repeats the names.
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

const PARTY_AND_PET_TOC = Object.freeze(["PartyFrame.xml", "PetFrame.xml"]);
const UNHANDLED_PET_ERROR_CEILING = 0;
// ColorPickerFrame.xml is the stock owner of PartyMemberBackground's opacity slider, so the
// PartyFrame path has no candidate-only handled errors after the dependency is present.
const EXPECTED_PARTY_HANDLED_ERRORS = Object.freeze([]);
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
    api: inventory.api.length,
    errors: inventory.lua.errorsRaised,
    distinctErrors: inventory.errors.length,
  };
}

function errorKey(error) {
  return `${error.file}:${error.line}:${error.message}`;
}

test("MPQ PetFrame vertical loads stock pet frame and records pet unit API census", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  let baseline;
  let candidate;
  try {
    // Pin ownership and order against the actual FrameXML.toc. This catches an invented file
    // name or a dependency placed after PetFrame even when the synthetic subset happens to run.
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
    assert.equal(realPaths.indexOf("interface/framexml/partyframe.xml"),
      realPaths.indexOf("interface/framexml/targetframe.xml") - 1,
    "PartyFrame.xml immediately precedes TargetFrame.xml in the stock TOC");
    assert.equal(realPaths.indexOf("interface/framexml/petframe.xml"),
      realPaths.indexOf("interface/framexml/targetframe.xml") + 2,
    "PetFrame.xml follows TargetFrame.xml in the stock TOC with one intervening entry");

    const petEntries = new Set(PARTY_AND_PET_TOC.map(normalized));
    const baselineSubset = FRAMEXML_VERTICAL_TOC.filter((entry) => !petEntries.has(normalized(entry)));
    baseline = await loadFromMpq(chain, baselineSubset);
    candidate = await loadFromMpq(chain, FRAMEXML_VERTICAL_TOC);

    // The baseline is intentionally red until PartyFrame.xml and PetFrame.xml are added to the
    // vertical TOC.
    assert.equal(baseline.boot.bridge.getFrame("PetFrame"), undefined,
      "baseline does not have PetFrame");
    assert.equal(baseline.boot.bridge.getFrame("PetFrameHealthBar"), undefined,
      "baseline does not have PetFrameHealthBar");
    assert.equal(baseline.boot.bridge.getFrame("PartyMemberFrame1"), undefined,
      "baseline does not have PartyMemberFrame1");

    for (const entry of PARTY_AND_PET_TOC) {
      assert.ok(candidate.requests.has(normalized(`interface/framexml/${entry}`)),
        `${entry} was read from MPQ`);
    }
    assert.ok(candidate.requests.has("interface/framexml/petframe.lua"),
      "PetFrame.lua was read through PetFrame.xml's relative Script");
    for (const path of [
      "interface/framexml/partymemberframe.lua",
      "interface/framexml/partyframetemplates.xml",
    ]) {
      assert.ok(candidate.requests.has(path), `${path} was read through PartyFrame.xml`);
    }
    assert.equal(candidate.inventory.files.missing.length, 0,
      "PetFrame vertical has no missing files");
    assert.equal(candidate.inventory.xml.failed.length, 0,
      "PetFrame XML parses without refusal");
    assert.equal(candidate.inventory.lua.failed, 0,
      "PetFrame.lua executes successfully");
    for (const name of [
      "PetFrame",
      "PetFrameFlash",
      "PetFrameTexture",
      "PetHitIndicator",
      "PetName",
      "PetPortrait",
      "PetFrameHealthBarText",
      "PetFrameManaBarText",
      "PetAttackModeTexture",
      "PetFrameHealthBar",
      "PetFrameManaBar",
      "PetFrameDebuff1",
      "PetFrameDebuff1Icon",
      "PetFrameDebuff1Border",
      "PetFrameDebuff2",
      "PetFrameDebuff2Icon",
      "PetFrameDebuff2Border",
      "PetFrameDebuff3",
      "PetFrameDebuff3Icon",
      "PetFrameDebuff3Border",
      "PetFrameDebuff4",
      "PetFrameDebuff4Icon",
      "PetFrameDebuff4Border",
      "PetFrameHappiness",
      "PetFrameHappinessTexture",
      "PetCastingBarFrame",
    ]) {
      assert.ok(candidate.boot.bridge.getFrame(name), `${name} exists in the MPQ candidate`);
    }
    assert.equal(candidate.boot.bridge.getFrame("PetFrame")?.type, "Button");
    assert.equal(candidate.boot.bridge.getFrame("PetFrameHealthBar")?.type, "StatusBar");
    assert.equal(candidate.boot.bridge.getFrame("PetFrameManaBar")?.type, "StatusBar");
    assert.equal(candidate.boot.bridge.getFrame("PetCastingBarFrame")?.type, "StatusBar");
    for (let index = 1; index <= 4; index += 1) {
      assert.equal(candidate.boot.bridge.getFrame(`PetFrameDebuff${index}`)?.type, "Button");
      assert.equal(candidate.boot.bridge.getFrame(`PetFrameDebuff${index}Icon`)?.type, "Texture");
      assert.equal(candidate.boot.bridge.getFrame(`PetFrameDebuff${index}Border`)?.type, "Texture");
      // The stock PartyDebuffFrameTemplate has no cooldown child; RefreshDebuffs checks it
      // conditionally. Keep this absence explicit so a later slice cannot invent a widget here.
      assert.equal(candidate.boot.bridge.getFrame(`PetFrameDebuff${index}Cooldown`), undefined);
    }

    for (const name of [
      "SecureUnitButtonTemplate",
      "TextStatusBar",
      "TextStatusBarText",
      "PartyDebuffFrameTemplate",
      "CastingBarFrameTemplate",
    ]) {
      assert.ok(candidate.boot.bridge.registry.get(name), `${name} template exists`);
    }

    const before = metrics(baseline.inventory);
    const after = metrics(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
    assert.ok(delta.files >= 2, `files delta: ${JSON.stringify(delta)}`);
    assert.ok(delta.widgets > 0, `widgets delta: ${JSON.stringify(delta)}`);
    // PetFrame.lua is reached by the XML's relative Script, while PetFrame.xml itself is parsed
    // rather than counted as a second Lua chunk.
    assert.ok(delta.lua >= 1, `Lua delta: ${JSON.stringify(delta)}`);
    assert.ok(delta.api > 0, `API delta: ${JSON.stringify(delta)}`);

    const petApi = candidate.inventory.api
      .filter((entry) => /^(?:Unit|GetPet)/.test(entry.name) && entry.calls > 0)
      .map((entry) => ({ name: entry.name, calls: entry.calls, firstTouch: entry.firstTouch }));
    assert.ok(petApi.length > 0, `PetFrame Unit*/GetPet* census is non-empty: ${JSON.stringify(petApi)}`);
    assert.ok(petApi.some((entry) => entry.name === "UnitClass"),
      `PetFrame census includes UnitClass: ${JSON.stringify(petApi)}`);
    assert.ok(petApi.some((entry) => entry.name === "UnitIsVisible"),
      `PetFrame census includes UnitIsVisible: ${JSON.stringify(petApi)}`);
    const petSource = decoder.decode(await chain.read("Interface/FrameXML/PetFrame.lua"));
    const petSourceApis = [...petSource.matchAll(/\b((?:Unit|GetPet)[A-Z][A-Za-z0-9_]*)\s*\(/g)]
      .map((match) => match[1]);
    assert.ok(petSourceApis.includes("GetPetHappiness"),
      "the MPQ PetFrame.lua source contains its GetPetHappiness call");
    const petRuntimeApi = petApi.filter((entry) => entry.firstTouch.includes("/petframe.lua"));
    assert.ok(petRuntimeApi.length >= 3,
      `PetFrame.lua reaches at least three real Unit*/GetPet* calls: ${JSON.stringify(petRuntimeApi)}`);

    const baselineErrors = new Set(baseline.inventory.errors.map(errorKey));
    const candidateSpecificErrors = candidate.inventory.errors.filter(
      (error) => !baselineErrors.has(errorKey(error)),
    );
    const candidateSpecificUnhandled = candidateSpecificErrors.filter((error) => !error.handled);
    const sortErrors = (errors) => errors
      .map((error) => ({
        file: error.file,
        line: error.line,
        message: error.message,
        count: error.count,
        handled: error.handled,
      }))
      .sort((left, right) => errorKey(left).localeCompare(errorKey(right)));
    assert.deepEqual(sortErrors(candidateSpecificErrors), [...EXPECTED_PARTY_HANDLED_ERRORS]
      .sort((left, right) => errorKey(left).localeCompare(errorKey(right))),
    "PartyFrame's candidate-specific handled errors stay at the measured set/count");
    assert.equal(candidate.inventory.errors.length,
      baseline.inventory.errors.length + EXPECTED_PARTY_HANDLED_ERRORS.length,
    "candidate error census is baseline plus the measured PartyFrame handled set");
    assert.ok(candidateSpecificUnhandled.length <= UNHANDLED_PET_ERROR_CEILING,
      `candidate-specific unhandled Lua: ${JSON.stringify(candidateSpecificUnhandled)}`);

    console.log(`[framexml PetFrame] MPQ delta ${JSON.stringify({
      toc: PARTY_AND_PET_TOC,
      baseline: before,
      candidate: after,
      delta,
      petApi,
      petSourceApis: [...new Set(petSourceApis)],
      petRuntimeApi,
      candidateSpecificErrors: candidateSpecificErrors.map((error) => ({
        file: error.file,
        line: error.line,
        message: error.message,
        count: error.count,
        handled: error.handled,
      })),
      candidateSpecificUnhandled: candidateSpecificUnhandled.length,
    })}`);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
    chain.close();
  }
});
