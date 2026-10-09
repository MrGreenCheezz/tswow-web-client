import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FactionClient } from "../dist/code/browser/FactionClient.js";
import { TalentClient } from "../dist/code/browser/TalentClient.js";

/*
 * WORK_PLAN 5.16: a failed /dbc/factions or /dbc/talents fetch used to leave the client with a
 * pending promise that was never reset ("Left unfetched rather than retried") — every unit neutral,
 * Tab and plate colours dead until a relog. Now the fetch is asked again with a growing pause
 * (1 s, 2 s, 4 s … at most 30 s), and the failure is reported once.
 */

const FACTIONS = { templates: { 1: { faction: 0, factionGroup: 0, friendGroup: 0, enemyGroup: 0, enemies: [], friends: [] } } };
const TALENTS = { talents: [], tabs: [], skillCategories: [], skillLines: [], glyphs: [], spellAbilities: [] };

/** A fetch that fails `failures` times and then answers with `body`. */
function flakyFetch(failures, body) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    if (calls.length <= failures) throw new Error("gateway down");
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, calls };
}

/** Lets the async fetch chain run to its next await. */
async function flush() {
  for (let round = 0; round < 5; round++) await Promise.resolve();
}

for (const [name, Client, body] of [["FactionClient", FactionClient, FACTIONS], ["TalentClient", TalentClient, TALENTS]]) {
  test(`5.16 ${name} asks again after a failure, with a growing pause, and says so once`, async () => {
    const realFetch = globalThis.fetch;
    const { fetch, calls } = flakyFetch(2, body);
    globalThis.fetch = fetch;
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const client = new Client("ws://127.0.0.1:8090/");
      const said = [];
      client.onStatus = (message, error) => { if (error) said.push(message); };
      client.load();
      await flush();
      assert.equal(calls.length, 1);
      assert.equal(client.ready, false);
      client.load();
      await flush();
      assert.equal(calls.length, 1, "load() while a retry waits does not fetch twice");

      mock.timers.tick(999);
      await flush();
      assert.equal(calls.length, 1, "the first pause is a second");
      mock.timers.tick(1);
      await flush();
      assert.equal(calls.length, 2);
      mock.timers.tick(1999);
      await flush();
      assert.equal(calls.length, 2, "the second pause is two");
      mock.timers.tick(1);
      await flush();
      assert.equal(calls.length, 3);
      assert.equal(client.ready, true, "the third try lands");
      assert.equal(said.length, 1, "the failure line is not repeated per attempt");
      mock.timers.tick(60_000);
      await flush();
      assert.equal(calls.length, 3, "nothing more once it has landed");
    } finally {
      mock.timers.reset();
      globalThis.fetch = realFetch;
    }
  });
}

test("5.16 a replaced client stops asking", async () => {
  const realFetch = globalThis.fetch;
  const { fetch, calls } = flakyFetch(5, FACTIONS);
  globalThis.fetch = fetch;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const client = new FactionClient("ws://127.0.0.1:8090/");
    client.load();
    await flush();
    client.abandon();
    mock.timers.tick(120_000);
    await flush();
    client.load();
    await flush();
    assert.equal(calls.length, 1, "the next world entry's client owns the table now");
  } finally {
    mock.timers.reset();
    globalThis.fetch = realFetch;
  }
});
