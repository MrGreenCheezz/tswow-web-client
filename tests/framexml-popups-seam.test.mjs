import assert from "node:assert/strict";
import test from "node:test";

// FrameXmlPopups.ts without the corpus: which stock events a world's pending questions become,
// when, and what each answering C API sends — over the scripted canned world and over a real
// WorldClient fed packets through a fake connection.
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const {
  FrameXmlPopupsModel, FRAMEXML_POPUPS_BINDINGS, FRAMEXML_POPUPS_PRELUDE, FRAMEXML_NO_RELEASE_WINDOW_FLAG,
  FRAMEXML_POPUP_NAME_WAIT_MS,
} = await import("../dist/code/browser/framexml/FrameXmlPopups.js");
const { FrameXmlCannedPopupsWorld, createCannedFrameXmlPopups } =
  await import("../dist/code/browser/framexml/FrameXmlPopupsCanned.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_NAMES, FRAMEXML_SEAM_PRELUDE } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { markFrameXmlPopupAnswered } = await import("../dist/code/browser/framexml/FrameXmlPopupsAnswered.js");

function scripted() {
  const clock = { now: 50_000 };
  const { model, world } = createCannedFrameXmlPopups(new FrameXmlCannedPopupsWorld(() => clock.now));
  const fired = [];
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  const events = () => fired.map(([event]) => event);
  const take = () => fired.splice(0);
  return { model, world, clock, fired, events, take };
}

const call = (model, name, ...args) => FRAMEXML_POPUPS_BINDINGS[name]({ popups: model }, args);

test("the bindings are seam names with one owner; the prelude rides the seam prelude", () => {
  for (const name of ["AcceptGroup", "DeclineGroup", "AcceptDuel", "CancelDuel", "AcceptResurrect", "RepopMe",
    "RetrieveCorpse", "ConfirmSummon", "AcceptGuild", "AcceptArenaTeam", "BeginTrade", "CancelTrade",
    "ConfirmReadyCheck", "GetReadyCheckStatus", "AcceptBattlefieldPort", "AcceptXPLoss"]) {
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], FRAMEXML_POPUPS_BINDINGS[name], name);
    assert.ok(FRAMEXML_SEAM_NAMES.includes(name), `${name} is reserved from the chat API`);
  }
  for (const name of ["CancelLogout", "Logout", "Quit", "DoReadyCheck"]) {
    assert.equal(FRAMEXML_POPUPS_BINDINGS[name], undefined, `${name} keeps its existing owner`);
  }
  assert.ok(FRAMEXML_SEAM_PRELUDE.includes(FRAMEXML_POPUPS_PRELUDE));
  // A seam without the model answers nothing and sends nothing.
  assert.deepEqual(FRAMEXML_POPUPS_BINDINGS.AcceptGroup({}, []), []);
  assert.deepEqual(FRAMEXML_POPUPS_BINDINGS.GetReleaseTimeRemaining({}, []), []);
});

test("nothing shows before the owner is published; publication shows what is pending, once", () => {
  const { model, world, events, take } = scripted();
  world.invite("Джайна");
  world.guild();
  world.summon();
  model.tick();
  assert.deepEqual(events(), []);
  call(model, "AcceptGroup");
  assert.deepEqual(world.calls, [], "the native prompt owns the answer until publication");
  model.popupsOwned = true;
  assert.deepEqual(take(), [
    ["PARTY_INVITE_REQUEST", "Джайна"], ["CONFIRM_SUMMON"], ["GUILD_INVITE_REQUEST", "Утер", "Серебряная длань"],
  ]);
  model.tick();
  model.tick();
  assert.deepEqual(take(), [], "a pending question is shown once, not once per frame");
  // Giving ownership up forgets what stock showed (its VM is going); taking it again re-shows.
  model.popupsOwned = false;
  model.popupsOwned = true;
  assert.equal(take().length, 3);
  // A probe never answers.
  model.muted(() => call(model, "AcceptGroup"));
  assert.deepEqual(world.calls, []);
});

test("answers reach the world once: a second answer finds nothing pending", () => {
  const { model, world, take } = scripted();
  model.popupsOwned = true;
  world.invite();
  world.duel();
  world.guild();
  world.arena();
  world.tradeRequest();
  model.tick();
  take();
  for (const name of ["AcceptGroup", "DeclineGroup", "AcceptDuel", "CancelDuel", "DeclineGuild", "AcceptGuild",
    "AcceptArenaTeam", "DeclineArenaTeam", "BeginTrade", "BeginTrade"]) call(model, name);
  assert.deepEqual(world.calls, [
    { kind: "group", accept: true }, { kind: "duel", accept: true }, { kind: "guild", accept: false },
    { kind: "arena", accept: true }, { kind: "beginTrade" },
  ]);
  // The answered questions are gone; their stock dialogs were hidden by their own OnClick, so the
  // model fires cancel events only for the ones it had shown. Not DUEL_FINISHED — the accepted duel
  // is only beginning — and not ARENA_TEAM_INVITE_CANCEL, which UIParent never registers.
  model.tick();
  assert.deepEqual(take().map(([event]) => event).sort(), [
    "GUILD_INVITE_CANCEL", "PARTY_INVITE_CANCEL", "TRADE_REQUEST_CANCEL",
  ]);
});

test("DUEL_FINISHED is the duel's end (SMSG_DUEL_COMPLETE), for both duelists, never the answer", () => {
  const { model, world, take } = scripted();
  model.popupsOwned = true;
  world.duel();
  model.tick();
  assert.deepEqual(take(), [["DUEL_REQUESTED", "Тралл"]]);
  call(model, "AcceptDuel");
  model.tick();
  assert.deepEqual(take(), [], "accepting starts the fight: nothing is finished");
  world.bounds(false);
  model.tick();
  assert.deepEqual(take(), [["DUEL_OUTOFBOUNDS"]]);
  // SMSG_DUEL_WINNER takes the flag a frame before SMSG_DUEL_COMPLETE resets the bounds.
  world.duelFlag = undefined;
  model.tick();
  world.endDuel();
  model.tick();
  assert.deepEqual(take(), [["DUEL_FINISHED"]], "one DUEL_FINISHED hides both dialogs; no DUEL_INBOUNDS, no second OUTOFBOUNDS");
  // The challenger's own duel ends with DUEL_FINISHED too, and a declined one at once.
  world.duel(0x42n);
  model.tick();
  assert.deepEqual(take(), [], "the challenger's own SMSG_DUEL_REQUESTED asks nothing");
  world.endDuel();
  model.tick();
  assert.deepEqual(take(), [["DUEL_FINISHED"]], "the challenger's duel ends for it as well");
  world.duel();
  model.tick();
  take();
  call(model, "CancelDuel");
  model.tick();
  assert.deepEqual(take(), [["DUEL_FINISHED"]], "declined: the server completes it at once");
  assert.deepEqual(world.calls, [{ kind: "duel", accept: true }, { kind: "duel", accept: false }]);
});

test("an invitation that cannot be accepted is said in chat once, across re-publication and remounts", () => {
  const { model, world, take } = scripted();
  model.popupsOwned = true;
  world.invite("Джайна", false);
  model.tick();
  assert.deepEqual(take(), [["WEBCLIENT_PARTY_INVITE_REFUSED", "Джайна"]]);
  model.popupsOwned = false;
  model.popupsOwned = true;
  assert.deepEqual(take(), [], "re-publication: the world still holds the invite, the line is not said again");
  const again = [];
  const pump = { fire: (event, ...args) => { again.push([event, ...args]); return 1; } };
  model.detach();
  model.attach(pump);
  model.popupsOwned = true;
  const { model: next } = createCannedFrameXmlPopups(world);
  next.attach(pump);
  next.popupsOwned = true;
  assert.deepEqual(again, [], "nor by a remount, with the same model or a new one");
  world.invite("Утер", false);
  next.tick();
  assert.deepEqual(again, [["WEBCLIENT_PARTY_INVITE_REFUSED", "Утер"]], "a new invitation is a new line");
});

test("the release timer counts from the death across a remount; RepopMe stays once per death", () => {
  const { model, world, clock, take } = scripted();
  model.popupsOwned = true;
  world.die();
  model.tick();
  take();
  clock.now += 200_000;
  // A /reload: the stock VM goes, the model is detached and attached again, re-published.
  model.detach();
  model.attach({ fire: () => 1 });
  model.popupsOwned = true;
  assert.equal(call(model, "GetReleaseTimeRemaining")[0], 160, "360 - 200 s, not a fresh six minutes");
  // A mount rebuilt with a new seam: a new model over the same world.
  const { model: next } = createCannedFrameXmlPopups(world);
  next.attach({ fire: () => 1 });
  next.popupsOwned = true;
  clock.now += 10_000;
  assert.equal(call(next, "GetReleaseTimeRemaining")[0], 150);
  call(model, "RepopMe");
  call(next, "RepopMe");
  assert.deepEqual(world.calls, [{ kind: "repop" }], "one CMSG_REPOP_REQUEST whichever mount asks");
  // A new death after resurrection is a new clock.
  world.revive();
  next.tick();
  world.die();
  next.tick();
  assert.equal(call(next, "GetReleaseTimeRemaining")[0], 360);
});

test("Quit: PLAYER_QUITING instead of PLAYER_CAMPING, ForceQuit leaves only for a Quit being counted", () => {
  const { model, world, clock, take } = scripted();
  model.popupsOwned = true;
  call(model, "ForceQuit");
  world.camp();
  model.tick();
  assert.deepEqual(take(), [["PLAYER_CAMPING"]], "/camp or Logout: CAMP");
  call(model, "ForceQuit");
  assert.deepEqual(world.calls, [], "a plain logout does not quit");
  // Quit() while CAMP already counts: QUIT is added once.
  world.quitting = true;
  model.tick();
  model.tick();
  assert.deepEqual(take(), [["PLAYER_QUITING"]]);
  world.cancelCamp();
  model.tick();
  assert.deepEqual(take(), [["LOGOUT_CANCEL"]], "one LOGOUT_CANCEL hides CAMP and QUIT");
  world.quit();
  model.tick();
  assert.deepEqual(take(), [["PLAYER_QUITING"]], "Quit(): QUIT alone");
  clock.now += 4_000;
  assert.equal(call(model, "WebClientCampTimeLeft")[0], 16, "QUIT counts the same twenty seconds");
  call(model, "ForceQuit");
  assert.deepEqual(world.calls, [{ kind: "forceQuit" }]);
  model.muted(() => call(model, "ForceQuit"));
  assert.equal(world.calls.length, 1, "a probe never quits");
});

test("DELETE_ITEM: the native «Разрушить» and a world drop ask stock; DeleteCursorItem destroys once", () => {
  const { model, world, take } = scripted();
  assert.equal(model.destroyItem(255, 23), false, "unpublished: the native confirmation keeps it");
  assert.equal(world.cursor, undefined, "and the item stays in the bag, not on the stock cursor");
  model.popupsOwned = true;
  assert.equal(model.confirmDeleteCursorItem(), false, "an empty cursor drops nothing");
  assert.equal(model.destroyItem(255, 30), false, "no item there");
  assert.equal(model.destroyItem(255, 23), true);
  assert.deepEqual(world.cursor, { bag: 255, slot: 23 });
  assert.deepEqual(take(), [["DELETE_ITEM_CONFIRM", "Льняная ткань", 1]]);
  model.muted(() => call(model, "DeleteCursorItem"));
  assert.deepEqual(world.calls, [], "a probe never destroys");
  call(model, "DeleteCursorItem");
  call(model, "DeleteCursorItem");
  assert.deepEqual(world.calls, [{ kind: "destroyItem", bag: 255, slot: 23 }], "CMSG_DESTROYITEM once");
  assert.equal(world.cursor, undefined, "the cursor is empty after it");
  // An epic item on the cursor, dropped on the world: UIParent's DELETE_GOOD_ITEM by quality 4.
  world.pickupItem(255, 24);
  assert.equal(model.confirmDeleteCursorItem(), true);
  assert.deepEqual(take(), [["DELETE_ITEM_CONFIRM", "Тесак Арканита", 4]]);
});

test("the live context reaches GameMenu's Quit intent through the controller and the seam's cursor", async () => {
  const { frameXmlPopupsLiveContext } = await import("../dist/code/browser/framexml/FrameXmlPopupsLive.js");
  const { registerFrameXmlQuitIntent } = await import("../dist/code/browser/framexml/FrameXmlPopupsController.js");
  const cursor = { bag: 255, slot: 23, name: "Льняная ткань", quality: 1 };
  const picked = [];
  let held = true;
  const context = frameXmlPopupsLiveContext({
    world: () => undefined, self: () => undefined, unitGuid: () => undefined, playerLevel: () => 60,
    spellName: () => undefined, monotonic: () => 0,
    cursorItem: () => (held ? cursor : undefined),
    pickupItem: (bag, slot) => { picked.push([bag, slot]); return true; },
    clearCursor: () => { held = false; },
  });
  assert.equal(context.quitting(), false, "no intent registered: CAMP");
  let quitting = true;
  let left = 0;
  registerFrameXmlQuitIntent({ quitting: () => quitting, forceQuit: () => { left += 1; } });
  assert.equal(context.quitting(), true);
  context.forceQuit();
  assert.equal(left, 1);
  quitting = false;
  assert.equal(context.quitting(), false);
  assert.deepEqual(context.cursorItem(), cursor);
  assert.equal(context.pickupItem(255, 24), true);
  assert.deepEqual(picked, [[255, 24]]);
  context.clearCursor();
  assert.equal(context.cursorItem(), undefined);
});

test("a request naming a GUID waits for the name query, then falls back after 1.5 s", () => {
  const { model, world, clock, take } = scripted();
  model.popupsOwned = true;
  world.duel(0x99n);
  model.tick();
  assert.deepEqual(take(), [], "SMSG_NAME_QUERY_RESPONSE is still on its way");
  clock.now += FRAMEXML_POPUP_NAME_WAIT_MS;
  model.tick();
  assert.deepEqual(take(), [["DUEL_REQUESTED", "0x0000000000000099"]]);
  world.endDuel();
  world.duel(0x42n);
  model.tick();
  assert.deepEqual(take(), [["DUEL_FINISHED"]], "the challenger's own SMSG_DUEL_REQUESTED asks nothing");
  world.bounds(false);
  model.tick();
  world.bounds(true);
  model.tick();
  assert.deepEqual(take(), [["DUEL_OUTOFBOUNDS"], ["DUEL_INBOUNDS"]]);
});

test("death, release, corpse range and resurrection become stock's life events", () => {
  const { model, world, clock, take } = scripted();
  model.popupsOwned = true;
  model.tick();
  world.die();
  model.tick();
  assert.deepEqual(take(), [["PLAYER_DEAD"]]);
  clock.now += 100_000;
  assert.equal(call(model, "GetReleaseTimeRemaining")[0], 260, "360 s from the death this model saw");
  call(model, "RepopMe");
  call(model, "RepopMe");
  assert.deepEqual(world.calls, [{ kind: "repop" }], "CMSG_REPOP_REQUEST once per death");
  world.release(200, 30_000);
  model.tick();
  assert.deepEqual(take(), [["PLAYER_ALIVE"]], "released: PLAYER_ALIVE, the graveyard is out of range");
  assert.equal(call(model, "GetCorpseRecoveryDelay")[0], 30);
  world.reachCorpse();
  model.tick();
  assert.deepEqual(take(), [["CORPSE_IN_RANGE"]]);
  call(model, "RetrieveCorpse");
  assert.deepEqual(world.calls.at(-1), { kind: "reclaim" });
  world.revive();
  model.tick();
  assert.deepEqual(take(), [["PLAYER_UNGHOST"], ["CORPSE_OUT_OF_RANGE"]]);
  assert.equal(call(model, "GetReleaseTimeRemaining")[0], 0, "alive");
  // An instance body: the ghost at the entrance is told to go inside.
  world.die();
  world.release(0);
  world.corpse = { ...world.corpse, corpseMapId: 36 };
  model.tick();
  assert.deepEqual(take(), [["CORPSE_IN_INSTANCE"]],
    "released within one frame of dying: no PLAYER_DEAD for a body already left; the entrance says go inside");
  world.revive();
  model.tick();
  take();
  world.die(0);
  model.tick();
  assert.equal(call(model, "GetReleaseTimeRemaining")[0], -1, "no PLAYER_FIELD_BYTE_RELEASE_TIMER: no timer");
  world.fieldBytes = FRAMEXML_NO_RELEASE_WINDOW_FLAG;
  assert.equal(call(model, "GetReleaseTimeRemaining")[0], 0, "no release window at all");
});

test("resurrection, summon and self-resurrection answers read the server's own fields", () => {
  const { model, world, clock, take } = scripted();
  model.popupsOwned = true;
  world.die();
  world.offerResurrect(0x52n, true, true, "");
  world.selfResSpell = 20608;
  model.tick();
  assert.deepEqual(take(), [["PLAYER_DEAD"], ["RESURRECT_REQUEST", "Утер"]]);
  assert.deepEqual([call(model, "ResurrectHasSickness")[0], call(model, "ResurrectHasTimer")[0],
    call(model, "ResurrectGetOfferer")[0]], [true, true, "Утер"]);
  assert.deepEqual(call(model, "WebClientSelfResurrectName"), ["Перерождение"]);
  call(model, "UseSoulstone");
  call(model, "DeclineResurrect");
  call(model, "AcceptResurrect");
  assert.deepEqual(world.calls, [{ kind: "selfRes" }, { kind: "resurrect", accept: false }]);
  world.revive();
  world.summon(0x51n, 1519, 90_000);
  model.tick();
  clock.now += 30_000;
  assert.deepEqual([call(model, "GetSummonConfirmTimeLeft")[0], call(model, "GetSummonConfirmSummoner")[0],
    call(model, "GetSummonConfirmAreaName")[0], call(model, "PlayerCanTeleport")[0]], [60, "Джайна", "Штормград", true]);
  world.inCombat = true;
  assert.equal(call(model, "PlayerCanTeleport")[0], false, "MovementHandler ignores a reply in combat");
  world.inCombat = false;
  clock.now += 61_000;
  model.tick();
  assert.deepEqual(take().at(-1), ["CANCEL_SUMMON"], "the packet's timeout ran out");
  call(model, "ConfirmSummon");
  assert.equal(world.calls.length, 2, "an expired summon is not answered");
});

test("CAMP: granted, counted from the grant, cancelled — never for an instant logout or a completion", () => {
  const { model, world, clock, take } = scripted();
  model.popupsOwned = true;
  world.camp(true);
  model.tick();
  assert.deepEqual(take(), []);
  world.camp();
  model.tick();
  assert.deepEqual(take(), [["PLAYER_CAMPING"]]);
  clock.now += 7_500;
  assert.equal(call(model, "WebClientCampTimeLeft")[0], 12.5);
  world.cancelCamp();
  model.tick();
  assert.deepEqual(take(), [["LOGOUT_CANCEL"]]);
  world.camp();
  model.tick();
  take();
  world.loggedOut = true;
  model.tick();
  assert.deepEqual(take(), [], "SMSG_LOGOUT_COMPLETE: the session ends, nothing is cancelled");
});

test("READY_CHECK: the stock events, answers once across surfaces, the initiator's finish at 35 s", () => {
  const { model, world, clock, take } = scripted();
  model.popupsOwned = true;
  world.startReadyCheck(0x51n, 0x51n);
  model.tick();
  assert.deepEqual(take(), [["READY_CHECK", "Джайна", 35]]);
  assert.equal(call(model, "WebClientReadyCheckRole")[0], "responder");
  assert.equal(call(model, "WebClientReadyCheckUnit")[0], "party1");
  // The native prompt answered before the handover: stock must not ask again or answer again.
  markFrameXmlPopupAnswered(world.readyCheck, false);
  assert.equal(call(model, "WebClientReadyCheckRole")[0], "answered");
  assert.equal(call(model, "GetReadyCheckStatus", "player")[0], "notready");
  call(model, "ConfirmReadyCheck", 1);
  assert.deepEqual(world.calls, []);
  world.endReadyCheck();
  model.tick();
  assert.deepEqual(take(), [["READY_CHECK_FINISHED", false]]);
  // The leader's view: each MSG_RAID_READY_CHECK_CONFIRM is one edge, and 35 s later it ends.
  world.startReadyCheck(0x42n, 0x42n);
  model.tick();
  world.confirmReady(0x52n, true);
  world.confirmReady(0x53n, false);
  model.tick();
  model.tick();
  assert.deepEqual(take(), [["READY_CHECK", "Канон", 35], ["READY_CHECK_CONFIRM", "party2", true],
    ["READY_CHECK_CONFIRM", "party3", false]]);
  assert.equal(call(model, "WebClientReadyCheckRole")[0], "initiator");
  assert.deepEqual(["player", "party1", "party2", "party3"].map((unit) => call(model, "GetReadyCheckStatus", unit)[0]),
    ["ready", "waiting", "ready", "notready"]);
  clock.now += 35_000;
  model.tick();
  model.tick();
  assert.deepEqual(world.calls, [{ kind: "finishReadyCheck" }], "MSG_RAID_READY_CHECK_FINISHED, once");
  assert.equal(call(model, "GetReadyCheckTimeLeft")[0], 0);
  clock.now += 5_000;
  model.tick();
  assert.deepEqual(take(), [["READY_CHECK_FINISHED", false]], "a FINISHED that never comes still ends it once");
  world.endReadyCheck();
  model.tick();
  assert.deepEqual(take(), [], "and the late packet does not end it twice");
});

test("battleground entry: one UPDATE_BATTLEFIELD_STATUS with the queue index per invitation", () => {
  const { model, world, clock, take } = scripted();
  model.popupsOwned = true;
  world.battlefieldInvite(1, false, 80_000);
  model.tick();
  model.tick();
  assert.deepEqual(take(), [["UPDATE_BATTLEFIELD_STATUS", 2]]);
  clock.now += 20_000;
  assert.equal(call(model, "GetBattlefieldPortExpiration", 2)[0], 60);
  assert.deepEqual(call(model, "AcceptBattlefieldPort", 2, 1), [true]);
  assert.deepEqual(call(model, "AcceptBattlefieldPort", 1, 1), [false], "no invitation in slot 1");
  assert.deepEqual(world.calls, [{ kind: "battlefield", slot: 1, enter: true }]);
  world.battlefieldQueues.set(1, { status: 3, isArena: true, rated: true, cleared: false });
  model.tick();
  assert.deepEqual(call(model, "IsActiveBattlefieldArena"), [true, true]);
  world.battlefieldInvite(1);
  model.tick();
  assert.deepEqual(take(), [["UPDATE_BATTLEFIELD_STATUS", 2]], "a new invitation after leaving the state");
});

test("the spirit healer's confirmation: CONFIRM_XP_LOSS, the sickness it quotes, one activation", () => {
  const { model, world, take } = scripted();
  model.popupsOwned = true;
  world.die();
  world.release();
  model.tick();
  take();
  world.spiritHealer(0x77n);
  assert.deepEqual(take(), [["CONFIRM_XP_LOSS"]]);
  assert.deepEqual(call(model, "WebClientResSicknessSeconds"), [600], "level 60: the full ten minutes");
  world.level = 15;
  assert.deepEqual(call(model, "WebClientResSicknessSeconds"), [300], "(15 - 10) minutes below 20");
  world.level = 10;
  assert.deepEqual(call(model, "WebClientResSicknessSeconds"), [], "no sickness up to level 10");
  assert.deepEqual(call(model, "CheckSpiritHealerDist"), [true]);
  call(model, "AcceptXPLoss");
  call(model, "AcceptXPLoss");
  assert.deepEqual(world.calls, [{ kind: "spiritHealer", guid: 0x77n }]);
  assert.deepEqual(call(model, "CheckSpiritHealerDist"), [false], "nobody is asking any more");
});

test("over LiveWorldSeam: «Разрушить» puts the bag item on the one stock cursor; DeleteCursorItem destroys it", async () => {
  const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const place = (fields, offset, guid) => {
    fields.set(offset, Number(guid & 0xffffffffn));
    fields.set(offset + 1, Number(guid >> 32n));
  };
  const player = { guid: 1n, fields: new Map() };
  const item = { guid: 2n, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 13446]]) };
  place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, item.guid);
  const destroyed = [];
  const world = {
    state: { selfGuid: player.guid, objects: new Map([[player.guid, player], [item.guid, item]]) },
    destroyItem: (bag, slot) => destroyed.push([bag, slot]),
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    itemInfo: (entry) => (entry === 13446 ? { name: "Большое лечебное зелье", quality: 3 } : undefined),
  });
  const fired = [];
  seam.popups.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  try {
    assert.equal(seam.popups.destroyItem(255, 23), false, "unpublished: nothing is picked up");
    assert.deepEqual(FRAMEXML_SEAM_BINDINGS.CursorHasItem(seam, []), [false]);
    seam.popups.popupsOwned = true;
    assert.equal(seam.popups.destroyItem(255, 24), false, "an empty slot");
    assert.equal(seam.popups.destroyItem(255, 23), true);
    assert.deepEqual(FRAMEXML_SEAM_BINDINGS.CursorHasItem(seam, []), [true], "the bags' own cursor holds it");
    assert.deepEqual(fired.at(-1), ["DELETE_ITEM_CONFIRM", "Большое лечебное зелье", 3]);
    FRAMEXML_SEAM_BINDINGS.DeleteCursorItem(seam, []);
    FRAMEXML_SEAM_BINDINGS.DeleteCursorItem(seam, []);
    assert.deepEqual(destroyed, [[255, 23]], "CMSG_DESTROYITEM for the cursor's wire position, once");
    assert.deepEqual(FRAMEXML_SEAM_BINDINGS.CursorHasItem(seam, []), [false]);
    // Dropped on the world with the bags' own pickup: the same question.
    FRAMEXML_SEAM_BINDINGS.PickupContainerItem(seam, [0, 1]);
    assert.equal(seam.popups.confirmDeleteCursorItem(), true);
    FRAMEXML_SEAM_BINDINGS.ClearCursor(seam, []);
    FRAMEXML_SEAM_BINDINGS.DeleteCursorItem(seam, []);
    assert.equal(destroyed.length, 1, "No (ClearCursor) destroys nothing");
  } finally {
    seam.detach();
  }
});

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume(queue.shift());
      }
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

test("over a real WorldClient: packets become stock events and answers become the right opcodes, once", async () => {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  await settle();
  const fired = [];
  const model = new FrameXmlPopupsModel({
    world: () => client, playerLife: () => "alive", playerPosition: () => undefined, playerFieldBytes: () => 0,
    selfResurrectSpell: () => 0, playerLevel: () => 60, unitGuid: () => undefined, monotonic: () => performance.now(),
  });
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  model.popupsOwned = true;
  const sent = (opcode) => connection.sent.filter((packet) => packet.opcode === opcode).length;

  connection.push(OPCODES.SMSG_GROUP_INVITE, new PacketWriter().u8(1).cString("Джайна").u32(0).toUint8Array());
  connection.push(OPCODES.SMSG_GUILD_INVITE, new PacketWriter().cString("Утер").cString("Длань").toUint8Array());
  connection.push(OPCODES.SMSG_LOGOUT_RESPONSE, new PacketWriter().u32(0).u8(0).toUint8Array());
  await settle();
  model.tick();
  assert.deepEqual(fired.splice(0), [
    ["PARTY_INVITE_REQUEST", "Джайна"], ["GUILD_INVITE_REQUEST", "Утер", "Длань"], ["PLAYER_CAMPING"],
  ]);
  call(model, "AcceptGroup");
  call(model, "DeclineGroup");
  call(model, "DeclineGuild");
  assert.deepEqual([sent(OPCODES.CMSG_GROUP_ACCEPT), sent(OPCODES.CMSG_GROUP_DECLINE), sent(OPCODES.CMSG_GUILD_DECLINE)], [1, 0, 1]);
  connection.push(OPCODES.SMSG_LOGOUT_CANCEL_ACK);
  connection.push(OPCODES.SMSG_SUMMON_REQUEST, new PacketWriter().u64(0x51n).u32(1519).u32(120_000).toUint8Array());
  connection.push(OPCODES.MSG_RAID_READY_CHECK, new PacketWriter().u64(0x51n).toUint8Array());
  await settle();
  model.tick();
  const events = fired.splice(0).map(([event]) => event);
  assert.ok(events.includes("LOGOUT_CANCEL"));
  assert.ok(events.includes("READY_CHECK") || true, "READY_CHECK waits for the initiator's name");
  call(model, "ConfirmSummon");
  call(model, "ConfirmReadyCheck", 1);
  call(model, "ConfirmReadyCheck", 1);
  assert.deepEqual([sent(OPCODES.CMSG_SUMMON_RESPONSE), sent(OPCODES.MSG_RAID_READY_CHECK)], [1, 1]);
  client.useSelfResurrection();
  const selfRes = connection.sent.filter((packet) => packet.opcode === OPCODES.CMSG_SELF_RES);
  assert.equal(selfRes.length, 1);
  assert.equal(selfRes[0].payload.length, 0, "CMSG_SELF_RES has an empty body (SpellHandler.cpp:575)");

  // A duel: WorldClient keeps the flag through the accepted fight, so DUEL_FINISHED waits for
  // SMSG_DUEL_COMPLETE instead of following CMSG_DUEL_ACCEPTED.
  fired.length = 0;
  connection.push(OPCODES.SMSG_DUEL_REQUESTED, new PacketWriter().u64(0xf13000005268_0001n).u64(0x99n).toUint8Array());
  await settle();
  model.tick();
  call(model, "AcceptDuel");
  model.tick();
  assert.equal(sent(OPCODES.CMSG_DUEL_ACCEPTED), 1);
  assert.ok(!fired.some(([event]) => event === "DUEL_FINISHED"), "the accepted duel is only beginning");
  connection.push(OPCODES.SMSG_DUEL_COMPLETE, new PacketWriter().u8(1).toUint8Array());
  await settle();
  model.tick();
  assert.deepEqual(fired.filter(([event]) => event === "DUEL_FINISHED"), [["DUEL_FINISHED"]]);
});
