import assert from "node:assert/strict";
import test from "node:test";
import {
  COMBAT_LOG_HISTORY, pushCombatEntry, swingEntry, swingText,
} from "../dist/code/browser/ui/CombatLogModel.js";
import {
  HITINFO_CRITICAL, HITINFO_CRUSHING, HITINFO_GLANCING, HITINFO_MISS,
  VICTIMSTATE_BLOCKS, VICTIMSTATE_DODGE,
} from "../dist/code/world/CombatProtocol.js";

const SELF = 10n;
const names = (guid) => (guid === SELF ? "Вы" : guid === 20n ? "Кабан" : "Волк");

function swing(fields = {}) {
  return {
    hitInfo: 0, attacker: SELF, victim: 20n, damage: 47, overkill: 0, victimState: 1, blocked: 0,
    damages: [{ schoolMask: 1, damage: 47, absorbed: 0, resisted: 0 }],
    ...fields,
  };
}

test("a swing the player neither dealt nor took still gets a line", () => {
  // The overlay over the world filters those out, because a busy place would bury the two swings
  // that matter. The tab does not: that is what a log is for.
  const written = swingText(swing({ attacker: 20n, victim: 30n }), SELF, names);
  assert.equal(written.text, "Кабан → Волк: 47");
  assert.equal(written.kind, "muted", "and it is the quiet colour, not the player's own");
});

test("the player's own swings read the way they always did", () => {
  assert.equal(swingText(swing(), SELF, names).text, "Кабан: 47");
  assert.equal(swingText(swing({ attacker: 20n, victim: SELF }), SELF, names).text, "Кабан → вы: 47");
});

test("a miss is a word and not a zero", () => {
  const missed = swingText(swing({ hitInfo: HITINFO_MISS }), SELF, names);
  assert.equal(missed.text, "Кабан: промах");
  assert.equal(missed.amount, undefined, "so nothing floats a zero over the target");
  assert.equal(missed.avoided, "промах");
  assert.equal(swingText(swing({ victimState: VICTIMSTATE_DODGE }), SELF, names).avoided, "уклонение");
});

test("a partial block is damage with a note, not an avoided swing", () => {
  // VICTIMSTATE_BLOCKS still lands: the block only takes part of it, and calling the whole swing
  // «заблокировано» would report a hit that took health as a hit that did not.
  const blocked = swingText(swing({ victimState: VICTIMSTATE_BLOCKS, blocked: 12 }), SELF, names);
  assert.equal(blocked.text, "Кабан: 47 (блок 12)");
  assert.equal(blocked.amount, 47);
});

test("a crit, a glance and a crush are all marked", () => {
  const marked = swingText(
    swing({ hitInfo: HITINFO_CRITICAL | HITINFO_GLANCING | HITINFO_CRUSHING }), SELF, names);
  assert.equal(marked.text, "Кабан: 47 (крит, скользящий, сокрушающий)");
  assert.equal(marked.kind, "crit", "a crit outranks whose swing it was");
});

test("absorb and resist are summed across both sub-damages", () => {
  // A two-school weapon sends two of them, and reporting only the first understates the shield.
  const split = swingText(swing({
    damage: 60,
    damages: [
      { schoolMask: 1, damage: 40, absorbed: 5, resisted: 0 },
      { schoolMask: 4, damage: 20, absorbed: 3, resisted: 7 },
    ],
  }), SELF, names);
  assert.equal(split.text, "Кабан: 60 (поглощено 8, сопротивление 7)");
});

test("the ring stops at five hundred and drops the oldest", () => {
  const list = [];
  for (let index = 0; index < COMBAT_LOG_HISTORY + 40; index++) {
    pushCombatEntry(list, { at: index, text: `${index}`, kind: "dealt", casterGuid: 0n, targetGuid: 0n, spellId: 0 });
  }
  assert.equal(list.length, COMBAT_LOG_HISTORY);
  assert.equal(list[0].text, "40", "the first forty are gone, not the last forty");
});

test("an entry keeps both guids, so a tab can say who hit whom later", () => {
  const entry = swingEntry(swing({ attacker: 20n, victim: SELF }), SELF, names, 1234);
  assert.equal(entry.at, 1234);
  assert.equal(entry.casterGuid, 20n);
  assert.equal(entry.targetGuid, SELF);
  assert.equal(entry.spellId, 0, "a melee swing names no spell");
});
