import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BOW_PULL, WEAPON_STAND } from "../dist/code/browser/BowDraw.js";
import {
  bowDrawMeshes, dropBowDrawVisuals, newBowDrawUnit, pinBowDrawBuilds, shownClip, syncBowDrawVisuals,
} from "../dist/code/browser/BowDrawVisuals.js";

// 5.05 (15.11, bow9): what the draw shows — the ammo on HandArrow 35 while it is hung (0x00831630 / 0x008274f0), the
// ranged weapon's own rig playing the asked sequence in place of its rigid piece, and nothing left behind when it goes.

const HAND_ARROW = 35;

function body() {
  const bones = [new THREE.Bone(), new THREE.Bone()];
  const wvm = { attachments: [{ id: HAND_ARROW, bone: 1, position: [1, 2, 3] }] };
  const template = { pivots: new Float32Array([0, 0, 0, 0.5, 0.5, 0.5]) };
  const piece = new THREE.Mesh();
  return { skinned: { skeleton: { bones } }, template, wvm, piece, item: { model: "Item\\Bow.m2", texture: "Item\\Bow.blp" }, bones };
}

function host(log) {
  const pull = new THREE.AnimationClip("pull", 1, []);
  return {
    rigid: (model, texture) => { log.push(`rigid ${model} ${texture}`); return { mesh: new THREE.Mesh(), built: { model } }; },
    rigged: (model) => {
      log.push(`rigged ${model}`);
      const root = new THREE.Group();
      const skinned = { root, mesh: new THREE.Mesh(), mixer: new THREE.AnimationMixer(root), skeleton: { dispose() {} } };
      const template = { clips: new Map([[BOW_PULL, pull]]), animations: new Set([0, BOW_PULL]) };
      return { skinned, template, built: { rig: model } };
    },
    clips: () => log.push("clips"),
    ammoModel: (ammo) => (ammo.displayId === 5996 ? { displayId: 5996, inventoryType: 24, model: "Item\\Arrow.m2", texture: "Item\\Arrow.blp" } : null),
    register: () => {},
    unregister: (object) => log.push(`unregister ${object.type}`),
  };
}

test("the arrow hangs on HandArrow's bone at the attachment's offset while hung, and comes off", () => {
  const log = [];
  const unit = newBowDrawUnit();
  const shape = body();
  const fake = host(log);
  syncBowDrawVisuals(unit, shape, fake, 0, 0.016);
  assert.equal(unit.arrow, undefined, "not hung");
  unit.draw.setAmmo(5996, 15, 2);
  unit.draw.arrow = true;
  unit.draw.hung = true;
  syncBowDrawVisuals(unit, shape, fake, 10, 0.016);
  assert.equal(unit.arrow.parent, shape.bones[1]);
  assert.deepEqual(unit.arrow.position.toArray(), [0.5, 1.5, 2.5]);
  assert.deepEqual(log, ["rigid Item\\Arrow.m2 Item\\Arrow.blp"]);
  syncBowDrawVisuals(unit, shape, fake, 20, 0.016);
  assert.equal(log.length, 1, "built once");
  unit.draw.stop(30);
  syncBowDrawVisuals(unit, shape, fake, 30, 0.016);
  assert.equal(unit.arrow, undefined);
  assert.equal(shape.bones[1].children.length, 0);
});

test("the weapon's rig: built when a sequence is asked, the rigid piece hidden from cameras, back when it goes", () => {
  const log = [];
  const unit = newBowDrawUnit();
  const shape = body();
  const fake = host(log);
  const mask = shape.piece.layers.mask;
  syncBowDrawVisuals(unit, shape, fake, 0, 0.016);
  assert.equal(unit.rig, undefined, "nothing asked: the rigid piece as before");
  unit.draw.weapon = { animation: BOW_PULL, speed: 2, at: 0 };
  syncBowDrawVisuals(unit, shape, fake, 250, 0.016);
  assert.ok(unit.rig);
  assert.equal(unit.rig.skinned.root.parent, shape.piece);
  assert.equal(shape.piece.layers.mask, 0, "the piece leaves every camera");
  assert.equal(unit.rig.action.getClip().name, "pull");
  assert.equal(unit.rig.action.loop, THREE.LoopOnce);
  assert.ok(unit.rig.action.clampWhenFinished, "held at the drawn string");
  assert.ok(Math.abs(unit.rig.action.time - (0.5 + 0.016 * 2)) < 1e-6, "where it would be by now, at its speed");
  assert.deepEqual([...bowDrawMeshes(unit)].length, 1);
  const pins = new Set();
  pinBowDrawBuilds(unit, pins);
  assert.equal(pins.size, 1);
  unit.draw.stop(400);
  assert.equal(unit.draw.weapon.animation, WEAPON_STAND);
  syncBowDrawVisuals(unit, shape, fake, 400, 0.016);
  assert.equal(unit.rig.action, undefined, "Stand with no keys: the rest pose");
  dropBowDrawVisuals(unit, fake);
  assert.equal(unit.rig, undefined);
  assert.equal(shape.piece.layers.mask, mask, "the piece back");
  assert.equal(shape.piece.children.length, 0);
});

test("a piece rebuilt (moved, unequipped) takes the rig down with it; a missing clip is asked for", () => {
  const log = [];
  const unit = newBowDrawUnit();
  const shape = body();
  const fake = host(log);
  unit.draw.weapon = { animation: 0xa1, speed: 1, at: 0 };
  syncBowDrawVisuals(unit, shape, fake, 0, 0.016);
  assert.ok(unit.rig);
  assert.equal(unit.rig.applied, unit.draw.weapon, "a sequence the model lacks: the rest pose, nothing asked");
  assert.equal(unit.rig.action, undefined);
  assert.equal(log.includes("clips"), false);
  unit.rig.template.animations.add(0xa1);
  unit.draw.weapon = { animation: 0xa1, speed: 1, at: 5 };
  syncBowDrawVisuals(unit, shape, fake, 5, 0.016);
  assert.equal(log.includes("clips"), true, "in the sidecar: asked for");
  assert.notEqual(unit.rig.applied, unit.draw.weapon, "and started once it is there");
  const moved = { ...shape, piece: new THREE.Mesh() };
  syncBowDrawVisuals(unit, moved, fake, 10, 0.016);
  assert.equal(unit.rig.node, moved.piece, "rebuilt on the new piece");
  assert.equal(shape.piece.layers.mask, 1, "the old piece is given its layers back");
  const gone = { ...shape, piece: undefined };
  syncBowDrawVisuals(unit, gone, fake, 20, 0.016);
  assert.equal(unit.rig, undefined);
});

test("the clip on show as the draw reads it: time, length, variation, the action as its start", () => {
  const into = newBowDrawUnit().base;
  const clipA = new THREE.AnimationClip("a", 2, []);
  const clipB = new THREE.AnimationClip("b", 2, []);
  const mixer = new THREE.AnimationMixer(new THREE.Object3D());
  const action = mixer.clipAction(clipB);
  action.time = 0.5;
  const template = { variations: new Map([[105, [{ variation: 0, clip: clipA, overlay: clipA }, { variation: 1, clip: clipB, overlay: clipB }]]]) };
  const shown = shownClip(into, action, 105, template);
  assert.deepEqual({ ...shown, token: shown.token === action }, { animation: 105, variation: 1, timeMs: 500, durationMs: 2000, token: true });
  assert.equal(shownClip(into, undefined, 105, template), undefined);
  assert.equal(shownClip(into, action, -1, template), undefined);
});
