import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBarberStyles } from "../dist/code/gateway/BarberMetadata.js";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { dbcDirectory } from "../tools/paths.mjs";

const FIELDS = 40;
const RECORD_SIZE = FIELDS * 4;

async function writeStyles(directory, rows, names = []) {
  const strings = [0];
  const offsets = [];
  for (const name of names) {
    offsets.push(strings.length);
    for (const byte of Buffer.from(name, "utf8")) strings.push(byte);
    strings.push(0);
  }
  const stringBlock = Buffer.from(strings);
  const data = Buffer.alloc(20 + rows.length * RECORD_SIZE + stringBlock.length);
  data.write("WDBC");
  data.writeUInt32LE(rows.length, 4);
  data.writeUInt32LE(FIELDS, 8);
  data.writeUInt32LE(RECORD_SIZE, 12);
  data.writeUInt32LE(stringBlock.length, 16);
  for (let row = 0; row < rows.length; row++) {
    for (const [field, value] of Object.entries(rows[row])) {
      data.writeUInt32LE(value, 20 + row * RECORD_SIZE + Number(field) * 4);
    }
  }
  stringBlock.copy(data, 20 + rows.length * RECORD_SIZE);
  await writeFile(join(directory, "BarberShopStyle.dbc"), data);
  return offsets;
}

test("barber styles expose only the columns HandleAlterAppearance reads, with ruRU names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "barber-dbc-"));
  try {
    // Row 1: human male hair, ruRU name at locale slot 8; row 2: enUS fallback only.
    const [ru, en] = await writeStyles(directory, [
      { 0: 63, 1: 0, 10: 999, 37: 1, 38: 0, 39: 0 },
      { 0: 64, 1: 0, 2: 999, 37: 1, 38: 0, 39: 1 },
      { 0: 85, 1: 2, 10: 999, 37: 1, 38: 0, 39: 0 },
      { 0: 99, 1: 1, 37: 1, 38: 0, 39: 0 },
      { 0: 0, 1: 0, 37: 1, 38: 0, 39: 5 },
    ], ["Лысая", "Peasant"]);
    // Patch the enUS slot of row 2 (field 2) to the second string.
    const { readFile } = await import("node:fs/promises");
    const path = join(directory, "BarberShopStyle.dbc");
    const data = await readFile(path);
    data.writeUInt32LE(en, 20 + 1 * RECORD_SIZE + 2 * 4);
    data.writeUInt32LE(ru, 20 + 0 * RECORD_SIZE + (2 + 8) * 4);
    data.writeUInt32LE(ru, 20 + 2 * RECORD_SIZE + (2 + 8) * 4);
    await writeFile(path, data);

    const catalog = await loadBarberStyles(directory);
    assert.deepEqual(catalog, {
      styles: [
        // Sorted by type, then data: hair rows first.
        { id: 63, type: 0, race: 1, sex: 0, data: 0, name: "Лысая" },
        { id: 64, type: 0, race: 1, sex: 0, data: 1, name: "Peasant" },
        { id: 85, type: 2, race: 1, sex: 0, data: 0, name: "Лысая" },
        // Type 1 is not a style the core reads: skipped, as is the zero id.
      ],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("barber styles reject a non-3.3.5 header and duplicate ids", async () => {
  const directory = await mkdtemp(join(tmpdir(), "barber-bad-dbc-"));
  try {
    await writeStyles(directory, [{ 0: 1 }]);
    const { readFile } = await import("node:fs/promises");
    const path = join(directory, "BarberShopStyle.dbc");
    const data = await readFile(path);
    data.writeUInt32LE(39, 8);
    await writeFile(path, data);
    await assert.rejects(loadBarberStyles(directory), /40 fields of 160 bytes/);

    await writeStyles(directory, [{ 0: 7, 1: 0 }, { 0: 7, 1: 0 }]);
    await assert.rejects(loadBarberStyles(directory), /duplicate style id 7/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the dataset's BarberShopStyle table loads with valid types and localized names", async () => {
  let directory;
  try {
    directory = dbcDirectory();
  } catch {
    return;
  }
  const catalog = await loadBarberStyles(directory);
  assert.ok(catalog.styles.length > 100, "the table is not empty");
  for (const style of catalog.styles) {
    assert.ok([0, 2, 3].includes(style.type), `type ${style.type} is one the core reads`);
    assert.ok(style.id > 0 && style.data >= 0);
    assert.ok(style.name.length > 0);
  }
  // Every playable race/sex from the audit has hair and facial rows, tauren also skin.
  for (const [race, sex] of [[1, 0], [1, 1], [6, 0], [6, 1]]) {
    assert.ok(catalog.styles.some((style) => style.type === 0 && style.race === race && style.sex === sex),
      `hair rows for race ${race} sex ${sex}`);
    assert.ok(catalog.styles.some((style) => style.type === 2 && style.race === race && style.sex === sex),
      `facial rows for race ${race} sex ${sex}`);
  }
  assert.ok(catalog.styles.some((style) => style.type === 3), "skin rows exist (tauren)");
});

test("barber styles are origin-protected, versioned and served from the active dataset", async () => {
  const origin = "http://127.0.0.1:5173";
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [origin],
    dbcDirectory: dbcDirectory(),
    datasetPollMs: 0,
  });
  const base = `http://127.0.0.1:${gateway.port}/dbc/barber-styles`;
  try {
    assert.equal((await fetch(`${base}?v=1`)).status, 403);
    assert.equal((await fetch(`${base}?v=2`, { headers: { origin } })).status, 400);
    const first = await fetch(`${base}?v=1`, { headers: { origin } });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("access-control-allow-origin"), origin);
    const body = await first.json();
    assert.ok(Array.isArray(body.styles) && body.styles.length > 100);
    for (const style of body.styles) {
      assert.ok(style.id > 0 && [0, 2, 3].includes(style.type));
      assert.ok(typeof style.name === "string" && style.name.length > 0);
    }
    assert.deepEqual(await (await fetch(`${base}?v=1`, { headers: { origin } })).json(), body);
  } finally {
    await gateway.close();
  }
});
