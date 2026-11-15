import assert from "node:assert/strict";
import test from "node:test";
import { RangedRepeatMarks } from "../dist/code/world/RangedRepeatMarks.js";
import { RenderInputsReceiver, RenderInputsSender } from "../dist/code/browser/RenderTablesBridge.js";
import { NO_RENDER_INPUTS } from "../dist/code/browser/RenderInputs.js";

// 5.05 (15.11, bow9): Wow.exe's auto-repeat mark +0xa38 0x200 (0x007fa2e0 from 0x00805330: the own send and every
// SMSG_SPELL_START without CAST_FLAG_PENDING; cleared by 0x0072d130 and 0x00807560) and the ammo display 0x00806700 hands
// 0x007206a0 for a REQ_AMMO spell. The attribute words are the dataset's rows (`/dbc/spells?v=19`, read 15.11):
// Auto Shot 75 [327698,0,32,…], wand Shoot 5019 [18,0,32,…], Arcane Shot 3044 [65538,0,131072,…], Throw 2764
// [4259858,512,1048576,…].
const ROWS = new Map([
  [75, [327698, 0, 32, 32768, 16777217, 0, 0, 0]],
  [5019, [18, 0, 32, 32768, 0, 0, 0, 0]],
  [3044, [65538, 0, 131072, 0, 0, 0, 0, 0]],
  [2764, [4259858, 512, 1048576, 32768, 0, 0, 0, 0]],
]);
const words = (spellId) => ROWS.get(spellId);
const AUTO_SHOT = 75, SHOOT = 5019, ARCANE_SHOT = 3044, THROW = 2764;
const CAST_FLAG_PENDING = 0x1, CAST_FLAG_AMMO = 0x20;
const HUNTER = 0x10n, MAGE = 0x20n;

test("SPELL_START of a repeat spell marks its caster; a pending (triggered) start does not", () => {
  const marks = new RangedRepeatMarks(words);
  marks.spellStart(HUNTER, AUTO_SHOT, CAST_FLAG_AMMO, 5996);
  assert.deepEqual(marks.marks.get(HUNTER), { ammo: 5996, reqAmmo: true });
  marks.spellStart(MAGE, SHOOT, CAST_FLAG_PENDING, undefined);
  assert.equal(marks.marks.has(MAGE), false, "0x00806700 skips 0x00805330 for CAST_FLAG_PENDING");
  marks.spellStart(MAGE, ARCANE_SHOT, CAST_FLAG_AMMO, 5996);
  assert.equal(marks.marks.has(MAGE), false, "no AUTOREPEAT flag");
  marks.spellStart(MAGE, SHOOT, CAST_FLAG_AMMO, 0);
  assert.deepEqual(marks.marks.get(MAGE), { ammo: 0, reqAmmo: true }, "Shoot is REQ_AMMO too: its own pair, none");
  assert.equal(marks.marks.has(0x30n), false);
  const unknown = new RangedRepeatMarks(() => undefined);
  unknown.spellStart(HUNTER, AUTO_SHOT, 0, 5996);
  assert.equal(unknown.marks.size, 0, "a row not yet known marks nothing");
});

test("the ammo: any REQ_AMMO start hands over its display; a mark's record changes only when it does", () => {
  const marks = new RangedRepeatMarks(words);
  marks.ownSend(HUNTER, AUTO_SHOT);
  assert.deepEqual(marks.marks.get(HUNTER), { ammo: 0, reqAmmo: true }, "the own send marks before the start arrives");
  const first = marks.marks.get(HUNTER);
  marks.spellStart(HUNTER, AUTO_SHOT, CAST_FLAG_AMMO, 5996);
  const second = marks.marks.get(HUNTER);
  assert.notEqual(second, first);
  marks.spellStart(HUNTER, AUTO_SHOT, CAST_FLAG_AMMO, 5996);
  assert.equal(marks.marks.get(HUNTER), second, "the same record while nothing changed");
  marks.spellStart(HUNTER, THROW, CAST_FLAG_AMMO, 5998);
  assert.equal(marks.marks.get(HUNTER).ammo, 5998, "Throw is REQ_AMMO: its display replaces the arrow's");
  marks.ownSend(HUNTER, ARCANE_SHOT);
  assert.equal(marks.marks.get(HUNTER).ammo, 5998, "a send of a spell with no repeat flag changes nothing");
});

test("SMSG_CANCEL_AUTO_REPEAT and the own cancel clear the mark; a gone unit is pruned", () => {
  const marks = new RangedRepeatMarks(words);
  marks.spellStart(HUNTER, AUTO_SHOT, CAST_FLAG_AMMO, 5996);
  marks.spellStart(MAGE, SHOOT, CAST_FLAG_AMMO, 0);
  marks.cancel(HUNTER);
  assert.equal(marks.marks.has(HUNTER), false);
  marks.spellStart(HUNTER, AUTO_SHOT, 0, undefined);
  assert.equal(marks.marks.get(HUNTER).ammo, 0, "the start's own pair: none");
  marks.prune((guid) => guid !== MAGE);
  assert.equal(marks.marks.has(MAGE), false);
  assert.equal(marks.marks.has(HUNTER), true);
});

test("the marks cross to the render worker as differences", () => {
  const marks = new RangedRepeatMarks(words);
  const sender = new RenderInputsSender();
  const receiver = new RenderInputsReceiver();
  const inputs = (rangedRepeat) => ({ ...NO_RENDER_INPUTS, rangedRepeat });
  marks.spellStart(HUNTER, AUTO_SHOT, CAST_FLAG_AMMO, 5996);
  let got = receiver.apply(sender.encode(inputs(marks.marks)));
  assert.deepEqual([...got.rangedRepeat], [[HUNTER, { ammo: 5996, reqAmmo: true }]]);
  const quiet = sender.encode(inputs(marks.marks));
  assert.equal(quiet.rangedRepeat, undefined, "nothing changed, nothing sent");
  marks.cancel(HUNTER);
  got = receiver.apply(sender.encode(inputs(marks.marks)));
  assert.equal(got.rangedRepeat.size, 0);
});
