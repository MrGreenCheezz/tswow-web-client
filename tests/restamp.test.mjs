import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DatasetFingerprint } from "../dist/code/gateway/DatasetFingerprint.js";
import { repositoryRoot } from "../tools/paths.mjs";
import { stampSidecar } from "../tools/source-stamp.mjs";

const encoder = new TextEncoder();
/** `ItemDisplayInfo` in 3.3.5: id, ModelName[2], ModelTexture[2], InventoryIcon[2], … — 25 fields. */
const ITEM_DISPLAY_FIELDS = 25;
const INVENTORY_ICON = 5;

function stringBlock(values) {
  const offsets = new Map();
  const bytes = [0];
  for (const value of values) {
    offsets.set(value, bytes.length);
    bytes.push(...encoder.encode(value), 0);
  }
  return { bytes: Uint8Array.from(bytes), offsets };
}

function dbcFixture(fields, rows, strings) {
  const result = new Uint8Array(20 + rows.length * fields * 4 + strings.byteLength);
  result.set(encoder.encode("WDBC"));
  const view = new DataView(result.buffer);
  view.setUint32(4, rows.length, true);
  view.setUint32(8, fields, true);
  view.setUint32(12, fields * 4, true);
  view.setUint32(16, strings.byteLength, true);
  for (let row = 0; row < rows.length; row++) {
    for (let field = 0; field < fields; field++) view.setUint32(20 + (row * fields + field) * 4, rows[row][field] ?? 0, true);
  }
  result.set(strings, 20 + rows.length * fields * 4);
  return result;
}

/** A 2x2 palette BLP2, which is the smallest thing `tools/blp.mjs` will decode. */
function blp(first = [10, 20, 30, 255]) {
  const header = Buffer.alloc(148 + 1024);
  header.write("BLP2", 0, "latin1");
  header.writeUInt32LE(1, 4);
  header[8] = 1;
  header[11] = 1;
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(2, 16);
  header.writeUInt32LE(148 + 1024, 20);
  header.writeUInt32LE(4, 84);
  for (const [index, entry] of [first, [200, 100, 50, 255]].entries()) {
    for (let channel = 0; channel < 4; channel++) header[148 + index * 4 + channel] = entry[channel];
  }
  return Buffer.concat([header, Buffer.from([0, 1, 1, 0])]);
}

/**
 * A machine with one custom item icon in it: a module's loose patch directory holding the picture,
 * a dataset naming it, and empty cache directories for every family the pass walks.
 *
 * Every family's directory is given explicitly and not left to default. The pass resolves them
 * against the repository root, and a developer running this in a tree that has a real `data/`
 * would otherwise have the test write sidecars all over the published cache.
 */
async function machine() {
  const client = await mkdtemp(join(tmpdir(), "webclient-restamp-client-"));
  const dbc = await mkdtemp(join(tmpdir(), "webclient-restamp-dbc-"));
  const cache = await mkdtemp(join(tmpdir(), "webclient-restamp-cache-"));
  const icon = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", "Interface", "Icons", "Custom_Fire.blp");
  await mkdir(join(icon, ".."), { recursive: true });
  await writeFile(icon, blp());

  // Two displays over one picture, which is the shape of the real table — 21,071 published item
  // icons stand over far fewer BLPs — and the shape that catches a reverse index built once per
  // entry instead of once: the pass has thirty-two entries in flight, so an index guarded by "is
  // it empty yet" is built by all of them and read by all of them while it is still empty.
  const strings = stringBlock(["Custom_Fire"]);
  const rows = [70000, 70001].map((displayId) => {
    const row = Array(ITEM_DISPLAY_FIELDS).fill(0);
    row[0] = displayId;
    row[INVENTORY_ICON] = strings.offsets.get("Custom_Fire");
    return row;
  });
  await writeFile(join(dbc, "ItemDisplayInfo.dbc"), dbcFixture(ITEM_DISPLAY_FIELDS, rows, strings.bytes));

  const families = {};
  for (const [variable, name] of Object.entries({
    ITEM_ICON_DIR: "item-icons", MINIMAP_DIR: "minimap", HORIZON_DIR: "horizon", LIQUID_DIR: "liquid",
    SOUND_DIR: "sound", TERRAIN_TEXTURE_DIR: "terrain-textures", TERRAIN_LAYER_DIR: "terrain-layers",
    VISUAL_TILE_DIR: "visual-tiles", TEXTURE_DIR: "textures", VISUAL_MODEL_DIR: "visual-models",
  })) {
    families[variable] = join(cache, name);
    await mkdir(families[variable], { recursive: true });
  }
  return {
    client, dbc, cache, icon,
    env: { ...process.env, CLIENT_DIR: client, DBC_DIR: dbc, ...families },
    directory: (variable) => families[variable],
  };
}

async function removeMachine({ client, dbc, cache }) {
  for (const directory of [client, dbc, cache]) await rm(directory, { recursive: true, force: true });
}

const restamp = (machineUnderTest, ...args) => promisify(execFile)(
  process.execPath,
  [resolve(repositoryRoot, "tools/restamp.mjs"), ...args],
  { cwd: repositoryRoot, env: machineUnderTest.env },
);

const publishIcon = (machineUnderTest, ...displayIds) => promisify(execFile)(
  process.execPath,
  [resolve(repositoryRoot, "tools/generate-item-icon.mjs"), ...displayIds.map(String)],
  { cwd: repositoryRoot, env: machineUnderTest.env },
);

test("the pass derives the stamp the generator would have written, without writing the picture", async () => {
  // The whole claim of `tools/restamp.mjs` in one test. A stamp does not need the picture: it
  // needs the source that won each input path and that file's size and mtime, and an item icon's
  // name is its display id, which `ItemDisplayInfo` reads straight back into the BLP it came from.
  // Measured over the published tree, with every generator-written sidecar hidden and the pass run
  // in its place: 21,637 stamps written and 0 of the 24,798 published files touched. Only 124 of
  // those had one of the generators' own to be held against — 1,153 entries carry a sidecar at all
  // and 1,029 of them are in the two families the pass cannot recover — and all 124 matched byte
  // for byte.
  const box = await machine();
  try {
    await publishIcon(box, 70000, 70001);
    const picture = join(box.directory("ITEM_ICON_DIR"), "70000.png");
    const written = await readFile(stampSidecar(picture));
    const bytes = await readFile(picture);
    const before = await stat(picture);

    // Which is exactly the state of everything published before stamps existed.
    await rm(stampSidecar(picture));
    await rm(stampSidecar(join(box.directory("ITEM_ICON_DIR"), "70001.png")));
    const { stderr } = await restamp(box);
    assert.match(stderr, /item-icons: 2 stamped/);

    assert.deepEqual(await readFile(stampSidecar(picture)), written,
      "the derived stamp has to read back as the one the generator wrote");
    assert.deepEqual(await readFile(picture), bytes, "and the picture is not touched");
    assert.equal((await stat(picture)).mtimeMs, before.mtimeMs, "not even rewritten with its own bytes");

    // Nothing left to do the second time: the pass is what the gateway starts at every startup.
    assert.match((await restamp(box)).stderr, /Stamped 0 published entries/);
  } finally {
    await removeMachine(box);
  }
});

test("a derived stamp is a stamp: the entry goes when the module replaces the picture behind it", async () => {
  // A sidecar that reads correctly and does not work is worse than none at all, so the derived one
  // is put to the only use a stamp has. `DatasetFingerprint` has never seen this entry generated.
  const box = await machine();
  try {
    await publishIcon(box, 70000);
    const picture = join(box.directory("ITEM_ICON_DIR"), "70000.png");
    await rm(stampSidecar(picture));
    await restamp(box);

    const fingerprint = new DatasetFingerprint({ dbcDirectory: box.dbc, clientDirectory: box.client, intervalMs: 0 });
    await fingerprint.poll();
    await fingerprint.ensureCurrent(picture);
    await assert.doesNotReject(access(picture), "an entry whose source is untouched stays");

    // The module ships a different picture under the same path — same name, same display id, and
    // the id is all the cache is keyed on.
    const stats = await stat(box.icon);
    await writeFile(box.icon, blp([90, 90, 90, 255]));
    await utimes(box.icon, stats.atime, new Date(stats.mtimeMs + 1_000));
    await fingerprint.poll();
    await fingerprint.ensureCurrent(picture);
    await assert.rejects(access(picture), "and one built from a file that has moved has to go");
  } finally {
    await removeMachine(box);
  }
});

test("an entry whose name cannot name its inputs is counted and left alone", async () => {
  // `data/textures` and `data/visual-models` are keyed on sha1 of a path, and nothing on disk
  // holds the path that was hashed: 836 and 670 of them here. Guessing at a stamp for one would
  // be worse than leaving it unwatched — the gateway drops an entry whose stamp disagrees, and a
  // wrong stamp is a picture deleted for no reason.
  const box = await machine();
  try {
    const id = createHash("sha1").update("texture-v1\0tileset\\test.blp").digest("hex");
    const texture = join(box.directory("TEXTURE_DIR"), `${id}.png`);
    await writeFile(texture, "PNG-from-before-stamps-existed");

    const { stderr } = await restamp(box);
    assert.match(stderr, /textures: 0 stamped, 1 unrecoverable/);
    assert.match(stderr, /1 whose names do not name their inputs/);
    assert.equal(await readFile(texture, "utf8"), "PNG-from-before-stamps-existed");
    await assert.rejects(access(stampSidecar(texture)), "and no stamp is invented for it");
  } finally {
    await removeMachine(box);
  }
});

test("a sidecar torn in half is written again, not skipped because a file of that name is there", async () => {
  // `writeSourceStamp` is a plain `writeFile`, and the gateway starts this pass in the background
  // at every startup while it is serving that same directory — a crash, a full disk or a machine
  // losing power in the middle of one of tens of thousands of them leaves a sidecar that parses as
  // nothing. `ensureCurrent` reads that as "no stamp" and serves the entry as it stands, which is
  // right; what it also used to do was rebuild the entry, which is what repaired the sidecar, and
  // Д0б took that away. So a pass that trusted the mere existence of the file would leave a torn
  // stamp torn for the life of the cache, and the entry unwatched behind it.
  const box = await machine();
  try {
    await publishIcon(box, 70000);
    const picture = join(box.directory("ITEM_ICON_DIR"), "70000.png");
    const written = await readFile(stampSidecar(picture), "utf8");
    await writeFile(stampSidecar(picture), written.slice(0, Math.floor(written.length / 2)));

    const { stderr } = await restamp(box);
    assert.match(stderr, /item-icons: 1 stamped/);
    assert.equal(await readFile(stampSidecar(picture), "utf8"), written, "and the whole stamp is what lands");

    // And a sidecar that reads is still left alone: the check is "does this parse", not "rewrite
    // everything every startup".
    assert.match((await restamp(box)).stderr, /Stamped 0 published entries/);
  } finally {
    await removeMachine(box);
  }
});

test("the pass writes nothing at all when it is only asked what it would do", async () => {
  // `--dry-run` is how the same numbers were taken against the real tree without touching it.
  const box = await machine();
  try {
    await publishIcon(box, 70000);
    const picture = join(box.directory("ITEM_ICON_DIR"), "70000.png");
    await rm(stampSidecar(picture));

    const { stderr } = await restamp(box, "--dry-run");
    assert.match(stderr, /item-icons: 1 stamped/);
    assert.match(stderr, /dry run: nothing was written/);
    await assert.rejects(access(stampSidecar(picture)), "a dry run that writes a sidecar is not one");
  } finally {
    await removeMachine(box);
  }
});
