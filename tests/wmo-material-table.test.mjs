// 05.10-A7b-3 (7.11 P2/P4): the MOMT material table and MOSB in a `visual-wmo-v25` artifact (WME5),
// the run's MOMT ordinal, and the old (WME4/WME3-only) artifacts that must keep decoding.
import assert from "node:assert/strict";
import test from "node:test";
import { parseWmoVisual, wmoGroupMeshes, wmoMaterialTable } from "../tools/wmo-visual.mjs";
import { WWM_MATERIALS_MAGIC, encodeWwm, encodeWwmGroup } from "../tools/wwm.mjs";
import { decodeWwm, decodeWwmGroup } from "../dist/code/browser/WmoModel.js";
import { WMO_SHADER_ENV_METAL, wmoRunMaterial } from "../dist/code/browser/WmoMaterials.js";

function chunk(tag, payload) {
  const header = Buffer.alloc(8);
  header.write([...tag].reverse().join(""), 0, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const NAMES = Buffer.from("World\\Textures\\Wall.blp\0World\\Textures\\Env.blp\0");
const WALL = 0;
const ENV = NAMES.indexOf("World\\Textures\\Env.blp");

/**
 * Three MOMT records over one MOTX: 0 and 1 share the wall texture, blend and flags but differ in
 * shader and colours (the case the old texture-keyed runs merged); 2 is a window (0x10 SIDN).
 */
function momt(records = undefined) { // 05.10-A7b-3-review: `records` — a fixture's own three records
  const data = Buffer.alloc(64 * 3);
  const record = (index, fields) => {
    const at = index * 64;
    data.writeUInt32LE(fields.flags ?? 0, at);
    data.writeUInt32LE(fields.shader ?? 0, at + 4);
    data.writeUInt32LE(fields.blend ?? 0, at + 8);
    data.writeUInt32LE(fields.texture ?? WALL, at + 12);
    // CImVector, stored BGRA.
    const bgra = (offset, [r, g, b, a]) => { data[at + offset] = b; data[at + offset + 1] = g; data[at + offset + 2] = r; data[at + offset + 3] = a; };
    if (fields.sidn) bgra(16, fields.sidn);
    if (fields.frame) bgra(20, fields.frame);
    data.writeUInt32LE(fields.texture2 ?? 0, at + 24);
    if (fields.diff) bgra(28, fields.diff);
    data.writeUInt32LE(fields.ground ?? 0, at + 32);
    data.writeUInt32LE(fields.texture3 ?? 0, at + 36);
    if (fields.colour2) bgra(40, fields.colour2);
    data.writeUInt32LE(fields.flags2 ?? 0, at + 44);
  };
  if (records) { // 05.10-A7b-3-review
    records.forEach((fields, index) => record(index, fields));
    return data;
  }
  record(0, { shader: 0, diff: [10, 20, 30, 40], ground: 4, texture2: 0x4fff });
  record(1, { shader: 5, texture2: ENV, diff: [1, 2, 3, 4], colour2: [5, 6, 7, 8], ground: 2 });
  record(2, { flags: 0x10 | 0x40, shader: 1, blend: 1, sidn: [255, 200, 100, 255], texture2: ENV + 3 });
  return data;
}

function root({ groupCount = 1, mosb, records } = {}) { // 05.10-A7b-3-review: records
  const header = Buffer.alloc(64);
  header.writeUInt32LE(groupCount, 4);
  return Buffer.concat([
    chunk("MOHD", header), chunk("MOTX", NAMES), chunk("MOMT", momt(records)),
    ...(mosb === undefined ? [] : [chunk("MOSB", Buffer.from(`${mosb}\0\0\0`, "latin1"))]),
  ]);
}

/** One group: six triangles in three batches, one per material; `flags` decide indoor/outdoor. */
function group(flags = 0x2000) {
  const vertices = Buffer.alloc(48);
  [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0].forEach((value, index) => vertices.writeFloatLE(value, index * 4));
  const indices = Buffer.alloc(6 * 6);
  [0, 1, 2, 1, 3, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3, 0, 3, 1].forEach((value, index) => indices.writeUInt16LE(value, index * 2));
  const header = Buffer.alloc(68);
  header.writeUInt32LE(flags, 8);
  [-1, -2, -3, 4, 5, 6].forEach((value, index) => header.writeFloatLE(value, 12 + index * 4));
  header.writeUInt16LE(3, 0x2a); // three interior batches
  const batches = Buffer.alloc(3 * 24);
  for (const [index, [first, count, material]] of [[0, 2, 0], [2, 2, 1], [4, 2, 2]].entries()) {
    batches.writeUInt32LE(first * 3, index * 24 + 12);
    batches.writeUInt16LE(count * 3, index * 24 + 16);
    batches.writeUInt8(material, index * 24 + 23);
  }
  return chunk("MOGP", Buffer.concat([header, chunk("MOVT", vertices), chunk("MOTV", Buffer.alloc(32)),
    chunk("MOVI", indices), chunk("MOBA", batches)]));
}

function build({ materialTable, groups = [group()], mosb, records } = {}) { // 05.10-A7b-3-review: records
  const parsed = parseWmoVisual(root({ groupCount: groups.length, mosb, records }), groups, "World\\wmo\\House.wmo",
    materialTable === undefined ? {} : { materialTable });
  return wmoGroupMeshes(parsed, materialTable === undefined ? undefined : { materialTable });
}

const urls = (meshes) => meshes.textures.map((_, index) => `/visual/texture/x-${index}.png`);
const arrayBuffer = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

test("MOMT: shader, colours (BGRA→RGBA), ground type and the second texture only where MOTX names a .blp", () => {
  const table = wmoMaterialTable(momt(), NAMES);
  assert.equal(table.length, 3);
  assert.deepEqual(table.map((material) => material.shader), [0, 5, 1]);
  assert.deepEqual(table.map((material) => material.blendMode), [0, 0, 1]);
  assert.deepEqual(table.map((material) => material.flags), [0, 0, 0x50]);
  assert.deepEqual(table[2].sidnColour, [255, 200, 100, 255]);
  assert.deepEqual(table[0].diffColour, [10, 20, 30, 40]);
  assert.deepEqual(table[1].colour2, [5, 6, 7, 8]);
  assert.deepEqual(table.map((material) => material.groundType), [4, 2, 0]);
  // 0x4fff is past MOTX and ENV+3 is mid-string: neither names a texture (23,477 of the client's
  // 25,034 records carry such a word, the Diffuse ones almost all of them).
  assert.deepEqual(table.map((material) => material.texture2), ["", "World\\Textures\\Env.blp", ""]);
});

test("v25 runs: two MOMT records sharing a texture are two runs, each naming its record", () => {
  const meshes = build({ materialTable: true });
  const runs = meshes.groups[0].runs;
  assert.deepEqual(runs.map((run) => run.materialIndex), [0, 1, 2]);
  assert.deepEqual(runs.map((run) => run.material), [0, 0, 0]); // still the artifact texture index
  assert.equal(meshes.materialTable.length, 3);
});

test("without the option (a visual-wmo-v22 job) runs merge by texture as before and carry no record", () => {
  const meshes = build();
  const runs = meshes.groups[0].runs;
  // Records 0 and 1: same texture, blend 0, flags 0, interior → one run, exactly the v22 shape.
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((run) => run.materialIndex), [undefined, undefined]);
  assert.equal(meshes.materialTable, undefined);
  assert.equal(meshes.skybox, undefined);
});

test("a v22 artifact is unchanged: no WME5 and a zero reserved word in every run", () => {
  const meshes = build();
  const data = encodeWwm(meshes, urls(meshes));
  assert.equal(data.indexOf(Buffer.from(WWM_MATERIALS_MAGIC)), -1);
  const model = decodeWwm(arrayBuffer(data), "http://gateway");
  assert.equal(model.materials, undefined);
  assert.equal(model.skybox, undefined);
  for (const run of model.groups[0].mesh.runs) assert.equal(run.materialIndex, undefined);
});

test("WME5 round trip after WME4 (a building of rooms alone): table, run records, MOSB, rooms intact", () => {
  const meshes = build({ materialTable: true, mosb: "ENVIRONMENTS\\STARS\\CAVERNSOFTIMESKY.MDX" });
  const data = encodeWwm(meshes, urls(meshes));
  assert.ok(data.indexOf(Buffer.from("WME4")) > 0, "the interior-only model carries WME4");
  assert.ok(data.indexOf(Buffer.from(WWM_MATERIALS_MAGIC)) > data.indexOf(Buffer.from("WME4")));
  const model = decodeWwm(arrayBuffer(data), "http://gateway");
  assert.equal(model.materials.length, 3);
  assert.equal(model.skybox, "ENVIRONMENTS\\STARS\\CAVERNSOFTIMESKY.MDX");
  const runs = model.groups[0].mesh.runs;
  assert.deepEqual(runs.map((run) => run.materialIndex), [0, 1, 2]);
  const env = wmoRunMaterial(model, runs[1]);
  assert.equal(env?.shader, WMO_SHADER_ENV_METAL);
  assert.equal(env?.texture2, "World\\Textures\\Env.blp");
  assert.deepEqual(env?.colour2, [5, 6, 7, 8]);
  assert.deepEqual(wmoRunMaterial(model, runs[2])?.sidnColour, [255, 200, 100, 255]);
  assert.equal(wmoRunMaterial(model, runs[2])?.flags, 0x50);
  assert.equal(model.doodadRooms.length, 0); // the house has no MODS, so WME4 holds no sets
});

test("WME5 straight after WME3 (a building with a street, no WME4)", () => {
  const meshes = build({ materialTable: true, groups: [group(0x8)] });
  const data = encodeWwm(meshes, urls(meshes));
  assert.equal(data.indexOf(Buffer.from("WME4")), -1);
  const model = decodeWwm(arrayBuffer(data), "http://gateway");
  assert.deepEqual(model.materials.map((material) => material.shader), [0, 5, 1]);
  assert.equal(model.skybox, undefined);
});

test("a group block on its own (a city's room file) carries its runs' records too", () => {
  const meshes = build({ materialTable: true });
  const block = decodeWwmGroup(arrayBuffer(encodeWwmGroup(meshes.groups[0], 0)));
  assert.deepEqual(block.mesh.runs.map((run) => run.materialIndex), [0, 1, 2]);
});

test("a damaged WME5 drops the table, never the geometry; a record past the table answers nothing", () => {
  const meshes = build({ materialTable: true });
  const data = encodeWwm(meshes, urls(meshes));
  const at = data.indexOf(Buffer.from(WWM_MATERIALS_MAGIC));
  const broken = Buffer.from(data);
  broken.writeUInt32LE(0xffff, at + 4); // material count past the section
  const model = decodeWwm(arrayBuffer(broken), "http://gateway");
  assert.equal(model.materials, undefined);
  assert.equal(model.groups[0].mesh.runs.length, 3);
  assert.equal(wmoRunMaterial(model, model.groups[0].mesh.runs[0]), undefined);
  const healthy = decodeWwm(arrayBuffer(data), "http://gateway");
  assert.equal(wmoRunMaterial(healthy, { materialIndex: 7 }), undefined);
  assert.equal(wmoRunMaterial(healthy, {}), undefined);
});

// 05.10-A7b-3-review: of the client's MapObj pixel effects only Env, EnvMetal and Composite sample
// texture[1] — in all 16 ARB programs of each (`.runtime/re-2026-10-05/A7b-3-review/probe-bls-tex1.out.txt`).
// A Diffuse/Opaque/Specular/Metal record's second word that happens to start a `.blp` name (264 of
// the client's records, "Metal" 191 — 05.10 review A7b-2: those 191 are Env, shader 3, see the last
// test) is kept in the table verbatim but must not split the runs.
test("v25 runs: a second texture splits runs only for the effects that sample it", () => {
  const meshes = build({
    materialTable: true,
    records: [
      { shader: 0, texture2: 0x4fff },
      { shader: 0, texture2: ENV }, // a Diffuse word that lands on a name: drawn exactly like record 0
      { shader: 5, texture2: ENV },
    ],
  });
  assert.deepEqual(meshes.materialTable.map((material) => material.texture2), ["", "World\\Textures\\Env.blp", "World\\Textures\\Env.blp"]);
  assert.deepEqual(meshes.groups[0].runs.map((run) => run.materialIndex), [0, 2]);
});

// 05.10 review A7b-2 (7.11): the shader ids are Wow.exe's program table — 1 Specular, 2 Metal, 3 Env,
// 4 Opaque, 5 EnvMetal, 6 Composite (`WmoMaterials.ts`). Env is 3, so 3 splits on its second texture
// (191 of the client's 192 shader-3 records name one) and 4 (Opaque, no record) does not.
test("v25 runs: Env (3) splits on its environment texture, Metal (2) and Opaque (4) do not", () => {
  const runs = (shader) => build({
    materialTable: true,
    records: [{ shader, texture2: 0x4fff }, { shader, texture2: ENV }, { shader: 0 }],
  }).groups[0].runs.map((run) => run.materialIndex);
  assert.deepEqual(runs(3), [0, 1, 2], "two Env records on one wall texture, two environment maps");
  assert.deepEqual(runs(2), [0, 2], "Metal never samples texture 1");
  assert.deepEqual(runs(4), [0, 2], "Opaque never samples texture 1");
});
