// 6.18 (line A7a, slice G, 05.10): the window, glue, lab and bench figures choose their geosets the
// way the world does (`worldCharacterGeosets`), and the character-select figure wears what Wow.exe
// 0x004e3cd0 puts on it from SMSG_CHAR_ENUM.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { figureGeosets } from "../dist/code/browser/FigureGeosets.js";
import { EVERY_GEOSET, geosetList, worldCharacterGeosets } from "../dist/code/browser/ModelBuild.js";
import { characterLook, wornQuery } from "../dist/code/browser/glue/GlueCharacterScene.js";
import { frameXmlDressUpKey, frameXmlDressUpSource } from "../dist/code/browser/framexml/FrameXmlDressUpStage.js";

/**
 * A patch-W body in miniature: the asked-for boot 501 reaches the ankle only (lower-leg UVs, no foot
 * row), the file's other boot 502 carries a foot — the case `worldCharacterGeosets` swaps.
 */
function patchWModel() {
  // Triangles: 0 body, 1 boot 501 (lower leg), 2 boot 502 (lower leg), 3 boot 502 (foot row).
  const uv = [
    [0.1, 0.1], [0.2, 0.1], [0.1, 0.2],
    [0.6, 0.7], [0.7, 0.7], [0.6, 0.8],
    [0.6, 0.7], [0.7, 0.7], [0.6, 0.8],
    [0.6, 0.9], [0.7, 0.9], [0.6, 0.95],
  ];
  return {
    uv0: new Float32Array(uv.flat()),
    indices: new Uint16Array(Array.from({ length: 12 }, (_, index) => index)),
    submeshes: [
      { geosetId: 0, indexStart: 0, indexCount: 3 },
      { geosetId: 501, indexStart: 3, indexCount: 3 },
      { geosetId: 502, indexStart: 6, indexCount: 6 },
    ],
  };
}

const PATCH_W_LOOK = {
  coordinatedVisuals: true,
  body: [{ path: "skin.blp" }, { path: "foot.blp", section: "foot" }],
  hair: "", cloak: "", geosets: [0, 501, 702], attached: [],
};

const ids = (choice) => [...(choice.explicit ?? [])].sort((a, b) => a - b);

test("a figure with an appearance takes the world's boot choice, not the gateway list as sent", () => {
  const model = patchWModel();
  const world = worldCharacterGeosets(model, PATCH_W_LOOK, true);
  assert.deepEqual(ids(world), [0, 502, 702], "fixture: the world swaps the ankle-only boot");
  assert.deepEqual(ids(figureGeosets(model, PATCH_W_LOOK)), ids(world));
  assert.notDeepEqual(ids(figureGeosets(model, PATCH_W_LOOK)), ids(geosetList(PATCH_W_LOOK.geosets)));
});

test("a figure without an appearance draws every geoset; a lab override is taken as written", () => {
  const model = patchWModel();
  assert.equal(figureGeosets(model, undefined), EVERY_GEOSET);
  assert.deepEqual(ids(figureGeosets(model, PATCH_W_LOOK, [0, 501])), [0, 501]);
});

test("glue, the model stage, the lab and the bench build through figureGeosets", async () => {
  const sites = [
    "src/browser/glue/GlueCharacterScene.ts",
    "src/browser/glue/GlueModelStage.ts",
    "src/browser/lab/CharacterLab.ts",
    "src/browser/bench/Harness.ts",
  ];
  for (const site of sites) {
    const source = await readFile(new URL(`../${site}`, import.meta.url), "utf8");
    assert.match(source, /figureGeosets\(/, `${site} chooses its geosets with figureGeosets`);
    assert.doesNotMatch(source, /geosets:\s*(?:appearance \? )?geosetList\(/,
      `${site} no longer hands the gateway list straight to buildModel`);
  }
});

function summary(flags, classId, equipment) {
  const slots = Array.from({ length: 23 }, () => ({ displayId: 0, inventoryType: 0 }));
  for (const [slot, displayId, inventoryType] of equipment) slots[slot] = { displayId, inventoryType };
  return {
    guid: 7n, name: "Тест", race: 1, classId, gender: 0, skin: 0, face: 0, hairStyle: 0, hairColor: 0,
    facialHair: 0, flags, equipment: slots,
  };
}

const HEAD = [0, 1001, 1];
const BACK = [14, 1014, 16];
const MAIN = [15, 1015, 17];
const OFF = [16, 1016, 14];
const RANGED = [17, 1017, 15];
const CHEST = [4, 1004, 5];

test("character select hides a helm and a cloak the character hides (CHARACTER_FLAG_HIDE_HELM/CLOAK)", () => {
  const all = [HEAD, CHEST, BACK, MAIN];
  assert.deepEqual(wornQuery(summary(0, 1, all)), "0:1:1001,14:16:1014,15:17:1015,4:5:1004");
  assert.deepEqual(wornQuery(summary(0x400, 1, all)), "14:16:1014,15:17:1015,4:5:1004");
  assert.deepEqual(wornQuery(summary(0x800, 1, all)), "0:1:1001,15:17:1015,4:5:1004");
  assert.deepEqual(wornQuery(summary(0xc00, 1, all)), "15:17:1015,4:5:1004");
  // The look's identity follows, so toggling the option rebuilds the figure.
  assert.notEqual(characterLook(summary(0, 1, all), 49).key, characterLook(summary(0x400, 1, all), 49).key);
});

test("character select shows a hunter's ranged weapon only, everybody else's melee weapons only", () => {
  const weapons = [MAIN, OFF, RANGED];
  assert.deepEqual(wornQuery(summary(0, 3, weapons)), "17:15:1017");
  assert.deepEqual(wornQuery(summary(0, 1, weapons)), "15:17:1015,16:14:1016");
  assert.deepEqual(wornQuery(summary(0, 6, weapons)), "15:17:1015,16:14:1016");
});

test("the dressing room asks for the wearer's class (the death knight's eyes)", () => {
  const asked = [];
  const models = {
    get: () => ({ model: "Character\\Human\\Male\\HumanMale.m2", textures: "", scale: 1 }),
    request: () => undefined,
    playerAppearance: (...args) => { asked.push(args); return PATCH_W_LOOK; },
  };
  const look = {
    displayId: 49, race: 1, sex: 0, skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0,
    equipment: [], classId: 6,
  };
  const outfit = { unit: "player", look, equipment: [], pending: false };
  assert.ok(frameXmlDressUpSource(outfit, models));
  assert.equal(asked[0]?.[8], 6, "the class goes to playerAppearance after the equipment");
  const plain = { ...outfit, look: { ...look, classId: undefined } };
  assert.notEqual(frameXmlDressUpKey(outfit), frameXmlDressUpKey(plain), "and into the outfit's identity");
});

test("the select-screen figure holds the hunter's bow in the left hand (0x004eacd0, attachment 2)", async () => {
  const { charSelectSheath } = await import("../dist/code/browser/glue/CharSelectWorn.js");
  const { attachmentPoint } = await import("../dist/code/browser/Attachment.js");
  const bow = { slot: 17, inventoryType: 15, path: "bow.m2" };
  assert.equal(attachmentPoint(bow, charSelectSheath(17)), 2, "left hand");
  assert.equal(attachmentPoint({ slot: 15, inventoryType: 17, path: "axe.m2" }, charSelectSheath(15)), 1, "right hand");
  assert.equal(attachmentPoint({ slot: 16, inventoryType: 14, path: "shield.m2" }, charSelectSheath(16)), 0, "a shield on 0");
});
