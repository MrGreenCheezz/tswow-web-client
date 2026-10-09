// 06.10-doodad-light — owner, 06.10, Goldshire inn «Гордость льва»: warm walls, but every piece of
// furniture blue/teal, and «мебель любит менять цвет». The instanced bucket of room-lit WMO doodads
// stored the MODD light bytes through three's normalized `setXYZ`, which expects 0…1 and stores
// round(v * 255) into a Uint8Array — 256 - v per channel. Real bytes from the inn below.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { writeInstancedLocalLight } from "../dist/code/browser/InstancedLocalLight.js";

let archives;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
} catch {
  archives = undefined;
}
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };
const innPath = ["World", "wmo", "Azeroth", "Buildings", "GoldshireInn", "GoldshireInn.wmo"]
  .join(String.fromCharCode(92));

async function innRoomLights() {
  const { parseWmoDoodadSets, wmoDependencies } = await import("../tools/wmo-visual.mjs");
  const root = await archives.read(innPath);
  assert.ok(root, "the Goldshire inn is in the client");
  const groups = [];
  for (const path of wmoDependencies(root, innPath).groups) groups.push(await archives.read(path));
  return parseWmoDoodadSets(root, groups, { effective: true })[0].filter((doodad) => doodad.localLight);
}

function decoded(attribute, index) {
  return [attribute.getX(index), attribute.getY(index), attribute.getZ(index)].map((value) => Math.round(value * 255));
}

test("the Goldshire inn's room-lit furniture keeps its warm MODD light in the instanced bucket", withClient, async () => {
  const lit = await innRoomLights();
  assert.ok(lit.length >= 80, `the inn's set 0 is room-lit furniture (${lit.length})`);
  // MODD 73, GENERALBOOKSTACKTALL01 — BGRA 51,76,106 on disk, RGBA 106,76,51 on the wire: brown.
  const books = lit.find((doodad) => doodad.index === 73);
  assert.equal(books?.name.split(String.fromCharCode(92)).pop(), "GENERALBOOKSTACKTALL01.m2");
  assert.deepEqual(books.localLight, [106, 76, 51, 255]);

  // The renderer's bucket: a normalized byte attribute, one RGB triple per copy.
  const attribute = new THREE.InstancedBufferAttribute(new Uint8Array(lit.length * 3), 3, true);
  lit.forEach((doodad, index) => writeInstancedLocalLight(attribute, index, doodad.localLight));
  lit.forEach((doodad, index) => {
    assert.deepEqual(decoded(attribute, index), doodad.localLight.slice(0, 3),
      `MODD ${doodad.index} reaches the shader as its own bytes`);
  });
  const warm = lit.filter((_, index) => { const [r, , b] = decoded(attribute, index); return r >= b; }).length;
  assert.ok(warm / lit.length > 0.8, `the inn is lit warm: ${warm}/${lit.length} copies with red >= blue`);

  // The defect, kept as evidence: normalized setXYZ turns the brown 106,76,51 into blue 150,180,205.
  const wrong = new THREE.InstancedBufferAttribute(new Uint8Array(3), 3, true);
  wrong.setXYZ(0, ...books.localLight.slice(0, 3));
  assert.deepEqual(decoded(wrong, 0), [150, 180, 205]);
});

test("the world renderer writes instanced local light as bytes, never through normalized setXYZ", () => {
  const renderer = readFileSync("src/browser/WorldRenderer3D.ts", "utf8");
  // Booleans, not assert.match: a failure must not print the whole renderer.
  assert.equal(/new THREE\.InstancedBufferAttribute\(new Uint8Array\(capacity \* 3\), 3, true\)/.test(renderer), true,
    "the bucket's attribute is the normalized byte attribute this writer is for");
  assert.equal(/writeInstancedLocalLight\(entry\.localLight\.attribute,\s*index,\s*localLight\)/.test(renderer), true,
    "each copy's MODD bytes go through the byte writer");
  assert.equal(/localLight\.attribute\.setXYZ\(/.test(renderer), false,
    "setXYZ on a normalized attribute rescales 0..255 bytes and inverts the colour");
});
