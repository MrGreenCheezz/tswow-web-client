// 05.10-A7b-2 (7.03 slice 3): a building with a street seen from the street — the per-placement
// walk state (`WmoOpenAir.ts`) and the renderer's one hook point in `#updateWmoGroups`.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  WMO_OPEN_AIR_ROOM_RANGE, createWmoOpenAirState, wmoOpenAirCandidatesStale, wmoOpenAirNoteCandidates,
  wmoOpenAirNoteWalk, wmoOpenAirWalkStale,
} from "../dist/code/browser/WmoOpenAir.js";
import { selectWmoPortalGroups } from "../dist/code/browser/WmoOcclusion.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test("the open-air room leash lies past the old sixty yards and within the shell's 250", () => {
  assert.ok(WMO_OPEN_AIR_ROOM_RANGE > 60 && WMO_OPEN_AIR_ROOM_RANGE <= 250, String(WMO_OPEN_AIR_ROOM_RANGE));
});

test("candidates are chosen again only when the player moves", () => {
  const state = createWmoOpenAirState();
  assert.equal(wmoOpenAirCandidatesStale(state, 1, 2, 3), true, "nothing chosen yet");
  const candidates = [0, 2];
  wmoOpenAirNoteCandidates(state, candidates, 1, 2, 3);
  assert.equal(wmoOpenAirCandidatesStale(state, 1, 2, 3), false);
  assert.equal(state.candidates === candidates, true);
  assert.equal(wmoOpenAirCandidatesStale(state, 1, 2, 3.5), true);
  assert.equal(wmoOpenAirCandidatesStale(state, 1.5, 2, 3), true);
});

test("a walk is redone when the matrix, the candidates or the room record change, and only then", () => {
  const state = createWmoOpenAirState();
  const rooms = {};
  wmoOpenAirNoteCandidates(state, [0, 1], 0, 0, 0);
  assert.equal(wmoOpenAirWalkStale(state, IDENTITY, rooms), true, "never walked");
  wmoOpenAirNoteWalk(state, IDENTITY, rooms);
  assert.equal(wmoOpenAirWalkStale(state, [...IDENTITY], rooms), false, "the same numbers in another array");
  for (let index = 0; index < 16; index++) {
    const moved = [...IDENTITY];
    moved[index] += 1e-9;
    assert.equal(wmoOpenAirWalkStale(state, moved, rooms), true, `element ${index}`);
  }
  assert.equal(wmoOpenAirWalkStale(state, IDENTITY, {}), true, "another room record");
  assert.equal(wmoOpenAirWalkStale(state, IDENTITY, undefined), true);
  wmoOpenAirNoteCandidates(state, [0, 1], 5, 0, 0);
  assert.equal(wmoOpenAirWalkStale(state, IDENTITY, rooms), true, "new candidates, even with equal contents");
});

test("the state's walk options carry its own scratch and seed from outside", () => {
  const state = createWmoOpenAirState();
  assert.equal(state.walk.exteriorSeeds, true);
  assert.equal(state.walk.scratch === state.scratch, true);
  const bounds = (minX, maxX) => ({ minX, minY: -1, minZ: -1, maxX, maxY: 1, maxZ: 1 });
  const groups = [
    { bounds: bounds(-10, 10), indoor: false, exterior: false, portalStart: 0, portalCount: 1 },
    { bounds: bounds(2, 3), indoor: true, exterior: false, portalStart: 1, portalCount: 1 },
  ];
  const portals = {
    vertices: new Float32Array([-0.2, -0.2, 0, 0.2, -0.2, 0, 0.2, 0.2, 0, -0.2, 0.2, 0]),
    definitions: [{ startVertex: 0, vertexCount: 4 }],
    references: [{ portal: 0, group: 1, side: 1 }, { portal: 0, group: 0, side: -1 }],
  };
  const walk = selectWmoPortalGroups(groups, portals, [0, 1], { x: 20, y: 0, z: 0 }, IDENTITY, undefined, undefined, state.walk);
  assert.equal(walk === state.scratch.result, true);
  assert.deepEqual([...walk.groups], [0, 1]);
});

test("the renderer walks from open air only for static buildings with a street, behind the switch", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source,
    /if \(staticEnvironment && !entered && this\.#wmoOcclusion && placed\.model\.portals && !wmoInteriorOnly\(placed\.model\)\) \{\r?\n\s+selected = this\.#wmoRoomsFromOpenAir\(placed, player, selected, walked\);/);
  assert.match(source, /clipped = entered;\r?\n\s+walked = true; \/\/ 05\.10-A7b-2/,
    "an indoor walk that answered is told apart from one that fell back");
  assert.match(source, /if \(wmoOpenAirWalkStale\(state, clip, rooms\)\) \{/, "walked again only on change");
  assert.match(source, /this\.#bindWmoDoodads\(placed, walk\.groups, true, WMO_OPEN_AIR_ROOM_RANGE\);/);
  assert.match(source, /if \(binds\) this\.#bindWmoDoodads\(placed, selected, false, INTERIOR_RANGE\);/);
  assert.match(source, /const rooms = this\.#bindWmoDoodads\(placed, selected, clipped\); \/\/ 05\.10-A7b-2/,
    "a building of rooms alone binds as before, on the environment range");
  assert.match(source,
    /return interiorOnlyDoodadShown\(object\) === undefined \? INTERIOR_RANGE : boundWmoDoodadLeash\(object\);/);
  assert.match(source, /return INTERIOR_ONLY_DOODADS\.get\(object\)\?\.rooms\.leash \?\? INTERIOR_ONLY_RANGE;/);
  // Only the static-environment call opts in (moving game objects keep distance selection).
  // 05.10-7.05-review: the game-object call measures from the transport viewer and passes false.
  const calls = [...source.matchAll(/this\.#updateWmoGroups\(rendered\.wmo, (?:player|viewer), rendered\.node, client, (true|false)\b/g)];
  assert.deepEqual(calls.map((match) => match[1]), ["true", "false"]);
});

// 05.10 review A7b-2: since slice 3 every admitted building with a street and WME4 binds its doodads,
// and each rebind (every snapshot change — a tile landing) walked the whole snapshot: K placements x N
// objects. Measured 1.3 ms at 10 x 20,000 and 3.6 ms at 30 x 20,000 on P-cores
// (`.runtime/re-2026-10-05/A7b-2-review/rebind-bench.mjs`; the Stormwind/Elwynn block holds 104,920
// objects, 84,262 of them WMO doodads). The snapshot is now grouped by parent once.
test("a snapshot's WMO doodads are grouped by placement once, in snapshot order", async () => {
  const { wmoDoodadsOfPlacement } = await import("../dist/code/browser/WmoOpenAir.js");
  const doodad = (parent, ordinal) => ({ id: -(parent * 1_000_000 + ordinal + 1), interior: true });
  const objects = [doodad(7, 0), { id: 5 }, doodad(9, 2), doodad(7, 3), { id: -(7 * 1_000_000 + 1) }, doodad(7, 1)];
  const seven = wmoDoodadsOfPlacement(objects, 7);
  assert.deepEqual(seven.map((object) => object.id), [-7_000_001, -7_000_004, -7_000_002],
    "interior doodads of placement 7 only, in order (a non-interior id of 7 is not one)");
  assert.equal(wmoDoodadsOfPlacement(objects, 7) === seven, true, "the same array for the same snapshot");
  assert.deepEqual(wmoDoodadsOfPlacement(objects, 9).map((object) => object.id), [-9_000_003]);
  assert.deepEqual(wmoDoodadsOfPlacement(objects, 1).length, 0);

  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const bind = source.slice(source.indexOf("  #bindWmoDoodads("), source.indexOf("  #noteInteriorOnly("));
  assert.match(bind, /for \(const object of wmoDoodadsOfPlacement\(objects, placed\.visualId\)\) \{/);
  assert.doesNotMatch(bind, /for \(const object of objects\)/, "no walk over the whole snapshot per placement");
});

