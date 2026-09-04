import assert from "node:assert/strict";
import test from "node:test";

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { createFrameXmlTalentResolvers, resolveFrameXmlTalentSnapshot } = await import(
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
        { id: 20, tabId: 10, tier: 0, column: 3, ranks: [2000], prerequisites: [] },
      ],
    },
  );
  assert.equal(snapshot.groups[0].tabs[0].pointsSpent, 5);
  assert.equal(snapshot.groups[0].tabs[0].talents[0].meetsPrereq, true);
});
test("missing player/packet or late metadata is undefined, never fabricated rows", () => {
  assert.equal(resolveFrameXmlTalentSnapshot(undefined, talents(), metadata()), undefined);
  assert.equal(resolveFrameXmlTalentSnapshot(player(), undefined, metadata()), undefined);
  assert.equal(resolveFrameXmlTalentSnapshot(player(), talents(), metadata({ ready: false })), undefined);
  assert.equal(resolveFrameXmlTalentSnapshot(player(), { ...talents(), pet: true }, metadata()), undefined);
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
