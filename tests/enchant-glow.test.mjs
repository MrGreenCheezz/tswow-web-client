import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import {
  attachedGlowTint,
  enchantGlowTint,
  visibleItemEnchants,
} from "../dist/code/browser/ItemEnchantments.js";

// M1: an enchanted blade glows in its art's own colour family.
//
// The chain is data all the way down: the unit's visible-enchant word names the enchant id,
// `ItemVisual` names the glow, `ItemVisuals` slots name the models, and only the last step —
// model filename to tint — is a reading of the art, pinned below model by model.

const HEAD = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
const STRIDE = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - HEAD;

function playerWith(slot, perm, temp = 0) {
  return {
    guid: 1n, typeId: 4,
    fields: new Map([[HEAD + slot * STRIDE + 1, ((temp & 0xffff) << 16) | (perm & 0xffff)]]),
  };
}

test("the visible-enchant word splits into permanent and temporary ids", () => {
  assert.deepEqual(visibleItemEnchants(playerWith(15, 1900, 7), 15), { perm: 1900, temp: 7 });
  assert.deepEqual(visibleItemEnchants(playerWith(16, 0), 16), { perm: 0, temp: 0 });
  assert.deepEqual(visibleItemEnchants({ guid: 2n, typeId: 4, fields: new Map() }, 15),
    { perm: 0, temp: 0 }, "a word that never arrived is no enchant");
});

test("filename colour and element words become tints with tiered strength", () => {
  assert.deepEqual(enchantGlowTint(["Spells\\Enchantments\\WhiteGlow_Low.mdx"]), { color: 0xf2f5f8, intensity: 0.45 });
  assert.deepEqual(enchantGlowTint(["Spells\\Enchantments\\RedGlow_High.mdx"]), { color: 0xff3b30, intensity: 0.9 });
  assert.deepEqual(enchantGlowTint(["Spells\\Enchantments\\BlueGlow_Med.mdx"]), { color: 0x3f8fdd, intensity: 0.65 });
  assert.deepEqual(enchantGlowTint(["Spells\\Enchantments\\PurpleFlame_Low.mdx"]), { color: 0xa64ee8, intensity: 0.45 });
  assert.deepEqual(enchantGlowTint(["Spells\\Enchantments\\Shaman_Fire.mdx"]), { color: 0xff5a1a, intensity: 0.65 },
    "element words glow in their element; no tier word means the middle strength");
  assert.deepEqual(enchantGlowTint(["Spells\\Enchantments\\PoisonDrip.mdx"]), { color: 0x4fd06a, intensity: 0.65 });
  assert.deepEqual(enchantGlowTint(["Spells\\Enchantments\\MongooseGlow_High.mdx"]), { color: 0x4fd06a, intensity: 0.9 });
  assert.deepEqual(enchantGlowTint(["Spells\\DeathKnight_FrozenRuneWeapon_State.mdx"]), { color: 0x9fd8ff, intensity: 0.65 });
});

test("models without any colour word stay dark, by name", () => {
  for (const model of ["Spells\\Enchantments\\ExecutionerGlow_High.mdx",
    "Spells\\Enchantments\\DisintigrateGlow_High.mdx",
    "Spells\\Enchantments\\BattlemasterGlow_High.mdx",
    "Spells\\Enchantments\\SpellSurgeGlow_High.mdx"]) {
    assert.equal(enchantGlowTint([model]), undefined, `${model} is a documented gap, not a guessed tint`);
  }
  assert.equal(enchantGlowTint([]), undefined);
});

test("only weapon slots glow, and the fresh coat wins", () => {
  const models = (id) => (id === 7 ? ["Spells\\Enchantments\\PoisonDrip.mdx"]
    : id === 1900 ? ["Spells\\Enchantments\\WhiteGlow_Low.mdx"] : []);
  assert.deepEqual(attachedGlowTint(playerWith(15, 1900, 7), 15, models),
    { color: 0x4fd06a, intensity: 0.65 }, "oil over crusader reads as oil");
  assert.deepEqual(attachedGlowTint(playerWith(15, 1900), 15, models),
    { color: 0xf2f5f8, intensity: 0.45 });
  assert.equal(attachedGlowTint(playerWith(0, 1900), 0, models), undefined, "a helm never glows");
  assert.equal(attachedGlowTint({ guid: 3n, typeId: 3, fields: new Map() }, 15, models), undefined,
    "creatures carry no visible items");
  assert.equal(attachedGlowTint(playerWith(15, 0), 15, models), undefined);
});

test("the dataset resolves the famous enchants to their models", async () => {
  const { dbcDirectory } = await import("../tools/paths.mjs");
  const { loadItemEnchantments } = await import("../dist/code/gateway/ItemEnchantments.js");
  const data = await loadItemEnchantments(await dbcDirectory());
  const byId = new Map(data.enchantments.map((row) => [row.id, row]));
  assert.equal(byId.get(1900)?.visual, 103, "crusader names its ItemVisual");
  assert.equal(byId.get(2673)?.visual, 155, "mongoose names its own");
  assert.deepEqual(data.visuals["1900"], ["Spells\\Enchantments\\WhiteGlow_Low.mdx"]);
  assert.deepEqual(data.visuals["2673"], ["Spells\\Enchantments\\MongooseGlow_High.mdx"]);
  assert.equal(data.visuals["3738"], undefined, "a stat enchant with ItemVisual 0 glows nothing");
  // The whole chain, gateway to tint, for a blade the test above never touched.
  const models = data.visuals["803"] ?? [];
  assert.ok(models.some((model) => model.includes("RedFlame")), "fiery weapon resolves to its flame");
  assert.deepEqual(enchantGlowTint(models), { color: 0xff3b30, intensity: 0.45 });
});

test("the renderer hangs the tint on cloned materials and lets go of them", async () => {
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(renderer, /setEnchantGlow\(/,
    "the loop pushes a resolver like the selection — never threaded through draw()");
  assert.match(renderer, /glow: EnchantGlow \| undefined/, "the tint rides the wanted entry");
  assert.match(renderer, /glowClones/, "clones are tracked for release");
  assert.match(renderer, /clone\.emissive\.setHex\(item\.glow!\.color\)/, "emissive, never the shared base colour");
  assert.match(renderer, /#disposeAttachedGlow\(node\)/, "a rebuild lets go of the old clones");
  const loop = await readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  // 05.10-A7a-E (6.14): `attachedGlow` carries the ItemVisuals slots beside the tint.
  assert.match(loop, /attachedGlow\(object, slot/, "the frame resolves per worn weapon");
});
