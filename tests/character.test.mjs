import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { BODY_SECTIONS, BODY_TEXTURE_SIZE, CharacterAppearanceIndex } from "../dist/code/gateway/CharacterAppearance.js";
import { loadCreatureModelMetadata } from "../dist/code/gateway/CreatureModelMetadata.js";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };
const visualDbcDirectory = resolve(
  process.env.VISUAL_DBC_DIR ?? join(process.cwd(), "data", "visual-dbc"));
let patchWVisuals = false;
try {
  const stamp = JSON.parse(readFileSync(resolve(
    visualDbcDirectory, "CreatureModelData.dbc.src"), "utf8"));
  patchWVisuals = stamp.sources?.some((source) => /^patch-w\.mpq$/i.test(source.name)) === true;
} catch {
  patchWVisuals = false;
}
const withVisualDbc = {
  skip: dbcDirectory && patchWVisuals
    && existsSync(resolve(visualDbcDirectory, "CharSections.dbc"))
    ? false
    : "no extracted client visual DBC overlay on this machine",
};

let index;
async function load() {
  index ??= await CharacterAppearanceIndex.load(dbcDirectory);
  return index;
}

test("the body sections tile the 512x512 texture without overlapping", () => {
  // 3.3.5 has no CharComponentTextureSections, so these rectangles are hardcoded here and in the
  // browser. If they drifted apart, a face would land on a thigh. Checking that they tile is the
  // cheapest way to catch a typo in either copy.
  const covered = new Uint8Array(BODY_TEXTURE_SIZE * BODY_TEXTURE_SIZE);
  for (const [name, rect] of Object.entries(BODY_SECTIONS)) {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        assert.equal(covered[y * BODY_TEXTURE_SIZE + x], 0, `${name} overlaps another section at ${x},${y}`);
        covered[y * BODY_TEXTURE_SIZE + x] = 1;
      }
    }
  }
  assert.equal(covered.indexOf(0), -1, "every pixel of the body texture belongs to a section");
});

test("a human male gets a face, a scalp, a beard and underwear", withDataset, async () => {
  const appearance = (await load()).forPlayer(1, 0, 2, 3, 4, 2, 5);

  const sections = appearance.body.map((layer) => layer.section ?? "base");
  // The base skin is the whole 512x512; everything after it lands in a rectangle.
  assert.equal(sections[0], "base");
  assert.ok(sections.includes("faceLower"), "the lower face is painted on");
  assert.ok(sections.includes("faceUpper"), "the upper face is painted on");
  assert.ok(sections.includes("legUpper"), "underwear lands on the pelvis");
  assert.ok(appearance.body.every((layer) => /\.blp$/i.test(layer.path)), "every layer names a BLP");

  // Two pieces on each face rectangle: the face itself and the facial hair over it.
  assert.equal(sections.filter((section) => section === "faceLower").length >= 2, true);
  assert.ok(appearance.hair.length > 0, "a hairstyle has a hair texture");
});

test("only the chosen geosets are drawn, and never the death knight eye glow", withDataset, async () => {
  const appearance = (await load()).forPlayer(1, 0, 0, 0, 4, 0, 3);
  // Exactly one hairstyle: ids 0..99 are the hairstyles and CharHairGeosets picks one.
  const hair = appearance.geosets.filter((geoset) => geoset < 100);
  assert.ok(hair.length >= 1 && hair.length <= 2, `expected one hairstyle (plus scalp), got ${hair}`);

  // At most one variant per family.
  const families = new Map();
  for (const geoset of appearance.geosets.filter((value) => value >= 100)) {
    const family = Math.floor(geoset / 100);
    assert.equal(families.has(family), false, `family ${family} has more than one variant`);
    families.set(family, geoset);
  }

  // A human model carries 1703 and nothing else in family 17 — the death knight glow. Drawing
  // every geoset therefore put glowing eyes on every humanoid in the game.
  assert.equal(appearance.geosets.some((geoset) => geoset >= 1700 && geoset < 1800), false,
    "no eye glow unless something explicitly asks for one");

  // Ears are 702, not 701. 701 is the two-to-ten triangle plug a helm leaves behind; night elves
  // and trolls do not even carry it, so 701 left them with a hole where an ear should be.
  assert.ok(appearance.geosets.includes(702), "ears show the ear mesh, not the plug");
  assert.equal(appearance.geosets.includes(701), false);

  // Bare hands, bare feet, plain legs and the collar. Without these a character has no hands and
  // no feet at all, because nothing else in the model covers those families.
  for (const bare of [401, 501, 1301, 1501]) {
    assert.ok(appearance.geosets.includes(bare), `an unequipped character shows ${bare}`);
  }
});

test("every race and sex resolves to something drawable", withDataset, async () => {
  const appearanceIndex = await load();
  let withFace = 0;
  let withHair = 0;
  let total = 0;
  // Playable races in 3.3.5: 1-11 without 9.
  for (const race of [1, 2, 3, 4, 5, 6, 7, 8, 10, 11]) {
    for (const sex of [0, 1]) {
      total++;
      const appearance = appearanceIndex.forPlayer(race, sex, 0, 0, 0, 0, 0);
      assert.ok(appearance.body.length > 0, `race ${race} sex ${sex} has no body layers`);
      assert.ok(appearance.geosets.length > 0, `race ${race} sex ${sex} has no geosets`);
      if (appearance.body.some((layer) => layer.section === "faceLower")) withFace++;
      // Hairstyle 0 is bald for several races, so ask for a real one before expecting a texture.
      if (appearanceIndex.forPlayer(race, sex, 0, 0, 2, 0, 0).hair) withHair++;
    }
  }
  assert.equal(withFace, total, "every race and sex has a face overlay");
  assert.equal(withHair, total, `every race and sex has a hair texture for hairstyle 2, got ${withHair}/${total}`);
});

test("a creature wearing a character model uses its baked body", withDataset, async () => {
  const appearanceIndex = await load();
  // CreatureDisplayInfoExtra ids are dense from 1; find one that has a bake.
  let baked;
  for (let id = 1; id < 400 && !baked; id++) {
    const appearance = appearanceIndex.forNpc(id);
    if (appearance && appearance.body.length === 1 && !appearance.body[0].section) baked = appearance;
  }
  assert.ok(baked, "some extended display should carry a baked texture");
  // A bake is a finished body, so it replaces the layers rather than sitting on top of them.
  assert.match(baked.body[0].path, /BakedNpcTextures/i);
  assert.ok(baked.geosets.length > 0);
});

test("an HD model uses the visual patch's extra skin, bake and display mapping", withVisualDbc, async () => {
  const appearances = await CharacterAppearanceIndex.load(
    dbcDirectory, undefined, visualDbcDirectory, true);
  const tauren = appearances.forPlayer(6, 0, 0, 0, 0, 0, 0);
  assert.match(tauren.skinExtra, /TaurenMaleSkin00_00_Extra\.blp$/i,
    "the HD hide samples texture type 8, which the dataset DBC does not name");

  const npc = appearances.forNpc(1526);
  assert.ok(npc, "the HD display's extended appearance exists");
  assert.match(npc.body[0]?.path ?? "", /CreatureDisplayExtra-01526_HD\.blp$/i,
    "an HD character model must not receive the stock hashed NPC bake");

  // NPCs take the same no-equipment path as players before an optional bake replaces the body.
  // Display 16's active extended record is a baked HumanMale, so its authored neutral waist must
  // survive the bake and reach the creature-model payload as well.
  const bakedHuman = appearances.forNpc(3265);
  assert.ok(bakedHuman?.body.length === 1 && !bakedHuman.body[0]?.section,
    "the NPC neutral-belt fixture is a baked appearance");
  assert.ok(bakedHuman.geosets.includes(1801),
    `the baked HumanMale NPC keeps its neutral belt: ${bakedHuman.geosets}`);

  const models = await loadCreatureModelMetadata(dbcDirectory, undefined, visualDbcDirectory, true);
  assert.equal(models.get(14)?.model, "Character\\Human\\Female\\HumanFemale.m2",
    "the display id must resolve through the same visual DBCs as the installed model patch");
});

test("equipment paints its component textures and shows its geosets", withDataset, async () => {
  const appearanceIndex = await load();
  const bare = appearanceIndex.forPlayer(1, 0, 2, 3, 4, 2, 5);
  // Layered Tunic, Recruit's Pants, Recruit's Boots, Thick Cloth Gloves, a belt and a cloak.
  const dressed = appearanceIndex.forPlayer(1, 0, 2, 3, 4, 2, 5, [
    { slot: 4, inventoryType: 5, displayId: 16891 },
    { slot: 6, inventoryType: 7, displayId: 9892 },
    { slot: 7, inventoryType: 8, displayId: 10141 },
    { slot: 9, inventoryType: 10, displayId: 16779 },
    { slot: 5, inventoryType: 6, displayId: 6847 },
    { slot: 14, inventoryType: 16, displayId: 15120 },
  ]);

  assert.ok(dressed.body.length > bare.body.length, "armour adds layers");
  const armour = dressed.body.slice(bare.body.length);
  assert.ok(armour.every((layer) => layer.path.startsWith("Item\\TextureComponents\\")),
    "armour layers come from the item component tree");
  assert.ok(armour.every((layer) => layer.section), "every armour layer names a body section");

  // Armour is painted after the skin and the underwear, or it would be covered by them.
  assert.deepEqual(bare.body, dressed.body.slice(0, bare.body.length));

  // Component textures ship as _M/_F or as _U, and only the archives know which; both are offered.
  assert.ok(armour.every((layer) => /_[MF]\.blp$/i.test(layer.path)));
  assert.ok(armour.every((layer) => /_U\.blp$/i.test(layer.alternate ?? "")));

  // Gloves and the cloak change the silhouette; the rest of this set only changes the skin.
  // GeosetGroup is zero-based against one-based variants, so a value of 1 is variant 2: dropping
  // that +1 gave a gloved character the bare hand, 401, and a cloak the collar it should replace.
  assert.ok(dressed.geosets.includes(402), "gloves replace the bare hand");
  assert.equal(dressed.geosets.includes(401), false, "and the bare hand is gone");
  assert.ok(dressed.geosets.some((geoset) => geoset > 1501 && geoset < 1600), "a cloak hangs");
  assert.equal(dressed.geosets.includes(1501), false, "the collar is under the cloak");

  // Equipment replaces a family rather than adding to it. Whatever is not covered stays bare.
  assert.ok(dressed.geosets.includes(702), "a set with no helm leaves the ears alone");
  for (const geoset of dressed.geosets.filter((value) => value >= 100)) {
    assert.equal(dressed.geosets.filter((value) => Math.floor(value / 100) === Math.floor(geoset / 100)).length, 1,
      `family ${Math.floor(geoset / 100)} has more than one variant`);
  }
});

test("an item paints only the sections its own slot owns", withDataset, async () => {
  const appearanceIndex = await load();
  const bare = appearanceIndex.forPlayer(1, 0, 2, 3, 4, 2, 5);

  // Dark Iron Helm. Its ItemDisplayInfo row carries the whole set's components — a sleeve, a
  // chest, trousers — because that is how the table is authored, and 499 of 2,054 head items do
  // the same. A helm is a separate mesh; it must paint nothing at all onto the body.
  const helmed = appearanceIndex.forPlayer(1, 0, 2, 3, 4, 2, 5, [{ slot: 0, inventoryType: 1, displayId: 31671 }]);
  assert.deepEqual(helmed.body, bare.body, "a helm paints nothing onto the body");

  // A belt owns the pelvis and the lower torso, and nothing else, however much its row names.
  const belted = appearanceIndex.forPlayer(1, 0, 2, 3, 4, 2, 5, [{ slot: 5, inventoryType: 6, displayId: 6847 }]);
  const sections = belted.body.slice(bare.body.length).map((layer) => layer.section);
  assert.ok(sections.length > 0, "a belt paints something");
  assert.ok(sections.every((section) => section === "legUpper" || section === "torsoLower"),
    `a belt painted ${sections}`);
});

test("armour paints in slot order, whatever order it arrives in", withDataset, async () => {
  const appearanceIndex = await load();
  // Thick Cloth Gloves and a bracer both land on armLower, and the gauntlet goes on top. The
  // browser sorts its equipment list for cache identity, which put the glove first; the order
  // that matters is decided here instead, so the arriving order cannot change the picture.
  const gear = [{ slot: 9, inventoryType: 10, displayId: 16779 }, { slot: 8, inventoryType: 9, displayId: 16936 }];
  const forwards = appearanceIndex.forPlayer(1, 0, 2, 3, 4, 2, 5, gear);
  const backwards = appearanceIndex.forPlayer(1, 0, 2, 3, 4, 2, 5, [...gear].reverse());
  assert.deepEqual(forwards.body, backwards.body, "the arriving order does not reach the picture");

  const armLower = forwards.body.filter((layer) => layer.section === "armLower");
  assert.equal(armLower.length, 2, "a bracer and a gauntlet both land on the forearm");
  assert.match(armLower[1].path, /Glove/i, "the gauntlet is painted over the bracer");
});

test("a robe replaces the legs instead of doubling them", withDataset, async () => {
  const appearanceIndex = await load();
  // Apprentice's Robe over Recruit's Pants. The robe skirt and the plain legs are two variants of
  // one family, and the browser draws every id it is handed — so emitting both would put the
  // trousers inside the skirt.
  const robed = appearanceIndex.forPlayer(1, 0, 2, 3, 4, 2, 5, [
    { slot: 4, inventoryType: 20, displayId: 12647 },
    { slot: 6, inventoryType: 7, displayId: 9892 },
  ]);
  assert.ok(robed.geosets.includes(1302), "a robe shows the full-length skirt");
  assert.equal(robed.geosets.includes(1301), false, "and not the plain legs as well");
});

test("an unknown or empty item changes nothing", withDataset, async () => {
  const appearanceIndex = await load();
  const bare = appearanceIndex.forPlayer(1, 0, 0, 0, 0, 0, 0);
  const withJunk = appearanceIndex.forPlayer(1, 0, 0, 0, 0, 0, 0, [
    { slot: 4, inventoryType: 5, displayId: 999_999 },
    { slot: 4, inventoryType: 99, displayId: 16891 },
  ]);
  // A display id nothing knows about is ignored; an inventory type with no geoset family still
  // paints its textures but adds no geoset, so the character never gains a silhouette by mistake.
  assert.deepEqual(withJunk.geosets, bare.geosets);
});

test("a cloak arrives as a texture, not as a body layer", withDataset, async () => {
  const appearanceIndex = await load();
  // A cloak is the one worn thing with no model of its own: Item\ObjectComponents\Cape holds 194
  // BLPs and not a single M2, because the geometry is already in the character file as geosets
  // 1502 to 1506 and only the picture on it changes. Those five are also the only batches of a
  // character model that sample texture type 2 at all, and nothing had ever filled it.
  const bare = appearanceIndex.forPlayer(1, 0, 2, 3, 4, 2, 5);
  assert.equal(bare.cloak, "", "no cloak, no cape texture");
  assert.ok(bare.geosets.includes(1501), "and the collar shows instead");

  const cloaked = appearanceIndex.forPlayer(1, 0, 2, 3, 4, 2, 5, [{ slot: 14, inventoryType: 16, displayId: 15120 }]);
  // A full path. A bare name would be resolved beside the model that asked for it, which for a
  // character is Character\<Race>\<Sex> — a directory with no capes in it.
  assert.match(cloaked.cloak, /^Item\\ObjectComponents\\Cape\\.+\.blp$/i);
  assert.deepEqual(cloaked.body, bare.body, "a cloak paints nothing onto the skin");
});

test("a creature wearing a character model is described like a player", withDataset, async () => {
  const models = await loadCreatureModelMetadata(dbcDirectory);
  const dressed = [...models.values()].filter((metadata) => metadata.appearance);
  assert.ok(dressed.length > 10_000, `expected thousands of character displays, got ${dressed.length}`);

  // The baked body is a finished 512x512 image and replaces every layer that would have made one.
  // It used to be built with a single backslash inside a template literal, where `\$` is an
  // identity escape rather than a separator, so the path came out as literal "${bake}" text and
  // every one of these was silently dropped.
  const baked = dressed.filter((metadata) => metadata.appearance.body.length === 1
    && !metadata.appearance.body[0].section);
  assert.ok(baked.length > 10_000, `expected thousands of baked bodies, got ${baked.length}`);
  assert.match(baked[0].appearance.body[0].path, /^Textures\\BakedNpcTextures\\[0-9a-f]+\.blp$/i);

  // And it is a whole appearance now, not just a texture: geosets, so the creature has a
  // hairstyle and ears rather than being bald and earless like every other creature in the game.
  assert.ok(baked[0].appearance.geosets.includes(702), "it has ears");
  assert.ok(baked[0].appearance.geosets.length > 3);
});

test("a creature skin keeps the apostrophe in its name", withDataset, async () => {
  const models = await loadCreatureModelMetadata(dbcDirectory);
  // `CreatureDisplayInfo.TextureVariation` had a character class of its own, ASCII and without an
  // apostrophe, that the merge of the eight path validators walked past. It emptied slot 11 on
  // exactly these three displays, and `Creature\KelThuzad\Kel'Thuzad.blp` — 350,724 bytes in
  // `common.MPQ` — is the only skin any of them has: there is no apostrophe-less copy of that file
  // anywhere in the chain, so all three were drawn with an empty slot and painted flat green.
  for (const display of [15945, 23214, 24787]) {
    assert.equal(models.get(display)?.textures, "11:Kel'Thuzad", `display ${display} lost its skin`);
  }

  // And the filter is still a filter: nothing that reaches a slot may hold a separator, because
  // the browser reads a value that does as a full path rather than as a name beside the model.
  // Measured over the whole table: 11,685 non-empty values and not one with a separator in it.
  const withSeparator = [...models.values()]
    .filter((metadata) => metadata.textures.split(",").some((slot) => /[\\/]/.test(slot)));
  assert.deepEqual(withSeparator.map((metadata) => metadata.id), []);
});

test("a helmet, two pauldrons and a weapon become models of their own", withDataset, async () => {
  const appearanceIndex = await load();
  const equip = (slot, inventoryType, displayId) => ({ slot, inventoryType, displayId });

  // Lionheart Helm. The DBC gives a bare stem and the archive holds one file per race and sex,
  // suffixed with ChrRaces.ClientPrefix and M or F, so only the wearer can resolve it.
  const male = appearanceIndex.forPlayer(1, 0, 0, 0, 0, 0, 0, [equip(0, 1, 22920)]);
  const female = appearanceIndex.forPlayer(1, 1, 0, 0, 0, 0, 0, [equip(0, 1, 22920)]);
  const orc = appearanceIndex.forPlayer(2, 0, 0, 0, 0, 0, 0, [equip(0, 1, 22920)]);
  assert.match(male.attached[0].model, /^Item\\ObjectComponents\\Head\\.+_HuM\.m2$/i);
  assert.match(female.attached[0].model, /_HuF\.m2$/i);
  assert.match(orc.attached[0].model, /_OrM\.m2$/i);
  // An item model almost never names its own diffuse; ItemDisplayInfo does, beside the model.
  assert.match(male.attached[0].texture, /^Item\\ObjectComponents\\Head\\.+\.blp$/i);

  // Shoulders are the one slot with two pieces, and they are two separate meshes rather than one
  // mirrored twice.
  const shoulders = appearanceIndex.forPlayer(1, 0, 0, 0, 0, 0, 0, [equip(2, 3, 10167)]);
  assert.equal(shoulders.attached.length, 2);
  assert.deepEqual(shoulders.attached.map((piece) => piece.side), ["left", "right"]);
  assert.notEqual(shoulders.attached[0].model, shoulders.attached[1].model);
  assert.ok(shoulders.attached.every((piece) => /\\Shoulder\\/i.test(piece.model)));

  // A shield shares the off hand with held weapons but lives in its own directory; keying only on
  // the slot sent all 520 of them to Weapon, where none of them is.
  const shield = appearanceIndex.forPlayer(1, 0, 0, 0, 0, 0, 0, [equip(16, 14, 18730)]);
  assert.ok(shield.attached.length > 0 && shield.attached.every((piece) => /\\Shield\\/i.test(piece.model)),
    `shield went to ${shield.attached[0]?.model}`);

  // Armour hangs nothing off a bone, however many models its display row happens to name: 977
  // armour rows carry a leftover helm or pauldron name that must never be rendered.
  const armour = appearanceIndex.forPlayer(1, 0, 0, 0, 0, 0, 0, [
    equip(4, 5, 16891), equip(6, 7, 9892), equip(9, 10, 16779), equip(14, 16, 15120),
  ]);
  assert.deepEqual(armour.attached, []);
});

test("the body is always drawn, whatever hairstyle is on top of it", withDataset, async () => {
  const appearanceIndex = await load();
  // Geoset 0 is the character, not the scalp: 620 of HumanMale's 6,356 triangles, spanning
  // z 0.00 to 1.96 and sampling the body atlas. Every other id in family 0 sits above z 1.5 and
  // samples the hair texture. Drawing it only when CharHairGeosets said the scalp showed left
  // most characters as a hairstyle floating over a pair of hands and boots.
  for (const race of [1, 2, 3, 4, 5, 6, 7, 8, 10, 11]) {
    for (const sex of [0, 1]) {
      for (const style of [0, 1, 2, 3, 5, 8]) {
        const appearance = appearanceIndex.forPlayer(race, sex, 0, 0, style, 0, 0);
        assert.ok(appearance.geosets.includes(0), `race ${race} sex ${sex} hair ${style} has no body`);
      }
    }
  }
});

test("a helmet covers up hair and ears, but not a tauren's horns", withDataset, async () => {
  const appearanceIndex = await load();
  const helm = (displayId) => [{ slot: 0, inventoryType: 1, displayId }];
  const hidden = (race, sex, displayId) => {
    const bare = appearanceIndex.forPlayer(race, sex, 0, 0, 2, 0, 1);
    const helmed = appearanceIndex.forPlayer(race, sex, 0, 0, 2, 0, 1, helm(displayId));
    assert.ok(helmed.geosets.includes(0), "the body stays");
    return new Set(bare.geosets.filter((geoset) => !helmed.geosets.includes(geoset))
      .map((geoset) => (geoset < 100 ? 0 : Math.floor(geoset / 100))));
  };

  // Lionheart Helm: a full helm, and its HelmetGeosetVisData rows are per-race bitmasks rather
  // than booleans. The exclusions are what prove which column is which.
  assert.deepEqual([...hidden(1, 0, 22920)].sort(), [0, 1, 2, 3, 7], "a human male loses hair, beard and ears");
  // A tauren wears a helm over horns, so its hair stays; night elves and trolls keep their ears.
  assert.equal(hidden(6, 0, 22920).has(0), false, "a tauren keeps its horns");
  assert.equal(hidden(4, 0, 22920).has(7), false, "a night elf keeps its ears");
  assert.equal(hidden(8, 0, 22920).has(7), false, "a troll keeps its ears");
  // The scourge jaw is facial hair and stays on; a troll's tusks are family 3 and stay too.
  assert.equal(hidden(5, 0, 22920).has(1), false, "the scourge keeps its jaw");
  assert.equal(hidden(8, 0, 22920).has(3), false, "a troll keeps its tusks");

  // Circlet of Prophecy hides nothing at all, and 169 of the 1,314 head displays are like it.
  assert.equal(hidden(1, 0, 31371).size, 0, "a circlet covers nothing");
});

test("a robe wins the legs it takes the geoset for", withDataset, async () => {
  const appearanceIndex = await load();
  // Geoset 1302, the full-length skirt, lands entirely in the legUpper and legLower rectangles,
  // so whichever item paints those last is what the skirt wears. The robe wins the geoset, so it
  // has to win the texture too — painting it first left 745 of 747 robes wearing the trousers
  // underneath, which is exactly the disagreement the paint order exists to prevent.
  const robed = appearanceIndex.forPlayer(1, 0, 0, 0, 0, 0, 0, [
    { slot: 4, inventoryType: 20, displayId: 12647 },
    { slot: 6, inventoryType: 7, displayId: 9892 },
  ]);
  assert.ok(robed.geosets.includes(1302), "the robe takes the legs");
  const legs = robed.body.filter((layer) => layer.section === "legUpper" || layer.section === "legLower");
  assert.ok(legs.length >= 4, "both garments paint both leg rectangles");
  assert.match(legs[legs.length - 2].path, /Robe/i, "the robe paints legUpper last");
  assert.match(legs[legs.length - 1].path, /Robe/i, "and legLower last");
});

test("night elves, blood elves and the undead keep their glowing eyes", withDataset, async () => {
  const appearanceIndex = await load();
  // CharacterFacialHairStyles has five geoset columns, not three, and the fifth is the racial eye
  // glow — always 2, on 55 of the 172 playable rows. Reading only the first three left 1702 off
  // six models that carry it, so every night elf in the game had dark eyes.
  for (const race of [4, 5, 10]) {
    for (const sex of [0, 1]) {
      assert.ok(appearanceIndex.forPlayer(race, sex, 0, 0, 0, 0, 0).geosets.includes(1702),
        `race ${race} sex ${sex} should glow`);
    }
  }
  // And it is still not handed out to everyone: 1703 is the death knight glow and no race asks
  // for it, which is why every humanoid in this client used to have one.
  for (const race of [1, 2, 3, 6, 7, 8, 11]) {
    const geosets = appearanceIndex.forPlayer(race, 0, 0, 0, 0, 0, 0).geosets;
    assert.equal(geosets.some((geoset) => geoset >= 1700 && geoset < 1800), false, `race ${race} should not glow`);
  }
});

test("a ranged weapon is a model like any other", withDataset, async () => {
  const appearanceIndex = await load();
  // Slot 17 was missing from the directory table, so a hunter's bow and a rogue's thrown weapon
  // resolved to nothing at all.
  // Worn Shortbow.
  const bow = appearanceIndex.forPlayer(1, 0, 0, 0, 0, 0, 0,
    [{ slot: 17, inventoryType: 15, displayId: 8106, subClass: 2 }]);
  assert.equal(bow.attached.length, 1);
  assert.ok(/\\Weapon\\/i.test(bow.attached[0].model), `a bow went to ${bow.attached[0].model}`);
  assert.equal(bow.attached[0].subClass, 2, "the appearance keeps the ranged subclass for pose selection");
});

/** Every extended display that resolves to a tauren, over the ids this dataset uses. */
function taurenNpcs(appearanceIndex) {
  const found = [];
  for (let id = 1; id < 4000; id++) {
    const appearance = appearanceIndex.forNpc(id);
    if (appearance && /Tauren/i.test(appearance.skinExtra ?? "")) found.push(appearance);
  }
  return found;
}

test("Т2 a tauren's skin names the extra texture its horns are painted from, and nobody else's does",
  withDataset, async () => {
    const appearanceIndex = await load();
    // The one texture slot the tauren has and the other eighteen playable profiles do not:
    // TaurenMale and TaurenFemale declare [0,1,2,8] where everyone else declares [0,1,2,6].
    // CharSections' skin row carries it in its *second* slot, beside the base body in the first.
    assert.equal(appearanceIndex.forPlayer(6, 0, 0, 0, 0, 0, 0).skinExtra,
      "Character\\Tauren\\Male\\TaurenMaleSkin00_00_Extra.blp");
    assert.equal(appearanceIndex.forPlayer(6, 1, 0, 0, 0, 0, 0).skinExtra,
      "Character\\Tauren\\Female\\TaurenFemaleSkin00_00_Extra.blp");
    // It follows the skin index rather than being one constant: another hide, another file. The
    // index is the *colour* of skin variation 0, which is the second number in the name.
    assert.equal(appearanceIndex.forPlayer(6, 0, 3, 0, 0, 0, 0).skinExtra,
      "Character\\Tauren\\Male\\TaurenMaleSkin00_03_Extra.blp");

    // And nobody else. Measured over CharSections: of the twenty playable profiles only the two
    // tauren name slot 1 on any skin row, which is exactly the set whose models declare slot 8.
    for (const race of [1, 2, 3, 4, 5, 7, 8, 10, 11]) {
      for (const sex of [0, 1]) {
        assert.equal(appearanceIndex.forPlayer(race, sex, 0, 0, 0, 0, 0).skinExtra, "",
          `race ${race} sex ${sex} named an extra skin texture and has no slot to put it in`);
      }
    }

    // A baked NPC keeps it. A bake is the finished 512x512 type 1 body and cannot reach type 8,
    // so a baked tauren needs the file exactly as much as an assembled one — and 810 of the 814
    // tauren creature displays on this dataset are baked, so that is the common case.
    const baked = taurenNpcs(appearanceIndex).filter((npc) => npc.body.length === 1 && !npc.body[0].section);
    assert.ok(baked.length > 0, "the dataset should have baked tauren NPCs");
    assert.match(baked[0].body[0].path, /BakedNpcTextures/i);
    assert.match(baked[0].skinExtra, /Tauren(Male|Female)Skin\d\d_\d\d_Extra\.blp$/i);
  });

test("Т4 a bald style closes the top of its own skull, and a mohawk keeps its mohawk", withDataset, async () => {
  const appearanceIndex = await load();
  const styles = (race, sex, style) => appearanceIndex.forPlayer(race, sex, 0, 0, style, 0, 0).geosets;

  // `Showscalp` was parsed and read by nothing, and geoset 1 — the cap over the crown — is named
  // by no CharHairGeosets row in any of the twenty playable models. Measured with position-matched
  // boundary edges on the models themselves: a bald HumanMale goes from 38 open edges to 28 with
  // it, GnomeMale 42 to 32 and DraeneiMale 40 to 30, every one of them at the crown.
  assert.ok(styles(1, 0, 0).includes(1), "human male style 0 is bald and has to be capped");
  assert.ok(styles(7, 0, 0).includes(1), "and so is a gnome's");
  assert.ok(styles(11, 0, 8).includes(1), "and a draenei's style 8");
  // A style with hair on it is not capped: the flag is off and the hairstyle covers the crown.
  assert.equal(styles(1, 0, 2).includes(1), false, "human male style 2 has hair and must not be capped");
  assert.equal(styles(4, 0, 0).includes(1), false, "a night elf's style 0 is not a Showscalp style");

  // The troll mohawks are why this adds rather than replaces. wowee writes
  // `useDefaultScalp ? 1 : geosetId` (entity_spawner.cpp:718-727), which here would delete all six
  // of them — and TrollFemale carries no geoset 1 at all, so she would be left with nothing on her
  // head. Both ids go out and the browser drops whichever the model does not carry.
  assert.deepEqual([1, 8].filter((id) => styles(8, 0, 7).includes(id)), [1, 8],
    "a troll male's style 7 keeps its mohawk and gains the cap");
  assert.deepEqual([1, 7].filter((id) => styles(8, 1, 5).includes(id)), [1, 7]);

  // The whole playable sweep, so the change stays as small as it was measured to be: 22 of the
  // 339 CharHairGeosets rows carry the flag, 13 of those are on a playable race, and those 13 are
  // the only answers of 289 that gain the id.
  //
  // Over the styles `CharHairGeosets` has a row for and not over the ones the form offers: since
  // the review those are two different sets — the creation gate takes 98 of them off the menu —
  // and Т4 is a statement about every style the appearance byte can name, which includes the ones
  // an existing character already wears.
  const table = await rawTables();
  let capped = 0;
  let answers = 0;
  for (const race of [1, 2, 3, 4, 5, 6, 7, 8, 10, 11]) {
    for (const sex of [0, 1]) {
      for (const style of table.hairVariations(race, sex)) {
        answers++;
        if (styles(race, sex, style).includes(1)) capped++;
      }
    }
  }
  // 290 distinct (race, sex, style) triples out of 292 playable rows — two are spelt twice — where
  // the offered list is 191 and the pre-review offered list was 289. The one triple neither list
  // has is BloodElfFemale style 19: `CharHairGeosets` gives it geoset 21 and `CharSections` has no
  // row for it at any colour, which is the wig Т3 drops rather than draw untextured.
  assert.equal(answers, 290, `the playable sweep is 290 answers, not ${answers}`);
  assert.equal(capped, 13, `13 of them are Showscalp styles, not ${capped}`);
  assert.ok(!styles(10, 1, 19).includes(21), "and style 19 of a blood elf female has no row to draw from");
});

test("Т1 a display that names no appearance gets the plain look of its own race", withDataset, async () => {
  const appearanceIndex = await load();

  // The race comes off the path, out of ChrRaces.ClientFileString rather than a table written
  // into the client, so a dataset that adds a race is picked up with it. The case is not stable
  // in CreatureDisplayInfo: four of the 74 spell the first component `CHARACTER\`.
  const human = appearanceIndex.forModel("Character\\Human\\Male\\HumanMale.m2");
  assert.ok(human, "a human male model has to resolve");
  assert.ok(human.body.length > 0, "and it has a body to paint, which is what stopped the torso being green");
  assert.deepEqual(human.geosets.filter((id) => id >= 400), [401, 501, 702, 1301, 1501],
    `the classic naked families — hands, shins, ears, thighs, collar — got ${human.geosets}`);
  const naga = appearanceIndex.forModel("CHARACTER\\Naga_\\Male\\Naga_Male.m2");
  assert.match(naga?.skinExtra ?? "", /Naga_MaleSkin00_\d\d_Extra\.blp$/i, "an underscore in a race name is part of it");
  assert.equal(appearanceIndex.forModel("Character\\Human\\Female\\HumanFemale.m2")?.body[0]?.path,
    "Character\\Human\\Female\\HumanFemaleSkin00_00.blp");

  // And nothing else answers. A creature is not a character and must keep drawing geoset 0 alone.
  assert.equal(appearanceIndex.forModel("Creature\\Wolf\\Wolf.m2"), undefined);
  assert.equal(appearanceIndex.forModel("Character\\NotARace\\Male\\NotARaceMale.m2"), undefined);
  assert.equal(appearanceIndex.forModel("Character\\Human\\Neither\\HumanMale.m2"), undefined);
  assert.equal(appearanceIndex.forModel("HumanMale.m2"), undefined);
});

test("Т1 no character display is left without an appearance at all", withDataset, async () => {
  const models = await loadCreatureModelMetadata(dbcDirectory);
  const characters = [...models.values()].filter((metadata) => /^Character\\/i.test(metadata.model));
  assert.ok(characters.length > 15_000, `expected fifteen thousand character displays, got ${characters.length}`);

  // 74 of them used to arrive with no appearance and an empty texture list, which in the browser
  // is geoset 0 alone on a torso painted flat green — a legless, faceless humanoid. Among them
  // were all twenty playable base displays, the most reused humanoid ids in `creature_template`.
  const bare = characters.filter((metadata) => !metadata.appearance);
  assert.deepEqual(bare.map((metadata) => metadata.id), [],
    `${bare.length} character displays still have no appearance`);

  for (const display of [49, 50, 51, 52, 59, 60, 1563, 1478, 15476, 16125]) {
    const metadata = models.get(display);
    assert.ok(metadata?.appearance, `display ${display} is a playable base display and has to be dressed`);
    assert.ok(metadata.appearance.body.length > 0, `display ${display} has no body to paint`);
  }
  // Display 59 is the tauren male, so it is also where the slot-8 file has to survive this path.
  assert.match(models.get(59).appearance.skinExtra, /TaurenMaleSkin\d\d_\d\d_Extra\.blp$/i);
});

test("П2 the display record carries where a rider sits, in model space", withDataset, async () => {
  const models = await loadCreatureModelMetadata(dbcDirectory);

  // 1.8657 is `CreatureModelData.MountHeight` of model 216 and also the z of attachment 0
  // ("MountMain") in `Creature\RidingHorse\RidingHorse.m2`: measured on this machine, they agree
  // to every decimal either tool prints. Display 2404 is the plain riding horse.
  assert.ok(Math.abs(models.get(2404).mountHeight - 1.8657) < 5e-5,
    `RidingHorse: ${models.get(2404).mountHeight}`);

  // Unscaled, unlike `collisionHeight` beside it. FrostWurm carries the tallest seat a mount aura
  // reaches, 8.139, at `CreatureModelScale` 0.75 — so a pre-multiplied column would answer 6.104
  // here and the renderer, which multiplies by the same scale again, would seat its rider at 4.578.
  const wurm = models.get(17255);
  assert.ok(Math.abs(wurm.mountHeight - 8.1390) < 5e-4, `FrostWurm: ${wurm.mountHeight}`);
  assert.ok(Math.abs(wurm.scale - 0.75) < 1e-6, `and it really is drawn at 0.75: ${wurm.scale}`);

  // Zero is a real answer and has to survive as one: 917 of the 1,331 rows of `CreatureModelData`
  // name no seat, and the renderer's third branch — four fifths of the tallest vertex — is reached
  // by exactly this value. These four are the mounts among them that carry no attachment 0 either.
  for (const display of [995, 368, 953, 19996]) {
    assert.equal(models.get(display).mountHeight, 0, `display ${display} names no seat`);
  }

  // And every record answers the field at all, which is what `CreatureModelClient.isMetadata`
  // requires from this slice on: one that does not is refused and its unit keeps its capsule.
  // 18,284 of the 24,262 displays resolve to a model with a seat, because the 414 seated rows of
  // `CreatureModelData` include every playable character model.
  const missing = [...models.values()].filter((metadata) => !Number.isFinite(metadata.mountHeight));
  assert.equal(missing.length, 0, `${missing.length} records have no mountHeight`);
  const seated = [...models.values()].filter((metadata) => metadata.mountHeight > 0);
  assert.ok(seated.length > 15_000, `expected most of the table to carry a seat, got ${seated.length}`);
});

/** The ten playable races, as `ChrRaces` numbers them; 9 is the goblin, which 3.3.5 ships unplayable. */
const PLAYABLE_RACES = [1, 2, 3, 4, 5, 6, 7, 8, 10, 11];

/** Every profile the creation form can put up, and everything it offers for each. */
function everyOffer(appearanceIndex) {
  const offers = [];
  for (const race of PLAYABLE_RACES) {
    for (const sex of [0, 1]) offers.push({ race, sex, options: appearanceIndex.options(race, sex) });
  }
  return offers;
}

/**
 * `CharSections` and `CharHairGeosets` read straight out of the dataset.
 *
 * The tables themselves rather than the index built over them, because these tests are about
 * whether what the index publishes matches what is in the DBC — asking the index both questions
 * would be asking it to mark its own work.
 */
let tables;
async function rawTables() {
  if (tables) return tables;
  const { openDbcFile } = await import("../tools/dbc.mjs");
  const [sections, hair, facial] = await Promise.all([
    openDbcFile(dbcDirectory, "CharSections"),
    openDbcFile(dbcDirectory, "CharHairGeosets"),
    openDbcFile(dbcDirectory, "CharacterFacialHairStyles"),
  ]);
  const rows = new Map();
  const flags = new Map();
  const hairProfiles = new Map();
  for (const row of sections.rows()) {
    const base = sections.int(row, "BaseSection");
    const race = sections.int(row, "RaceID");
    const sex = sections.int(row, "SexID");
    const key = `${base}/${race}/${sex}/${sections.int(row, "VariationIndex")}/${sections.int(row, "ColorIndex")}`;
    if (base === 3) hairProfiles.set(`${race}/${sex}`, (hairProfiles.get(`${race}/${sex}`) ?? 0) + 1);
    if (rows.has(key)) continue;
    rows.set(key, sections.string(row, "TextureName", 0));
    flags.set(key, sections.int(row, "Flags"));
  }
  const geosets = new Map();
  for (const row of hair.rows()) {
    geosets.set(`${hair.int(row, "RaceID")}/${hair.int(row, "SexID")}/${hair.int(row, "VariationID")}`,
      hair.int(row, "GeosetID"));
  }
  const facials = new Map();
  for (const row of facial.rows()) {
    facials.set(`${facial.int(row, "RaceID")}/${facial.int(row, "SexID")}/${facial.int(row, "VariationID")}`,
      [0, 1, 2].map((column) => facial.int(row, "Geoset", column)));
  }
  tables = {
    /** Whether the table has a row for one section, whatever it names. */
    has: (base, race, sex, variation, colour) => rows.has(`${base}/${race}/${sex}/${variation}/${colour}`),
    /** The first texture slot of that row, which is "" on a row that names nothing. */
    texture: (base, race, sex, variation, colour) => rows.get(`${base}/${race}/${sex}/${variation}/${colour}`) ?? "",
    /** `CharSections.Flags` of that row; 0x01 is the core's `SECTION_FLAG_PLAYER`. */
    flags: (base, race, sex, variation, colour) => flags.get(`${base}/${race}/${sex}/${variation}/${colour}`) ?? 0,
    /** How many hair rows the table carries for a profile at all, over every variation and colour. */
    hairSections: (race, sex) => hairProfiles.get(`${race}/${sex}`) ?? 0,
    /** The hairstyle geoset `CharHairGeosets` gives a variation, or undefined if it has no row. */
    hairGeoset: (race, sex, variation) => geosets.get(`${race}/${sex}/${variation}`),
    /** Every variation `CharHairGeosets` has a row for, in order. */
    hairVariations: (race, sex) => [...geosets.keys()]
      .filter((key) => key.startsWith(`${race}/${sex}/`))
      .map((key) => Number(key.split("/")[2]))
      .sort((left, right) => left - right),
    /** The three `CharacterFacialHairStyles` geoset columns of one variation, or undefined. */
    facial: (race, sex, variation) => facials.get(`${race}/${sex}/${variation}`),
    /** What the counts published: the largest index that exists, plus one. */
    counted: (base, race, sex) => {
      let variations = 0;
      let colours = 0;
      for (let variation = 0; variation < 64; variation++) {
        if (rows.has(`${base}/${race}/${sex}/${variation}/0`)) variations = variation + 1;
      }
      for (let colour = 0; colour < 64; colour++) {
        if (rows.has(`${base}/${race}/${sex}/0/${colour}`)) colours = colour + 1;
      }
      return { variations, colours };
    },
  };
  return tables;
}

test("Т3 every look the form offers has a row behind it", withDataset, async () => {
  const appearanceIndex = await load();
  const table = await rawTables();
  // `options()` used to answer the largest index that exists plus one, so a gap inside the range
  // was offered like anything else. Measured over the twenty playable profiles: 10,028 pairs on
  // offer and 1,900 of them with no `CharSections` row — 1,820 faces, 48 hair, 32 facial hair.
  // A face with no row leaves the bare base skin with no eyes or mouth; a hair colour with no row
  // leaves a wig with no texture, which the browser paints flat green.
  //
  // The rectangle is checked here the way the gateway looks it up, because that is the only thing
  // that makes a pair real: a face row is keyed `(face, skin)` and hair and facial-hair rows on
  // `(variation, hairColor)`. The counts are proved wrong on the same table, so that the test
  // fails if the enumeration ever quietly becomes a range again.
  let offered = 0;
  let holes = 0;
  let refused = 0;
  let countedOffered = 0;
  let countedHoles = 0;
  // A row without `SECTION_FLAG_PLAYER` is a hole of the second kind: the row is there, the
  // gateway can describe the character, and `Player::ValidateAppearance(create=true)` refuses to
  // create it whatever the class is (`Player.cpp:27273-27275`). Counted on every offered pair.
  const playable = (base, race, sex, variation, colour) =>
    table.has(base, race, sex, variation, colour) && (table.flags(base, race, sex, variation, colour) & 0x01) !== 0;
  for (const { race, sex, options } of everyOffer(appearanceIndex)) {
    for (const skin of options.skins) {
      offered++;
      if (!table.has(0, race, sex, 0, skin)) holes++;
      if (!playable(0, race, sex, 0, skin)) refused++;
      for (const face of options.facesBySkin[skin]) {
        offered++;
        if (!table.has(1, race, sex, face, skin)) holes++;
        if (!playable(1, race, sex, face, skin)) refused++;
      }
    }
    for (const colour of options.hairColors) {
      for (const style of options.hairStyles) {
        offered++;
        // Even the rows whose own texture slot is deliberately blank, which is what a bald row is:
        // the question is whether the client was given the combination, not what it put in it.
        if (!table.has(3, race, sex, style, colour)) holes++;
        if (!playable(3, race, sex, style, colour)) refused++;
      }
      for (const variation of options.facialHairs) {
        offered++;
        // Ten of the twenty profiles have no facial-hair section at all and the core does not ask
        // for one; where the sections exist, every offered pair must have one.
        if (table.counted(2, race, sex).variations === 0) continue;
        if (!table.has(2, race, sex, variation, colour)) holes++;
        if (!playable(2, race, sex, variation, colour)) refused++;
      }
    }

    // And the same rectangle as the counts drew it, on the same table.
    const skins = table.counted(0, race, sex).colours;
    const faces = table.counted(1, race, sex).variations;
    const hair = table.counted(3, race, sex);
    const facials = table.counted(2, race, sex).variations;
    for (let skin = 0; skin < skins; skin++) {
      countedOffered++;
      if (!table.has(0, race, sex, 0, skin)) countedHoles++;
      for (let face = 0; face < faces; face++) {
        countedOffered++;
        if (!table.has(1, race, sex, face, skin)) countedHoles++;
      }
    }
    for (let colour = 0; colour < hair.colours; colour++) {
      for (let style = 0; style < hair.variations; style++) {
        countedOffered++;
        if (!table.has(3, race, sex, style, colour)) countedHoles++;
      }
      for (let variation = 0; variation < facials; variation++) {
        countedOffered++;
        if (!table.has(2, race, sex, variation, colour)) countedHoles++;
      }
    }
  }
  assert.equal(holes, 0, `${holes} of ${offered} offered looks have no row`);
  // And not one of them is a row the core would refuse to create for any class. The review found
  // the second kind of hole after the lists went in: 98 hairstyles over the twenty profiles and
  // 2 hair colours — the tauren's colour 3, both sexes — have a row and not the player flag, and
  // the form was putting all of them up.
  assert.equal(refused, 0, `${refused} of ${offered} offered looks have a row the core refuses`);
  assert.equal(offered, 7709, `the twenty profiles offer 7,709 looks, not ${offered}`);
  assert.equal(countedHoles, 1900, `counting to the largest index offered 1,900 holes, not ${countedHoles}`);
  assert.equal(countedOffered, 10028);
});

test("Т3 the endpoint lists the indices that exist rather than counting to the largest",
  withDataset, async () => {
    const appearanceIndex = await load();
    // The night elf is the case that was visible on screen: hair colours 0..7, 10, 11 and 12 for
    // every one of the twelve styles and both sexes, 8 and 9 nowhere at all, and the count said 13.
    assert.deepEqual(appearanceIndex.options(4, 0).hairColors, [0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12]);
    assert.deepEqual(appearanceIndex.options(4, 1).hairColors, [0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12]);

    // A face row is keyed on `(face, skin)` and the two are not a full rectangle. The human male's
    // death-knight skins carry three faces of the twenty-four; his ordinary ones carry all of them.
    const human = appearanceIndex.options(1, 0);
    assert.deepEqual(human.skins, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14]);
    assert.deepEqual(human.facesBySkin[0], human.faces);
    assert.deepEqual(human.facesBySkin[12], [0, 2, 11]);
    // Skins 10 and 11 exist as skin rows and have no face row whatsoever, so they are not offered:
    // the character would wear a blank face, and the core refuses to create it.
    assert.equal(human.facesBySkin[10], undefined);
    for (const { race, sex, options } of everyOffer(appearanceIndex)) {
      for (const skin of options.skins) {
        assert.ok((options.facesBySkin[skin] ?? []).length > 0,
          `race ${race} sex ${sex} offers skin ${skin} with no face to wear on it`);
        for (const face of options.facesBySkin[skin]) {
          assert.ok(options.faces.includes(face), `face ${face} is missing from the union`);
        }
      }
    }

    // Facial hair comes from `CharacterFacialHairStyles`, which is the table the geosets come from
    // and the one the core insists on. Counting `CharSections` gave ten of the twenty profiles a
    // flat zero and hid the control — including both tauren, whose "facial hair" is his horns.
    assert.deepEqual(appearanceIndex.options(6, 0).facialHairs, [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(appearanceIndex.options(11, 0).facialHairs, [0, 1, 2, 3, 4, 5, 6, 7]);
    const table = await rawTables();
    let silent = 0;
    let bare = 0;
    for (const { race, sex, options } of everyOffer(appearanceIndex)) {
      if (options.facialHairs.length === 0) silent++;
      for (const variation of options.facialHairs) {
        const look = appearanceIndex.forPlayer(race, sex, 0, 0, 0, 0, variation);
        // What this used to assert was `look.geosets.length > 0`, which cannot fail: `#geosets`
        // starts from `{0}` and never takes anything out of it, so the line was true for every
        // input and the emission could have been replaced by nothing without it noticing. What the
        // variation is actually worth is the three pieces its own row names, so that is asked
        // instead — the columns being 0, 1, 2 → families 1, 3, 2, which is the mapping measured
        // beside the emission.
        const columns = table.facial(race, sex, variation);
        assert.ok(columns, `race ${race} sex ${sex} is offered facial ${variation} with no row`);
        const named = [1, 3, 2]
          .map((family, column) => (columns[column] > 0 ? family * 100 + columns[column] : 0))
          .filter(Boolean)
          .sort((left, right) => left - right);
        const drawn = look.geosets.filter((geoset) => geoset >= 100 && geoset < 400);
        assert.deepEqual(drawn, named,
          `race ${race} sex ${sex} facial ${variation} draws ${drawn} where its row names ${named}`);
        if (named.length === 0) bare++;
      }
    }
    assert.equal(silent, 0, `${silent} profiles are offered no facial hair at all, and it used to be ten`);
    // 29 of the 172 name no piece in any of the three families: all eight of ScourgeFemale's, all
    // ten of NightElfFemale's, and variation 0 — "none of it" — on eight more profiles. They are
    // looks all the same, painted on the face texture, and they are why "all 172 of them draw
    // geometry" would have been the wrong claim to make.
    assert.equal(bare, 29, `29 of the 172 offered variations name no facial geoset at all, not ${bare}`);
  });

test("Т3 the form offers only what the core will let a character be created with", withDataset, async () => {
  const appearanceIndex = await load();
  const table = await rawTables();
  // `Player::ValidateAppearance(create=true)` refuses a section without `SECTION_FLAG_PLAYER` for
  // every class, the death knight included (`Player.cpp:27273-27275`), so a look the flag is
  // missing from is a look that ends in «Создание отклонено». Measured on the offered rectangle:
  // 98 hairstyles and 2 hair colours over the twenty profiles were being offered that way.
  const human = appearanceIndex.options(1, 0);
  assert.deepEqual(human.hairStyles, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    "the human male's styles 12 to 16 carry no player flag at any colour");
  // The tauren keeps his mane and loses the colour it was painted in: colour 3 has a row for all 13
  // of his male styles and not one of them is flagged for creation.
  assert.deepEqual(appearanceIndex.options(6, 0).hairColors, [0, 1, 2]);
  assert.deepEqual(appearanceIndex.options(6, 1).hairColors, [0, 1, 2]);
  // But `forPlayer` still draws it, because the byte comes off the wire and an existing character
  // may already wear it — the barbershop's rules are not the creation screen's.
  assert.ok(appearanceIndex.forPlayer(6, 0, 0, 0, 4, 3, 0).geosets.includes(6),
    "a tauren already wearing colour 3 keeps his mane");

  // The region the flag takes out is an exact product of whole styles and whole colours, which is
  // why filtering the two axes separately leaves nothing ragged behind: measured, every unflagged
  // (style, colour) pair of the twenty profiles lies in a style with no flagged colour or a colour
  // with no flagged style.
  let styles = 0;
  let colours = 0;
  let ragged = 0;
  for (const { race, sex } of everyOffer(appearanceIndex)) {
    const counted = table.counted(3, race, sex);
    const deadStyles = new Set();
    const deadColours = new Set();
    // "Dead" is a row without the flag, not a number without a row: an index that exists nowhere
    // is the first kind of hole and the enumeration already leaves it out.
    for (let style = 0; style < counted.variations; style++) {
      let rows = 0;
      let flagged = 0;
      for (let colour = 0; colour < counted.colours; colour++) {
        if (!table.has(3, race, sex, style, colour)) continue;
        rows++;
        if ((table.flags(3, race, sex, style, colour) & 0x01) !== 0) flagged++;
      }
      if (rows > 0 && flagged === 0) deadStyles.add(style);
    }
    for (let colour = 0; colour < counted.colours; colour++) {
      let rows = 0;
      let flagged = 0;
      for (let style = 0; style < counted.variations; style++) {
        if (!table.has(3, race, sex, style, colour)) continue;
        rows++;
        if ((table.flags(3, race, sex, style, colour) & 0x01) !== 0) flagged++;
      }
      if (rows > 0 && flagged === 0) deadColours.add(colour);
    }
    styles += deadStyles.size;
    colours += deadColours.size;
    for (let style = 0; style < counted.variations; style++) {
      for (let colour = 0; colour < counted.colours; colour++) {
        if (!table.has(3, race, sex, style, colour)) continue;
        if ((table.flags(3, race, sex, style, colour) & 0x01) !== 0) continue;
        if (!deadStyles.has(style) && !deadColours.has(colour)) ragged++;
      }
    }
  }
  assert.equal(styles, 98, `98 hairstyles carry no player flag at any colour, not ${styles}`);
  assert.equal(colours, 2, `2 hair colours carry no player flag at any style, not ${colours}`);
  assert.equal(ragged, 0, `${ragged} unflagged pairs are in a style and a colour that are both alive`);

  // The unfiltered inventory includes death-knight sections for appearance inspection. The
  // creation screen passes a class, so ordinary classes must lose them while class 6 keeps them.
  // Measured on the human male: three of his thirteen skins and 129 of his 249 face rows.
  const knightSkins = human.skins.filter((skin) => (table.flags(0, 1, 0, 0, skin) & 0x04) !== 0);
  assert.deepEqual(knightSkins, [12, 13, 14], "the unfiltered inventory retains knight skins");

  const warrior = appearanceIndex.options(1, 0, 1);
  const deathKnight = appearanceIndex.options(1, 0, 6);
  assert.deepEqual(warrior.skins, human.skins.filter((skin) => !knightSkins.includes(skin)),
    "the core refuses death-knight-only skins for a warrior at character creation");
  assert.deepEqual(deathKnight.skins, human.skins,
    "the death knight keeps its exclusive skins and the ordinary ones");
  for (const skin of warrior.skins) {
    assert.equal(table.flags(0, 1, 0, 0, skin) & 0x04, 0);
    for (const face of warrior.facesBySkin[skin]) {
      assert.equal(table.flags(1, 1, 0, face, skin) & 0x04, 0,
        `warrior face ${face} skin ${skin} must pass ValidateAppearance`);
    }
  }
});

test("Т3 a hairstyle with no row of its own is not drawn, and a mane with a blank row still is",
  withDataset, async () => {
    const appearanceIndex = await load();
    // The wig: a night elf at hair colour 8 has no `CharSections` row, so `hair` is empty, and the
    // geoset used to be added anyway out of `CharHairGeosets` — a different table. All twelve
    // night-elf styles sample texture type 6, so the mesh came out flat green: 24 combinations per
    // sex out of the 3,278 the form put up.
    const styled = appearanceIndex.forPlayer(4, 0, 0, 0, 3, 0, 0);
    const wigless = appearanceIndex.forPlayer(4, 0, 0, 0, 3, 8, 0);
    assert.ok(styled.hair.length > 0 && styled.geosets.includes(5), `style 3 is geoset 5: ${styled.geosets}`);
    assert.equal(wigless.hair, "");
    assert.ok(!wigless.geosets.includes(5), `colour 8 has no row and must not draw a wig: ${wigless.geosets}`);

    // And the boundary the reviewer marked: **a row that exists with an empty texture is not the
    // same thing**. The tauren's hair colour 3 has a row for every one of his 13 male and 12
    // female styles with texture slot 0 blank, and those geosets are his mane — 26 to 138
    // triangles sampling the body atlas, which needs no hair texture and never had one. Testing
    // the string rather than the row would shave 25 of his offered looks.
    for (const [sex, styles] of [[0, 13], [1, 12]]) {
      for (let style = 0; style < styles; style++) {
        const mane = appearanceIndex.forPlayer(6, sex, 0, 0, style, 3, 0);
        assert.equal(mane.hair, "", `tauren ${sex} style ${style} colour 3 names no texture`);
        assert.ok(mane.geosets.includes(style + 2),
          `tauren ${sex} style ${style} lost its mane at colour 3: ${mane.geosets}`);
      }
    }
    // A style the table has never had still falls back to the race's own variation 0 — and the
    // texture question is asked about *that* variation, or the fallback would take the tauren's
    // mane away for a number he simply does not have.
    assert.deepEqual(appearanceIndex.forPlayer(6, 0, 0, 0, 99, 0, 0).geosets,
      appearanceIndex.forPlayer(6, 0, 0, 0, 0, 0, 0).geosets);

    // The whole sweep, on the 3,278-cell rectangle the counts used to offer: 48 of them lose a
    // geoset and they are exactly the night elf's, 24 per sex. Nobody else moves.
    const table = await rawTables();
    let cells = 0;
    let changed = 0;
    const races = new Set();
    for (const { race, sex } of everyOffer(appearanceIndex)) {
      const hair = table.counted(3, race, sex);
      for (let style = 0; style < hair.variations; style++) {
        for (let colour = 0; colour < hair.colours; colour++) {
          cells++;
          const wig = table.hairGeoset(race, sex, style);
          if (wig === undefined || wig === 0) continue;
          if (appearanceIndex.forPlayer(race, sex, 0, 0, style, colour, 0).geosets.includes(wig)) continue;
          changed++;
          races.add(`${race}/${sex}`);
        }
      }
    }
    assert.equal(cells, 3278, `the counts offered 3,278 hair looks, not ${cells}`);
    assert.deepEqual([...races].sort(), ["4/0", "4/1"], "only the night elf's wigs are dropped");
    assert.equal(changed, 48, `48 of the offered cells lose their wig, not ${changed}`);
  });

test("Т3 a race the section table says nothing about keeps the hair the geoset table gives it",
  withDataset, async () => {
    // `forPlayer` is the NPC path as well — `forNpc` calls it — and the "no row means the
    // combination does not exist" rule has to be read as what it is: a statement about a table that
    // speaks of this race at all. The review found the half that was missing. Measured on this
    // dataset: 41 (race, sex) pairs have a `CharHairGeosets` row, 39 of them have at least one
    // `CharSections` hair row, and the goblin male and the taunka male have none at any variation
    // or colour — so the rule read total silence as a denial and took the wig off 601 of the 15,475
    // extended display records, 502 goblin and 99 taunka, reached by 627 displays.
    const appearanceIndex = await load();
    const table = await rawTables();
    const { openDbcFile } = await import("../tools/dbc.mjs");
    const extra = await openDbcFile(dbcDirectory, "CreatureDisplayInfoExtra");
    // 05.10-A7a-B 6.01: the helmet column, read the way `forNpc` reads it (a named model, the per-sex
    // HelmetGeosetVisID, column 0 of HelmetGeosetVisData as a race bitmask).
    const itemDisplays = await openDbcFile(dbcDirectory, "ItemDisplayInfo");
    const helmetVis = await openDbcFile(dbcDirectory, "HelmetGeosetVisData");
    const displayRows = new Map([...itemDisplays.rows()].map((row) => [itemDisplays.id(row), row]));
    const hairMasks = new Map([...helmetVis.rows()].map((row) => [helmetVis.id(row), helmetVis.int(row, "HideGeoset", 0)]));
    const helmetHidesHair = (row, race, sex) => {
      const display = displayRows.get(extra.int(row, "NPCItemDisplay", 0));
      if (display === undefined || !itemDisplays.string(display, "ModelName", 0)) return false;
      return ((hairMasks.get(itemDisplays.int(display, "HelmetGeosetVisID", sex === 1 ? 1 : 0)) ?? 0) & (1 << race)) !== 0;
    };
    let helmeted = 0;

    assert.equal(table.hairSections(9, 0), 0, "the goblin male has no CharSections hair row at all");
    assert.equal(table.hairSections(19, 0), 0, "and neither has the taunka male");
    // His `CharHairGeosets` row is geoset 2 with `Showscalp`, and `GoblinMale.m2` carries it: 90
    // triangles in two batches, 28 of them sampling the baked body the display already supplies.
    assert.equal(table.hairGeoset(9, 0, 0), 2);

    let rows = 0;
    let undescribed = 0;
    let wigless = 0;
    const races = new Map();
    for (const row of extra.rows()) {
      const id = extra.id(row);
      if (id <= 0) continue;
      rows++;
      const race = extra.int(row, "DisplayRaceID");
      const sex = extra.int(row, "DisplaySexID");
      const style = extra.int(row, "HairStyleID");
      // The same fallback `#geosets` makes: a variation the table has never had becomes 0.
      const variation = table.hairGeoset(race, sex, style) === undefined ? 0 : style;
      const wig = table.hairGeoset(race, sex, variation);
      if (wig === undefined || wig === 0) continue;
      if (table.hairSections(race, sex) > 0) continue;
      undescribed++;
      races.set(`${race}/${sex}`, (races.get(`${race}/${sex}`) ?? 0) + 1);
      // 05.10-A7a-B 6.01: a drawn helmet whose HelmetGeosetVisData hides the hair takes the wig off by
      // design (npc-equipment.test.mjs); this test is about the section table, so those rows step aside.
      // 05.10 review: only when `forNpc` really hangs that helmet, and then the wig must be gone.
      const look = appearanceIndex.forNpc(id);
      if (helmetHidesHair(row, race, sex) && look.attached.some((item) => item.slot === 0)) {
        helmeted++;
        assert.ok(!look.geosets.includes(wig), `extra ${id}: a drawn hair-hiding helmet takes the wig off`);
        continue;
      }
      if (!look.geosets.includes(wig)) wigless++;
    }
    assert.equal(helmeted, 36, `36 wear a drawn hair-hiding helmet (spec 6.01 recount), not ${helmeted}`); // 05.10 review
    assert.equal(rows, 15475, `15,475 extended display records, not ${rows}`);
    assert.deepEqual([...races].sort(), [["19/0", 99], ["9/0", 502]]);
    assert.equal(undescribed, 601, `601 extended rows name a wig for a race with no hair rows, not ${undescribed}`);
    assert.equal(wigless, 0, `${wigless} of them lost it`);
    // And the goblin end to end: the wig is on the list, and so is the cap `Showscalp` asks for.
    // NPCItemDisplay legitimately adds unrelated clothing families, so this hair regression must
    // not freeze the complete outfit as an accidental oracle.
    const goblin = appearanceIndex.forNpc(4599).geosets;
    assert.ok(goblin.includes(2), `the baked goblin keeps its authored wig: ${goblin}`);
    assert.ok(goblin.includes(1), `the baked goblin keeps the Showscalp cap: ${goblin}`);

    // The night elf is untouched by the guard, which is the point of making it per profile: her
    // table has 132 hair rows and says plainly that colour 8 is not one of them.
    assert.equal(table.hairSections(4, 0), 132);
    assert.ok(!appearanceIndex.forPlayer(4, 0, 0, 0, 3, 8, 0).geosets.includes(5));
  });
