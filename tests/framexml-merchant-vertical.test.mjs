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
const { FRAMEXML_TOC_PATH, FRAMEXML_VERTICAL_TOC } =
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

test("MerchantFrame is the exact stock vertical tail and remains renderable", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  let baseline;
  let candidate;
  try {
    const toc = await chain.read(FRAMEXML_TOC_PATH);
    assert.ok(toc);
    const realPaths = parseGlueToc(decoder.decode(toc), "interface/framexml/")
      .map((entry) => normalize(entry.path));
    const merchantPath = realPaths.indexOf("interface/framexml/merchantframe.xml");
    const questInfoPath = realPaths.indexOf("interface/framexml/questinfo.xml");
    const containerPath = realPaths.indexOf("interface/framexml/containerframe.xml");
    assert.ok(merchantPath >= 0 && questInfoPath >= 0 && containerPath >= 0);
    assert.ok(questInfoPath < merchantPath && merchantPath < containerPath,
      "MerchantFrame follows QuestInfo and precedes ContainerFrame in stock TOC");
    assert.equal(FRAMEXML_VERTICAL_TOC.filter((entry) => normalize(entry) === "merchantframe.xml").length, 1);
    const baselineSubset = FRAMEXML_VERTICAL_TOC.filter((entry) => normalize(entry) !== "merchantframe.xml");
    baseline = await load(chain, baselineSubset);
    candidate = await load(chain, FRAMEXML_VERTICAL_TOC);
    assert.equal(baseline.boot.bridge.getFrame("MerchantFrame"), undefined);
    assert.ok(candidate.requests.has("interface/framexml/merchantframe.xml"));
    assert.ok(candidate.requests.has("interface/framexml/merchantframe.lua"));
    assert.equal(candidate.inventory.files.missing.length, 0);
    assert.equal(candidate.inventory.xml.failed.length, 0);
    assert.equal(candidate.inventory.lua.failed, 0);
    const before = metrics(baseline.inventory);
    const after = metrics(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
    assert.deepEqual(delta, {
      files: 2, bytes: 46873, widgets: 583, chunks: 29, lua: 1, luaFailed: 0,
    }, `MerchantFrame delta: ${JSON.stringify(delta)}`);

    const frame = (name) => candidate.boot.bridge.getFrame(name);
    const merchant = frame("MerchantFrame");
    assert.ok(merchant);
    assert.equal(merchant.type, "Frame");
    assert.equal(candidate.boot.bridge.isVisible(merchant), false);
    for (const name of [
      "MerchantNameText", "MerchantFramePortrait", "MerchantFrameCloseButton",
      "MerchantFrameTab1", "MerchantFrameTab2", "MerchantPrevPageButton", "MerchantNextPageButton",
      "MerchantRepairAllButton", "MerchantRepairItemButton", "MerchantBuyBackItem",
      ...Array.from({ length: 12 }, (_, index) => `MerchantItem${index + 1}`),
    ]) assert.ok(frame(name), `${name} exists in stock MerchantFrame`);
    for (const name of [
      "MerchantItem1ItemButton", "MerchantItem10ItemButton", "MerchantBuyBackItemItemButton",
    ]) assert.ok(frame(name), `${name} item button exists`);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
    chain.close();
  }
});
