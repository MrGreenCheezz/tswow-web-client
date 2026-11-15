import assert from "node:assert/strict";
import test from "node:test";
import { ANIMATION_IDS, ANIMATION_WEAPON_FLAGS } from "../dist/code/generated/animations.js";
import { stepUnitShownSheath, animationSheathRow } from "../dist/code/browser/UnitShownSheath.js";

/*
 * 5.05 (15.11): Wow.exe 0x00738180 runs for every unit (its one caller is CGUnit's animation player 0x007385c0, no
 * test of the unit before the call; .runtime/re-2026-11-11/combat/d5.c, refs3.txt). A unit that is not the active
 * player shows the state its animation starts set, and takes the server's byte when the byte moves (0x00737aa0).
 * The spell ids below are made up: the context names their attribute words itself.
 */

const GUID = 0xf13000001a2b0001n;
const OTHER = 0xf13000001a2b0002n;
const FICTIONAL_SPELL = 9_000_001;
const FICTIONAL_KEEP_SPELL = 9_000_002;
const context = (over = {}) => ({
  casts: new Map(),
  spellAttributes: new Map([[FICTIONAL_SPELL, [0]], [FICTIONAL_KEEP_SPELL, [0x40000]]]),
  meleeTargets: new Set(),
  ...over,
});
const { Stand, SpellCastDirected, EmoteTalk, Attack1H, Ready1H } = ANIMATION_IDS;

test("5.05 (15.11): the animation rows this file leans on carry the Weaponflags the rule reads", () => {
  assert.equal(ANIMATION_WEAPON_FLAGS[SpellCastDirected] & 0x4, 0x4, "SpellCastDirected sheathes");
  assert.equal(ANIMATION_WEAPON_FLAGS[EmoteTalk] & 0x10, 0x10, "EmoteTalk sheathes at idle");
  assert.equal(ANIMATION_WEAPON_FLAGS[Attack1H] & 0x20, 0x20, "Attack1H draws melee");
  assert.equal(ANIMATION_WEAPON_FLAGS[Ready1H] & 0x20, 0x20, "Ready1H draws melee");
  assert.equal(animationSheathRow(-1), undefined);
});

test("5.05 (15.11): first sight takes the byte and judges nothing already started", () => {
  const shown = stepUnitShownSheath(undefined, GUID, 1, 7, SpellCastDirected, false, context());
  assert.equal(shown.held, 1);
  assert.equal(shown.starts, 7);
});

test("5.05 (15.11): a creature's cast puts its sword away, its next stance draws it again", () => {
  const casting = context({ casts: new Map([[GUID, { spellId: FICTIONAL_SPELL, channel: false }]]) });
  let shown = stepUnitShownSheath(undefined, GUID, 1, 0, Stand, false, casting);
  shown = stepUnitShownSheath(shown, GUID, 1, 1, SpellCastDirected, false, casting);
  assert.equal(shown.held, 0, "Weaponflags 0x4: away for the cast");
  // The cast ended (SPELL_GO took the cast bar); not fighting: the next start hands the byte back (branch 7).
  shown = stepUnitShownSheath(shown, GUID, 1, 2, Stand, false, context());
  assert.equal(shown.held, 1, "the server's byte again at the next start nothing else decides");
});

test("5.05 (15.11): a start while the cast bar runs sheathes unless the spell keeps the sheath; a channel is no cast", () => {
  const kept = context({ casts: new Map([[GUID, { spellId: FICTIONAL_KEEP_SPELL, channel: false }]]) });
  let shown = stepUnitShownSheath(undefined, GUID, 1, 0, Stand, false, kept);
  shown = stepUnitShownSheath(shown, GUID, 1, 1, Stand, false, kept);
  assert.equal(shown.held, 1, "DONT_AFFECT_SHEATH_STATE");
  const plain = context({ casts: new Map([[GUID, { spellId: FICTIONAL_SPELL, channel: false }]]) });
  shown = stepUnitShownSheath(shown, GUID, 1, 2, Stand, false, plain);
  assert.equal(shown.held, 0, "any start under a plain cast bar");
  const channel = context({ casts: new Map([[GUID, { spellId: FICTIONAL_SPELL, channel: true }]]) });
  shown = stepUnitShownSheath(stepUnitShownSheath(undefined, GUID, 1, 0, Stand, false, channel), GUID, 1, 1, Stand, false, channel);
  assert.equal(shown.held, 1, "a channel is not +0xa60");
  const someoneElse = context({ casts: new Map([[OTHER, { spellId: FICTIONAL_SPELL, channel: false }]]) });
  shown = stepUnitShownSheath(stepUnitShownSheath(undefined, GUID, 1, 0, Stand, false, someoneElse), GUID, 1, 1, Stand, false, someoneElse);
  assert.equal(shown.held, 1, "another caster's bar is not this unit's");
});

test("5.05 (15.11): a kit start with the keep bit leaves the sword where it is", () => {
  let shown = stepUnitShownSheath(undefined, GUID, 1, 0, Stand, false, context());
  shown = stepUnitShownSheath(shown, GUID, 1, 1, SpellCastDirected, true, context());
  assert.equal(shown.held, 1);
});

test("5.05 (15.11): a talk emote sheathes, a swing draws; a fighter keeps the blade out between swings", () => {
  const fighting = context({ meleeTargets: new Set([GUID]) });
  let shown = stepUnitShownSheath(undefined, GUID, 1, 0, Stand, false, context());
  shown = stepUnitShownSheath(shown, GUID, 1, 1, EmoteTalk, false, context());
  assert.equal(shown.held, 0, "EmoteTalk: Weaponflags 0x10");
  shown = stepUnitShownSheath(shown, GUID, 0, 2, Attack1H, false, fighting);
  assert.equal(shown.held, 1, "a swing draws even on a byte of 0");
  shown = stepUnitShownSheath(shown, GUID, 0, 3, Stand, false, fighting);
  assert.equal(shown.held, 1, "attacking: draw (branch 6), the byte is not read");
  shown = stepUnitShownSheath(shown, GUID, 0, 4, Stand, false, context());
  assert.equal(shown.held, 0, "the fight over: the byte again");
});

test("5.05 (15.11): a new byte is shown at once, whatever the last start decided", () => {
  let shown = stepUnitShownSheath(undefined, GUID, 1, 0, Stand, false, context());
  shown = stepUnitShownSheath(shown, GUID, 1, 1, EmoteTalk, false, context());
  assert.equal(shown.held, 0);
  shown = stepUnitShownSheath(shown, GUID, 2, 1, EmoteTalk, false, context());
  assert.equal(shown.held, 2, "0x00737aa0 → 0x00736d30(byte, 1, 1)");
  shown = stepUnitShownSheath(shown, GUID, 2, 2, Stand, false, context());
  assert.equal(shown.held, 2, "another unit with the bow out keeps it at a plain start (branch 2)");
});
