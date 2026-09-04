import assert from "node:assert/strict";
import test from "node:test";

// This regression is intentionally MPQ-backed: a fixture that repeats the expected widget names
// would not prove that the real TOC still reaches the real XML and its Script dependency.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");

const CASTING_BAR_XML = "interface/framexml/castingbarframe.xml";
const CASTING_BAR_LUA = "interface/framexml/castingbarframe.lua";
const VERTICAL_ERROR_CEILING = 8;

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
      return data ? new TextDecoder("utf-8").decode(data) : undefined;
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

test("the vertical subset loads CastingBarFrame and reaches both cast APIs", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  // Keep this regression scoped to the prefix that existed when CastingBarFrame was added. A
  // future vertical tail (TargetFrame, minimap, auras, ...) must not enter its baseline.
  const castingBarVertical = verticalPrefixThrough("CastingBarFrame.xml");
  const withoutCastingBar = castingBarVertical.filter((entry) => entry !== "CastingBarFrame.xml");
  let baseline;
  let candidate;
  try {
    baseline = await loadFromMpq(chain, withoutCastingBar);
    candidate = await loadFromMpq(chain, castingBarVertical);

    // The candidate must have pulled the real XML and the XML's own relative Script, rather than
    // merely inheriting a pre-existing frame with this name.
    assert.ok(candidate.requests.has(CASTING_BAR_XML), "CastingBarFrame.xml was read from MPQ");
    assert.ok(candidate.requests.has(CASTING_BAR_LUA), "CastingBarFrame.lua was read from MPQ");
    assert.ok(candidate.inventory.files.total >= baseline.inventory.files.total + 2,
      `files: baseline ${baseline.inventory.files.total}, candidate ${candidate.inventory.files.total}`);
    assert.equal(candidate.inventory.files.missing.length, 0, "vertical MPQ subset has no missing files");
    assert.equal(candidate.inventory.lua.failed, 0, "CastingBarFrame.lua does not fail to execute");

    // The existing vertical slice ceiling is the contract: adding the castbar must not consume
    // another error, and a clean candidate must not hide a newly raised one behind a fixed floor.
    assert.ok(baseline.inventory.lua.errorsRaised <= VERTICAL_ERROR_CEILING,
      `baseline errors: ${baseline.inventory.lua.errorsRaised}`);
    assert.ok(candidate.inventory.lua.errorsRaised <= VERTICAL_ERROR_CEILING,
      `candidate errors: ${candidate.inventory.lua.errorsRaised}`);
    assert.ok(candidate.inventory.lua.errorsRaised <= baseline.inventory.lua.errorsRaised,
      `candidate added errors: baseline ${baseline.inventory.lua.errorsRaised}, `
      + `candidate ${candidate.inventory.lua.errorsRaised}`);

    const frame = (name) => candidate.boot.bridge.getFrame(name);
    const castbar = frame("CastingBarFrame");
    assert.ok(castbar, "CastingBarFrame exists");
    assert.equal(castbar.type, "StatusBar");
    // The template is virtual; its children are materialised on the concrete bar.
    for (const name of [
      "CastingBarFrameBorder",
      "CastingBarFrameBorderShield",
      "CastingBarFrameText",
      "CastingBarFrameIcon",
      "CastingBarFrameSpark",
      "CastingBarFrameFlash",
    ]) {
      assert.ok(frame(name), `${name} exists from CastingBarFrameTemplate`);
    }

    const api = new Map(candidate.inventory.api.map((entry) => [entry.name, entry]));
    for (const name of ["UnitCastingInfo", "UnitChannelInfo"]) {
      assert.ok((api.get(name)?.calls ?? 0) > 0, `${name} was reached during PLAYER_ENTERING_WORLD`);
    }

    console.log(`[framexml F4] castbar vertical: files ${candidate.inventory.files.total}, `
      + `widgets ${candidate.inventory.widgets.total}, Lua errors `
      + `${candidate.inventory.lua.errorsRaised}, `
      + `UnitCastingInfo/UnitChannelInfo ${api.get("UnitCastingInfo")?.calls}/`
      + `${api.get("UnitChannelInfo")?.calls}`);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
    chain.close();
  }
});
