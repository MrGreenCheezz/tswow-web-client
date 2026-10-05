// 05.10-A7a-E (6.14): enchantment glow from ItemVisuals slots on the weapon's attachments 0…4
// (gateway/ItemEnchantments.ts loadItemVisualSlots, browser/ItemEnchantments.ts, browser/WeaponGlow.ts).
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { loadItemVisualSlots } from "../dist/code/gateway/ItemEnchantments.js";
import { ItemEnchantmentClient, attachedGlow, glowSlots } from "../dist/code/browser/ItemEnchantments.js";
import {
  attachGlowAnchors, detachGlowAnchors, glowAnchorsOf, glowEmitterEntries, glowPlacement, glowSlotsKey, resolveGlowModels,
} from "../dist/code/browser/WeaponGlow.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
let tables;
try {
  tables = dbcDirectory ? await loadItemVisualSlots(dbcDirectory) : undefined;
} catch {
  tables = undefined;
}
const withDataset = { skip: tables ? false : "no ItemVisuals tables in the tswow dataset on this machine" };

const FIVE = Object.freeze(["Spells\\A.m2", null, "Spells\\C.m2", "Spells\\D.m2", "Spells\\E.m2"]);

test("dataset: ItemVisuals keeps its five slot numbers, and displays naming a glow resolve to them", withDataset, () => {
  const filled = [0, 0, 0, 0, 0];
  for (const five of tables.slots.values()) {
    assert.equal(five.length, 5);
    five.forEach((path, slot) => {
      if (path === null) return;
      filled[slot]++;
      assert.match(path, /\.m2$/i, "renamed from .mdx");
    });
  }
  // Measured 05.10; the census before the slice: 80 rows, slots filled 53/60/63/72/64.
  // 05.10, resolved through ItemVisualEffects (a reference outside that table is empty): 78 rows,
  // slots 46/48/53/64/62; 1,382 of the 1,383 displays naming an ItemVisual reach a resolvable one.
  assert.equal(tables.slots.size, 78);
  assert.deepEqual(filled, [46, 48, 53, 64, 62]);
  assert.equal(tables.displayVisual.size, 1382);
});

test("a slot goes on the weapon attachment of the same number, and nowhere else", () => {
  assert.deepEqual(glowPlacement([0, 1, 2, 3, 4], FIVE).map((one) => [one.slot, one.attachment, one.path]), [
    [0, 0, "Spells\\A.m2"], [2, 2, "Spells\\C.m2"], [3, 3, "Spells\\D.m2"], [4, 4, "Spells\\E.m2"],
  ]);
  assert.deepEqual(glowPlacement([1, 3], FIVE).map((one) => one.slot), [3], "slot 1 is empty, slots 0/2/4 have no attachment");
  assert.deepEqual(glowPlacement([], FIVE), [], "a weapon without attachments keeps the tint instead");
});

test("an enchantment's ItemVisual wins over the display's; the temporary enchant is tried first", () => {
  const source = {
    glowSlots: (id) => (id === 10 ? ["Spells\\Enchant.m2", null, null, null, null] : undefined),
    displayGlowSlots: (id) => (id === 500 ? ["Spells\\Legendary.m2", null, null, null, null] : undefined),
  };
  assert.equal(glowSlots([0, 10], 500, source)[0], "Spells\\Enchant.m2");
  assert.equal(glowSlots([7, 0], 500, source)[0], "Spells\\Legendary.m2", "no enchant glow: the display's");
  assert.equal(glowSlots([], undefined, source), undefined);
});

test("the client reads the additive keys, and an older gateway's answer still loads with no slots", async () => {
  const original = globalThis.fetch;
  const base = {
    enchantments: [{ id: 803, name: "Fiery", gemItemId: 0, conditionId: 0, visual: 26, flags: 0 }],
    gems: [], visuals: { 803: ["Spells\\Enchantments\\RedGlow_High.mdx"] },
  };
  try {
    globalThis.fetch = async () => ({ ok: true, async json() {
      return { ...base, slots: { 26: FIVE, 27: ["x"] }, displayVisual: { 1234: 26, 99: "no" } };
    } });
    const client = new ItemEnchantmentClient("http://gateway");
    await client.load();
    assert.equal(client.glowSlots(803)[0], "Spells\\A.m2");
    assert.equal(client.displayGlowSlots(1234)[2], "Spells\\C.m2");
    assert.equal(client.itemVisualSlots.has(27), false, "a malformed slot set is skipped");
    assert.equal(client.displayVisuals.has(99), false);
    globalThis.fetch = async () => ({ ok: true, async json() { return base; } });
    const old = new ItemEnchantmentClient("http://gateway");
    await old.load();
    assert.equal(old.glowSlots(803), undefined);
    assert.equal(old.ready, true);
  } finally {
    globalThis.fetch = original;
  }
});

test("attachedGlow carries both the slots and the tint fallback for a worn weapon", () => {
  const first = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
  const stride = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - first;
  const player = { typeId: 4, fields: new Map([[first + 15 * stride + 1, 803]]) };
  const source = {
    glowModels: () => ["Spells\\Enchantments\\RedGlow_High.mdx"],
    glowSlots: (id) => (id === 803 ? FIVE : undefined),
    displayGlowSlots: () => undefined,
  };
  const glow = attachedGlow(player, 15, source);
  assert.equal(glow.slots, FIVE);
  assert.ok(glow.intensity > 0, "the tint stays available for a weapon with no attachments");
  assert.equal(attachedGlow(player, 1, source), undefined, "a helmet never glows");
  const noWord = attachedGlow(player, 15, { ...source, glowModels: () => ["Spells\\Enchantments\\ExecutionerGlow.mdx"] });
  assert.equal(noWord.intensity, 0, "no colour word: slots only");
});

test("anchors sit at the attachment points in the weapon's model space and leave with it", () => {
  const mesh = new THREE.Object3D();
  const itemModel = { attachments: [{ id: 0, bone: 0, position: [0, 0, 0.1] }, { id: 3, bone: 0, position: [0, 0, 1.2] }] };
  const anchors = attachGlowAnchors(mesh, itemModel, glowPlacement([0, 3], FIVE), "unit:5:glow:15/right");
  assert.deepEqual(anchors.map((one) => [one.key, one.anchor.position.z]), [
    ["unit:5:glow:15/right:0", 0.1], ["unit:5:glow:15/right:3", 1.2],
  ]);
  const models = new Map([["Spells\\A.m2", { particleEmitters: [{}], ribbonEmitters: [] }], ["Spells\\D.m2", { particleEmitters: [], ribbonEmitters: [] }]]);
  resolveGlowModels(mesh, (path) => models.get(path));
  const entries = [];
  glowEmitterEntries(mesh, 4, (key, wvm, distance, visual) => ({ key, distance, visual }), entries);
  assert.deepEqual(entries.map((entry) => entry.key), ["unit:5:glow:15/right:0"], "a model without emitters adds nothing");
  assert.equal(entries[0].visual.parent, mesh);
  detachGlowAnchors(mesh);
  assert.equal(mesh.children.length, 0);
  assert.equal(glowAnchorsOf(mesh), undefined);
});

test("the slot set's key is stable per array and distinguishes sets", () => {
  assert.equal(glowSlotsKey(FIVE), glowSlotsKey(FIVE));
  assert.notEqual(glowSlotsKey(FIVE), glowSlotsKey([null, null, null, null, "Spells\\A.m2"]));
  assert.equal(glowSlotsKey(undefined), "");
});
