import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { selectWmoPortalGroups } from "../dist/code/browser/WmoOcclusion.js";
import {
  defaultSettings, parseSettings, settingDefinition,
} from "../dist/code/browser/ui/SettingsModel.js";

const IDENTITY = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

const bounds = (minX, maxX) => ({ minX, minY: -1, minZ: -1, maxX, maxY: 1, maxZ: 1 });
const group = (minX, maxX, portalStart, portalCount, extra = {}) => ({
  bounds: bounds(minX, maxX), indoor: true, exterior: false, portalStart, portalCount, ...extra,
});

function corridor() {
  return {
    groups: [group(-1, 1, 0, 1), group(2, 3, 1, 2), group(4, 5, 3, 1)],
    portals: {
      // Portal zero is on screen. Portal one is wholly to its right, outside both the viewport and
      // the aperture inherited by the middle room.
      vertices: new Float32Array([
        -0.25, -0.5, 0, 0.25, -0.5, 0, 0.25, 0.5, 0, -0.25, 0.5, 0,
        1.4, -0.5, 0, 1.8, -0.5, 0, 1.8, 0.5, 0, 1.4, 0.5, 0,
      ]),
      definitions: [{ startVertex: 0, vertexCount: 4 }, { startVertex: 4, vertexCount: 4 }],
      references: [
        { portal: 0, group: 1, side: 1 },
        { portal: 0, group: 0, side: -1 },
        { portal: 1, group: 2, side: 1 },
        { portal: 1, group: 1, side: -1 },
      ],
    },
  };
}

test("portal traversal refines distance candidates and reports its savings", () => {
  const { groups, portals } = corridor();
  const selected = selectWmoPortalGroups(groups, portals, [0, 1, 2], { x: 0, y: 0, z: 0 }, IDENTITY);
  assert.deepEqual(selected, {
    groups: [0, 1], candidates: 3, visible: 2, culled: 1, used: true,
  });
});

test("a portal crossing the eye plane widens instead of falsely hiding its neighbour", () => {
  const groups = [group(-1, 1, 0, 1), group(2, 3, 1, 1)];
  const portals = {
    vertices: new Float32Array([
      -0.2, -0.2, -1, 0.2, -0.2, 1, 0.2, 0.2, 1, -0.2, 0.2, -1,
    ]),
    definitions: [{ startVertex: 0, vertexCount: 4 }],
    references: [{ portal: 0, group: 1, side: 1 }, { portal: 0, group: 0, side: -1 }],
  };
  const wFromZ = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 1,
    0, 0, 0, 0,
  ];
  const selected = selectWmoPortalGroups(groups, portals, [0, 1], { x: 0, y: 0, z: 0 }, wFromZ);
  assert.deepEqual(selected.groups, [0, 1]);
  assert.equal(selected.used, true);
  assert.equal(selected.culled, 0);
});

test("groups without portal evidence are retained as conservative orphans", () => {
  const { groups, portals } = corridor();
  groups.push(group(8, 9, 4, 0));
  const selected = selectWmoPortalGroups(groups, portals, [0, 1, 2, 3], { x: 0, y: 0, z: 0 }, IDENTITY);
  assert.deepEqual(selected.groups, [0, 1, 3]);
  assert.equal(selected.candidates, 4);
  assert.equal(selected.visible, 3);
  assert.equal(selected.culled, 1);
});

test("no containing room or a damaged graph returns the unchanged distance fallback", () => {
  const { groups, portals } = corridor();
  const outside = selectWmoPortalGroups(groups, portals, [0, 1, 2], { x: 20, y: 0, z: 0 }, IDENTITY);
  assert.deepEqual(outside, { groups: [0, 1, 2], candidates: 3, visible: 3, culled: 0, used: false });

  const damaged = { ...portals, references: portals.references.map((reference, index) => (
    index === 0 ? { ...reference, group: 99 } : reference
  )) };
  const invalid = selectWmoPortalGroups(groups, damaged, [0, 1, 2], { x: 0, y: 0, z: 0 }, IDENTITY);
  assert.deepEqual(invalid, { groups: [0, 1, 2], candidates: 3, visible: 3, culled: 0, used: false });
});

test("an explicit untrusted bounds bit forces portal fallback even for finite bounds", () => {
  const { groups, portals } = corridor();
  groups[0].boundsValid = false;
  const candidates = [0, 1, 2];
  const selection = selectWmoPortalGroups(groups, portals, candidates, { x: 0, y: 0, z: 0 }, IDENTITY);
  assert.deepEqual(selection, {
    groups: candidates, candidates: 3, visible: 3, culled: 0, used: false,
  });
  assert.strictEqual(selection.groups, candidates, "fail-open keeps the exact distance candidate array");
});

test("a camera outside, in a non-indoor shell or in an exterior-lit indoor group cannot seed culling", () => {
  const { groups, portals } = corridor();
  const candidates = [0, 1, 2];
  const justOutside = selectWmoPortalGroups(groups, portals, candidates, { x: 1.01, y: 0, z: 0 }, IDENTITY);
  assert.equal(justOutside.used, false);
  assert.deepEqual(justOutside.groups, [0, 1, 2]);

  groups[0].indoor = false;
  const shell = selectWmoPortalGroups(groups, portals, candidates, { x: 0, y: 0, z: 0 }, IDENTITY);
  assert.equal(shell.used, false);
  assert.deepEqual(shell.groups, [0, 1, 2]);

  groups[0].indoor = true;
  groups[0].exterior = true;
  const exteriorIndoor = selectWmoPortalGroups(groups, portals, candidates, { x: 0, y: 0, z: 0 }, IDENTITY);
  assert.equal(exteriorIndoor.used, false);
  assert.strictEqual(exteriorIndoor.groups, candidates, "a safe fallback does not copy its candidate array");
  assert.deepEqual(exteriorIndoor.groups, [0, 1, 2]);
});

test("portals before or crossing the camera near plane widen conservatively", () => {
  const groups = [group(-1, 1, 0, 1), group(2, 3, 1, 1)];
  const references = [{ portal: 0, group: 1, side: 1 }, { portal: 0, group: 0, side: -1 }];
  const definitions = [{ startVertex: 0, vertexCount: 4 }];
  // With the identity clip matrix z=-2 lies between the eye and/outside the z=-w near plane. Its
  // x coordinates are deliberately off-screen: treating only projected endpoints would hide 1.
  const before = {
    vertices: new Float32Array([2, -0.2, -2, 3, -0.2, -2, 3, 0.2, -2, 2, 0.2, -2]),
    definitions, references,
  };
  assert.deepEqual(
    selectWmoPortalGroups(groups, before, [0, 1], { x: 0, y: 0, z: 0 }, IDENTITY).groups,
    [0, 1],
  );

  const crossing = {
    vertices: new Float32Array([2, -0.2, -2, 3, -0.2, 0, 3, 0.2, 0, 2, 0.2, -2]),
    definitions, references,
  };
  assert.deepEqual(
    selectWmoPortalGroups(groups, crossing, [0, 1], { x: 0, y: 0, z: 0 }, IDENTITY).groups,
    [0, 1],
  );
});

// 05.10-A7b-2 (7.03 slice 2): the walk from open air. A street shell (group 0) opens through a door
// (portal 0, on screen) into room 1; room 1 opens through portal 1 (right of the screen) into room 2.
function street({ doorOnScreen = true } = {}) {
  const door = doorOnScreen ? [-0.25, 0.25] : [1.2, 1.3];
  return {
    groups: [
      group(-10, 10, 0, 1, { indoor: false }),
      group(2, 3, 1, 2),
      group(4, 5, 3, 1),
    ],
    portals: {
      vertices: new Float32Array([
        door[0], -0.5, 0, door[1], -0.5, 0, door[1], 0.5, 0, door[0], 0.5, 0,
        1.4, -0.5, 0, 1.8, -0.5, 0, 1.8, 0.5, 0, 1.4, 0.5, 0,
      ]),
      definitions: [{ startVertex: 0, vertexCount: 4 }, { startVertex: 4, vertexCount: 4 }],
      references: [
        { portal: 0, group: 1, side: 1 },
        { portal: 0, group: 0, side: -1 },
        { portal: 1, group: 2, side: 1 },
        { portal: 1, group: 1, side: -1 },
      ],
    },
  };
}
const OUTSIDE = { x: 20, y: 0, z: 0 };

test("from open air the walk starts at the outside and reaches a room only through a door on screen", async () => {
  const { createWmoPortalWalkScratch } = await import("../dist/code/browser/WmoOcclusion.js");
  const { groups, portals } = street();
  const scratch = createWmoPortalWalkScratch();
  const apertures = new Float32Array(12).fill(7);
  const options = { exteriorSeeds: true, scratch };
  const seen = selectWmoPortalGroups(groups, portals, [0, 1, 2], OUTSIDE, IDENTITY, undefined, apertures, options);
  assert.deepEqual({ ...seen, groups: [...seen.groups] }, {
    groups: [0, 1], candidates: 3, visible: 2, culled: 1, used: true,
  }, "the room behind the door shows, the one beyond it (its portal off screen) does not");
  assert.deepEqual([...apertures], [-1, 1, -1, 1, -0.25, 0.25, -0.5, 0.5, 1, -1, 1, -1],
    "the street whole, the room through its door, the hidden room empty");

  // The old call — no option — still answers the unchanged distance fallback from outside.
  const before = selectWmoPortalGroups(groups, portals, [0, 1, 2], OUTSIDE, IDENTITY);
  assert.deepEqual(before, { groups: [0, 1, 2], candidates: 3, visible: 3, culled: 0, used: false });

  // The door off screen: nothing inside is reached.
  const shut = street({ doorOnScreen: false });
  const hidden = selectWmoPortalGroups(shut.groups, shut.portals, [0, 1, 2], OUTSIDE, IDENTITY, undefined, undefined,
    { exteriorSeeds: true, scratch: createWmoPortalWalkScratch() });
  assert.deepEqual([...hidden.groups], [0]);
  assert.equal(hidden.used, true);
});

test("from open air: orphans and the viewer's room stay, a damaged graph falls back, nothing is allocated", async () => {
  const { createWmoPortalWalkScratch } = await import("../dist/code/browser/WmoOcclusion.js");
  const { groups, portals } = street();
  groups.push(group(8, 9, 4, 0));
  const scratch = createWmoPortalWalkScratch();
  const options = { exteriorSeeds: true, scratch };
  const orphan = selectWmoPortalGroups(groups, portals, [0, 1, 2, 3], OUTSIDE, IDENTITY, undefined, undefined, options);
  assert.deepEqual([...orphan.groups], [0, 1, 3], "a room no portal names cannot be proven hidden");

  // The walk's answer is the scratch's own: a second walk reuses the same objects.
  const again = selectWmoPortalGroups(groups, portals, [0, 1, 2, 3], OUTSIDE, IDENTITY, undefined, undefined, options);
  assert.equal(again === orphan, true, "the same result object");
  assert.equal(again.groups === orphan.groups, true, "the same selection array");

  // The character stands in room 2 while the camera is out in the street: its room is a seed.
  const viewer = selectWmoPortalGroups(groups, portals, [0, 1, 2, 3], OUTSIDE, IDENTITY, { x: 4.5, y: 0, z: 0 },
    undefined, options);
  assert.deepEqual([...viewer.groups], [0, 1, 2, 3]);

  const damaged = { ...portals, references: portals.references.map((reference, index) => (
    index === 0 ? { ...reference, group: 99 } : reference
  )) };
  const candidates = [0, 1, 2];
  const invalid = selectWmoPortalGroups(street().groups, damaged, candidates, OUTSIDE, IDENTITY, undefined, undefined,
    { exteriorSeeds: true, scratch: createWmoPortalWalkScratch() });
  assert.equal(invalid.used, false);
  assert.equal(invalid.groups === candidates, true, "the exact distance candidates back");
});

test("with the option, a camera in a room walks from it as the old walk does", async () => {
  const { createWmoPortalWalkScratch } = await import("../dist/code/browser/WmoOcclusion.js");
  const { groups, portals } = corridor();
  for (const camera of [{ x: 0, y: 0, z: 0 }, { x: 2.5, y: 0, z: 0 }, { x: 4.5, y: 0, z: 0 }]) {
    const old = selectWmoPortalGroups(groups, portals, [0, 1, 2], camera, IDENTITY);
    const walked = selectWmoPortalGroups(groups, portals, [0, 1, 2], camera, IDENTITY, undefined, undefined,
      { exteriorSeeds: true, scratch: createWmoPortalWalkScratch() });
    assert.deepEqual([...walked.groups], [...old.groups], `camera at ${camera.x}`);
    assert.equal(walked.used, old.used);
  }
});

// 05.10 review A7b-2: a city's room boxes are districts (Dalaran's reach 145 x 145 yards), so a
// street camera can stand inside the box of a room it is not in. From open air that room joins the
// street as a seed; it must not replace it — measured on ND_Dalaran.wmo, 39 of 6,000 street frames
// sat in such a box and lost 2.6 rooms each behind doors on screen
// (.runtime/re-2026-10-05/A7b-2-review/walk-probe.mjs).
test("from open air a camera inside a room's box still sees through the street's doors", async () => {
  const { createWmoPortalWalkScratch } = await import("../dist/code/browser/WmoOcclusion.js");
  const { groups, portals } = street();
  // Room 3: a district-sized box around the camera, its own portal graph elsewhere (none here).
  groups.push(group(15, 25, 4, 0));
  const seen = selectWmoPortalGroups(groups, portals, [0, 1, 2, 3], OUTSIDE, IDENTITY, undefined, undefined,
    { exteriorSeeds: true, scratch: createWmoPortalWalkScratch() });
  assert.equal(seen.used, true);
  assert.deepEqual([...seen.groups], [0, 1, 3], "the room behind the door on screen stays drawn");
});

test("WMO occlusion is an on-by-default account setting with an off switch", () => {
  const definition = settingDefinition("wmoOcclusion");
  assert.equal(definition?.kind, "boolean");
  assert.equal(definition?.fallback, true);
  assert.equal(defaultSettings().wmoOcclusion, true);
  assert.equal(parseSettings('{"wmoOcclusion":false}')?.wmoOcclusion, false);
});

test("renderer integration is static-WMO-only and exposes portal savings", async () => {
  const [world, settings] = await Promise.all([
    readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/ui/Settings.ts", import.meta.url), "utf8"),
  ]);
  assert.match(settings, /setWmoOcclusion\(settingBoolean\(values, "wmoOcclusion"\)\)/);
  // 05.10-7.05-review: the game-object call measures from the transport viewer and passes false
  // (then its transport shell leash), as in wmo-open-air.test.mjs.
  const calls = [...world.matchAll(/this\.#updateWmoGroups\(rendered\.wmo, (?:player|viewer), rendered\.node, client, (true|false)\b/g)];
  assert.deepEqual(calls.map((match) => match[1]), ["true", "false"],
    "only the static environment call opts in; moving game objects keep distance selection");
  assert.match(world, /staticEnvironment && \(this\.#indoors \|\| entered\) && this\.#wmoOcclusion/,
    "the collision-backed indoor state, or standing in a building of rooms alone (whose rooms have "
    + "no shell to fall back on), gates portal selection before any static WMO can be hidden");
  assert.match(world, /WMO portals .*скрыто/);
  assert.match(world, /#wmoPortalCulled \+= portalSelection\.culled/);
});
