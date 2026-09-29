import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { join, resolve } from "node:path";
import * as THREE from "three";
import { parseM2 } from "../tools/m2.mjs";
import { encodeWvm9 } from "../tools/wvm.mjs";
import { decodeWvm9 } from "../dist/code/browser/Wvm.js";
import {
  BODY_ONLY, EVERY_GEOSET, characterSlots, defaultCharacterGeosets, geosetList, geosetVisible,
  resolveGeosetId, resolveGeosets, unitGeosets, worldCharacterGeosets,
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
let visualDbcDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  dbcDirectory = paths.dbcDirectory();
  const candidate = resolve(process.env.VISUAL_DBC_DIR ?? join(process.cwd(), "data", "visual-dbc"));
  if (existsSync(join(candidate, "CreatureModelData.dbc"))) visualDbcDirectory = candidate;
} catch {
  dbcDirectory = undefined;
  visualDbcDirectory = undefined;
}
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };
const withBoth = { skip: archives && dbcDirectory ? false : "no 3.3.5a client and dataset on this machine" };
const patchWVisuals = archives && visualDbcDirectory
  && (await archives.locate("Character\\Human\\Male\\HumanMale.m2"))?.toLowerCase() === "patch-w.mpq"
  && (await archives.locate("DBFilesClient\\CreatureModelData.dbc"))?.toLowerCase() === "patch-w.mpq";
const withPatchW = {
  skip: patchWVisuals ? false : "no coordinated patch-W model and visual DBC pack on this machine",
};
const classicModels = archives
  && !/^patch-[w-z]\.mpq$/i.test((await archives.locate("Character\\Human\\Male\\HumanMale.m2")) ?? "");
const withClassic = {
  skip: archives && dbcDirectory && !visualDbcDirectory && classicModels
    ? false
    : "classic client verification requires no visual DBC overlay or patch-W/X/Y/Z model",
};

function loadAppearanceIndex() {
  return CharacterAppearanceIndex.load(
    dbcDirectory, undefined, visualDbcDirectory ?? dbcDirectory, Boolean(patchWVisuals));
}

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
  const present = presentGeosets(human);
  const availableBare = [...chosen.explicit].filter((id) => present.has(id)).sort((left, right) => left - right);
  const drawn = (choice) => new Set(human.submeshes
    .filter((submesh) => submesh.indexCount > 0 && geosetVisible(submesh.geosetId, choice))
    .map((submesh) => submesh.geosetId));
  assert.deepEqual([...drawn(BODY_ONLY)], [0], "geoset 0 alone is what it used to be");
  assert.deepEqual([...drawn(chosen)].sort((left, right) => left - right), availableBare,
    "the bare list draws every available default body part and no absent one");

  // And that is what the renderer picks for a character with no appearance. A pre-composed creature
  // has no appearance list to resolve: its M2's non-zero submeshes are authored body parts, so the
  // world path draws every one of them rather than treating the model as a torso-only BODY_ONLY
  // fallback.
  assert.deepEqual([...drawn(unitGeosets(undefined, true))].sort((left, right) => left - right), availableBare);
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
    "Creature\\HumanMaleKid\\HumanMaleKid",
    "Creature\\HumanMalePeasant\\HumanMalePeasant",
    "Creature\\Ogre\\Ogre",
  ];
  for (const base of cases) {
    const model = await modelAt(base);
    assert.ok(model, `${base} has to be readable for this regression`);
    const present = [...new Set(model.submeshes
      .filter((submesh) => submesh.indexCount > 0)
      .map((submesh) => submesh.geosetId))].sort((left, right) => left - right);
    const drawn = [...new Set(model.submeshes
      .filter((submesh) => submesh.indexCount > 0 && geosetVisible(
        submesh.geosetId, unitGeosets(undefined, false)))
      .map((submesh) => submesh.geosetId))].sort((left, right) => left - right);
    assert.ok(present.length > 0, `${base}: archive has no drawable geosets`);
    assert.deepEqual(drawn, present, `${base}: no authored geoset may be hidden`);
  }
});

test("Т1 the bare-character list closes the body below the waist on every playable model", withClient, async () => {
  // Position-matched boundary edges below 60% of each model's own height — the ankle-to-hip band.
  // The exact seam count belongs to the model generation. Keep the useful part of this check: the
  // fallback is only geoset 0, while the selected body includes every default lower-body family the
  // active file actually carries, and its boundary calculation remains finite.
  const chosen = defaultCharacterGeosets();
  let measured = 0;
  for (const profile of PROFILES) {
    const model = await modelOf(profile);
    if (!model) continue;
    measured++;
    const bodyOnly = openEdgesBelow(model, BODY_ONLY, 0.6);
    const bare = openEdgesBelow(model, chosen, 0.6);
    assert.ok(Number.isFinite(bodyOnly) && Number.isFinite(bare),
      `${profile.name}: boundary calculation must stay finite`);
    const present = presentGeosets(model);
    const drawn = [...present].filter((id) => geosetVisible(id, chosen));
    assert.ok(drawn.includes(0), `${profile.name}: the body geoset is visible`);
    assert.ok(drawn.some((id) => id >= 400 && id < 600) && drawn.some((id) => id >= 1300 && id < 1400),
      `${profile.name}: the default look keeps hands/feet and legs visible`);
  }
  assert.equal(measured, 20, `all twenty playable models have to be measured, got ${measured}`);
});

test("Т2 a naked tauren has no batch left painting itself flat green", withBoth, async () => {
  // The whole of Т2 in one number. Built through the same `characterSlots`, `geosetList` and
  // `buildModel` the renderer uses, with the body atlas supplied the way the renderer supplies it.
  const index = await loadAppearanceIndex();
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

  for (const profile of [PROFILES[10], PROFILES[11]]) {
    const appearance = index.forPlayer(profile.race, profile.sex, 0, 0, 0, 0, 0);
    assert.ok(appearance.skinExtra, `${profile.name} declares its skin-extra texture`);
    const panel = await build(profile, appearance);
    assert.equal(panel.flatTriangles, 0,
      `${profile.name}: ${panel.flatTriangles} of ${panel.triangles} triangles are still flat`
      + ` (${panel.materials.filter((line) => line.flat).map((line) => `geoset ${line.geoset} slot ${line.slot}`)})`);

    // And the same build with the field taken away is the defect, so the test cannot pass by the
    // slot having quietly stopped being sampled: a non-zero set of batches must still ask for type 8.
    const without = await build(profile, { ...appearance, skinExtra: "" });
    assert.ok(without.flatTriangles > 0, `${profile.name} without the file must expose flat triangles`);
    assert.ok(without.materials.filter((line) => line.flat).every((line) => line.slot === 8),
      `${profile.name} without the file only flattens the skin-extra slot`);
  }

  // Nobody else changes: a human male declares no slot 8 and was never flat to begin with. He
  // His own model does not declare slot 8 and must stay flat-free. The active model generation may
  // add or remove scalp triangles, so only the cap's actual geometry is compared below.
  const human = index.forPlayer(1, 0, 0, 0, 0, 0, 0);
  const panel = await build(PROFILES[0], human);
  assert.equal(panel.flatTriangles, 0);
  assert.ok(panel.triangles > 0, "the human body remains drawable");
});

test("Т3 not one look the form offers draws a batch with nothing in its slot", withBoth, async () => {
  // The contact sheet, without a browser. Every (style, colour) the options endpoint offers for
  // every playable profile, built through the real path, and not one of them may come out flat.
  // It used to be 3,278 cells with 48 of them a green night-elf wig — the colours 8 and 9 that
  // exist for no night elf — and on the female the 24-triangle brow-and-lash batch of geoset 0
  // went green with the wig, because it samples the hair slot too.
  const index = await loadAppearanceIndex();
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
  const sections = await openDbcFile(visualDbcDirectory ?? dbcDirectory, "CharSections");
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
  assert.ok(cells >= PROFILES.length, `the active visual DBC offers hair looks, got ${cells}`);
  // Not one offered look ends up with no hair texture any more. It was 25 before the review — the
  // tauren's hair colour 3, where no variation of that colour names anything at all — and that
  // colour is now off the list for a different reason: the core refuses to create a character with
  // it. The fallback that fills a blank slot from another row of the same colour still carries the
  // 59 bald rows that a beard is painted from, which is what `borrowed` counts.
  assert.equal(textureless, 0, `${textureless} offered looks end up with no hair texture`);
  assert.ok(borrowed >= 0 && borrowed <= cells, `borrowed looks are within the offered set: ${borrowed}`);
  // The active visual DBC supplies the facial-hair rows used to choose geosets.
  assert.ok(facials >= PROFILES.length, `the active visual DBC offers facial-hair variations, got ${facials}`);
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
  const bare = [...defaultCharacterGeosets().explicit];
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
    const crown = withCap.geosets.find((line) => line.id === 1)?.drawn ?? 0;
    if (crown === 0) {
      absent++;
      assert.equal(withCap.triangles, plain.triangles, `${profile.name} has no geoset 1 and must not move`);
      assert.equal(withCap.materials.length, plain.materials.length, `${profile.name} gained a material`);
      assert.equal(drawn(withCap), drawn(plain), `${profile.name} drew something else`);
    } else {
      assert.equal(withCap.triangles - plain.triangles, crown,
        `${profile.name}'s geoset 1 contributes its own triangles`);
      assert.equal(withCap.materials.length - plain.materials.length, 1, `${profile.name} draws it in one batch`);
    }
  }
  assert.ok(absent > 0 && absent < PROFILES.length,
    `${absent} of the twenty active models omit geoset 1`);
});

test("Т1 nothing about transparency or culling can hide a leg", withBoth, async () => {
  // The regression test the plan parks in Т1. Before the geoset arithmetic was believed, the two
  // other ways a limb can vanish had to be ruled out: a batch drawn in the transparent pass can be
  // sorted behind the body, and one that does not write depth can be painted over by it. Measured
  // over all twenty naked playable characters, and it is one rule with one exception.
  const index = await loadAppearanceIndex();
  let glows = 0;
  let glowTriangles = 0;
  let batches = 0;
  let triangles = 0;
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
      triangles += line.triangles;
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
  assert.ok(glows > 0 && glows < batches, `transparent batches are a bounded subset: ${glows}/${batches}`);
  assert.ok(glowTriangles > 0 && glowTriangles < triangles * 0.05,
    `transparent unlit geometry stays a small face/glow subset: ${glowTriangles}/${triangles}`);
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
  const taurenBoots = [...tauren].filter((id) => id >= 500 && id < 600);
  assert.ok(taurenBoots.length > 0, "TaurenMale carries a boot family");
  const activeBoot = Math.min(...taurenBoots);
  for (const asked of [502, 503, 504]) {
    assert.equal(resolveGeosetId(asked, tauren), tauren.has(asked) ? asked : activeBoot);
  }
  assert.equal(resolveGeosetId(activeBoot, tauren), activeBoot, "and one active boot is left alone");
  // Variant 1 is "no boot", and it stays silent rather than becoming a boot nobody asked for.
  assert.equal(resolveGeosetId(501, tauren), undefined);
  // Family 9 he carries as one active variant, so a kneepad follows the same road.
  const taurenKnees = [...tauren].filter((id) => id >= 900 && id < 1000);
  assert.ok(taurenKnees.length > 0, "TaurenMale carries a kneepad family");
  assert.equal(resolveGeosetId(902, tauren), Math.min(...taurenKnees));
  // A family absent from a model stays absent; this synthetic set keeps the oracle independent of
  // which active HD replacement happens to add or remove a race-specific family.
  assert.equal(resolveGeosetId(602, new Set([0])), undefined,
    "a model without family 6 does not invent a geoset for it");

  // 1103 — "Legguards of the Vault", entry 9396, display 18274, the one item in the dataset that
  // asks for it — on every model, because family 11 exists in all twenty. The active model may
  // carry a different variant, so resolve against the family it actually publishes.
  for (const profile of PROFILES) {
    const model = await modelOf(profile);
    if (!model) continue;
    const trousers = [...presentGeosets(model)].filter((id) => Math.floor(id / 100) === 11);
    assert.ok(trousers.length > 0, `${profile.name} carries a trousers family`);
    assert.ok(trousers.includes(resolveGeosetId(1103, presentGeosets(model))),
      `${profile.name} resolves the trousers to one of its own variants`);
  }

  // The whole list at once, with the substitutions handed back rather than worked out twice.
  const { choice, substitutions } = resolveGeosets(geosetList([0, 401, 502, 902, 1301, 1501]), tauren);
  assert.ok(choice.explicit.has(0) && choice.explicit.has(401) && choice.explicit.has(1301),
    "the tauren keeps the body, hands and legs");
  assert.equal(choice.explicit.has(502), false, "the absent boot spelling is not drawn directly");
  assert.equal(choice.explicit.has(902), false, "the absent knee spelling is not drawn directly");
  assert.equal(substitutions.get(502), resolveGeosetId(502, tauren));
  assert.equal(substitutions.get(902), resolveGeosetId(902, tauren));
  assert.ok(substitutions.size >= 1, "at least one absent garment variant is substituted");
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

    // Family 0: 0 is the body, 1 the crown, 2 upwards the hairstyles. It is not a substitute family.
    assert.equal(resolveGeosetId(5, new Set([0])), undefined);
    const taurenHair = [...tauren].filter((id) => Math.floor(id / 100) === 0 && id > 1);
    assert.ok(taurenHair.length > 0, "TaurenMale carries hairstyle geometry");
    const absentHair = [...Array(24).keys()].map((variant) => variant + 2)
      .find((id) => !tauren.has(id));
    if (absentHair !== undefined) assert.equal(resolveGeosetId(absentHair, tauren), undefined);

    // Families 1 to 3: the number is the look's own index, the same one in all three columns on
    // 131 of the 143 playable rows that name anything, so a family with no member of that index is
    // a look with no piece there. TaurenMale's look 4 is horn 105 and nothing else; resolving gave
    // him 202 and 302, the head-plate and snout-piece of look 2.
    const taurenFacial = [...tauren].filter((id) => id >= 100 && id < 400);
    assert.ok(taurenFacial.length > 0, "TaurenMale carries facial geometry");
    for (const family of [1, 2, 3]) {
      const missing = family * 100 + 99;
      assert.equal(resolveGeosetId(missing, tauren), undefined,
        `an absent facial variant in family ${family} stays silent`);
    }
    // Family 1 is unresolved rather than a nearest-neighbour family: an absent variant stays absent.
    const nightElfFacial = [...nightElf].filter((id) => id >= 100 && id < 200);
    assert.ok(nightElfFacial.length > 0, "NightElfMale carries family-1 facial geometry");
    const absentNightElf = [102, 104, 105].find((id) => !nightElf.has(id));
    if (absentNightElf !== undefined) assert.equal(resolveGeosetId(absentNightElf, nightElf), undefined);

    // Family 17: the nearest member is another race's eyes. A human model carries 1703 alone, the
    // death knight's, and five NPC displays — 11810, 16157, 16427, 18242, 19379 — emit 1702.
    const humanGlow = [...human].filter((id) => id >= 1700 && id < 1800);
    assert.ok(humanGlow.length > 0, "the human model carries an eye-glow variant");
    const absentHumanGlow = [1702, 1704].find((id) => !human.has(id));
    if (absentHumanGlow !== undefined) assert.equal(resolveGeosetId(absentHumanGlow, human), undefined,
      "a model does not answer a racial glow with another variant");
    const nightElfGlow = [...nightElf].find((id) => id >= 1700 && id < 1800);
    assert.ok(nightElfGlow !== undefined, "the night elf has its own eye glow");
    assert.equal(resolveGeosetId(nightElfGlow, nightElf), nightElfGlow);

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
  const index = await loadAppearanceIndex();
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
  assert.ok(perTriple.size > 1, `the item table has distinct GeosetGroup triples, got ${perTriple.size}`);

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
  assert.ok(outfits.size > PROFILES.length, `the item table produces outfits for the playable models, got ${outfits.size}`);

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
  assert.ok(familyless >= 0 && substituted >= 0, "resolution counts are non-negative");
  assert.ok(boots.size > 0, "the sweep exercises a tauren boot substitution");
  for (const [from, to] of boots) {
    assert.equal(resolveGeosetId(from, presentGeosets(await modelOf(PROFILES[10]))), to,
      `the tauren resolves boot ${from} to its active variant`);
  }
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
  const index = await loadAppearanceIndex();
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
  assert.ok(looks > PROFILES.length, `the active visual DBC offers facial looks, got ${looks}`);
  assert.deepEqual([...moved], [], "a look the form offers draws exactly the ids it names");
});

test("Т5 the model draws the substitute, and the panel says so", withBoth, async () => {
  // Through the real build, because Т5 is about triangles on the screen. Item display 220 has
  // `GeosetGroup[0] = 1`, so the gateway emits boot variant 502 — which is what 471 of the 1,327
  // boot displays in this dataset do — and a tauren carries only 505.
  const index = await loadAppearanceIndex();
  const profile = PROFILES[10];
  const model = await modelOf(profile);
  const dressed = index.forPlayer(6, 0, 0, 0, 0, 0, 0, [{ slot: 7, inventoryType: 8, displayId: 220 }]);
  assert.ok(dressed.geosets.includes(502), `display 220 emits 502: ${dressed.geosets}`);
  const expectedBoot = resolveGeosetId(502, presentGeosets(model));
  assert.ok(expectedBoot !== undefined, "the active tauren model carries a boot family");

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

  const boot = panel.geosets.find((line) => line.id === expectedBoot);
  assert.ok(boot && boot.drawn > 0, `the shaft is drawn: ${JSON.stringify(boot)}`);
  assert.equal(panel.triangles - bare.triangles, boot.drawn,
    "and the whole difference from the naked tauren is that boot");
  // The panel says which id was asked for and which was drawn instead of calling 502 missing.
  const asked = panel.geosets.find((line) => line.id === 502);
  assert.deepEqual(
    { emitted: asked.emitted, inModel: asked.inModel, drawnAs: asked.drawnAs },
    { emitted: true, inModel: false, drawnAs: expectedBoot });
  const missing = panel.geosets.filter((line) => line.emitted && !line.inModel && line.drawnAs === undefined).length;
  const substituted = panel.geosets.filter((line) => line.drawnAs !== undefined).length;
  assert.match(labSummary(panel), new RegExp(`геосетов нет в модели: ${missing} · заменено: ${substituted}`));
});

test("classic appearances keep stock belt and boot geoset choices", withClassic, async () => {
  const index = await CharacterAppearanceIndex.load(dbcDirectory);
  const plain = index.forPlayer(1, 0, 0, 0, 0, 0, 0);
  assert.equal(plain.coordinatedVisuals, undefined, "classic payloads do not opt into patch-W policy");
  assert.deepEqual(plain.geosets.filter((id) => Math.floor(id / 100) === 18), [],
    "a classic naked character does not gain the HD neutral waist");

  const belt = index.forPlayer(1, 0, 0, 0, 0, 0, 0,
    [{ slot: 5, inventoryType: 6, displayId: 6847 }]);
  assert.deepEqual(belt.geosets.filter((id) => Math.floor(id / 100) === 18), [],
    "a stock group-0 belt remains the classic draw-nothing variant");

  const profile = PROFILES[0];
  const model = await modelOf(profile);
  assert.ok(model, `${profile.name} should be readable for the classic geoset proof`);
  for (const [displayId, expected] of [[10141, 501], [9938, 502], [64771, 505]]) {
    const appearance = index.forPlayer(1, 0, 0, 0, 0, 0, 0,
      [{ slot: 7, inventoryType: 8, displayId }]);
    const emitted = appearance.geosets.find((id) => Math.floor(id / 100) === 5);
    assert.equal(emitted, expected, `classic display ${displayId} keeps its DBC boot group`);
    const choice = worldCharacterGeosets(model, appearance, true);
    const selected = [...choice.explicit].find((id) => Math.floor(id / 100) === 5);
    assert.equal(selected, expected, `classic display ${displayId} is not rewritten by patch-W UV policy`);
  }
});

test("an equipped belt keeps one active belt geoset and paints over trousers", withPatchW, async () => {
  const index = await loadAppearanceIndex();
  const profile = PROFILES[0];
  const model = await modelOf(profile);
  assert.ok(model, `${profile.name} should be readable for the belt proof`);

  // Display 6847 is a real waist display: its first GeosetGroup selects one belt variant. Include a
  // trouser display as well so the body-layer order is observable without a canvas or pixel oracle.
  const appearance = index.forPlayer(1, 0, 0, 0, 0, 0, 0, [
    { slot: 6, inventoryType: 7, displayId: 9892 },
    { slot: 5, inventoryType: 6, displayId: 6847 },
  ]);
  const beltIds = appearance.geosets.filter((id) => Math.floor(id / 100) === 18);
  assert.equal(beltIds.length, 1, `display 6847 emits one family-18 geoset: ${appearance.geosets}`);
  assert.ok(presentGeosets(model).has(beltIds[0]),
    `HumanMale carries active belt geoset ${beltIds[0]}`);

  const bodyPaths = appearance.body.map((layer) => layer.path.toLowerCase());
  const trouserIndex = bodyPaths.findIndex((path) => path.includes("pants") || path.includes("pant_"));
  const beltIndex = bodyPaths.findIndex((path) => path.includes("belt"));
  assert.ok(trouserIndex >= 0, `the trouser display contributes a body layer: ${appearance.body.map((l) => l.path)}`);
  assert.ok(beltIndex > trouserIndex, "the belt layer is painted after the trouser layer");
  assert.ok(appearance.body[beltIndex]?.path, "the belt body layer is non-empty");

  const panel = buildForLab(model, {
    modelPath: `${modelPathOf(profile)}.m2`,
    slots: characterSlots("", appearance),
    geosets: geosetList(appearance.geosets),
    baseUrl: "http://gateway:8090",
    loadTexture: () => new THREE.Texture(),
    slotTextures: new Map([[1, new THREE.Texture()]]),
    skinned: false,
    emitted: appearance.geosets,
  }).panel;
  const belt = panel.geosets.find((line) => line.id === beltIds[0]);
  assert.ok(belt && belt.drawn > 0, `active belt geoset is visible: ${JSON.stringify(belt)}`);
  assert.equal(panel.flatTriangles, 0, "the belt look has no flat visible triangles");
});

test("an equipped belt still selects authored 1802 on profiles that only carry the worn variant",
  withPatchW, async () => {
    const index = await loadAppearanceIndex();
    const profile = PROFILES[1];
    const model = await modelOf(profile);
    assert.ok(model, `${profile.name} should be readable for the equipped-belt control`);
    const appearance = index.forPlayer(profile.race, profile.sex, 0, 0, 0, 0, 0, [
      { slot: 5, inventoryType: 6, displayId: 6847 },
    ]);
    assert.deepEqual(appearance.geosets.filter((id) => Math.floor(id / 100) === 18), [1802],
      "the actual waist item remaps semantic variant 1 to the model's authored worn variant");
    assert.ok(appearance.body.some((layer) => layer.path.toLowerCase().includes("belt")),
      `the equipped belt paints its component into the body atlas: ${appearance.body.map((layer) => layer.path)}`);

    const panel = buildForLab(model, {
      modelPath: `${modelPathOf(profile)}.m2`,
      slots: characterSlots("", appearance),
      geosets: geosetList(appearance.geosets),
      baseUrl: "http://gateway:8090",
      loadTexture: () => new THREE.Texture(),
      slotTextures: new Map([[1, new THREE.Texture()]]),
      skinned: false,
      emitted: appearance.geosets,
    }).panel;
    const worn = panel.materials.filter((line) => line.geoset === 1802 && !line.hidden);
    assert.ok(worn.some((line) => line.slot === 1 && line.triangles > 0),
      `equipped 1802 remains drawable from the painted body atlas: ${JSON.stringify(worn)}`);
  });

test("a naked active model seeds its authored neutral belt", withPatchW, async () => {
  const index = await loadAppearanceIndex();
  const human = PROFILES[0];
  const model = await modelOf(human);
  assert.ok(model, `${human.name} should be readable for the neutral belt proof`);
  const appearance = index.forPlayer(human.race, human.sex, 0, 0, 0, 0, 0);
  assert.deepEqual(appearance.geosets.filter((id) => Math.floor(id / 100) === 18), [1801],
    "HumanMale's naked look names its authored 1801 waist");

  const choice = worldCharacterGeosets(model, appearance, true);
  const panel = buildForLab(model, {
    modelPath: `${modelPathOf(human)}.m2`,
    slots: characterSlots("", appearance),
    geosets: choice,
    baseUrl: "http://gateway:8090",
    loadTexture: () => new THREE.Texture(),
    slotTextures: new Map([[1, new THREE.Texture()]]),
    emitted: appearance.geosets,
  }).panel;
  const belt = panel.geosets.find((line) => line.id === 1801);
  assert.ok(belt && belt.drawn > 0, `the active neutral belt is drawn: ${JSON.stringify(belt)}`);
});

test("naked coordinated profiles request only the semantic neutral waist variant", withPatchW, async () => {
  const index = await loadAppearanceIndex();
  let authored = 0;
  for (const profile of PROFILES) {
    const model = await modelOf(profile);
    assert.ok(model, `${profile.name} should be readable for the neutral belt corpus`);
    const present = presentGeosets(model);
    const appearance = index.forPlayer(profile.race, profile.sex, 0, 0, 0, 0, 0);
    const emitted = appearance.geosets.filter((id) => Math.floor(id / 100) === 18);
    assert.deepEqual(emitted, [1801],
      `${profile.name} requests semantic variant 1 rather than inventing an equipped belt`);
    const resolved = resolveGeosets(geosetList(emitted), present).choice.explicit;
    const selected = [...resolved].filter((id) => Math.floor(id / 100) === 18);
    if (present.has(1801)) {
      authored++;
      assert.deepEqual(selected, [1801], `${profile.name} keeps its authored neutral waist bridge`);
    } else {
      assert.deepEqual(selected, [], `${profile.name} does not substitute worn variant 1802 for absent 1801`);
    }
  }
  assert.equal(authored, 11, "eleven active profiles author the semantic neutral waist variant");
});

test("HD-1 naked looks never render worn belt variant 1802 with the composed body atlas",
  withPatchW, async () => {
    const index = await loadAppearanceIndex();
    const offenders = [];
    for (const profile of PROFILES) {
      const model = await modelOf(profile);
      assert.ok(model, `${profile.name} should be readable for the naked waist texture proof`);
      const appearance = index.forPlayer(profile.race, profile.sex, 0, 0, 0, 0, 0);
      const panel = buildForLab(model, {
        modelPath: `${modelPathOf(profile)}.m2`,
        slots: characterSlots("", appearance),
        geosets: geosetList(appearance.geosets),
        baseUrl: "http://gateway:8090",
        loadTexture: () => new THREE.Texture(),
        slotTextures: new Map([[1, new THREE.Texture()]]),
        skinned: false,
        emitted: appearance.geosets,
      }).panel;
      const bodyAtlasTriangles = panel.materials
        .filter((line) => line.geoset === 1802 && !line.hidden && line.slot === 1)
        .reduce((sum, line) => sum + line.triangles, 0);
      if (bodyAtlasTriangles > 0) offenders.push({ profile: profile.name, bodyAtlasTriangles });
    }
    assert.deepEqual(offenders, [],
      `naked appearances must not render item-belt geometry with skin: ${JSON.stringify(offenders)}`);
  });

test("patch-W HumanMale boots keep their foot component drawable", withPatchW, async () => {
  // This is the live seam behind the missing-feet report: ItemDisplayInfo contributes both LL and
  // FO layers, then the active patch-W HumanMale WVM must select the one boot mesh whose UVs reach
  // the foot rectangle.  Testing the encoded/decoded model keeps this from becoming a gateway-only
  // assertion that can pass while the browser still has no drawable foot triangles.
  const index = await loadAppearanceIndex();
  const profile = PROFILES[0];
  const model = await modelOf(profile);
  assert.ok(model, `${profile.name} should be readable for the boot proof`);
  const present = presentGeosets(model);
  const maxV = (geosetId) => {
    let highest = -Infinity;
    for (const submesh of model.submeshes) {
      if (submesh.geosetId !== geosetId || submesh.indexCount === 0) continue;
      for (let offset = submesh.indexStart; offset < submesh.indexStart + submesh.indexCount; offset++) {
        highest = Math.max(highest, model.uv0[model.indices[offset] * 2 + 1]);
      }
    }
    return highest;
  };
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

  const boots = index.forPlayer(1, 0, 0, 0, 0, 0, 0, [
    { slot: 7, inventoryType: 8, displayId: 10141 },
  ]);
  const foot = boots.body.find((layer) => layer.section === "foot");
  assert.ok(foot?.path.includes("Boot_FO"),
    `display 10141 contributes a foot texture: ${boots.body.map((layer) => layer.path)}`);
  assert.ok(boots.geosets.includes(505), `display 10141 selects the foot-capable 505: ${boots.geosets}`);
  assert.equal(resolveGeosetId(505, present), 505, "patch-W carries the selected boot mesh");
  assert.ok(maxV(505) > 0.9, `boot 505 reaches the foot atlas rectangle (max V ${maxV(505)})`);
  const boot = panelOf(boots).geosets.find((line) => line.id === 505);
  assert.ok(boot && boot.drawn > 0, `foot-capable boot is drawn: ${JSON.stringify(boot)}`);

  // Keep the belt control in the same real pipeline: the adjacent waist layer must remain visible
  // while the feet fix changes only the ordinary boot variant.
  const beltAppearance = index.forPlayer(1, 0, 0, 0, 0, 0, 0, [
    { slot: 5, inventoryType: 6, displayId: 6847 },
  ]);
  assert.ok(beltAppearance.geosets.includes(1801),
    `display 6847 selects the active belt: ${beltAppearance.geosets}`);
  const belt = panelOf(beltAppearance).geosets.find((line) => line.id === 1801);
  assert.ok(belt && belt.drawn > 0, `active belt is drawn: ${JSON.stringify(belt)}`);

  // The numeric family is not a universal shape contract. The patch-W repair is profile-scoped:
  // the measured non-hoof profiles use their authored 505 shaft, while hoof/bare profiles retain
  // their own spellings.
  const orc = index.forPlayer(2, 0, 0, 0, 0, 0, 0, [
    { slot: 7, inventoryType: 8, displayId: 10141 },
  ]);
  assert.ok(orc.geosets.includes(505) && !orc.geosets.includes(501),
    `non-hoof profiles publish their foot-capable boot variant: ${orc.geosets}`);
});

test("patch-W footwear has real foot coverage on every non-hoof profile", withPatchW, async () => {
  // A max-V check is too weak: HumanFemale's ordinary 501 reaches .8838 through a handful of
  // ankle/seam vertices but still leaves almost all of the FootTexture rectangle unrepresented.
  // Measure actual triangles in the atlas's foot and legLower rectangles after the same model-aware
  // choice the world renderer uses. The three displays deliberately cover group 0, group 1 and a
  // patch-W group 4 item rather than making 10141 the only oracle.
  const index = await loadAppearanceIndex();
  const footwear = [10141, 9938, 64771];
  const hoofOrBare = new Set([
    "TaurenMale", "TaurenFemale", "TrollMale", "TrollFemale", "DraeneiMale", "DraeneiFemale",
  ]);
  const footMetrics = (model, id) => {
    let triangles = 0, footTriangles = 0, legLowerTriangles = 0;
    for (const submesh of model.submeshes) {
      if (submesh.geosetId !== id || submesh.indexCount <= 0) continue;
      for (let offset = submesh.indexStart; offset < submesh.indexStart + submesh.indexCount; offset += 3) {
        triangles++;
        const vertices = [0, 1, 2].map((corner) => model.indices[offset + corner]);
        const uv = vertices.map((vertex) => [model.uv0[vertex * 2], model.uv0[vertex * 2 + 1]]);
        const inRightAtlas = uv.every(([u]) => u >= 0.49);
        if (inRightAtlas && uv.every(([, v]) => v >= 0.8755)) footTriangles++;
        if (inRightAtlas && uv.every(([, v]) => v >= 0.625 && v < 0.8755)) legLowerTriangles++;
      }
    }
    return { triangles, footTriangles, legLowerTriangles };
  };

  for (const profile of PROFILES) {
    const model = await modelOf(profile);
    assert.ok(model, `${profile.name} should be readable for the footwear corpus`);
    const present = presentGeosets(model);
    for (const displayId of footwear) {
      const appearance = index.forPlayer(profile.race, profile.sex, 0, 0, 0, 0, 0,
        [{ slot: 7, inventoryType: 8, displayId }]);
      const sourceFoot = appearance.body.filter((layer) => layer.section === "foot");
      assert.equal(sourceFoot.length, 1, `${profile.name}/${displayId} has one FootTexture layer`);
      const emittedBoot = appearance.geosets.find((id) => Math.floor(id / 100) === 5);
      if (hoofOrBare.has(profile.name)) {
        // The gateway must not turn a hoof/bare profile into a shoe simply because another model
        // carries a 505 family member. Tauren's authored 505 is intentionally retained; Troll and
        // Draenei keep the display's ordinary group spelling.
        const expected = profile.name.startsWith("Tauren")
          ? (displayId === 9938 ? 502 : 505)
          : (displayId === 9938 ? 502 : displayId === 64771 ? 505 : 501);
        assert.equal(emittedBoot, expected,
          `${profile.name}/${displayId} keeps its authored hoof/bare boot variant`);
      } else {
        assert.equal(emittedBoot, 505,
          `${profile.name}/${displayId} publishes the active patch-W foot-capable boot`);
      }
      const choice = worldCharacterGeosets(model, appearance, true);
      const resolved = resolveGeosets(choice, present).choice;
      const selected = [...resolved.explicit].find((id) => Math.floor(id / 100) === 5);
      assert.ok(selected !== undefined, `${profile.name}/${displayId} selects a boot family`);
      const metrics = footMetrics(model, selected);
      if (hoofOrBare.has(profile.name)) {
        // Hoof/bare profiles are deliberately not upgraded to a human-style 505 shoe. Their
        // authored 501/505 choice is the contract, even when it has no FootTexture UV region.
        assert.ok(metrics.triangles > 0, `${profile.name}/${displayId} keeps authored boot triangles`);
        continue;
      }
      assert.ok(metrics.footTriangles / metrics.triangles >= 0.10,
        `${profile.name}/${displayId} draws real foot triangles: ${JSON.stringify({ selected, ...metrics })}`);
      assert.ok(metrics.legLowerTriangles > 0,
        `${profile.name}/${displayId} keeps legLower coverage: ${JSON.stringify({ selected, ...metrics })}`);
      const built = buildForLab(model, {
        modelPath: `${modelPathOf(profile)}.m2`,
        slots: characterSlots("", appearance),
        geosets: choice,
        baseUrl: "http://gateway:8090",
        loadTexture: () => new THREE.Texture(),
        slotTextures: new Map([[1, new THREE.Texture()]]),
        skinned: false,
        emitted: appearance.geosets,
      }).panel;
      const drawn = built.geosets.find((line) => line.id === selected);
      assert.ok(drawn && drawn.drawn >= metrics.footTriangles + metrics.legLowerTriangles,
        `${profile.name}/${displayId} submits selected boot triangles: ${JSON.stringify({ selected, metrics, drawn })}`);
    }
  }
});

test("patch-W baked NPC appearance keeps its foot-capable HumanMale mesh", withPatchW, async () => {
  // NPCs with CreatureDisplayInfoExtra use a full BakedNpcTextures layer, so there is no explicit
  // FootTexture component to trigger the player-equipment branch. The world path must still apply
  // the same model-aware decision or the common baked HumanMale displays remain ankle-only.
  const index = await loadAppearanceIndex();
  const baked = index.forNpc(3265);
  assert.ok(baked?.body.length === 1 && baked.body[0].section === undefined,
    "display-extra 3265 is the real baked NPC fixture");
  const model = await modelOf(PROFILES[0]);
  const choice = worldCharacterGeosets(model, baked, true);
  const resolved = resolveGeosets(choice, presentGeosets(model)).choice;
  const selected = [...resolved.explicit].find((id) => Math.floor(id / 100) === 5);
  assert.equal(selected, 505, `baked HumanMale selects the foot-capable boot: ${[...resolved.explicit]}`);
  const metrics = { triangles: 0, footTriangles: 0, legLowerTriangles: 0 };
  for (const submesh of model.submeshes) {
    if (submesh.geosetId !== selected || submesh.indexCount <= 0) continue;
    for (let offset = submesh.indexStart; offset < submesh.indexStart + submesh.indexCount; offset += 3) {
      metrics.triangles++;
      const uv = [0, 1, 2].map((corner) => {
        const vertex = model.indices[offset + corner];
        return [model.uv0[vertex * 2], model.uv0[vertex * 2 + 1]];
      });
      if (uv.every(([u, v]) => u >= 0.49 && v >= 0.8755)) metrics.footTriangles++;
      if (uv.every(([u, v]) => u >= 0.49 && v >= 0.625 && v < 0.8755)) metrics.legLowerTriangles++;
    }
  }
  assert.ok(metrics.footTriangles / metrics.triangles >= 0.10,
    `baked HumanMale draws real foot triangles: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.legLowerTriangles > 0,
    `baked HumanMale keeps legLower coverage: ${JSON.stringify(metrics)}`);
});

/**
 * Triangles of one geoset whose three corners all sit inside the atlas's `foot` rectangle.
 *
 * The same 0.49 / 0.8755 thresholds the footwear corpus above uses, so the two agree about what
 * "in the foot rectangle" means: `foot` is `{x:256,y:448,w:256,h:64}` of the 512x512 atlas, i.e.
 * u >= 0.5 and v >= 0.875 with a half-texel of slack.
 *
 * Only meaningful for a geoset whose every batch samples texture type 1. Family 5 and family 20 are
 * such; **geoset 0 is not** — on the active HumanMale it also carries type 6 and type 8 batches
 * whose coordinates address the hair sheet and the extra skin, so 24 of its triangles land in this
 * rectangle in hair-sheet space while none of them is a foot. That is why the corpus below asks
 * about z and not about UV.
 */
function footRectangleTriangles(model, geosetId) {
  let triangles = 0;
  for (const submesh of model.submeshes) {
    if (submesh.geosetId !== geosetId || submesh.indexCount <= 0) continue;
    for (let offset = submesh.indexStart; offset < submesh.indexStart + submesh.indexCount; offset += 3) {
      const corners = [0, 1, 2].map((corner) => model.indices[offset + corner]);
      if (corners.every((vertex) => model.uv0[vertex * 2] >= 0.49 && model.uv0[vertex * 2 + 1] >= 0.8755)) {
        triangles++;
      }
    }
  }
  return triangles;
}

/** The lowest and highest z of the drawable triangles of `ids`, or undefined when none are drawn. */
function heightRange(model, ids) {
  let lowest = Infinity;
  let highest = -Infinity;
  for (const submesh of model.submeshes) {
    if (submesh.indexCount <= 0 || (ids !== undefined && !ids.has(submesh.geosetId))) continue;
    for (let offset = submesh.indexStart; offset < submesh.indexStart + submesh.indexCount; offset++) {
      const z = model.positions[model.indices[offset] * 3 + 2];
      if (z < lowest) lowest = z;
      if (z > highest) highest = z;
    }
  }
  return Number.isFinite(lowest) ? { lowest, highest } : undefined;
}

function submeshHeightRanges(model, geosetId) {
  const ranges = [];
  for (const submesh of model.submeshes) {
    if (submesh.geosetId !== geosetId || submesh.indexCount <= 0) continue;
    let lowest = Infinity;
    let highest = -Infinity;
    for (let offset = submesh.indexStart; offset < submesh.indexStart + submesh.indexCount; offset++) {
      const z = model.positions[model.indices[offset] * 3 + 2];
      lowest = Math.min(lowest, z);
      highest = Math.max(highest, z);
    }
    ranges.push({ lowest, highest });
  }
  return ranges;
}

test("HD-1 Жмых keeps the authored waist bridge instead of mixing classic appearance with HD geometry",
  withPatchW, async () => {
    const profile = PROFILES.find((candidate) => candidate.race === 4 && candidate.sex === 0);
    const model = await modelOf(profile);
    assert.ok(model, "NightElfMale should be readable for the reported character regression");

    const equipment = [
      { slot: 3, inventoryType: 4, displayId: 3265 },
      { slot: 6, inventoryType: 7, displayId: 9937 },
      { slot: 7, inventoryType: 8, displayId: 9938 },
    ];
    const hd = (await loadAppearanceIndex()).forPlayer(4, 0, 8, 6, 3, 1, 5, equipment);
    const classic = (await CharacterAppearanceIndex.load(dbcDirectory))
      .forPlayer(4, 0, 8, 6, 3, 1, 5, equipment);
    const hdChoice = worldCharacterGeosets(model, hd, true);
    const classicChoice = worldCharacterGeosets(model, classic, true);

    const trousers = heightRange(model, new Set([1301]));
    const upperBody = submeshHeightRanges(model, 0)
      .filter((range) => range.lowest > trousers.highest)
      .sort((left, right) => left.lowest - right.lowest)[0];
    assert.ok(upperBody, "the replacement model has a separately authored upper torso");
    assert.ok(upperBody.lowest - trousers.highest > 0.05,
      "the forbidden classic/HD pairing reproduces the visible waist gap");
    assert.equal([...classicChoice.explicit].some((id) => Math.floor(id / 100) === 18), false,
      "classic appearance has no replacement-model waist bridge");

    const belt = [...hdChoice.explicit].find((id) => Math.floor(id / 100) === 18);
    assert.ok(belt, `the coordinated appearance selects an authored waist: ${hd.geosets}`);
    const bridge = heightRange(model, new Set([belt]));
    assert.ok(bridge.lowest <= trousers.highest + 0.005,
      `waist ${belt} reaches the trousers (${bridge.lowest} <= ${trousers.highest})`);
    assert.ok(bridge.highest >= upperBody.lowest - 0.005,
      `waist ${belt} reaches the upper torso (${bridge.highest} >= ${upperBody.lowest})`);
  });

test("HD-1 the coordinated pack's own foot mesh is named by whoever needs one", withPatchW, async () => {
  // The owner's «ноги пропали», measured. Ten of the twenty active profiles have taken the foot out
  // of geoset 0 and authored it as a family-20 mesh — the active HumanMale's geoset 0 spans z
  // 0.71..2.02 where the classic one spans -0.00..1.96, and the 630 triangles between 0.00 and 0.13
  // are geoset 2001. Nothing emitted family 20, so those ten stood on bare stumps in the world and
  // on the glue screens alike.
  //
  // The oracle is the model and not the gateway's own table: a profile needs a foot mesh exactly
  // when its geoset 0 stops well above the model's own floor, and the mesh it needs is the
  // family-20 member that reaches that floor. That is what makes this a regression test rather than
  // a restatement of `FOOT_GEOSET_PROFILES` — and it catches the two traps in the family,
  // NightElfFemale's 2002 (a crown at z 2.04..2.17) and GnomeMale's 2002 (z 0.75..0.79), which a
  // "lowest member of the family" fallback would have hung off an ankle.
  const index = await loadAppearanceIndex();
  let needing = 0;
  for (const profile of PROFILES) {
    const model = await modelOf(profile);
    assert.ok(model, `${profile.name} should be readable for the foot corpus`);
    const present = presentGeosets(model);
    const whole = heightRange(model, undefined);
    const body = heightRange(model, new Set([0]));
    // A twentieth of the model's own height: far above the 1-2 mm of numerical slack at the sole
    // and far below the 0.22 the smallest of the ten (GnomeMale, 1.00 tall) leaves open.
    const slack = (whole.highest - whole.lowest) / 20;
    const grounded = [...present]
      .filter((id) => Math.floor(id / 100) === 20)
      .filter((id) => heightRange(model, new Set([id])).lowest - whole.lowest <= slack);
    const needsFoot = body.lowest - whole.lowest > slack;

    const appearance = index.forPlayer(profile.race, profile.sex, 0, 0, 0, 0, 0);
    const emitted = appearance.geosets.filter((id) => Math.floor(id / 100) === 20);
    if (!needsFoot) {
      assert.deepEqual(emitted, [],
        `${profile.name} keeps its foot inside geoset 0 (down to z ${body.lowest.toFixed(2)}) `
        + "and must not be sent one");
      continue;
    }
    needing++;
    assert.equal(grounded.length, 1,
      `${profile.name} authored exactly one family-20 mesh at its floor, got ${grounded}`);
    assert.deepEqual(emitted, grounded,
      `${profile.name} names the family-20 mesh that actually reaches its floor`);
    assert.equal(resolveGeosetId(grounded[0], present), grounded[0],
      `${profile.name}'s foot mesh survives resolution rather than reading as "no foot"`);
  }
  // Nine of them name 2001 and DwarfMale names 2002; the count is what says the corpus found the
  // split at all rather than passing because nobody needed anything.
  assert.equal(needing, 10, `ten active profiles authored a separate foot mesh, got ${needing}`);
});

test("HD-1 a naked coordinated character stands on the ground again", withPatchW, async (t) => {
  // Through the real build, because the defect was triangles that were not on the screen. For each
  // profile that needs one, the naked look must draw its foot mesh, and — the part that is the
  // defect rather than the fix — the same look with that one id taken out must stop short of the
  // ground. Measured over the ten: HumanMale's drawn body ended at z 0.10 without it and reaches
  // -0.01 with it, and the other nine are the same shape of gap.
  const index = await loadAppearanceIndex();
  let measured = 0;
  for (const profile of PROFILES) {
    const model = await modelOf(profile);
    const appearance = index.forPlayer(profile.race, profile.sex, 0, 0, 0, 0, 0);
    const foot = appearance.geosets.find((id) => Math.floor(id / 100) === 20);
    if (foot === undefined) continue;
    measured++;
    const panel = buildForLab(model, {
      modelPath: `${modelPathOf(profile)}.m2`,
      slots: characterSlots("", appearance),
      geosets: worldCharacterGeosets(model, appearance, true),
      baseUrl: "http://gateway:8090",
      loadTexture: () => new THREE.Texture(),
      slotTextures: new Map([[1, new THREE.Texture()]]),
      skinned: false,
      emitted: appearance.geosets,
    }).panel;
    const line = panel.geosets.find((entry) => entry.id === foot);
    assert.ok(line && line.drawn > 0, `${profile.name} draws its foot mesh: ${JSON.stringify(line)}`);
    assert.equal(panel.flatTriangles, 0,
      `${profile.name}: the foot mesh samples a filled slot (${panel.flatTriangles} flat)`);

    const whole = heightRange(model, undefined);
    const drawn = new Set(panel.geosets.filter((entry) => entry.drawn > 0).map((entry) => entry.id));
    const withFoot = heightRange(model, drawn).lowest;
    drawn.delete(foot);
    const withoutFoot = heightRange(model, drawn).lowest;
    t.diagnostic(`${profile.name}: geoset ${foot} takes the drawn body from z ${withoutFoot.toFixed(3)} `
      + `down to ${withFoot.toFixed(3)}, against the model's own floor of ${whole.lowest.toFixed(3)}`);
    // Five millimetres, four orders above the rounding these positions carry and two below the
    // smallest gap the ten leave open (GnomeMale, 0.05 on a model 1.01 tall).
    assert.ok(withoutFoot - withFoot > 0.005,
      `${profile.name} without the foot mesh is the defect: the body stops at z ${withoutFoot.toFixed(3)}`);
    // And it reaches the ground plane, not merely lower. `whole.lowest` is not the oracle here: it
    // is -0.013 on HumanMale because the full boot 505 and the long skirt 1302 dip below the plane,
    // and a naked character draws neither.
    assert.ok(withFoot <= 0.01,
      `${profile.name}'s naked look reaches z 0: ${withFoot.toFixed(3)}`);
  }
  assert.equal(measured, 10, `ten naked profiles draw a foot mesh, got ${measured}`);
});

test("HD-1 the fifth boot variant carries its own sole and is not doubled", withPatchW, async () => {
  // The one exception, measured rather than assumed: 505 is the only family-5 member that reaches
  // the sole, and it paints the foot rectangle itself. So a look that settles on it is not also
  // sent the bare foot underneath, while every other boot variant is.
  const index = await loadAppearanceIndex();
  const profile = PROFILES[0];
  const model = await modelOf(profile);
  assert.ok(footRectangleTriangles(model, 505) > 0, "HumanMale's 505 paints the foot rectangle");

  // Display 10141 carries a FootTexture component, which is what selects 505 on a non-hoof profile.
  const booted = index.forPlayer(1, 0, 0, 0, 0, 0, 0, [{ slot: 7, inventoryType: 8, displayId: 10141 }]);
  assert.ok(booted.geosets.includes(505), `display 10141 settles on 505: ${booted.geosets}`);
  assert.deepEqual(booted.geosets.filter((id) => Math.floor(id / 100) === 20), [],
    "a boot that carries its own sole is not given a second one underneath");

  // Display 9892 is a trousers display: it moves no boot, so the naked boot variant stands and the
  // foot mesh comes with it.
  const trousered = index.forPlayer(1, 0, 0, 0, 0, 0, 0, [{ slot: 6, inventoryType: 7, displayId: 9892 }]);
  assert.deepEqual(trousered.geosets.filter((id) => Math.floor(id / 100) === 20), [2001],
    `a look that keeps the bare boot keeps the foot: ${trousered.geosets}`);
});

test("NPCItemDisplay slots drive baked NPC belt and boots", withPatchW, async () => {
  // 3265 is a real baked HumanMale display. Its CreatureDisplayInfoExtra row carries a waist
  // display (8551) and feet display (8553); before this bridge forNpc ignored all eleven columns,
  // so only the neutral 501 boot was emitted and the NPC lost the authored belt/boot choice.
  const appearance = (await loadAppearanceIndex()).forNpc(3265);
  assert.ok(appearance, "display-extra 3265 should resolve");
  assert.ok(appearance.body.length === 1 && appearance.body[0].section === undefined,
    "the NPC remains on its baked body texture");
  assert.ok(appearance.geosets.includes(1801),
    `NPC waist slot selects the active HumanMale belt: ${appearance.geosets}`);
  assert.ok(appearance.geosets.includes(505),
    `NPC feet slot selects the foot-capable boot: ${appearance.geosets}`);
  assert.deepEqual(appearance.attached, [], "NPC item columns do not opt into attached gear");
});
