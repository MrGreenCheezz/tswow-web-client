import assert from "node:assert/strict";
import test from "node:test";

// This regression is MPQ-backed on purpose: the aura frame must come from the stock 3.3.5a
// BuffFrame.xml and its relative BuffFrame.lua, not from a fixture that repeats the names.
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

const AURA_TOC = Object.freeze(["BuffFrame.xml"]);
const EXPECTED_DELTA = Object.freeze({
  files: 2,
  bytes: 23_225,
  widgets: 18,
  lua: 1,
  luaFailed: 0,
  errors: 0,
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

test("MPQ BuffFrame vertical loads stock aura templates and widgets", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  let baseline;
  let candidate;
  try {
    assert.ok(FRAMEXML_VERTICAL_TOC.includes("BuffFrame.xml"),
      "BuffFrame.xml is promoted into the bounded vertical");

    // Pin ownership and order against the actual FrameXML.toc. This catches an invented file
    // name or a dependency placed after BuffFrame even when the synthetic subset happens to run.
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

    const auraEntries = new Set(AURA_TOC.map(normalized));
    const baselineSubset = FRAMEXML_VERTICAL_TOC.filter((entry) => !auraEntries.has(normalized(entry)));
    baseline = await loadFromMpq(chain, baselineSubset);
    candidate = await loadFromMpq(chain, FRAMEXML_VERTICAL_TOC);

    assert.equal(baseline.boot.bridge.getFrame("BuffFrame"), undefined,
      "current vertical baseline does not have BuffFrame");
    assert.equal(baseline.boot.bridge.registry.get("AuraButtonTemplate"), undefined,
      "current vertical baseline does not have aura templates");

    for (const entry of AURA_TOC) {
      assert.ok(candidate.requests.has(normalized(`interface/framexml/${entry}`)),
        `${entry} was read from MPQ`);
    }
    assert.ok(candidate.requests.has("interface/framexml/buffframe.lua"),
      "BuffFrame.lua was read through BuffFrame.xml's relative Script");
    assert.equal(candidate.inventory.files.missing.length, 0,
      "aura vertical has no missing files");
    assert.equal(candidate.inventory.xml.failed.length, 0,
      "BuffFrame XML parses without refusal");
    assert.equal(candidate.inventory.lua.failed, 0,
      "BuffFrame.lua executes successfully");

    for (const name of [
      "BuffFrame",
      "ConsolidatedBuffs",
      "TemporaryEnchantFrame",
      "TempEnchant1",
    ]) {
      assert.ok(candidate.boot.bridge.getFrame(name), `${name} exists in the MPQ candidate`);
    }
    assert.equal(candidate.boot.bridge.getFrame("BuffFrame")?.type, "Frame");
    for (const name of [
      "AuraButtonTemplate",
      "BuffButtonTemplate",
      "DebuffButtonTemplate",
      "TempEnchantButtonTemplate",
    ]) {
      assert.ok(candidate.boot.bridge.registry.get(name), `${name} template exists`);
    }

    // BuffFrame's dynamic aura calls are behind UNIT_AURA and the click handler, so this census
    // keeps their exact static call sites separate from the one load-time weapon-enchant probe.
    const candidatePlan = frameXmlStubPlan((await candidate.boot.corpus.scan()).chunks);
    assert.equal(candidatePlan.apiCallSites.get("UnitAura"), 1,
      "BuffFrame contributes exactly one UnitAura call site");
    assert.equal(candidatePlan.apiCallSites.get("CancelUnitBuff"), 5,
      "the full bounded corpus has exactly five CancelUnitBuff call sites");
    assert.deepEqual(
      candidate.inventory.api
        .filter((entry) => ["UnitAura", "CancelUnitBuff", "GetWeaponEnchantInfo"].includes(entry.name))
        .map(({ name, calls, sites, neutral }) => ({ name, calls, sites, neutral })),
      [{ name: "GetWeaponEnchantInfo", calls: 1, sites: 1, neutral: "" }],
      "only the neutral weapon-enchant probe is actually called during the load exercise",
    );

    const before = metrics(baseline.inventory);
    const after = metrics(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
    assert.deepEqual(delta, EXPECTED_DELTA,
      `exact BuffFrame delta versus the current vertical: ${JSON.stringify(delta)}`);

    const baselineErrors = new Set(baseline.inventory.errors.map(errorKey));
    const candidateSpecificErrors = candidate.inventory.errors.filter(
      (error) => !baselineErrors.has(errorKey(error)),
    );
    const candidateSpecificUnhandled = candidateSpecificErrors.filter((error) => !error.handled);
    assert.deepEqual(candidateSpecificErrors, [],
      "BuffFrame adds no candidate-specific Lua errors");
    assert.deepEqual(candidateSpecificUnhandled, [],
      "BuffFrame adds no candidate-specific unhandled Lua errors");

    console.log(`[framexml BuffFrame] MPQ delta ${JSON.stringify({
      toc: AURA_TOC,
      baseline: before,
      candidate: after,
      delta,
      candidateSpecificErrors,
      candidateSpecificUnhandled: candidateSpecificUnhandled.length,
    })}`);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
    chain.close();
  }
});
