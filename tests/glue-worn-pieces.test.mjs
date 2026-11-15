// 15.11 (6.18, 6.14): what the figures drawn outside the world carry — browser/glue/GlueWornPieces.ts
// (pieces on their points, the closed hands, glows only where the weapon has the attachment, a kit's
// effect on the figure's own attachment), FigureGlow.ts (the select screen's glow rule), CharSelectGhost.ts
// (kit 989), and the hosts' point rules: the window's copy (FrameXmlUnitModelLive.frameXmlUnitPieces) and
// the dressing room (FrameXmlDressUpStage.frameXmlDressUpPieces).
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { GlueWornPieces } from "../dist/code/browser/glue/GlueWornPieces.js";
import { figureGlowSlots, figureGlowVisual } from "../dist/code/browser/glue/FigureGlow.js";
import { GHOST_MODEL_ALPHA, ghostLookOf, paintGhost } from "../dist/code/browser/glue/CharSelectGhost.js";
import { characterLook } from "../dist/code/browser/glue/GlueCharacterScene.js";
import { frameXmlUnitPieces } from "../dist/code/browser/framexml/FrameXmlUnitModelLive.js";
import { frameXmlDressUpPieces } from "../dist/code/browser/framexml/FrameXmlDressUpStage.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

/** A model with nothing to draw: what `buildModel` takes for an empty file. */
function emptyModel(attachments = []) {
  return {
    positions: new Float32Array(0), normals: new Float32Array(0), uv0: new Float32Array(0), uv1: new Float32Array(0),
    indices: new Uint16Array(0), submeshes: [], batches: [], textures: [], attachments,
    bounds: { min: [0, 0, 0], max: [0, 0, 0], radius: 0 }, globalSequences: new Uint32Array(0),
    particleEmitters: [], ribbonEmitters: [], colours: [], textureWeights: [], textureTransforms: [],
  };
}

/** A two-bone figure: bone 0 the root, bone 1 a right-hand finger (key bone 8). */
function figure(attachments, { closedClip = true } = {}) {
  const bones = [new THREE.Bone(), new THREE.Bone()];
  bones[0].add(bones[1]);
  const keyBones = new Int16Array(18).fill(-1);
  keyBones[8] = 1;
  const clips = new Map();
  if (closedClip) {
    clips.set(15, new THREE.AnimationClip("HandsClosed", 1, [
      new THREE.QuaternionKeyframeTrack("bone1.quaternion", [0], [0, 0, Math.SQRT1_2, Math.SQRT1_2]),
    ]));
  }
  const template = { parents: Int16Array.from([-1, 0]), pivots: new Float32Array(6), globalChannels: [], clips };
  const instance = { skeleton: { bones } };
  const wvm = { ...emptyModel(attachments), keyBones };
  return { bones, template, instance, wvm };
}

function host(models) {
  return {
    baseUrl: "http://gateway.test",
    model: async (path) => {
      const model = models[path];
      if (!model) throw new Error(`no ${path}`);
      return model;
    },
    loadTexture: () => new THREE.Texture(),
    animations: async () => { throw new Error("no sidecar in this test"); },
  };
}

const item = (slot, model, inventoryType = 13) => ({ slot, inventoryType, side: "right", model, texture: "" });

test("a piece hangs on its point's bone at the point's offset; a point the figure lacks hangs nothing", async () => {
  const { bones, template, instance, wvm } = figure([{ id: 1, bone: 1, position: [0, 0, 0.5] }]);
  const pieces = new GlueWornPieces(wvm, "Figure.m2", instance, template, host({ "Sword.m2": emptyModel() }));
  await pieces.hang([{ item: item(15, "Sword.m2"), point: 1 }, { item: item(0, "Sword.m2", 1), point: 11 }]);
  assert.equal(pieces.meshes.length, 1, "the helm's point 11 is not on this figure");
  assert.ok(pieces.meshes[0].parent === bones[1]);
  assert.deepEqual(pieces.meshes[0].position.toArray(), [0, 0, 0.5]);
  assert.deepEqual(pieces.points, [1]);
  pieces.dispose();
  assert.equal(pieces.meshes.length, 0);
  assert.equal(bones[1].children.length, 0, "dispose takes them off");
});

test("an item on point 1 closes the right hand (0x004e7700 key bones 8–12); a stowed one does not", async () => {
  const held = figure([{ id: 1, bone: 0, position: [0, 0, 0] }, { id: 26, bone: 0, position: [0, 0, 0] }]);
  const inHand = new GlueWornPieces(held.wvm, "Figure.m2", held.instance, held.template, host({ "Sword.m2": emptyModel() }));
  await inHand.hang([{ item: item(15, "Sword.m2"), point: 1 }]);
  assert.equal(inHand.handsMask, 1);
  inHand.pose(0);
  assert.ok(Math.abs(held.bones[1].quaternion.z - Math.SQRT1_2) < 1e-6, "the finger takes HandsClosed's first key");

  const stowed = figure([{ id: 1, bone: 0, position: [0, 0, 0] }, { id: 26, bone: 0, position: [0, 0, 0] }]);
  const onBack = new GlueWornPieces(stowed.wvm, "Figure.m2", stowed.instance, stowed.template, host({ "Sword.m2": emptyModel() }));
  await onBack.hang([{ item: item(15, "Sword.m2"), point: 26 }]);
  assert.equal(onBack.handsMask, 0);
  onBack.pose(0);
  assert.equal(stowed.bones[1].quaternion.w, 1, "an open hand keeps its clip");
});

test("follow-up: a piece hangs while the sidecar is still on the wire; the hand closes when it lands", async () => {
  const rig = figure([{ id: 1, bone: 0, position: [0, 0, 0] }], { closedClip: false });
  let land;
  const sidecar = new Promise((resolve) => { land = resolve; });
  const pieces = new GlueWornPieces(rig.wvm, "Figure.m2", rig.instance, rig.template, {
    ...host({ "Sword.m2": emptyModel() }),
    handsClosedClip: () => sidecar,
  });
  // Raced against a short timer: a hang that waited for the sidecar would never settle here.
  await Promise.race([pieces.hang([{ item: item(15, "Sword.m2"), point: 1 }]), new Promise((resolve) => setTimeout(resolve, 200))]);
  assert.equal(pieces.meshes.length, 1, "the sword is in the hand before the sidecar has answered");
  pieces.pose(0);
  assert.equal(rig.bones[1].quaternion.w, 1, "the fingers wait for HandsClosed");
  land(new THREE.AnimationClip("HandsClosed", 1, [
    new THREE.QuaternionKeyframeTrack("bone1.quaternion", [0], [0, 0, Math.SQRT1_2, Math.SQRT1_2]),
  ]));
  await new Promise((resolve) => setImmediate(resolve));
  pieces.pose(0);
  assert.ok(Math.abs(rig.bones[1].quaternion.z - Math.SQRT1_2) < 1e-6, "and close once it lands");
  pieces.dispose();
});

test("follow-up: glows are handed over after the pieces hang, to those hung and those still to come", async () => {
  const { template, instance, wvm } = figure([{ id: 1, bone: 0, position: [0, 0, 0] }, { id: 2, bone: 0, position: [0, 0, 0] }]);
  const blade = () => emptyModel([0, 1, 2, 3, 4].map((id) => ({ id, bone: 0, position: [0, 0, id] })));
  const models = { "Main.m2": blade(), "Off.m2": blade(), "Glow.m2": emptyModel() };
  const pieces = new GlueWornPieces(wvm, "Figure.m2", instance, template, host(models));
  const main = item(15, "Main.m2");
  const off = { ...item(16, "Off.m2", 22), side: "left" };
  await pieces.hang([{ item: main, point: 1 }]);
  assert.equal(pieces.effectAnchors, 0, "no tables yet: the blade hangs plain");
  const five = ["Glow.m2", "Glow.m2", "Glow.m2", "Glow.m2", "Glow.m2"];
  pieces.glowWith((piece) => (piece.slot === 15 || piece.slot === 16 ? five : undefined));
  assert.equal(pieces.effectAnchors, 5, "the hung blade takes its five slots");
  await pieces.hang([{ item: off, point: 2 }]);
  assert.equal(pieces.effectAnchors, 10, "a blade hung afterwards takes them too");
  pieces.glowWith(() => five);
  assert.equal(pieces.effectAnchors, 10, "once per piece");
  pieces.dispose();
});

test("follow-up: ItemVisuals 24 in the dataset is BlueGlow_High in all five slots", withDataset, async () => {
  const { loadItemVisualSlots } = await import("../dist/code/gateway/ItemEnchantments.js");
  const tables = await loadItemVisualSlots(dbcDirectory);
  const row = tables.slots.get(24);
  assert.ok(row, "ItemVisuals 24");
  assert.equal(row.length, 5);
  for (const path of row) assert.match(path, /BlueGlow_High\.m2$/i);
  // The lab's documented example: display 20089 (item 1482) has no ItemVisual of its own, so glow=15:24 is
  // what hangs; display 1550 (the first example, Sword_1H_Long_A_02 with no attachments) could show none.
  assert.equal(tables.displayVisual.get(20089), undefined);
  assert.deepEqual(figureGlowSlots(15, 24, 20089, { itemVisualSlots: tables.slots, displayVisuals: tables.displayVisual }), row);
});

test("glow slot i goes on the weapon's attachment i only; a kit effect on the figure's own attachment", async () => {
  const { template, instance, wvm } = figure([{ id: 1, bone: 0, position: [0, 0, 0] }, { id: 19, bone: 0, position: [0, 0, 0] }]);
  const sword = emptyModel([{ id: 0, bone: 0, position: [0, 0, 0.1] }, { id: 4, bone: 0, position: [0, 0, 0.9] }]);
  const models = { "Sword.m2": sword, "Glow0.m2": emptyModel(), "Glow2.m2": emptyModel(), "Glow4.m2": emptyModel(), "Ghost.m2": emptyModel() };
  const pieces = new GlueWornPieces(wvm, "Figure.m2", instance, template, host(models));
  await pieces.hang(
    [{ item: item(15, "Sword.m2"), point: 1, glow: ["Glow0.m2", null, "Glow2.m2", null, "Glow4.m2"] }],
    [{ path: "Ghost.m2", point: 19, scale: 1 }, { path: "Ghost.m2", point: 20, scale: 1 }],
  );
  // Slots 0 and 4 have their attachments on the sword, slot 2 does not (0x00831630 returns without one);
  // the kit's Base (19) is on the figure, its Head (20) is not (0x004e2c30 asks 0x008273d0 first).
  assert.equal(pieces.effectAnchors, 3);
  const names = pieces.meshes[0].children.map((child) => child.name).sort();
  assert.deepEqual(names, ["glow:0", "glow:4"]);
  pieces.dispose();
});

const TABLES = {
  itemVisualSlots: new Map([[10, ["Own.m2", null, null, null, null]], [20, ["Enchant.m2", null, null, null, null]]]),
  displayVisuals: new Map([[500, 10], [600, 99]]),
};

test("select screen: a display with its own ItemVisuals row keeps it, else the enum's enchant visual", () => {
  assert.equal(figureGlowVisual(15, 20, 500, TABLES), 10, "0x004e3cd0 passes 0 when the display's visual has a row");
  assert.equal(figureGlowVisual(15, 20, 700, TABLES), 20, "a plain display: the enchant");
  assert.equal(figureGlowVisual(15, 20, 600, TABLES), 20, "a display visual with no row does not block the enchant");
  assert.equal(figureGlowVisual(15, 0, 500, TABLES), 10, "no enchant: the display's own (0x004eacd0 falls back to +0x5c)");
  assert.equal(figureGlowVisual(4, 20, 500, TABLES), 0, "only the hand slots are hung by 0x004eacd0");
  assert.deepEqual(figureGlowSlots(16, 20, undefined, TABLES), ["Enchant.m2", null, null, null, null]);
});

test("the select look carries the enum's enchant visuals and the ghost flag, and its key changes with them", () => {
  const equipment = Array.from({ length: 23 }, () => ({ displayId: 0, inventoryType: 0, enchantVisual: 0 }));
  equipment[15] = { displayId: 700, inventoryType: 13, enchantVisual: 20 };
  const base = { guid: 7n, name: "Тест", race: 1, classId: 1, gender: 0, skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0, equipment };
  const living = characterLook({ ...base, flags: 0 }, 49);
  const dead = characterLook({ ...base, flags: 0x2000 }, 49);
  assert.deepEqual(living.enchantVisuals, { 15: 20 });
  assert.equal(living.ghost, undefined);
  assert.equal(dead.ghost, true);
  assert.notEqual(living.key, dead.key);
  const plain = characterLook({ ...base, flags: 0, equipment: equipment.map((slot, index) => index === 15 ? { ...slot, enchantVisual: 0 } : slot) }, 49);
  assert.notEqual(plain.key, living.key, "an enchant redraws the figure");
});

test("the ghost look: kit effects at their attachments, CharProc 1's colour and the 0.5 alpha", () => {
  const look = ghostLookOf([{ id: 989, kit: { effects: [{ path: "Spells\\Ghost_state.m2", attachment: 19, scale: 1 }], tint: 9222653 } }]);
  assert.deepEqual(look.effects, [{ path: "Spells\\Ghost_state.m2", point: 19, scale: 1 }]);
  assert.equal(look.tint, 0x8cb9fd);
  assert.equal(look.alpha, GHOST_MODEL_ALPHA);
  assert.equal(ghostLookOf([{ id: 989 }]), undefined, "a dataset without the kit draws no ghost look");
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
  paintGhost(material, look);
  assert.deepEqual(material.color.toArray().map((value) => Math.round(value * 1000) / 1000),
    new THREE.Color(0x8cb9fd).toArray().map((value) => Math.round(value * 1000) / 1000));
  assert.equal(material.opacity, 0.5);
  assert.equal(material.transparent, true);
});

test("kit 989 in the dataset is the ghost's Ghost_state on Base with 140/185/253", withDataset, async () => {
  const { loadSpellVisualKits } = await import("../dist/code/gateway/SpellVisual.js");
  const kits = await loadSpellVisualKits(dbcDirectory);
  const kit = kits.get(989);
  assert.ok(kit, "SpellVisualKit 989");
  const look = ghostLookOf([{ id: 989, kit }]);
  assert.equal(look.tint, 0x8cb9fd);
  assert.ok(look.effects.some((effect) => /ghost_state\.m2$/i.test(effect.path) && effect.point === 19));
});

test("?fake=charselect-gear: an armed ghost and an axe that glows by itself, for looking without a server", async () => {
  const { fakeGlueSession } = await import("../dist/code/browser/glue/GlueFakeSession.js");
  const canned = fakeGlueSession("charselect-gear");
  assert.equal(canned.screen, "charselect");
  const characters = await (await canned.connect()).characters();
  const [ghost, axe] = characters.map((character) => characterLook(character, 49));
  assert.equal(ghost.ghost, true);
  assert.deepEqual(ghost.enchantVisuals, { 15: 24 });
  assert.match(ghost.items, /15:13:20089/);
  assert.equal(axe.ghost, undefined);
  assert.match(axe.items, /15:17:33458/);
});

test("the lab's glow= names an ItemVisuals id per hand slot", async () => {
  const { parseLabQuery } = await import("../dist/code/browser/lab/LabQuery.js");
  assert.deepEqual(parseLabQuery("?glow=15:24,16:33").glow, { 15: 24, 16: 33 });
  assert.deepEqual(parseLabQuery("").glow, {});
  assert.throws(() => parseLabQuery("?glow=4:24"), /слот 15–17/);
});

function unit(sheath, fields = new Map()) {
  fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, sheath);
  return { guid: 1n, typeId: 3, fields };
}

test("the window's copy hangs each piece where the world does at the moment of the copy", () => {
  const sword = { slot: 15, inventoryType: 13, side: "right", model: "Sword.m2", texture: "", sheathe: 3 };
  const helm = { slot: 0, inventoryType: 1, side: "right", model: "Helm.m2", texture: "" };
  const model = { model: "Body.m2", scale: 1, appearance: { body: [], attached: [helm, sword] } };
  const drawn = frameXmlUnitPieces(unit(1), model, undefined);
  assert.deepEqual(drawn.map((piece) => piece.point), [11, 1], "drawn: helm 11, the sword in the right hand");
  const stowed = frameXmlUnitPieces(unit(0), model, undefined);
  assert.deepEqual(stowed.map((piece) => piece.point), [11, 32], "stowed: SheatheType 3 on the right hip (0x004eacd0's table)");
  const glow = { glowModels: () => [], glowSlots: () => undefined, displayGlowSlots: (display) => (display === 42 ? ["A.m2", null, null, null, null] : undefined) };
  const creature = frameXmlUnitPieces(unit(1), { ...model, appearance: { body: [], attached: [{ ...sword, displayId: 42 }] } }, glow);
  assert.deepEqual(creature[0].glow, ["A.m2", null, null, null, null], "the world's attachedGlow: a creature's display glow");
});

test("the dressing room: a try-on is held, the unit's own weapon hangs by its sheath state", () => {
  const sword = { slot: 15, inventoryType: 13, side: "right", model: "Sword.m2", texture: "" };
  const bow = { slot: 17, inventoryType: 15, side: "right", model: "Bow.m2", texture: "" };
  const gun = { slot: 17, inventoryType: 26, side: "right", model: "Gun.m2", texture: "" };
  const look = { displayId: 49, race: 1, sex: 0, skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0, equipment: [], sheath: 0, wornSheathe: { 15: 3 } };
  const own = frameXmlDressUpPieces({ unit: "player", look, equipment: [], pending: false }, [sword]);
  assert.deepEqual(own.map((piece) => piece.point), [32], "stowed on the hip as the unit carries it");
  const tried = frameXmlDressUpPieces({ unit: "player", look, equipment: [], pending: false, tried: new Set([15, 17]) }, [sword, bow]);
  assert.deepEqual(tried.map((piece) => piece.point), [1, 2], "0x005980d0: held — a bow in the off hand");
  const triedGun = frameXmlDressUpPieces({ unit: "player", look, equipment: [], pending: false, tried: new Set([17]) }, [gun]);
  assert.deepEqual(triedGun.map((piece) => piece.point), [1], "a gun goes to the main hand slot (0x005980d0: 0x1a → 0xf)");
});
