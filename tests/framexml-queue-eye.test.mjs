// 3.24 (12.10): the stock queue eye — MiniMapBattlefieldFrame and its dropdown over the battleground queues
// and the Wintergrasp queue (FrameXmlWorldPvpQueue.ts, Wow.exe 0x0054c8a0, the 0x0054e720 handlers).
import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}

const { FrameXmlWorldPvpModel } = await import("../dist/code/browser/framexml/FrameXmlWorldPvpQueue.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} seam binding exists`);
  return [...binding(seam, args)];
}

const AREAS = new Map([
  [4197, { name: "Озеро Ледяных Оков", parentId: 0, flags: 0x08000000 }],
  [4538, { name: "Крепость Ледяных Оков", parentId: 4197, flags: 0x08000000 }],
  [12, { name: "Элвиннский лес", parentId: 0, flags: 0 }],
]);

function model(world, areaId = 12) {
  return new FrameXmlWorldPvpModel({ world: () => world, area: (id) => AREAS.get(id), currentAreaId: () => areaId });
}

test("GetWorldPVPQueueStatus answers the world's queue as 0x0054c8a0 does", () => {
  const world = { battlefieldQueuedId: 0, battlefieldQueuedZoneId: 0, battlefieldWarInvite: undefined, currentServerTime: () => 1_000 };
  const pvp = model(world);
  assert.deepEqual(pvp.queueStatus(1), ["none", undefined, 0, 0]);
  assert.deepEqual(pvp.queueStatus(2), [], "only index 1 answers");
  world.battlefieldQueuedId = 1;
  world.battlefieldQueuedZoneId = 4197;
  assert.deepEqual(pvp.queueStatus(1), ["queued", "Озеро Ледяных Оков", 1, 0]);
  world.battlefieldWarInvite = { battleId: 1, zoneId: 4197, expiresAt: 1_020 };
  assert.deepEqual(pvp.queueStatus(1), ["confirm", "Озеро Ледяных Оков", 1, 20], "the invitation's seconds left");
  world.battlefieldQueuedZoneId = 0;
  world.battlefieldWarInvite = undefined;
  assert.deepEqual(pvp.queueStatus(1), ["queued", "", 1, 0], "an unknown zone is \"\", never nil for stock's format");
});

test("CanHearthAndResurrectFromArea reads AreaTable flag 0x08000000 of the current area", () => {
  assert.equal(model({}, 4538).canHearthAndResurrect(), true);
  assert.equal(model({}, 12).canHearthAndResurrect(), false);
  assert.equal(model({}, 0).canHearthAndResurrect(), false);
});

test("each BATTLEFIELD_MGR_* packet raises Wow.exe's event and arguments", () => {
  const pvp = model({}, 4538);
  assert.deepEqual(pvp.edgeEvent(1, { kind: "queueInvite", warmup: true }), ["BATTLEFIELD_MGR_QUEUE_INVITE", 1, true]);
  assert.deepEqual(pvp.edgeEvent(1, { kind: "queueResponse", queued: true, loggingIn: false, warmup: false, zoneId: 4197 }),
    ["BATTLEFIELD_MGR_QUEUE_REQUEST_RESPONSE", 1, true, false, true, false], "a sub-area of the zone is in the area");
  assert.equal(model({}, 12).edgeEvent(1, { kind: "queueResponse", queued: true, loggingIn: false, warmup: false, zoneId: 4197 })[4],
    false, "elsewhere is not");
  assert.deepEqual(pvp.edgeEvent(1, { kind: "entryInvite", zoneId: 4197 }), ["BATTLEFIELD_MGR_ENTRY_INVITE", 1]);
  assert.deepEqual(pvp.edgeEvent(1, { kind: "entered", flag1: true, flag2: false }), ["BATTLEFIELD_MGR_ENTERED", 1, true, false]);
  assert.deepEqual(pvp.edgeEvent(1, { kind: "ejected", reason: 8, battleStatus: 2, relocated: true }),
    ["BATTLEFIELD_MGR_EJECTED", 1, true, true, true, false]);
  assert.deepEqual(pvp.edgeEvent(1, { kind: "ejected", reason: 10, battleStatus: 1, relocated: false }),
    ["BATTLEFIELD_MGR_EJECTED", 1, false, false, false, true]);
});

test("the live seam raises the event for a packet edge only, and the answers reach the world", () => {
  const listeners = new Map();
  const events = {
    on(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return () => {}; },
    emit(name, payload) { for (const listener of listeners.get(name) ?? []) listener(payload); },
  };
  const calls = [];
  const world = {
    state: { selfGuid: 0x10n, objects: new Map() }, battlefieldQueues: new Map(), casts: new Map(),
    cooldownSnapshots: new Map(), actionButtons: [], events,
    battlefieldQueuedId: 0, battlefieldWarInvite: undefined,
    answerBattlefieldQueueInvite(battleId, accept) { calls.push(["queue", battleId, accept]); },
    answerBattlefieldWarInvite(battleId, accept) { calls.push(["entry", battleId, accept]); },
    leaveBattlefieldQueue(battleId) { calls.push(["exit", battleId]); },
    leaveBattlefield() { calls.push(["hearth"]); },
  };
  const seam = new LiveWorldSeam({ world: () => world, store: () => undefined, areaRecord: (id) => AREAS.get(id), currentAreaId: () => 4538 });
  const fired = [];
  seam.attach({ now: () => 1, fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  fired.length = 0;
  events.emit("BATTLEFIELD_CHANGED", { battleId: 1 });
  assert.deepEqual(fired, [], "a world-side answer raises nothing");
  events.emit("BATTLEFIELD_CHANGED", { battleId: 1, edge: { kind: "queueInvite", warmup: false } });
  assert.deepEqual(fired, [["BATTLEFIELD_MGR_QUEUE_INVITE", 1, false]]);
  assert.deepEqual(api(seam, "CanHearthAndResurrectFromArea"), [1]);
  api(seam, "BattlefieldMgrQueueInviteResponse", 1, 1);
  api(seam, "BattlefieldMgrQueueInviteResponse", 1, 0);
  api(seam, "BattlefieldMgrEntryInviteResponse", 1, 1);
  api(seam, "BattlefieldMgrExitRequest", 1);
  api(seam, "HearthAndResurrectFromArea");
  assert.deepEqual(calls, [["queue", 1, true], ["queue", 1, false], ["entry", 1, true], ["exit", 1], ["hearth"]],
    "stock's 1 and 0 are yes and no (StaticPopup.lua:547-585)");
  seam.detach();
});

test("the stock eye shows the queues and its dropdown leaves them", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { mountFrameXmlQueueEye } = await import("../dist/code/browser/framexml/FrameXmlQueueEyeOwner.js");
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
      const fn = boot.vm.compileFunction(code, "queue-eye-test", []);
      try { return boot.vm.call(fn, [], 1)[0]; } finally { boot.vm.release(fn); }
    };
    // What the world mount's PvP gate leaves: BattlefieldFrame hearing the queue status only.
    const battlefield = boot.bridge.getFrame("BattlefieldFrame");
    boot.bridge.UnregisterAllEvents(battlefield);
    boot.bridge.RegisterEvent(battlefield, "UPDATE_BATTLEFIELD_STATUS");
    const queues = seam.worldPvpWorld;
    // The published popups answer AcceptBattlefieldPort over their world's queue slots (FrameXmlPopups.ts).
    seam.popups.popupsOwned = true;
    seam.popupsWorld.battlefieldQueues.set(0, { status: 1, isArena: false, rated: false, cleared: false });
    queues.queues[1] = ["queued", "Альтеракская долина", 0, 71, 80, 0, false];
    assert.equal(mountFrameXmlQueueEye(seam, boot, renderer), true, "the eye passes its gate");
    assert.equal(Object.prototype.hasOwnProperty.call(seam, "battlefieldStatus"), false, "the probe's status is gone");
    assert.deepEqual(seam.popupsWorld.calls, [], "the gate answers nothing");
    for (const event of ["PLAYER_ENTERING_WORLD", "ZONE_CHANGED_NEW_AREA", "BATTLEFIELD_MGR_QUEUE_INVITE", "BATTLEFIELD_MGR_EJECTED"]) {
      assert.equal(battlefield.registeredEvents.has(event), true, `${event} is back on BattlefieldFrame`);
    }
    assert.match(lua("return MiniMapBattlefieldFrame.tooltip or ''"), /Альтеракская долина/, "the real queue's tooltip is back");
    const errors = boot.errors.length + boot.vm.errors.length;
    // A battleground queue: the eye shows, its dropdown leaves the queue (AcceptBattlefieldPort(i)).
    queues.queues[1] = ["none", undefined, 0, 0, 0, 0, false];
    queues.queues[0] = ["queued", "Ущелье Песни Войны", 0, 10, 19, 0, false];
    boot.bridge.dispatchEvent("UPDATE_BATTLEFIELD_STATUS", 1);
    assert.equal(lua("return MiniMapBattlefieldFrame:IsShown() and 1 or 0"), 1);
    lua(`ToggleDropDownMenu(1, nil, MiniMapBattlefieldDropDown, "MiniMapBattlefieldFrame", 0, -5)`);
    assert.equal(lua("return DropDownList1Button1:GetText() .. '|' .. DropDownList1Button2:GetText()"),
      `Ущелье Песни Войны|${lua("return LEAVE_QUEUE")}`);
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("DropDownList1Button2")), true);
    assert.deepEqual(seam.popupsWorld.calls.at(-1), { kind: "battlefield", slot: 0, enter: false });
    // Wintergrasp: the queue shows under the zone's name and its row leaves through BattlefieldMgrExitRequest.
    queues.queues[0] = ["none", undefined, 0, 0, 0, 0, false];
    queues.queueForWintergrasp(1);
    boot.bridge.dispatchEvent("ZONE_CHANGED");
    assert.equal(lua("return MiniMapBattlefieldFrame:IsShown() and 1 or 0"), 1, "the world queue alone shows the eye");
    lua(`ToggleDropDownMenu(1, nil, MiniMapBattlefieldDropDown, "MiniMapBattlefieldFrame", 0, -5)`);
    assert.equal(lua("return DropDownList1Button1:GetText() .. '|' .. DropDownList1Button2:GetText()"),
      `Озеро Ледяных Оков|${lua("return LEAVE_QUEUE")}`);
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("DropDownList1Button2")), true);
    assert.deepEqual(queues.calls.at(-1), { kind: "exit", battleId: 1 });
    // The server's invitation to queue: stock's BFMGR_INVITED_TO_QUEUE, whose Accept answers yes for battle 1.
    boot.bridge.dispatchEvent("BATTLEFIELD_MGR_QUEUE_INVITE", 1, false);
    const popup = lua(`for i = 1, STATICPOPUP_NUMDIALOGS do local f = _G["StaticPopup" .. i]
      if f:IsShown() and f.which == "BFMGR_INVITED_TO_QUEUE" then return i end end return 0`);
    assert.ok(popup > 0, "BFMGR_INVITED_TO_QUEUE asks");
    assert.equal(boot.bridge.Click(boot.bridge.getFrame(`StaticPopup${popup}Button1`)), true);
    assert.deepEqual(queues.calls.at(-1), { kind: "queueInvite", battleId: 1, accept: true });
    assert.equal(boot.errors.length + boot.vm.errors.length, errors, JSON.stringify(boot.errors.slice(-2)));
  } finally {
    boot.close();
    chain.close();
  }
});
