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
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");

const decoder = new TextDecoder("utf-8");

/** What the core sends back for CMSG_BATTLEFIELD_LIST from the PvP frame (`fromWhere` 1). */
function battlegroundList(bgTypeId) {
  return {
    battlemasterGuid: 0n,
    fromWhere: 1,
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

test("a battleground list answer repaints PVPBattlegroundFrame and does not ask for the list again", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    exercise: false,
    screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    const inventory = await boot.load();
    assert.equal(inventory.lua.failed, 0);
    const requests = seam.battlegroundListRequests;
    // A battleground is selected, as OnLoad's `BattlegroundType1:Click()` or the player leaves it.
    const asked = requests.length;
    assert.equal(boot.vm.executeReported(
      "PVPBattlegroundFrame.selectedBG = 1; RequestBattlegroundInstanceInfo(1)", "@pvp-list-answer-select"), true);
    assert.equal(requests.length, asked + 1, "selecting a battleground asks for its list");
    // The core answers every request. Mapped to PVPQUEUE_ANYWHERE_UPDATE_AVAILABLE, the answer made
    // the stock handler (PVPBattleground_ResetInfo) ask again, and the live client and the core
    // ping-ponged about twenty lists a second for the whole session.
    let answered = asked;
    while (answered < requests.length && answered < asked + 10) {
      seam.setBattlefieldList(battlegroundList(requests[answered].bgTypeId));
      answered++;
    }
    assert.equal(requests.length - asked, 1,
      `an answer must not ask again: ${requests.length - asked} requests for ${answered - asked} answers`);
    assert.equal(boot.vm.executeReported(
      "WEBCLIENT_TEST_PVP_CURRENT = PVPBattlegroundFrame.currentData == true", "@pvp-list-answer-read"), true);
    assert.equal(boot.vm.getGlobal("WEBCLIENT_TEST_PVP_CURRENT"), true, "the answer reached the stock frame as its data");
  } finally {
    boot.close();
    chain.close();
  }
});
