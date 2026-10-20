import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 3 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-honor-resolver.test.mjs
{
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
}

// ── framexml-honor-seam.test.mjs
{
const { CannedWorldSeam, CANNED_HONOR } =
  await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} seam binding exists`);
  return [...binding(seam, args)];
}

test("Canned Honor answers exact stock PvP tuples without retired rank data", () => {
  const seam = new CannedWorldSeam();
  assert.deepEqual(api(seam, "GetPVPSessionStats"), [
    CANNED_HONOR.todayHonorableKills,
    CANNED_HONOR.todayContribution,
  ]);
  assert.deepEqual(api(seam, "GetPVPYesterdayStats"), [
    CANNED_HONOR.yesterdayHonorableKills,
    CANNED_HONOR.yesterdayContribution,
  ]);
  assert.deepEqual(api(seam, "GetPVPLifetimeStats"), [
    CANNED_HONOR.lifetimeHonorableKills,
    undefined,
  ]);
  assert.deepEqual(api(seam, "GetPVPRankInfo", undefined), [undefined, 0]);
  assert.deepEqual(api(seam, "UnitPVPRank", "player"), []);
  assert.deepEqual(api(seam, "UnitPVPRank", "target"), []);
  assert.deepEqual(api(seam, "GetPVPRankProgress"), [0]);
});

test("Canned Honor seeds one update edge and detaches silently", () => {
  const seam = new CannedWorldSeam();
  const events = [];
  const pump = {
    now: () => 100,
    fire(event, ...args) {
      events.push([event, ...args]);
      return 1;
    },
  };
  seam.attach(pump);
  assert.equal(events.filter(([event]) =>
    event === FRAMEXML_SEAM_EVENTS.pvpKillsChanged).length, 1);
  seam.detach();
  events.length = 0;
  seam.tick(101);
  assert.deepEqual(events, []);
});
}

// ── framexml-live-honor-seam.test.mjs
{
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

class FakeEvents {
  #listeners = new Map();

  on(name, listener) {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }

  emit(name, payload = {}) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }
}

function fixture() {
  const guid = 0x10n;
  const fields = new Map([
    [UPDATE_FIELDS.PLAYER_FIELD_KILLS.offset, 12 | (7 << 16)],
    [UPDATE_FIELDS.PLAYER_FIELD_TODAY_CONTRIBUTION.offset, 90],
    [UPDATE_FIELDS.PLAYER_FIELD_YESTERDAY_CONTRIBUTION.offset, 60],
    [UPDATE_FIELDS.PLAYER_FIELD_LIFETIME_HONORABLE_KILLS.offset, 123],
    [UPDATE_FIELDS.PLAYER_FIELD_HONOR_CURRENCY.offset, 456],
    [UPDATE_FIELDS.PLAYER_FIELD_ARENA_CURRENCY.offset, 78],
  ]);
  const player = { guid, typeId: 4, fields };
  const events = new FakeEvents();
  const world = {
    mapId: 0,
    worldStateContext: undefined,
    state: { selfGuid: guid, objects: new Map([[guid, player]]) },
    actionButtons: [],
    casts: new Map(),
    cooldownSnapshots: new Map(),
    events,
    channels: new Map(),
    partyStats: new Map(),
    questPoi: new Map(),
    chatLog: [],
    cooldownRemaining: () => 0,
    aurasFor: () => [],
  };
  const fieldListeners = new Map();
  const store = {
    field(_subject, name, listener) {
      fieldListeners.set(name, listener);
      return () => fieldListeners.delete(name);
    },
  };
  const fired = [];
  const pump = {
    now: () => 100,
    fire(event, ...args) {
      fired.push([event, ...args]);
      return 1;
    },
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: () => undefined,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  return { seam, world, player, events, fieldListeners, fired, pump };
}

test("live Honor publishes only after authoritative fields change", () => {
  const { seam, player, events, fieldListeners, fired, pump } = fixture();
  seam.attach(pump);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetPVPSessionStats(seam, []), [12, 90]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetPVPYesterdayStats(seam, []), [7, 60]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetPVPLifetimeStats(seam, []), [123, undefined]);
  fired.length = 0;

  events.emit("HONOR_AWARDED", { honor: 10, victimGuid: 0x20n, victimRank: 0 });
  assert.deepEqual(fired, [], "credit arrives before fields and must not publish stale data");

  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_KILLS.offset, 13 | (7 << 16));
  fieldListeners.get("PLAYER_FIELD_KILLS")?.();
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.pvpKillsChanged]],
    "one changed field publishes exactly one PvP edge");
  fired.length = 0;
  fieldListeners.get("PLAYER_FIELD_KILLS")?.();
  assert.deepEqual(fired, [], "unchanged field callbacks stay quiet");

  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_HONOR_CURRENCY.offset, 789);
  fieldListeners.get("PLAYER_FIELD_HONOR_CURRENCY")?.();
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.honorCurrencyUpdate]],
    "currency-only changes publish HONOR_CURRENCY_UPDATE without a kill edge");
  fired.length = 0;
  events.emit("HONOR_AWARDED", { honor: 10, victimGuid: 0x20n, victimRank: 0 });
  assert.deepEqual(fired, [], "HONOR_AWARDED alone cannot publish stale honor data");

  // Both packet families can update the object before the store drains its callbacks. The
  // first callback must not consume the other family's signature.
  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_KILLS.offset, 14 | (7 << 16));
  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_HONOR_CURRENCY.offset, 999);
  fired.length = 0;
  fieldListeners.get("PLAYER_FIELD_KILLS")?.();
  fieldListeners.get("PLAYER_FIELD_HONOR_CURRENCY")?.();
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.pvpKillsChanged],
    [FRAMEXML_SEAM_EVENTS.honorCurrencyUpdate],
  ], "batched stats and currency writes retain one event per family");
  seam.detach();
});
}
