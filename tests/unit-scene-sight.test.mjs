import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { game } from "../dist/code/browser/game/Context.js";
import { cycleEnemyTarget } from "../dist/code/browser/game/Targeting.js";
import {
  UnitSightPass, unitSeenByCamera, unitSightRadius, unitSphereInView,
} from "../dist/code/browser/UnitSceneSight.js";

/*
 * 5.16 / 6.37 (15.11): Tab (0x00524440) and the name plates (0x0072B060, 0x00734390) take only units whose map entity
 * byte +0x25 is 0 (0x0077F0B0): the per-frame passes 0x00793060, 0x007987A0, 0x00799980 clear it when the sphere —
 * the feet, radius the model box's diagonal (0x007B5740) — is inside the six view planes (0x00983D20) and in no map
 * occluder's shadow (0x007CCE00). Notes: .runtime/re-2026-11-15/go8/c.c, d.c; .runtime/re-2026-11-15/combat5/d3.c.
 */

/** A camera at the scene's origin looking along WoW +y (the scene's −z), twice as wide as high. */
function camera() {
  const view = new THREE.PerspectiveCamera(50, 2, 0.1, 1000);
  view.updateProjectionMatrix();
  view.updateMatrixWorld(true);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse));
  return { view, planes: frustum.planes };
}

const BODY = { wvm: { bounds: { min: [-0.5, 0, -0.5], max: [0.5, 2, 0.5] } }, scale: 1 };

function candidate(guid, x, y, z = 0, typeId = 3) {
  return { value: { guid, typeId, position: { x, y, z } } };
}

test("0x007B5740: the radius is the whole diagonal of the model box, scaled; mounted, the mount's", () => {
  assert.equal(unitSightRadius(BODY), Math.hypot(1, 2, 1));
  assert.equal(unitSightRadius({ ...BODY, scale: 2 }), 2 * Math.hypot(1, 2, 1));
  const mount = { wvm: { bounds: { min: [-1, 0, -2], max: [1, 2, 2] } }, scale: 1.5 };
  assert.equal(unitSightRadius({ ...BODY, mount }), 1.5 * Math.hypot(2, 2, 4));
  assert.equal(unitSightRadius({ wvm: undefined, scale: 1 }), undefined);
  assert.equal(unitSightRadius(undefined), undefined);
});

test("0x00983D20: in front is seen, behind the camera and beside the view are not; a sphere reaching in is", () => {
  const { planes } = camera();
  // The scene's axes: WoW x, z, −y.
  assert.equal(unitSphereInView(0, 0, -20, 1, planes), true);
  assert.equal(unitSphereInView(0, 0, 20, 1, planes), false, "behind the camera");
  assert.equal(unitSphereInView(60, 0, -20, 1, planes), false, "far to the side");
  assert.equal(unitSphereInView(60, 0, -20, 40, planes), true, "a large enough body still reaches into the view");
});

test("the pass: the set holds exactly the units that passed, kept and edited in place", () => {
  const { view, planes } = camera();
  const pass = new UnitSightPass();
  const seen = new Set();
  const bodies = new Map([[10n, BODY], [11n, BODY], [12n, BODY]]);
  const ahead = candidate(10n, 0, 20);
  const behind = candidate(11n, 0, -20);
  const aside = candidate(12n, 60, 20);
  const object = { value: { guid: 13n, typeId: 5, position: { x: 0, y: 20, z: 0 } } };
  pass.publish(seen, [ahead, behind, aside, object], bodies, planes, view, undefined);
  assert.deepEqual([...seen], [10n], "game objects are not units; behind and aside are not seen");
  assert.equal(pass.tested, 3);
  const same = seen;
  pass.publish(seen, [ahead, behind, aside], bodies, planes, view, undefined);
  assert.equal(seen, same);
  assert.deepEqual([...seen], [10n], "a still scene: the same answer");
  // The unit walks out of the view, another walks in.
  pass.publish(seen, [candidate(10n, 0, -5), candidate(11n, 2, 30)], bodies, planes, view, undefined);
  assert.deepEqual([...seen], [11n]);
  pass.publish(seen, [], bodies, planes, view, undefined);
  assert.equal(seen.size, 0, "gone from the renderer's range: gone from the set");
});

test("a unit with no model box yet is a point at its feet", () => {
  const { view, planes } = camera();
  const pass = new UnitSightPass();
  const seen = new Set();
  pass.publish(seen, [candidate(10n, 0, 20), candidate(11n, 0, -20)], new Map(), planes, view, undefined);
  assert.deepEqual([...seen], [10n]);
});

test("0x007CCE00: a unit in a map occluder's shadow is not seen; beside it, or with no occluders, it is", () => {
  const { view, planes } = camera();
  // A wall 10 yards ahead, 10 wide and 10 high, in WoW coordinates.
  const wall = [{ flags: 0, points: [-5, 10, -5, 5, 10, -5, 5, 10, 5, -5, 10, 5] }];
  const bodies = new Map([[10n, BODY], [11n, BODY]]);
  const behindWall = candidate(10n, 0, 20);
  const besideShadow = candidate(11n, 14, 20);
  const pass = new UnitSightPass();
  const seen = new Set();
  pass.publish(seen, [behindWall, besideShadow], bodies, planes, view, wall);
  assert.deepEqual([...seen], [11n]);
  assert.equal(pass.occluderTests, 2);
  pass.publish(seen, [behindWall, besideShadow], bodies, planes, view, undefined);
  assert.deepEqual([...seen].sort(), [10n, 11n], "a wall the original has no occluder for hides nothing: no line of sight");
});

test("the page's question: no renderer record means no culling", () => {
  assert.equal(unitSeenByCamera(undefined, 5n), true);
  assert.equal(unitSeenByCamera(new Set([5n]), 5n), true);
  assert.equal(unitSeenByCamera(new Set(), 5n), false);
});

// Tab over the renderer's set (0x00524440 asks 0x0077F0B0 when it builds the list).
const HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;
const FACTION = UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset;
const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;

function unit(guid, { typeId = 3, x = 0, faction = 2 } = {}) {
  return { guid, typeId, position: { x, y: 0, z: 0, orientation: 0 }, fields: new Map([[HEALTH, 100], [FACTION, faction], [FLAGS, typeId === 4 ? 8 : 0]]) };
}

function tabWorld() {
  const objects = new Map([[1n, unit(1n, { typeId: 4, faction: 1 })], [10n, unit(10n, { x: 5 })], [11n, unit(11n, { x: -6 })]]);
  return {
    state: { selfGuid: 1n, objects }, targetGuid: undefined, forcedReactions: new Map(), selectionClears: 0,
    creatureTemplates: new Map(), group: undefined, selected: [],
    selectTarget(guid) { this.selected.push(guid); this.targetGuid = guid; },
  };
}

async function withTab(seen, body) {
  const previous = { world: game.world, factions: game.factions, renderer: game.renderer };
  try {
    const world = tabWorld();
    game.world = world;
    game.factions = { ready: true, reaction: (_mine, theirs) => (theirs === 2 ? -1 : 1), factionOf: () => undefined };
    game.renderer = seen === undefined ? undefined : { results: { unitsSeen: seen } };
    await body(world);
  } finally {
    game.world = previous.world;
    game.factions = previous.factions;
    game.renderer = previous.renderer;
  }
}

test("Tab: without the renderer's record both enemies are in the list (the one ahead first)", () => withTab(undefined, (w) => {
  cycleEnemyTarget(1);
  cycleEnemyTarget(1);
  assert.deepEqual(w.selected, [10n, 11n]);
}));

test("Tab: a unit the camera did not see is not listed — the one behind the camera's back is never picked", () => withTab(new Set([10n]), (w) => {
  cycleEnemyTarget(1);
  cycleEnemyTarget(1);
  assert.deepEqual(w.selected, [10n, 10n]);
}));

test("Tab: with the camera turned, only the unit it sees is taken", () => withTab(new Set([11n]), (w) => {
  cycleEnemyTarget(1);
  assert.deepEqual(w.selected, [11n]);
}));

test("Tab: nothing seen, nothing picked, the selection stays", () => withTab(new Set(), (w) => {
  cycleEnemyTarget(1);
  assert.deepEqual(w.selected, []);
}));
