import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 6 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-live-talent-seam.test.mjs
{
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

class FakeEvents {
  #listeners = new Map();

  on(name, listener) {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }

  emit(name, payload) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }
}

test("LiveWorldSeam emits separate stock talent updates for player and pet packets", () => {
  const events = new FakeEvents();
  const world = {
    state: { selfGuid: undefined, objects: new Map() },
    events,
    casts: new Map(),
    actionButtons: [],
    cooldownRemaining: () => 0,
  };
  const fired = [];
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: () => undefined,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 100 };
  seam.attach(pump);
  fired.length = 0;

  events.emit("TALENTS_CHANGED", { pet: true });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.petTalentsChanged]],
    "pet talent packets produce the stock pet edge, not a player update");
  events.emit("TALENTS_CHANGED", { pet: false });
  events.emit("TALENTS_CHANGED", { pet: false });
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.petTalentsChanged],
    [FRAMEXML_SEAM_EVENTS.talentsChanged],
    [FRAMEXML_SEAM_EVENTS.talentsChanged],
  ], "each authoritative player packet produces exactly one transition");

  seam.detach();
  events.emit("TALENTS_CHANGED", { pet: false });
  assert.equal(fired.length, 3, "detached worlds no longer publish stale talent transitions");
});

test("stock pet LearnTalent sends one core pet preview rank and waits for packet state", () => {
  const sent = [];
  const world = {
    state: { selfGuid: undefined, objects: new Map() },
    petSpells: { guid: 0x42n, creatureFamily: 1 },
    petTalents: { pet: true, unspentPoints: 1, activeSpec: 0,
      specs: [{ talents: [{ talentId: 30, rank: 3 }], glyphs: [] }] },
    learnPetTalents: (guid, talents) => sent.push([guid, talents]),
  };
  const metadata = {
    ready: true,
    revision: 1,
    tabsForClass: () => [],
    petTalentMask: (family) => family === 1 ? 1 : 0,
    petTabs: (mask) => mask === 1 ? [{ id: 200, name: "Ferocity", orderIndex: 0,
      classMask: 0, petTalentMask: 1 }] : [],
    talentsIn: (tabId) => tabId === 200 ? [
      { id: 30, tabId, tier: 0, column: 0, ranks: [3001, 3002, 3003], prerequisites: [] },
      { id: 31, tabId, tier: 1, column: 1, ranks: [3101], prerequisites: [] },
    ] : [],
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: () => undefined,
    talentMetadata: () => metadata,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  assert.equal(seam.talentSnapshot(true).groups[0].tabs[0].talents[1].meetsPrereq, true);
  seam.learnTalent(1, 2, true, 1);
  assert.deepEqual(sent, [[0x42n, [{ talentId: 31, rank: 1 }]]]);
  assert.equal(seam.talentSnapshot(true).groups[0].tabs[0].talents[1].rank, 0,
    "a click cannot spend a point until SMSG_TALENTS_INFO arrives");
  seam.learnTalent(1, 2, true, 2);
  seam.learnTalent(1, 1, true, 1);
  assert.equal(sent.length, 1, "wrong group and maxed rank are refused before transport");

  world.petSpells = { guid: 0x43n, creatureFamily: 1 };
  assert.equal(seam.talentSnapshot(true), undefined,
    "a replacement pet cannot inherit the previous pet's untagged rank packet");
  seam.learnTalent(1, 2, true, 1);
  assert.equal(sent.length, 1, "stale ranks cannot train a new pet");
  world.petTalents = { pet: true, unspentPoints: 2, activeSpec: 0,
    specs: [{ talents: [{ talentId: 30, rank: 1 }], glyphs: [] }] };
  assert.equal(seam.talentSnapshot(true).groups[0].tabs[0].talents[0].rank, 1);
});
}

// ── framexml-talent-controller.test.mjs
{
const {
  closeFrameXmlTalent,
  frameXmlTalentOpen,
  publishFrameXmlTalent,
  toggleFrameXmlTalent,
} = await import("../dist/code/browser/framexml/FrameXmlTalentController.js");

function owner() {
  let open = false;
  const calls = [];
  return {
    calls,
    isOpen: () => open,
    show: () => { open = true; calls.push("show"); },
    hide: () => { open = false; calls.push("hide"); },
    dispose: () => { calls.push("dispose"); },
  };
}

test("talent owner routes toggle and Escape, then cleans up idempotently", () => {
  const first = owner();
  const cleanup = publishFrameXmlTalent(first);
  assert.equal(frameXmlTalentOpen(), false);
  assert.equal(toggleFrameXmlTalent(), true);
  assert.deepEqual(first.calls, ["show"]);
  assert.equal(frameXmlTalentOpen(), true);
  assert.equal(closeFrameXmlTalent(), true);
  assert.deepEqual(first.calls, ["show", "hide"]);
  cleanup();
  cleanup();
  assert.deepEqual(first.calls, ["show", "hide", "hide", "dispose"]);
  assert.equal(frameXmlTalentOpen(), false);
});

test("stale talent cleanup cannot hide or clear a newer owner", () => {
  const first = owner();
  const cleanupFirst = publishFrameXmlTalent(first);
  const second = owner();
  const cleanupSecond = publishFrameXmlTalent(second);
  assert.deepEqual(first.calls, ["hide", "dispose"]);
  cleanupFirst();
  assert.deepEqual(second.calls, []);
  assert.equal(toggleFrameXmlTalent(), true);
  assert.deepEqual(second.calls, ["show"]);
  cleanupSecond();
  assert.deepEqual(second.calls, ["show", "hide", "dispose"]);
  assert.equal(frameXmlTalentOpen(), false);
});
}

// ── framexml-talent-group-seam.test.mjs
{
// Plan item 1.07: SetActiveTalentGroup casts the activation spell and ACTIVE_TALENT_GROUP_CHANGED
// follows the talent packet (FrameXmlTalentGroup.ts), as the original client does (Wow.exe 0x5c5e70,
// table 0xad05e8; SMSG_TALENTS_INFO handler 0x5c9e50).

const { FrameXmlTalentGroupModel, FRAMEXML_TALENT_GROUP_BINDINGS } =
  await import("../dist/code/browser/framexml/FrameXmlTalentGroup.js");
const { TALENT_SPEC_ACTIVATION_SPELLS } = await import("../dist/code/world/TalentSpecSpells.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

function modelFixture(state) {
  const casts = [];
  const fired = [];
  const talents = { current: state };
  const model = new FrameXmlTalentGroupModel({ talents: () => talents.current, castSpell: (id) => casts.push(id) });
  model.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  const call = (...args) => [...FRAMEXML_TALENT_GROUP_BINDINGS.SetActiveTalentGroup({ talentGroup: model }, args)];
  return { model, casts, fired, talents, call };
}

test("the activation spells are the client's table, in group order", () => {
  assert.deepEqual([...TALENT_SPEC_ACTIVATION_SPELLS], [63645, 63644]);
});

test("SetActiveTalentGroup casts the group's spell only for another existing group below 3", () => {
  const { casts, call } = modelFixture({ activeSpec: 0, specCount: 2 });
  assert.deepEqual(call(2), []);
  assert.deepEqual(casts, [63644], "group 2 casts 63644");
  call(1);
  assert.deepEqual(casts, [63644], "the active group casts nothing");
  call("2");
  call(1.6);
  assert.deepEqual(casts, [63644, 63644, 63644], "a numeric string and 1.6 round to group 2");
  for (const refused of [0, -1, 3, 1.4, "x", undefined, Number.NaN]) call(refused);
  assert.equal(casts.length, 3, "outside 1..count, or not a number: nothing");
});

test("with one group or before the first packet nothing is cast", () => {
  const one = modelFixture({ activeSpec: 0, specCount: 1 });
  one.call(2);
  assert.deepEqual(one.casts, []);
  const none = modelFixture(undefined);
  none.call(1);
  none.call(2);
  assert.deepEqual(none.casts, []);
  const second = modelFixture({ activeSpec: 1, specCount: 2 });
  second.call(1);
  second.call(2);
  assert.deepEqual(second.casts, [63645], "from the second group, group 1 casts 63645");
});

test("ACTIVE_TALENT_GROUP_CHANGED carries the new and previous 1-based group once per move", () => {
  const { model, fired, talents } = modelFixture(undefined);
  talents.current = { activeSpec: 0, specCount: 2 };
  model.talentsChanged();
  assert.deepEqual(fired, [], "a first packet with the first group active does not move it");
  talents.current = { activeSpec: 1, specCount: 2 };
  model.talentsChanged();
  model.talentsChanged();
  assert.deepEqual(fired, [["ACTIVE_TALENT_GROUP_CHANGED", 2, 1]]);
  talents.current = { activeSpec: 0, specCount: 2 };
  model.talentsChanged();
  assert.deepEqual(fired.at(-1), ["ACTIVE_TALENT_GROUP_CHANGED", 1, 2]);

  const login = modelFixture(undefined);
  login.talents.current = { activeSpec: 1, specCount: 2 };
  login.model.talentsChanged();
  assert.deepEqual(login.fired, [["ACTIVE_TALENT_GROUP_CHANGED", 2, 0]],
    "the session's first packet reports 0 as the previous group");
});

test("a mount after the packet starts from the known groups", () => {
  const { model, fired, talents } = modelFixture({ activeSpec: 1, specCount: 2 });
  model.talentsChanged();
  assert.deepEqual(fired, []);
  talents.current = { activeSpec: 0, specCount: 2 };
  model.talentsChanged();
  assert.deepEqual(fired, [["ACTIVE_TALENT_GROUP_CHANGED", 1, 2]]);
});

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }
  emit(name, payload) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }
}

test("the live seam casts through its host and fires the edge after PLAYER_TALENT_UPDATE", () => {
  const events = new FakeEvents();
  const talents = (activeSpec) => ({ pet: false, unspentPoints: 0, activeSpec,
    specs: [{ talents: [], glyphs: [] }, { talents: [], glyphs: [] }] });
  const world = {
    state: { selfGuid: undefined, objects: new Map() },
    events,
    casts: new Map(),
    actionButtons: [],
    cooldownRemaining: () => 0,
    talents: talents(0),
  };
  const casts = [];
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: (id) => casts.push(id),
  });
  const fired = [];
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 100 });
  fired.length = 0;

  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.SetActiveTalentGroup(seam, [2])], []);
  assert.deepEqual(casts, [63644]);
  FRAMEXML_SEAM_BINDINGS.SetActiveTalentGroup(seam, [1]);
  assert.deepEqual(casts, [63644], "the active group is not cast again");

  world.talents = talents(1);
  events.emit("TALENTS_CHANGED", { pet: false });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.talentsChanged], ["ACTIVE_TALENT_GROUP_CHANGED", 2, 1]]);
  events.emit("TALENTS_CHANGED", { pet: true });
  events.emit("TALENTS_CHANGED", { pet: false });
  assert.equal(fired.filter(([event]) => event === "ACTIVE_TALENT_GROUP_CHANGED").length, 1,
    "a pet packet or an unchanged group adds no edge");
  seam.detach();
});

test("the canned seam records the cast of its two-group player", () => {
  const seam = new CannedWorldSeam();
  seam.setTalentGroups(2, 1);
  FRAMEXML_SEAM_BINDINGS.SetActiveTalentGroup(seam, [2]);
  assert.deepEqual(seam.talentGroupCasts, [63644]);
});
}

// ── framexml-talent-preview-seam.test.mjs
{
// Plan item 3.33: the stock talent preview as Wow.exe keeps it — AddPreviewTalentPoints (0x5c9590,
// rules 0x5c73d0), GetGroupPreviewTalentPointsSpent (0x5c6420), GetPreviewTalentPointsSpent (0x5c63b0,
// always 0), Reset(Group)PreviewTalentPoints (0x5c7200/0x5c7130), LearnPreviewTalents (0x5c6a10,
// CMSG_LEARN_PREVIEW_TALENTS 0x4C1) and the preview values of GetTalentInfo/TabInfo/Prereqs.

const {
  FrameXmlTalentPreviewModel, FRAMEXML_TALENT_PREVIEW_BINDINGS,
  PREVIEW_TALENT_POINTS_CHANGED, PREVIEW_PET_TALENT_POINTS_CHANGED,
} = await import("../dist/code/browser/framexml/FrameXmlTalentPreview.js");
const { buildLearnPreviewTalents } = await import("../dist/code/world/CharacterProgressProtocol.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

const cell = (index, id, tier, column, maxRank, rank = 0, prerequisites = []) => ({
  index, id, name: `t${id}`, iconTexture: undefined, iconId: undefined, tier, column, rank, maxRank,
  isExceptional: undefined, meetsPrereq: true, previewRank: undefined, meetsPreviewPrereq: undefined,
  prerequisites: prerequisites.map(([talentId, requiredRank, tierOf, columnOf]) => ({
    talentId, tier: tierOf, column: columnOf, requiredRank, meetsPrereq: false, meetsPreviewPrereq: undefined,
  })),
  link: undefined,
});

/** One tab: A (tier 1, 2 ranks), B (tier 1, 3 ranks), C (tier 2, 1 rank, needs A at 2); a second tab D. */
function snapshot({ unspent = 10, ranks = {} } = {}) {
  const talents = [
    cell(1, 101, 1, 1, 2, ranks[101] ?? 0),
    cell(2, 102, 1, 2, 3, ranks[102] ?? 0),
    cell(3, 103, 2, 1, 1, ranks[103] ?? 0, [[101, 2, 1, 1]]),
    cell(4, 104, 1, 3, 5, ranks[104] ?? 0),
  ];
  const spent = talents.reduce((sum, t) => sum + t.rank, 0);
  return {
    classId: 8, activeTalentGroup: 1, activeSpec: 0, numTalentGroups: 1, unspentPoints: unspent,
    groups: [{
      group: 1, spec: 0, active: true, unspentPoints: unspent,
      tabs: [
        { index: 1, id: 10, name: "Огонь", iconId: undefined, iconTexture: undefined, background: undefined,
          pointsSpent: spent, previewPointsSpent: 0, talents },
        { index: 2, id: 11, name: "Лёд", iconId: undefined, iconTexture: undefined, background: undefined,
          pointsSpent: 0, previewPointsSpent: 0, talents: [cell(1, 201, 1, 1, 5)] },
      ],
    }],
  };
}

function fixture(options) {
  const world = { base: snapshot(options), packet: {}, learned: [] };
  const fired = [];
  const model = new FrameXmlTalentPreviewModel({
    snapshot: () => world.base,
    packet: () => world.packet,
    learn: (pet, talents) => world.learned.push([pet, talents]),
  });
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  const host = { talentPreview: model };
  const call = (name, ...args) => [...FRAMEXML_TALENT_PREVIEW_BINDINGS[name](host, args)];
  const info = (tab, index) => {
    const found = model.apply(false, world.base).groups[0].tabs[tab - 1].talents[index - 1];
    return [found.rank, found.previewRank, found.meetsPreviewPrereq];
  };
  const tabPreview = (tab) => model.apply(false, world.base).groups[0].tabs[tab - 1].previewPointsSpent;
  return { world, fired, model, call, info, tabPreview };
}

test("the preview names are seam bindings; no model answers 0 and does nothing", () => {
  for (const name of Object.keys(FRAMEXML_TALENT_PREVIEW_BINDINGS)) {
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], FRAMEXML_TALENT_PREVIEW_BINDINGS[name], name);
  }
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.GetGroupPreviewTalentPointsSpent({}, [])], [0]);
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.AddPreviewTalentPoints({}, [1, 1, 1])], []);
});

test("a point previewed: preview rank, tab and group totals, one event with index, tab, group, points", () => {
  const { call, fired, info, tabPreview } = fixture();
  assert.deepEqual(info(1, 1), [0, 0, true], "no preview: the preview rank is the learned one");
  call("AddPreviewTalentPoints", 1, 1, 1, false);
  assert.deepEqual(info(1, 1), [0, 1, true]);
  assert.equal(tabPreview(1), 1);
  assert.deepEqual(call("GetGroupPreviewTalentPointsSpent", false), [1]);
  assert.deepEqual(call("GetGroupPreviewTalentPointsSpent", false, 1), [1]);
  assert.deepEqual(fired, [[PREVIEW_TALENT_POINTS_CHANGED, 1, 1, 1, 1]]);
  assert.deepEqual(call("GetPreviewTalentPointsSpent", 1, false), [0], "the client's own answer is always 0");
});

test("clamped to the highest rank; no event when nothing moved; zero points is nothing", () => {
  const { call, fired, info } = fixture();
  call("AddPreviewTalentPoints", 1, 1, 1);
  call("AddPreviewTalentPoints", 1, 1, 1);
  call("AddPreviewTalentPoints", 1, 1, 1);
  assert.deepEqual(info(1, 1), [0, 2, true]);
  assert.equal(fired.length, 2);
  call("AddPreviewTalentPoints", 1, 1, 0);
  call("AddPreviewTalentPoints", 1, 1, -5);
  assert.deepEqual(info(1, 1), [0, 0, true], "taken back to the learned rank, not below");
  assert.deepEqual(fired.at(-1), [PREVIEW_TALENT_POINTS_CHANGED, 1, 1, 1, -2]);
});

test("refused without free points, below the tier's points, or without the prerequisite's preview", () => {
  const poor = fixture({ unspent: 2 });
  poor.call("AddPreviewTalentPoints", 1, 2, 1);
  poor.call("AddPreviewTalentPoints", 1, 2, 1);
  poor.call("AddPreviewTalentPoints", 1, 2, 1);
  assert.deepEqual(poor.info(1, 2), [0, 2, true], "two points, two ranks");
  const { call, info, fired } = fixture();
  call("AddPreviewTalentPoints", 1, 3, 1);
  assert.deepEqual(info(1, 3), [0, 0, false], "tier 2 needs five points in the tab");
  call("AddPreviewTalentPoints", 1, 1, 1); call("AddPreviewTalentPoints", 1, 1, 1);
  call("AddPreviewTalentPoints", 1, 3, 1);
  assert.deepEqual(info(1, 3), [0, 0, false], "A at 2 meets the prerequisite, but two points do not open tier 2");
  call("AddPreviewTalentPoints", 1, 1, -2);
  fired.length = 0;
  call("AddPreviewTalentPoints", 1, 2, 1); call("AddPreviewTalentPoints", 1, 2, 1); call("AddPreviewTalentPoints", 1, 2, 1);
  assert.deepEqual(fired[0], [PREVIEW_TALENT_POINTS_CHANGED, 2, 1, 1, 1], "talentIndex, tabIndex, groupIndex, points");
  call("AddPreviewTalentPoints", 1, 1, 1);
  call("AddPreviewTalentPoints", 2, 1, 1);
  assert.deepEqual(info(1, 3).slice(0, 2), [0, 0], "four in this tab: still locked; another tab's point does not count");
  call("AddPreviewTalentPoints", 1, 1, 1);
  assert.deepEqual(info(1, 3), [0, 0, true], "five points and A at 2: the preview meets it");
  call("AddPreviewTalentPoints", 1, 3, 1);
  assert.deepEqual(info(1, 3), [0, 1, true]);
});

test("taking back is refused while a previewed dependant or a higher tier needs the points", () => {
  const { call, info } = fixture();
  for (let i = 0; i < 3; i += 1) call("AddPreviewTalentPoints", 1, 2, 1);
  call("AddPreviewTalentPoints", 1, 1, 1); call("AddPreviewTalentPoints", 1, 1, 1);
  call("AddPreviewTalentPoints", 1, 3, 1);
  call("AddPreviewTalentPoints", 1, 4, 1);
  call("AddPreviewTalentPoints", 1, 1, -1);
  assert.deepEqual(info(1, 1), [0, 2, true], "C needs A at 2 (six points in tier 1: not the tier rule)");
  call("AddPreviewTalentPoints", 1, 4, -1);
  call("AddPreviewTalentPoints", 1, 2, -1);
  assert.deepEqual(info(1, 2), [0, 3, true], "tier 2 holds a point and needs five below");
  call("AddPreviewTalentPoints", 1, 3, -1);
  call("AddPreviewTalentPoints", 1, 2, -1);
  assert.deepEqual(info(1, 2), [0, 2, true], "with C gone, B can go down");
});

test("learned ranks count; the reset returns every preview rank to the learned one", () => {
  const { call, fired, info, world } = fixture({ ranks: { 101: 2, 102: 3 } });
  assert.deepEqual(info(1, 3), [0, 0, true], "learned points unlock the tier");
  call("AddPreviewTalentPoints", 1, 3, 1);
  call("AddPreviewTalentPoints", 2, 1, 1);
  call("AddPreviewTalentPoints", 1, 1, -1);
  assert.deepEqual(info(1, 1), [2, 2, true], "a learned rank is not taken back by the preview");
  fired.length = 0;
  call("ResetPreviewTalentPoints", 2, false);
  assert.deepEqual(fired, [[PREVIEW_TALENT_POINTS_CHANGED, 0, 2, 1, -1]]);
  call("ResetGroupPreviewTalentPoints", false);
  assert.deepEqual(fired.at(-1), [PREVIEW_TALENT_POINTS_CHANGED, 0, 0, 1, -1]);
  assert.deepEqual(call("GetGroupPreviewTalentPointsSpent"), [0]);
  call("ResetGroupPreviewTalentPoints", false);
  assert.equal(fired.length, 2, "nothing to reset, no event");
  assert.equal(world.learned.length, 0);
});

test("LearnPreviewTalents sends the previewed ranks, lower tiers first; a new talents packet clears the preview", () => {
  const { call, world, info } = fixture();
  call("LearnPreviewTalents", false);
  assert.deepEqual(world.learned, [], "nothing previewed, nothing sent");
  call("AddPreviewTalentPoints", 2, 1, 1);
  for (let i = 0; i < 3; i += 1) call("AddPreviewTalentPoints", 1, 2, 1);
  call("AddPreviewTalentPoints", 1, 1, 1); call("AddPreviewTalentPoints", 1, 1, 1);
  call("AddPreviewTalentPoints", 1, 3, 1);
  call("LearnPreviewTalents", false);
  assert.deepEqual(world.learned, [[false, [
    { talentId: 101, rank: 2 }, { talentId: 102, rank: 3 }, { talentId: 103, rank: 1 }, { talentId: 201, rank: 1 },
  ]]]);
  assert.deepEqual(info(1, 1), [0, 2, true], "the preview stays until the server answers");
  world.packet = {};
  assert.deepEqual(info(1, 1), [0, 0, true], "SMSG_TALENTS_INFO rebuilt the tree");
  assert.deepEqual(call("GetGroupPreviewTalentPointsSpent"), [0]);
});

// Talent.dbc has same-tier prerequisites to the right of their dependant (2214 at tier 6 column 0
// needs 71 at column 1; 1849, 1692, 2027 alike). Player::LearnTalent (Player.cpp:25897-25912) refuses
// a talent whose prerequisite is not yet known, so the prerequisite has to go first.
test("LearnPreviewTalents sends a same-tier prerequisite before its dependant to its left", () => {
  const talents = [cell(1, 301, 1, 1, 1, 0, [[302, 1, 1, 2]]), cell(2, 302, 1, 2, 1)];
  const base = {
    classId: 8, activeTalentGroup: 1, activeSpec: 0, numTalentGroups: 1, unspentPoints: 5,
    groups: [{ group: 1, spec: 0, active: true, unspentPoints: 5, tabs: [
      { index: 1, id: 10, name: "Лёд", iconId: undefined, iconTexture: undefined, background: undefined,
        pointsSpent: 0, previewPointsSpent: 0, talents },
    ] }],
  };
  const learned = [];
  const model = new FrameXmlTalentPreviewModel({ snapshot: () => base, packet: () => base, learn: (pet, t) => learned.push(t) });
  model.add(1, 2, 1, false, undefined);
  model.add(1, 1, 1, false, undefined);
  model.learn(false);
  assert.deepEqual(learned, [[{ talentId: 302, rank: 1 }, { talentId: 301, rank: 1 }]]);
});

test("a pet's preview signals the pet event and three points per tier", () => {
  const world = { base: snapshot(), packet: {}, learned: [] };
  const fired = [];
  const model = new FrameXmlTalentPreviewModel({ snapshot: () => world.base, packet: () => world.packet, learn: (pet, t) => world.learned.push([pet, t]) });
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  for (let i = 0; i < 3; i += 1) model.add(1, 2, 1, true, undefined);
  model.add(1, 3, 1, true, undefined);
  assert.equal(model.apply(true, world.base).groups[0].tabs[0].talents[2].previewRank, 0, "C still needs A at 2");
  model.add(1, 1, 1, true, undefined); model.add(1, 1, 1, true, undefined);
  model.add(1, 3, 1, true, undefined);
  assert.equal(model.apply(true, world.base).groups[0].tabs[0].talents[2].previewRank, 1, "five in tier 1 ≥ 3 for a pet");
  assert.equal(fired[0][0], PREVIEW_PET_TALENT_POINTS_CHANGED);
  model.learn(true);
  assert.equal(world.learned[0][0], true);
});

// 3.33 (13.10): the previewTalents CVar's callback (0x005127d0) — every talent group's preview counted
// (0x005c5be0) and cleared (0x005c70d0), then the character's event and the pet's, always.
test("the previewTalents callback clears every group's preview and signals both events with -points", () => {
  const one = snapshot();
  const base = { ...one, numTalentGroups: 2, groups: [one.groups[0], { ...one.groups[0], group: 2, active: false }] };
  const fired = [];
  const model = new FrameXmlTalentPreviewModel({ snapshot: (pet) => (pet ? undefined : base), packet: () => base, learn: () => {} });
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  model.add(1, 1, 1, false, 1);
  model.add(1, 2, 1, false, 2);
  model.add(1, 2, 1, false, 2);
  assert.deepEqual([model.groupSpent(false, 1), model.groupSpent(false, 2)], [1, 2]);
  fired.length = 0;
  model.cvarChanged();
  assert.deepEqual(fired, [[PREVIEW_TALENT_POINTS_CHANGED, 0, 0, 0, -3], [PREVIEW_PET_TALENT_POINTS_CHANGED, 0, 0, 0, 0]]);
  assert.ok(!Object.is(fired[1][4], -0), "no pet points: 0, not -0");
  assert.deepEqual([model.groupSpent(false, 1), model.groupSpent(false, 2)], [0, 0]);
  model.cvarChanged();
  assert.equal(fired.length, 4, "nothing previewed: both events still fire");
});

test("CMSG_LEARN_PREVIEW_TALENTS: u32 count, then u32 id and zero-based u32 rank per talent", () => {
  const bytes = [...buildLearnPreviewTalents([{ talentId: 101, rank: 2 }, { talentId: 0x1234, rank: 1 }])];
  assert.deepEqual(bytes, [2, 0, 0, 0, 101, 0, 0, 0, 1, 0, 0, 0, 0x34, 0x12, 0, 0, 0, 0, 0, 0]);
});

// The live wiring: LiveWorldSeam's preview learns the character's pairs through
// CMSG_LEARN_PREVIEW_TALENTS and the pet's with its guid through the _PET opcode.
test("the live seam sends the character's preview and the pet's preview with the pet's guid", async () => {
  const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const selfGuid = 0x10n;
  const fields = new Map([[UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, (1 << 0) | (8 << 8)]]);
  const sent = [];
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, { guid: selfGuid, typeId: 4, fields }]]) },
    casts: new Map(), actionButtons: [], cooldownRemaining: () => 0,
    talents: { pet: false, unspentPoints: 3, activeSpec: 0, specs: [{ talents: [], glyphs: [] }] },
    petSpells: { guid: 0x42n, creatureFamily: 1 },
    petTalents: { pet: true, unspentPoints: 1, activeSpec: 0,
      specs: [{ talents: [{ talentId: 30, rank: 3 }], glyphs: [] }] },
    learnPreviewTalents: (talents) => sent.push(["player", talents]),
    learnPetTalents: (guid, talents) => sent.push([guid, talents]),
  };
  const metadata = {
    ready: true, revision: 1,
    tabsForClass: (classId) => classId === 8 ? [{ id: 41, name: "Огонь", orderIndex: 0, classMask: 128, petTalentMask: 0 }] : [],
    petTalentMask: (family) => family === 1 ? 1 : 0,
    petTabs: (mask) => mask === 1 ? [{ id: 200, name: "Ferocity", orderIndex: 0, classMask: 0, petTalentMask: 1 }] : [],
    talentsIn: (tabId) => tabId === 41 ? [
      { id: 1849, tabId, tier: 0, column: 0, ranks: [18490], prerequisites: [{ talentId: 1735, rank: 1 }] },
      { id: 1735, tabId, tier: 0, column: 1, ranks: [17350], prerequisites: [] },
    ] : tabId === 200 ? [
      { id: 30, tabId, tier: 0, column: 0, ranks: [3001, 3002, 3003], prerequisites: [] },
      { id: 31, tabId, tier: 1, column: 1, ranks: [3101], prerequisites: [] },
    ] : [],
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined, talentMetadata: () => metadata,
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  assert.ok(seam.talentSnapshot(false), "the character's tree resolves");
  FRAMEXML_SEAM_BINDINGS.AddPreviewTalentPoints(seam, [1, 2, 1]);
  FRAMEXML_SEAM_BINDINGS.AddPreviewTalentPoints(seam, [1, 1, 1]);
  FRAMEXML_SEAM_BINDINGS.AddPreviewTalentPoints(seam, [1, 2, 1, true]);
  FRAMEXML_SEAM_BINDINGS.LearnPreviewTalents(seam, []);
  FRAMEXML_SEAM_BINDINGS.LearnPreviewTalents(seam, [true]);
  assert.deepEqual(sent, [
    ["player", [{ talentId: 1735, rank: 1 }, { talentId: 1849, rank: 1 }]],
    [0x42n, [{ talentId: 31, rank: 1 }]],
  ]);
});
}

// ── framexml-talent-resolver.test.mjs
{
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { createFrameXmlTalentResolvers, resolveFrameXmlTalentSnapshot, resolveFrameXmlPetTalentSnapshot } = await import(
  "../dist/code/browser/framexml/FrameXmlTalentResolver.js",
);

function player(classId = 8) {
  const fields = new Map([
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, classId << 8],
  ]);
  return { guid: 1n, typeId: 4, fields };
}

const tabs = [
  { id: 100, name: "Arcane", orderIndex: 2, iconId: 700, background: "MageArcane" },
  { id: 101, name: "Fire", orderIndex: 1, iconId: 701 },
];

const entries = [
  { id: 1, tabId: 100, tier: 0, column: 0, ranks: [1001, 1002, 1003], name: "Arcane Root", prerequisites: [] },
  { id: 2, tabId: 100, tier: 1, column: 1, ranks: [2001, 2002], prerequisites: [{ talentId: 1, rank: 2 }] },
  { id: 3, tabId: 101, tier: 0, column: 2, ranks: [3001], prerequisites: [] },
];

function metadata(overrides = {}) {
  return {
    ready: true,
    revision: 1,
    tabsForClass: () => tabs,
    talentsIn: (tabId) => entries.filter((entry) => entry.tabId === tabId),
    ...overrides,
  };
}

function talents(overrides = {}) {
  return {
    pet: false,
    unspentPoints: 5,
    activeSpec: 1,
    specs: [
      { talents: [{ talentId: 1, rank: 2 }, { talentId: 2, rank: 1 }], glyphs: [] },
      { talents: [{ talentId: 1, rank: 1 }, { talentId: 3, rank: 1 }], glyphs: [] },
    ],
    ...overrides,
  };
}

test("player talent snapshot preserves Lua/wire indexes, ranks, tree geometry and tab points", () => {
  const snapshot = resolveFrameXmlTalentSnapshot(player(), talents(), metadata());

  assert.equal(snapshot.activeTalentGroup, 2);
  assert.equal(snapshot.activeSpec, 1);
  assert.equal(snapshot.numTalentGroups, 2);
  assert.equal(snapshot.unspentPoints, 5);
  assert.deepEqual(snapshot.groups.map((group) => [group.group, group.spec, group.active]), [
    [1, 0, false], [2, 1, true],
  ]);
  assert.equal(snapshot.groups[0].unspentPoints, undefined, "the packet only carries the active pool");
  assert.equal(snapshot.groups[1].unspentPoints, 5);

  const firstGroup = snapshot.groups[0];
  assert.deepEqual(firstGroup.tabs.map((tab) => [tab.index, tab.id, tab.name]), [
    [1, 101, "Fire"], [2, 100, "Arcane"],
  ]);
  assert.equal(firstGroup.tabs[1].pointsSpent, 3);
  assert.equal(firstGroup.tabs[1].background, "MageArcane");
  assert.equal(firstGroup.tabs[1].iconId, 700);
  assert.equal(firstGroup.tabs[1].previewPointsSpent, 0);

  const child = firstGroup.tabs[1].talents[1];
  assert.deepEqual({
    index: child.index,
    id: child.id,
    tier: child.tier,
    column: child.column,
    rank: child.rank,
    maxRank: child.maxRank,
    meetsPrereq: child.meetsPrereq,
    prereq: child.prerequisites[0],
    previewRank: child.previewRank,
    link: child.link,
  }, {
    index: 2,
    id: 2,
    tier: 2,
    column: 2,
    rank: 1,
    maxRank: 2,
    meetsPrereq: false,
    prereq: {
      talentId: 1,
      tier: 1,
      column: 1,
      requiredRank: 2,
      meetsPrereq: true,
      meetsPreviewPrereq: undefined,
    },
    previewRank: undefined,
    link: undefined,
  });
  assert.equal(child.name, undefined, "TalentClient has no cell-name metadata");
  assert.equal(child.iconTexture, undefined, "numeric DBC ids are not texture paths");
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.groups[0]), true);
  assert.equal(Object.isFrozen(firstGroup.tabs[1].talents[1]), true);
  assert.equal(Object.isFrozen(firstGroup.tabs[1].talents[1].prerequisites), true);
});

test("tier availability uses total tree points, independent of row ordering", () => {
  const snapshot = resolveFrameXmlTalentSnapshot(
    player(),
    {
      pet: false,
      unspentPoints: 0,
      activeSpec: 0,
      specs: [{ talents: [{ talentId: 20, rank: 5 }], glyphs: [] }],
    },
    {
      ready: true,
      revision: 1,
      tabsForClass: () => [{ id: 10, name: "Tree", orderIndex: 1 }],
      // The learned, later-column row sorts after the tier-2 target. A prefix accumulator
      // incorrectly leaves the target unavailable even though the tree has five points.
      talentsIn: () => [
        { id: 21, tabId: 10, tier: 1, column: 0, ranks: [2100], prerequisites: [] },
        { id: 20, tabId: 10, tier: 0, column: 3,
          ranks: [2000, 2001, 2002, 2003, 2004], prerequisites: [] },
      ],
    },
  );
  assert.equal(snapshot.groups[0].tabs[0].pointsSpent, 5);
  assert.equal(snapshot.groups[0].tabs[0].talents[0].meetsPrereq, true);
});

test("pet talent snapshot uses the family mask, one pet group and three points per tier", () => {
  const petTab = { id: 200, name: "Ferocity", orderIndex: 0, classMask: 0, petTalentMask: 1,
    iconTexture: "Interface\\Icons\\Ability_Hunter_Pet_Wolf", background: "PetFerocity" };
  const petMetadata = metadata({
    petTabs: (mask) => mask === 1 ? [petTab] : [],
    talentsIn: (tabId) => tabId === 200 ? [
      { id: 30, tabId, tier: 0, column: 0, ranks: [3001, 3002, 3003], prerequisites: [] },
      { id: 31, tabId, tier: 1, column: 1, ranks: [3101], prerequisites: [] },
    ] : [],
  });
  const petTalents = { pet: true, unspentPoints: 1, activeSpec: 0,
    specs: [{ talents: [{ talentId: 30, rank: 3 }], glyphs: [] }] };
  const snapshot = resolveFrameXmlPetTalentSnapshot(0x1234n, 1, petTalents, petMetadata);
  assert.equal(snapshot.activeTalentGroup, 1);
  assert.equal(snapshot.numTalentGroups, 1);
  assert.equal(snapshot.unspentPoints, 1);
  assert.deepEqual(snapshot.groups[0].tabs.map((tab) => [tab.id, tab.pointsSpent]), [[200, 3]]);
  assert.deepEqual(snapshot.groups[0].tabs[0].talents.map((cell) => [cell.rank, cell.meetsPrereq]),
    [[3, true], [0, true]], "three spent points unlock the pet's second tier");
  assert.equal(resolveFrameXmlPetTalentSnapshot(0n, 1, petTalents, petMetadata), undefined);
  assert.equal(resolveFrameXmlPetTalentSnapshot(0x1234n, 0, petTalents, petMetadata), undefined);
  assert.equal(resolveFrameXmlPetTalentSnapshot(0x1234n, 1, talents(), petMetadata), undefined,
    "a player's talent packet cannot be reused as a pet snapshot");
});
test("missing player/packet or late metadata is undefined, never fabricated rows", () => {
  assert.equal(resolveFrameXmlTalentSnapshot(undefined, talents(), metadata()), undefined);
  assert.equal(resolveFrameXmlTalentSnapshot(player(), undefined, metadata()), undefined);
  assert.equal(resolveFrameXmlTalentSnapshot(player(), talents(), metadata({ ready: false })), undefined);
  assert.equal(resolveFrameXmlTalentSnapshot(player(), { ...talents(), pet: true }, metadata()), undefined);
});

test("a dataset class past 11 (HERO = 13) resolves; 0 and 32 (no ChrClasses mask bit) do not (9.05)", () => {
  const asked = [];
  const meta = metadata({ tabsForClass: (classId) => { asked.push(classId); return tabs; } });
  const snapshot = resolveFrameXmlTalentSnapshot(player(13), talents(), meta);
  assert.ok(snapshot, "class 13 gets a snapshot");
  assert.deepEqual(asked, [13], "its own tabs were asked for");
  assert.deepEqual(snapshot.groups[0].tabs.map((tab) => tab.id), [101, 100]);
  assert.equal(resolveFrameXmlTalentSnapshot(player(0), talents(), metadata()), undefined);
  assert.equal(resolveFrameXmlTalentSnapshot(player(32), talents(), metadata()), undefined);
});

test("cached snapshot refreshes on identity and explicit revision changes", () => {
  const state = {
    player: player(),
    playerRevision: 1,
    talents: talents(),
    talentsRevision: 1,
    talent: metadata(),
  };
  const resolver = createFrameXmlTalentResolvers(() => state);
  const first = resolver.talentSnapshot();
  assert.equal(resolver.talentSnapshot(), first);

  state.talents.specs[1].talents[0].rank = 2;
  assert.equal(resolver.talentSnapshot(), first, "a mutation is ignored until its packet revision advances");
  state.talentsRevision = 2;
  const second = resolver.talentSnapshot();
  assert.notEqual(second, first);
  assert.equal(second.groups[1].tabs[1].talents[0].rank, 2);

  state.talent = metadata({ ready: false, revision: 2 });
  assert.equal(resolver.talentSnapshot(), undefined);
});

test("pet snapshot cache follows pet packet, family mask and identity changes", () => {
  const petTab = { id: 200, name: "Ferocity", orderIndex: 0, classMask: 0, petTalentMask: 1 };
  const state = {
    player: player(), playerRevision: 1, talents: talents(), talentsRevision: 1,
    petGuid: 0x42n, petFamilyMask: 1,
    petTalents: { pet: true, unspentPoints: 1, activeSpec: 0,
      specs: [{ talents: [{ talentId: 30, rank: 1 }], glyphs: [] }] },
    petTalentsRevision: 1,
    talent: metadata({ petTabs: (mask) => mask === 1 ? [petTab] : [],
      talentsIn: () => [{ id: 30, tabId: 200, tier: 0, column: 0,
        ranks: [3001, 3002, 3003], prerequisites: [] }] }),
  };
  const resolver = createFrameXmlTalentResolvers(() => state);
  const first = resolver.petTalentSnapshot();
  assert.equal(first.groups[0].tabs[0].talents[0].rank, 1);
  assert.equal(resolver.petTalentSnapshot(), first);
  state.petTalents.specs[0].talents[0].rank = 2;
  assert.equal(resolver.petTalentSnapshot(), first, "a mutable packet needs its event revision");
  state.petTalentsRevision++;
  assert.equal(resolver.petTalentSnapshot().groups[0].tabs[0].talents[0].rank, 2);
  state.petGuid = 0n;
  assert.equal(resolver.petTalentSnapshot(), undefined, "dismissed pets expose no old tree");
});
}

// ── framexml-talent-seam.test.mjs
{
const { CannedWorldSeam, CANNED_TALENT_SNAPSHOT } = await import(
  "../dist/code/browser/framexml/CannedWorldSeam.js",
);
const { FRAMEXML_SEAM_BINDINGS } = await import(
  "../dist/code/browser/framexml/FrameXmlWorldSeam.js",
);

function twoGroupSnapshot() {
  const inactive = {
    ...CANNED_TALENT_SNAPSHOT.groups[0],
    group: 1,
    spec: 0,
    active: false,
    unspentPoints: undefined,
  };
  const active = {
    ...CANNED_TALENT_SNAPSHOT.groups[0],
    group: 2,
    spec: 1,
    active: true,
    unspentPoints: 4,
    tabs: CANNED_TALENT_SNAPSHOT.groups[0].tabs.map((tab) => ({
      ...tab,
      pointsSpent: 2,
      talents: tab.talents.map((cell) => ({ ...cell, rank: 0 })),
    })),
  };
  return {
    ...CANNED_TALENT_SNAPSHOT,
    activeTalentGroup: 2,
    activeSpec: 1,
    numTalentGroups: 2,
    unspentPoints: 4,
    groups: [inactive, active],
  };
}

const call = (name, seam, args, count = 1) => FRAMEXML_SEAM_BINDINGS[name](seam, args, count);

test("talent bindings default to active group and preserve explicit inactive group", () => {
  const seam = new CannedWorldSeam(undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, twoGroupSnapshot());
  assert.deepEqual(call("GetActiveTalentGroup", seam, [false, false]), [2]);
  assert.deepEqual(call("GetNumTalentGroups", seam, [false, false]), [2]);
  assert.deepEqual(call("GetNumTalentTabs", seam, [false, false]), [1]);
  assert.equal(call("GetTalentTabInfo", seam, [1, false, false], 5)[2], 2,
    "omitted group reads the active spec");
  assert.equal(call("GetTalentTabInfo", seam, [1, false, false, 1], 5)[2], 1,
    "explicit inactive group remains addressable");
  assert.equal(call("GetTalentInfo", seam, [1, 1, false, false], 10)[4], 0);
  assert.equal(call("GetTalentInfo", seam, [1, 1, false, false, 1], 10)[4], 1);
  assert.equal(call("GetUnspentTalentPoints", seam, [false, false], 1)[0], 4);
  assert.equal(call("GetUnspentTalentPoints", seam, [false, false, 1], 1)[0], 0,
    "inactive group has no spendable pool");
  assert.deepEqual(call("GetTalentInfo", seam, [1, 1, true, false, 2], 10), [],
    "pet projection is unavailable rather than copied from the player");
});

test("LearnTalent keeps Lua indices and only forwards a valid active-player cell", () => {
  const seam = new CannedWorldSeam(undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, twoGroupSnapshot());
  const calls = [];
  const original = seam.learnTalent.bind(seam);
  seam.learnTalent = (...args) => { calls.push(args); original(...args); };
  call("LearnTalent", seam, [1, 1, false]);
  assert.deepEqual(calls, [[1, 1, false, undefined]], "default group is active and remains one-based");
  call("LearnTalent", seam, [1, 1, false, 1]);
  call("LearnTalent", seam, [1, 1, true, 2]);
  assert.deepEqual(calls, [
    [1, 1, false, undefined],
    [1, 1, false, 1],
    [1, 1, true, 2],
  ], "the binding passes rejected requests to one fail-closed seam boundary");
});

test("stock talent getters route pet=true to the pet snapshot without copying player ranks", () => {
  const pet = {
    ...CANNED_TALENT_SNAPSHOT,
    classId: 0,
    activeTalentGroup: 1,
    activeSpec: 0,
    numTalentGroups: 1,
    unspentPoints: 2,
    groups: [{ ...CANNED_TALENT_SNAPSHOT.groups[0], unspentPoints: 2,
      tabs: [{ ...CANNED_TALENT_SNAPSHOT.groups[0].tabs[0], id: 200, name: "Ferocity",
        pointsSpent: 3, talents: [{ ...CANNED_TALENT_SNAPSHOT.groups[0].tabs[0].talents[0],
          id: 30, rank: 3, maxRank: 3 }] }] }],
  };
  const seam = { talentSnapshot: (isPet) => isPet ? pet : CANNED_TALENT_SNAPSHOT };
  assert.deepEqual(call("GetActiveTalentGroup", seam, [false, true]), [1]);
  assert.deepEqual(call("GetNumTalentGroups", seam, [false, true]), [1]);
  assert.deepEqual(call("GetNumTalentTabs", seam, [false, true]), [1]);
  assert.equal(call("GetTalentTabInfo", seam, [1, false, true], 5)[2], 3);
  assert.deepEqual(call("GetNumTalents", seam, [1, false, true]), [1]);
  assert.equal(call("GetTalentInfo", seam, [1, 1, false, true], 10)[4], 3);
  assert.deepEqual(call("GetUnspentTalentPoints", seam, [false, true]), [2]);
  assert.deepEqual(call("GetNumTalentGroups", seam, [true, true]), [0],
    "inspect remains unavailable without an inspect talent packet");
});
}
