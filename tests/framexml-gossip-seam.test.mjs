import assert from "node:assert/strict";
import test from "node:test";

// The stock GossipFrame's C API over the canned innkeeper: the GOSSIP_SHOW/CLOSED edges, the row
// tuples GossipFrame.lua reads, and SelectGossipOption's confirm/code/send contract. MPQ-free; the
// stock Lua that consumes all of this runs in framexml-gossip-vertical.test.mjs.
const {
  FRAMEXML_GOSSIP_BINDINGS, FrameXmlGossipModel, frameXmlGossipOptionType, frameXmlGossipQuests, frameXmlGossipText,
  frameXmlQuestTrivial,
} = await import("../dist/code/browser/framexml/FrameXmlGossip.js");
const {
  FRAMEXML_CANNED_GOSSIP_PAGE, FRAMEXML_CANNED_GOSSIP_SUBPAGE, FRAMEXML_CANNED_GOSSIP_GUID, createCannedFrameXmlGossip,
} = await import("../dist/code/browser/framexml/FrameXmlGossipCanned.js");
const controller = await import("../dist/code/browser/framexml/FrameXmlGossipController.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

function fixture({ owned = true, playerLevel } = {}) {
  const { model, world } = createCannedFrameXmlGossip(playerLevel ? { playerLevel } : {});
  const fired = [];
  model.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  model.owned = owned;
  const call = (name, ...args) => FRAMEXML_GOSSIP_BINDINGS[name]({ gossip: model }, args);
  return { model, world, fired, call };
}

const names = (fired) => fired.map(([event]) => event);

test("GOSSIP_SHOW waits for the page's npc_text and is raised once per page", () => {
  const { world, fired, call } = fixture();
  world.talk(FRAMEXML_CANNED_GOSSIP_PAGE, true);
  assert.deepEqual(names(fired), [], "no text yet: stock would draw an empty greeting and the rows twice");
  assert.deepEqual(call("GetNumGossipOptions"), [0], "nothing is shown, nothing is answered");
  world.answerText();
  assert.deepEqual(names(fired), ["GOSSIP_SHOW"]);
  // WorldClient repaints the native window again when a re-query lands; stock must not re-run
  // GossipFrame_OnEvent (its lone-service-row shortcut would select that row twice).
  world.onChanged();
  assert.deepEqual(names(fired), ["GOSSIP_SHOW"]);
  assert.deepEqual(call("GetGossipText"), ["Добро пожаловать в «Златоземье», Тестер! Путь до Штормграда неблизкий — отдохни у огня."]);
  world.closeGossip();
  assert.deepEqual(names(fired), ["GOSSIP_SHOW", "GOSSIP_CLOSED"]);
});

test("an unpublished model raises nothing; publication hands the open page over", () => {
  const { model, world, fired } = fixture({ owned: false });
  world.talk();
  assert.deepEqual(fired, [], "the native window answers this page");
  model.owned = true;
  assert.deepEqual(names(fired), ["GOSSIP_SHOW"], "the page already open when stock took the route");
  model.owned = false;
  world.talk(FRAMEXML_CANNED_GOSSIP_SUBPAGE);
  assert.deepEqual(names(fired), ["GOSSIP_SHOW"]);
});

test("the row tuples: options as text/type pairs, quests as GossipFrame.lua reads them", () => {
  const { world, call } = fixture();
  world.talk();
  assert.deepEqual(call("GetNumGossipOptions"), [4]);
  assert.deepEqual(call("GetGossipOptions"), [
    "Расскажи мне об этом городе.", "gossip",
    "Я хочу остановиться в этой таверне.", "binder",
    "Покажи мне свои товары.", "vendor",
    "Мне нужна комната на ночь.", "banker",
  ]);
  assert.deepEqual(call("GetNumGossipAvailableQuests"), [1]);
  // title, level, isTrivial (nil: no player level to grey against), isDaily, isRepeatable
  assert.deepEqual(call("GetGossipAvailableQuests"), ["Кобольдские свечи", 5, undefined, false, false]);
  assert.deepEqual(call("GetNumGossipActiveQuests"), [1]);
  // title, level, isTrivial, isComplete (PLAYER_QUEST_LOG's complete bit)
  assert.deepEqual(call("GetGossipActiveQuests"), ["Золотая пыль", 58, undefined, true]);
  assert.deepEqual(call("ForceGossip"), [false]);
});

test("a quest the player has outgrown is trivial: more than GetQuestGreenRange() levels below", () => {
  const { world, call } = fixture({ playerLevel: () => 60 });
  world.talk();
  assert.deepEqual(call("GetGossipAvailableQuests"), ["Кобольдские свечи", 5, true, false, false], "60 - 5 > 12");
  assert.deepEqual(call("GetGossipActiveQuests"), ["Золотая пыль", 58, false, true], "60 - 58 is within the range");
  // UIParent.lua GetQuestDifficultyColor: trivial when -levelDiff > GetQuestGreenRange().
  assert.equal(frameXmlQuestTrivial(5, 10, 5), false, "10 - 5 = 5 is still green");
  assert.equal(frameXmlQuestTrivial(4, 10, 5), true);
  assert.equal(frameXmlQuestTrivial(-1, 80, 12), false, "a quest that scales to the player");
  assert.equal(frameXmlQuestTrivial(5, undefined, 0), undefined, "no player level: nil, as before");
  const low = fixture({ playerLevel: () => 6 });
  low.world.talk();
  assert.equal(low.call("GetGossipAvailableQuests")[2], false);
  const probed = fixture({ playerLevel: () => 60 });
  probed.model.probe({ text: "p", page: FRAMEXML_CANNED_GOSSIP_PAGE },
    () => assert.equal(probed.call("GetGossipAvailableQuests")[2], undefined, "the gate's probe page is never grey"));
});

test("an npc_text the database lacks still greets: TrinityCore's all-zero «Greetings $N» row", () => {
  // QueryHandler.cpp:246-259: no npc_text row, eight options at probability 0 saying «Greetings $N».
  const missing = { id: 9999, options: Array.from({ length: 8 }, () => ({ probability: 0, male: "Greetings $N", female: "Greetings $N", language: 0 })) };
  assert.equal(frameXmlGossipText(missing), "Greetings $N");
  const weighted = { id: 1, options: [
    { probability: 0, male: "never", female: "", language: 0 },
    { probability: 0.2, male: "", female: "rare", language: 0 },
    { probability: 0.8, male: "usual", female: "", language: 0 },
  ] };
  assert.equal(frameXmlGossipText(weighted), "usual", "a weighted line still wins over an unweighted one");
  assert.equal(frameXmlGossipText({ id: 2, options: [] }), undefined);
  const { world, call } = fixture();
  world.talk({ ...FRAMEXML_CANNED_GOSSIP_SUBPAGE, textId: 9999 }, true);
  world.npcTexts.set(9999, missing);
  world.answerText();
  assert.deepEqual(call("GetGossipText"), ["Greetings Тестер"], "$N resolved like any other line");
});

test("GossipOptionIcon maps onto the icon words whose textures this client ships", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(frameXmlGossipOptionType),
    ["gossip", "vendor", "taxi", "trainer", "healer", "binder", "banker", "petition", "tabard", "battlemaster", "unlearn"]);
  assert.equal(frameXmlGossipOptionType(11), "gossip", "11+ are chat bubbles in the core's enum");
  assert.equal(frameXmlGossipOptionType(200), "gossip");
  // PrepareQuestMenu: 4 involved, 0 and 2 to take; an unknown icon is in neither group.
  const page = { quests: [{ icon: 2 }, { icon: 4 }, { icon: 0 }, { icon: 5 }] };
  assert.equal(frameXmlGossipQuests(page, "available").length, 2);
  assert.equal(frameXmlGossipQuests(page, "active").length, 1);
});

test("SelectGossipOption asks before paying or typing, then sends the option id", () => {
  const { world, fired, call } = fixture();
  world.talk();
  fired.length = 0;
  call("SelectGossipOption", 4);
  assert.deepEqual(fired, [["GOSSIP_CONFIRM", 4, "Комната стоит 10 серебряных.", 1000]], "a price: stock's GOSSIP_CONFIRM");
  assert.deepEqual(world.calls, []);
  call("SelectGossipOption", 4, "", 1);
  assert.deepEqual(world.calls, [{ kind: "select", optionId: 3, code: undefined }], "the accepted dialog sends");
  call("SelectGossipOption", 2);
  assert.deepEqual(fired.at(-1), ["GOSSIP_CONFIRM", 2, "Сделать эту таверну своим домом?", 0], "a box message alone asks too");
  call("SelectGossipOption", 3);
  assert.deepEqual(world.calls.at(-1), { kind: "select", optionId: 2, code: undefined }, "a plain row sends at once");
  call("SelectGossipOption", 9);
  call("SelectGossipOption", 0);
  assert.equal(world.calls.length, 2, "an index outside the page sends nothing");
});

test("a coded row raises GOSSIP_ENTER_CODE and sends the code the dialog gives back", () => {
  const { model, world, fired } = fixture();
  world.talk({ ...FRAMEXML_CANNED_GOSSIP_SUBPAGE, options: [
    { id: 7, icon: 0, coded: true, money: 0, text: "Пароль?", boxText: "Скажи пароль" },
  ] });
  fired.length = 0;
  model.selectOption(1, undefined, false);
  assert.deepEqual(fired, [["GOSSIP_ENTER_CODE", 1]]);
  model.selectOption(1, "сезам", true);
  assert.deepEqual(world.calls, [{ kind: "select", optionId: 7, code: "сезам" }]);
});

test("a page that replaced the one on screen is not re-indexed under the player's click", () => {
  const { world, call } = fixture();
  world.talk();
  // A new menu arrived and its text is still being queried: stock still shows the old rows.
  world.talk(FRAMEXML_CANNED_GOSSIP_SUBPAGE, true);
  assert.deepEqual(call("GetNumGossipOptions"), [4], "reads answer the page Lua was told about");
  call("SelectGossipOption", 3);
  assert.deepEqual(world.calls, [], "the old row's id is not sent against the new menu");
  world.answerText();
  assert.deepEqual(call("GetNumGossipOptions"), [1]);
});

test("the quest rows open the quest by id, an involved one as a turn-in", () => {
  const { world, call } = fixture();
  world.talk();
  call("SelectGossipAvailableQuest", 1);
  call("SelectGossipActiveQuest", 1);
  call("SelectGossipActiveQuest", 2);
  assert.deepEqual(world.calls, [
    { kind: "quest", questId: 60, completion: false },
    { kind: "quest", questId: 47, completion: true },
  ]);
});

test("CloseGossip forgets the page; a probe answers its own page and sends nothing", () => {
  const { model, world, fired, call } = fixture();
  world.talk();
  const probe = { text: "p", page: { ...FRAMEXML_CANNED_GOSSIP_PAGE, guid: 0n } };
  model.probe(probe, () => {
    assert.deepEqual(call("GetGossipText"), ["p"]);
    call("SelectGossipOption", 3);
    call("SelectGossipAvailableQuest", 1);
    call("CloseGossip");
  });
  assert.deepEqual(world.calls, [], "muted: no packet, and the real page is still open");
  assert.equal(world.gossip, FRAMEXML_CANNED_GOSSIP_PAGE);
  call("CloseGossip");
  assert.deepEqual(world.calls, [{ kind: "close" }]);
  assert.deepEqual(names(fired), ["GOSSIP_SHOW", "GOSSIP_CLOSED"]);
});

test("the seam table carries the gossip C API and a seam without the model answers nothing", () => {
  for (const name of Object.keys(FRAMEXML_GOSSIP_BINDINGS)) {
    assert.ok(FRAMEXML_SEAM_BINDINGS[name], `${name} reaches the stock Lua through the seam`);
  }
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetNumGossipOptions({}, []), []);
  assert.equal(new FrameXmlGossipModel({ world: () => undefined }).text(), undefined);
  assert.equal(FRAMEXML_CANNED_GOSSIP_PAGE.guid, FRAMEXML_CANNED_GOSSIP_GUID);
});

test("the controller answers false until published and a stale cleanup keeps the current owner", () => {
  assert.equal(controller.notifyFrameXmlGossip(), false);
  assert.equal(controller.frameXmlGossipOpen(), false);
  assert.equal(controller.closeFrameXmlGossip(), false);
  const log = [];
  const owner = (name) => ({ isOpen: () => true, sync: () => log.push(`${name}:sync`), close: () => log.push(`${name}:close`) });
  const releaseFirst = controller.publishFrameXmlGossip(owner("a"));
  const releaseSecond = controller.publishFrameXmlGossip(owner("b"));
  releaseFirst();
  assert.equal(controller.frameXmlGossipPublished(), true);
  assert.equal(controller.notifyFrameXmlGossip(), true);
  assert.equal(controller.closeFrameXmlGossip(), true);
  assert.deepEqual(log, ["b:sync", "b:close"]);
  releaseSecond();
  assert.equal(controller.frameXmlGossipPublished(), false);
});
