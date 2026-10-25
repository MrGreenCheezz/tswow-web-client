// 26.10 (6.27, owner: «болезнь логически не должна светить»): a disease, a poison or a curse gives no spell light in
// the enhanced profile — by the spell's DispelType, or by the effect model's own name where the spell says nothing
// (the wolves' cosmetic «Поражение болезнью», 71764: physical, DispelType 0, `BestowDisease_Impact_Chest.m2`).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  planSpellAuraState, planSpellAuraDone, spellGivesNoLight, spellModelGivesNoLight,
} from "../dist/code/browser/SpellVisuals.js";

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

test("wiring: the gateway sends DispelType, the client asks v=11 and validates it, the renderer gives no light", async () => {
  const gateway = await readFile(new URL("../src/gateway/SpellVisual.ts", import.meta.url), "utf8");
  assert.match(gateway, /const dispelType = spells\.int\(row, "DispelType"\);/);
  const client = await readFile(new URL("../src/browser/SpellVisualClient.ts", import.meta.url), "utf8");
  assert.match(client, /\/dbc\/spell-visuals\?v=11&ids=/);
  assert.match(client, /visual\["dispelType"\]/);
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(renderer, /if \(instance\.noLight \|\| spellModelGivesNoLight\(instance\.path\)\) return undefined;/);
  assert.match(renderer, /const spellKind = living && entry\.spell \? spellLightKind\(entry\.spell\.instance\) : undefined;/);
  assert.match(renderer, /const kind = spellLightKind\(visual\.instance\);[^\n]*\n\s+if \(!kind\) continue;/);
});
