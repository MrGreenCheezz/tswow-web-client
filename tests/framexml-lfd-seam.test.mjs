import assert from "node:assert/strict";
import test from "node:test";

// The stock dungeon finder's C API over the canned world: the choice list's number contract, the
// command mapping onto WorldClient's LFG methods, and the LFG_* event pump. MPQ-free; the stock Lua
// that consumes all of this runs in framexml-lfd-vertical.test.mjs.
const {
  FRAMEXML_LFD_BINDINGS, FRAMEXML_LFD_PRELUDE, FrameXmlLfdModel, frameXmlLfdChoiceOrder, frameXmlLfgAvailableRoles,
} = await import("../dist/code/browser/framexml/FrameXmlLfd.js");
const {
  FRAMEXML_CANNED_LFD_CATALOG, FRAMEXML_CANNED_LFD_PLAYER_GUID, createCannedFrameXmlLfd,
} = await import("../dist/code/browser/framexml/FrameXmlLfdCanned.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_PRELUDE } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

const DUNGEON = 1 << 24;
const RANDOM = 6 << 24;

function fixture({ level = 60, classId = 11, faction = "Alliance", leader = false, party = 0 } = {}) {
  const { model, world } = createCannedFrameXmlLfd({
    playerLevel: () => level,
    playerClassId: () => classId,
    playerName: () => "Игрок",
    playerGuid: () => FRAMEXML_CANNED_LFD_PLAYER_GUID,
    playerFaction: () => faction,
    partyMemberCount: () => party,
    raidMemberCount: () => 0,
    isPartyLeader: () => leader,
  });
  const fired = [];
  let now = 1000;
  const pump = { fire(event, ...args) { fired.push([event, ...args]); return 1; }, now: () => now };
  model.attach(pump);
  const call = (name, ...args) => FRAMEXML_LFD_BINDINGS[name]({ lfd: model }, args);
  return { model, world, fired, pump, call, advance(seconds) { now += seconds; } };
}

const names = (fired) => fired.map(([event]) => event);

test("choice order: negative headers by LFGDungeonGroup order, children by level, each child's groupID is its header", () => {
  const { call } = fixture();
  const order = frameXmlLfdChoiceOrder(FRAMEXML_CANNED_LFD_CATALOG, "Alliance");
  // Group 2 (Burning Crusade, Order_index 4) before group 1 (classic, 5); rows by Target_level.
  assert.deepEqual(order, [-2, 136, 137, -1, 12, 276, 34, 32, 2, 40, 274]);
  let header;
  for (const id of order) {
    const info = call("GetLFGDungeonInfo", id);
    if (id < 0) {
      header = id;
      assert.equal(info[8], 0, "a header has no group of its own");
      continue;
    }
    assert.equal(info[8], header, `dungeon ${id} files under the header just before it`);
    assert.ok(info[1] === 1 || info[1] === 5, "only normal and heroic rows are choices");
  }
  // Randoms are the server's list, not choices; the other faction's own dungeon is not shown.
  assert.ok(!order.includes(258) && !order.includes(259));
  assert.ok(!order.includes(4), "Ragefire Chasm is Horde-only");
  assert.ok(frameXmlLfdChoiceOrder(FRAMEXML_CANNED_LFD_CATALOG, "Horde").includes(4));
  assert.ok(!frameXmlLfdChoiceOrder(FRAMEXML_CANNED_LFD_CATALOG, "Horde").includes(12), "the Stockade is Alliance-only");
});

test("GetLFGDungeonInfo answers the fourteen LFG_RETURN_VALUES fields for rows and headers", () => {
  const { call } = fixture();
  assert.deepEqual(call("GetLFGDungeonInfo", 40), [
    "Стратхольм - Главные врата", 1, 55, 65, 60, 0, 0, 0, -1, "STRATHOLME", 0, 5, "", false,
  ]);
  assert.deepEqual(call("GetLFGDungeonInfo", -1), [
    "Классические подземелья", 1, 0, 0, 0, 0, 0, 0, 0, "", 0, 0, "", false,
  ]);
  assert.deepEqual(call("GetLFGDungeonInfo", 258).slice(0, 2), ["Случайное подземелье классической игры", 6],
    "a random row is answered too: the type dropdown asks GetLFGDungeonInfo for it");
  assert.deepEqual(call("GetLFGDungeonInfo", 999), []);
  assert.deepEqual(call("GetLFGDungeonInfo", "x"), []);
});

test("without a version-2 catalog every list is empty and nothing is ready", () => {
  const model = new FrameXmlLfdModel({
    world: () => undefined, catalog: () => undefined, playerLevel: () => 80, playerClassId: () => 1,
    playerName: () => "x", playerGuid: () => 1n, playerFaction: () => "Horde", partyMemberCount: () => 0,
    raidMemberCount: () => 0, isPartyLeader: () => false, inDungeonInstance: () => false,
  });
  assert.equal(model.ready(), false);
  assert.deepEqual(model.choiceIds(), []);
  assert.deepEqual(FRAMEXML_LFD_BINDINGS.GetLFGDungeonInfo({ lfd: model }, [2]), []);
  assert.deepEqual(FRAMEXML_LFD_BINDINGS.GetNumRandomDungeons({ lfd: model }, []), [0]);
  assert.deepEqual(FRAMEXML_LFD_BINDINGS.GetLFGDungeonInfo({}, [2]), [], "a seam without the model answers nothing");
});

test("randoms, locks and rewards come from SMSG_LFG_PLAYER_INFO and the party lock list", () => {
  const { call, world } = fixture();
  assert.deepEqual(call("GetNumRandomDungeons"), [2]);
  assert.deepEqual(call("GetLFGRandomDungeonInfo", 1), [258, "Случайное подземелье классической игры"]);
  assert.deepEqual(call("GetLFGRandomDungeonInfo", 2), [259, "Случайное подземелье Burning Crusade"]);
  assert.deepEqual(call("GetRandomDungeonBestChoice"), [259], "the classic random ends at 58; at 60 it is Burning Crusade's");
  assert.deepEqual(call("GetLFGDungeonRewards", 259), [false, 1234, 0, 5000, 0, 0]);
  assert.deepEqual(call("GetLFGDungeonRewards", 258), [true, 0, 0, 0, 0, 0]);
  assert.deepEqual(call("GetLFGDungeonRewards", 40), [false, 0, 0, 0, 0, 0], "a specific dungeon has no reward row");
  assert.deepEqual(call("IsLFGDungeonJoinable", 274), [false], "the canned quest lock");
  assert.deepEqual(call("IsLFGDungeonJoinable", 40), [true]);
  assert.deepEqual(call("GetLFDLockPlayerCount"), [1]);
  assert.deepEqual(call("GetLFDLockInfo", 274, 1), ["Игрок", 1022]);
  world.lfgPartyInfo = [{ guid: 0x77n, dungeons: [{ dungeonId: 40 | DUNGEON, reason: 2 }] }];
  world.names.set(0x77n, "Бета");
  assert.deepEqual(call("GetLFDLockPlayerCount"), [2]);
  assert.deepEqual(call("GetLFDLockInfo", 40, 2), ["Бета", 2]);
  assert.deepEqual(call("IsLFGDungeonJoinable", 40), [false], "a party member's lock blocks the group");
  assert.deepEqual(call("WebClientLfdLockedIds").sort((a, b) => a - b), [40, 274]);
});

test("JoinLFG sends the SetLFGDungeon selection as typed wire entries with the checked roles", () => {
  const { call, world } = fixture();
  call("SetLFGRoles", 1, 1, undefined, 1);
  assert.deepEqual(call("GetLFGRoles"), [true, true, false, true]);
  call("ClearAllLFGDungeons");
  call("SetLFGDungeon", 40);
  call("SetLFGDungeon", 2);
  call("JoinLFG");
  // Solo: the leader flag rides along (0x01) with tank (0x02) and damage (0x08).
  assert.deepEqual(world.calls.at(-1), { kind: "join", roles: 0x0b, dungeons: [2 | DUNGEON, 40 | DUNGEON], comment: "" });
  call("ClearAllLFGDungeons");
  call("SetLFGDungeon", 258);
  call("JoinLFG");
  assert.deepEqual(world.calls.at(-1).dungeons, [258 | RANDOM], "a random keeps type 6 in its top byte");
  call("LeaveLFG");
  call("AcceptProposal");
  call("RejectProposal");
  assert.deepEqual(world.calls.slice(-3), [{ kind: "leave" }, { kind: "proposal", accept: true }, { kind: "proposal", accept: false }]);
});

test("a non-leader in a party sends no leader flag; classes offer their stock roles", () => {
  const { call, world } = fixture({ party: 2, leader: false, classId: 8 });
  assert.deepEqual(call("GetAvailableRoles"), [false, false, true], "a mage is damage only");
  call("SetLFGRoles", 1, 1, 1, 1);
  assert.deepEqual(call("GetLFGRoles"), [true, false, false, true], "roles the class cannot take are not kept");
  assert.equal(call("CompleteLFGRoleCheck", true)[0], true);
  assert.deepEqual(world.calls.at(-1), { kind: "roles", roles: 0x08 });
  assert.deepEqual(frameXmlLfgAvailableRoles(13), [true, true, true],
    "a TSWoW class is offered every role; the server's player_class_roles strips the rest");
});

test("CompleteLFGRoleCheck refuses no role, sends the chosen roles, and declines with none", () => {
  const { call, world } = fixture();
  assert.deepEqual(call("CompleteLFGRoleCheck", true), [false], "the stock popup stays open without a combat role");
  assert.equal(world.calls.length, 0);
  call("SetLFGRoles", undefined, undefined, 1, undefined);
  assert.deepEqual(call("CompleteLFGRoleCheck", true), [true]);
  assert.deepEqual(world.calls.at(-1), { kind: "roles", roles: 0x04 });
  assert.deepEqual(call("CompleteLFGRoleCheck", false), [true]);
  assert.deepEqual(world.calls.at(-1), { kind: "roles", roles: 0 },
    "TrinityCore's UpdateRoleCheck turns no role into LFG_ROLECHECK_NO_ROLE");
});

test("a muted model (the mount's gate probe) sends no packet", () => {
  const { call, model, world } = fixture();
  call("SetLFGDungeon", 40);
  model.muted(() => {
    call("RequestLFDPlayerLockInfo");
    call("JoinLFG");
    call("LeaveLFG");
  });
  assert.deepEqual(world.calls, []);
  call("RequestLFDPlayerLockInfo");
  call("RequestLFDPartyLockInfo");
  assert.deepEqual(world.calls, [{ kind: "requestLocks" }], "the party request rides on the one lock request");
});

test("queue state answers GetLFGInfoServer, GetLFGQueuedList and GetLFGQueueStats on the GetTime clock", () => {
  const { call, world, fired, advance } = fixture();
  assert.deepEqual(call("GetLFGInfoServer"), [false, false, false, false, false, "", 0]);
  assert.deepEqual(call("GetLFGQueueStats"), [false]);
  world.queue([40 | DUNGEON], 95);
  assert.deepEqual(names(fired), ["LFG_UPDATE", "LFG_QUEUE_STATUS_UPDATE"]);
  assert.deepEqual(call("GetLFGInfoServer"), [false, true, true, false, false, "", 1]);
  assert.deepEqual(call("WebClientLfdQueuedIds"), [40]);
  advance(10);
  // Stamped at delivery (1000) minus the 95 seconds the server says were already waited.
  assert.deepEqual(call("GetLFGQueueStats"), [true, 0, 1, 0, 2, 1, "Стратхольм - Главные врата", 300, 60, 120, 600, 240, 905]);
  world.unqueue();
  assert.deepEqual(call("WebClientLfdQueuedIds"), []);
  assert.equal(names(fired).at(-1), "LFG_UPDATE");
});

test("proposal events: SHOW once per proposal and only while stock owns the popup; FAILED and SUCCEEDED follow the state", () => {
  const { call, model, world, fired } = fixture();
  world.propose(40 | DUNGEON, 7);
  assert.deepEqual(names(fired), ["LFG_PROPOSAL_UPDATE", "LFG_UPDATE"], "the native prompt owns an unpublished proposal");
  assert.deepEqual(call("GetLFGProposal"), [true, 1, 40, "Стратхольм - Главные врата", "STRATHOLME", "TANK", false, 0, 0, 5, false, false]);
  assert.deepEqual(call("GetLFGProposalMember", 5), [true, "DAMAGER", 0, false, false, "", undefined]);
  fired.length = 0;
  model.popupsOwned = true;
  assert.deepEqual(names(fired), ["LFG_PROPOSAL_SHOW", "LFG_PROPOSAL_UPDATE"],
    "publication hands the still-open proposal 7 to the stock popup (the native prompt steps aside)");
  fired.length = 0;
  world.propose(40 | DUNGEON, 7);
  assert.deepEqual(names(fired), ["LFG_PROPOSAL_UPDATE", "LFG_UPDATE"], "a same-id re-send is an update, not a second SHOW");
  fired.length = 0;
  world.propose(40 | DUNGEON, 8);
  world.propose(40 | DUNGEON, 8, 0, true);
  assert.deepEqual(names(fired), ["LFG_PROPOSAL_SHOW", "LFG_PROPOSAL_UPDATE", "LFG_UPDATE", "LFG_PROPOSAL_UPDATE", "LFG_UPDATE"]);
  assert.equal(call("GetLFGProposal")[6], true, "the answered update shows the ready states");
  fired.length = 0;
  world.propose(40 | DUNGEON, 8, 1);
  assert.deepEqual(names(fired), ["LFG_PROPOSAL_FAILED", "LFG_UPDATE"]);
  assert.deepEqual(call("GetLFGProposal"), [false], "a failed proposal is over");
  fired.length = 0;
  world.propose(40 | DUNGEON, 9, 2);
  assert.deepEqual(names(fired), ["LFG_PROPOSAL_SUCCEEDED", "LFG_UPDATE"]);
});

test("publication hands every prompt still open to the stock popups, once per ownership edge", () => {
  const { model, world } = createCannedFrameXmlLfd({
    playerLevel: () => 60, playerClassId: () => 11, playerName: () => "Игрок",
    playerGuid: () => FRAMEXML_CANNED_LFD_PLAYER_GUID, playerFaction: () => "Alliance",
  });
  // Packets that landed before the seam attached: a ReloadUI remount or a relogin into a queue.
  world.propose(40 | DUNGEON, 11);
  world.startRoleCheck(FRAMEXML_CANNED_LFD_PLAYER_GUID, [258 | RANDOM]);
  world.lfgBoot = {
    inProgress: true, voted: false, votedYes: false, victimGuid: 0x77n, votes: 1, agree: 1,
    secondsLeft: 0, votesNeeded: 3, reason: "AFK",
  };
  world.lfgOfferContinue = 40;
  const fired = [];
  model.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; }, now: () => 1000 });
  assert.deepEqual(fired, [], "attaching shows nothing: the native prompts still own these");
  // And one that lands between attach and publication (the corpus-load window).
  world.propose(40 | DUNGEON, 12);
  assert.deepEqual(names(fired), ["LFG_PROPOSAL_UPDATE", "LFG_UPDATE"]);
  fired.length = 0;
  model.popupsOwned = true;
  assert.deepEqual(fired, [
    ["LFG_PROPOSAL_SHOW"], ["LFG_PROPOSAL_UPDATE"], ["LFG_ROLE_CHECK_SHOW"], ["LFG_ROLE_CHECK_UPDATE"],
    ["LFG_BOOT_PROPOSAL_UPDATE"], ["LFG_OFFER_CONTINUE", "Стратхольм - Главные врата", 40, 1],
  ], "the native prompts stepped aside at this moment, so each open one appears in stock");
  fired.length = 0;
  model.popupsOwned = true;
  assert.deepEqual(fired, [], "ownership is an edge: a repeated publication replays nothing");
  world.propose(40 | DUNGEON, 12);
  world.startRoleCheck(FRAMEXML_CANNED_LFD_PLAYER_GUID, [258 | RANDOM]);
  assert.deepEqual(names(fired), ["LFG_PROPOSAL_UPDATE", "LFG_UPDATE", "LFG_ROLE_CHECK_UPDATE", "LFG_UPDATE"],
    "the server's same-id re-sends update the popups already shown");
  // Unpublished (the VM goes) and published again: the new owner is handed the same prompts. A
  // member who already chose (the leader, whose roles rode on the join) is not asked again.
  model.popupsOwned = false;
  world.lfgRoleCheck = { ...world.lfgRoleCheck, members: world.lfgRoleCheck.members.map((member) => ({ ...member, ready: true })) };
  world.lfgBoot = undefined;
  world.lfgOfferContinue = undefined;
  fired.length = 0;
  model.popupsOwned = true;
  assert.deepEqual(names(fired), ["LFG_PROPOSAL_SHOW", "LFG_PROPOSAL_UPDATE"]);
});

test("role check: SHOW for a member who has not chosen, UPDATE per answer, HIDE when it ends", () => {
  const { call, model, world, fired } = fixture();
  model.popupsOwned = true;
  world.names.set(0x99n, "Альфа");
  world.startRoleCheck(FRAMEXML_CANNED_LFD_PLAYER_GUID, [258 | RANDOM]);
  assert.deepEqual(names(fired), ["LFG_ROLE_CHECK_SHOW", "LFG_ROLE_CHECK_UPDATE", "LFG_UPDATE"]);
  assert.deepEqual(call("GetLFGRoleUpdate"), [true, 1, 2]);
  assert.deepEqual(call("GetLFGRoleUpdateSlot", 1), [6, 258]);
  fired.length = 0;
  world.emit({ kind: "roleChosen", guid: 0x99n, roles: 0x0c });
  assert.deepEqual(fired, [["LFG_ROLE_CHECK_ROLE_CHOSEN", "Альфа", false, true, true], ["LFG_ROLE_CHECK_UPDATE"]]);
  fired.length = 0;
  world.endRoleCheck(1);
  assert.deepEqual(names(fired), ["LFG_ROLE_CHECK_HIDE", "LFG_ROLE_CHECK_UPDATE", "LFG_UPDATE"]);
  assert.deepEqual(call("GetLFGRoleUpdate"), [false, 1, 2]);
});

test("lock, random, boot, continue and refusal packets map onto their stock events", () => {
  const { model, world, fired } = fixture();
  world.emit({ kind: "playerInfo" });
  world.emit({ kind: "partyInfo" });
  world.emit({ kind: "joinResult", result: 5, message: "Вы не подходите под выбранные подземелья" });
  world.emit({ kind: "teleportDenied", message: "Нельзя телепортироваться мёртвым" });
  world.emit({ kind: "boot" });
  world.lfgOfferContinue = 40;
  world.emit({ kind: "offerContinue", entry: 40 | DUNGEON });
  world.emit({ kind: "reward" });
  assert.deepEqual(fired, [
    ["LFG_UPDATE_RANDOM_INFO"], ["LFG_LOCK_INFO_RECEIVED"], ["LFG_LOCK_INFO_RECEIVED"],
    ["UI_ERROR_MESSAGE", "Вы не подходите под выбранные подземелья"], ["LFG_UPDATE"],
    ["UI_ERROR_MESSAGE", "Нельзя телепортироваться мёртвым"],
  ], "boot and continue popups stay native until stock owns them; the reward has no stock owner");
  fired.length = 0;
  model.popupsOwned = true;
  assert.deepEqual(fired, [["LFG_OFFER_CONTINUE", "Стратхольм - Главные врата", 40, 1]],
    "the unanswered continue offer is handed over at publication; no boot vote is running");
  fired.length = 0;
  world.emit({ kind: "boot" });
  world.emit({ kind: "offerContinue", entry: 40 | DUNGEON });
  assert.deepEqual(fired, [["LFG_BOOT_PROPOSAL_UPDATE"], ["LFG_OFFER_CONTINUE", "Стратхольм - Главные врата", 40, 1]]);
  model.detach();
  fired.length = 0;
  world.emit({ kind: "update" });
  assert.deepEqual(fired, [], "a detached model hears nothing");
  assert.equal(model.popupsOwned, false, "detaching hands the prompts back");
});

test("the seam binds every finder name, and the Lua shim fills tables the host cannot push", () => {
  for (const name of Object.keys(FRAMEXML_LFD_BINDINGS)) {
    assert.equal(FRAMEXML_SEAM_BINDINGS[name] !== undefined, true, `${name} is a seam binding`);
  }
  assert.ok(FRAMEXML_SEAM_PRELUDE.includes(FRAMEXML_LFD_PRELUDE), "the shim rides the seam prelude");
  for (const name of ["GetLFDChoiceOrder", "GetLFDChoiceInfo", "GetLFDChoiceEnabledState",
    "GetLFDChoiceCollapseState", "GetLFDChoiceLockedState", "GetLFGQueuedList", "GetLFRChoiceOrder"]) {
    assert.match(FRAMEXML_LFD_PRELUDE, new RegExp(`impl\\.${name} = function`), `${name} is a Lua table filler`);
    assert.equal(FRAMEXML_LFD_BINDINGS[name], undefined, `${name} is not a flat JS binding`);
  }
});
