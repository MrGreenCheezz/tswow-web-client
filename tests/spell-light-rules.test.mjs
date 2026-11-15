// 26.10 (6.27, owner: «болезнь логически не должна светить»): a disease, a poison or a curse gives no spell light in
// the enhanced profile — by the spell's DispelType, or by the effect model's own name where the spell says nothing
// (the wolves' cosmetic «Поражение болезнью», 71764: physical, DispelType 0, `BestowDisease_Impact_Chest.m2`).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  planSpellAuraState, planSpellAuraDone, spellGivesNoLight, spellModelGivesNoLight,
} from "../dist/code/browser/SpellVisuals.js";
import { spellLightKind } from "../dist/code/browser/SpellLightKind.js";
import { SpellVisualClient } from "../dist/code/browser/SpellVisualClient.js";

const kit = (path) => ({ startAnimation: -1, animation: -1, effects: [{ path, attachment: 34, scale: 1 }] });
const point = { x: 0, y: 0, z: 0 };

test("dispel types: curse, disease and poison give no light; magic, enrage and none do", () => {
  for (const type of [2, 3, 4]) assert.equal(spellGivesNoLight(type), true, String(type));
  for (const type of [undefined, 0, 1, 5, 9]) assert.equal(spellGivesNoLight(type), false, String(type));
});

test("effect models: a disease, plague, poison, curse or blight by its file name gives no light; its cure still does", () => {
  for (const path of [
    "Spells\\BestowDisease_Impact_Chest.m2", "Spells\\Poison_ImpactDot_Med_Base.m2", "Spells\\DeathKnight_PlagueStrikeState.m2",
    "Spells\\CurseofAgony_Head.m2", "Spells\\DeathKnight_UnholyBlight_State.m2", "spells/plague_gas_orange_02.m2",
  ]) assert.equal(spellModelGivesNoLight(path), true, path);
  for (const path of [
    "Spells\\NullifyPoison_Base.m2", "Spells\\AbolishDisease_Base.m2", "Spells\\Fireball_Missile_High.m2",
    "Spells\\HolyProtection_Chest.m2", "Spells\\ShadowProtection_Chest.m2", "Spells\\ThunderClap_Impact_Base.m2",
  ]) assert.equal(spellModelGivesNoLight(path), false, path);
  // Only the file name is read: a folder that happens to say "poison" does not darken a fireball in it.
  assert.equal(spellModelGivesNoLight("World\\Poisonous\\Fire_Base.m2"), false);
});

test("plans: every instance of a curse/disease/poison spell is marked; another spell's are not", () => {
  const disease = { id: 1, state: kit("Spells\\Fire_State.m2"), stateDone: kit("Spells\\Fire_Done.m2"), dispelType: 3 };
  const magic = { ...disease, id: 2, dispelType: 1 };
  assert.ok(planSpellAuraState(disease, { guid: 5n, point }, 0, 1000).instances.every((instance) => instance.noLight === true));
  assert.ok(planSpellAuraDone(disease, { guid: 5n, point }, 0).instances.every((instance) => instance.noLight === true));
  assert.ok(planSpellAuraState(magic, { guid: 5n, point }, 0, 1000).instances.every((instance) => instance.noLight === undefined));
});

// 13.09 (pins9): the light kind is a function of its own (SpellLightKind.ts), checked by what it answers.
test("light kind: a marked or diseased instance gives none; a missile, a held aura and a burst each their own", () => {
  const instance = (fields) => ({ path: "Spells\\Fire_State.m2", flight: undefined, modelPlayback: "once", ...fields });
  assert.equal(spellLightKind(instance({})), "burst");
  assert.equal(spellLightKind(instance({ modelPlayback: "hold" })), "aura");
  assert.equal(spellLightKind(instance({ flight: {} })), "missile");
  assert.equal(spellLightKind(instance({ noLight: true })), undefined, "a curse, disease or poison spell's instance");
  assert.equal(spellLightKind(instance({ modelPlayback: "hold", path: "Spells\\BestowDisease_Impact_Chest.m2" })), undefined,
    "a disease by the model's own name");
});

// 13.09 (pins9): the client half is behaviour — what the visual client accepts. The gateway half reads the DBC and is
// covered by the gateway route tests; what stays pinned is the renderer's use of the kind at both light sites.
test("wiring: the client accepts a positive DispelType and refuses a malformed one; the renderer asks the kind at both sites", async () => {
  const original = globalThis.fetch;
  const impact = { startAnimation: -1, animation: -1, effects: [], sound: 0 };
  const ask = async (answer) => {
    globalThis.fetch = async () => ({ ok: true, async json() { return [answer]; } });
    const client = new SpellVisualClient("http://localhost:8090/ws");
    const errors = [];
    client.onStatus = (message, error) => { if (error) errors.push(message); };
    client.get(answer.id);
    for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setImmediate(resolve));
    return { visual: client.get(answer.id), errors };
  };
  try {
    const disease = await ask({ id: 1, dispelType: 3, impact });
    assert.equal(disease.visual?.dispelType, 3, "a disease's DispelType reaches the plan");
    const malformed = await ask({ id: 2, dispelType: -1, impact });
    assert.equal(malformed.visual, undefined, "a malformed DispelType is not taken");
    assert.equal(malformed.errors.length, 1, "it is reported as an invalid answer");
  } finally {
    globalThis.fetch = original;
  }
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  // Protects the two call sites (a unit's held spell light, the visuals' own lights): no behaviour check reaches them
  // without a whole renderer.
  assert.match(renderer, /spellLightKind\(entry\.spell\.instance\)/);
  assert.match(renderer, /spellLightKind\(visual\.instance\)/);
});
