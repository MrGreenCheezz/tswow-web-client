// 06.11 (3.01): the COMBAT_TEXT_UPDATE messages no combat-log entry raises, as Wow.exe 3.3.5a raises them: FACTION
// (0x005d20a0 → 0x0050b8c0), HONOR_GAINED (0x0050b6d0 for SMSG_PVP_CREDIT, 0x006d0e10 for a quest turned in),
// ARENA_POINTS_GAINED (0x006d0e10) and SPELL_ACTIVE (0x0053cf10/0x0053d1b0); .runtime/re-2026-11-06/301.
import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { factionStandingReport } from "../dist/code/world/FactionStandingReport.js";
import {
  frameXmlFactionText, frameXmlHonorCreditText, frameXmlQuestRewardTexts,
} from "../dist/code/browser/framexml/FrameXmlCombatTextPoints.js";
import { FrameXmlCombatLogLive } from "../dist/code/browser/framexml/FrameXmlCombatLogLive.js";
import { healEntries } from "../dist/code/world/CombatEventModel.js";
import { FrameXmlSpellActive } from "../dist/code/browser/framexml/FrameXmlSpellActive.js";

const VISIBLE = 0x1;
const HIDDEN = 0x4;
const RIVAL = 0x40;

test("0x005d20a0: only the first entry of an ordinary faction, every rival entry, generic when hidden", () => {
  assert.deepEqual(factionStandingReport(0, 5, VISIBLE, 100, 125), { listId: 5, delta: 25, generic: false });
  assert.deepEqual(factionStandingReport(0, 5, VISIBLE, 100, 40), { listId: 5, delta: -60, generic: false });
  assert.equal(factionStandingReport(1, 6, VISIBLE, 100, 125), undefined, "a spill-over entry says nothing");
  assert.equal(factionStandingReport(0, 5, VISIBLE | HIDDEN, 100, 125), undefined, "a hidden first entry neither");
  assert.equal(factionStandingReport(0, 5, VISIBLE, 100, 100), undefined, "an unchanged standing");
  assert.deepEqual(factionStandingReport(3, 7, RIVAL, 0, 10), { listId: 7, delta: 10, generic: false });
  assert.deepEqual(factionStandingReport(3, 7, RIVAL | HIDDEN, 0, 10), { listId: 7, delta: 10, generic: true });
  assert.deepEqual(factionStandingReport(0, 9, 0, 0, 10), { listId: 9, delta: 10, generic: false },
    "a slot the list never named: flags and standing 0");
});

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume(queue.shift());
      }
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  await settle();
  return { client, connection };
}

test("WorldClient: the reports go out before REPUTATION_CHANGED, judged by the flags before the packet", async () => {
  const { client, connection } = await loggedIn();
  const seen = [];
  client.events.on("FACTION_STANDING_REPORTED", (report) => seen.push(["report", report]));
  client.events.on("REPUTATION_CHANGED", () => seen.push(["changed"]));
  const init = new PacketWriter().u32(3).u8(VISIBLE).i32(100).u8(VISIBLE).i32(0).u8(RIVAL | HIDDEN).i32(0).toUint8Array();
  connection.push(OPCODES.SMSG_INITIALIZE_FACTIONS, init);
  await settle();
  seen.length = 0;
  connection.push(OPCODES.SMSG_SET_FACTION_STANDING,
    new PacketWriter().f32(0).u8(1).u32(3).u32(0).i32(150).u32(1).i32(20).u32(2).i32(5).toUint8Array());
  await settle();
  assert.deepEqual(seen, [
    ["report", { listId: 0, delta: 50, generic: false }],
    ["report", { listId: 2, delta: 5, generic: true }],
    ["changed"],
  ]);
  client.close();
});

test("WorldClient: SMSG_QUESTGIVER_QUEST_COMPLETE hands on the honor word and the arena points", async () => {
  const { client, connection } = await loggedIn();
  const seen = [];
  client.events.on("QUEST_REWARD_POINTS", (points) => seen.push(points));
  connection.push(OPCODES.SMSG_QUESTGIVER_QUEST_COMPLETE,
    new PacketWriter().u32(7777).u32(300).i32(50).u32(150).u32(0).u32(25).toUint8Array());
  await settle();
  assert.deepEqual(seen, [{ questId: 7777, honorWord: 150, arenaPoints: 25 }]);
  client.close();
});

test("FACTION, HONOR_GAINED and ARENA_POINTS_GAINED: the rules of 0x0050b8c0, 0x0050b6d0 and 0x006d0e10", () => {
  assert.deepEqual(frameXmlFactionText({ delta: 25, generic: false }, "Штормград"), ["FACTION", "Штормград", 25]);
  assert.deepEqual(frameXmlFactionText({ delta: -10, generic: false }, "Штормград"), ["FACTION", "Штормград", -10]);
  assert.equal(frameXmlFactionText({ delta: 25, generic: true }, "Штормград"), undefined, "the generic line only");
  assert.equal(frameXmlFactionText({ delta: 25, generic: false }, undefined), undefined, "no Faction.dbc row");

  const strings = new Map([["COMBATLOG_HONORAWARD", "Получено %d очков чести."], ["COMBATLOG_HONORGAIN", "%s: %d"],
    ["COMBATLOG_HONORGAIN_NO_RANK", "%s: %d"]]);
  const text = (name) => strings.get(name);
  const none = () => undefined;
  assert.deepEqual(frameXmlHonorCreditText({ honor: 40, victimGuid: 0n, victimRank: 0 }, false, text), ["HONOR_GAINED", 40]);
  assert.deepEqual(frameXmlHonorCreditText({ honor: 0, victimGuid: 0n, victimRank: 0 }, false, text), ["HONOR_GAINED", 0],
    "without a victim the amount is not checked");
  assert.equal(frameXmlHonorCreditText({ honor: 40, victimGuid: 0n, victimRank: 0 }, false, none), undefined,
    "no COMBATLOG_HONORAWARD text: nothing");
  assert.deepEqual(frameXmlHonorCreditText({ honor: 12, victimGuid: 0x99n, victimRank: 3 }, true, text), ["HONOR_GAINED", 12]);
  assert.deepEqual(frameXmlHonorCreditText({ honor: 12, victimGuid: 0x99n, victimRank: 0xffffffff }, true,
    (name) => (name === "COMBATLOG_HONORGAIN_NO_RANK" ? "x" : undefined)), ["HONOR_GAINED", 12], "rank -1: the NO_RANK line");
  assert.equal(frameXmlHonorCreditText({ honor: 12, victimGuid: 0x99n, victimRank: 3 }, false, text), undefined,
    "a victim out of sight");
  assert.equal(frameXmlHonorCreditText({ honor: 0, victimGuid: 0x99n, victimRank: 3 }, true, text), undefined, "no honor");

  assert.deepEqual(frameXmlQuestRewardTexts({ honorWord: 157, arenaPoints: 25 }),
    [["HONOR_GAINED", 15], ["ARENA_POINTS_GAINED", 25]], "the word over ten, rounded down, then the arena points");
  assert.deepEqual(frameXmlQuestRewardTexts({ honorWord: 7, arenaPoints: 0 }), [["HONOR_GAINED", 0]],
    "a word above 0 still says it, at 0");
  assert.deepEqual(frameXmlQuestRewardTexts({ honorWord: 0, arenaPoints: 0 }), []);
});

test("live: the points ride their world events whoever the combat-text unit is; UNKNOWNOBJECT is the VM's", () => {
  const listeners = new Map();
  const world = {
    events: { on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name); } },
    state: { objects: new Map([[0x99n, { typeId: 4 }], [0x77n, { typeId: 5 }]]) },
  };
  const strings = new Map([["COMBATLOG_HONORAWARD", "a"], ["COMBATLOG_HONORGAIN", "b"], ["UNKNOWNOBJECT", "Неизвестно"]]);
  const fired = [];
  const log = new FrameXmlCombatLogLive({
    world: () => world, spell: () => undefined, name: () => undefined, reaction: () => -1,
    targetGuid: () => undefined, focusGuid: () => undefined, monotonic: () => 0, now: () => 0,
    prepareLimitCategories: () => {},
    globalString: (name) => strings.get(name),
    reputationName: (listId) => (listId === 5 ? "Штормград" : undefined),
  });
  log.attach({ fire: (name, ...args) => { if (name === "COMBAT_TEXT_UPDATE") fired.push(args); return 1; } });
  listeners.get("FACTION_STANDING_REPORTED")({ listId: 5, delta: 25, generic: false });
  listeners.get("FACTION_STANDING_REPORTED")({ listId: 6, delta: 25, generic: false });
  listeners.get("HONOR_AWARDED")({ honor: 20, victimGuid: 0n, victimRank: 0 });
  listeners.get("HONOR_AWARDED")({ honor: 9, victimGuid: 0x99n, victimRank: 2 });
  listeners.get("HONOR_AWARDED")({ honor: 9, victimGuid: 0x77n, victimRank: 2 });
  listeners.get("QUEST_REWARD_POINTS")({ questId: 1, honorWord: 150, arenaPoints: 30 });
  assert.deepEqual(fired, [
    ["FACTION", "Штормград", 25], ["HONOR_GAINED", 20], ["HONOR_GAINED", 9], ["HONOR_GAINED", 15],
    ["ARENA_POINTS_GAINED", 30],
  ], "a game object (type 5) is no unit in sight");
  fired.length = 0;
  log.setCombatTextUnit(0x1234n);
  healEntries(0x55n, 0x1234n, 2061, 5, 0, 0, false, false, log);
  assert.deepEqual(fired, [["HEAL", "Неизвестно", 5]], "an unnamed healer in the client's words (0x0074d750)");
  log.detach();
  assert.equal(listeners.size, 0, "detach removes every listener");
});

const OVERPOWER_1 = { id: 7384, name: "Превосходство", spellLevel: 12, attributes: [0, 0, 0, 0, 0x200, 0, 0, 0] };
const OVERPOWER_2 = { id: 7887, name: "Превосходство", spellLevel: 24, attributes: [0, 0, 0, 0, 0x200, 0, 0, 0] };
const STRIKE = { id: 78, name: "Удар героя", spellLevel: 1, attributes: [0, 0, 0, 0, 0, 0, 0, 0] };
const ROWS = new Map([OVERPOWER_1, OVERPOWER_2, STRIKE].map((row) => [row.id, row]));

test("SPELL_ACTIVE: a TRIGGER_ACTIVATE spell that turns usable and powered, once per turn, by its highest rank", () => {
  const active = new FrameXmlSpellActive();
  const owner = {};
  const book = [{ id: 78 }, { id: 7384 }, { id: 7887 }];
  let answer = [false, true];
  const asked = [];
  const pass = (who = owner, spells = book) => active.pass(who, spells, (id) => ROWS.get(id),
    (row) => { asked.push(row.id); return answer; });
  assert.deepEqual(pass(), []);
  assert.deepEqual(asked, [7887], "one entry per name, the higher rank; a spell without the bit is not asked");
  answer = [true, true];
  assert.deepEqual(pass(), ["Превосходство"]);
  assert.deepEqual(pass(), [], "still active: nothing new");
  answer = [true, false];
  assert.deepEqual(pass(), [], "short of rage");
  answer = [true, true];
  assert.deepEqual(pass(), ["Превосходство"], "the rage came: 0x0053d1b0's edge");
  assert.deepEqual(pass(owner, [{ id: 78 }]), []);
  assert.deepEqual(pass(owner, book), ["Превосходство"], "unlearned and learned again: a new entry");
  assert.deepEqual(pass({}), ["Превосходство"], "another character starts a new list whose entries start off");
});
