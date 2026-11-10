import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { ANIMATION_WEAPON_FLAGS } from "../dist/code/generated/animations.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { setPetSpellAttributesSource } from "../dist/code/world/PetCastSpell.js";
import { OwnAnimationSheath } from "../dist/code/browser/game/OwnAnimationSheath.js";
import { parseSpellVisualKits, parseSpellVisuals } from "../dist/code/gateway/SpellVisual.js";
import {
  kitAnimations, planSpellAuraState, planSpellCastStart, planSpellVisual, planSpellVisualKitEvent,
} from "../dist/code/browser/SpellVisuals.js";
import { startKeep } from "../dist/code/browser/UnitActionArbiter.js";
import { fakeWorldConnection, loginVerifyWorldPacket, settle } from "./fixtures/world-packets.mjs";

/*
 * 5.05 (11.11): the `keep` bit of Wow.exe 0x007385c0's play flags (0x20), which 0x00738180 reads before it puts the
 * weapon away (world/AnimationSheathRule.ts). Only the kit player 0x0073b140 sets it (.runtime/re-2026-10-05/l621/r1.c):
 * from the kit's Flags 0x100, the spell's Attributes 0x40000, or a SpellVisual whose MissileModel is −1 or −2. Every other
 * caller pushes 0, 1, 0x10 or 0x40 (.runtime/re-2026-11-11/combat/playflags.mjs, sheathvis/ac30flags.mjs, d1.c, d2.c).
 */

// ---- the gateway: SpellVisualKit.Flags, Spell.Attributes and SpellVisual.MissileModel → `sheathKeep` ----

function dbcPayload(fieldCount, recordSize, rows) {
  const payload = new Uint8Array(20 + rows.length * recordSize + 1);
  const view = new DataView(payload.buffer);
  payload.set([0x57, 0x44, 0x42, 0x43]); // WDBC
  view.setUint32(4, rows.length, true);
  view.setUint32(8, fieldCount, true);
  view.setUint32(12, recordSize, true);
  view.setUint32(16, 1, true);
  rows.forEach((row, index) => payload.set(row, 20 + index * recordSize));
  return payload;
}

/** SpellVisualKit: 38 fields of 152 bytes; AnimID at 8, Flags at 148 (src/generated/dbcLayouts.ts). */
function kitRow(id, anim, flags = 0) {
  const row = new Uint8Array(152);
  const view = new DataView(row.buffer);
  view.setInt32(0, id, true);
  view.setInt32(4, -1, true);
  view.setInt32(8, anim, true);
  view.setInt32(148, flags, true);
  return row;
}

/** SpellVisual: 32 fields of 128 bytes; CastKit at 8, MissileModel at 32. */
function visualRow(id, castKit, missileModel = 0) {
  const row = new Uint8Array(128);
  const view = new DataView(row.buffer);
  view.setInt32(0, id, true);
  view.setInt32(8, castKit, true);
  view.setInt32(32, missileModel, true);
  return row;
}

/** Spell: 234 fields of 936 bytes; Attributes at 16, SpellVisualID[0] at 524. */
function spellRow(id, visual, attributes = 0) {
  const row = new Uint8Array(936);
  const view = new DataView(row.buffer);
  view.setInt32(0, id, true);
  view.setInt32(16, attributes, true);
  view.setInt32(524, visual, true);
  return row;
}

const names = dbcPayload(7, 28, []);
const kits = dbcPayload(38, 152, [kitRow(20, 54), kitRow(21, 54, 0x100), kitRow(22, 54, 0x20)]);

test("5.05 (11.11): a kit carries `sheathKeep` for its Flags 0x100 and for nothing else", () => {
  const byId = parseSpellVisualKits(kits, names);
  assert.equal(byId.get(20).sheathKeep, undefined);
  assert.equal(byId.get(21).sheathKeep, true, "Flags 0x100");
  assert.equal(byId.get(22).sheathKeep, undefined, "another flag bit is not the keep bit");
});

test("5.05 (11.11): a spell carries `sheathKeep` for Attributes 0x40000 or a MissileModel of −1/−2", () => {
  const visuals = dbcPayload(32, 128, [
    visualRow(10, 20), visualRow(11, 20, -1), visualRow(12, 20, -2), visualRow(13, 20, -3), visualRow(14, 21),
  ]);
  const spells = dbcPayload(234, 936, [
    spellRow(1, 10), spellRow(2, 10, 0x40000), spellRow(3, 11), spellRow(4, 12), spellRow(5, 13), spellRow(6, 14),
    spellRow(7, 10, 0x10000),
  ]);
  const bySpell = parseSpellVisuals(spells, visuals, kits, names);
  const keep = (id) => bySpell.get(id).sheathKeep;
  assert.equal(keep(1), undefined, "a plain spell");
  assert.equal(keep(2), true, "SPELL_ATTR0_DONT_AFFECT_SHEATH_STATE");
  assert.equal(keep(3), true, "MissileModel −1");
  assert.equal(keep(4), true, "MissileModel −2");
  assert.equal(keep(5), undefined, "MissileModel −3 is not one of the two");
  assert.equal(keep(6), undefined, "the kit's own flag stays on the kit");
  assert.equal(bySpell.get(6).cast.sheathKeep, true);
  assert.equal(keep(7), undefined, "another attribute bit");
});

// ---- the plan: the spell's and the kit's halves meet on every animation a kit starts ----

const kit = (animation, extra = {}) => ({ startAnimation: -1, animation, effects: [], sound: 0, ...extra });
const point = { x: 0, y: 0, z: 0 };
const cast = { caster: 1n, casterPoint: point, targets: [{ guid: 2n, point }] };

test("5.05 (11.11): kit animations are marked `keep` by the spell's flag or the kit's, and only then", () => {
  assert.equal(kitAnimations(kit(54), 1n, 0, 0, "once", "cast")[0].keep, undefined);
  assert.equal(kitAnimations(kit(54), 1n, 0, 0, "once", "cast", true)[0].keep, true, "the spell's half");
  assert.equal(kitAnimations(kit(54, { sheathKeep: true }), 1n, 0, 0, "once", "cast")[0].keep, true, "the kit's half");
  const lead = kitAnimations(kit(54, { startAnimation: 52, sheathKeep: true }), 1n, 0, 0, "once", "cast")[0];
  assert.equal(lead.keep, true, "a lead-in and its follow-up are one start of the kit player");

  const plain = { id: 133, cast: kit(54), impact: kit(10), precast: kit(52), state: kit(97) };
  const kept = { ...plain, sheathKeep: true };
  assert.ok(planSpellVisual(plain, cast, 0).animations.every((animation) => animation.keep === undefined));
  const go = planSpellVisual(kept, cast, 0).animations;
  assert.equal(go.length, 2);
  assert.ok(go.every((animation) => animation.keep === true), "the cast kit on the caster and the impact on the target");
  assert.equal(planSpellCastStart(kept, { ...cast, castTime: 2000 }, 0).animations[0].keep, true);
  assert.equal(planSpellCastStart(plain, { ...cast, castTime: 2000 }, 0).animations[0].keep, undefined);
  assert.equal(planSpellAuraState(kept, { guid: 2n, point }, 0).animations[0].keep, true);
  assert.equal(planSpellVisualKitEvent(kit(69), { guid: 2n, point }, 0).animations[0].keep, undefined,
    "a packet's kit has no spell and no visual");
  assert.equal(planSpellVisualKitEvent(kit(69, { sheathKeep: true }), { guid: 2n, point }, 0).animations[0].keep, true);
});

test("5.05 (11.11): which starts carry the bit: a kit's from its plan, none other; a semantic spell pose is not judged", () => {
  const visual = { source: "visual", action: undefined };
  assert.equal(startKeep({ ...visual, keep: true }), true);
  assert.equal(startKeep(visual), false);
  assert.equal(startKeep({ source: "external", action: "attack" }), false, "a swing");
  assert.equal(startKeep({ source: "external", action: "shoot" }), false, "a shot");
  assert.equal(startKeep({ source: "external", action: undefined }), false, "an emote, a reaction");
  assert.equal(startKeep({ source: "external", action: "precast" }), undefined, "a kit whose spell is not known here");
});

// ---- the renderer: the entry carries the bit, the count publishes the last start's ----

const RENDERER = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");

function rendererMethods(names, dependencies = {}) {
  const parsed = ts.createSourceFile("WorldRenderer3D.ts", RENDERER, ts.ScriptTarget.Latest, true);
  const renderer = parsed.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "WorldRenderer3D");
  const members = names.map((name) => {
    const member = renderer.members.find((candidate) => candidate.name?.getText(parsed) === name);
    assert.ok(member, name);
    return member.getText(parsed).replaceAll("#", "");
  });
  const body = ts.transpileModule(`class Harness { ${members.join("\n")} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return Function(...Object.keys(dependencies), `${body}; return Harness;`)(...Object.values(dependencies));
}

test("5.05 (11.11): #setUnitAnimation hands the plan's `keep` to the queued entry", () => {
  const Harness = rendererMethods(["#setUnitAnimation"], {
    ACTION_CLIP_WAIT: 900, ACTION_SIDECAR_WAIT: 3_000, kitWoundAnimation: (animation) => animation,
  });
  const h = new Harness();
  const submitted = [];
  h.submitUnitAction = (guid, request) => submitted.push(request);
  h.meleeTargets = new Set();
  h.setUnitAnimation({ guid: 7n, animation: 54, at: 0, hold: 0, mode: "once", layer: "cast", keep: true }, "visual");
  h.setUnitAnimation({ guid: 7n, animation: 54, at: 0, hold: 0, mode: "once", layer: "cast" }, "visual");
  assert.equal(submitted[0].payload.keep, true);
  assert.equal(submitted[1].payload.keep, undefined);
});

test("5.05 (11.11): the player's starts are counted with the last one's bit; another model's and an unjudged one are not", () => {
  const Harness = rendererMethods(["#noteStart", "#publishOwnAnimation"]);
  const h = new Harness();
  const self = { animationId: 54, overlayAction: undefined, overlayAnimationId: undefined };
  Object.assign(h, { selfModel: self, selfStarts: 0, selfKeep: false, startKeep: false, results: { ownAnimation: undefined } });
  h.startKeep = true;
  h.noteStart(self);
  h.publishOwnAnimation(5n, self);
  assert.deepEqual(h.results.ownAnimation, { guid: 5n, animation: 54, starts: 1, keep: true });
  h.startKeep = undefined;
  h.noteStart(self);
  h.startKeep = false;
  h.noteStart({});
  h.publishOwnAnimation(5n, self);
  assert.equal(h.results.ownAnimation.starts, 1, "neither an unjudged start nor another model's moves the count");
  self.animationId = 0;
  h.noteStart(self);
  h.publishOwnAnimation(5n, self);
  assert.deepEqual(h.results.ownAnimation, { guid: 5n, animation: 0, starts: 2, keep: false });
});

// ---- the page: OwnAnimationSheath → WorldClient → CMSG_SET_SHEATHED ----

const SELF = 0x1234n;
const VICTIM = 0x5678n;

async function client() {
  const connection = fakeWorldConnection([{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: loginVerifyWorldPacket() }]);
  const world = new WorldClient(connection);
  world.state.selfGuid = SELF;
  world.state.move(SELF, { flags: 0, position: { x: 10, y: 20, z: 30, orientation: 0 } });
  await world.loginCharacter(SELF);
  await settle();
  world.state.move(VICTIM, { flags: 0, position: { x: 12, y: 20, z: 30, orientation: 0 } });
  world.state.objects.get(VICTIM).typeId = 3;
  world.state.setField(VICTIM, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  world.selectTarget(VICTIM);
  connection.sent.length = 0;
  const sheaths = () => connection.sentOf(OPCODES.CMSG_SET_SHEATHED).map(({ payload }) => payload[0]);
  return { world, sheaths };
}

const dataSkip = { skip: ANIMATION_WEAPON_FLAGS[54] === 4 ? false : "no generated AnimationData.Weaponflags in this checkout" };

test("5.05 (11.11): after a fight a spell kit's SpellCastOmni puts the blade away, unless the kit keeps it", dataSkip, async () => {
  const { world, sheaths } = await client();
  const sheath = new OwnAnimationSheath();
  const own = { guid: SELF, animation: 0, starts: 0, keep: false };
  sheath.afterDraw(world, own);
  world.startAttack();
  world.stopAttack();
  assert.deepEqual(sheaths(), [1]);
  Object.assign(own, { starts: 1, animation: 54, keep: true }); // SpellCastOmni, Weaponflags 0x4, the kit keeps it
  sheath.afterDraw(world, own);
  assert.deepEqual(sheaths(), [1], "branch 1 skipped: `keep`");
  Object.assign(own, { starts: 2, animation: 54, keep: false });
  sheath.afterDraw(world, own);
  assert.deepEqual(sheaths(), [1, 0], "a kit without the bit puts it away");
  world.close();
});

test("5.05 (11.11): a channel is not the cast in progress (+0xa60): a Ready1H start draws the blade under it", dataSkip, async () => {
  const { world, sheaths } = await client();
  const sheath = new OwnAnimationSheath();
  const own = { guid: SELF, animation: 0, starts: 0, keep: false };
  sheath.afterDraw(world, own);
  setPetSpellAttributesSource((spellId) => (spellId === 5143 ? [0x10000, 0, 0, 0, 0, 0, 0, 0] : undefined));
  try {
    world.casts.set(SELF, { spellId: 5143, castTime: 5000, channel: true, startedAt: 0 });
    Object.assign(own, { starts: 1, animation: 26 }); // Ready1H, Weaponflags 0x20
    sheath.afterDraw(world, own);
    assert.deepEqual(sheaths(), [1], "branch 5 draws melee: no cast bar to sheathe for");
    world.casts.set(SELF, { spellId: 5143, castTime: 5000, channel: false, startedAt: 0 });
    Object.assign(own, { starts: 2, animation: 26 });
    sheath.afterDraw(world, own);
    assert.deepEqual(sheaths(), [1, 0], "the same spell as a cast bar: branch 3 puts it away");
  } finally {
    setPetSpellAttributesSource(undefined);
    world.casts.delete(SELF);
  }
  world.close();
});
