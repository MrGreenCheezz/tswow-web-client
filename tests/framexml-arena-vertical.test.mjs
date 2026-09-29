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
const { FRAMEXML_SEAM_EVENTS } = await import(
  "../dist/code/browser/framexml/FrameXmlWorldSeam.js",
);
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");

const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();

function arenaList(guid = 0x1234n, fromWhere = 0, bgTypeId = 6) {
  return {
    battlemasterGuid: guid,
    fromWhere,
    bgTypeId,
    hasWin: false,
    winHonor: 0,
    winArena: 0,
    lossHonor: 0,
    random: false,
    randomHasWin: false,
    randomWinHonor: 0,
    randomWinArena: 0,
    randomLossHonor: 0,
    instances: [],
  };
}

async function load(chain, subset) {
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
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
  return { boot, seam, inventory: await boot.load() };
}

function metrics(inventory) {
  return {
    files: inventory.files.total,
    bytes: inventory.files.bytes,
    widgets: inventory.widgets.total,
    chunks: inventory.plan.chunks,
    lua: inventory.lua.executed,
  };
}

test("ArenaFrame is an exact stock TOC delta with a complete gated tree", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  let baseline;
  let candidate;
  try {
    const toc = await chain.read(FRAMEXML_TOC_PATH);
    assert.ok(toc, "FrameXML.toc exists in the local MPQ chain");
    const realPaths = parseGlueToc(decoder.decode(toc), "interface/framexml/")
      .map((entry) => normalize(entry.path));
    const pvp = realPaths.indexOf("interface/framexml/pvpframe.xml");
    const battleground = realPaths.indexOf("interface/framexml/pvpbattlegroundframe.xml");
    const arena = realPaths.indexOf("interface/framexml/arenaframe.xml");
    const registrar = realPaths.indexOf("interface/framexml/arenaregistrarframe.xml");
    assert.ok(pvp >= 0 && battleground > pvp && arena > battleground && registrar > arena,
      "the stock TOC orders ArenaFrame after PVPBattlegroundFrame and before ArenaRegistrarFrame");
    assert.deepEqual(FRAMEXML_VERTICAL_TOC.slice(FRAMEXML_VERTICAL_TOC.indexOf("PVPFrame.xml"),
      FRAMEXML_VERTICAL_TOC.indexOf("ArenaFrame.xml") + 1), [
      "PVPFrame.xml", "PVPBattlegroundFrame.xml", "ArenaFrame.xml",
    ]);

    const withoutArena = FRAMEXML_VERTICAL_TOC
      .filter((entry) => normalize(entry) !== "arenaframe.xml");
    baseline = await load(chain, withoutArena);
    candidate = await load(chain, FRAMEXML_VERTICAL_TOC);
    assert.deepEqual({
      files: metrics(candidate.inventory).files - metrics(baseline.inventory).files,
      bytes: metrics(candidate.inventory).bytes - metrics(baseline.inventory).bytes,
      widgets: metrics(candidate.inventory).widgets - metrics(baseline.inventory).widgets,
      chunks: metrics(candidate.inventory).chunks - metrics(baseline.inventory).chunks,
      lua: metrics(candidate.inventory).lua - metrics(baseline.inventory).lua,
    }, { files: 2, bytes: 12916, widgets: 57, chunks: 7, lua: 1 });
    assert.equal(candidate.inventory.files.missing.length, 0);
    assert.equal(candidate.inventory.xml.failed.length, 0);
    assert.equal(candidate.inventory.lua.failed, 0);

    const arenaFrame = candidate.boot.bridge.getFrame("ArenaFrame");
    assert.ok(arenaFrame);
    assert.equal(candidate.boot.bridge.isVisible(arenaFrame), false,
      "ArenaFrame remains closed until BATTLEFIELDS_SHOW from a valid list");
    assert.equal(arenaFrame.scriptFunctions.get("OnLoad"), "ArenaFrame_OnLoad");
    assert.equal(arenaFrame.scriptFunctions.get("OnEvent"), "ArenaFrame_OnEvent");
    assert.equal(arenaFrame.scriptSources.has("OnShow"), true, "ArenaFrame has stock OnShow");
    assert.equal(arenaFrame.scriptSources.has("OnHide"), true, "ArenaFrame has stock OnHide");
    for (const event of [
      "BATTLEFIELDS_SHOW", "BATTLEFIELDS_CLOSED", "UPDATE_BATTLEFIELD_STATUS", "PARTY_LEADER_CHANGED",
    ]) assert.equal(arenaFrame.registeredEvents.has(event), true, `ArenaFrame registers ${event}`);
    for (const name of [
      "ArenaZone1", "ArenaZone2", "ArenaZone3", "ArenaZone4", "ArenaZone5", "ArenaZone6",
      "ArenaFrameJoinButton", "ArenaFrameGroupJoinButton", "ArenaFrameCancelButton", "ArenaFrameCloseButton",
    ]) {
      const child = candidate.boot.bridge.getFrame(name);
      assert.ok(child, `${name} exists`);
      assert.equal(child.type, "Button", `${name} is a stock Button`);
      assert.equal(child.parent, arenaFrame, `${name} is owned by ArenaFrame`);
    }

    candidate.seam.setArenaSeason(5);
    candidate.seam.setPartyLeader(true);
    candidate.seam.setBattlefieldList(arenaList());
    assert.equal(candidate.boot.bridge.isVisible(arenaFrame), true,
      "fresh battlemaster arena list opens the stock root");
    assert.equal(candidate.boot.bridge.Click(candidate.boot.bridge.getFrame("ArenaZone4")), true);
    assert.equal(candidate.boot.bridge.Click(candidate.boot.bridge.getFrame("ArenaFrameJoinButton")), true);
    assert.equal(candidate.boot.bridge.isVisible(arenaFrame), false);
    assert.deepEqual(candidate.seam.arenaJoins.map((join) => ({
      guid: join.battlemasterGuid.toString(), slot: join.arenaSlot, group: join.asGroup, rated: join.rated,
    })), [{ guid: "4660", slot: 0, group: false, rated: false }]);

    candidate.seam.setBattlefieldList(arenaList(0x1235n));
    assert.equal(candidate.boot.bridge.isVisible(arenaFrame), true);
    assert.equal(candidate.boot.bridge.Click(candidate.boot.bridge.getFrame("ArenaZone1")), true);
    assert.equal(candidate.boot.bridge.Click(candidate.boot.bridge.getFrame("ArenaFrameGroupJoinButton")), true);
    assert.deepEqual(candidate.seam.arenaJoins.at(-1), {
      battlemasterGuid: 0x1235n, arenaSlot: 0, asGroup: true, rated: true,
    });

    candidate.seam.setBattlefieldList(arenaList(0x1236n));
    assert.equal(candidate.boot.bridge.isVisible(arenaFrame), true);
    candidate.seam.setBattlefieldList(arenaList(0x1236n, 1));
    assert.equal(candidate.boot.bridge.isVisible(arenaFrame), false,
      "queue-originated list closes an already-open arena owner");
    candidate.boot.bridge.dispatchEvent(FRAMEXML_SEAM_EVENTS.battlefieldStatus);
    assert.equal(candidate.boot.bridge.isVisible(arenaFrame), false,
      "late queue/status events cannot reopen stale ArenaFrame");
    candidate.seam.setBattlefieldList(arenaList(0x1237n));
    assert.equal(candidate.boot.bridge.isVisible(arenaFrame), true,
      "a new fresh arena list is the only reopen path");
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
    chain.close();
  }
});
