import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH } =
  await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");

const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const metrics = (inventory) => ({
  files: inventory.files.total,
  bytes: inventory.files.bytes,
  widgets: inventory.widgets.total,
  chunks: inventory.plan.chunks,
  lua: inventory.lua.executed,
  luaFailed: inventory.lua.failed,
  errors: inventory.lua.errorsRaised,
  distinctErrors: inventory.errors.length,
});

async function load(chain, subset) {
  const requests = new Set();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        requests.add(normalize(path));
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU",
    subset,
    seam: new CannedWorldSeam(),
    exercise: false,
    screen: () => ({ width: 1024, height: 768 }),
  });
  return { boot, inventory: await boot.load(), requests };
}

test("PVP battleground vertical closure is exact and adds no candidate errors", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  let baseline;
  let candidate;
  try {
    const toc = await chain.read(FRAMEXML_TOC_PATH);
    assert.ok(toc, "FrameXML.toc is present in the MPQ chain");
    const realPaths = parseGlueToc(decoder.decode(toc), "interface/framexml/")
      .map((entry) => normalize(entry.path));
    const battlefieldPath = realPaths.indexOf("interface/framexml/battlefieldframe.xml");
    const pvpPath = realPaths.indexOf("interface/framexml/pvpframe.xml");
    const battlegroundPath = realPaths.indexOf("interface/framexml/pvpbattlegroundframe.xml");
    const mainMenuBarPath = realPaths.indexOf("interface/framexml/mainmenubar.xml");
    const previousPath = realPaths.indexOf("interface/framexml/classtrainerframetemplates.xml");
    assert.ok(battlefieldPath >= 0 && mainMenuBarPath >= 0 && battlefieldPath < mainMenuBarPath,
      "BattlefieldFrame precedes MainMenuBar in the retail TOC");
    assert.ok(pvpPath >= 0 && battlegroundPath >= 0 && pvpPath < battlegroundPath,
      "PVPBattlegroundFrame follows PVPFrame in the retail TOC");
    assert.ok(previousPath >= 0 && pvpPath > previousPath,
      "PVPFrame follows the trainer templates in the retail TOC");
    const pvpEntries = FRAMEXML_VERTICAL_TOC.filter((entry) => normalize(entry) === "pvpframe.xml");
    const battlefieldEntries = FRAMEXML_VERTICAL_TOC.filter((entry) => normalize(entry) === "battlefieldframe.xml");
    const battlegroundEntries = FRAMEXML_VERTICAL_TOC
      .filter((entry) => normalize(entry) === "pvpbattlegroundframe.xml");
    assert.equal(pvpEntries.length, 1);
    assert.equal(battlefieldEntries.length, 1);
    assert.equal(battlegroundEntries.length, 1);
    const baselineSubset = FRAMEXML_VERTICAL_TOC.filter((entry) => {
      const path = normalize(entry);
      return path !== "battlefieldframe.xml" && path !== "pvpbattlegroundframe.xml";
    });
    baseline = await load(chain, baselineSubset);
    candidate = await load(chain, FRAMEXML_VERTICAL_TOC);
    assert.equal(baseline.boot.bridge.getFrame("BattlefieldFrame")?.name, undefined);
    assert.equal(baseline.boot.bridge.getFrame("PVPBattlegroundFrame")?.name, undefined);
    assert.ok(baseline.boot.bridge.getFrame("PVPParentFrame"));
    assert.ok(candidate.requests.has("interface/framexml/battlefieldframe.xml"));
    assert.ok(candidate.requests.has("interface/framexml/pvpframe.xml"));
    assert.ok(candidate.requests.has("interface/framexml/pvpbattlegroundframe.xml"));
    assert.ok(candidate.requests.has("interface/framexml/pvpframetemplates.xml"));
    assert.ok(candidate.requests.has("interface/framexml/pvpframe.lua"));
    assert.equal(candidate.inventory.files.missing.length, 0);
    assert.equal(candidate.inventory.xml.failed.length, 0);
    assert.equal(candidate.inventory.lua.failed, 0);
    const before = metrics(baseline.inventory);
    const after = metrics(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
    assert.deepEqual(delta, {
      files: 4, bytes: 71825, widgets: 216, chunks: 22, lua: 2,
      luaFailed: 0, errors: 0, distinctErrors: 0,
    }, `PVPFrame delta: ${JSON.stringify(delta)}`);
    const errorKey = (error) => `${error.file}|${error.message}`;
    const baselineErrors = new Set(baseline.inventory.errors.map(errorKey));
    const candidateSpecificErrors = candidate.inventory.errors
      .filter((error) => !baselineErrors.has(errorKey(error)));
    assert.deepEqual(candidateSpecificErrors, [],
      "PVPFrame adds no candidate-specific Lua errors");
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
    chain.close();
  }
});
