import assert from "node:assert/strict";
import test from "node:test";

// 6.06 (line A7a, 05.10-A7a-D2): WHEN and WHICH reaction a melee victim plays. Wow.exe (notes in
// .runtime/re-2026-10-05/A7a-D2/) keeps SMSG_ATTACKERSTATEUPDATE as a pending record on the attacker
// (+0xb98, opcode switch 0x756800 case 0x14A) and plays the victim's half only from the attacker's
// model events (0x756240): `$CPP` → parry / dodge / shield block, `$AH0-3` / `$CAH` → the wound
// (0x755e40 → 0x736640). The next swing (0x756180) or SMSG_ATTACK_STOP (0x756770) flushes an unfired
// record without an animation; an attacker the client does not know reacts the victim at once
// (0x755e40, the wound only). Constants: TrinityCore `UnitDefines.h:359-387`, `Unit.h:44-55`.

const {
  HITINFO_AFFECTS_VICTIM, HITINFO_BLOCK, HITINFO_CRITICAL, HITINFO_FULL_ABSORB, HITINFO_MISS,
  VICTIMSTATE_BLOCKS, VICTIMSTATE_DEFLECTS, VICTIMSTATE_DODGE, VICTIMSTATE_EVADES, VICTIMSTATE_HIT,
  VICTIMSTATE_IMMUNE, VICTIMSTATE_INTACT, VICTIMSTATE_PARRY,
} = await import("../dist/code/world/CombatProtocol.js");
const {
  CUE_HIT, CUE_PARRY, HITINFO_NO_ANIMATION, SWING_NOMINAL_MS, SwingReactionCues, hitCueReaction, parryCueReaction,
} = await import(process.env.SWING_REACTION_CUES_MODULE ?? "../dist/code/browser/game/SwingReactionCues.js");

const HIT = HITINFO_AFFECTS_VICTIM;
const ATTACKER = 11n;
const VICTIM = 22n;
const record = (hitInfo, victimState, blocked = 0) => ({ attacker: ATTACKER, victim: VICTIM, hitInfo, victimState, blocked });

// 22.10 ARC-2 S4a: the renderer side of the swing timing (SwingProgressWatch.ts) and the record it fills.
const { SwingProgressWatch } = await import(process.env.SWING_PROGRESS_WATCH_MODULE ?? "../dist/code/browser/SwingProgressWatch.js");
const { createRenderResults } = await import("../dist/code/browser/RenderResults.js");

/**
 * 22.10 ARC-2 S4a: a renderer on the command/result interface. A swing is queued under main's id and watched; a
 * frame publishes every watched swing's progress where `draw` used to call `afterUnits`, then the loop's
 * `afterDraw` ticks the cues. `progressOf(entry)` answers as `meleeSwingProgress` did.
 */
function swingRenderer({ progressOf, refuse = () => false, calls = [], logSwings = false, onQueue = () => {} }) {
  const watch = new SwingProgressWatch();
  const results = createRenderResults({});
  const renderer = {
    results, entries: [], released: [], meleeTargets: undefined, owner: 0, commands: [],
    playUnitAction(guid, action, hold, id) {
      renderer.commands.push(["playUnitAction", guid, action, hold, id]);
      if (logSwings) calls.push(`swing ${guid} ${action}`);
      if (refuse()) return undefined;
      const entry = { guid, action, started: false, payload: {} };
      renderer.entries.push(entry);
      onQueue(entry);
      watch.watch(id, guid, entry);
      return id;
    },
    playUnitReaction(guid, reaction) {
      renderer.commands.push(["playUnitReaction", guid, reaction]);
      calls.push(`react ${guid} ${reaction}`);
    },
    releaseUnitAction(id) {
      renderer.commands.push(["releaseUnitAction", id]);
      renderer.released.push(id);
      watch.release(id);
    },
    setMeleeTargets(units, owner) {
      renderer.commands.push(["setMeleeTargets", units, owner]);
      if (units !== undefined) {
        renderer.meleeTargets = units;
        renderer.owner = owner;
      } else if (renderer.owner === owner) {
        renderer.meleeTargets = undefined;
        renderer.owner = 0;
      }
    },
    get watched() { return watch.size; },
    /** One frame: the units' moment of `draw`, then the loop's tick after it. */
    frame(now, reactions) {
      watch.publish(results, now, (_guid, entry) => progressOf(entry));
      reactions.afterDraw();
    },
  };
  return renderer;
}

/** A host whose attacker clock the test moves by hand. */
function host() {
  const h = {
    progress: new Map(), // token → number | undefined | null
    dead: new Set(), away: new Set(), reactions: [],
    // 05.10-A7a-D3: no token — the attacker is there and its swing undrawn (undefined); an unknown token — gone (null).
    swingProgress(_attacker, token) { return token === undefined ? undefined : h.progress.has(token) ? h.progress.get(token) : null; },
    canReact(victim) { return !h.dead.has(victim); },
    sheathed(victim) { return h.away.has(victim); },
    react(victim, reaction) { h.reactions.push(`${victim}:${reaction}`); },
  };
  return h;
}

test("the $CPP cue: parry, dodge (and deflect), any blocked amount — by the record, not by damage", () => {
  assert.equal(parryCueReaction(record(HIT, VICTIMSTATE_PARRY)), "parry");
  assert.equal(parryCueReaction(record(HIT, VICTIMSTATE_DODGE)), "dodge");
  assert.equal(parryCueReaction(record(HIT, VICTIMSTATE_DEFLECTS)), "dodge", "0x756240: state 8 dodges too");
  // A partial block (HIT + HITINFO_BLOCK, Unit.cpp:1480) and a full one (BLOCKS, :1510): blocked > 0.
  assert.equal(parryCueReaction(record(HIT | HITINFO_BLOCK, VICTIMSTATE_HIT, 7)), "block");
  assert.equal(parryCueReaction(record(HIT | HITINFO_BLOCK, VICTIMSTATE_BLOCKS, 20)), "block");
  assert.equal(parryCueReaction(record(HIT, VICTIMSTATE_HIT)), undefined);
  assert.equal(parryCueReaction(record(HITINFO_MISS, VICTIMSTATE_INTACT)), undefined);
  assert.equal(parryCueReaction(record(HITINFO_MISS, VICTIMSTATE_EVADES)), undefined);
  assert.equal(parryCueReaction(record(0, VICTIMSTATE_IMMUNE)), undefined);
});

test("the $CAH cue: HITINFO_AFFECTS_VICTIM wounds; crit, or CombatWound only for a victim swinging itself", () => {
  assert.equal(hitCueReaction(record(HIT, VICTIMSTATE_HIT), false), "standWound", "0x736640: no melee target → StandWound");
  assert.equal(hitCueReaction(record(HIT, VICTIMSTATE_HIT), true), "wound", "a melee target (+0xa20) → CombatWound");
  assert.equal(hitCueReaction(record(HIT | HITINFO_CRITICAL, VICTIMSTATE_HIT), false), "critical");
  assert.equal(hitCueReaction(record(HIT | HITINFO_CRITICAL, VICTIMSTATE_HIT), true), "critical");
  // The damage is not read: a fully absorbed hit still flinches (TrinityCore sets the bit on every non-miss).
  assert.equal(hitCueReaction(record(HIT | HITINFO_FULL_ABSORB, VICTIMSTATE_HIT), false), "standWound");
  assert.equal(hitCueReaction(record(HIT, VICTIMSTATE_DODGE), false), "standWound", "the bit, not the state");
  // Misses, evades and immunity carry no AFFECTS_VICTIM (Unit.cpp:1343, :1419, :1557-1559).
  assert.equal(hitCueReaction(record(HITINFO_MISS, VICTIMSTATE_INTACT), true), undefined);
  assert.equal(hitCueReaction(record(HITINFO_MISS, VICTIMSTATE_EVADES), true), undefined);
  assert.equal(hitCueReaction(record(0, VICTIMSTATE_IMMUNE), true), undefined);
  assert.equal(HITINFO_NO_ANIMATION, 0x00040000);
  // The measured M2 event medians (probe-events.mjs: 14 models, 114/116 attack sequences).
  assert.ok(CUE_PARRY > 0 && CUE_PARRY < CUE_HIT && CUE_HIT < 1);
});

test("nothing plays on packet arrival; parry at the $CPP moment, the wound at the $CAH moment", () => {
  const cues = new SwingReactionCues();
  const h = host();
  const token = {};
  h.progress.set(token, undefined); // queued, not yet drawn
  cues.swing(record(HIT | HITINFO_BLOCK, VICTIMSTATE_HIT, 5), token, true, h);
  assert.deepEqual(h.reactions, [], "not on arrival");
  cues.tick(0, h);
  assert.deepEqual(h.reactions, [], "still waiting for the swing to be drawn");
  h.progress.set(token, CUE_PARRY / 2);
  cues.tick(10, h);
  assert.deepEqual(h.reactions, []);
  h.progress.set(token, CUE_PARRY);
  cues.tick(20, h);
  assert.deepEqual(h.reactions, ["22:block"], "a partial block raises the shield at $CPP");
  h.progress.set(token, (CUE_PARRY + CUE_HIT) / 2);
  cues.tick(30, h);
  assert.deepEqual(h.reactions, ["22:block"]);
  h.progress.set(token, CUE_HIT + 0.01);
  cues.tick(40, h);
  // 05.10 review D2: the $CPP branch clears AFFECTS_VICTIM in the record (0x756552), so $CAH
  // (0x755e40) has no wound to play after the shield went up.
  assert.deepEqual(h.reactions, ["22:block"], "…and does not flinch at $CAH");
  assert.equal(cues.pending, 0);
  cues.tick(50, h);
  assert.equal(h.reactions.length, 1, "each cue once");
});

test("a swing that ran to its end fires what it still owed; one cut short or never drawn fires nothing", () => {
  const h = host();
  // A frame hitch: the clip started and ran out between two ticks — the events had happened.
  let cues = new SwingReactionCues();
  let token = {};
  h.progress.set(token, 0.05);
  cues.swing(record(HIT, VICTIMSTATE_PARRY), token, true, h);
  cues.tick(0, h);
  h.progress.set(token, 1);
  cues.tick(1_500, h);
  assert.deepEqual(h.reactions, ["22:parry"], "05.10 review D2: the parry consumed the wound (0x75650d)");
  // Interrupted after it started (a cast took over): no event, no reaction.
  h.reactions.length = 0;
  cues = new SwingReactionCues();
  token = {};
  h.progress.set(token, 0.05);
  cues.swing(record(HIT, VICTIMSTATE_HIT), token, true, h);
  cues.tick(0, h);
  h.progress.set(token, null);
  cues.tick(100, h);
  assert.deepEqual(h.reactions, []);
  assert.equal(cues.pending, 0);
  // 05.10-A7a-D3: null is the host's "attacker gone / swing cut short" — the record goes, nothing plays.
  token = {};
  cues.swing(record(HIT, VICTIMSTATE_HIT), token, true, h);
  cues.tick(0, h);
  assert.deepEqual(h.reactions, []);
  assert.equal(cues.pending, 0);
});

// 05.10-A7a-D3: Wow.exe plays the swing whether or not our renderer draws it (the attacker over the
// unit budget, a running quadruped with no upper-body cut, a cast above the melee layer, a clip still
// on the wire), and its events fire on its clock. With no drawn swing to read — progress undefined, or
// no token at all — the record runs on a nominal clock from the first tick after arrival:
// the attacker's own Attack clip length when the host knows it, SWING_NOMINAL_MS otherwise.
test("05.10-A7a-D3: a swing we do not draw still fires $CPP / $CAH on a nominal clock", () => {
  // Never drawn (progress stays undefined): the parry at CUE_PARRY of the nominal swing.
  let cues = new SwingReactionCues();
  let h = host();
  let token = {};
  h.progress.set(token, undefined);
  cues.swing(record(HIT, VICTIMSTATE_PARRY), token, true, h);
  cues.tick(1_000, h); // the clock starts here
  cues.tick(1_000 + CUE_PARRY * SWING_NOMINAL_MS - 1, h);
  assert.deepEqual(h.reactions, []);
  cues.tick(1_000 + CUE_PARRY * SWING_NOMINAL_MS, h);
  assert.deepEqual(h.reactions, ["22:parry"]);
  cues.tick(1_000 + SWING_NOMINAL_MS, h);
  assert.deepEqual(h.reactions, ["22:parry"], "the parry still consumes the wound");
  assert.equal(cues.pending, 0);
  // Refused by the attacker's queue (no token, not HITINFO_NO_ANIMATION): the wound at CUE_HIT.
  cues = new SwingReactionCues();
  h = host();
  cues.swing(record(HIT, VICTIMSTATE_HIT), undefined, true, h);
  assert.equal(cues.pending, 1);
  cues.tick(0, h);
  cues.tick(CUE_HIT * SWING_NOMINAL_MS - 1, h);
  assert.deepEqual(h.reactions, []);
  cues.tick(CUE_HIT * SWING_NOMINAL_MS, h);
  assert.deepEqual(h.reactions, ["22:standWound"]);
  assert.equal(cues.pending, 0);
  // The host's own clip length (1.5 s, e.g. Attack2H) moves both moments.
  cues = new SwingReactionCues();
  h = host();
  h.swingDuration = () => 1_500;
  cues.swing(record(HIT, VICTIMSTATE_HIT), undefined, true, h);
  cues.tick(0, h);
  cues.tick(CUE_HIT * SWING_NOMINAL_MS, h);
  assert.deepEqual(h.reactions, []);
  cues.tick(CUE_HIT * 1_500, h);
  assert.deepEqual(h.reactions, ["22:standWound"]);
  // HITINFO_NO_ANIMATION: 0x755130 draws nothing in Wow.exe either — no record, no reaction.
  cues = new SwingReactionCues();
  h = host();
  cues.swing(record(HIT | HITINFO_NO_ANIMATION, VICTIMSTATE_HIT), undefined, true, h);
  assert.equal(cues.pending, 0);
  cues.tick(0, h);
  cues.tick(5_000, h);
  assert.deepEqual(h.reactions, []);
  // A swing that owes nothing (a miss) keeps no record.
  cues.swing(record(HITINFO_MISS, VICTIMSTATE_INTACT), undefined, true, h);
  assert.equal(cues.pending, 0);
  // Late drawn: once the renderer shows the swing, its clock takes over from the nominal one.
  cues = new SwingReactionCues();
  h = host();
  token = {};
  h.progress.set(token, undefined);
  cues.swing(record(HIT | HITINFO_BLOCK, VICTIMSTATE_HIT, 4), token, true, h);
  cues.tick(0, h);
  cues.tick(CUE_PARRY * SWING_NOMINAL_MS, h);
  assert.deepEqual(h.reactions, ["22:block"], "the shield on the nominal clock");
  h.progress.set(token, 0.05); // the clip arrived and started
  cues.tick(CUE_HIT * SWING_NOMINAL_MS + 50, h);
  assert.deepEqual(h.reactions, ["22:block"]);
  assert.equal(cues.pending, 1, "waits for the drawn swing's own $CAH");
  h.progress.set(token, 1);
  cues.tick(CUE_HIT * SWING_NOMINAL_MS + 60, h);
  assert.equal(cues.pending, 0);
  // No duration to know (0 or not finite): both owed cues at once.
  cues = new SwingReactionCues();
  h = host();
  h.swingDuration = () => 0;
  cues.swing(record(HIT, VICTIMSTATE_HIT), undefined, true, h);
  cues.tick(0, h);
  assert.deepEqual(h.reactions, ["22:standWound"]);
});

test("05.10-A7a-D3: the session host — undrawn swings run the nominal clock, a gone or cut-short attacker drops", async () => {
  const { SwingMeleeReactions } = await import(process.env.SWING_REACTION_HOST_MODULE ?? "../dist/code/browser/game/SwingReactionHost.js");
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;
  const unit = (health = 100) => ({ fields: new Map([[HEALTH, health]]) });
  const world = { objects: new Map([[ATTACKER, unit()], [VICTIM, unit()]]) };
  const calls = [];
  const progress = new Map();
  let refuse = false;
  // 22.10 ARC-2 S4a: the renderer's queued entries, as the old tokens were.
  const renderer = swingRenderer({ calls, refuse: () => refuse,
    progressOf: (entry) => (progress.has(entry) ? progress.get(entry) : null) });
  const tokens = renderer.entries;
  const reactions = new SwingMeleeReactions(world, () => renderer);
  const run = (from, to) => { for (let t = from; t <= to; t += 10) renderer.frame(t, reactions); };
  // Queued, then removed without being drawn (yield / dropped / out of range): the renderer says null.
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attack");
  run(0, SWING_NOMINAL_MS);
  assert.deepEqual(calls, ["react 22 standWound"], "the attacker is still there: the nominal clock");
  // The renderer resolved the clip but could not draw it: its length times the cues.
  calls.length = 0;
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attack");
  tokens.at(-1).payload.swingSeconds = 2;
  run(0, 800);
  assert.deepEqual(calls, [], "0.43 of a 2 s clip is 860 ms");
  run(860, 870);
  assert.deepEqual(calls, ["react 22 standWound"]);
  // Refused by the queue (a cast owns the attacker): still reacts.
  calls.length = 0;
  refuse = true;
  reactions.swing(record(HIT, VICTIMSTATE_DODGE), "attack");
  run(0, SWING_NOMINAL_MS);
  assert.deepEqual(calls, ["react 22 dodge"]);
  refuse = false;
  // Drawn, then cut short: no events.
  calls.length = 0;
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attack");
  const cut = tokens.at(-1);
  progress.set(cut, 0.05);
  renderer.frame(0, reactions);
  cut.started = true;
  progress.set(cut, null);
  run(10, SWING_NOMINAL_MS);
  assert.deepEqual(calls, []);
  // The attacker despawned or died before its events: the record goes, as before.
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attack");
  renderer.frame(0, reactions);
  const attacker = world.objects.get(ATTACKER);
  world.objects.delete(ATTACKER);
  run(10, SWING_NOMINAL_MS);
  world.objects.set(ATTACKER, attacker);
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attack");
  renderer.frame(0, reactions);
  world.objects.set(ATTACKER, unit(0));
  run(10, SWING_NOMINAL_MS);
  assert.deepEqual(calls, []);
  reactions.dispose();
  assert.equal(renderer.watched, 0, "22.10 ARC-2 S4a: every swing id was released with its record");
});

// 05.10-A7a-D3: +0xa20 lives on the unit object. A unit destroyed while auto-attacking (out of view)
// and created again starts without it; TrinityCore resends SMSG_ATTACK_START if it still swings
// (Player.cpp:23052). The host's record of the old object must not survive into the new one.
test("05.10-A7a-D3: a melee target dies with the unit object it was written on", async () => {
  const { SwingMeleeReactions } = await import(process.env.SWING_REACTION_HOST_MODULE ?? "../dist/code/browser/game/SwingReactionHost.js");
  const world = { objects: new Map([[ATTACKER, { fields: new Map() }], [VICTIM, { fields: new Map() }]]) };
  const calls = [];
  const renderer = swingRenderer({ calls, progressOf: () => 1 });
  const reactions = new SwingMeleeReactions(world, () => renderer);
  reactions.meleeAttack(VICTIM, ATTACKER); // the victim swings back
  assert.deepEqual([...renderer.meleeTargets], [VICTIM], "22.10 ARC-2 S4a: pushed to the renderer as data");
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attack");
  renderer.frame(0, reactions);
  assert.deepEqual(calls, ["react 22 wound"]);
  // The victim leaves view and comes back as a new object, with no ATTACK_START since.
  world.objects.set(VICTIM, { fields: new Map() });
  // 22.10 ARC-2 S4a: the next sync (before a draw, before a spell visual) hands over the set without it.
  reactions.syncMeleeTargets();
  assert.deepEqual([...renderer.meleeTargets], [], "a recreated unit has no +0xa20 for a kit's wound either");
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attack");
  renderer.frame(1, reactions);
  assert.deepEqual(calls, ["react 22 wound", "react 22 standWound"]);
  // A fresh ATTACK_START on the new object counts again.
  reactions.meleeAttack(VICTIM, ATTACKER);
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attack");
  renderer.frame(2, reactions);
  assert.equal(calls.at(-1), "react 22 wound");
  reactions.dispose();
});

test("the next swing and SMSG_ATTACK_STOP flush an unfired record without a reaction (0x756180, 0x756770)", () => {
  const cues = new SwingReactionCues();
  const h = host();
  const first = {};
  const second = {};
  h.progress.set(first, undefined);
  h.progress.set(second, undefined);
  cues.swing(record(HIT, VICTIMSTATE_PARRY), first, true, h);
  cues.swing(record(HIT | HITINFO_CRITICAL, VICTIMSTATE_HIT), second, true, h);
  assert.equal(cues.pending, 1, "one record per attacker");
  h.progress.set(first, 0.9); // the old token no longer matters
  h.progress.set(second, 0.9);
  cues.tick(0, h);
  assert.deepEqual(h.reactions, ["22:critical"], "only the newer swing reacts");
  const third = {};
  h.progress.set(third, undefined);
  cues.swing(record(HIT, VICTIMSTATE_HIT), third, true, h);
  cues.attackStopped(ATTACKER);
  h.progress.set(third, 0.9);
  cues.tick(10, h);
  assert.deepEqual(h.reactions, ["22:critical"]);
  assert.equal(cues.pending, 0);
  // A next swing that draws nothing (no token) still flushes the one before it.
  const fourth = {};
  h.progress.set(fourth, undefined);
  cues.swing(record(HIT, VICTIMSTATE_PARRY), fourth, true, h);
  cues.swing(record(HITINFO_MISS, VICTIMSTATE_INTACT), undefined, true, h);
  assert.equal(cues.pending, 0);
  h.progress.set(fourth, 0.9);
  cues.tick(20, h);
  assert.deepEqual(h.reactions, ["22:critical"]);
});

test("an attacker the client does not know: the wound at once, no parry (0x756800 → 0x755e40)", () => {
  const cues = new SwingReactionCues();
  const h = host();
  cues.swing(record(HIT, VICTIMSTATE_PARRY), {}, false, h);
  assert.deepEqual(h.reactions, ["22:standWound"]);
  assert.equal(cues.pending, 0);
  cues.swing(record(HITINFO_MISS, VICTIMSTATE_INTACT), {}, false, h);
  assert.equal(h.reactions.length, 1);
});

test("the victim's own melee target is read when the wound plays; dead, feigning or sheathed victims", () => {
  const cues = new SwingReactionCues();
  const h = host();
  let token = {};
  h.progress.set(token, 0);
  cues.swing(record(HIT, VICTIMSTATE_HIT), token, true, h);
  cues.attackStarted(VICTIM, ATTACKER); // the victim starts swinging back before the blow lands
  h.progress.set(token, 0.5);
  cues.tick(0, h);
  assert.deepEqual(h.reactions, ["22:wound"]);
  cues.attackStopped(VICTIM);
  token = {};
  h.progress.set(token, 0.5);
  cues.swing(record(HIT, VICTIMSTATE_HIT), token, true, h);
  cues.tick(1, h);
  assert.deepEqual(h.reactions, ["22:wound", "22:standWound"]);
  // A parry with the weapons sheathed: ParryUnarmed (0x73b050 reads UNIT_FIELD_BYTES_2 byte 0).
  h.away.add(VICTIM);
  token = {};
  h.progress.set(token, 0.2);
  cues.swing(record(HIT, VICTIMSTATE_PARRY), token, true, h);
  cues.tick(2, h);
  assert.equal(h.reactions.at(-1), "22:parryUnarmed");
  // Dead or feigning (0x71f560): nothing.
  h.dead.add(VICTIM);
  token = {};
  h.progress.set(token, 1);
  cues.swing(record(HIT, VICTIMSTATE_PARRY), token, true, h);
  const before = h.reactions.length;
  cues.tick(3, h);
  assert.equal(h.reactions.length, before);
});

test("ticking reuses its records: no growth across many swings", () => {
  const cues = new SwingReactionCues();
  const h = host();
  for (let i = 0; i < 1_000; i++) {
    const token = {};
    h.progress.set(token, 1);
    cues.swing({ ...record(HIT, VICTIMSTATE_HIT), attacker: BigInt(i % 4) }, token, true, h);
    cues.tick(i, h);
    h.progress.delete(token);
  }
  assert.equal(cues.pending, 0);
  assert.ok(cues.spare <= 4, `pooled records: ${cues.spare}`);
  cues.tick(0, h); // an empty tick is a size check
});

test("the session host: the renderer's swing token, the world's fields, attach and dispose", async () => {
  const { SwingMeleeReactions } = await import(process.env.SWING_REACTION_HOST_MODULE ?? "../dist/code/browser/game/SwingReactionHost.js");
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const fields = (health, flags2 = 0, bytes2 = 1) => new Map([
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health], [UPDATE_FIELDS.UNIT_FIELD_FLAGS_2.offset, flags2],
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, bytes2],
  ]);
  const world = { objects: new Map([[ATTACKER, { fields: fields(100) }], [VICTIM, { fields: fields(100) }]]) };
  const calls = [];
  const progress = new Map();
  const renderer = swingRenderer({ calls, logSwings: true, onQueue: (entry) => progress.set(entry, undefined),
    progressOf: (entry) => (progress.has(entry) ? progress.get(entry) : null) });
  const reactions = new SwingMeleeReactions(world, () => renderer);
  // 22.10 ARC-2 S4a: on construction the entry hands over its (empty) melee targets under its owner id.
  assert.deepEqual(renderer.meleeTargets, new Set(), "attached on construction");
  assert.ok(renderer.owner > 0);
  reactions.swing(record(HIT, VICTIMSTATE_PARRY), "attack");
  assert.deepEqual(calls, ["swing 11 attack"]);
  const [token] = progress.keys();
  progress.set(token, 0.5);
  renderer.frame(0, reactions);
  assert.deepEqual(calls, ["swing 11 attack", "react 22 parry"], "05.10 review D2: no wound after the parry");
  // The victim swinging back: CombatWound; sheathed: ParryUnarmed; feigning: nothing.
  reactions.meleeAttack(VICTIM, ATTACKER);
  world.objects.get(VICTIM).fields = fields(100, 0, 0);
  calls.length = 0;
  reactions.swing(record(HIT, VICTIMSTATE_PARRY), "attack");
  for (const key of progress.keys()) progress.set(key, 1);
  renderer.frame(1, reactions);
  assert.deepEqual(calls, ["swing 11 attack", "react 22 parryUnarmed"]);
  // 05.10 review D2: the victim's own swing still turns a plain hit into CombatWound.
  calls.length = 0;
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attack");
  for (const key of progress.keys()) progress.set(key, 1);
  renderer.frame(1.5, reactions);
  assert.deepEqual(calls, ["swing 11 attack", "react 22 wound"]);
  world.objects.get(VICTIM).fields = fields(100, 0x1);
  calls.length = 0;
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attackOff");
  for (const key of progress.keys()) progress.set(key, 1);
  renderer.frame(2, reactions);
  assert.deepEqual(calls, ["swing 11 attackOff"]);
  // HITINFO_NO_ANIMATION: no swing is drawn and nothing reacts.
  world.objects.get(VICTIM).fields = fields(100);
  calls.length = 0;
  reactions.swing(record(HIT | HITINFO_NO_ANIMATION, VICTIMSTATE_HIT), "attack");
  renderer.frame(3, reactions);
  assert.deepEqual(calls, []);
  // An attacker the world does not have: the wound at once.
  reactions.swing({ ...record(HIT, VICTIMSTATE_HIT), attacker: 99n }, "attack");
  assert.deepEqual(calls, ["swing 99 attack", "react 22 wound"]);
  reactions.dispose();
  assert.equal(renderer.meleeTargets, undefined, "detached with the world entry");
  assert.equal(renderer.watched, 0);
});

// 05.10 review D2: every $CPP branch of 0x756240 that plays something — parry (0x75650d), shield
// block (0x756552), dodge/deflect (0x756580) — ends by clearing bit 0x2 of the attacker's stored
// hitInfo (`+0xba8`, the record at `+0xb98`). The $AH0-3/$CAH branch then hands that record to
// 0x755e40, whose wound (0x736640) is gated by the same bit: no flinch follows a parry, a dodge or a
// block — partial blocks included. A plain hit, a feigning victim (no $CPP branch ran) and an
// attacker the client does not know (0x755e40 at once, no $CPP) keep the bit.
test("$CPP consumes HITINFO_AFFECTS_VICTIM: no flinch after a parry, dodge, deflect or block", () => {
  const cases = [
    [record(HIT, VICTIMSTATE_PARRY), ["22:parry"]],
    [record(HIT, VICTIMSTATE_DODGE), ["22:dodge"]],
    [record(HIT, VICTIMSTATE_DEFLECTS), ["22:dodge"]],
    [record(HIT | HITINFO_BLOCK, VICTIMSTATE_HIT, 9), ["22:block"]],
    [record(HIT | HITINFO_BLOCK | HITINFO_CRITICAL, VICTIMSTATE_HIT, 9), ["22:block"]],
    [record(HIT | HITINFO_BLOCK, VICTIMSTATE_BLOCKS, 30), ["22:block"]],
    [record(HIT, VICTIMSTATE_HIT), ["22:standWound"]],
    [record(HIT | HITINFO_CRITICAL, VICTIMSTATE_HIT), ["22:critical"]],
  ];
  for (const [swing, expected] of cases) {
    for (const steps of [[CUE_PARRY, CUE_HIT], [1]]) { // cue by cue, and both in one late frame
      const cues = new SwingReactionCues();
      const h = host();
      const token = {};
      h.progress.set(token, undefined);
      cues.swing(swing, token, true, h);
      steps.forEach((step, index) => { h.progress.set(token, step); cues.tick(index, h); });
      assert.deepEqual(h.reactions, expected, `state ${swing.victimState} hitInfo ${swing.hitInfo} steps ${steps}`);
      assert.equal(cues.pending, 0);
    }
  }
  // The record is consumed per swing: the next swing's hit flinches again (the pooled record is reset).
  const cues = new SwingReactionCues();
  const h = host();
  for (const swing of [record(HIT, VICTIMSTATE_DODGE), record(HIT, VICTIMSTATE_HIT)]) {
    const token = {};
    h.progress.set(token, 1);
    cues.swing(swing, token, true, h);
    cues.tick(0, h);
  }
  assert.deepEqual(h.reactions, ["22:dodge", "22:standWound"]);
});

test("05.10 review D2: SMSG_ATTACK_START of an attacker the client lacks writes no melee target (0x756800 case 0x143)", async () => {
  const { SwingMeleeReactions } = await import(process.env.SWING_REACTION_HOST_MODULE ?? "../dist/code/browser/game/SwingReactionHost.js");
  const world = { objects: new Map([[ATTACKER, { fields: new Map() }], [VICTIM, { fields: new Map() }]]) };
  const calls = [];
  const renderer = swingRenderer({ calls, progressOf: () => 1 });
  const reactions = new SwingMeleeReactions(world, () => renderer);
  // The victim (22) is not in the world when its ATTACK_START arrives: Wow.exe's lookup fails and returns.
  const victimObject = world.objects.get(VICTIM);
  world.objects.delete(VICTIM);
  reactions.meleeAttack(VICTIM, ATTACKER);
  world.objects.set(VICTIM, victimObject);
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attack");
  renderer.frame(0, reactions);
  assert.deepEqual(calls, ["react 22 standWound"]);
  reactions.dispose();
});

/* --- 22.10 ARC-2 S4a: the swing timing crosses the renderer boundary as commands and a record ---------------- */

/**
 * A scripted attacker queue both paths below share: each queued swing walks its own steps, one per frame since it
 * was queued — "wait" (in the queue), a clip fraction (shown, so started), "done" (ran out: 1), "cut" (a started
 * swing taken away: null), "gone" (left unstarted: null, with the clip length it resolved when `seconds` is set).
 */
function swingModel(script) {
  let frame = 0;
  let queued = 0;
  const entries = [];
  return {
    entries,
    queue(guid, action) {
      const plan = script(action, queued++);
      if (plan === "refuse") return undefined;
      const entry = { guid, action, started: false, payload: {}, plan, born: frame, step: "wait" };
      entries.push(entry);
      return entry;
    },
    setFrame(next) {
      frame = next;
      for (const entry of entries) {
        const steps = entry.plan.steps;
        const step = steps[Math.min(frame - entry.born, steps.length - 1)];
        entry.step = step;
        if (typeof step === "number") entry.started = true;
        if (step === "gone" && entry.plan.seconds !== undefined) entry.payload.swingSeconds = entry.plan.seconds;
      }
    },
    /** What `meleeSwingProgress` answered for the entry. */
    progressOf(entry) {
      const step = entry.step;
      if (typeof step === "number") return step;
      if (step === "wait") return undefined;
      if (step === "done") return 1;
      return null;
    },
  };
}

/**
 * The path ARC-2 S4a removed (game/SwingReactionHost.ts at 93b8543), kept here to compare against: the renderer
 * called `afterUnits(now)` in the middle of `draw`, and the host asked `meleeSwingProgress` and read the live token.
 */
function oldSwingPath(world, model, fieldsOf, log) {
  const cues = new SwingReactionCues();
  const present = (guid) => {
    const fields = world.objects.get(guid)?.fields;
    if (fields === undefined) return false;
    const health = fields.get(fieldsOf.HEALTH);
    return health === undefined || health > 0;
  };
  const host = {
    swingProgress: (attacker, token) => {
      const progress = token === undefined ? null : model.progressOf(token) ?? null;
      if (typeof progress === "number") return progress;
      if (!present(attacker)) return null;
      if (progress === null && token?.started === true) return null;
      return undefined;
    },
    swingDuration: (_attacker, token) => {
      const seconds = token?.payload?.swingSeconds;
      return seconds !== undefined && seconds > 0 ? seconds * 1_000 : SWING_NOMINAL_MS;
    },
    sameUnit: (unit, stamp) => world.objects.get(unit) === stamp,
    canReact: (victim) => {
      const fields = world.objects.get(victim)?.fields;
      if (fields === undefined) return false;
      const health = fields.get(fieldsOf.HEALTH);
      if (health !== undefined && health <= 0) return false;
      return ((fields.get(fieldsOf.FLAGS_2) ?? 0) & 1) === 0;
    },
    sheathed: (victim) => {
      const bytes2 = world.objects.get(victim)?.fields.get(fieldsOf.BYTES_2);
      return bytes2 !== undefined && (bytes2 & 0xff) === 0;
    },
    react: (victim, reaction) => log(victim, reaction),
  };
  return {
    swing(swing, action) {
      const token = (swing.hitInfo & HITINFO_NO_ANIMATION) === 0 ? model.queue(swing.attacker, action) : undefined;
      cues.swing(swing, token, world.objects.has(swing.attacker), host);
    },
    meleeAttack(attacker, victim) {
      if (victim === undefined) cues.attackStopped(attacker);
      else {
        const unit = world.objects.get(attacker);
        if (unit !== undefined) cues.attackStarted(attacker, victim, unit);
      }
    },
    /** One `draw`: the units animate (the model's frame), then `afterUnits(now)`. */
    draw(frame, now) {
      model.setFrame(frame);
      cues.tick(now, host);
    },
  };
}

/** The new path: SwingMeleeReactions on a renderer that queues under main's ids and publishes per frame. */
async function newSwingPath(world, model, log) {
  const { SwingMeleeReactions } = await import(process.env.SWING_REACTION_HOST_MODULE ?? "../dist/code/browser/game/SwingReactionHost.js");
  const watch = new SwingProgressWatch();
  const renderer = {
    results: createRenderResults({}),
    commands: [],
    playUnitAction(guid, action, hold, id) {
      renderer.commands.push(["playUnitAction", guid, action, hold, id]);
      const entry = model.queue(guid, action);
      if (entry === undefined) return undefined;
      watch.watch(id, guid, entry);
      return id;
    },
    playUnitReaction(guid, reaction) {
      renderer.commands.push(["playUnitReaction", guid, reaction]);
      log(guid, reaction);
    },
    releaseUnitAction(id) {
      renderer.commands.push(["releaseUnitAction", id]);
      watch.release(id);
    },
    setMeleeTargets(units, owner) { renderer.commands.push(["setMeleeTargets", units, owner]); },
    get watched() { return watch.size; },
  };
  const reactions = new SwingMeleeReactions(world, () => renderer);
  return {
    renderer,
    reactions,
    swing: (swing, action) => reactions.swing(swing, action),
    meleeAttack: (attacker, victim) => reactions.meleeAttack(attacker, victim),
    /** One `draw` (the units animate, the record is published) and the loop's `afterDraw`. */
    draw(frame, now) {
      model.setFrame(frame);
      watch.publish(renderer.results, now, (_guid, entry) => model.progressOf(entry));
      // The record crosses by structured clone in a worker; the clone must be what the page reads.
      assert.deepEqual(structuredClone(renderer.results.swings), renderer.results.swings);
      reactions.afterDraw();
    },
  };
}

/**
 * A representative exchange: main hand and off hand, plain hits, a crit, a parry (armed and unarmed), a dodge, a
 * shield block, the victim swinging back (CombatWound), a refused swing on the nominal clock, a yielded swing timed
 * by its own clip, one cut short, HITINFO_NO_ANIMATION, an attacker the client lacks, ATTACK_STOP flushing a
 * record, and a dead victim.
 */
async function runExchange(path) {
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const fieldsOf = {
    HEALTH: UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, FLAGS_2: UPDATE_FIELDS.UNIT_FIELD_FLAGS_2.offset,
    BYTES_2: UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset,
  };
  const unit = (health = 100, bytes2 = 1) => ({ fields: new Map([[fieldsOf.HEALTH, health], [fieldsOf.BYTES_2, bytes2]]) });
  const world = { objects: new Map([[ATTACKER, unit()], [VICTIM, unit()]]) };
  const reactions = [];
  let frame = 0;
  const log = (victim, reaction) => reactions.push(`${frame}:${victim}:${reaction}`);
  const shown = (frames) => ({ steps: ["wait", ...Array.from({ length: frames }, (_, i) => (i + 1) / frames), "done"] });
  const script = (action, index) => {
    if (index === 6) return "refuse"; // a cast owns the attacker
    if (index === 7) return { steps: ["wait", "gone"], seconds: 1.5 }; // yielded undrawn, clip resolved
    if (index === 8) return { steps: ["wait", 0.05, "cut"] }; // cut short after it started
    return shown(action === "attackOff" ? 6 : 8);
  };
  const model = swingModel(script);
  const p = path === "old" ? oldSwingPath(world, model, fieldsOf, log) : await newSwingPath(world, model, log);
  const FRAME_MS = 16;
  const run = (frames) => {
    for (let index = 0; index < frames; index++) {
      frame++;
      p.draw(frame, frame * FRAME_MS);
    }
  };
  const swing = (hitInfo, victimState, blocked = 0, attacker = ATTACKER) =>
    ({ attacker, victim: VICTIM, hitInfo, victimState, blocked });
  p.swing(swing(HIT, VICTIMSTATE_HIT), "attack"); run(12); // 0 main hand: standWound
  p.swing(swing(HIT, VICTIMSTATE_PARRY), "attackOff"); run(9); // 1 off hand: parry, no wound
  p.meleeAttack(VICTIM, ATTACKER); // the victim swings back
  p.swing(swing(HIT, VICTIMSTATE_HIT), "attack"); run(12); // 2: wound (CombatWound)
  p.swing(swing(HIT, VICTIMSTATE_DODGE), "attackOff"); run(3); // 3: dodge, then flushed by the next swing
  p.swing(swing(HIT | HITINFO_CRITICAL, VICTIMSTATE_HIT), "attack"); run(12); // 4: critical
  p.swing(swing(HIT | HITINFO_BLOCK, VICTIMSTATE_HIT, 7), "attackOff"); run(9); // 5: block, no wound
  p.swing(swing(HIT, VICTIMSTATE_HIT), "attack"); run(Math.ceil(SWING_NOMINAL_MS / FRAME_MS) + 2); // 6 refused: nominal clock
  p.swing(swing(HIT, VICTIMSTATE_HIT), "attack"); run(Math.ceil(1_500 / FRAME_MS) + 2); // 7 yielded: its own 1.5 s
  p.swing(swing(HIT, VICTIMSTATE_HIT), "attack"); run(Math.ceil(SWING_NOMINAL_MS / FRAME_MS) + 2); // 8 cut short: nothing, ever
  p.swing(swing(HIT | HITINFO_NO_ANIMATION, VICTIMSTATE_HIT), "attack"); run(4); // no swing, nothing
  p.swing(swing(HIT, VICTIMSTATE_HIT, 0, 99n), "attack"); run(2); // 9 unknown attacker: the wound at once
  p.swing(swing(HIT, VICTIMSTATE_HIT), "attack"); run(1); // 10, stopped before its events
  p.meleeAttack(ATTACKER, undefined); run(12);
  world.objects.get(VICTIM).fields.set(fieldsOf.BYTES_2, 0); // weapons away
  p.swing(swing(HIT, VICTIMSTATE_PARRY), "attack"); run(12); // 11: parryUnarmed
  world.objects.get(VICTIM).fields.set(fieldsOf.HEALTH, 0);
  p.swing(swing(HIT, VICTIMSTATE_HIT), "attack"); run(12); // 12 dead victim: nothing
  return { reactions, path: p };
}

test("22.10 ARC-2 S4a: a melee exchange reacts at the same frames, in the same order, as the old mid-draw path", async () => {
  const old = await runExchange("old");
  const current = await runExchange("new");
  assert.deepEqual(current.reactions, old.reactions);
  // The exchange covers what it claims to.
  const kinds = new Set(old.reactions.map((line) => line.split(":")[2]));
  for (const kind of ["standWound", "parry", "wound", "dodge", "critical", "block", "parryUnarmed"]) {
    assert.ok(kinds.has(kind), `${kind} in ${old.reactions.join(" ")}`);
  }
  assert.ok(old.reactions.length >= 10, old.reactions.join(" "));
  // Every swing id was released when its record left; nothing is left watched.
  current.path.reactions.dispose();
  assert.equal(current.path.renderer.watched, 0);
});

test("22.10 ARC-2 S4a: the swing commands and the published record are structured-clonable", async () => {
  const { path } = await runExchange("new");
  const { commands, results } = path.renderer;
  assert.ok(commands.some(([name]) => name === "playUnitAction"));
  assert.ok(commands.some(([name]) => name === "releaseUnitAction"));
  assert.ok(commands.some(([name]) => name === "setMeleeTargets"));
  for (const command of commands) assert.deepEqual(structuredClone(command), command, command[0]);
  // playUnitAction carries main's id (a number); the renderer answers with it, not with its queue entry.
  for (const [name, , , hold, id] of commands) {
    if (name !== "playUnitAction") continue;
    assert.equal(hold, 0);
    assert.equal(typeof id, "number");
  }
  // The record, rows included: plain numbers, booleans, null and undefined in Maps.
  const watch = new SwingProgressWatch();
  watch.watch(41, 7n, { started: true, payload: { swingSeconds: 1.25 } });
  watch.watch(42, 8n, { started: false, payload: {} });
  watch.watch(43, 9n, { started: false, payload: {} });
  const answers = new Map([[7n, 0.5], [8n, undefined], [9n, null]]);
  watch.publish(results, 1234.5, (guid) => answers.get(guid));
  const clone = structuredClone(results);
  assert.deepEqual(clone.swings, results.swings);
  assert.deepEqual([...clone.swings.keys()], [41, 42, 43]);
  assert.deepEqual(clone.swings.get(41), { progress: 0.5, started: true, swingSeconds: 1.25 });
  assert.deepEqual(clone.swings.get(42), { progress: undefined, started: false, swingSeconds: undefined });
  assert.equal(clone.swings.get(43).progress, null);
  assert.equal(clone.swingNow, 1234.5, "the frame's now, on the main clock (identity in the page)");
  const frameBefore = results.swingFrame;
  watch.release(42);
  watch.publish(results, 1250, (guid) => answers.get(guid));
  assert.equal(results.swingFrame, frameBefore + 1);
  assert.deepEqual([...results.swings.keys()], [41, 43], "a released id is no longer published");
});

test("22.10 ARC-2 S4a: one tick per published frame; a frame that never reached the units ticks nothing", async () => {
  const { SwingMeleeReactions } = await import(process.env.SWING_REACTION_HOST_MODULE ?? "../dist/code/browser/game/SwingReactionHost.js");
  const world = { objects: new Map([[ATTACKER, { fields: new Map() }], [VICTIM, { fields: new Map() }]]) };
  const calls = [];
  const renderer = swingRenderer({ calls, progressOf: () => undefined }); // never drawn: the nominal clock
  const reactions = new SwingMeleeReactions(world, () => renderer);
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attack");
  reactions.afterDraw(); // no frame published yet
  renderer.frame(0, reactions); // the clock starts here
  // `draw` returned early (no player, a lost context) twice: the record is not re-read at a stale `now`.
  reactions.afterDraw();
  reactions.afterDraw();
  assert.deepEqual(calls, []);
  renderer.frame(CUE_HIT * SWING_NOMINAL_MS, reactions);
  assert.deepEqual(calls, ["react 22 standWound"]);
  reactions.dispose();
});
