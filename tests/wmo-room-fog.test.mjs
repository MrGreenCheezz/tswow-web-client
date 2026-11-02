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
import { createWmoRoomFog, wmoRoomFogFor } from "../dist/code/browser/WmoRoomFog.js";
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
  assert.match(method, /if \(!wmoRoomFogFor\(candidate\.fog, this\.#underwater, room\)\) return;/);
  const gate = method.indexOf("if (!renderSwitches.wmoRoomFogOnScene) return;");
  const write = method.indexOf("const scene = this.#scene.fog as THREE.Fog;");
  assert.ok(gate > 0 && write > gate);
  assert.match(method, /scene\.near = room\.near;\r?\n\s+scene\.far = room\.far;\r?\n\s+this\.#wmoRoomFogApplied = true;/);
  // The zone's fog comes back at the top of every submission, before the room is looked for.
  assert.match(source, /this\.#wmoFogCandidate = undefined;\r?\n\s+this\.#wmoFloor = undefined;\r?\n\s+this\.#wmoFogVisualId = undefined;\r?\n\s+this\.#restoreZoneFog\(\);/);
  assert.match(source, /if \(atmosphere\.haze > 0 && !this\.#underwater && !this\.#wmoRoomFogApplied\) applyPrecipitationHaze\(/,
    "no rain veil pulled over a room's fog");
  assert.match(source, /if \(this\.#wmoRoomFogApplied && this\.#underwater\) \{\r?\n\s+uniforms\.tint\.value\.set\(this\.#wmoRoomFog\.r, this\.#wmoRoomFog\.g, this\.#wmoRoomFog\.b, frame\.fogStrength\);/,
    "the underwater overlay takes the authored water colour");
});
