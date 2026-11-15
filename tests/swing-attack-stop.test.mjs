import assert from "node:assert/strict";
import test from "node:test";
import { SwingReactionCues } from "../dist/code/browser/game/SwingReactionCues.js";
import { HITINFO_AFFECTS_VICTIM } from "../dist/code/world/CombatProtocol.js";

// 6.06 (15.11, events8): SMSG_ATTACK_STOP (0x756770) flushes the attacker's record through 0x756180 → 0x755a60 (text and
// sounds, no animation). A record held only because its swing's clip is still on the way first plays what Wow.exe's own
// swing, playing on its model since the record's arrival, had fired by then (`$CPP` at 0.13, `$CAH` at 0.43 of the
// nominal 1000 ms); the rest goes unseen, as there.

const ATTACKER = 1n;
const VICTIM = 2n;
const swing = { attacker: ATTACKER, victim: VICTIM, hitInfo: HITINFO_AFFECTS_VICTIM, victimState: 1, blocked: 0 };

function host(waiting) {
  const reactions = [];
  return {
    reactions,
    swingProgress: () => 0,
    canReact: () => true,
    waitingForClip: () => waiting,
    react: (victim, reaction) => reactions.push([victim, reaction]),
  };
}

function stopAt(stopNow, waiting = true, tickFirst = true) {
  const cues = new SwingReactionCues();
  const h = host(waiting);
  assert.equal(cues.swing(swing, 7, true, h), true);
  if (tickFirst) cues.tick(1000, h); // the first frame after the swing's arrival starts its clock
  cues.attackStopped(ATTACKER, h, stopNow);
  assert.equal(cues.pending, 0, "the record leaves");
  return h.reactions;
}

test("a stop after the waiting swing's hit moment: the wound plays", () => {
  assert.deepEqual(stopAt(1500), [[VICTIM, "standWound"]]);
});

test("a stop before it: the wound goes unseen, as Wow.exe's flush", () => {
  assert.deepEqual(stopAt(1200), []);
});

test("a stop in the swing's own batch (the killing blow): nothing", () => {
  assert.deepEqual(stopAt(1500, true, false), []);
});

test("a drawn swing is not waiting: the stop drops what it has not fired", () => {
  assert.deepEqual(stopAt(5000, false), []);
});

test("without the host the stop drops the record (the older call)", () => {
  const cues = new SwingReactionCues();
  const h = host(true);
  cues.swing(swing, 7, true, h);
  cues.tick(1000, h);
  cues.attackStopped(ATTACKER);
  assert.deepEqual(h.reactions, []);
  assert.equal(cues.pending, 0);
});
