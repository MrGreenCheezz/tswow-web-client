import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/index.js";
import {
  QUEST_STATE_COMPLETE, QUEST_STATE_FAIL, QUEST_STATUS_AVAILABLE, QUEST_STATUS_REWARD,
  buildAbandonQuest, buildCarriedItemCounts, buildQuestLogView, buildQuestPoiQuery, splitQuestMoney,
  parseCompletedQuests, parseGossipPoi,
  parseQuestConfirmAccept, parseQuestGiverStatus, parseQuestGiverStatusMultiple, parseQuestIdUpdate,
  parseQuestKillUpdate, parseQuestPoi, parseQuestQueryResponse,
} from "../dist/code/world/QuestProtocol.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { questMapObjectiveMarkers, questMarkerProgress } from "../dist/code/browser/ui/QuestObjectiveMarkers.js";

const GIVER = 0xf130000000000303n;

/**
 * Writes a quest the way `QueryQuestInfoResponse::Write` does. Everything this client does not read
 * still has to be written, or every field after it lands one place to the left.
 */
function writeQuest({
  questId = 62, title = "Волки у ворот", rewardMoney = 1200, rewardDisplaySpell = 0,
  rewardSpellCast = 0, objectives = [], items = [],
} = {}) {
  const writer = new PacketWriter();
  writer.u32(questId).u32(2).u32(10).u32(6).u32(12);       // id, method, level, min level, sort
  writer.u32(0).u32(0);                                     // type, suggested players
  for (let team = 0; team < 2; team++) writer.u32(0).u32(0); // required faction id and value
  writer.u32(0).u32(0);                                     // next quest, xp difficulty
  writer.i32(rewardMoney).u32(0).u32(rewardDisplaySpell).i32(rewardSpellCast); // RewOrReqMoney, bonus, RewSpell, RewSpellCast
  writer.u32(0).f32(0).u32(0);                              // honor, kill honor, start item
  writer.u32(0x08).u32(0).u32(0).u32(0).u32(0).u32(0);      // flags, title id, kills, talents, arena, faction flags
  for (let index = 0; index < 4; index++) writer.u32(index === 0 ? 117 : 0).u32(index === 0 ? 5 : 0);
  for (let index = 0; index < 6; index++) writer.u32(index === 0 ? 2504 : 0).u32(index === 0 ? 1 : 0);
  for (let index = 0; index < 15; index++) writer.u32(0);   // five factions: ids, values, overrides
  writer.u32(0).f32(-9450.5).f32(60.25).u32(1);             // point of interest
  writer.cString(title).cString("Убей волков").cString("Подробности").cString("Область").cString("Готово");
  for (let index = 0; index < 4; index++) {
    const objective = objectives[index];
    writer.u32(objective?.entry ?? 0).u32(objective?.count ?? 0).u32(0).u32(0);
  }
  for (let index = 0; index < 6; index++) {
    const item = items[index];
    writer.u32(item?.itemId ?? 0).u32(item?.count ?? 0);
  }
  for (let index = 0; index < 4; index++) writer.cString(objectives[index]?.text ?? "");
  return writer.toUint8Array();
}

test("a quest description decodes, including the bit that means gameobject", () => {
  const payload = writeQuest({
    objectives: [
      { entry: 299, count: 10, text: "Лесной волк убит" },
      // The core sets the top bit to say "this entry is a gameobject, not a creature".
      { entry: (0x8000_0000 | 1617) >>> 0, count: 5, text: "Куст собран" },
    ],
    items: [{ itemId: 769, count: 8 }],
  });

  const quest = parseQuestQueryResponse(payload);
  assert.equal(quest.questId, 62);
  assert.equal(quest.title, "Волки у ворот");
  assert.equal(quest.level, 10);
  assert.equal(quest.rewardMoney, 1200);
  assert.deepEqual(quest.rewardItems, [{ itemId: 117, count: 5 }]);
  assert.deepEqual(quest.rewardChoiceItems, [{ itemId: 2504, count: 1 }]);
  assert.deepEqual(quest.itemObjectives, [{ slot: 0, itemId: 769, count: 8 }]);
  assert.equal(quest.objectives.length, 2);
  assert.deepEqual(quest.objectives[0], { slot: 0, entry: 299, count: 10, gameObject: false, itemDrop: 0, text: "Лесной волк убит" });
  assert.equal(quest.objectives[1].entry, 1617, "the id is what is left after the flag comes off");
  assert.equal(quest.objectives[1].gameObject, true);
  assert.ok(Math.abs(quest.poi.x - -9450.5) < 0.01);
});

test("sparse quest objectives retain server slot identities for counters and POI markers", () => {
  // QuestPackets.cpp writes all four NPC/GO and six item slots, including holes. The player
  // update fields and quest_poi.ObjectiveIndex address those original slots.
  const quest = parseQuestQueryResponse(writeQuest({
    objectives: [
      { entry: 0, count: 0, text: "Текст пустого нулевого слота" },
      undefined,
      { entry: 299, count: 10, text: "Третий слот" },
    ],
    items: [undefined, undefined, undefined, { itemId: 769, count: 8 }],
  }));
  assert.deepEqual(quest.objectives.map(({ slot, entry }) => [slot, entry]), [[2, 299]]);
  assert.equal(quest.objectives[0].text, "Третий слот",
    "objective text is indexed before the four wire slots are compacted");
  assert.deepEqual(quest.itemObjectives.map(({ slot, itemId }) => [slot, itemId]), [[3, 769]]);

  const [entry] = buildQuestLogView(
    [{ slot: 0, questId: 62, state: 0, counters: [0, 0, 7, 0], timer: 0 }],
    new Map([[62, quest]]), new Map([[769, 5]]),
  );
  assert.deepEqual(entry.objectives.map(({ poiIndex, have, need }) => [poiIndex, have, need]), [
    [2, 7, 10],
    [7, 5, 8],
  ]);
  const blobs = [2, 7].map((objectiveIndex) => ({
    index: objectiveIndex, objectiveIndex, map: 0, worldMapAreaId: 1, floor: 0,
    points: [{ x: 10, y: 20 }],
  }));
  const markers = questMapObjectiveMarkers([entry], new Map([[62, blobs]]));
  assert.deepEqual(markers.map(({ kind, id }) => [kind, id]), [["creature", 299], ["item", 769]]);
  assert.deepEqual(markers.map(questMarkerProgress), ["7 / 10", "5 / 8"]);
});

test("quest query keeps distinct display/cast spells and signed reward-or-required money", () => {
  const quest = parseQuestQueryResponse(writeQuest({
    rewardMoney: -4321,
    rewardDisplaySpell: 133,
    rewardSpellCast: 689,
  }));

  assert.equal(quest.rewardDisplaySpell, 133);
  assert.equal(quest.rewardSpellCast, 689);
  assert.equal(quest.rewardSpell, 689, "legacy rewardSpell remains the cast-spell alias");
  assert.equal(quest.rewardMoney, -4321, "negative RewOrReqMoney must remain signed");
  assert.equal(quest.requiredMoney, 4321);
  assert.deepEqual(splitQuestMoney(quest.rewardMoney), { raw: -4321, reward: 0, required: 4321 });
  assert.deepEqual(splitQuestMoney(1200), { raw: 1200, reward: 1200, required: 0 });
});

test("the log joins what the fields count to what the quest is", () => {
  const template = parseQuestQueryResponse(writeQuest({
    objectives: [{ entry: 299, count: 10, text: "Лесной волк убит" }],
    items: [{ itemId: 769, count: 8 }],
  }));
  const templates = new Map([[62, template]]);

  const view = buildQuestLogView([
    { slot: 0, questId: 62, state: 0, counters: [7, 0, 0, 0], timer: 0 },
    { slot: 1, questId: 999, state: QUEST_STATE_COMPLETE, counters: [0, 0, 0, 0], timer: 0 },
    { slot: 2, questId: 62, state: QUEST_STATE_FAIL, counters: [10, 0, 0, 0], timer: 1_700_000_000 },
  ], templates);

  assert.equal(view[0].objectives[0].text, "Лесной волк убит");
  assert.deepEqual([view[0].objectives[0].have, view[0].objectives[0].need], [7, 10]);
  assert.equal(view[0].objectives[0].done, false);
  // The item objective is listed even though its tally lives in the bags rather than in a counter.
  assert.equal(view[0].objectives[1].need, 8);

  // A quest whose description has not arrived is still in the log; the log knows it is there
  // before it knows its name.
  assert.equal(view[1].template, undefined);
  assert.equal(view[1].complete, true);

  assert.equal(view[2].failed, true);
  assert.equal(view[2].objectives[0].done, true);
  assert.equal(view[2].timer, 1_700_000_000);
});

test("item objectives use the authoritative carried count, or stay unknown", () => {
  const template = parseQuestQueryResponse(writeQuest({
    items: [{ itemId: 769, count: 8 }],
  }));
  const slots = [{ slot: 0, questId: 62, state: 0, counters: [0, 0, 0, 0], timer: 0 }];
  const templates = new Map([[62, template]]);

  const known = buildQuestLogView(slots, templates, new Map([[769, 9]]));
  assert.deepEqual(
    [known[0].objectives[0].have, known[0].objectives[0].need, known[0].objectives[0].done],
    [9, 8, true],
  );

  const unknown = buildQuestLogView(slots, templates);
  assert.ok(Number.isNaN(unknown[0].objectives[0].have));
  assert.equal(unknown[0].objectives[0].done, false);
});

test("carried item counts sum split stacks", () => {
  const counts = buildCarriedItemCounts([
    { itemId: 769, count: 5 },
    { itemId: 769, count: 4 },
    { itemId: 2504, count: 1 },
    { itemId: 0, count: 999 },
  ]);
  assert.equal(counts.get(769), 9);
  assert.equal(counts.get(2504), 1);
  assert.equal(counts.has(0), false);
});

test("quest giver marks, progress and finishing decode", () => {
  assert.deepEqual(parseQuestGiverStatus(new PacketWriter().u64(GIVER).u8(QUEST_STATUS_AVAILABLE).toUint8Array()),
    { guid: GIVER, status: QUEST_STATUS_AVAILABLE });

  const many = parseQuestGiverStatusMultiple(new PacketWriter().u32(2)
    .u64(GIVER).u8(QUEST_STATUS_REWARD)
    .u64(0x44n).u8(QUEST_STATUS_AVAILABLE)
    .toUint8Array());
  assert.equal(many.length, 2);
  assert.equal(many[0].status, QUEST_STATUS_REWARD);

  const kill = parseQuestKillUpdate(new PacketWriter().u32(62).u32(299).u32(3).u32(10).u64(GIVER).toUint8Array());
  assert.deepEqual([kill.questId, kill.entry, kill.count, kill.required], [62, 299, 3, 10]);

  assert.equal(parseQuestIdUpdate(new PacketWriter().u32(62).toUint8Array()), 62);

  const shared = parseQuestConfirmAccept(new PacketWriter().u32(62).cString("Волки у ворот").u64(GIVER).toUint8Array());
  assert.deepEqual(shared, { questId: 62, title: "Волки у ворот", initiatorGuid: GIVER });

  assert.deepEqual(parseCompletedQuests(new PacketWriter().u32(3).u32(1).u32(7).u32(62).toUint8Array()), [1, 7, 62]);
});

test("points of interest decode, and the query names the quests it wants", () => {
  const payload = new PacketWriter().u32(1)
    .u32(62).u32(1)
    .u32(0).u32(-1).u32(0).u32(1519).u32(0).u32(0).u32(0).u32(2)
    .u32(0xffff_dc20).u32(100)
    .u32(50).u32(0xffff_ff9c)
    .toUint8Array();
  const poi = parseQuestPoi(payload);
  const blobs = poi.get(62);
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].objectiveIndex, -1);
  assert.equal(blobs[0].worldMapAreaId, 1519);
  // The points are signed: half the world is at negative coordinates.
  assert.deepEqual(blobs[0].points, [{ x: -9184, y: 100 }, { x: 50, y: -100 }]);

  assert.deepEqual([...buildQuestPoiQuery([62, 63])], [2, 0, 0, 0, 62, 0, 0, 0, 63, 0, 0, 0]);
  assert.deepEqual([...buildAbandonQuest(3)], [3]);

  const gossip = parseGossipPoi(new PacketWriter().u32(1).f32(-9450).f32(60).u32(7).u32(0).cString("Кузница").toUint8Array());
  assert.equal(gossip.name, "Кузница");
  assert.equal(gossip.icon, 7);
});

test("quest markers are asked for in chunks the log's own size and kept when they come back empty", async () => {
  // A quest with nowhere to go comes back with an empty list, and that is an answer: kept, so the
  // map does not ask for it again on every log change for the rest of the session.
  const response = new PacketWriter().u32(2)
    .u32(100).u32(0)
    .u32(101).u32(1)
    .u32(0).i32(0).u32(0).u32(30).u32(0).u32(0).u32(0).u32(2)
    .i32(-9450).i32(-60)
    .i32(-9400).i32(-70)
    .toUint8Array();
  const login = new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array();
  const connection = {
    sent: [],
    packets: [
      { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login },
      { opcode: OPCODES.SMSG_QUEST_POI_QUERY_RESPONSE, payload: response },
    ],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  await client.loginCharacter(1n);
  await Promise.resolve();
  await Promise.resolve();

  // Twenty-six quests. `MAX_QUEST_LOG_SIZE` is 25, and a query naming more is dropped **whole**
  // rather than trimmed — so one oversized packet loses every marker, not just the extra one.
  const questIds = Array.from({ length: 26 }, (_, index) => 100 + index);
  client.requestQuestPoi(questIds);
  const queries = connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_QUEST_POI_QUERY);
  assert.equal(queries.length, 2, "26 ids is two packets, not one the server will throw away");
  assert.deepEqual(queries[0].payload, buildQuestPoiQuery(questIds.slice(0, 25)));
  assert.deepEqual(queries[1].payload, buildQuestPoiQuery(questIds.slice(25)));
  assert.equal(client.requestQuestPoi([]) ?? true, true, "an empty log sends nothing");
  assert.equal(connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_QUEST_POI_QUERY).length, 2);

  assert.deepEqual(client.questPoi.get(100), []);
  assert.equal(client.questPoi.has(100), true, "empty and never-asked have to be different");
  assert.equal(client.questPoi.get(101)?.[0]?.worldMapAreaId, 30);
  assert.deepEqual(client.questPoi.get(101)?.[0]?.points, [{ x: -9450, y: -60 }, { x: -9400, y: -70 }]);
});

/** Small DOM seam for the one interaction test below; it implements real child lookup and events. */
function questDom() {
  let documentRef;
  let activeElement;
  const byId = new Map();
  const attach = (parent, child, index = parent.children.length) => {
    if (!child || typeof child !== "object") return;
    child.parentNode?.removeChild?.(child);
    child.parentNode = parent;
    child.parentElement = parent;
    parent.children.splice(index, 0, child);
  };
  const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
  const matches = (node, selector) => {
    const attr = selector.match(/^(?:([a-z0-9_-]+))?\[([^=]+)=['"]?([^\]'"]+)['"]?\]$/i);
    if (attr) {
      if (attr[1] && node.tagName.toLowerCase() !== attr[1].toLowerCase()) return false;
      const value = node.getAttribute(attr[2]) ?? node[attr[2]];
      return String(value) === attr[3];
    }
    if (selector.startsWith("#")) return node.id === selector.slice(1);
    if (selector.startsWith(".")) return node.classList.contains(selector.slice(1));
    return node.tagName.toLowerCase() === selector.toLowerCase();
  };
  const find = (node, selector) => {
    const token = selector.trim().split(/\s+/).at(-1);
    return descendants(node).find((child) => matches(child, token));
  };
  const make = (tag) => {
    const listeners = new Map();
    const node = {
      tagName: String(tag).toUpperCase(), children: [], parentNode: null, parentElement: null,
      dataset: {}, attributes: new Map(), className: "", hidden: false, disabled: false,
      id: "", value: "", type: "", placeholder: "", textContent: "", title: "",
      selectionStart: 0, selectionEnd: 0, style: {
        setProperty(name, value) { this[name] = value; },
        removeProperty(name) { delete this[name]; },
      },
      classList: {
        add(...names) { for (const name of names) node.className = `${node.className} ${name}`.trim(); },
        remove(...names) { node.className = node.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
        contains(name) { return node.className.split(/\s+/).includes(name); },
        toggle(name, force) {
          const wanted = force === undefined ? !this.contains(name) : force;
          wanted ? this.add(name) : this.remove(name);
          return wanted;
        },
      },
      append(...children) { children.forEach((child) => attach(node, child)); },
      prepend(...children) { children.reverse().forEach((child) => attach(node, child, 0)); },
      appendChild(child) { attach(node, child); return child; },
      insertBefore(child, sibling) { const index = node.children.indexOf(sibling); attach(node, child, index < 0 ? node.children.length : index); return child; },
      removeChild(child) { const index = node.children.indexOf(child); if (index >= 0) node.children.splice(index, 1); child.parentNode = null; child.parentElement = null; return child; },
      replaceChildren(...children) { for (const child of node.children) { child.parentNode = null; child.parentElement = null; } node.children = []; children.forEach((child) => attach(node, child)); },
      remove() { node.parentNode?.removeChild?.(node); },
      addEventListener(type, listener) { const list = listeners.get(type) ?? []; list.push(listener); listeners.set(type, list); },
      removeEventListener(type, listener) { listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== listener)); },
      dispatchEvent(event) { for (const listener of listeners.get(event.type) ?? []) listener.call(node, event); return true; },
      focus() { activeElement = node; if (documentRef) documentRef.activeElement = node; },
      blur() { if (activeElement === node) activeElement = undefined; },
      setSelectionRange(start, end) { node.selectionStart = start; node.selectionEnd = end; },
      setAttribute(name, value) {
        const text = String(value); node.attributes.set(name, text);
        if (name === "id") node.id = text;
        if (name === "class") node.className = text;
        if (name.startsWith("data-")) node.dataset[name.slice(5).replace(/-([a-z])/g, (_m, letter) => letter.toUpperCase())] = text;
      },
      getAttribute(name) { return node.attributes.get(name) ?? (name === "id" ? node.id || null : name === "class" ? node.className || null : null); },
      removeAttribute(name) { node.attributes.delete(name); if (name === "id") node.id = ""; },
      querySelector(selector) { return find(node, selector); },
      querySelectorAll(selector) { return descendants(node).filter((child) => matches(child, selector.trim().split(/\s+/).at(-1))); },
      closest() { return undefined; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }; },
    };
    return node;
  };
  const body = make("body");
  const document = {
    body, documentElement: make("html"), head: make("head"), activeElement: undefined,
    createElement: make, createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (text) => ({ textContent: text }), createDocumentFragment: () => make("fragment"),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) {
        node = make(id.endsWith("-form") ? "form" : "div"); node.id = id; byId.set(id, node);
        if (id === "login-form" || id === "create-form") { const submit = make("button"); submit.type = "submit"; node.append(submit); }
      }
      return node;
    },
    querySelector(selector) { return find(body, selector); }, querySelectorAll(selector) { return body.querySelectorAll(selector); },
    addEventListener() {}, removeEventListener() {},
  };
  documentRef = document;
  return document;
}

test("quest search keeps focus and the complete query across sequential input redraws", async () => {
  const previous = {
    document: globalThis.document, location: globalThis.location, window: globalThis.window,
    localStorage: globalThis.localStorage, matchMedia: globalThis.matchMedia,
    requestAnimationFrame: globalThis.requestAnimationFrame, HTMLElement: globalThis.HTMLElement,
  };
  const document = questDom();
  globalThis.document = document;
  globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 720, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.matchMedia = globalThis.window.matchMedia;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.HTMLElement = class {};
  try {
    const { game } = await import("../dist/code/browser/game/Context.js");
    const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
    const { clearQuestLog, toggleQuestLog } = await import("../dist/code/browser/ui/QuestLog.js");
    usePanelHost({ viewport: document.body, attach() {}, detach() {} });
    game.world = undefined;
    toggleQuestLog();
    let search = document.body.querySelector(".quest-log-toolbar input[type=\"search\"]");
    assert.ok(search);
    search.value = "к";
    search.setSelectionRange(1, 1);
    search.dispatchEvent({ type: "input" });
    search = document.body.querySelector(".quest-log-toolbar input[type=\"search\"]");
    assert.equal(search.value, "к");
    assert.equal(document.activeElement, search, "the first redraw must keep keyboard focus");

    search.value = "кр";
    search.setSelectionRange(2, 2);
    search.dispatchEvent({ type: "input" });
    const finalSearch = document.body.querySelector(".quest-log-toolbar input[type=\"search\"]");
    assert.equal(finalSearch.value, "кр", "the second character must append to the retained query");
    assert.equal(document.activeElement, finalSearch);
    assert.equal(finalSearch.selectionStart, 2);
    clearQuestLog();
  } finally {
    globalThis.document = previous.document; globalThis.location = previous.location;
    globalThis.window = previous.window; globalThis.localStorage = previous.localStorage;
    globalThis.matchMedia = previous.matchMedia; globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    globalThis.HTMLElement = previous.HTMLElement;
  }
});

test("quest targets render metadata names and item objectives use an inventory slot", async () => {
  const previous = {
    document: globalThis.document, location: globalThis.location, window: globalThis.window,
    localStorage: globalThis.localStorage, matchMedia: globalThis.matchMedia,
    requestAnimationFrame: globalThis.requestAnimationFrame, HTMLElement: globalThis.HTMLElement,
  };
  const document = questDom();
  globalThis.document = document;
  globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 720, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.matchMedia = globalThis.window.matchMedia;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.HTMLElement = class {};
  try {
    const { game } = await import("../dist/code/browser/game/Context.js");
    const { questObjectiveRows } = await import("../dist/code/browser/ui/QuestLog.js");
    const previousGame = {
      world: game.world, itemMetadata: game.itemMetadata, creatureMetadata: game.creatureMetadata,
      gatewayOrigin: game.gatewayOrigin,
    };
    game.world = {
      itemTemplates: new Map(), creatureTemplates: new Map(),
      gameObjectTemplates: new Map([[1617, { name: "Сундук Братства" }]]),
    };
    game.itemMetadata = {
      get: (id) => id === 769 ? { entry: 769, name: "Кусок мяса вепря", quality: 2 } : undefined,
      iconUrl: () => "/icons/item-769.png",
    };
    game.creatureMetadata = {
      get: (id) => id === 299 ? { entry: 299, name: "Лесной волк", type: 1, family: 1, rank: 0 } : undefined,
    };
    game.gatewayOrigin = undefined;
    try {
      const rows = questObjectiveRows({
        slot: 0, questId: 62, template: undefined, complete: false, failed: false, timer: 0,
        objectives: [
          { kind: "item", id: 769, text: "", have: 5, need: 8, done: false },
          { kind: "creature", id: 299, text: "", have: 3, need: 10, done: false },
          { kind: "gameObject", id: 1617, text: "", have: 0, need: 1, done: false },
        ],
      });

      const itemSlot = rows[0].querySelector(".quest-objective-item");
      assert.ok(itemSlot?.classList.contains("ui-slot"));
      assert.equal(itemSlot.getAttribute("role"), "img");
      assert.equal(itemSlot.querySelector("img")?.src, "/icons/item-769.png");
      assert.equal(itemSlot.querySelector(".ui-slot-count")?.textContent, "8");
      assert.equal(rows[0].querySelector(".ui-line-label")?.textContent, "Кусок мяса вепря");
      assert.equal(rows[0].querySelector(".ui-line")?.children[1]?.textContent, "5 / 8");

      assert.ok(rows[1].querySelector(".quest-objective-icon"));
      assert.equal(rows[1].querySelector(".ui-line-label")?.textContent, "Лесной волк");
      assert.ok(rows[2].querySelector(".quest-objective-marker"));
      assert.equal(rows[2].querySelector(".ui-line-label")?.textContent, "Сундук Братства");
    } finally {
      game.world = previousGame.world;
      game.itemMetadata = previousGame.itemMetadata;
      game.creatureMetadata = previousGame.creatureMetadata;
      game.gatewayOrigin = previousGame.gatewayOrigin;
    }
  } finally {
    globalThis.document = previous.document; globalThis.location = previous.location;
    globalThis.window = previous.window; globalThis.localStorage = previous.localStorage;
    globalThis.matchMedia = previous.matchMedia; globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    globalThis.HTMLElement = previous.HTMLElement;
  }
});

test("native quest targets re-prime cleared metadata caches and replace stable ID fallbacks", async () => {
  const previous = {
    document: globalThis.document, location: globalThis.location, window: globalThis.window,
    localStorage: globalThis.localStorage, matchMedia: globalThis.matchMedia,
    requestAnimationFrame: globalThis.requestAnimationFrame, HTMLElement: globalThis.HTMLElement,
  };
  const document = questDom();
  globalThis.document = document;
  globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 720, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.matchMedia = globalThis.window.matchMedia;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.HTMLElement = class {};
  try {
    const { game } = await import("../dist/code/browser/game/Context.js");
    const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
    const { bindQuestLogStore, clearQuestLog, questObjectiveRows } = await import("../dist/code/browser/ui/QuestLog.js");
    const previousGame = {
      world: game.world, itemMetadata: game.itemMetadata, creatureMetadata: game.creatureMetadata,
      gatewayOrigin: game.gatewayOrigin,
    };
    const itemInfo = new Map();
    const creatureInfo = new Map();
    const gameObjectInfo = new Map();
    const itemLoads = [];
    const creatureLoads = [];
    const gameObjectLoads = [];
    let cacheListener;
    const questId = 62;
    const selfGuid = 1n;
    const questBase = UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset;
    const world = {
      state: { selfGuid, objects: new Map([[selfGuid, {
        guid: selfGuid, typeId: 4, fields: new Map([[questBase, questId]]),
      }]]) },
      questTemplates: new Map([[questId, {
        title: "Волки у ворот",
        objectives: [
          { entry: 299, count: 10, gameObject: false, itemDrop: 0, text: "" },
          { entry: 1617, count: 1, gameObject: true, itemDrop: 0, text: "" },
        ],
        itemObjectives: [{ itemId: 769, count: 8 }],
      }]]),
      itemTemplates: new Map(), creatureTemplates: new Map(), gameObjectTemplates: gameObjectInfo,
      events: {
        on(type, listener) {
          if (type === "QUERY_CACHE_CHANGED") cacheListener = listener;
          return () => { if (cacheListener === listener) cacheListener = undefined; };
        },
      },
      gameObjectTemplate(id) {
        gameObjectLoads.push(id);
        gameObjectInfo.set(id, { name: "Сундук Братства" });
      },
    };
    game.world = world;
    game.itemMetadata = {
      get: (id) => itemInfo.get(id),
      iconUrl: () => "/icons/item-769.png",
      async load(ids) {
        itemLoads.push([...ids]);
        itemInfo.set(769, { entry: 769, name: "Кусок мяса вепря", quality: 2 });
        return true;
      },
    };
    game.creatureMetadata = {
      get: (id) => creatureInfo.get(id),
      async load(ids) {
        creatureLoads.push([...ids]);
        creatureInfo.set(299, { entry: 299, name: "Лесной волк", type: 1, family: 1, rank: 0 });
        return true;
      },
    };
    game.gatewayOrigin = undefined;
    const view = {
      slot: 0, questId, template: undefined, complete: false, failed: false, timer: 0,
      objectives: [
        { kind: "item", id: 769, text: "", have: 0, need: 8, done: false },
        { kind: "creature", id: 299, text: "", have: 0, need: 10, done: false },
        { kind: "gameObject", id: 1617, text: "", have: 0, need: 1, done: false },
      ],
    };
    try {
      assert.deepEqual(
        questObjectiveRows(view).map((row) => row.querySelector(".ui-line-label")?.textContent),
        ["Предмет #769", "Существо #299", "Объект #1617"],
      );

      bindQuestLogStore(undefined, world);
      cacheListener?.({ kind: "cleared", id: 0 });
      await Promise.resolve();
      await Promise.resolve();

      assert.deepEqual(itemLoads, [[769]]);
      assert.deepEqual(creatureLoads, [[299]]);
      assert.deepEqual(gameObjectLoads, [1617]);
      assert.deepEqual(
        questObjectiveRows(view).map((row) => row.querySelector(".ui-line-label")?.textContent),
        ["Кусок мяса вепря", "Лесной волк", "Сундук Братства"],
      );
    } finally {
      clearQuestLog();
      game.world = previousGame.world;
      game.itemMetadata = previousGame.itemMetadata;
      game.creatureMetadata = previousGame.creatureMetadata;
      game.gatewayOrigin = previousGame.gatewayOrigin;
    }
  } finally {
    globalThis.document = previous.document; globalThis.location = previous.location;
    globalThis.window = previous.window; globalThis.localStorage = previous.localStorage;
    globalThis.matchMedia = previous.matchMedia; globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    globalThis.HTMLElement = previous.HTMLElement;
  }
});
