// Plan item 3.33: the stock talent preview as Wow.exe keeps it — AddPreviewTalentPoints (0x5c9590,
// rules 0x5c73d0), GetGroupPreviewTalentPointsSpent (0x5c6420), GetPreviewTalentPointsSpent (0x5c63b0,
// always 0), Reset(Group)PreviewTalentPoints (0x5c7200/0x5c7130), LearnPreviewTalents (0x5c6a10,
// CMSG_LEARN_PREVIEW_TALENTS 0x4C1) and the preview values of GetTalentInfo/TabInfo/Prereqs.
import assert from "node:assert/strict";
import test from "node:test";

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
