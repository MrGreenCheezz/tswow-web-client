import assert from "node:assert/strict";
import test from "node:test";

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { resolveFrameXmlHonorSnapshot } = await import(
  "../dist/code/browser/framexml/FrameXmlHonorResolver.js",
);

function player(fields = new Map()) {
  return { guid: 0x100n, typeId: 4, fields };
}

function complete({
  todayKills = 7,
  yesterdayKills = 11,
  todayContribution = 120,
  yesterdayContribution = 80,
  lifetimeHonorableKills = 314,
  honorCurrency = 4567,
  arenaCurrency = 89,
} = {}) {
  const fields = new Map([
    [UPDATE_FIELDS.PLAYER_FIELD_KILLS.offset, ((yesterdayKills & 0xffff) << 16) | (todayKills & 0xffff)],
    [UPDATE_FIELDS.PLAYER_FIELD_TODAY_CONTRIBUTION.offset, todayContribution],
    [UPDATE_FIELDS.PLAYER_FIELD_YESTERDAY_CONTRIBUTION.offset, yesterdayContribution],
    [UPDATE_FIELDS.PLAYER_FIELD_LIFETIME_HONORABLE_KILLS.offset, lifetimeHonorableKills],
    [UPDATE_FIELDS.PLAYER_FIELD_HONOR_CURRENCY.offset, honorCurrency],
    [UPDATE_FIELDS.PLAYER_FIELD_ARENA_CURRENCY.offset, arenaCurrency],
  ]);
  return player(fields);
}

test("resolves the 3.3.5 packed KILLS order and exact honor fields", () => {
  const snapshot = resolveFrameXmlHonorSnapshot(complete());
  assert.deepEqual(snapshot, {
    todayHonorableKills: 7,
    yesterdayHonorableKills: 11,
    todayContribution: 120,
    yesterdayContribution: 80,
    lifetimeHonorableKills: 314,
    honorCurrency: 4567,
    arenaCurrency: 89,
    lifetimeContribution: undefined,
    rank: undefined,
    rankProgress: undefined,
  });
  assert.equal(Object.isFrozen(snapshot), true);
});

test("does not fabricate a snapshot for missing player or partial fields", () => {
  assert.equal(resolveFrameXmlHonorSnapshot(undefined), undefined);
  assert.equal(resolveFrameXmlHonorSnapshot(player()), undefined);
  assert.equal(resolveFrameXmlHonorSnapshot({ ...complete(), typeId: 3 }), undefined);

  const fields = complete().fields;
  fields.delete(UPDATE_FIELDS.PLAYER_FIELD_ARENA_CURRENCY.offset);
  assert.equal(resolveFrameXmlHonorSnapshot(player(fields)), undefined);
});

test("normalizes update words as unsigned without changing packed short halves", () => {
  const snapshot = resolveFrameXmlHonorSnapshot(complete({
    todayKills: 0xffff,
    yesterdayKills: 0x8001,
    todayContribution: -1,
    yesterdayContribution: 0x80000000,
    lifetimeHonorableKills: -2,
    honorCurrency: 0xffffffff,
    arenaCurrency: -0x80000000,
  }));
  assert.equal(snapshot.todayHonorableKills, 0xffff);
  assert.equal(snapshot.yesterdayHonorableKills, 0x8001);
  assert.equal(snapshot.todayContribution, 0xffffffff);
  assert.equal(snapshot.yesterdayContribution, 0x80000000);
  assert.equal(snapshot.lifetimeHonorableKills, 0xfffffffe);
  assert.equal(snapshot.honorCurrency, 0xffffffff);
  assert.equal(snapshot.arenaCurrency, 0x80000000);
  assert.equal(snapshot.lifetimeContribution, undefined);
  assert.equal(snapshot.rank, undefined);
  assert.equal(snapshot.rankProgress, undefined);
});
