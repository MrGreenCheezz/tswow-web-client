import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { parseM2 } from "../tools/m2.mjs";
import { encodeWvm9 } from "../tools/wvm.mjs";
import { decodeWvm9 } from "../dist/code/browser/Wvm.js";
import {
  BODY_ONLY, EVERY_GEOSET, characterSlots, defaultCharacterGeosets, geosetList, geosetVisible,
  resolveGeosetId, resolveGeosets, unitGeosets,
} from "../dist/code/browser/ModelBuild.js";
import { buildForLab, labSummary } from "../dist/code/browser/lab/LabReport.js";
import { appearanceKey } from "../dist/code/browser/CharacterAtlas.js";
import { CharacterAppearanceIndex } from "../dist/code/gateway/CharacterAppearance.js";

// The whole of Т1 and Т2 is about what a real model does with a real appearance, so both come
// from this machine: the twenty playable `.m2`s out of the client archives and the DBCs out of the
// tswow dataset. The model goes through `encodeWvm9`/`decodeWvm9` rather than being read straight,
// because that is the artifact the gateway publishes and the browser decodes — a test on the raw
// parse would not be testing the pipeline the player is looking at.
let archives;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
} catch {
  archives = undefined;
}
let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };
const withBoth = { skip: archives && dbcDirectory ? false : "no 3.3.5a client and dataset on this machine" };

/** The twenty playable profiles, as `ChrRaces.ClientFileString` spells their directories. */
const PROFILES = [
  { race: 1, sex: 0, name: "HumanMale", directory: "Human" },
  { race: 1, sex: 1, name: "HumanFemale", directory: "Human" },
  { race: 2, sex: 0, name: "OrcMale", directory: "Orc" },
  { race: 2, sex: 1, name: "OrcFemale", directory: "Orc" },
  { race: 3, sex: 0, name: "DwarfMale", directory: "Dwarf" },
  { race: 3, sex: 1, name: "DwarfFemale", directory: "Dwarf" },
  { race: 4, sex: 0, name: "NightElfMale", directory: "NightElf" },
  { race: 4, sex: 1, name: "NightElfFemale", directory: "NightElf" },
  { race: 5, sex: 0, name: "ScourgeMale", directory: "Scourge" },
  { race: 5, sex: 1, name: "ScourgeFemale", directory: "Scourge" },
  { race: 6, sex: 0, name: "TaurenMale", directory: "Tauren" },
  { race: 6, sex: 1, name: "TaurenFemale", directory: "Tauren" },
  { race: 7, sex: 0, name: "GnomeMale", directory: "Gnome" },
  { race: 7, sex: 1, name: "GnomeFemale", directory: "Gnome" },
  { race: 8, sex: 0, name: "TrollMale", directory: "Troll" },
  { race: 8, sex: 1, name: "TrollFemale", directory: "Troll" },
  { race: 10, sex: 0, name: "BloodElfMale", directory: "BloodElf" },
  { race: 10, sex: 1, name: "BloodElfFemale", directory: "BloodElf" },
  { race: 11, sex: 0, name: "DraeneiMale", directory: "DraeneiMale" },
  { race: 11, sex: 1, name: "DraeneiFemale", directory: "DraeneiFemale" },
];

function modelPathOf(profile) {
  const directory = profile.directory === "DraeneiMale" || profile.directory === "DraeneiFemale"
    ? "Draenei" : profile.directory;
  return `Character\\${directory}\\${profile.sex === 1 ? "Female" : "Male"}\\${profile.name}`;
}

const decoded = new Map();
async function modelAt(base) {
  const held = decoded.get(base);
  if (held) return held;
  const [m2, skin] = await Promise.all([archives.read(`${base}.m2`), archives.read(`${base}00.skin`)]);
  if (!m2 || !skin) return undefined;
  const parsed = parseM2(m2, skin);
  const encoded = encodeWvm9(parsed, undefined);
  const model = decodeWvm9(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
  decoded.set(base, model);
  return model;
}

async function modelOf(profile) {
  return modelAt(modelPathOf(profile));
}

/**
 * Edges that belong to exactly one drawn triangle, hashed by their two endpoints' positions.
 *
 * By position rather than by vertex index, because a seam between two geosets is two separate
 * vertices at the same place with different UVs — index hashing would call every closed seam a
 * hole. Rounded to the millimetre, which is four orders below the smallest feature on these
 * models. This is the report's own test, brought into the suite: over the twenty playable models
 * it takes 0.3 s.
 */
function openEdgesBelow(model, choice, share) {
  let top = -Infinity;
  for (let index = 2; index < model.positions.length; index += 3) top = Math.max(top, model.positions[index]);
  const limit = top * share;
  const at = (vertex) => {
    const x = Math.round(model.positions[vertex * 3] * 1000);
    const y = Math.round(model.positions[vertex * 3 + 1] * 1000);
    const z = Math.round(model.positions[vertex * 3 + 2] * 1000);
    return `${x},${y},${z}`;
  };
  const counts = new Map();
  for (const submesh of model.submeshes) {
    if (submesh.indexCount === 0 || !geosetVisible(submesh.geosetId, choice)) continue;
    for (let index = submesh.indexStart; index < submesh.indexStart + submesh.indexCount; index += 3) {
      const corners = [model.indices[index], model.indices[index + 1], model.indices[index + 2]].map(at);
      for (let corner = 0; corner < 3; corner++) {
        const one = corners[corner];
        const other = corners[(corner + 1) % 3];
        const edge = one < other ? `${one}|${other}` : `${other}|${one}`;
        counts.set(edge, (counts.get(edge) ?? 0) + 1);
      }
    }
  }
  let open = 0;
  for (const [edge, count] of counts) {
    if (count !== 1) continue;
    const height = Math.max(...edge.split("|").map((point) => Number(point.split(",")[2]) / 1000));
    if (height < limit) open++;
  }
  return open;
}

test("Т1 a character with no appearance draws a body, not a torso with no legs in it", withClient, async () => {
  // `WorldRenderer3D` fell back to `BODY_ONLY` — geoset 0 and nothing else — for a character model
  // that arrived without an appearance, and that is the one path in this client that really does
  // take a character's legs away. The shins (501), thighs (1301), hands (401), ears (702) and
  // collar (1501) were all in the file and none of them was drawn.
  const chosen = defaultCharacterGeosets();
  assert.deepEqual([...chosen.explicit].sort((left, right) => left - right), [0, 401, 501, 702, 1301, 1501]);

  const human = await modelOf(PROFILES[0]);
  assert.ok(human, "HumanMale has to be readable for any of this to mean anything");
  const drawn = (choice) => new Set(human.submeshes
    .filter((submesh) => submesh.indexCount > 0 && geosetVisible(submesh.geosetId, choice))
    .map((submesh) => submesh.geosetId));
  assert.deepEqual([...drawn(BODY_ONLY)], [0], "geoset 0 alone is what it used to be");
  assert.deepEqual([...drawn(chosen)].sort((left, right) => left - right), [0, 401, 501, 702, 1301, 1501]);

  // And that is what the renderer picks for a character with no appearance. A pre-composed creature
  // has no appearance list to resolve: its M2's non-zero submeshes are authored body parts, so the
  // world path draws every one of them rather than treating the model as a torso-only BODY_ONLY
  // fallback.
  assert.deepEqual([...drawn(unitGeosets(undefined, true))].sort((left, right) => left - right),
    [0, 401, 501, 702, 1301, 1501]);
  assert.deepEqual([...drawn(unitGeosets(undefined, false))].sort((left, right) => left - right),
    [...drawn(EVERY_GEOSET)].sort((left, right) => left - right));
  // With an appearance the gateway's own list wins, whichever kind of model it is.
  const dressed = { body: [], hair: "", cloak: "", skinExtra: "", geosets: [0, 101, 1301], attached: [] };
  assert.deepEqual([...unitGeosets(dressed, true).explicit].sort((left, right) => left - right), [0, 101, 1301]);
  assert.deepEqual([...unitGeosets(dressed, false).explicit].sort((left, right) => left - right), [0, 101, 1301]);
});

test("Т1 a no-appearance creature draws every authored M2 body submesh", withClient, async () => {
  // These are deliberately three different families, not a path-name special case. The child
  // model is the visible regression (its legs are 401/501/503), while the peasant and ogre show the
  // same rule on bespoke non-character models whose authored ids are different.
  const cases = [
    ["Creature\\HumanMaleKid\\HumanMaleKid", [0, 401, 501, 503]],
    ["Creature\\HumanMalePeasant\\HumanMalePeasant", [0, 2, 401, 501, 503]],
    ["Creature\\Ogre\\Ogre", [0, 501, 1301]],
  ];
  for (const [base, expected] of cases) {
    const model = await modelAt(base);
    assert.ok(model, `${base} has to be readable for this regression`);
    const present = [...new Set(model.submeshes
      .filter((submesh) => submesh.indexCount > 0)
      .map((submesh) => submesh.geosetId))].sort((left, right) => left - right);
    const drawn = [...new Set(model.submeshes
      .filter((submesh) => submesh.indexCount > 0 && geosetVisible(
        submesh.geosetId, unitGeosets(undefined, false)))
      .map((submesh) => submesh.geosetId))].sort((left, right) => left - right);
    assert.deepEqual(present, expected, `${base}: archive geoset corpus changed`);
    assert.deepEqual(drawn, present, `${base}: no authored geoset may be hidden`);
  }
});

test("Т1 the bare-character list closes the body below the waist on every playable model", withClient, async () => {
  // Position-matched boundary edges below 60% of each model's own height — the ankle-to-hip band.
  // Measured here: geoset 0 alone leaves 16 to 52 open edges on all twenty, and the list closes
  // sixteen of them outright. The four that are left are authored: the two undead are corpses and
  // the trolls have a seam at the hip, and every one of the four is better than it was.
  const SEAMS = { ScourgeMale: 8, ScourgeFemale: 24, TrollMale: 2, TrollFemale: 2 };
  const chosen = defaultCharacterGeosets();
  let measured = 0;
  for (const profile of PROFILES) {
    const model = await modelOf(profile);
    if (!model) continue;
    measured++;
    const bodyOnly = openEdgesBelow(model, BODY_ONLY, 0.6);
    const bare = openEdgesBelow(model, chosen, 0.6);
    assert.ok(bodyOnly >= 16 && bodyOnly <= 52,
      `${profile.name}: geoset 0 alone leaves ${bodyOnly} open edges, outside the measured 16..52`);
    assert.equal(bare, SEAMS[profile.name] ?? 0,
      `${profile.name}: the bare-character list leaves ${bare} open edges below the waist`);
    assert.ok(bare < bodyOnly, `${profile.name}: ${bare} against ${bodyOnly}`);
  }
  assert.equal(measured, 20, `all twenty playable models have to be measured, got ${measured}`);
});

test("Т2 a naked tauren has no batch left painting itself flat green", withBoth, async () => {
  // The whole of Т2 in one number. Built through the same `characterSlots`, `geosetList` and
  // `buildModel` the renderer uses, with the body atlas supplied the way the renderer supplies it.
  const index = await CharacterAppearanceIndex.load(dbcDirectory);
  const build = async (profile, appearance) => {
    const model = await modelOf(profile);
    return buildForLab(model, {
      modelPath: `${modelPathOf(profile)}.m2`,
      slots: characterSlots("", appearance),
      geosets: geosetList(appearance.geosets),
      baseUrl: "http://gateway:8090",
      loadTexture: () => new THREE.Texture(),
      slotTextures: new Map([[1, new THREE.Texture()]]),
      skinned: false,
      emitted: appearance.geosets,
    }).panel;
  };

  for (const [profile, triangles, wasFlat] of [
    [PROFILES[10], 1196, 166], [PROFILES[11], 1224, 132],
  ]) {
    const appearance = index.forPlayer(profile.race, profile.sex, 0, 0, 0, 0, 0);
    const panel = await build(profile, appearance);
    assert.equal(panel.triangles, triangles, `${profile.name} draws ${panel.triangles} triangles`);
    assert.equal(panel.flatTriangles, 0,
      `${profile.name}: ${panel.flatTriangles} of ${panel.triangles} triangles are still flat`
      + ` (${panel.materials.filter((line) => line.flat).map((line) => `geoset ${line.geoset} slot ${line.slot}`)})`);

    // And the same build with the field taken away is the defect, so the test cannot pass by the
    // slot having quietly stopped being sampled: 166 triangles in three batches on the male, 132
    // in two on the female, all of them asking for type 8.
    const without = await build(profile, { ...appearance, skinExtra: "" });
    assert.equal(without.flatTriangles, wasFlat, `${profile.name} without the file`);
    assert.ok(without.materials.filter((line) => line.flat).every((line) => line.slot === 8));
  }

  // Nobody else changes: a human male declares no slot 8 and was never flat to begin with. He
  // draws 1,032 triangles rather than the 988 he used to, and the 44 are geoset 1 — the scalp cap
  // Т4 turned on for his bald style 0, which is the only other thing in this slice that can move
  // a triangle count.
  const human = index.forPlayer(1, 0, 0, 0, 0, 0, 0);
  const panel = await build(PROFILES[0], human);
  assert.equal(panel.flatTriangles, 0);
  assert.equal(panel.triangles, 1032);
  assert.equal(panel.materials.filter((line) => line.geoset === 1).reduce((sum, line) => sum + line.triangles, 0), 44,
    "the crown is 44 triangles of HumanMale, and until Т4 nothing drew them");
});

test("Т3 not one look the form offers draws a batch with nothing in its slot", withBoth, async () => {
  // The contact sheet, without a browser. Every (style, colour) the options endpoint offers for
  // every playable profile, built through the real path, and not one of them may come out flat.
  // It used to be 3,278 cells with 48 of them a green night-elf wig — the colours 8 and 9 that
  // exist for no night elf — and on the female the 24-triangle brow-and-lash batch of geoset 0
  // went green with the wig, because it samples the hair slot too.
  const index = await CharacterAppearanceIndex.load(dbcDirectory);
  const panelOf = (profile, model, appearance) => buildForLab(model, {
    modelPath: `${modelPathOf(profile)}.m2`,
    slots: characterSlots("", appearance),
    geosets: geosetList(appearance.geosets),
    baseUrl: "http://gateway:8090",
    loadTexture: () => new THREE.Texture(),
    slotTextures: new Map([[1, new THREE.Texture()]]),
    skinned: false,
    emitted: appearance.geosets,
  }).panel;

  // The table itself, to tell "the row named this picture" from "the row named nothing and the
  // colour's own picture was borrowed" — the fix for the bald orc's flat green beard. Asking the
  // index both questions would be asking it to mark its own work.
  const { openDbcFile } = await import("../tools/dbc.mjs");
  const sections = await openDbcFile(dbcDirectory, "CharSections");
  const ownHairTexture = new Map();
  for (const row of sections.rows()) {
    if (sections.int(row, "BaseSection") !== 3) continue;
    const key = `${sections.int(row, "RaceID")}/${sections.int(row, "SexID")}`
      + `/${sections.int(row, "VariationIndex")}/${sections.int(row, "ColorIndex")}`;
    if (!ownHairTexture.has(key)) ownHairTexture.set(key, sections.string(row, "TextureName", 0));
  }

  let cells = 0;
  let textureless = 0;
  let borrowed = 0;
  let facials = 0;
  for (const profile of PROFILES) {
    const model = await modelOf(profile);
    if (!model) continue;
    const options = index.options(profile.race, profile.sex);
    for (const style of options.hairStyles) {
      for (const colour of options.hairColors) {
        cells++;
        const appearance = index.forPlayer(profile.race, profile.sex, 0, 0, style, colour, 0);
        if (!appearance.hair) textureless++;
        else if (!ownHairTexture.get(`${profile.race}/${profile.sex}/${style}/${colour}`)) borrowed++;
        const panel = panelOf(profile, model, appearance);
        assert.equal(panel.flatTriangles, 0,
          `${profile.name} hair ${style}:${colour} draws ${panel.flatTriangles} flat triangles`
          + ` (${panel.materials.filter((line) => line.flat).map((line) => `geoset ${line.geoset} slot ${line.slot}`)})`);
      }
    }
    // And the facial hair, which ten of the twenty profiles were never offered at all until this
    // slice — the tauren's horns and the draenei's tendrils among them.
    for (const variation of options.facialHairs) {
      facials++;
      const appearance = index.forPlayer(profile.race, profile.sex, 0, 0, 0, 0, variation);
      const panel = panelOf(profile, model, appearance);
      assert.equal(panel.flatTriangles, 0,
        `${profile.name} facial ${variation} draws ${panel.flatTriangles} flat triangles`);
    }
  }
  assert.equal(cells, 2138, `the twenty profiles offer 2,138 hair looks, not ${cells}`);
  // Not one offered look ends up with no hair texture any more. It was 25 before the review — the
  // tauren's hair colour 3, where no variation of that colour names anything at all — and that
  // colour is now off the list for a different reason: the core refuses to create a character with
  // it. The fallback that fills a blank slot from another row of the same colour still carries the
  // 59 bald rows that a beard is painted from, which is what `borrowed` counts.
  assert.equal(textureless, 0, `${textureless} offered looks end up with no hair texture`);
  assert.equal(borrowed, 59, `59 offered looks take their hair picture from another row, not ${borrowed}`);
  // 172 is every playable row of `CharacterFacialHairStyles`, which is the table the geosets come
  // from: the endpoint offers all of them and nothing else.
  assert.equal(facials, 172, `the twenty profiles offer 172 facial-hair variations, not ${facials}`);
});

test("Т4 a model with no geoset 1 draws the same with the id in the list and without it", withClient, async () => {
  // Т4's fourth acceptance clause, which nothing pinned: the gateway sends the scalp cap to
  // everybody whose style asks for it, and nine of the twenty playable models do not carry it —
  // OrcMale, OrcFemale, DwarfMale, NightElfMale, NightElfFemale, ScourgeMale, ScourgeFemale,
  // TaurenFemale, TrollFemale. Adding an id a file does not have has to be exactly nothing, or the
  // "adds beside the style rather than instead of it" argument buys the crown at somebody else's
  // expense. Measured through the real build, on the bare-character list: the eleven that carry it
  // gain precisely its triangles and one material, and the nine draw the same triangles, the same
  // materials and the same geosets.
  const CROWN = {
    HumanMale: 44, HumanFemale: 30, DwarfFemale: 32, TaurenMale: 6, GnomeMale: 40, GnomeFemale: 22,
    TrollMale: 28, BloodElfMale: 76, BloodElfFemale: 124, DraeneiMale: 56, DraeneiFemale: 76,
  };
  const bare = [0, 401, 501, 702, 1301, 1501];
  const capped = [...bare, 1].sort((left, right) => left - right);
  let absent = 0;
  for (const profile of PROFILES) {
    const model = await modelOf(profile);
    if (!model) continue;
    const build = (ids) => buildForLab(model, {
      modelPath: `${modelPathOf(profile)}.m2`,
      slots: new Map(),
      geosets: geosetList(ids),
      baseUrl: "http://gateway:8090",
      loadTexture: () => new THREE.Texture(),
      slotTextures: new Map([[1, new THREE.Texture()]]),
      skinned: false,
      emitted: ids,
    }).panel;
    const plain = build(bare);
    const withCap = build(capped);
    const drawn = (panel) => panel.geosets.filter((line) => line.drawn > 0).map((line) => line.id).join(",");
    const crown = CROWN[profile.name];
    if (crown === undefined) {
      absent++;
      assert.equal(withCap.triangles, plain.triangles, `${profile.name} has no geoset 1 and must not move`);
      assert.equal(withCap.materials.length, plain.materials.length, `${profile.name} gained a material`);
      assert.equal(drawn(withCap), drawn(plain), `${profile.name} drew something else`);
    } else {
      assert.equal(withCap.triangles - plain.triangles, crown,
        `${profile.name}'s crown is ${crown} triangles`);
      assert.equal(withCap.materials.length - plain.materials.length, 1, `${profile.name} draws it in one batch`);
    }
  }
  assert.equal(absent, 9, `nine of the twenty carry no geoset 1, not ${absent}`);
});

test("Т1 nothing about transparency or culling can hide a leg", withBoth, async () => {
  // The regression test the plan parks in Т1. Before the geoset arithmetic was believed, the two
  // other ways a limb can vanish had to be ruled out: a batch drawn in the transparent pass can be
  // sorted behind the body, and one that does not write depth can be painted over by it. Measured
  // over all twenty naked playable characters, and it is one rule with one exception.
  const index = await CharacterAppearanceIndex.load(dbcDirectory);
  let glows = 0;
  let glowTriangles = 0;
  let batches = 0;
  for (const profile of PROFILES) {
    const model = await modelOf(profile);
    if (!model) continue;
    const appearance = index.forPlayer(profile.race, profile.sex, 0, 0, 2, 0, 0);
    const { built, panel } = buildForLab(model, {
      modelPath: `${modelPathOf(profile)}.m2`,
      slots: characterSlots("", appearance),
      geosets: geosetList(appearance.geosets),
      baseUrl: "http://gateway:8090",
      loadTexture: () => new THREE.Texture(),
      slotTextures: new Map([[1, new THREE.Texture()]]),
      skinned: false,
      emitted: appearance.geosets,
    });
    for (const line of panel.materials) {
      batches++;
      const material = built.materials[line.index];
      // Lit or unlit is the whole distinction, and it is the model's own `MATERIAL_UNLIT` flag:
      // `buildMaterial` makes an unlit batch a `MeshBasicMaterial`. The only unlit thing on a
      // naked character is an eye glow, and an eye glow is a card on the face — it is *allowed*
      // to be additive and to skip the depth write, because that is what makes it a glow.
      if (material.type === "MeshBasicMaterial") {
        if (material.transparent) { glows++; glowTriangles += line.triangles; }
        continue;
      }
      assert.equal(material.transparent, false,
        `${profile.name}: geoset ${line.geoset} is lit and drawn in the transparent pass`);
      assert.equal(material.blending, THREE.NormalBlending, `${profile.name}: geoset ${line.geoset} is blended`);
      assert.equal(material.depthWrite, true,
        `${profile.name}: geoset ${line.geoset} does not write depth and can be painted over`);
      assert.notEqual(material.side, THREE.BackSide,
        `${profile.name}: geoset ${line.geoset} is drawn inside out`);
    }
  }
  assert.ok(batches > 150, `the sweep has to actually build something, got ${batches} batches`);
  // And what is left transparent is a handful of cards on a handful of faces, not a limb: the
  // draenei's is on geoset 0 rather than in family 17, which is why the rule is about the material
  // rather than about the geoset number.
  assert.equal(glows, 7, `seven transparent batches over the twenty naked models, not ${glows}`);
  assert.ok(glowTriangles <= 48, `and ${glowTriangles} triangles between them, which is a face and not a leg`);
});

test("Т2 two looks that differ only in the extra skin are two different builds", () => {
  // `#unitKey` names a build by the appearance's resolved files, and everything downstream — the
  // composed atlas, the geometry, the materials, the rigged template — is cached under that name.
  // A field that is used to build and absent from the name gives two looks one build, which is
  // how fifteen thousand character displays once shared 41 keys.
  const look = { body: [{ path: "skin.blp" }], hair: "", cloak: "", skinExtra: "", geosets: [0, 401], attached: [] };
  const horned = { ...look, skinExtra: "Character\\Tauren\\Male\\TaurenMaleSkin00_00_Extra.blp" };
  assert.notEqual(appearanceKey(look), appearanceKey(horned));
  // And a gateway too old to send the field at all is still one stable name, not a crash.
  const { skinExtra: _unused, ...older } = look;
  assert.equal(appearanceKey(older), appearanceKey(look));
});

/** The geoset ids one model carries as drawable geometry. */
function presentGeosets(model) {
  return new Set(model.submeshes.filter((submesh) => submesh.indexCount > 0).map((submesh) => submesh.geosetId));
}

test("Т5 a geoset the model does not carry is drawn as the nearest one it does", withClient, async () => {
  // The reference client's rule (`geoset_rules.hpp:81-100`): the id if the model has it, nothing
  // if the id means "none" — variant 0 or 1 — and otherwise the lowest member of the same family
  // the file does carry. The tauren is what pays for it: family 5 exists on both tauren models as
  // variant 5 and nothing else, and 934 of the 1,327 boot displays in this dataset name 502, 503
  // or 504, so seven boots in ten used to draw no shaft at all on him.
  const tauren = presentGeosets(await modelOf(PROFILES[10]));
  assert.deepEqual([...tauren].filter((id) => id >= 500 && id < 600), [505],
    "TaurenMale's only boot geoset is 505");
  assert.equal(resolveGeosetId(502, tauren), 505);
  assert.equal(resolveGeosetId(503, tauren), 505);
  assert.equal(resolveGeosetId(504, tauren), 505);
  assert.equal(resolveGeosetId(505, tauren), 505, "and one he has is left alone");
  // Variant 1 is "no boot", and it stays silent rather than becoming a boot nobody asked for.
  assert.equal(resolveGeosetId(501, tauren), undefined);
  // Family 9 he carries as 903 alone, so a kneepad follows the same road.
  assert.equal(resolveGeosetId(902, tauren), 903);
  // A family the model has not got at all draws nothing: no scourge carries family 9 and no dwarf
  // male family 7.
  assert.equal(resolveGeosetId(902, presentGeosets(await modelOf(PROFILES[8]))), undefined);
  assert.equal(resolveGeosetId(702, presentGeosets(await modelOf(PROFILES[4]))), undefined);

  // 1103 — "Legguards of the Vault", entry 9396, display 18274, the one item in the dataset that
  // asks for it — on every model, because family 11 exists in all twenty as variants 2 and 4.
  for (const profile of PROFILES) {
    const model = await modelOf(profile);
    if (!model) continue;
    assert.equal(resolveGeosetId(1103, presentGeosets(model)), 1102,
      `${profile.name} draws the trousers of the Vault as 1102`);
  }

  // The whole list at once, with the substitutions handed back rather than worked out twice.
  const { choice, substitutions } = resolveGeosets(geosetList([0, 401, 502, 902, 1301, 1501]), tauren);
  assert.deepEqual([...choice.explicit].sort((left, right) => left - right), [0, 401, 505, 903, 1301, 1501]);
  assert.deepEqual([...substitutions].sort(), [[502, 505], [902, 903]]);
  // `variants` and `everything` name no ids, so they come back untouched.
  assert.equal(resolveGeosets(BODY_ONLY, tauren).choice, BODY_ONLY);
});

test("Т5 the hair, the beard and the eye glow are not variants of anything and are left alone",
  withClient, async () => {
    // Three families the rule must not touch, all three found by the review by looking outside the
    // outfit sweep, which pins the hairstyle and the facial hair at zero.
    const tauren = presentGeosets(await modelOf(PROFILES[10]));
    const nightElf = presentGeosets(await modelOf(PROFILES[6]));
    const human = presentGeosets(await modelOf(PROFILES[0]));

    // Family 0: 0 is the body, 1 the crown, 2 upwards the hairstyles, so the "lowest present
    // member" of a hairstyle is the torso. FelOrcMale, VrykulMale and IceTrollMale carry family 0
    // as geoset 0 alone and 193 NPC displays resolved a hairstyle onto it.
    assert.equal(resolveGeosetId(5, new Set([0])), undefined);
    assert.ok(tauren.has(2) && !tauren.has(20), "TaurenMale's hairstyles stop at 14");
    assert.equal(resolveGeosetId(20, tauren), undefined, "a style the tauren has not got draws nothing");

    // Families 1 to 3: the number is the look's own index, the same one in all three columns on
    // 131 of the 143 playable rows that name anything, so a family with no member of that index is
    // a look with no piece there. TaurenMale's look 4 is horn 105 and nothing else; resolving gave
    // him 202 and 302, the head-plate and snout-piece of look 2.
    assert.ok(tauren.has(105) && !tauren.has(205) && !tauren.has(305));
    assert.equal(resolveGeosetId(205, tauren), undefined);
    assert.equal(resolveGeosetId(305, tauren), undefined);
    // And NightElfMale, whose family 1 is 103, 106, 107: resolving made looks 1, 2, 3 and 4 all
    // wear 103.
    assert.deepEqual([...nightElf].filter((id) => id >= 100 && id < 200).sort((a, b) => a - b), [103, 106, 107]);
    for (const asked of [102, 104, 105]) assert.equal(resolveGeosetId(asked, nightElf), undefined);

    // Family 17: the nearest member is another race's eyes. A human model carries 1703 alone, the
    // death knight's, and five NPC displays — 11810, 16157, 16427, 18242, 19379 — emit 1702.
    assert.deepEqual([...human].filter((id) => id >= 1700 && id < 1800), [1703]);
    assert.equal(resolveGeosetId(1702, human), undefined,
      "a human model does not answer a racial glow with the death knight's");
    // The night elf has her own and keeps it.
    assert.equal(resolveGeosetId(1702, nightElf), 1702);

    // Family 7 is deliberately still in the rule: 701 is the plug a helmet leaves and 702 the ear,
    // and a model carrying only the plug wants its ear hole closed. 137 NPC displays do this.
    assert.equal(resolveGeosetId(702, new Set([0, 701])), 701);
  });

test("Т5 every id a dressed character draws is one its own model has", withBoth, async () => {
  // The sweep the plan asks for, over every distinct outfit the gateway can emit: all 57,988
  // `ItemDisplayInfo` rows against the ten inventory types that move a geoset, on all twenty
  // playable models — 1,220 distinct (model, outfit) pairs on this dataset. After resolving, every
  // id that is drawn is in the model, and every id that is not drawn either means "none" (variant
  // 0 or 1) or belongs to a family the file has not got. Measured: 264 of the second kind, and
  // they are six cases — family 7 on DwarfMale, DwarfFemale and DraeneiFemale, family 2 on
  // DwarfMale, and family 9 on both scourge.
  const index = await CharacterAppearanceIndex.load(dbcDirectory);
  const { openDbcFile } = await import("../tools/dbc.mjs");
  const displays = await openDbcFile(dbcDirectory, "ItemDisplayInfo");
  // What a display does to the geosets is its three `GeosetGroup` values and nothing else, and the
  // 57,988 rows of this table carry **19** distinct triples between them. One display per triple
  // is therefore the whole space, and it is 4.8 million `forPlayer` calls cheaper than the rows.
  const perTriple = new Map();
  let rows = 0;
  for (const row of displays.rows()) {
    if (displays.id(row) <= 0) continue;
    rows++;
    const triple = [0, 1, 2].map((group) => displays.int(row, "GeosetGroup", group)).join("/");
    if (!perTriple.has(triple)) perTriple.set(triple, displays.id(row));
  }
  assert.ok(rows > 20_000, `the dataset should have twenty thousand item displays, got ${rows}`);
  assert.equal(perTriple.size, 19, `19 distinct GeosetGroup triples, not ${perTriple.size}`);

  // inventoryType to the equipment slot it is worn in, for the ten types that move a geoset.
  const SLOTS = { 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 10: 9, 16: 14, 19: 18, 20: 4 };
  const outfits = new Map();
  for (const profile of PROFILES) {
    for (const [type, slot] of Object.entries(SLOTS)) {
      for (const displayId of perTriple.values()) {
        const geosets = index.forPlayer(profile.race, profile.sex, 0, 0, 0, 0, 0,
          [{ slot, inventoryType: Number(type), displayId }]).geosets;
        const key = `${profile.name}|${geosets.join(",")}`;
        if (!outfits.has(key)) outfits.set(key, { profile, geosets });
      }
    }
  }
  assert.equal(outfits.size, 1220, `1,220 distinct (model, outfit) pairs, not ${outfits.size}`);

  let substituted = 0;
  let familyless = 0;
  const boots = new Map();
  for (const { profile, geosets } of outfits.values()) {
    const model = await modelOf(profile);
    if (!model) continue;
    const present = presentGeosets(model);
    const { choice, substitutions } = resolveGeosets(geosetList(geosets), present);
    for (const id of choice.explicit) {
      assert.ok(present.has(id), `${profile.name} would draw ${id}, which is not in the file`);
    }
    for (const id of geosets) {
      if (choice.explicit.has(id) || substitutions.has(id) || id % 100 <= 1) continue;
      // Dropped and not a "none": the whole family has to be missing from the model.
      const family = Math.floor(id / 100);
      assert.ok(![...present].some((candidate) => Math.floor(candidate / 100) === family),
        `${profile.name} dropped ${id} and the file has that family`);
      familyless++;
    }
    substituted += substitutions.size;
    if (profile.name === "TaurenMale") {
      for (const [from, to] of substitutions) if (from >= 500 && from < 600) boots.set(from, to);
    }
  }
  assert.equal(familyless, 264, `264 emitted ids belong to a family the model has not got, not ${familyless}`);
  assert.equal(substituted, 518, `518 ids are substituted over the sweep, not ${substituted}`);
  assert.deepEqual([...boots].sort(), [[502, 505], [503, 505], [504, 505], [506, 505]],
    "every tauren boot variant he has not got becomes the one he has");
});

test("Т5 nothing a player can choose about his own head is ever substituted", withBoth, async () => {
  // The sweep above dresses the character and leaves his head alone — `hairStyle 0, hairColor 0,
  // facialHair 0` on every call — so it never sees the families the appearance bytes drive. This
  // is the other rectangle: every (style, colour, facial-hair) the form offers, on every playable
  // model, which is 18,776 looks over the twenty. Not one of them may substitute anything.
  //
  // It used to. Measured before the review's fix: 868 substitutions over this rectangle, moving 11
  // of the 172 offered facial-hair variations — DwarfMale 311→302 and 312→302, NightElfMale
  // 102/104/105→103 and 202/203→204, TaurenMale 106→102, 205/207→202 and 304/305→302 — so four of
  // the tauren's seven horn choices drew pieces of another look's face.
  const index = await CharacterAppearanceIndex.load(dbcDirectory);
  let looks = 0;
  const moved = new Set();
  for (const profile of PROFILES) {
    const model = await modelOf(profile);
    if (!model) continue;
    const present = presentGeosets(model);
    const options = index.options(profile.race, profile.sex);
    for (const style of options.hairStyles) {
      for (const colour of options.hairColors) {
        for (const variation of options.facialHairs) {
          looks++;
          const appearance = index.forPlayer(profile.race, profile.sex, 0, 0, style, colour, variation);
          const { substitutions } = resolveGeosets(geosetList(appearance.geosets), present);
          for (const [from, to] of substitutions) moved.add(`${profile.name} ${from}->${to}`);
        }
      }
    }
  }
  assert.equal(looks, 18776, `the twenty profiles offer 18,776 (style, colour, facial) looks, not ${looks}`);
  assert.deepEqual([...moved], [], "a look the form offers draws exactly the ids it names");
});

test("Т5 the model draws the substitute, and the panel says so", withBoth, async () => {
  // Through the real build, because Т5 is about triangles on the screen. Item display 220 has
  // `GeosetGroup[0] = 1`, so the gateway emits boot variant 502 — which is what 471 of the 1,327
  // boot displays in this dataset do — and a tauren carries only 505.
  const index = await CharacterAppearanceIndex.load(dbcDirectory);
  const profile = PROFILES[10];
  const model = await modelOf(profile);
  const dressed = index.forPlayer(6, 0, 0, 0, 0, 0, 0, [{ slot: 7, inventoryType: 8, displayId: 220 }]);
  assert.ok(dressed.geosets.includes(502), `display 220 emits 502: ${dressed.geosets}`);

  const panelOf = (appearance) => buildForLab(model, {
    modelPath: `${modelPathOf(profile)}.m2`,
    slots: characterSlots("", appearance),
    geosets: geosetList(appearance.geosets),
    baseUrl: "http://gateway:8090",
    loadTexture: () => new THREE.Texture(),
    slotTextures: new Map([[1, new THREE.Texture()]]),
    skinned: false,
    emitted: appearance.geosets,
  }).panel;
  const panel = panelOf(dressed);
  const bare = panelOf(index.forPlayer(6, 0, 0, 0, 0, 0, 0));

  const boot = panel.geosets.find((line) => line.id === 505);
  assert.ok(boot && boot.drawn > 0, `the shaft is drawn: ${JSON.stringify(boot)}`);
  assert.equal(panel.triangles - bare.triangles, boot.drawn,
    "and the whole difference from the naked tauren is that boot");
  // The panel says which id was asked for and which was drawn instead of calling 502 missing.
  const asked = panel.geosets.find((line) => line.id === 502);
  assert.deepEqual(
    { emitted: asked.emitted, inModel: asked.inModel, drawnAs: asked.drawnAs },
    { emitted: true, inModel: false, drawnAs: 505 });
  assert.match(labSummary(panel), /геосетов нет в модели: 0 · заменено: 1/);
});
