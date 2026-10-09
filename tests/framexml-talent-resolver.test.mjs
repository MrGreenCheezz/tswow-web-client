import assert from "node:assert/strict";
import test from "node:test";

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
