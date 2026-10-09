import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as THREE from "three";
import { WmoGeometryBuild } from "../dist/code/browser/WmoGeometryBuild.js";
import { FrameBuildBudget } from "../dist/code/browser/FrameBuildBudget.js";
import { sameWmoSelection } from "../dist/code/browser/WmoGroupRange.js";

const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("WorldRenderer3D.ts", source, ts.ScriptTarget.ES2022, true);
const renderer = parsed.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === "WorldRenderer3D");
const methods = ["#updateWmoGroups", "#wmoGroupMesh", "#clearWmoGroups", "#evictWmoResources"].map(name =>
  renderer.members.find(n => n.name?.getText(parsed) === name).getText(parsed).replaceAll("#", ""));
const js = ts.transpileModule(`class Harness { ${methods.join("\n")} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
// P1-12: the distance selection comes from `placed.ranges` (see `placement` below).
const Harness = Function("THREE", "sameWmoSelection", "WMO_GROUP_BUILD_BUDGET", `${js}; return Harness;`)(
  THREE, sameWmoSelection, 6,
);

/** `BuiltModelCache`'s surface the room pass reads: `peek` without touching, `epoch` on set/delete. */
class EpochCache extends Map {
  epoch = 0;
  peek(key) { return super.get(key); }
  set(key, value) { this.epoch++; return super.set(key, value); }
  delete(key) {
    const had = super.delete(key);
    if (had) this.epoch++;
    return had;
  }
}

/** A second placement of the same model: its own rooms and node, none of the first's pass state. */
const sibling = (placed) => ({ model: placed.model, boxes: placed.boxes, ranges: placed.ranges, built: new Map(), node: new THREE.Group() });

function fixture() {
  let time = 0;
  let cancelled = 0;
  let warmed = 0;
  const build = function* () {
    let done = false;
    try {
      for (let i = 0; i < 5; i++) { time += 0.5; yield; }
      done = true;
      return new THREE.BufferGeometry();
    } finally { if (!done) cancelled++; }
  };
  const cache = new EpochCache();
  cache.evictUnpinned = () => [];
  const h = Object.assign(new Harness(), {
    submissionSerial: 0, wmoGroupBuildSerial: -1, wmoGroupBuilds: 0, wmoGroupsPending: 0, worldResourceEpoch: 1,
    wmoGroupBuildBudget: new FrameBuildBudget(6, 2, () => time),
    wmoGeometryBuild: new WmoGeometryBuild(1.5, 128, () => time, build),
    wmoGeometries: cache, wmoPreparedGeometryPins: new Set(), legacyGeometries: { evictUnpinned: () => [] },
    worldMaterials: { commitPins() {} },
    wmoGroupBorrowers: () => ({ geometryPins: new Set(), materialPins: new Set() }),
    legacyResourceBorrowers: () => ({ geometryPins: new Set(), materialPins: new Set() }),
    wmoGroupCacheKey: (model, index) => `${model.name}/${index}`,
    wmoRunMaterial: () => ({ material: new THREE.MeshBasicMaterial() }),
    programWarmup: { registerObject() { warmed++; }, unregisterObject() {} },
    // The warm hold (tests/program-warmup-shadow-depth.test.mjs) only hides a room until its
    // programs link; the streaming contract under test here is unaffected by it.
    holdWmoGroupUntilWarm() {},
  });
  function placement(name, count = 1) {
    const model = { name, complete: true, selected: Array.from({ length: count }, (_, i) => i),
      groups: Array.from({ length: count }, () => ({ exterior: true, mesh: { runs: [{}] } })) };
    return { model, built: new Map(), boxes: [], node: new THREE.Group(), ranges: { select: () => model.selected } };
  }
  function frame(...placements) {
    h.submissionSerial++;
    h.wmoGroupsPending = 0;
    for (const p of placements) h.updateWmoGroups(p, { x: h.submissionSerial, y: 0, z: 0 }, p.node);
    h.evictWmoResources();
  }
  return { h, placement, frame, cancelled: () => cancelled, warmed: () => warmed };
}

test("production renderer attaches a room only after its geometry completes, then shares the cache", () => {
  const { h, placement, frame, warmed } = fixture();
  const first = placement("town");
  frame(first);
  assert.equal(first.node.children.length, 0);
  assert.equal(h.wmoGeometries.size, 0);
  assert.equal(warmed(), 0);
  assert.equal(h.wmoGroupsPending, 1);
  frame(first);
  assert.equal(first.built.size, 1);
  assert.equal(first.node.children.length, 1);
  assert.equal(h.wmoGroupsPending, 0);
  const second = sibling(first);
  frame(first, second);
  assert.equal(second.built.size, 1);
  assert.equal(second.node.children[0].geometry, first.node.children[0].geometry);
  assert.equal(h.wmoGeometries.size, 1);
});

test("a pending room behind more than six unrelated requests is not starved by admission", () => {
  const { placement, frame } = fixture();
  const pending = placement("pending");
  frame(pending);
  const earlier = placement("earlier", 12);
  frame(earlier, pending);
  assert.equal(pending.built.size, 1);
  assert.equal(earlier.built.size, 0);
  frame(earlier, pending);
  frame(earlier, pending);
  assert.ok(earlier.built.size > 0);
});

test("production final demand cancels removed rooms but keeps another placement's shared demand", () => {
  const { placement, frame, cancelled, h } = fixture();
  const first = placement("shared");
  frame(first);
  const second = sibling(first);
  frame(second);
  assert.equal(second.built.size, 1);
  assert.equal(cancelled(), 0);
  const obsolete = placement("obsolete");
  frame(obsolete);
  frame();
  assert.equal(cancelled(), 1);
  assert.equal(h.wmoGeometries.has("obsolete/0"), false);
  const replacement = placement("replacement");
  frame(replacement);
  frame(replacement);
  assert.equal(replacement.built.size, 1);
});

test("cache pressure cannot discard a completed room while its material admission is deferred", () => {
  const { h, placement, frame } = fixture();
  const room = placement("delayed");
  frame(room);
  const take = h.wmoGroupBuildBudget.take.bind(h.wmoGroupBuildBudget);
  h.wmoGroupBuildBudget.take = () => false;
  h.wmoGeometries.evictUnpinned = pins => {
    const removed = [];
    for (const [key, entry] of h.wmoGeometries) {
      if (!pins.has(entry)) { removed.push({ built: entry }); h.wmoGeometries.delete(key); }
    }
    return removed;
  };
  frame(room);
  const ready = h.wmoGeometries.get("delayed/0");
  assert.ok(ready);
  assert.equal(room.built.size, 0);
  h.wmoGroupBuildBudget.take = take;
  h.wmoGroupBorrowers = () => ({ geometryPins: new Set([...room.built.values()].map(v => v.entry)), materialPins: new Set() });
  frame(room);
  assert.equal(room.built.get(0).entry, ready);
  assert.equal(h.wmoPreparedGeometryPins.size, 0);
});
