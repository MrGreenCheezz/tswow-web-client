import assert from "node:assert/strict";
import test from "node:test";

// This regression is MPQ-backed on purpose: the TargetFrame must come from the client's own
// TargetFrame.xml and its relative TargetFrame.lua, not from a fixture that repeats the names.
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

const TARGET_FRAME_TOC = Object.freeze(["TargetFrame.xml"]);
const UNHANDLED_TARGET_ERROR_CEILING = 0;
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

test("MPQ TargetFrame vertical loads stock target frames and core children", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  let baseline;
  let candidate;
  try {
    // Pin ownership and order against the actual FrameXML.toc. This catches an invented file
    // name or a dependency placed after TargetFrame even when the synthetic subset happens to run.
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

    const targetEntries = new Set(TARGET_FRAME_TOC.map(normalized));
    const baselineSubset = FRAMEXML_VERTICAL_TOC.filter((entry) => !targetEntries.has(normalized(entry)));
    baseline = await loadFromMpq(chain, baselineSubset);
    candidate = await loadFromMpq(chain, FRAMEXML_VERTICAL_TOC);

    // The baseline is intentionally red until TargetFrame.xml is added to the vertical TOC.
    assert.equal(baseline.boot.bridge.getFrame("TargetFrame"), undefined,
      "baseline does not have TargetFrame");
    assert.equal(baseline.boot.bridge.getFrame("TargetFrameHealthBar"), undefined,
      "baseline does not have TargetFrameHealthBar");

    for (const entry of TARGET_FRAME_TOC) {
      assert.ok(candidate.requests.has(normalized(`interface/framexml/${entry}`)),
        `${entry} was read from MPQ`);
    }
    assert.ok(candidate.requests.has("interface/framexml/targetframe.lua"),
      "TargetFrame.lua was read through TargetFrame.xml's relative Script");
    assert.equal(candidate.inventory.files.missing.length, 0,
      "TargetFrame vertical has no missing files");
    assert.equal(candidate.inventory.xml.failed.length, 0,
      "TargetFrame XML parses without refusal");
    assert.equal(candidate.inventory.lua.failed, 0,
      "TargetFrame.lua executes successfully");

    for (const name of [
      "TargetFrame",
      "TargetFrameTextureFrame",
      "TargetFrameTextureFrameTexture",
      "TargetFrameTextureFrameName",
      "TargetFrameTextureFrameHealthBarText",
      "TargetFrameTextureFrameManaBarText",
      "TargetFramePortrait",
      "TargetFrameHealthBar",
      "TargetFrameManaBar",
      "TargetFrameBuffs",
      "TargetFrameDebuffs",
      "TargetFrameNumericalThreat",
      "FocusFrame",
      "Boss1TargetFrame",
    ]) {
      assert.ok(candidate.boot.bridge.getFrame(name), `${name} exists in the MPQ candidate`);
    }
    assert.equal(candidate.boot.bridge.getFrame("TargetFrame")?.type, "Button");
    assert.equal(candidate.boot.bridge.getFrame("TargetFrameHealthBar")?.type, "StatusBar");
    assert.equal(candidate.boot.bridge.getFrame("TargetFrameManaBar")?.type, "StatusBar");

    for (const name of [
      "SecureUnitButtonTemplate",
      "TextStatusBar",
      "CooldownFrameTemplate",
      "TargetofTargetDebuffFrameTemplate",
      "TargetDebuffFrameTemplate",
      "TargetBuffFrameTemplate",
      "TargetFrameTemplate",
      "TargetofTargetFrameTemplate",
      "TargetSpellBarTemplate",
    ]) {
      assert.ok(candidate.boot.bridge.registry.get(name), `${name} template exists`);
    }

    const before = metrics(baseline.inventory);
    const after = metrics(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
    assert.ok(delta.files >= 2, `files delta: ${JSON.stringify(delta)}`);
    assert.ok(delta.widgets > 0, `widgets delta: ${JSON.stringify(delta)}`);
    // TargetFrame.lua is reached by the XML's relative Script, while TargetFrame.xml itself is
    // parsed rather than counted as a second Lua chunk.
    assert.ok(delta.lua >= 1, `Lua delta: ${JSON.stringify(delta)}`);
    assert.ok(delta.api > 0, `API delta: ${JSON.stringify(delta)}`);

    const baselineErrors = new Set(baseline.inventory.errors.map(errorKey));
    const candidateSpecificErrors = candidate.inventory.errors.filter(
      (error) => !baselineErrors.has(errorKey(error)),
    );
    const candidateSpecificUnhandled = candidateSpecificErrors.filter((error) => !error.handled);
    assert.ok(candidateSpecificUnhandled.length <= UNHANDLED_TARGET_ERROR_CEILING,
      `candidate-specific unhandled Lua: ${JSON.stringify(candidateSpecificUnhandled)}`);

    console.log(`[framexml TargetFrame] MPQ delta ${JSON.stringify({
      toc: TARGET_FRAME_TOC,
      baseline: before,
      candidate: after,
      delta,
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
