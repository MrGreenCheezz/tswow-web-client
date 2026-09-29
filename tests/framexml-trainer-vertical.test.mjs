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
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH } = await import(
  "../dist/code/browser/framexml/FrameXmlCorpus.js",
);
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");

const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const DEPENDENCIES = new Set(["staticpopup.xml", "classtrainerframetemplates.xml"]);

function metrics(inventory) {
  return {
    files: inventory.files.total,
    bytes: inventory.files.bytes,
    widgets: inventory.widgets.total,
    chunks: inventory.plan.chunks,
    lua: inventory.lua.executed,
    luaFailed: inventory.lua.failed,
    errorsRaised: inventory.lua.errorsRaised,
    distinctErrors: inventory.errors.length,
  };
}

async function load(chain, subset) {
  const requests = [];
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        requests.push(normalize(path));
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

function errorKey(error) {
  return `${error.file}|${error.line}|${error.message}`;
}

test("Trainer dependencies preserve stock TOC order and exact vertical delta", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  let baseline;
  let candidate;
  try {
    const toc = await chain.read(FRAMEXML_TOC_PATH);
    assert.ok(toc, "stock FrameXML.toc exists in the local MPQ chain");
    const stockPaths = parseGlueToc(decoder.decode(toc), "interface/framexml/")
      .map((entry) => normalize(entry.path));
    const autoComplete = stockPaths.indexOf("interface/framexml/autocomplete.xml");
    const staticPopup = stockPaths.indexOf("interface/framexml/staticpopup.xml");
    const trainerTemplates = stockPaths.indexOf("interface/framexml/classtrainerframetemplates.xml");
    const pvp = stockPaths.indexOf("interface/framexml/pvpframe.xml");
    assert.ok(autoComplete >= 0 && staticPopup === autoComplete + 1,
      "StaticPopup.xml follows AutoComplete.xml in stock TOC");
    assert.ok(trainerTemplates >= 0 && pvp > trainerTemplates,
      "ClassTrainerFrameTemplates.xml precedes PVPFrame.xml in stock TOC");

    assert.equal(FRAMEXML_VERTICAL_TOC.filter((entry) => normalize(entry) === "staticpopup.xml").length, 1);
    assert.equal(FRAMEXML_VERTICAL_TOC
      .filter((entry) => normalize(entry) === "classtrainerframetemplates.xml").length, 1);
    const staticIndex = FRAMEXML_VERTICAL_TOC.findIndex((entry) => normalize(entry) === "staticpopup.xml");
    const autoIndex = FRAMEXML_VERTICAL_TOC.findIndex((entry) => normalize(entry) === "autocomplete.xml");
    const templateIndex = FRAMEXML_VERTICAL_TOC
      .findIndex((entry) => normalize(entry) === "classtrainerframetemplates.xml");
    const pvpIndex = FRAMEXML_VERTICAL_TOC.findIndex((entry) => normalize(entry) === "pvpframe.xml");
    assert.equal(staticIndex, autoIndex + 1);
    assert.ok(templateIndex >= 0 && pvpIndex > templateIndex);

    baseline = await load(chain, FRAMEXML_VERTICAL_TOC
      .filter((entry) => !DEPENDENCIES.has(normalize(entry))));
    candidate = await load(chain, FRAMEXML_VERTICAL_TOC);
    assert.deepEqual({
      ...Object.fromEntries(Object.entries(metrics(candidate.inventory)).map(([key, value]) => [
        key, value - metrics(baseline.inventory)[key],
      ])),
    }, {
      files: 3,
      bytes: 106773,
      // StaticPopup's four concrete MoneyInputFrameTemplate children now inherit their full
      // stock edit-box/texture tree, adding 76 widgets to the measured dependency delta.
      widgets: 296,
      chunks: 21,
      lua: 1,
      luaFailed: 0,
      errorsRaised: 0,
      distinctErrors: 0,
    });
    assert.equal(candidate.inventory.files.missing.length, 0);
    assert.equal(candidate.inventory.xml.failed.length, 0);
    assert.equal(candidate.inventory.lua.failed, 0);
    assert.deepEqual(candidate.inventory.errors.filter((error) =>
      !new Set(baseline.inventory.errors.map(errorKey)).has(errorKey(error))), []);
    assert.ok(candidate.requests.includes("interface/framexml/staticpopup.xml"));
    assert.ok(candidate.requests.includes("interface/framexml/staticpopup.lua"));
    assert.ok(candidate.requests.includes("interface/framexml/classtrainerframetemplates.xml"));

    assert.equal(candidate.boot.bridge.getFrame("ClassTrainerFrame")?.name, undefined,
      "vertical inventory does not load the LoD root before Blizzard_TrainerUI is requested");
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
    chain.close();
  }
});
