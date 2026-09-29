import assert from "node:assert/strict";
import test from "node:test";

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
