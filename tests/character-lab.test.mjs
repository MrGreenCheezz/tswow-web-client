import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  appearanceQuery, labGatewayUrl, parseLabItems, parseLabQuery, playableProfiles,
  PLAYABLE_RACE_DISPLAYS,
} from "../dist/code/browser/lab/LabQuery.js";
import { buildForLab, labAttachmentLines, labSummary, texturePathOf } from "../dist/code/browser/lab/LabReport.js";
import {
  CHARACTER_APPEARANCE_VERSION, CHARACTER_OPTIONS_VERSION, isCharacterOptions,
} from "../dist/code/browser/CharacterAtlas.js";
import { characterSlots, geosetList } from "../dist/code/browser/ModelBuild.js";

/**
 * A model with one geoset per interesting case: a body geoset the composed atlas fills, a geoset
 * whose slot nothing fills, a geoset whose slot the appearance names a file for, and one the file
 * carries that this character was never asked to wear.
 *
 * The numbers are the shape of a real character in miniature: 0 is the body, 501 the shin, 1301
 * the thigh and 1302 the other pair of boots, and the appearance also asks for 702 (the ears) which
 * this file does not carry — which is the case the panel exists to tell apart from a missing
 * texture. The declared type 2 slot is the cloak that every character model declares and that
 * nobody without a cloak draws: empty, and not a defect.
 */
function labModel() {
  const vertices = 15;
  const indices = new Uint16Array(Array.from({ length: vertices }, (_, index) => index));
  const batch = (submesh, texture) => ({
    submesh, blendMode: 0, materialFlags: 0, priorityPlane: 0, materialLayer: 0,
    textures: [texture], uvSets: [0], shaderId: 0, colorIndex: -1, textureWeight: -1, textureTransform: -1,
  });
  return {
    positions: new Float32Array(vertices * 3).map((_, index) => (index % 7) * 0.1),
    normals: new Float32Array(vertices * 3).fill(0),
    uv0: new Float32Array(vertices * 2).fill(0),
    uv1: new Float32Array(vertices * 2).fill(0),
    indices,
    submeshes: [
      { geosetId: 0, indexStart: 0, indexCount: 6 },
      { geosetId: 501, indexStart: 6, indexCount: 3 },
      { geosetId: 1301, indexStart: 9, indexCount: 3 },
      { geosetId: 1302, indexStart: 12, indexCount: 3 },
    ],
    batches: [batch(0, 0), batch(1, 1), batch(2, 2), batch(3, 2)],
    // 1 body, 8 skin extra (what the tauren declares and nothing fills), 6 hair, 2 cloak.
    textures: [
      { type: 1, flags: 0, path: "" }, { type: 8, flags: 0, path: "" },
      { type: 6, flags: 0, path: "" }, { type: 2, flags: 0, path: "" },
    ],
    attachments: [],
    bounds: { min: [0, 0, 0], max: [1, 1, 2], radius: 2 },
    globalSequences: new Uint32Array(0),
    particleEmitters: [],
    ribbonEmitters: [],
  };
}

const HAIR = "Character\\Human\\Hair00_00.blp";

function labPanel() {
  const appearance = { body: [{ path: "skin.blp" }], hair: HAIR, cloak: "", geosets: [0, 501, 702, 1301], attached: [] };
  return buildForLab(labModel(), {
    modelPath: "Character\\Human\\Male\\HumanMale.m2",
    slots: characterSlots("", appearance),
    geosets: geosetList(appearance.geosets),
    baseUrl: "http://gateway:8090",
    // A fresh texture per call, as `TextureLoader.load` hands one back per call.
    loadTexture: () => new THREE.Texture(),
    slotTextures: new Map([[1, new THREE.Texture()]]),
    skinned: false,
    emitted: appearance.geosets,
  });
}

test("the lab panel separates a geoset the model lacks from a texture nothing fills", () => {
  const { panel } = labPanel();

  const ears = panel.geosets.find((line) => line.id === 702);
  assert.ok(ears, "702 was emitted, so it has to appear in the panel");
  assert.equal(ears.emitted, true);
  assert.equal(ears.inModel, false, "the model carries no 702 and the panel must say so");
  assert.equal(ears.triangles, 0);

  const shin = panel.geosets.find((line) => line.id === 501);
  assert.equal(shin.inModel, true);
  assert.equal(shin.triangles, 1);
  assert.equal(shin.drawn, 1, "a geoset that is both emitted and present is drawn");

  // And the other way round, which is the column the panel had no test for: the file carries 1302
  // and this character was never asked to wear it, so it is in the model, out of the picture, and
  // not a fault of anything.
  const otherBoots = panel.geosets.find((line) => line.id === 1302);
  assert.equal(otherBoots.emitted, false);
  assert.equal(otherBoots.inModel, true);
  assert.equal(otherBoots.triangles, 1, "the file's own triangles are counted whether drawn or not");
  assert.equal(otherBoots.drawn, 0);

  // The shin's batch samples slot 8, which nothing fills: present geometry, missing texture.
  const flat = panel.materials.filter((line) => line.flat);
  assert.equal(flat.length, 1);
  assert.equal(flat[0].geoset, 501);
  assert.equal(panel.flatTriangles, 1);
  assert.equal(panel.triangles, 4);
  assert.equal(panel.modelTriangles, 5);
});

test("the lab says which batches the file itself switched off", () => {
  // The third answer the panel used to have no way to give. A geoset can be absent, its texture can
  // fail to arrive, and — since WVM8 — the artist can have switched the batch off with a zero track,
  // which this client drew anyway. A hidden batch is not counted among the triangles on the screen.
  const model = labModel();
  model.batches[1].colorIndex = 0;
  model.colours = [{
    rgb: { interpolation: 1, globalSequence: -1, components: 3, tracks: [{ sequence: 0, times: new Uint32Array([0]), values: new Float32Array([1, 1, 1]) }] },
    alpha: { interpolation: 1, globalSequence: -1, components: 1, tracks: [{ sequence: 0, times: new Uint32Array([0]), values: new Float32Array([0]) }] },
  }];
  const appearance = { body: [{ path: "skin.blp" }], hair: HAIR, cloak: "", geosets: [0, 501, 702, 1301], attached: [] };
  const { panel } = buildForLab(model, {
    modelPath: "Character\Human\Male\HumanMale.m2",
    slots: characterSlots("", appearance),
    geosets: geosetList(appearance.geosets),
    baseUrl: "http://gateway:8090",
    loadTexture: () => new THREE.Texture(),
    slotTextures: new Map([[1, new THREE.Texture()]]),
    skinned: false,
    emitted: appearance.geosets,
  });

  const hidden = panel.materials.filter((line) => line.hidden);
  assert.equal(hidden.length, 1, "one batch was switched off");
  assert.equal(hidden[0].geoset, 501, "the shin, whose colour track is a flat zero");
  assert.equal(panel.triangles, 3, "and its triangle is not among the ones on the screen");
  assert.equal(panel.flatTriangles, 0, "nor among the flat ones, since nothing of it is drawn");
  assert.equal(panel.geosets.find((line) => line.id === 501).drawn, 0);
  assert.equal(panel.geosets.find((line) => line.id === 501).triangles, 1, "the file still carries it");
});

test("the lab panel names the file behind every material it drew", () => {
  const { panel } = labPanel();
  const byGeoset = new Map(panel.materials.map((line) => [line.geoset, line]));

  // The body is the composed atlas, which has no path of its own.
  assert.equal(byGeoset.get(0).texture, "атлас");
  assert.equal(byGeoset.get(0).triangles, 2);
  // The hair slot is filled from the appearance, so the material names the MPQ path rather than
  // the URL it was fetched through.
  assert.equal(byGeoset.get(1301).texture, HAIR);
  assert.equal(byGeoset.get(501).texture, "");
  assert.equal(byGeoset.get(1302), undefined, "a geoset nobody asked for draws no material");

  // Which slot each batch reached for, so a flat row says what is missing rather than that
  // something is: the shin is the tauren's case, slot 8, declared by the model and filled by
  // nobody.
  assert.equal(byGeoset.get(0).slot, 1);
  assert.equal(byGeoset.get(501).slot, 8);
  assert.equal(byGeoset.get(501).slotLabel, "skin extra");
  assert.equal(byGeoset.get(1301).slot, 6);

  const slots = new Map(panel.slots.map((line) => [line.type, line]));
  assert.equal(slots.get(1).kind, "composed");
  assert.equal(slots.get(6).filledWith, HAIR);
  assert.equal(slots.get(8).kind, "empty", "slot 8 is declared and nothing fills it");
  assert.equal(slots.get(8).sampled, true, "and the shin draws it");
  // The cloak slot is declared, empty, and sampled by nothing this character wears.
  assert.equal(slots.get(2).kind, "empty");
  assert.equal(slots.get(2).sampled, false);
  assert.deepEqual(panel.texturePaths, [HAIR]);
});

test("the lab summary counts the flat triangles and the geosets that are not in the file", () => {
  const { panel } = labPanel();
  const summary = labSummary(panel);
  assert.match(summary, /4 тр\. из 5/);
  assert.match(summary, /плоских 1 \(25\.0%, 1 мат\.\)/);
  assert.match(summary, /геосетов нет в модели: 1/);
  // Two slots are empty and only one of them is drawn. Counting both called a character with no
  // cloak defective for not having one.
  assert.equal(panel.slots.filter((line) => line.kind === "empty").length, 2);
  assert.match(summary, /пустых слотов на видимых батчах: 1/);
});

test("the lab says where every worn piece hangs, and why one of them hangs nowhere", () => {
  // Measured from the gateway on this machine: itemDisplay 28135 in the head slot answers with
  // this model and hides the face and ear geosets to make room for it. Drawn nowhere, the page
  // showed a bare earless head and called the build clean.
  const helm = {
    slot: 0, inventoryType: 1, side: "left",
    model: "Item\\ObjectComponents\\Head\\Helm_Plate_D_03_HuM.m2",
    texture: "Item\\ObjectComponents\\Head\\Helm_Plate_D_03Purple.blp",
  };
  const sword = { slot: 15, inventoryType: 21, side: "left", model: "Item\\ObjectComponents\\Weapon\\Sword_1H_A_01.m2", texture: "" };
  const pauldron = (side) => ({ slot: 2, inventoryType: 3, side, model: `${side}Shoulder_Plate_A_01.m2`, texture: "" });

  const drawn = labAttachmentLines([helm, sword, pauldron("left"), pauldron("right")], 1);
  assert.equal(drawn[0].point, 11, "a helmet hangs off ATTACHMENT_HELM");
  assert.equal(drawn[0].refusal, undefined);
  assert.equal(drawn[0].texture, helm.texture, "an item model does not name its own skin");
  assert.equal(drawn[1].point, 1, "the main hand is the right one");
  // The shoulders are the one slot with two pieces, and they are two separate meshes.
  assert.equal(drawn[2].point, 6);
  assert.equal(drawn[3].point, 5);

  // Nothing drawn: where a stowed weapon goes needs the item's sheath type, which the browser is
  // never told, so the client hangs nothing rather than putting a sword across the wrong shoulder.
  const stowed = labAttachmentLines([helm, sword], 0);
  assert.equal(stowed[1].point, undefined);
  assert.match(stowed[1].refusal, /ножн/);
  assert.equal(stowed[0].point, 11, "a helmet is worn whatever the weapons are doing");
  assert.equal(labAttachmentLines([], 1).length, 0);
});

test("the lab page can hide the canvas it is not drawing into", async () => {
  const html = await readFile(new URL("../character-lab.html", import.meta.url), "utf8");
  // `hidden` is honoured by one rule in the browser's own stylesheet, and *any* author rule for
  // `display` outranks it whatever its specificity — so with the rule below and without the
  // `!important` one, `canvas.hidden = true` does nothing at all and the contact sheet renders
  // under a full-size stray view of its own last cell.
  assert.match(html, /canvas\s*\{[^}]*display:\s*block/, "this is the rule that makes it necessary");
  assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test("the lab reads a look out of the query string the way the client spells one", async () => {
  const query = parseLabQuery("?race=6&sex=1&skin=2&face=3&hair=4&hairColor=5&facialHair=6&items=7:8:10141,6:7:9892");
  assert.equal(query.race, 6);
  assert.equal(query.sex, 1);
  assert.equal(query.skin, 2);
  assert.equal(query.face, 3);
  assert.equal(query.hair, 4);
  assert.equal(query.hairColor, 5);
  assert.equal(query.facialHair, 6);
  assert.deepEqual(query.items, [
    { slot: 7, inventoryType: 8, displayId: 10141 },
    { slot: 6, inventoryType: 7, displayId: 9892 },
  ]);
  assert.equal(query.sheet, undefined);
  assert.equal(query.animation, "Stand");
  // A weapon is hung only while it is out, so the page draws one by default: a lab that showed a
  // character holding nothing would be right about it and useless.
  assert.equal(query.sheath, 1);
  assert.equal(parseLabQuery("?sheath=0").sheath, 0);

  // Sorted, versioned, and the items encoded — the same request `playerAppearance` makes, because
  // a lab that asks a different question than the client asks is not evidence about the client.
  // The version is spelt from the shared constant rather than written out, because it used to be
  // written out in three places — the client, the lab and here — and the first bump would have
  // left the lab asking an older question and reading it out of the browser's own cache.
  const version = `v=${CHARACTER_APPEARANCE_VERSION}`;
  // 4 rather than 3: the review found that Т3 and Т4 changed what the route answers without a
  // field being added, and the constant's rule now says "changes what it answers", not "gains a
  // field". A returning browser would otherwise have drawn an hour more of green beards. 5 rather
  // than 4: Т7 puts the spelling the archives really hold first, which changes `path` itself on
  // three layers in four of a dressed character.
  assert.equal(CHARACTER_APPEARANCE_VERSION, 5, "5 is the version that asks the archives which file exists");
  assert.equal(
    appearanceQuery(query),
    `${version}&race=6&sex=1&skin=2&face=3&hair=4&hairColor=5&facialHair=6&items=6%3A7%3A9892%2C7%3A8%3A10141`);
  assert.equal(appearanceQuery(parseLabQuery("")),
    `${version}&race=1&sex=0&skin=0&face=0&hair=0&hairColor=0&facialHair=0`);
  // And it really is the client's own number, not a second constant that happens to agree.
  const client = await readFile(new URL("../src/browser/CreatureModelClient.ts", import.meta.url), "utf8");
  assert.match(client, /`v=\$\{CHARACTER_APPEARANCE_VERSION\}/,
    "the client has to send the shared version rather than a copy of it");
});

test("the lab refuses a query it would otherwise draw the wrong character for", () => {
  assert.throws(() => parseLabQuery("?hair=300"), /hair=300/);
  assert.throws(() => parseLabQuery("?skin=-1"), /skin=-1/);
  assert.throws(() => parseLabQuery("?items=6:7"), /items=6:7/);
  assert.throws(() => parseLabQuery("?sheet=faces"), /sheet=faces/);
  assert.throws(() => parseLabQuery("?display=0"), /display=0/);
  assert.throws(() => parseLabQuery("?sheath=3"), /sheath=3/);
  assert.deepEqual(parseLabItems(""), []);
});

test("the lab sweeps the twenty playable profiles and takes their models from ChrRaces", () => {
  const profiles = playableProfiles();
  assert.equal(profiles.length, 20);
  assert.deepEqual(profiles[0], { race: 1, sex: 0, display: 49 });
  assert.deepEqual(profiles[1], { race: 1, sex: 1, display: 50 });
  // Race 9 is the goblin, which 3.3.5 ships unplayable, so it is not in the sweep.
  assert.equal(PLAYABLE_RACE_DISPLAYS[9], undefined);
  assert.deepEqual(PLAYABLE_RACE_DISPLAYS[10], [15476, 15475]);
  assert.equal(new Set(profiles.map((profile) => profile.display)).size, 20);
});

test("the lab page carries every element the lab reaches for", async () => {
  // `element()` throws on a missing id, and it runs while the module is being evaluated — so an id
  // that drifts out of the page turns the whole lab into a blank screen with a console message.
  // Nothing else in this repo can catch that: the page is never rendered by a test.
  const source = await readFile(new URL("../src/browser/lab/CharacterLab.ts", import.meta.url), "utf8");
  const html = await readFile(new URL("../character-lab.html", import.meta.url), "utf8");
  const ids = [...source.matchAll(/element<[^>]+>\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(ids.length >= 9, `the lab should be asking for its panel; found ${ids.length}`);
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `character-lab.html has no #${id}`);
  assert.match(html, /<script type="module" src="\/src\/browser\/lab\/CharacterLab\.ts"><\/script>/);
});

test("the lab reaches the shipping modules and none of the login flow", async () => {
  const sources = await Promise.all(["CharacterLab", "LabReport", "LabQuery"].map((name) =>
    readFile(new URL(`../src/browser/lab/${name}.ts`, import.meta.url), "utf8")));
  const all = sources.join("\n");
  // The point of the page is that it exercises the client's own code. A second copy of any of
  // these would make every observation it produces evidence about the copy instead.
  for (const module of [
    "../Wvm.js", "../ModelBuild.js", "../CharacterAtlas.js", "../AnimatedModel.js",
    "../TextureLoad.js", "../Attachment.js",
  ]) {
    assert.ok(all.includes(`from "${module}"`), `the lab must build with the real ${module}`);
  }
  // And there is no login, no world server and no game context in this page; importing any of them
  // would drag in module-level DOM that only index.html has. Read off the import specifiers rather
  // than the file text, so that naming one of them in a comment is not a failure.
  // `from "x"` and the bare `import "x"` alike: a side-effect import of the game context would
  // pull in exactly as much of the client as a named one.
  const imported = [...all.matchAll(/(?:^|\n)\s*(?:import|export)(?:[^\n]*?from)? "([^"]+)"/g)].map((match) => match[1]);
  for (const forbidden of ["game/Context", "ui/Dom", "app/Login", "app/EnterWorld", "WorldRenderer3D"]) {
    assert.ok(!imported.some((specifier) => specifier.includes(forbidden)),
      `the lab must not import ${forbidden}`);
  }
});

test("the lab takes the gateway from the page, as the login screen does", () => {
  assert.equal(labGatewayUrl({ protocol: "http:", hostname: "10.0.0.4" }), "http://10.0.0.4:8090");
  assert.equal(labGatewayUrl({ protocol: "https:", hostname: "wow.example" }), "https://wow.example:8090");
  assert.equal(texturePathOf("http://x/texture?path=Character%5CHuman%5CHair.blp"), "Character\\Human\\Hair.blp");
});

test("Т3 a gateway older than the bundle hides the appearance controls instead of breaking them", () => {
  // The page and the gateway ship separately, and the `v=` in the query is a cache-buster rather
  // than a handshake: an older gateway ignores it and answers the counts. That answer used to go
  // straight into `fillLook`, where `values.entries()` on a number throws inside a `void`ed
  // promise — the loop over the five selects aborts on the first, all five are left empty, and the
  // form submits five zeros, which is the bald character the whole slice is about.
  assert.equal(CHARACTER_OPTIONS_VERSION, 3, "1 was the counts, 2 the lists, 3 the lists the core accepts");
  assert.equal(isCharacterOptions({ skins: 15, faces: 24, hairStyles: 17, hairColors: 13, facialHairs: 9 }), false,
    "the counts an older gateway answers are not the lists this bundle reads");
  assert.equal(isCharacterOptions({
    skins: [0, 1], faces: [0], hairStyles: [0], hairColors: [0], facialHairs: [0], facesBySkin: { 0: [0], 1: [0] },
  }), true);
  // A list of anything but numbers is not one either: the values go into the wire bytes.
  assert.equal(isCharacterOptions({
    skins: ["0"], faces: [0], hairStyles: [0], hairColors: [0], facialHairs: [0], facesBySkin: {},
  }), false);
  // And the shapes a fetch can hand back when nothing is right at all.
  for (const answer of [undefined, null, 3, "options", [], {}, { skins: [0] }]) {
    assert.equal(isCharacterOptions(answer), false, `${JSON.stringify(answer)} is not an options answer`);
  }
});
