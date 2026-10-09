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
  let tokens = [];
  const renderer = {
    afterUnits: undefined,
    playUnitAction(guid, action) {
      if (refuse) return undefined;
      const token = { guid, action, started: false, payload: {} };
      tokens.push(token);
      return token;
    },
    playUnitReaction(guid, reaction) { calls.push(`react ${guid} ${reaction}`); },
    meleeSwingProgress(_guid, token) { return progress.has(token) ? progress.get(token) : null; },
  };
  const reactions = new SwingMeleeReactions(world, () => renderer);
  const run = (from, to) => { for (let t = from; t <= to; t += 10) renderer.afterUnits(t); };
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
  renderer.afterUnits(0);
  cut.started = true;
  progress.set(cut, null);
  run(10, SWING_NOMINAL_MS);
  assert.deepEqual(calls, []);
  // The attacker despawned or died before its events: the record goes, as before.
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attack");
  renderer.afterUnits(0);
  const attacker = world.objects.get(ATTACKER);
  world.objects.delete(ATTACKER);
  run(10, SWING_NOMINAL_MS);
  world.objects.set(ATTACKER, attacker);
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attack");
  renderer.afterUnits(0);
  world.objects.set(ATTACKER, unit(0));
  run(10, SWING_NOMINAL_MS);
  assert.deepEqual(calls, []);
  reactions.dispose();
});

// 05.10-A7a-D3: +0xa20 lives on the unit object. A unit destroyed while auto-attacking (out of view)
// and created again starts without it; TrinityCore resends SMSG_ATTACK_START if it still swings
// (Player.cpp:23052). The host's record of the old object must not survive into the new one.
test("05.10-A7a-D3: a melee target dies with the unit object it was written on", async () => {
  const { SwingMeleeReactions } = await import(process.env.SWING_REACTION_HOST_MODULE ?? "../dist/code/browser/game/SwingReactionHost.js");
  const world = { objects: new Map([[ATTACKER, { fields: new Map() }], [VICTIM, { fields: new Map() }]]) };
  const calls = [];
  const renderer = {
    afterUnits: undefined,
    playUnitAction() { return { started: true }; },
    playUnitReaction(guid, reaction) { calls.push(`react ${guid} ${reaction}`); },
    meleeSwingProgress() { return 1; },
  };
  const reactions = new SwingMeleeReactions(world, () => renderer);
  reactions.meleeAttack(VICTIM, ATTACKER); // the victim swings back
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attack");
  renderer.afterUnits(0);
  assert.deepEqual(calls, ["react 22 wound"]);
  // The victim leaves view and comes back as a new object, with no ATTACK_START since.
  world.objects.set(VICTIM, { fields: new Map() });
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attack");
  renderer.afterUnits(1);
  assert.deepEqual(calls, ["react 22 wound", "react 22 standWound"]);
  // A fresh ATTACK_START on the new object counts again.
  reactions.meleeAttack(VICTIM, ATTACKER);
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attack");
  renderer.afterUnits(2);
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
  const renderer = {
    afterUnits: undefined,
    playUnitAction(guid, action) { const token = { guid, action }; calls.push(`swing ${guid} ${action}`); progress.set(token, undefined); return token; },
    playUnitReaction(guid, reaction) { calls.push(`react ${guid} ${reaction}`); },
    meleeSwingProgress(_guid, token) { return progress.has(token) ? progress.get(token) : null; },
  };
  const reactions = new SwingMeleeReactions(world, () => renderer);
  assert.equal(typeof renderer.afterUnits, "function", "attached on construction");
  reactions.swing(record(HIT, VICTIMSTATE_PARRY), "attack");
  assert.deepEqual(calls, ["swing 11 attack"]);
  const [token] = progress.keys();
  progress.set(token, 0.5);
  renderer.afterUnits(0);
  assert.deepEqual(calls, ["swing 11 attack", "react 22 parry"], "05.10 review D2: no wound after the parry");
  // The victim swinging back: CombatWound; sheathed: ParryUnarmed; feigning: nothing.
  reactions.meleeAttack(VICTIM, ATTACKER);
  world.objects.get(VICTIM).fields = fields(100, 0, 0);
  calls.length = 0;
  reactions.swing(record(HIT, VICTIMSTATE_PARRY), "attack");
  for (const key of progress.keys()) progress.set(key, 1);
  renderer.afterUnits(1);
  assert.deepEqual(calls, ["swing 11 attack", "react 22 parryUnarmed"]);
  // 05.10 review D2: the victim's own swing still turns a plain hit into CombatWound.
  calls.length = 0;
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attack");
  for (const key of progress.keys()) progress.set(key, 1);
  renderer.afterUnits(1.5);
  assert.deepEqual(calls, ["swing 11 attack", "react 22 wound"]);
  world.objects.get(VICTIM).fields = fields(100, 0x1);
  calls.length = 0;
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attackOff");
  for (const key of progress.keys()) progress.set(key, 1);
  renderer.afterUnits(2);
  assert.deepEqual(calls, ["swing 11 attackOff"]);
  // HITINFO_NO_ANIMATION: no swing is drawn and nothing reacts.
  world.objects.get(VICTIM).fields = fields(100);
  calls.length = 0;
  reactions.swing(record(HIT | HITINFO_NO_ANIMATION, VICTIMSTATE_HIT), "attack");
  renderer.afterUnits(3);
  assert.deepEqual(calls, []);
  // An attacker the world does not have: the wound at once.
  reactions.swing({ ...record(HIT, VICTIMSTATE_HIT), attacker: 99n }, "attack");
  assert.deepEqual(calls, ["swing 99 attack", "react 22 wound"]);
  reactions.dispose();
  assert.equal(renderer.afterUnits, undefined, "detached with the world entry");
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
  const progress = new Map();
  const renderer = {
    afterUnits: undefined,
    playUnitAction(guid, action) { const token = { guid, action }; progress.set(token, 1); return token; },
    playUnitReaction(guid, reaction) { calls.push(`react ${guid} ${reaction}`); },
    meleeSwingProgress(_guid, token) { return progress.has(token) ? progress.get(token) : null; },
  };
  const reactions = new SwingMeleeReactions(world, () => renderer);
  // The victim (22) is not in the world when its ATTACK_START arrives: Wow.exe's lookup fails and returns.
  const victimObject = world.objects.get(VICTIM);
  world.objects.delete(VICTIM);
  reactions.meleeAttack(VICTIM, ATTACKER);
  world.objects.set(VICTIM, victimObject);
  reactions.swing(record(HIT, VICTIMSTATE_HIT), "attack");
  renderer.afterUnits(0);
  assert.deepEqual(calls, ["react 22 standWound"]);
  reactions.dispose();
});
