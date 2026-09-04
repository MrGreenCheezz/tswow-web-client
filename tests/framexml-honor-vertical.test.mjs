import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH } =
  await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");

const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();

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

async function load(chain, subset, seam) {
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
    seam,
    exercise: false,
    screen: () => ({ width: 1024, height: 768 }),
  });
  return { boot, inventory: await boot.load(), requests };
}

test("MPQ HonorFrame loads as an unrouted CharacterFrame child and renders its seam data",
  withClient, async () => {
    const { clientArchives } = await import("../tools/mpq.mjs");
    const chain = await clientArchives(clientDirectory);
    let baseline;
    let candidate;
    try {
      const toc = await chain.read(FRAMEXML_TOC_PATH);
      assert.ok(toc, "FrameXML.toc is present in the MPQ chain");
      const realPaths = parseGlueToc(decoder.decode(toc), "interface/framexml/")
        .map((entry) => normalize(entry.path));
      const honorPath = realPaths.indexOf("interface/framexml/honorframe.xml");
      const reputationPath = realPaths.indexOf("interface/framexml/reputationframe.xml");
      assert.ok(honorPath >= 0 && reputationPath >= 0 && honorPath > reputationPath,
        "HonorFrame follows ReputationFrame in the retail TOC");
      assert.equal(FRAMEXML_VERTICAL_TOC.filter((entry) => normalize(entry) === "honorframe.xml").length, 1);

      const baselineSubset = FRAMEXML_VERTICAL_TOC.filter((entry) =>
        normalize(entry) !== "honorframe.xml");
      baseline = await load(chain, baselineSubset, new CannedWorldSeam());
      candidate = await load(chain, FRAMEXML_VERTICAL_TOC, new CannedWorldSeam());
      assert.equal(baseline.boot.bridge.getFrame("HonorFrame"), undefined,
        "comparison subset does not include HonorFrame");
      assert.ok(candidate.requests.has("interface/framexml/honorframe.xml"));
      assert.ok(candidate.requests.has("interface/framexml/honorframetemplates.xml"));
      assert.ok(candidate.requests.has("interface/framexml/honorframe.lua"));
      assert.equal(candidate.inventory.files.missing.length, 0);
      assert.equal(candidate.inventory.xml.failed.length, 0);
      assert.equal(candidate.inventory.lua.failed, 0);

      const before = metrics(baseline.inventory);
      const after = metrics(candidate.inventory);
      const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
      assert.deepEqual(delta, {
        files: 3, bytes: 19_636, widgets: 58, lua: 1,
        luaFailed: 0, errors: 0, distinctErrors: 0,
      }, `HonorFrame delta: ${JSON.stringify(delta)}`);

      const honor = candidate.boot.bridge.getFrame("HonorFrame");
      const character = candidate.boot.bridge.getFrame("CharacterFrame");
      assert.ok(honor && character, "HonorFrame and CharacterFrame exist");
      assert.equal(honor.parent, character, "HonorFrame keeps the stock parent");
      assert.equal(honor.id, 0, "HonorFrame has no stock tab id (runtime default is zero)");
      assert.equal(honor.visible, false, "HonorFrame starts hidden");

      const beforeShowErrors = candidate.boot.vm.errors.length;
      assert.equal(candidate.boot.bridge.Show(character), true);
      // This is a bridge proof of the stock child itself, not a claim that the
      // ordinary CharacterFrame tabs route to HonorFrame.  The retail PVPFrame
      // owner lives outside this bounded corpus and remains a later slice.
      assert.equal(candidate.boot.bridge.Show(honor), true,
        "the unrouted stock child can be shown directly for bridge verification");
      assert.ok(candidate.boot.bridge.dispatchEvent("PLAYER_ENTERING_WORLD") >= 1,
        "HonorFrame receives its stock initial-data event");
      assert.equal(candidate.boot.bridge.isVisible(honor), true);
      assert.equal(candidate.boot.bridge.getFrame("HonorFrameCurrentHKValue").text, "42");
      assert.equal(candidate.boot.bridge.getFrame("HonorFrameYesterdayHKValue").text, "17");
      assert.equal(candidate.boot.bridge.getFrame("HonorFrameYesterdayContributionValue").text, "650");
      assert.equal(candidate.boot.bridge.getFrame("HonorFrameLifeTimeHKValue").text, "1234");
      assert.notEqual(candidate.boot.bridge.getFrame("HonorFrameCurrentPVPTitle").text, "",
        "unavailable rank still renders stock NONE text");
      assert.match(candidate.boot.bridge.getFrame("HonorFrameCurrentPVPRank").text, /0/);
      assert.equal(candidate.boot.bridge.getFrame("HonorFrameProgressBar").statusBar?.value, 0);
      assert.equal(candidate.boot.vm.errors.length, beforeShowErrors,
        "showing and updating HonorFrame adds no Lua errors");

      assert.equal(candidate.boot.bridge.Hide(honor), true);
      assert.equal(candidate.boot.bridge.Hide(character), true);
      assert.equal(candidate.boot.bridge.isVisible(honor), false,
        "owner hide tears down the stock child effectively");
    } finally {
      candidate?.boot.close();
      baseline?.boot.close();
      chain.close();
    }
  });
