import assert from "node:assert/strict";
import test from "node:test";

// LiveWorldSeam's achievement wiring (FrameXmlAchievementLive.ts): the model reads WorldClient's
// achievement maps and events, the seam tick coalesces CRITERIA_UPDATE, the comparison sends the
// inspect query, and the chat emitter writes an achievement line's `$a` link and `$g` gender — after
// waiting once for the catalog — before stock ChatFrame formats it.

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FrameXmlAchievementCatalog } = await import("../dist/code/browser/framexml/FrameXmlAchievementCatalog.js");
const { FRAMEXML_ACHIEVEMENT_CANNED_CATALOG } = await import("../dist/code/browser/framexml/FrameXmlAchievementCannedData.js");
const { CHAT_MSG_ACHIEVEMENT, CHAT_MSG_GUILD_ACHIEVEMENT } = await import("../dist/code/world/ChatProtocol.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    let listeners = this.#listeners.get(name);
    if (!listeners) this.#listeners.set(name, listeners = new Set());
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  emit(name, payload) { for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload); }
  listenerCount(name) { return this.#listeners.get(name)?.size ?? 0; }
}

const SELF = 0x10n;
const EARNER = 0x22n;

function fixture() {
  const events = new FakeEvents();
  // A female earner in view: UNIT_FIELD_BYTES_0's third byte is the gender (Fields.ts BYTES_0_GENDER).
  const earner = { guid: EARNER, typeId: 4, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 1 << 16]]) };
  const queries = [];
  const world = {
    state: { selfGuid: SELF, objects: new Map([[EARNER, earner]]) },
    targetGuid: undefined, chatLog: [], channels: new Map(), events,
    casts: new Map(), actionButtons: [], aurasFor: () => [], cooldownRemaining: () => 0,
    cooldownState: () => ({ start: 0, duration: 0, enable: 0 }), names: new Map(), creatureTemplates: new Map(),
    worldStateContext: undefined, mapId: undefined, selfName: "Игрок",
    displayName: (guid) => (guid === EARNER ? "Сильвана" : `0x${guid.toString(16)}`),
    achievements: new Map([[7, (26 << 24) | (8 << 20) | (2 << 14)]]),
    criteria: new Map([[36, 25n]]),
    inspectAchievements: undefined,
    queryInspectAchievements: (guid) => queries.push(guid),
  };
  const fired = [];
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 100 };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined, monotonic: () => 1000,
    globalCooldownUntil: () => 0, castSpell: () => {},
  });
  let release;
  const catalog = FrameXmlAchievementCatalog.fromJson(JSON.parse(JSON.stringify(FRAMEXML_ACHIEVEMENT_CANNED_CATALOG)));
  seam.achievement.catalogSource = { load: () => new Promise((resolve) => { release = () => resolve(catalog); }) };
  return { seam, world, events, fired, pump, queries, release: () => release?.() };
}

const line = (overrides) => ({
  type: CHAT_MSG_ACHIEVEMENT, language: 0, senderGuid: EARNER, senderName: "", receiverGuid: EARNER, receiverName: "",
  channel: "", text: "%s $gзаслужил:заслужила; достижение $a!", tag: 0, achievementId: 7, ...overrides,
});

test("the live model reads the world's maps and answers its events through the seam", async () => {
  const { seam, world, events, fired, pump, queries, release } = fixture();
  seam.attach(pump);
  try {
    const loading = seam.achievement.loadCatalog();
    release();
    await loading;
    assert.deepEqual(call("GetAchievementInfo", seam, 7).slice(0, 7), [7, "20-й уровень", 10, true, 9, 3, 26]);
    assert.deepEqual(call("HasCompletedAnyAchievement", seam), [true]);
    // An achievement link's player, for its tooltip: this one, or a name from WorldClient's name cache.
    world.names.set(EARNER, "Сильвана");
    assert.equal(seam.achievement.linkPlayer("0000000000000010"), true);
    assert.equal(seam.achievement.linkPlayer("0000000000000022"), "Сильвана");
    fired.length = 0;
    events.emit("ACHIEVEMENT_STATE_CHANGED", { kind: "list" });
    assert.deepEqual(fired.filter(([event]) => event.includes("ACHIEVEMENT")), [["RECEIVED_ACHIEVEMENT_LIST"]]);
    seam.achievement.owned = true;
    fired.length = 0;
    world.criteria.set(36, 26n);
    events.emit("ACHIEVEMENT_STATE_CHANGED", { kind: "criteria", criteriaId: 36, timeElapsed: 0 });
    world.criteria.set(36, 27n);
    events.emit("ACHIEVEMENT_STATE_CHANGED", { kind: "criteria", criteriaId: 36, timeElapsed: 0 });
    assert.equal(fired.some(([event]) => event === "CRITERIA_UPDATE"), false, "not per packet");
    // The seam's own frame tick flushes it.
    seam.tick(101);
    assert.deepEqual(fired.filter(([event]) => event === "CRITERIA_UPDATE"), [["CRITERIA_UPDATE"]]);
    events.emit("ACHIEVEMENT_EARNED", { achievementId: 8, mine: true });
    assert.deepEqual(fired.at(-1), ["ACHIEVEMENT_EARNED", 8]);
    // «Сравнить достижения» on the target: UnitGUID's text back to the guid the query sends.
    world.targetGuid = EARNER;
    call("SetAchievementComparisonUnit", seam, "target");
    assert.deepEqual(queries, [EARNER]);
    world.inspectAchievements = { guid: EARNER, completed: new Map([[6, 0], [7, 0]]), criteria: new Map() };
    events.emit("ACHIEVEMENT_STATE_CHANGED", { kind: "inspect", guid: EARNER });
    assert.deepEqual(fired.at(-1), ["INSPECT_ACHIEVEMENT_READY"]);
    assert.deepEqual(call("GetComparisonAchievementPoints", seam), [20]);
    // The Alliance/Horde filter follows UnitFactionGroup("player"), unknown here: both faction rows are listed.
    assert.equal(call("GetCategoryNumAchievements", seam, 92, true)[0], 18);
  } finally {
    seam.detach();
  }
  assert.equal(events.listenerCount("ACHIEVEMENT_STATE_CHANGED"), 0, "detach drops the model's subscriptions");
  assert.equal(events.listenerCount("ACHIEVEMENT_EARNED"), 0);
});

test("an achievement chat line waits for the catalog once, then reaches stock with its link and gender", async () => {
  const { seam, events, fired, pump, release } = fixture();
  seam.attach(pump);
  try {
    fired.length = 0;
    events.emit("CHAT_MESSAGE", line());
    assert.deepEqual(fired, [], "held: `$a` needs the catalog's name");
    release();
    await seam.achievement.loadCatalog();
    assert.equal(fired.length, 1);
    const [event, text, sender] = fired[0];
    assert.equal(event, "CHAT_MSG_ACHIEVEMENT");
    assert.equal(sender, "Сильвана");
    assert.match(text, /^%s заслужила достижение \|cffffff00\|Hachievement:7:0000000000000022:1:\d+:\d+:\d+:4294967295:4294967295:4294967295:4294967295\|h\[20-й уровень\]\|h\|r!$/,
      "the earner in view is female; the link names her, dated now");
    // Loaded now: a guild line goes straight through, in order with the next one.
    events.emit("CHAT_MESSAGE", line({ type: CHAT_MSG_GUILD_ACHIEVEMENT, achievementId: 8 }));
    assert.equal(fired.length, 2);
    assert.equal(fired[1][0], "CHAT_MSG_GUILD_ACHIEVEMENT");
    assert.match(fired[1][1], /\[30-й уровень\]/);
  } finally {
    seam.detach();
  }
});

test("a line held for the catalog is dropped if the seam was detached meanwhile", async () => {
  const { seam, events, fired, pump, release } = fixture();
  seam.attach(pump);
  events.emit("CHAT_MESSAGE", line());
  seam.detach();
  fired.length = 0;
  release();
  await seam.achievement.loadCatalog();
  assert.deepEqual(fired, [], "no line into a torn-down VM");
});
