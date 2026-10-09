import assert from "node:assert/strict";
import test from "node:test";
import { FactionClient } from "../dist/code/browser/FactionClient.js";
import {
  FACTION_TEMPLATE_FLAG_CONTESTED_GUARD, PLAYER_FLAGS_CONTESTED_PVP, contestedGuardHostile,
} from "../dist/code/world/ContestedGuard.js";

/*
 * L18 5.05 (04.10): FactionTemplate.Flags reach the browser (/dbc/factions?v=3) for Wow.exe's
 * CONTESTED_GUARD rule — 0x007251c0 at 0x007253ca (the player's view of a reputation faction's unit) and
 * 0x0071f770 (a unit's view of a player): a template with FACTION_TEMPLATE_FLAG_CONTESTED_GUARD 0x1000
 * (DBCEnums.h:322) is hostile to a player with PLAYER_FLAGS_CONTESTED_PVP 0x100 (Player.h:362). The column
 * is FactionTemplate.dbc's third (tools/dbd/FactionTemplate.dbd 3.3.5.12340: ID, Faction, Flags, …;
 * DBCStructure.h:694), the row word Wow.exe reads at +8.
 */

test("L18 5.05: the two flags are the core's", () => {
  assert.equal(FACTION_TEMPLATE_FLAG_CONTESTED_GUARD, 0x1000);
  assert.equal(PLAYER_FLAGS_CONTESTED_PVP, 0x100);
});

test("L18 5.05: contestedGuardHostile — the player's flag, then the template's; unknown flags stay unknown", () => {
  assert.equal(contestedGuardHostile(0, 0x1821), false, "not contested");
  assert.equal(contestedGuardHostile(0, undefined), false, "not contested: the flags are not needed");
  assert.equal(contestedGuardHostile(0x100, 0x1821), true, "the Booty Bay bruiser (template 121)");
  assert.equal(contestedGuardHostile(0x100 | 0x8, 0x1001), true, "other player flags do not matter");
  assert.equal(contestedGuardHostile(0x100, 0x0821), false, "PVP 0x800 alone is no guard");
  assert.equal(contestedGuardHostile(0x100, 0), false);
  assert.equal(contestedGuardHostile(0x100, undefined), undefined, "a gateway before v=3: the caller decides");
  assert.equal(contestedGuardHostile(0xff, 0x1000), false, "0x80 and below are not CONTESTED_PVP");
});

test("L18 5.05: FactionClient asks for v=3 and answers the template flags; an old body answers nothing", async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  let body = {
    templates: {
      121: { faction: 21, flags: 0x1821, factionGroup: 1, friendGroup: 0, enemyGroup: 8, enemies: [], friends: [21] },
      120: { faction: 21, flags: 0, factionGroup: 0, friendGroup: 0, enemyGroup: 0, enemies: [], friends: [21] },
    },
  };
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => body }; };
  try {
    const client = new FactionClient("ws://127.0.0.1:8090/");
    assert.equal(client.templateFlagsOf(121), undefined, "before the table lands");
    client.load();
    for (let round = 0; round < 5; round++) await Promise.resolve();
    assert.deepEqual(calls, ["http://127.0.0.1:8090/dbc/factions?v=3"]);
    assert.equal(client.templateFlagsOf(121), 0x1821);
    assert.equal(client.templateFlagsOf(120), 0);
    assert.equal(client.templateFlagsOf(77777), undefined, "a template the table does not have");
    // The gateway now running predates the flags until its restart: its rows carry none.
    body = { templates: { 121: { faction: 21, factionGroup: 1, friendGroup: 0, enemyGroup: 8, enemies: [], friends: [21] } } };
    const old = new FactionClient("ws://127.0.0.1:8090/");
    old.load();
    for (let round = 0; round < 5; round++) await Promise.resolve();
    assert.equal(old.ready, true);
    assert.equal(old.templateFlagsOf(121), undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});
