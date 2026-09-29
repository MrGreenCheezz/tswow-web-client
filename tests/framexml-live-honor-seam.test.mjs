import assert from "node:assert/strict";
import test from "node:test";

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
