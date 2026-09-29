import assert from "node:assert/strict";
import test from "node:test";

// This regression is MPQ-backed on purpose: the Minimap must come from the stock 3.3.5a
// Minimap.xml and its relative Minimap.lua, rather than from a fixture that repeats the names.
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

const MINIMAP_TOC = Object.freeze(["Minimap.xml"]);
const UNHANDLED_MINIMAP_ERROR_CEILING = 0;
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

test("MPQ Minimap vertical loads the stock cluster, authored children and templates", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  let baseline;
  let candidate;
  try {
    // Pin ownership and order against the actual FrameXML.toc. This catches an invented file
    // name or a dependency placed after Minimap even when the synthetic subset happens to run.
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

    const minimapEntries = new Set(MINIMAP_TOC.map(normalized));
    // Keep the comparison against the current TargetFrame vertical baseline. The baseline is
    // intentionally red until Minimap.xml is promoted into FRAMEXML_VERTICAL_TOC.
    const baselineSubset = FRAMEXML_VERTICAL_TOC.filter((entry) => !minimapEntries.has(normalized(entry)));
    baseline = await loadFromMpq(chain, baselineSubset);
    candidate = await loadFromMpq(chain, FRAMEXML_VERTICAL_TOC);

    assert.equal(baseline.boot.bridge.getFrame("MinimapCluster")?.name, undefined,
      "TargetFrame baseline does not have MinimapCluster");
    assert.equal(baseline.boot.bridge.getFrame("Minimap")?.name, undefined,
      "TargetFrame baseline does not have Minimap");

    for (const entry of MINIMAP_TOC) {
      assert.ok(candidate.requests.has(normalized(`interface/framexml/${entry}`)),
        `${entry} was read from MPQ`);
    }
    assert.ok(candidate.requests.has("interface/framexml/minimap.lua"),
      "Minimap.lua was read through Minimap.xml's relative Script");
    assert.equal(candidate.inventory.files.missing.length, 0,
      "Minimap vertical has no missing files");
    assert.equal(candidate.inventory.xml.failed.length, 0,
      "Minimap XML parses without refusal");
    assert.equal(candidate.inventory.lua.failed, 0,
      "Minimap.lua executes successfully");

    // These are the authored roots and the principal children of the stock minimap cluster. The
    // two virtual templates are checked separately because they are load-critical inheritance.
    for (const name of [
      "MinimapCluster",
      "MinimapZoneTextButton",
      "Minimap",
      "MinimapBackdrop",
      "MinimapZoomIn",
      "MinimapZoomOut",
      "MiniMapWorldMapButton",
      "MiniMapTracking",
      "MiniMapLFGFrame",
      "MiniMapMailFrame",
      "MiniMapBattlefieldFrame",
      "MinimapPing",
      "MiniMapInstanceDifficulty",
      "MiniMapRecordingButton",
    ]) {
      assert.ok(candidate.boot.bridge.getFrame(name), `${name} exists in the MPQ candidate`);
    }
    assert.equal(candidate.boot.bridge.getFrame("MinimapCluster")?.type, "Frame");
    assert.equal(candidate.boot.bridge.getFrame("Minimap")?.type, "Minimap");
    for (const name of ["EyeTemplate", "MiniMapButtonTemplate"]) {
      assert.ok(candidate.boot.bridge.registry.get(name), `${name} template exists`);
    }

    const before = metrics(baseline.inventory);
    const after = metrics(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
    assert.ok(delta.files >= MINIMAP_TOC.length + 1, `files delta: ${JSON.stringify(delta)}`);
    assert.ok(delta.widgets > 0, `widgets delta: ${JSON.stringify(delta)}`);
    // Minimap.lua is reached by Minimap.xml's relative Script; XML itself is parsed, not counted
    // as a Lua chunk.
    assert.ok(delta.lua >= 1, `Lua delta: ${JSON.stringify(delta)}`);
    assert.ok(delta.api > 0, `API delta: ${JSON.stringify(delta)}`);

    const baselineErrors = new Set(baseline.inventory.errors.map(errorKey));
    const candidateSpecificErrors = candidate.inventory.errors.filter(
      (error) => !baselineErrors.has(errorKey(error)),
    );
    const candidateSpecificUnhandled = candidateSpecificErrors.filter((error) => !error.handled);
    assert.ok(candidateSpecificUnhandled.length <= UNHANDLED_MINIMAP_ERROR_CEILING,
      `candidate-specific unhandled Lua: ${JSON.stringify(candidateSpecificUnhandled)}`);

    console.log(`[framexml Minimap] MPQ delta ${JSON.stringify({
      toc: MINIMAP_TOC,
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
