import assert from "node:assert/strict";
import test from "node:test";

// 5.05 (11.11): UnitSelectionColor for a unit the player does not control — Wow.exe 0x0060da00 → 0x00521bf0 indexes its
// table 0x00bd0c94 by 0x007251c0(unit, player), the ReputationRank: 0-1 red, 2 (Unfriendly) orange, 3 yellow, 4-7 green
// (.runtime/re-2026-10-04/d3-factions/g2.c). A player-controlled unit (UNIT_FLAG_PLAYER_CONTROLLED 0x8) keeps the
// three-way reaction it had.
const { EventBus } = await import("../dist/code/world/EventBus.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { frameXmlSelectionColorOfRank } = await import("../dist/code/browser/framexml/FrameXmlSelectionColor.js");

function object(guid, typeId) {
  return {
    guid, typeId, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined, runSpeed: undefined,
    turnRate: undefined, motion: undefined, glide: undefined, transport: undefined, speeds: undefined,
    transportTime: undefined, fields: new Map(),
  };
}

test("5.05 (11.11): 0x00bd0c94 — the selection colour of each rank", () => {
  const ORANGE = [1, 0x80 / 0xff, 0];
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(frameXmlSelectionColorOfRank),
    [[1, 0, 0], [1, 0, 0], ORANGE, [1, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0]]);
});

test("5.05 (11.11): UnitSelectionColor paints an Unfriendly creature orange; a player-controlled unit keeps the reaction", () => {
  const state = new WorldState();
  const store = new WorldStore(state);
  const player = object(11n, 4);
  const target = object(12n, 3);
  state.objects.set(player.guid, player);
  state.objects.set(target.guid, target);
  state.selfGuid = player.guid;
  store.flush();
  const world = {
    state, targetGuid: target.guid, selfName: "Герой", names: { get: () => undefined }, creatureTemplates: new Map(),
    actionButtons: [], casts: new Map(), events: new EventBus(),
    cooldownState: () => undefined, cooldownRemaining: () => 0, isActiveMountSpell: () => false,
  };
  let rank = 2;
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store, spell: () => undefined,
    reaction: () => 0,
    unitReactionToPlayer: () => 0,
    unitRankToPlayer: () => rank,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const color = (unit) => FRAMEXML_SEAM_BINDINGS.UnitSelectionColor(seam, [unit]);
  assert.deepEqual(color("target"), [1, 0x80 / 0xff, 0], "Unfriendly: orange (was yellow, the neutral of three)");
  rank = 5;
  assert.deepEqual(color("target"), [0, 1, 0], "Honored: green");
  rank = 2;
  target.fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x8);
  assert.deepEqual(color("target"), [1, 1, 0], "player-controlled: the three-way reaction, neutral yellow");
  assert.deepEqual(color("player"), [0, 1, 0], "the player's own: friendly");
  store.detach();
});
