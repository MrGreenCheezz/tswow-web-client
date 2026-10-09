// 05.10-A7a-E2 (6.14): the effect models' meshes on the glow anchors (browser/WeaponGlowBody.ts), the
// display's own glow through the attached piece's displayId (gateway CharacterAppearance/NpcWeapons,
// browser NpcWeapons/ItemEnchantments), and the renderer's hook lines.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { loadItemVisualSlots } from "../dist/code/gateway/ItemEnchantments.js";
import { attachedGlow } from "../dist/code/browser/ItemEnchantments.js";
import { attachGlowAnchors, detachGlowAnchors, glowAnchorsOf, glowEmitterEntries, glowPlacement } from "../dist/code/browser/WeaponGlow.js";
import {
  glowHasMesh, makeGlowBody, mountGlowBodies, pinGlowBuilds, poseGlowBodies,
  fadeGlowEmitters, glowBodyMeshes, glowShown, // 05.10: ревью E2 — the unit's opacity and visibility
} from "../dist/code/browser/WeaponGlowBody.js";
import { NpcWeaponClient, heldWeapons } from "../dist/code/browser/NpcWeapons.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

const FIVE = Object.freeze([null, null, null, null, "Spells\\Enchantments\\Sparkle_A.m2"]);
const MESH = { indices: new Uint16Array([0, 1, 2]), batches: [{}], particleEmitters: [], ribbonEmitters: [], globalSequences: new Uint32Array(0) };
const EMITTERS_ONLY = { indices: new Uint16Array(0), batches: [], particleEmitters: [{}], ribbonEmitters: [], globalSequences: new Uint32Array(0) };

function weaponWithAnchors() {
  const mesh = new THREE.Object3D();
  const itemModel = { attachments: [0, 1, 2, 3, 4].map((id) => ({ id, bone: 0, position: [0, 0, id * 0.25] })) };
  const slots = ["Spells\\A.m2", null, null, null, "Spells\\Enchantments\\Sparkle_A.m2"];
  attachGlowAnchors(mesh, itemModel, glowPlacement([0, 1, 2, 3, 4], slots), "unit:9:glow:15/left");
  return mesh;
}

/** A body the way the renderer makes one: a static mesh, or a fake rig that records its mixer. */
function staticBody(built) {
  return makeGlowBody({ geometry: new THREE.BufferGeometry(), materials: [new THREE.MeshBasicMaterial()], ...built }, undefined);
}

test("only a model with geometry gets a body; emitter-only glows stay emitters", () => {
  assert.equal(glowHasMesh(MESH), true);
  assert.equal(glowHasMesh(EMITTERS_ONLY), false);
  assert.equal(glowHasMesh({ ...MESH, batches: [] }), false, "indices without a batch draw nothing");
});

test("bodies mount under their anchors once, at the anchor's own frame, and retry while the builder waits", () => {
  const mesh = weaponWithAnchors();
  const anchors = glowAnchorsOf(mesh);
  anchors[0].wvm = EMITTERS_ONLY;
  anchors[1].wvm = MESH;
  const asked = [];
  let budget = false;
  const build = (path, wvm) => {
    asked.push(path);
    if (!glowHasMesh(wvm)) return null;
    if (!budget) return undefined;
    return staticBody({ marker: path });
  };
  assert.equal(mountGlowBodies(anchors, build), 0, "the budget said no: nothing mounted");
  assert.ok(anchors[0].body === null, "an emitter-only model is settled as bodiless");
  assert.ok(anchors[1].body === undefined, "a refused build is asked again next frame");
  budget = true;
  assert.equal(mountGlowBodies(anchors, build), 1);
  assert.deepEqual(asked, ["Spells\\A.m2", "Spells\\Enchantments\\Sparkle_A.m2", "Spells\\Enchantments\\Sparkle_A.m2"]);
  const body = anchors[1].body;
  assert.ok(body.object.parent === anchors[1].anchor, "hung on the slot-4 anchor");
  assert.equal(body.object.position.length(), 0);
  assert.equal(body.object.quaternion.w, 1, "the weapon's model space: no extra M2→scene turn");
  assert.equal(mountGlowBodies(anchors, build), 0, "mounted once");
  assert.equal(asked.length, 3);
});

test("a rigged body is an instance of the template with its root reset into the weapon's model space", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const clip = new THREE.AnimationClip("stand", 1, [new THREE.VectorKeyframeTrack("bone0.scale", [0, 1], [1, 1, 1, 2, 2, 2])]);
  const template = {
    geometry, clips: new Map([[0, clip]]), animations: new Set([0]), boneInverses: [new THREE.Matrix4()],
    parents: new Int16Array([-1]), pivots: new Float32Array(3), flags: new Uint16Array(1), billboards: [], globalChannels: [], height: 1,
  };
  const body = makeGlowBody({ geometry, materials: [new THREE.MeshBasicMaterial()] }, template);
  assert.ok(body.skinned, "a skinned instance");
  assert.ok(body.object === body.skinned.root, "the instance root is the body");
  assert.equal(body.object.quaternion.w, 1, "instantiateSkinned's M2→scene turn is undone");
  const mesh = weaponWithAnchors();
  const anchors = glowAnchorsOf(mesh);
  anchors[1].wvm = MESH;
  mountGlowBodies(anchors, () => body);
  poseGlowBodies(anchors, 0.5, 1000, new THREE.PerspectiveCamera());
  assert.ok(body.action, "Stand plays, looping");
  assert.equal(body.action.loop, THREE.LoopRepeat);
  const bone = body.skinned.skeleton.bones[0];
  assert.ok(Math.abs(bone.scale.x - 1.5) < 1e-6, `the clip moves the bone (scale ${bone.scale.x})`);
  // The emitters ride the same rig.
  const entries = [];
  anchors[1].wvm = { ...MESH, particleEmitters: [{}] };
  glowEmitterEntries(mesh, 1, (key, wvm, distance, visual, rig) => ({ key, visual, rig }), entries);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].rig === body, "the emitter entry is posed by the body's rig");
  detachGlowAnchors(mesh);
  assert.ok(body.object.parent === null, "off the anchor");
});

test("detaching disposes the rig; pins hold every worn body's build", () => {
  const mesh = weaponWithAnchors();
  const anchors = glowAnchorsOf(mesh);
  anchors[0].wvm = MESH;
  anchors[1].wvm = MESH;
  const builtA = { name: "a" };
  let disposed = 0;
  mountGlowBodies(anchors, (path) => {
    const body = staticBody({});
    body.built = path === "Spells\\A.m2" ? builtA : { name: "b" };
    if (path === "Spells\\A.m2") body.skinned = { root: body.object, mixer: { stopAllAction() {}, uncacheRoot() {} }, skeleton: { dispose() { disposed++; } } };
    return body;
  });
  const pins = new Set();
  pinGlowBuilds(anchors, pins);
  assert.equal(pins.size, 2);
  assert.ok(pins.has(builtA));
  detachGlowAnchors(mesh);
  assert.equal(disposed, 1, "the skinned instance lets go of its skeleton");
  assert.equal(mesh.children.length, 0);
});

test("the display's own glow reaches a player's and a creature's weapon; an enchant still wins", () => {
  const first = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
  const stride = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - first;
  const enchanted = { typeId: 4, fields: new Map([[first + 15 * stride + 1, 803]]) };
  const bare = { typeId: 4, fields: new Map() };
  const creature = { typeId: 3, fields: new Map() };
  const ENCHANT = Object.freeze(["Spells\\Enchantments\\RedGlow_High.m2", null, null, null, null]);
  // The client hands out its stored arrays, so the glow is re-made only when those change.
  const RED = ["Spells\\Enchantments\\RedGlow_High.mdx"];
  const NONE = [];
  const source = {
    glowModels: (id) => (id === 803 ? RED : NONE),
    glowSlots: (id) => (id === 803 ? ENCHANT : undefined),
    displayGlowSlots: (id) => (id === 500 ? FIVE : undefined),
  };
  assert.equal(attachedGlow(bare, 15, source, 500)?.slots, FIVE, "no enchant: the display's glow");
  assert.equal(attachedGlow(enchanted, 15, source, 500)?.slots, ENCHANT, "the enchant wins");
  assert.equal(attachedGlow(creature, 16, source, 500)?.slots, FIVE, "a creature's held weapon");
  assert.equal(attachedGlow(creature, 16, source, 0), undefined);
  assert.equal(attachedGlow(creature, 16, source), undefined, "an old gateway sends no displayId: no glow, as before");
  assert.equal(attachedGlow(creature, 1, source, 500), undefined, "a helmet never glows");
  assert.equal(attachedGlow(bare, 15, source, 500), attachedGlow(bare, 15, source, 500), "one object per glow, not per frame");
  assert.equal(attachedGlow(enchanted, 15, source, 500), attachedGlow(enchanted, 15, source), "and per enchant");
  assert.equal(attachedGlow(bare, 15, source, 500).intensity, 0, "a display glow gets no invented tint");
  assert.equal(attachedGlow(enchanted, 15, source, 500).intensity, 0.9, "an enchant keeps its tint stand-in");
  // A reload hands out new arrays: the remembered glow follows them.
  const reloaded = Object.freeze(["Spells\\Enchantments\\Rune_Intellect.m2", null, null, null, null]);
  source.displayGlowSlots = (id) => (id === 500 ? reloaded : undefined);
  assert.equal(attachedGlow(bare, 15, source, 500).slots, reloaded);
  source.displayGlowSlots = () => undefined;
  assert.equal(attachedGlow(bare, 15, source, 500), undefined);
});

test("/dbc/npc-weapons may carry the display id, and the held piece keeps it; an older answer has none", async () => {
  const original = globalThis.fetch;
  let answer = [
    { entry: 1001, inventoryType: 17, subClass: 8, model: "Item\\ObjectComponents\\Weapon\\Sword_2H_Ashbringer.m2", texture: "", displayId: 31262 },
    { entry: 1002, inventoryType: 13, model: "Item\\ObjectComponents\\Weapon\\Axe_1H_A.m2", texture: "" },
  ];
  globalThis.fetch = async () => ({ ok: true, status: 200, async json() { return answer; } });
  try {
    const client = new NpcWeaponClient("http://127.0.0.1:8090", () => 0);
    heldWeapons([1001, 1002, 0], client);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const { held } = heldWeapons([1001, 1002, 0], client);
    assert.deepEqual(held.map((item) => item.displayId), [31262, undefined]);
    assert.equal("displayId" in held[1], false, "absent, not undefined-valued");
    answer = [{ entry: 1003, inventoryType: 13, model: "m.m2", texture: "", displayId: "x" }];
    const strict = new NpcWeaponClient("http://127.0.0.1:8090", () => 0);
    heldWeapons([1003, 0, 0], strict);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(strict.weapon(1003), undefined, "a malformed displayId rejects the batch");
  } finally {
    globalThis.fetch = original;
  }
});

test("dataset: the gateway's attached weapon and NPC weapon carry the ItemDisplayInfo id", withDataset, async () => {
  const { CharacterAppearanceIndex } = await import("../dist/code/gateway/CharacterAppearance.js");
  const { openDbcFile } = await import("../dist/code/gateway/Dbc.js");
  const { npcWeaponsFor } = await import("../dist/code/gateway/NpcWeapons.js");
  const index = await CharacterAppearanceIndex.load(dbcDirectory, undefined, dbcDirectory, false);
  const tables = await loadItemVisualSlots(dbcDirectory);
  const glowing = [...tables.displayVisual.keys()].find((displayId) =>
    index.weaponModels([{ slot: 15, inventoryType: 17, displayId }]).length > 0);
  assert.ok(glowing, "a drawn weapon display that names an ItemVisual");
  const [held] = index.weaponModels([{ slot: 15, inventoryType: 17, displayId: glowing }]);
  assert.equal(held.displayId, glowing);
  const worn = index.forPlayer(1, 0, 0, 0, 0, 0, 0, [{ slot: 15, inventoryType: 17, displayId: glowing }]);
  assert.equal(worn.attached.find((item) => item.slot === 15)?.displayId, glowing, "a player's appearance too");
  const items = await openDbcFile(dbcDirectory, "Item");
  let entry;
  for (const row of items.rows()) {
    if (items.int(row, "DisplayInfoID") !== glowing) continue;
    entry = items.id(row);
    break;
  }
  if (entry !== undefined) assert.equal(npcWeaponsFor(items, index, [entry])[0]?.displayId, glowing);
});

test("the renderer's hooks: bodies mount, pose, pin, and the display id reaches the glow resolver", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /this\.#enchantGlow\?\.\(object, item\.slot, item\.displayId\)/);
  assert.match(source, /mountGlowBodies\(glowAnchorsOf\(node\), /);
  assert.match(source, /poseGlowBodies\(glowAnchorsOf\(node\), elapsed, now, this\.#camera\)/);
  assert.match(source, /pinGlowBuilds\(glowAnchorsOf\(node\), unitPins\)/);
  const loop = readFileSync(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  assert.match(loop, /attachedGlow\(object, slot, enchantClient, displayId\)/);
});

// 05.10: ревью E2 — a glow follows the unit the way the blade it sits on does: faded with it (stealth,
// invisibility, ghost, spawn fade) and gone with it (a unit turned away, a first-person rider).
test("review E2: the bodies are among the meshes a unit's fade reaches", () => {
  const mesh = weaponWithAnchors();
  const anchors = glowAnchorsOf(mesh);
  anchors[0].wvm = MESH;
  anchors[1].wvm = EMITTERS_ONLY;
  const plain = staticBody({});
  mountGlowBodies(anchors, (path, wvm) => (glowHasMesh(wvm) ? plain : null));
  const found = [...glowBodyMeshes(anchors)];
  assert.equal(found.length, 1, "one body, the bodiless anchor gives none");
  assert.ok(found[0] === plain.object, "the static body's own mesh");
  assert.equal([...glowBodyMeshes(undefined)].length, 0);
  // A rigged body: its skinned mesh, not the bone root.
  const skinnedMesh = new THREE.Mesh();
  const rigged = staticBody({});
  rigged.skinned = { root: rigged.object, mesh: skinnedMesh };
  const other = weaponWithAnchors();
  const otherAnchors = glowAnchorsOf(other);
  otherAnchors[1].wvm = MESH;
  mountGlowBodies(otherAnchors, (path, wvm) => (wvm === MESH ? rigged : undefined));
  const riggedFound = [...glowBodyMeshes(otherAnchors)];
  assert.equal(riggedFound.length, 1);
  assert.ok(riggedFound[0] === skinnedMesh, "the rig's skinned mesh carries the materials");
});

test("review E2: a glow is shown only while every node up to the scene is", () => {
  const scene = new THREE.Object3D();
  const unitNode = new THREE.Object3D();
  const rider = new THREE.Object3D();
  const weapon = new THREE.Object3D();
  scene.add(unitNode);
  unitNode.add(rider);
  rider.add(weapon);
  assert.equal(glowShown(weapon), true);
  unitNode.visible = false;
  assert.equal(glowShown(weapon), false, "a unit turned away or held for its programs");
  unitNode.visible = true;
  rider.visible = false;
  assert.equal(glowShown(weapon), false, "the first-person rider");
  rider.visible = true;
  weapon.visible = false;
  assert.equal(glowShown(weapon), false, "the blade itself held back");
});

test("review E2: emitters fade with the unit by what each blend does with alpha, and come back whole", () => {
  const normal = new THREE.MeshBasicMaterial({ transparent: true });
  const alphaAdd = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.CustomBlending });
  alphaAdd.blendSrc = THREE.SrcAlphaFactor;
  alphaAdd.blendDst = THREE.OneFactor;
  const oneOne = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.CustomBlending });
  oneOne.blendSrc = THREE.OneFactor;
  oneOne.blendDst = THREE.OneFactor;
  const mod = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.CustomBlending });
  mod.blendSrc = THREE.DstColorFactor;
  mod.blendDst = THREE.ZeroFactor;
  const effects = { emitters: [normal, alphaAdd, oneOne, mod].map((material) => ({ material })) };
  fadeGlowEmitters(effects, 0.35);
  assert.equal(normal.opacity, 0.35);
  assert.equal(normal.color.r, 1, "alpha blends fade by opacity alone");
  assert.equal(alphaAdd.opacity, 0.35);
  assert.equal(oneOne.color.g, 0.35, "One/One ignores alpha: the colour carries the fade");
  assert.equal(oneOne.opacity, 0.35);
  assert.equal(mod.opacity, 1, "a modulate blend has no fade to give");
  assert.equal(mod.color.b, 1);
  fadeGlowEmitters(effects, 0.35);
  assert.equal(oneOne.color.g, 0.35, "not compounded frame after frame");
  fadeGlowEmitters(effects, 1);
  assert.equal(normal.opacity, 1);
  assert.equal(oneOne.color.r, 1);
  assert.equal(oneOne.opacity, 1);
  assert.equal(normal.needsUpdate === true, false, "uniforms only: no program change");
});

test("review E2: the emitter entries carry the unit's opacity", () => {
  const mesh = weaponWithAnchors();
  glowAnchorsOf(mesh)[1].wvm = { ...EMITTERS_ONLY };
  const entries = [];
  glowEmitterEntries(mesh, 4, (key, wvm, distance, visual, rig, fade) => ({ key, fade }), entries, 0.35);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].fade, 0.35);
});

test("review E2: the renderer's hooks fade and hide the glows with their unit", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const meshes = source.slice(source.indexOf("* #unitOpacityMeshes("), source.indexOf("#applyUnitShadow(unit: RenderedUnit"));
  assert.match(meshes, /yield\* glowBodyMeshes\(glowAnchorsOf\(node\)\)/, "the fade reaches the bodies");
  const effects = source.slice(source.indexOf("#updateEffects(player: WorldPosition"), source.indexOf("// Spell visuals are ranked and budgeted apart"));
  assert.match(effects, /if \(!glowAnchorsOf\(node\) \|\| !glowShown\(node\)\) continue;/, "a hidden blade's glow is not emitted");
  assert.match(effects, /glowEmitterEntries\(node, distance, glowEntry, wanted, unit\.unitOpacity\)/);
  assert.match(source, /if \(entry\.fade !== undefined\) fadeGlowEmitters\(held\.effects, entry\.fade\);/);
});

// 05.10-A7a-G2 (ревью E2, pre-existing): a unit's own model emitters went with neither its visibility nor its
// opacity — a stealthed rogue, an invisible mage or a first-person rider still drew the model's particles.
test("05.10-A7a-G2: a unit's own emitters hide and fade with the unit, as its glows do", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const effects = source.slice(source.indexOf("#updateEffects(player: WorldPosition"), source.indexOf("// Spell visuals are ranked and budgeted apart"));
  const units = effects.slice(effects.indexOf("this.#units.forEach((unit, guid) => {"), effects.indexOf("enchantment glow effects on worn weapons"));
  assert.match(units, /if \(!glowShown\(unit\.skinned\?\.root \?\? unit\.visual!\)\) return;/, "a hidden unit emits nothing");
  assert.match(units, /fade: unit\.unitOpacity/, "its emitters fade with it");
});
