import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const { auditWmoMonr } = await import("../tools/audit-wmo-monr.mjs");

const PREFIX = "World\\wmo\\Audit";

function chunk(tag, payload) {
  const header = Buffer.alloc(8);
  header.write([...tag].reverse().join(""), 0, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function vectorBuffer(values) {
  const result = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => result.writeFloatLE(value, index * 4));
  return result;
}

function group({ positions, normals, indices = [0, 1, 2], malformedNested = false, duplicateMotv = false }) {
  const header = Buffer.alloc(68);
  const parts = [header, chunk("MOVT", vectorBuffer(positions))];
  if (normals !== undefined) parts.push(chunk("MONR", vectorBuffer(normals)));
  parts.push(chunk("MOVI", Buffer.from(indices.flatMap((index) => [index & 0xff, index >> 8]))));
  if (duplicateMotv) parts.push(chunk("MOTV", Buffer.alloc(0)), chunk("MOTV", Buffer.alloc(0)));
  const nested = Buffer.concat(parts);
  return chunk("MOGP", malformedNested ? Buffer.concat([nested, Buffer.from([0x01])]) : nested);
}

const exact = group({
  positions: [0, 0, 0, 1, 0, 0, 0, 0, 0],
  normals: [0, 0, 1, 0, 1, 0, 0, 1, 0],
  duplicateMotv: true,
});
const nonUnit = group({
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  normals: [0, 0, 2, 0, 0, 1, 0, 1, 0],
});
const missing = group({
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
});
const malformed = group({
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  normals: [0, 0, 1],
});
const nonfinite = group({
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  normals: [Number.NaN, 0, 1, 0, 0, 1, 0, 1, 0],
});
const broken = group({
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 1, 0],
  malformedNested: true,
});

const canonical = (path) => String(path).replaceAll("/", "\\").toLowerCase();
const paths = [
  `${PREFIX}\\A_000.wmo`, `${PREFIX}\\B_001.wmo`, `${PREFIX}\\C_000.wmo`,
  `${PREFIX}\\D_000.wmo`, `${PREFIX}\\E_000.wmo`, `${PREFIX}\\F_000.wmo`,
  `${PREFIX}\\G_000.wmo`, `${PREFIX}.wmo`, `${PREFIX}\\not-a-group.wmo`,
];
const data = new Map([
  [canonical(paths[0]), exact], [canonical(paths[1]), nonUnit], [canonical(paths[2]), missing],
  [canonical(paths[3]), malformed], [canonical(paths[4]), nonfinite], [canonical(paths[5]), broken],
]);

function makeArchives(reverse = false) {
  const calls = [];
  let closed = false;
  return {
    calls,
    get closed() { return closed; },
    async list(prefix) {
      calls.push(["list", prefix]);
      return reverse ? [...paths].reverse() : paths;
    },
    async read(path) {
      calls.push(["read", path]);
      return data.get(canonical(path));
    },
    close() { closed = true; },
  };
}

test("strictly audits nested MOGP MOVT/MONR/MOVI and reports hard-edge evidence", async () => {
  const archives = makeArchives();
  const result = await auditWmoMonr({ archives, prefix: "World/wmo/" });
  assert.equal(result.counts.listedGroups, 7);
  assert.equal(result.counts.readGroups, 6);
  assert.equal(result.counts.geometryValidGroups, 5);
  assert.equal(result.counts.validGroups, 2);
  assert.equal(result.counts.vertexTotal, 15);
  assert.equal(result.counts.indexTotal, 15);
  assert.deepEqual({
    missing: result.counts.monrMissing,
    exact: result.counts.monrExact,
    malformed: result.counts.monrMalformed,
    nonfinite: result.counts.monrNonfinite,
  }, { missing: 1, exact: 2, malformed: 1, nonfinite: 1 });
  assert.equal(result.counts.monrUnread, 1);
  assert.equal(result.counts.monrParseError, 1);
  assert.equal(result.counts.normalizedNormals, 5);
  assert.equal(result.counts.nonUnitNormals, 1);
  assert.equal(result.counts.duplicatePositionGroups, 1);
  assert.equal(result.counts.duplicatePositionClusters, 1);
  assert.equal(result.counts.duplicatePositionVertices, 2);
  assert.equal(result.counts.divergentNormalGroups, 1);
  assert.equal(result.counts.divergentNormalClusters, 1);
  assert.equal(result.counts.divergentNormalVertices, 2);
  assert.equal(result.diagnostics.readMissing, 1);
  assert.equal(result.diagnostics.parseErrorCount, 1);
  assert.deepEqual(result.groups.find((row) => row.path.endsWith("d_000.wmo"))?.monrStatus, "malformed");
  assert.deepEqual(result.groups.find((row) => row.path.endsWith("e_000.wmo"))?.monrStatus, "nonfinite");
  assert.equal(result.groups.find((row) => row.path.endsWith("a_000.wmo"))?.valid, true);
  assert.equal(result.groups.find((row) => row.path.endsWith("f_000.wmo"))?.monrStatus, "parse-error");
  assert.deepEqual(archives.calls[0], ["list", ""]);
  assert.equal(archives.calls.filter(([kind]) => kind === "list").length, 1);
  assert.equal(archives.closed, false);
});

test("listing order and aliases cannot change the group digest or aggregate", async () => {
  const forward = await auditWmoMonr({ archives: makeArchives(false), prefix: "World\\wmo" });
  const reverse = await auditWmoMonr({ archives: makeArchives(true), prefix: "WORLD\\WMO\\" });
  assert.equal(reverse.digest, forward.digest);
  assert.deepEqual(reverse.counts, forward.counts);
  assert.deepEqual(reverse.groups, forward.groups);
});

test("source stays offline and does not import runtime renderer or close archives", async () => {
  const source = await readFile(new URL("../tools/audit-wmo-monr.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /WorldRenderer3D|RenderAdmission|EnvironmentClient|BuiltModelCache|ResourceCache/);
  assert.match(source, /auditWmoMonr/);
  assert.match(source, /archives\.list\(""\)/);
});
