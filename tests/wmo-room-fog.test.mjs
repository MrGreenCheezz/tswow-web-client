// 05.10-A7b-2 (7.12): a WMO room's MFOG as the frame's one fog — the half the camera is in
// (`WmoRoomFog.ts`) and the renderer's switchable write of it into the scene fog.

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { clientDirectory, vmapsDirectory } from "../tools/paths.mjs";
import { parseWmoVisual, wmoDependencies, wmoGroupMeshes } from "../tools/wmo-visual.mjs";
import { encodeWwm } from "../tools/wwm.mjs";
import { parseVMapModelGroups } from "../dist/code/gateway/VMapModel.js";
import { alignWmoMinimapGroups } from "../dist/code/browser/WmoMinimapAlign.js";
import { decodeWwm, wmoLandFogActive, wmoLandFogAt } from "../dist/code/browser/WmoModel.js";
import {
  createWmoRoomFog, mixZoneIntoRoomFog, wmoGroupLandFog, wmoRoomFogFor, wmoRoomFogShare,
} from "../dist/code/browser/WmoRoomFog.js";
import { locatedWmoFog } from "../dist/code/browser/WorldRenderer3D.js";
import { renderSwitches, resetRenderSwitches, setRenderSwitches } from "../dist/code/browser/RenderSwitches.js";

const record = (land, water) => ({
  flags: 0, position: [0, 0, 0], innerRadius: 0, outerRadius: 10,
  land: { end: land[0], scale: land[1], colour: land[2] },
  water: { end: water[0], scale: water[1], colour: water[2] },
});
// Goldshire's peach room fog over the tool's default water half; Blackfathom's authored one.
const INN = record([83.3, 0.25, [255, 204, 153]], [222.2, -0.5, [0, 0, 255]]);
const BLACKFATHOM = record([333.3, 0.1, [10, 20, 30]], [69.4, 0.1, [151, 65, 118]]);

test("on land the land half: near = end · scale, far = end, colour 0–1", () => {
  const out = createWmoRoomFog();
  assert.equal(wmoRoomFogFor(INN, false, out), true);
  assert.equal(out.near, 83.3 * 0.25);
  assert.equal(out.far, 83.3);
  assert.deepEqual([out.r, out.g, out.b], [1, 204 / 255, 153 / 255]);
});

test("under water only an authored water half answers", () => {
  const out = createWmoRoomFog();
  assert.equal(wmoRoomFogFor(INN, true, out), false, "the default half (scale -0.5) is not a distance");
  assert.equal(wmoRoomFogFor(record([1, 1, [0, 0, 0]], [222.2, -1, [0, 0, 0]]), true, out), false);
  assert.equal(wmoRoomFogFor(BLACKFATHOM, true, out), true);
  assert.equal(out.far, 69.4);
  assert.ok(Math.abs(out.near - 6.94) < 1e-9);
  assert.deepEqual([out.r, out.g, out.b], [151 / 255, 65 / 255, 118 / 255], "the water colour, not the land one");
});

// 15.11 (7.55): Stormwind.wmo's records 0–2 as the file holds them (WowOracle tools/fog6-rooms.mjs), and what Wow.exe
// drew on the stand with the camera at a model-space point (WowOracle runs/fog6-sw*-*.tsv: VS c30, PS c2).
const placed = (position, inner, outer, land) => ({
  flags: 0, position, innerRadius: inner, outerRadius: outer,
  land: { end: land[0], scale: land[1], colour: land[2] },
  water: { end: 222.2222, scale: -1, colour: [0, 0, 255] },
});
const STORMWIND_FOGS = [
  placed([0, 0, 0], 0, 0, [444.4445, 0.25, [255, 255, 255]]),
  placed([-148.759, -319.078, -63.86], 40.139, 51.194, [333.3333, 0.25, [112, 202, 244]]),
  placed([-148.759, -286.179, -62.903], 40.139, 51.194, [333.3333, 0.25, [112, 202, 244]]),
];
const drawn = (fogIds, at) => {
  const out = createWmoRoomFog();
  assert.equal(wmoGroupLandFog(STORMWIND_FOGS, fogIds, ...at, out), true);
  return { rgb: [out.r, out.g, out.b].map((v) => Math.round(v * 255)), near: out.near, far: out.far };
};
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.05, `${label}: ${actual} vs ${expected}`);

test("Wow.exe on the stand: inside a record's inner radius its own fog (Wizard's Sanctum)", () => {
  const fog = drawn([1, 2], [-148.76, -310, -54.69]); // fog6-sw-sanctum-a
  assert.deepEqual(fog.rgb, [112, 202, 244]);
  close(fog.near, 83.33, "start");
  close(fog.far, 333.33, "end");
});

test("Wow.exe on the stand: between the radii the record gives way to record 0 by the camera's distance", () => {
  let fog = drawn([1, 2], [-148.76, -319.08, -16.69]); // fog6-sw-m05-d469: 47.17 yards from record 1
  assert.deepEqual(fog.rgb, [203, 235, 251]);
  close(fog.near, 100.99, "start");
  close(fog.far, 403.97, "end");
  fog = drawn([1, 2], [-148.76, -286.19, -16.69]); // fog6-sw-m05-d459: 46.21 yards from record 2
  assert.deepEqual(fog.rgb, [190, 231, 250]);
  close(fog.near, 98.59, "start");
  close(fog.far, 394.36, "end");
  fog = drawn([1, 2], [-137.2, -328.27, -14.09]); // fog6-sw-3p-m05-o0: the camera 51.92 yards out, its character at 47.2
  assert.deepEqual(fog.rgb, [255, 255, 255]);
});

test("Wow.exe on the stand: a group naming only record 0 draws record 0, white included (the keep's throne room)", () => {
  const fog = drawn([0], [-257.6, 479.9, 40]); // fog6-sw2-throne01
  assert.deepEqual(fog.rgb, [255, 255, 255]);
  close(fog.near, 111.11, "start");
  close(fog.far, 444.44, "end");
  assert.deepEqual(drawn([1, 2], [-148.76, -319.08, 0]).rgb, [255, 255, 255], "fog6-sw2-m05-z0: past the radii");
  assert.equal(wmoGroupLandFog([], [0], 0, 0, 0, createWmoRoomFog()), false, "no record 0: the zone's fog");
});

test("0x007a1150: a record flagged 1 is never blended in (the Stockade's record 1)", () => {
  const flagged = STORMWIND_FOGS.map((fog, id) => (id === 1 ? { ...fog, flags: 1 } : fog));
  const out = createWmoRoomFog();
  assert.equal(wmoGroupLandFog(flagged, [1], -148.76, -310, -54.69, out), true);
  assert.deepEqual([out.r, out.g, out.b].map((v) => Math.round(v * 255)), [255, 255, 255]);
});

// A room (group 0) whose one portal leads into a hall (group 1, indoor), whose portal leads outside (group 2, MOGI 0x8).
const portalModel = () => {
  const square = (x) => [x, -2, 0, x, 2, 0, x, 2, 4, x, -2, 4];
  return {
    groups: [
      { flags: 0x2000, portalStart: 0, portalCount: 1 },
      { flags: 0x2000, portalStart: 1, portalCount: 2 },
      { flags: 0x8, portalStart: 3, portalCount: 1 },
    ],
    portals: {
      vertices: new Float32Array([...square(0), ...square(-10)]),
      definitions: [{ startVertex: 0, vertexCount: 4 }, { startVertex: 4, vertexCount: 4 }],
      references: [{ portal: 0, group: 1, side: 1 }, { portal: 0, group: 0, side: -1 }, { portal: 1, group: 2, side: 1 }, { portal: 1, group: 1, side: -1 }],
    },
  };
};

test("0x007d77c0: the room's share is 0.04 a yard from the nearest portal out, through indoor groups, 1 past 25 yards", () => {
  const { groups, portals } = portalModel();
  close(wmoRoomFogShare(groups, portals, 0, 5, 0, 2), 0.6, "15 yards from the way out, through the hall");
  close(wmoRoomFogShare(groups, portals, 1, -4, 0, 2), 0.24, "6 yards in the hall");
  close(wmoRoomFogShare(groups, portals, 1, -10, 5, 2), 0.12, "beside the portal: to its nearest edge, 3 yards");
  assert.equal(wmoRoomFogShare(groups, portals, 0, 20, 0, 2), 1, "30 yards: no portal near");
  assert.equal(wmoRoomFogShare(groups, undefined, 0, 5, 0, 2), 1, "no portals: the room's fog whole");
});

test("0x007f16f0 on the stand: the zone's fog mixed towards the room's by the share (mageinterior01, fog6-line-5)", () => {
  // The zone of that frame (fog6-line-0, the camera outside) and record 0; the share measured offline is 0.321.
  const zone = { r: 76 / 255, g: 118 / 255, b: 140 / 255, near: 124.81, far: 499.25, density: 1 };
  const room = { r: 1, g: 1, b: 1, near: 111.11, far: 444.44, density: 1 };
  mixZoneIntoRoomFog(zone, room, 0.3215);
  assert.deepEqual([room.r, room.g, room.b].map((v) => Math.round(v * 255)), [133, 161, 176]);
  close(room.near, 120.41, "start");
  close(room.far, 481.62, "end");
});


test("a record with no usable distance leaves the zone's fog", () => {
  const out = createWmoRoomFog();
  assert.equal(wmoRoomFogFor(record([0, 0.5, [1, 1, 1]], [1, 0.5, [1, 1, 1]]), false, out), false);
  assert.equal(wmoRoomFogFor(record([Number.NaN, 0.5, [1, 1, 1]], [1, 0.5, [1, 1, 1]]), false, out), false);
  assert.equal(wmoRoomFogFor(record([10, Number.POSITIVE_INFINITY, [1, 1, 1]], [1, 0.5, [1, 1, 1]]), false, out), false);
});

test("the room is the collision group's flags and box, not its index: the `.vmo` leaves groups out", () => {
  const box = (minX) => ({ minX, minY: -10, minZ: -2, maxX: minX + 20, maxY: 10, maxZ: 8 });
  const room = (flags, minX, fogIds) => ({ flags, indoor: true, bounds: box(minX), fogIds });
  const model = {
    fogs: [INN, BLACKFATHOM],
    // The file: a room, a group the `.vmo` leaves out (MOGP 0x80), then two rooms with the same flags around one camera.
    groups: [room(0x2005, 0, []), room(0x22c1, 0, []), room(0x2005, -5, [0]), room(0x2005, -4, [1])],
  };
  const camera = { x: 2, y: 0, z: 2 };
  const floor = (groupIndex, minX) => ({ groupIndex, groupFlags: 0x2005, groupBounds: box(minX) });
  assert.equal(locatedWmoFog(model, floor(1, -5), camera), INN,
    "collision group 1 is file group 2; at file group 1 the flags differ and the fog was silently lost");
  assert.equal(locatedWmoFog(model, floor(2, -4), camera), BLACKFATHOM,
    "collision group 2 is file group 3; file group 2 has the same flags, holds the camera and has another record");
  assert.equal(locatedWmoFog(model, floor(0, 9), camera), undefined, "a group the file does not have keeps the zone's fog");
});

const stormwindVmo = join(vmapsDirectory(), "Stormwind.wmo.vmo");
const withStormwind = {
  skip: !existsSync(join(clientDirectory(), "Data")) ? `no client at ${clientDirectory()}`
    : !existsSync(stormwindVmo) ? `no ${stormwindVmo}` : false,
};

test("on Stormwind's own `.vmo` a room reads its own group's record", withStormwind, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const archives = await clientArchives(clientDirectory());
  const name = "World\\wmo\\Azeroth\\Buildings\\Stormwind\\Stormwind.wmo";
  const root = await archives.read(name);
  const groupBytes = [];
  for (const file of wmoDependencies(root, name).groups) groupBytes.push(await archives.read(file));
  const city = wmoGroupMeshes(parseWmoVisual(root, groupBytes, name));
  const wwm = encodeWwm(city, city.textures.map(() => ""), new Set());
  const model = decodeWwm(wwm.buffer.slice(wwm.byteOffset, wwm.byteOffset + wwm.byteLength), "");
  const collision = parseVMapModelGroups(new Uint8Array(await readFile(stormwindVmo)));
  assert.ok(collision.length < model.groups.length, "the file has groups the `.vmo` leaves out");
  const { visualOfCollision } = alignWmoMinimapGroups(model.groups, collision);
  let answered = 0;
  let movedAnswered = 0;
  for (const [index, kept] of collision.entries()) {
    const group = model.groups[visualOfCollision[index]];
    if (!group.indoor) continue;
    const floor = { groupIndex: index, groupFlags: kept.flags, groupBounds: kept.bounds };
    for (const id of group.fogIds) {
      const fog = model.fogs[id];
      if (!fog || !wmoLandFogActive(fog)) continue;
      // The point of this room's box nearest the record: inside the room and as deep in the record as the room goes.
      const { minX, minY, minZ, maxX, maxY, maxZ } = group.bounds;
      const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
      const camera = {
        x: clamp(fog.position[0], minX, maxX), y: clamp(fog.position[1], minY, maxY), z: clamp(fog.position[2], minZ, maxZ),
      };
      const expected = wmoLandFogAt(model, group, camera.x, camera.y, camera.z);
      assert.equal(locatedWmoFog(model, floor, camera), expected, `collision group ${index}, record ${id}`);
      if (expected) {
        answered++;
        if (visualOfCollision[index] !== index) movedAnswered++;
      }
    }
  }
  assert.ok(movedAnswered > 0, `${answered} answers, none at a moved index: this test no longer tells the two lookups apart`);
});

test("the switch is off by default (until the 14.25 frame) and can be turned on", () => {
  try {
    assert.equal(renderSwitches.wmoRoomFogOnScene, false);
    assert.equal(setRenderSwitches({ wmoRoomFogOnScene: true }).wmoRoomFogOnScene, true);
  } finally {
    resetRenderSwitches();
  }
  assert.equal(renderSwitches.wmoRoomFogOnScene, false);
});

test("the renderer writes the room's fog into the scene once a frame, behind the switch", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const start = source.indexOf("  #applyWmoFogCandidate(): void {");
  const method = source.slice(start, source.indexOf("\n  }\n", start));
  assert.doesNotMatch(method, /if \(this\.#underwater \|\| !candidate\) return;/, "under water no longer skips the record");
  assert.match(method, /if \(this\.#underwater && !renderSwitches\.wmoRoomFogOnScene\) return;/,
    "switched off, under water stays exactly as before");
  assert.match(method, /\? !candidate\.fog \|\| !wmoRoomFogFor\(candidate\.fog, true, room\)\r?\n\s+: !wmoGroupLandFog\(candidate\.fogs, candidate\.fogIds, candidate\.x, candidate\.y, candidate\.z, room\)\) return;/);
  assert.match(method, /if \(!this\.#underwater && candidate\.shaped && this\.#sceneFogDensity !== 1\) shapeWmoRoomFog\(room, this\.#wmoInteriorFog\.far\.value\);/,
    "7.66: on a shaped map the room is shaped to the zone's end");
  assert.match(method, /mixZoneIntoRoomFog\(zone, room, candidate\.share\);/, "7.55: the zone's fog mixed in by the share");
  const gate = method.indexOf("if (!renderSwitches.wmoRoomFogOnScene) return;");
  const write = method.indexOf("const scene = this.#scene.fog as THREE.Fog;");
  assert.ok(gate > 0 && write > gate);
  assert.match(method, /scene\.near = room\.near;\r?\n\s+scene\.far = room\.far;\r?\n\s+this\.#sceneFogDensity = room\.density; \/\/ 7\.66\r?\n\s+this\.#wmoRoomFogApplied = true;/);
  // The zone's fog comes back at the top of every submission, before the room is looked for.
  assert.match(source, /this\.#wmoFogCandidate = undefined;\r?\n\s+this\.#wmoFloor = undefined;\r?\n\s+this\.#wmoFogVisualId = undefined;\r?\n\s+this\.#restoreZoneFog\(\);/);
  assert.match(source, /if \(atmosphere\.haze > 0 && !this\.#underwater && !this\.#wmoRoomFogApplied\) applyPrecipitationHaze\(/,
    "no rain veil pulled over a room's fog");
  assert.match(source, /if \(this\.#wmoRoomFogApplied && this\.#underwater\) \{\r?\n\s+uniforms\.tint\.value\.set\(this\.#wmoRoomFog\.r, this\.#wmoRoomFog\.g, this\.#wmoRoomFog\.b, frame\.fogStrength\);/,
    "the underwater overlay takes the authored water colour");
});
