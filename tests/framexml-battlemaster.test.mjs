// 3.24 (12.10): the battlemaster's battleground list — Wow.exe's one list state (0x0054e390, 0x005496d0,
// 0x0054bb40/0x0054bbd0, 0x0054cc70) and stock BattlefieldFrame over it, gated as the world mount does.
import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}

const { FrameXmlBattlefieldListState } = await import("../dist/code/browser/framexml/FrameXmlBattlefieldList.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} seam binding exists`);
  return [...binding(seam, args)];
}

const MASTER = 0xF1300000E3000777n;

function list(overrides = {}) {
  return {
    battlemasterGuid: MASTER, fromWhere: 0, bgTypeId: 2,
    hasWin: false, winHonor: 0, winArena: 0, lossHonor: 0,
    random: false, randomHasWin: false, randomWinHonor: 0, randomWinArena: 0, randomLossHonor: 0,
    instances: [12, 15],
    ...overrides,
  };
}

const FACTS = { maxGroupSize: 10, partyMembers: 0, raidMembers: 0, inBattleground: false };

test("the list state raises Wow.exe's edges and keeps the battlemaster as 0x0054e390 does", () => {
  const state = new FrameXmlBattlefieldListState();
  assert.deepEqual(state.receive(list()), ["BATTLEFIELDS_SHOW"]);
  assert.equal(state.guid, MASTER);
  assert.equal(state.type, 2);
  // The PvP tab's answer replaces the rows and the type but leaves the battlemaster alone.
  assert.deepEqual(state.receive(list({ fromWhere: 1, battlemasterGuid: 0n, bgTypeId: 3, instances: [4] })),
    ["PVPQUEUE_ANYWHERE_SHOW"]);
  assert.equal(state.guid, MASTER);
  assert.equal(state.count(), 1);
  // A random battlemaster opens the PvP frame instead (0x280), and becomes the battlemaster.
  assert.deepEqual(state.receive(list({ bgTypeId: 32, battlemasterGuid: 0x99n, instances: [] })), ["NPC_PVPQUEUE_ANYWHERE"]);
  assert.equal(state.guid, 0x99n);
  // A battlemaster's list without a guid: 0x005496d0(0) closes, then the handler shows.
  assert.deepEqual(state.receive(list({ battlemasterGuid: 0n })), ["BATTLEFIELDS_CLOSED", "BATTLEFIELDS_SHOW"]);
  assert.equal(state.guid, 0n);
  assert.deepEqual(state.receive(undefined), ["PVPQUEUE_ANYWHERE_SHOW"]);
});

test("selection and join follow 0x0054bb40/0x0054bbd0/0x0054cc70", () => {
  const state = new FrameXmlBattlefieldListState();
  assert.deepEqual(state.join(0, false, FACTS), { kind: "none" }, "no list type, no join");
  state.receive(list());
  assert.equal(state.selectedIndex(), 0);
  state.select(2);
  assert.equal(state.selectedIndex(), 2);
  assert.equal(state.instance(2), 15);
  assert.equal(state.instance(3), undefined);
  state.select(5);
  assert.equal(state.selectedIndex(), 0, "an index past the list is «first available»");
  assert.deepEqual(state.join(2, true, FACTS), { kind: "join", guid: MASTER, bgTypeId: 2, instanceId: 15, asGroup: true });
  assert.deepEqual(state.join(0, false, FACTS), { kind: "join", guid: MASTER, bgTypeId: 2, instanceId: 0, asGroup: false });
  assert.deepEqual(state.join(2, true, { ...FACTS, raidMembers: 11 }),
    { kind: "refused", error: "ERR_GROUP_JOIN_BATTLEGROUND_TOO_MANY" });
  assert.deepEqual(state.join(2, false, { ...FACTS, raidMembers: 11 }).kind, "join", "a solo join ignores the group size");
  assert.deepEqual(state.join(1, false, { ...FACTS, inBattleground: true }),
    { kind: "refused", error: "ERR_BATTLEGROUND_NOT_IN_BATTLEGROUND" });
  state.close();
  assert.deepEqual(state.join(2, false, FACTS), { kind: "join", guid: 0n, bgTypeId: 2, instanceId: 0, asGroup: false },
    "without a battlemaster the instance is 0");
  state.request(7);
  assert.equal(state.type, 7, "RequestBattlegroundInstanceInfo makes its type current at once");
});

test("the canned seam answers the list C API and CloseBattlefield raises BATTLEFIELDS_CLOSED", () => {
  const seam = new CannedWorldSeam();
  const fired = [];
  seam.attach({ now: () => 1, fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  fired.length = 0;
  seam.setBattlefieldList(list());
  assert.deepEqual(fired.map(([event]) => event), ["BATTLEFIELDS_SHOW"]);
  assert.deepEqual(api(seam, "GetNumBattlefields"), [2]);
  assert.deepEqual(api(seam, "GetBattlefieldInstanceInfo", 1), [12]);
  assert.deepEqual(api(seam, "GetBattlefieldInstanceInfo", 3), []);
  assert.deepEqual(api(seam, "GetBattlefieldInfo"), ["Warsong Gulch", "Capture the enemy flag.", 5, true, false, false]);
  assert.deepEqual(api(seam, "CanJoinBattlefieldAsGroup"), [true], "BattlemasterList.GroupsAllowed");
  api(seam, "SetSelectedBattlefield", 2);
  assert.deepEqual(api(seam, "GetSelectedBattlefield"), [2]);
  api(seam, "JoinBattlefield", 2, 1);
  assert.deepEqual(seam.battlegroundJoins.at(-1), { bgTypeId: 2, instanceId: 15, asGroup: true, guid: MASTER });
  fired.length = 0;
  api(seam, "CloseBattlefield");
  assert.deepEqual(fired.map(([event]) => event), ["BATTLEFIELDS_CLOSED"]);
  api(seam, "JoinBattlefield", 2);
  assert.deepEqual(seam.battlegroundJoins.at(-1), { bgTypeId: 2, instanceId: 0, asGroup: false },
    "after the close the battlemaster is gone");
  seam.detach();
});

test("stock BattlefieldFrame opens on a battlemaster's list, selects a row and joins it", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { mountFrameXmlBattlemaster } = await import("../dist/code/browser/framexml/FrameXmlBattlemasterOwner.js");
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false,
    screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    await boot.load();
    const elements = new Map();
    for (const current of boot.bridge.frames) {
      elements.set(current, {
        parentElement: current.parent ? elements.get(current.parent) : undefined,
        getAttribute(attribute) {
          if (attribute === "data-framexml-name") return current.name;
          if (attribute === "data-framexml-type") return current.type;
          return null;
        },
      });
    }
    const renderer = { elementFor(frame) { return elements.get(frame); } };
    const lua = (code) => {
      const fn = boot.vm.compileFunction(code, "battlemaster-test", []);
      try { return boot.vm.call(fn, [], 1)[0]; } finally { boot.vm.release(fn); }
    };
    // What the world mount's PvP gate leaves (FrameXmlWorldMount.ts frameXmlPvpGate, kept DOM-free here):
    // every OnLoad event off BattlefieldFrame but the queue status.
    const frame = boot.bridge.getFrame("BattlefieldFrame");
    boot.bridge.UnregisterAllEvents(frame);
    boot.bridge.RegisterEvent(frame, "UPDATE_BATTLEFIELD_STATUS");
    assert.equal(frame.registeredEvents.has("BATTLEFIELDS_SHOW"), false, "before the gate the list's events are off");
    const sentBefore = seam.battlegroundJoins.length;
    // An arena battlemaster's list open while the HUD mounts: the probe neither refuses on it nor retires it.
    seam.setBattlefieldList(list({ bgTypeId: 6, instances: [] }));
    assert.equal(seam.isBattlefieldArena(), true);
    const owner = mountFrameXmlBattlemaster(seam, boot, renderer);
    assert.ok(owner, "BattlefieldFrame passes its gate");
    assert.equal(seam.isBattlefieldArena(), true, "the probe's close did not reach the world");
    assert.equal(seam.battlegroundJoins.length, sentBefore, "the gate joins nothing");
    assert.equal(seam.battlefieldListState.type, 6, "the gate's probe list is gone, the real one is back");
    lua("HideUIPanel(ArenaFrame)");
    assert.equal(boot.bridge.isVisible(frame), false);
    for (const event of ["BATTLEFIELDS_SHOW", "BATTLEFIELDS_CLOSED", "PARTY_LEADER_CHANGED", "UPDATE_BATTLEFIELD_STATUS"]) {
      assert.equal(frame.registeredEvents.has(event), true, `${event} is back on BattlefieldFrame`);
    }
    const errors = boot.errors.length + boot.vm.errors.length;
    seam.setBattlefieldList(list());
    assert.equal(owner.isOpen(), true, "BATTLEFIELDS_SHOW opens the stock list");
    assert.equal(lua("return BattlefieldZone1:GetText() .. '|' .. BattlefieldZone2:GetText() .. '|' .. BattlefieldZone3:GetText()"),
      `${lua("return FIRST_AVAILABLE")}|Warsong Gulch 12|Warsong Gulch 15`);
    assert.equal(lua("return BattlefieldZone4:IsShown() and 1 or 0"), 0);
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("BattlefieldZone3")), true);
    assert.equal(lua("return GetSelectedBattlefield()"), 2);
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("BattlefieldFrameJoinButton")), true);
    assert.deepEqual(seam.battlegroundJoins.at(-1), { bgTypeId: 2, instanceId: 15, asGroup: false, guid: MASTER });
    assert.equal(owner.isOpen(), false, "Join hides the frame");
    assert.equal(seam.battlefieldListState.guid, 0n, "and its OnHide's CloseBattlefield forgets the battlemaster");
    // An arena battlemaster's list stays ArenaFrame's (BattlefieldFrame.lua:41).
    seam.setBattlefieldList(list({ bgTypeId: 6, instances: [] }));
    assert.equal(owner.isOpen(), false);
    seam.setBattlefieldList(list());
    assert.equal(owner.isOpen(), true);
    owner.close();
    assert.equal(owner.isOpen(), false);
    assert.equal(boot.errors.length + boot.vm.errors.length, errors, JSON.stringify(boot.errors.slice(-2)));
  } finally {
    boot.close();
    chain.close();
  }
});
