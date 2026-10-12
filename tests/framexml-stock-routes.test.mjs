// Plan item 3.24 (12.10): the native routes that ask the stock interface first — the scoreboard key and an arena
// battlemaster's list — each module loaded alone with its imports replaced (fixtures/isolated-ui.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { isolatedModule } from "./fixtures/isolated-ui.mjs";

test("TOGGLEWORLDSTATESCORES runs stock ToggleWorldStateScoreFrame while it is published, else the native board", async () => {
  let stock = false;
  let stockCalls = 0;
  let nativeCalls = 0;
  const actions = await isolatedModule("browser/input/Actions", {
    "../game/Context.js": { game: { world: {} } },
    "../framexml/FrameXmlScoreboardController.js": {
      toggleFrameXmlScoreboard: () => { stockCalls += 1; return stock; },
    },
    "../ui/Scoreboard.js": { toggleScoreboard: () => { nativeCalls += 1; } },
    "./Bindings.js": { ACTION_BAR_SLOTS: [], ACTION_BAR_PAGES: [], EXTRA_ACTION_BAR_SLOTS: {} },
    "../../world/ActionBarProtocol.js": { EXTRA_ACTION_BARS: [], actionPage: () => 0 },
  });
  assert.equal(actions.runAction("toggleWorldStateScores"), true);
  assert.deepEqual([stockCalls, nativeCalls], [1, 1], "no stock owner: the native window");
  stock = true;
  assert.equal(actions.runAction("toggleWorldStateScores"), true);
  assert.deepEqual([stockCalls, nativeCalls], [2, 1], "the stock owner answered: no native window beside it");
});

function fakeElement() {
  const element = {
    hidden: true, textContent: "", className: "", children: [], type: "", ariaLabel: "",
    replaceChildren(...nodes) { element.children = nodes; },
    append(...nodes) { element.children.push(...nodes); },
    addEventListener() {}, setAttribute() {}, removeAttribute() {},
  };
  return element;
}

async function battlemaster(arenaPublished) {
  const dom = {
    gossipWindow: fakeElement(), gossipTitle: fakeElement(), gossipText: fakeElement(),
    gossipOptions: fakeElement(), gossipQuests: fakeElement(), targetName: fakeElement(),
  };
  globalThis.document = { createElement: () => fakeElement() };
  const list = { battlemasterGuid: 0x99n, fromWhere: 0, bgTypeId: 6, instances: [], winHonor: 0, lossHonor: 0 };
  const world = { battlefieldList: list, group: undefined, joinArena() {} };
  const npc = await isolatedModule("browser/ui/Npc", {
    "../game/Context.js": { game: { world, gatewayOrigin: "" } },
    "./Dom.js": dom,
    "../../world/PvpProtocol.js": { BATTLEGROUND_AA: 6 },
    "../framexml/FrameXmlPvpController.js": { frameXmlPvpArenaPublished: () => arenaPublished },
  });
  // The «waiting» card a battlemaster click put up (Npc.ts showPendingNpcDialog).
  dom.gossipWindow.hidden = false;
  dom.gossipText.textContent = "Ожидание ответа NPC…";
  npc.showBattlegroundList();
  return dom;
}

test("an arena battlemaster's list is stock ArenaFrame's once the PvP owner holds it; the native dialog is the fallback", async () => {
  try {
    const stock = await battlemaster(true);
    assert.equal(stock.gossipWindow.hidden, true, "the waiting card steps aside for stock ArenaFrame");
    assert.equal(stock.gossipOptions.children.length, 0, "no native size buttons beside it");
    const native = await battlemaster(false);
    assert.equal(native.gossipWindow.hidden, false);
    assert.equal(native.gossipTitle.textContent, "Арена");
    assert.equal(native.gossipOptions.children.length, 3, "2×2, 3×3, 5×5");
  } finally {
    delete globalThis.document;
  }
});
