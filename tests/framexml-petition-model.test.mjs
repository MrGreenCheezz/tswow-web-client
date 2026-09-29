import assert from "node:assert/strict";
import test from "node:test";

// The charter windows' models without the MPQ corpus: the tabard designer's ranges, the vendor
// kind and banner colours, the charter's edges, and the new wire bodies.
const tabard = await import("../dist/code/browser/framexml/FrameXmlTabard.js");
const registrar = await import("../dist/code/browser/framexml/FrameXmlRegistrar.js");
const petition = await import("../dist/code/browser/framexml/FrameXmlPetition.js");
const canned = await import("../dist/code/browser/framexml/FrameXmlPetitionCanned.js");
const { liveFrameXmlInteractionNpc } = await import("../dist/code/browser/framexml/FrameXmlGossipLive.js");
const { buildOfferPetition } = await import("../dist/code/world/PetitionProtocol.js");

function pump() {
  const events = [];
  return { events, fire(event, ...args) { events.push([event, ...args]); return 1; } };
}

test("the designer's arrows wrap in the measured GuildEmblems ranges; border colours follow the style", () => {
  const start = { style: 169, color: 0, borderStyle: 5, borderColor: 16, background: 50 };
  assert.equal(tabard.frameXmlTabardCycle(start, 1, 1).style, 0, "Emblem_169 is the last symbol");
  assert.equal(tabard.frameXmlTabardCycle(start, 2, -1).color, 16);
  assert.equal(tabard.frameXmlTabardCycle(start, 5, 1).background, 0);
  const later = tabard.frameXmlTabardCycle(start, 3, 1);
  assert.deepEqual([later.borderStyle, later.borderColor], [6, 3], "styles 6-9 have four colours: the colour is clamped");
  assert.equal(tabard.frameXmlTabardCycle(later, 4, 1).borderColor, 0);
  assert.equal(tabard.frameXmlTabardEmblemTexture(start, "lower"), "Textures\\GuildEmblems\\Emblem_169_00_TL_U");
  assert.deepEqual(tabard.frameXmlTabardFromGuild({ emblemStyle: 400, emblemColor: -1, borderStyle: 8, borderColor: 9, backgroundColor: 3 }),
    { style: 169, color: 0, borderStyle: 8, borderColor: 3, background: 3 });
});

test("the tabard model raises OPEN/CLOSE once per designer and waits for the guild's emblem", () => {
  const { world, tabard: model } = canned.createCannedFrameXmlCharters();
  const events = pump();
  model.attach(events);
  model.owned = true;
  world.guildQuery = undefined;
  world.openTabard();
  assert.deepEqual(events.events.map(([name]) => name), ["OPEN_TABARD_FRAME"]);
  model.initialize();
  assert.equal(model.emblemTexture("upper"), undefined, "no emblem before the guild query");
  assert.equal(model.canSave(), false);
  world.guildQuery = { emblemStyle: 1, emblemColor: 2, borderStyle: 3, borderColor: 4, backgroundColor: 5 };
  world.events.emit("TABARD_VENDOR_CHANGED", { guid: world.tabardVendorGuid });
  assert.deepEqual(events.events.map(([name]) => name), ["OPEN_TABARD_FRAME", "OPEN_TABARD_FRAME"],
    "the guild query's arrival re-opens the frame so it draws the emblem");
  model.initialize();
  assert.equal(model.emblemTexture("upper"), "Textures\\GuildEmblems\\Emblem_01_02_TU_U");
  model.close();
  assert.equal(world.tabardVendorGuid, 0n);
  assert.deepEqual(events.events.at(-1), ["CLOSE_TABARD_FRAME"]);
  model.detach();
});

test("the vendor kind is the list's shape; banner colours are opaque ARGB words", () => {
  assert.equal(registrar.frameXmlRegistrarKind(canned.FRAMEXML_CANNED_GUILD_LIST), "guild");
  assert.equal(registrar.frameXmlRegistrarKind(canned.FRAMEXML_CANNED_ARENA_LIST), "arena");
  assert.equal(registrar.frameXmlArenaBannerColor(1, 0.5, 0), 0xffff8000);
  assert.equal(registrar.frameXmlArenaBannerColor(2, -1, "x"), 0xffff0000, "out of range clamps, nonsense is 0");
});

test("the registrar raises the kind's SHOW/CLOSED, and UPDATE when a waited-for name lands", () => {
  const { world, registrar: model } = canned.createCannedFrameXmlCharters();
  const events = pump();
  model.attach(events);
  model.owned = true;
  world.openList(canned.FRAMEXML_CANNED_GUILD_LIST);
  assert.deepEqual(events.events.map(([name]) => name), ["GUILD_REGISTRAR_SHOW"]);
  assert.equal(model.guildCharterCost(), 1000);
  world.openList(canned.FRAMEXML_CANNED_ARENA_LIST);
  assert.deepEqual(events.events.map(([name]) => name).slice(1),
    ["GUILD_REGISTRAR_CLOSED", "PETITION_VENDOR_SHOW", "PETITION_VENDOR_UPDATE"]);
  assert.equal(model.guildCharterCost(), undefined);
  assert.deepEqual(model.petitionItemInfo(3), ["Хартия команды арены 5 на 5", undefined, 2000000]);
  world.uncached.add(23560);
  world.events.emit("QUERY_CACHE_CHANGED", { kind: "item", id: 23560 });
  assert.deepEqual(model.petitionItemInfo(1), []);
  const before = events.events.length;
  world.cacheItem(23560);
  assert.deepEqual(events.events.slice(before).map(([name]) => name), ["PETITION_VENDOR_UPDATE"]);
  // A carried charter known to be short of signatures is not «filled».
  world.carried = [{ guid: canned.FRAMEXML_CANNED_CHARTER_GUID, entry: 23560 }];
  assert.equal(model.hasFilledPetition(), true, "unknown count: the server decides");
  world.petition = { ...canned.FRAMEXML_CANNED_CHARTER_INFO, minSignatures: 1, arena: true };
  world.petitionSignatures = { ...canned.FRAMEXML_CANNED_CHARTER_SIGNATURES, signers: [] };
  assert.equal(model.hasFilledPetition(), false);
  model.close("guild");
  assert.notEqual(world.petitionVendor, undefined, "the other kind's close does nothing");
  model.close("arena");
  assert.equal(world.petitionVendor, undefined);
  assert.deepEqual(events.events.at(-1), ["PETITION_VENDOR_CLOSED"]);
  model.detach();
});

test("the charter model: one query per shown charter, the rename re-raise, nothing while muted", () => {
  const { world, petition: model } = canned.createCannedFrameXmlCharters();
  const events = pump();
  model.attach(events);
  model.owned = true;
  world.showCharter(canned.FRAMEXML_CANNED_CHARTER_SIGNATURES, true);
  world.events.emit("PETITION_CHANGED", {});
  assert.deepEqual(world.calls, [{ kind: "query", petitionGuid: canned.FRAMEXML_CANNED_CHARTER_GUID }]);
  world.answerQuery();
  assert.deepEqual(events.events, [["PETITION_SHOW"]]);
  assert.deepEqual(model.info(), ["guild", "Стражи Златоземья", "", 9, "Альдерик", false, 9]);
  assert.equal(model.nameInfo(1), "Бруна");
  assert.equal(model.nameInfo(2), undefined);
  assert.equal(model.canSign(), true);
  world.events.emit("PETITION_CHANGED", {});
  assert.equal(events.events.length, 1, "an unrelated answer re-raises nothing");
  world.answerQuery({ ...canned.FRAMEXML_CANNED_CHARTER_INFO, name: "Другое имя" });
  assert.equal(events.events.length, 2);
  model.muted(() => { model.sign(); model.close(); });
  assert.equal(world.calls.length, 1);
  assert.equal(petition.frameXmlPetitionInfoFor(world.petition, { ...world.petitionSignatures, petitionId: 2 }), undefined);
  model.detach();
});

test("CMSG_OFFER_PETITION is a discarded word, the charter and the player", () => {
  assert.deepEqual([...buildOfferPetition(0x0102030405060708n, 0x11n)], [
    0, 0, 0, 0, 8, 7, 6, 5, 4, 3, 2, 1, 0x11, 0, 0, 0, 0, 0, 0, 0,
  ]);
});

test("UnitName('npc') names the tabard designer or the registrar while one is open", () => {
  assert.equal(liveFrameXmlInteractionNpc({ tabardVendorGuid: 0x55n, bankerGuid: undefined }), 0x55n);
  assert.equal(liveFrameXmlInteractionNpc({ tabardVendorGuid: 0n, petitionVendor: { vendorGuid: 0x66n } }), 0x66n);
  assert.equal(liveFrameXmlInteractionNpc({ tabardVendorGuid: 0n }), undefined);
});
