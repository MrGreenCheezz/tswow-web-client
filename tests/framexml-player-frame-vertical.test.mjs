import assert from "node:assert/strict";
import test from "node:test";

// This regression is MPQ-backed on purpose: the player frame's Lua state machine and XML
// inheritance must come from the client's own FrameXML, not from a fixture that repeats the names.
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

const PLAYER_FRAME_TOC = Object.freeze(["UnitFrame.xml", "PlayerFrame.xml"]);
const UNHANDLED_PLAYER_ERROR_CEILING = 0;
const decoder = new TextDecoder("utf-8");

function verticalPrefixThrough(entry) {
  const end = FRAMEXML_VERTICAL_TOC.indexOf(entry);
  assert.ok(end >= 0, `${entry} is present in the vertical TOC`);
  return FRAMEXML_VERTICAL_TOC.slice(0, end + 1);
}

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

test("MPQ PlayerFrame vertical loads the stock frame and its core children", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  let baseline;
  let candidate;
  try {
    // Pin the ownership and order against the actual FrameXML.toc. This catches an invented file
    // name and a dependency placed after PlayerFrame even when the synthetic subset happens to run.
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
    const playerPositions = PLAYER_FRAME_TOC.map((entry) => realPaths.indexOf(
      normalized(`interface/framexml/${entry}`),
    ));
    assert.ok(playerPositions[0] >= 0 && playerPositions[1] > playerPositions[0],
      `UnitFrame.xml precedes PlayerFrame.xml in stock TOC: ${JSON.stringify(playerPositions)}`);

    // Keep this regression scoped to the prefix through PlayerFrame. A future vertical tail
    // (TargetFrame, minimap, auras, ...) must not enter either side of this comparison.
    const playerVertical = verticalPrefixThrough("PlayerFrame.xml");
    const playerEntries = new Set(PLAYER_FRAME_TOC.map(normalized));
    const baselineSubset = playerVertical.filter((entry) => !playerEntries.has(normalized(entry)));
    baseline = await loadFromMpq(chain, baselineSubset);
    candidate = await loadFromMpq(chain, playerVertical);

    // The baseline is the intentionally red half of this regression: without the two MPQ-owned
    // entries there is no player-frame root or health bar to mount.
    assert.equal(baseline.boot.bridge.getFrame("PlayerFrame")?.name, undefined,
      "baseline does not have PlayerFrame");
    assert.equal(baseline.boot.bridge.getFrame("PlayerFrameHealthBar")?.name, undefined,
      "baseline does not have PlayerFrameHealthBar");

    for (const entry of PLAYER_FRAME_TOC) {
      assert.ok(candidate.requests.has(normalized(`interface/framexml/${entry}`)),
        `${entry} was read from MPQ`);
    }
    assert.equal(candidate.inventory.files.missing.length, 0,
      "player-frame vertical has no missing files");
    assert.equal(candidate.inventory.xml.failed.length, 0,
      "player-frame XML parses without refusal");
    assert.equal(candidate.inventory.lua.failed, 0,
      "UnitFrame.lua and PlayerFrame.lua execute successfully");

    // These are the core declarations needed to mount the stock player unit frame. Optional
    // speaker/ready-check/dropdown children inherit owners outside this deliberately bounded slice.
    for (const name of [
      "PlayerFrame",
      "PlayerName",
      "PlayerPortrait",
      "PlayerFrameFlash",
      "PlayerFrameHealthBar",
      "PlayerFrameHealthBarText",
      "PlayerFrameManaBar",
      "PlayerFrameManaBarText",
    ]) {
      assert.ok(candidate.boot.bridge.getFrame(name), `${name} exists in the MPQ candidate`);
    }
    assert.equal(candidate.boot.bridge.getFrame("PlayerFrame")?.type, "Button");
    assert.equal(candidate.boot.bridge.getFrame("PlayerFrameHealthBar")?.type, "StatusBar");
    assert.equal(candidate.boot.bridge.getFrame("PlayerFrameManaBar")?.type, "StatusBar");

    // The direct and transitive templates are the load-critical inheritance surface for those
    // declarations; checking the registry makes a missing template visible independently of names.
    for (const name of [
      "SecureUnitButtonTemplate",
      "SecureFrameTemplate",
      "TextStatusBar",
      "TextStatusBarText",
      "GameFontNormalSmall",
      "NumberFontNormalHuge",
    ]) {
      assert.ok(candidate.boot.bridge.registry.get(name), `${name} template exists`);
    }

    const api = new Map(candidate.inventory.api.map((entry) => [entry.name, entry]));
    for (const name of ["UnitHealthMax", "UnitIsConnected", "UnitName"]) {
      assert.ok((api.get(name)?.calls ?? 0) > 0, `${name} was reached by PlayerFrame`);
    }

    const before = metrics(baseline.inventory);
    const after = metrics(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
    assert.ok(delta.files >= PLAYER_FRAME_TOC.length, `files delta: ${JSON.stringify(delta)}`);
    assert.ok(delta.widgets > 0, `widgets delta: ${JSON.stringify(delta)}`);
    assert.ok(delta.lua >= PLAYER_FRAME_TOC.length, `Lua delta: ${JSON.stringify(delta)}`);
    assert.ok(delta.api > 0, `API delta: ${JSON.stringify(delta)}`);

    const baselineErrors = new Set(baseline.inventory.errors.map(errorKey));
    const candidateSpecificErrors = candidate.inventory.errors.filter(
      (error) => !baselineErrors.has(errorKey(error)),
    );
    const candidateSpecificUnhandled = candidateSpecificErrors.filter((error) => !error.handled);
    assert.ok(candidateSpecificUnhandled.length <= UNHANDLED_PLAYER_ERROR_CEILING,
      `candidate-specific unhandled Lua: ${JSON.stringify(candidateSpecificUnhandled)}`);

    console.log(`[framexml F5] PlayerFrame MPQ delta ${JSON.stringify({
      toc: PLAYER_FRAME_TOC,
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
