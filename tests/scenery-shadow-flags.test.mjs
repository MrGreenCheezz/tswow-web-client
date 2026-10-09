import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as THREE from "three";

import { SHADOW_CASTER_PRUNE_FRAMES, ShadowCasterList } from "../dist/code/browser/ShadowCasterList.js";
import {
  SCENERY_FAR_SHADOW_MIN_RADIUS, SCENERY_SHADOW_CAST, SCENERY_SHADOW_FAR, SCENERY_SHADOW_MIN_RADIUS,
  SCENERY_SHADOW_RECEIVE, sceneryShadowFlags,
} from "../dist/code/browser/SceneryShadowFlags.js";

const CAST = SCENERY_SHADOW_CAST;
const RECEIVE = SCENERY_SHADOW_RECEIVE;
const FAR = SCENERY_SHADOW_FAR;

// The closure `#syncSceneryShadows` ran over every mesh before P2-02a, written out by hand.
function before(eligibleMaterials, radius, wanted, include, cascades) {
  const eligible = wanted && include && eligibleMaterials;
  const casts = eligible && radius >= 1.5;
  const far = casts && cascades && radius >= 3;
  return (casts ? CAST : 0) | (eligible ? RECEIVE : 0) | (far ? FAR : 0);
}

test("the thresholds are the renderer's", () => {
  assert.equal(SCENERY_SHADOW_MIN_RADIUS, 1.5);
  assert.equal(SCENERY_FAR_SHADOW_MIN_RADIUS, 3);
});

test("P2-02b: an instanceable copy reaches the cached cascade by its unscaled radius", () => {
  // Geometry radius 4 at scale 0.6: casts (2.4), and is far like its bucket (4), not by its own 2.4.
  assert.equal(sceneryShadowFlags({ eligible: true, radius: 2.4, farRadius: 4 }, true, true, true), RECEIVE | CAST | FAR);
  // Geometry radius 2.5 at scale 1.5: its bucket is not far, so neither is the copy.
  assert.equal(sceneryShadowFlags({ eligible: true, radius: 3.75, farRadius: 2.5 }, true, true, true), RECEIVE | CAST);
  assert.equal(sceneryShadowFlags({ eligible: true, radius: 1, farRadius: 4 }, true, true, true), RECEIVE, "a copy too small to cast is not far either");
  assert.equal(sceneryShadowFlags({ eligible: true, radius: 2, farRadius: undefined }, true, true, true), RECEIVE | CAST);
});

test("radius thresholds: casting from 1.5 yards, the cached cascade from 3 with cascades on", () => {
  const at = (radius, cascades = true) => sceneryShadowFlags({ eligible: true, radius }, true, true, cascades);
  assert.equal(at(1.49), RECEIVE, "a crate receives but does not cast");
  assert.equal(at(SCENERY_SHADOW_MIN_RADIUS), RECEIVE | CAST, "the threshold itself casts");
  assert.equal(at(2.99), RECEIVE | CAST);
  assert.equal(at(SCENERY_FAR_SHADOW_MIN_RADIUS), RECEIVE | CAST | FAR, "the far threshold itself is far");
  assert.equal(at(40, false), RECEIVE | CAST, "no cascades, no cached cascade");
  assert.equal(at(Number.NaN), RECEIVE, "an unknown radius never casts");
});

test("off, excluded or ineligible meshes carry no flag at all", () => {
  for (const radius of [0, 2, 10]) {
    assert.equal(sceneryShadowFlags({ eligible: true, radius }, false, true, true), 0, "leaf off clears all three");
    assert.equal(sceneryShadowFlags({ eligible: true, radius }, true, false, true), 0, "a WMO placement casts through stand-ins only");
    assert.equal(sceneryShadowFlags({ eligible: false, radius }, true, true, true), 0, "translucent or unlit");
  }
});

test("the same answer as the pre-P2-02a closure on every input", () => {
  let checked = 0;
  for (const eligible of [false, true]) {
    for (const wanted of [false, true]) {
      for (const include of [false, true]) {
        for (const cascades of [false, true]) {
          for (const radius of [0, 0.5, 1.4999, 1.5, 1.5001, 2.9999, 3, 3.0001, 12, Number.NaN, Infinity]) {
            assert.equal(sceneryShadowFlags({ eligible, radius }, wanted, include, cascades),
              before(eligible, radius, wanted, include, cascades),
              JSON.stringify({ eligible, radius, wanted, include, cascades }));
            checked++;
          }
        }
      }
    }
  }
  assert.equal(checked, 176);
});

const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");

function body(name) {
  const start = source.indexOf(`\n  ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = source.slice(start + 1).search(/\n {2}(?:readonly |get |set |static |async )*#?[A-Za-z_$][\w$]*\s*[(<=:]/);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

test("the environment is walked only on a transition, not on the thirtieth light push", () => {
  const sync = body("#syncSceneryShadows");
  // Correction 7: both lines stay as they were.
  assert.match(sync, /const wanted = this\.#cinematic\.profile\.sceneryShadows && this\.#lightingProfile\.shadowMapSize > 0\s+&& this\.#interiorLight === undefined;/);
  assert.match(sync, /if \(!wanted && !this\.#sceneryShadowsApplied\) return;/);
  // Switching on waits for the cadence as before (a flickering room light costs one walk per thirty
  // pushes); switching off and forced syncs are immediate.
  assert.match(sync, /if \(!force && wanted && this\.#sceneryShadowFrame % 30 !== 0\) return;\s+const transition = force \|\| wanted !== this\.#sceneryShadowsApplied;/);
  const guarded = /if \(transition\) \{[^}]*for \(const rendered of this\.#environment\.values\(\)\)[^}]*for \(const \{ mesh \} of this\.#instances\.values\(\)\)/s;
  assert.match(sync, guarded, "the placement and instance loops sit under `if (transition)`");
  assert.equal(sync.match(/this\.#environment\.values\(\)/g)?.length, 1, "no second, unguarded environment walk");
  assert.equal(sync.match(/this\.#instances\.values\(\)/g)?.length, 1);
  assert.match(sync, /for \(const terrain of this\.#terrains\.values\(\)\)/, "the terrain stays on the cadence");
  // P2-02b: against the folds as the cached cascade last drew them, plus the marks no fold sees.
  assert.match(sync, /if \(this\.#sceneryFarDirty \|\| farCasters !== this\.#sceneryTerrainDrawnFold\s+\|\| this\.#sceneryFarFold !== this\.#sceneryFarDrawnFold \|\| this\.#sceneryFarCount !== this\.#sceneryFarDrawnCount\) \{/,
    "a change of the scenery in the cached cascade since its last render re-renders it on the cadence");
  assert.match(source, /readonly #noteFarRendered = \(\): void => \{\s+this\.#sceneryFarDrawnFold = this\.#sceneryFarFold;\s+this\.#sceneryFarDrawnCount = this\.#sceneryFarCount;\s+this\.#sceneryTerrainDrawnFold = this\.#sceneryTerrainFold;/);
  assert.match(source, /this\.#sunCascades\.setFarRenderListener\(this\.#noteFarRendered\);/);
});

test("every place scenery joins the scene flags it, and every place it leaves reports the cached cascade", () => {
  const update = body("#updateEnvironment");
  assert.match(update, /this\.#assignEnvironmentInstance\(rendered, object, visual, model\);\s+\/\/ P2-02a[^\n]*\n\s+this\.#sceneryShadowsForPlacement\(rendered\);/,
    "a built placement, after its matrices");
  const growth = body("#updateVegetationGrowth");
  assert.match(growth, /this\.#growingVegetation--;[\s\S]*?this\.#assignEnvironmentInstance\([\s\S]*?if \(this\.#sceneryFarOwners\.has\(rendered\)\) this\.#sceneryFarDirty = true;\s+this\.#sceneryShadowsForPlacement\(rendered\);/,
    "a settled tree, after its instance key; one already far re-renders the cached map");
  assert.ok(growth.indexOf("node.updateMatrixWorld(true)") < growth.indexOf("#sceneryShadowsForPlacement"),
    "after its full-size world matrix");
  const instances = body("#updateInstances");
  assert.match(instances, /\.add\(mesh\);\s+this\.#sceneryShadowsForInstance\(mesh\);/, "a fresh instance bucket");
  const rooms = body("#updateWmoGroups");
  assert.match(rooms, /node\.add\(rendered\.mesh\);[\s\S]{0,1200}if \(staticEnvironment && this\.#sceneryShadowsApplied\) \{\s+this\.#syncWmoRoomShadow\(placed, index, rendered, true, this\.#sunCascades\.active\);/,
    "a room hung on a placed building");
  assert.equal(rooms.match(/node\.remove\(built\.mesh\);\s+this\.#releaseWmoRoomShadow\(built\.mesh\)/g)?.length, 2, "both room detaches");
  assert.match(body("#clearWmoGroups"), /node\.remove\(mesh\);\s+this\.#releaseWmoRoomShadow\(mesh\)/);
  assert.match(body("#releaseWmoRoomShadow"), /this\.#forgetSceneryFar\(mesh\);[\s\S]*if \(proxy\) this\.#shadowCasters\.set\(proxy, false\);/,
    "a detached room's stand-in leaves the caster list at once");
  assert.match(body("#disposeEnvironment"), /this\.#forgetSceneryFar\(rendered\)/);
  // P2-02b: instance buckets are not far owners (their placements are), so a rebuild is no change.
  assert.doesNotMatch(body("#sceneryShadowsForInstance"), /#noteSceneryFar/);
  assert.match(body("#syncWmoRoomShadow"), /this\.#noteSceneryFar\(mesh, \(mesh\.parent\?\.id \?\? 0\) \* 4096 \+ index, casts\)/,
    "a room folds under its building and group, not its fresh mesh");
  const admitted = body("#setEnvironmentAdmitted");
  assert.match(admitted, /if \(rendered\.growthStartedAt !== undefined\) \{\s+if \(this\.#sceneryFarOwners\.has\(rendered\)\) this\.#sceneryFarDirty = true;[^\n]*\n\s+this\.#sceneryShadowsForPlacement\(rendered\);/,
    "a tree hidden mid-growth is flagged at the size it stopped at");
  assert.doesNotMatch(admitted, /rendered\.interior[^\n]*#sceneryFarDirty/,
    "interior admission is left to the interval: the city orbit flips it on every reconcile");
});

test("scenery joins the scene at exactly the three hooked sites", () => {
  // A new site adding placements, instance buckets or rooms needs its flagging helper: the caster
  // list drops an entry detached for SHADOW_CASTER_PRUNE_FRAMES and no cadence re-sets scenery now.
  const placements = source.match(/(?:#environmentGroup|#animatedEnvironmentGroup)\)?\.add\(/g) ?? [];
  assert.equal(placements.length, 1, "one placement attach site");
  assert.match(source, /\(rendered\.skinned \? this\.#animatedEnvironmentGroup : this\.#environmentGroup\)\.add\(node\);[\s\S]{0,8000}?this\.#sceneryShadowsForPlacement\(rendered\);/);
  const buckets = source.match(/(?:#instanceGroup|#localLightInstanceGroup)\)?\.add\(/g) ?? [];
  assert.equal(buckets.length, 1, "one instance bucket attach site");
  assert.equal(source.match(/node\.add\(rendered\.mesh\);/g)?.length, 1, "one room attach site");
});

test("the caster list forgets an entry detached for the prune interval until it is set again", () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  scene.add(mesh);
  const list = new ShadowCasterList();
  list.set(mesh, true);
  list.beginFrame(scene);
  assert.equal(list.stats.emitted, 1);
  scene.remove(mesh);
  for (let frame = 0; frame < SHADOW_CASTER_PRUNE_FRAMES; frame++) list.beginFrame(scene);
  assert.equal(list.has(mesh), false, "pruned after the interval");
  scene.add(mesh);
  list.beginFrame(scene);
  assert.equal(list.stats.emitted, 0, "hung back without `set`, it casts nothing: the hooks above are what re-set scenery");
  list.set(mesh, true);
  list.beginFrame(scene);
  assert.equal(list.stats.emitted, 1);
});

test("a posed rigged far placement keeps the cached cascade on its frame interval", () => {
  assert.match(body("#sceneryShadowsForPlacement"), /this\.#noteSceneryFar\(rendered, rendered\.node\.id, far, rendered\.skinned !== undefined\);/);
  assert.match(source, /this\.#sunCascades\.setFarAnimated\(this\.#sceneryFarPosed\);\s+this\.#sunCascades\.update\(/);
  assert.match(body("#poseDoodads"), /for \(let index = 0; index < this\.#doodadsPosed && !farPosed; index\+\+\) \{\s+if \(this\.#sceneryFarAnimated\.has\(posed\[index\]!\.rendered\)\) farPosed = true;/,
    "only rigs actually posed this frame, not every retained one");
  assert.match(body("#forgetSceneryFar"), /this\.#sceneryFarAnimated\.delete\(owner\);/);
});

test("the cached map's other blind spots are marked", () => {
  assert.match(body("#commitTerrainRepair"), /rendered\.mesh\.geometry = geometry;[\s\S]{0,300}if \(rendered\.mesh\.castShadow && rendered\.mesh\.layers\.isEnabled\(SHADOW_FAR_LAYER\)\) this\.#sunCascades\.invalidateFar\(\);/,
    "a repaired tile keeps its mesh");
  assert.match(body("#updateWmoGroups"), /this\.#holdWmoGroupUntilWarm\(rendered\.mesh\);[\s\S]{0,1200}?\/\/ P2-02b: a held room[^\n]*\n\s+const heldFar = rendered\.mesh\.visible \? undefined : this\.#sceneryFarOwners\.get\(rendered\.mesh\);\s+if \(heldFar !== undefined\) \{\s+this\.#forgetSceneryFar\(rendered\.mesh\);\s+this\.#wmoHeldFar\.set\(rendered\.mesh, heldFar\);/,
    "a room held until warm is out of the far set");
  assert.match(body("#releaseWarmWmoGroups"), /const heldFar = this\.#wmoHeldFar\.get\(mesh\);\s+if \(heldFar !== undefined\) \{\s+this\.#wmoHeldFar\.delete\(mesh\);\s+if \(this\.#wmoShadowProxies\.get\(mesh\)\?\.castShadow\) this\.#noteSceneryFar\(mesh, heldFar, true\);/,
    "and joins it when shown");
  assert.match(body("#applySceneryShadowFlags"), /if \(rendered\?\.instanceKey !== undefined\) traits\.farRadius = geometry\.boundingSphere\?\.radius \?\? 0;/,
    "a copy the instance pass may draw takes its bucket's far answer");
});

test("the event helpers do nothing while the leaf was never applied", () => {
  for (const name of ["#sceneryShadowsForPlacement", "#sceneryShadowsForInstance"]) {
    assert.match(body(name), /wanted = this\.#sceneryShadowsApplied,[\s\S]*if \(!wanted && !this\.#sceneryShadowsApplied\) return;/, name);
  }
});
