import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { prepareLocalPatchSnapshot, prepareLocalPatches } from "../tools/prepare-local-patches.mjs";
import { openClientArchives } from "../tools/mpq.mjs";
import { CLIENT_MEDIA_DBC_TABLES, PLAYABLE_CHARACTER_PROFILES } from "../tools/extract-visual-dbc-overlay.mjs";

function dbc(value) {
  const bytes = Buffer.alloc(25);
  bytes.write("WDBC"); bytes.writeUInt32LE(1, 4); bytes.writeUInt32LE(1, 8);
  bytes.writeUInt32LE(4, 12); bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(value, 20);
  return bytes;
}
async function put(path, bytes) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "local-patches-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { clientDirectory: join(root, "base"), dbcDirectory: join(root, "dbc"),
    patchRoot: join(root, "patches"), stateDirectory: join(root, "state") };
  await put(join(options.clientDirectory, "client-pack.json"), '{"testBase":1}');
  await put(join(options.clientDirectory, "Data", "patch-A.MPQ", "Textures", "base.blp"), "BASE");
  await put(join(options.clientDirectory, "Data", "patch-A.MPQ", "DBFilesClient", "Spell.dbc"), dbc(1));
  await put(join(options.dbcDirectory, "Spell.dbc"), dbc(1));
  await put(join(options.dbcDirectory, "Missing.dbc"), dbc(7));
  await mkdir(options.patchRoot);
  return { root, options };
}
async function readAsset(result, path) {
  const chain = await openClientArchives(result.clientDirectory);
  try { return await chain.read(path); } finally { chain.close(); }
}

test("local patches add assets and addons, follow letter/locale priority, and remove on next launch", async (t) => {
  const { options } = await fixture(t);
  await put(join(options.patchRoot, "patch-B.MPQ", "Textures", "base.blp"), "ROOT");
  await put(join(options.patchRoot, "ruRU", "patch-ruRU-B.MPQ", "Textures", "base.blp"), "LOCL");
  await put(join(options.patchRoot, "patch-C.MPQ", "Interface", "AddOns", "Example", "Example.toc"), "Example.lua\n");
  await put(join(options.patchRoot, "patch-C.MPQ", "Interface", "AddOns", "Example", "Example.lua"), "example = 42");
  await put(join(options.patchRoot, "patch-C.MPQ", "DBFilesClient", "Spell.dbc"), dbc(42));
  const active = await prepareLocalPatchSnapshot(options);
  assert.deepEqual(active.addons, [{ name: "example", loadOnDemand: false }]);
  assert.deepEqual((await prepareLocalPatchSnapshot(options)).addons, active.addons);
  assert.equal((await readAsset(active, "Textures\\base.blp")).toString(), "LOCL");
  assert.equal((await readAsset(active, "Interface\\AddOns\\Example\\Example.lua")).toString(), "example = 42");
  assert.equal((await readFile(join(active.dbcDirectory, "Spell.dbc"))).readUInt32LE(20), 42);
  assert.equal((await readFile(join(active.dbcDirectory, "Missing.dbc"))).readUInt32LE(20), 7);
  assert.equal((await readFile(join(options.dbcDirectory, "Spell.dbc"))).readUInt32LE(20), 1);
  assert.ok((await stat(join(options.clientDirectory, "Data", "patch-A.MPQ", "Textures", "base.blp"))).nlink >= 2);
  await rm(options.patchRoot, { recursive: true });
  await mkdir(options.patchRoot);
  assert.equal(await prepareLocalPatchSnapshot(options), undefined);
  assert.equal((await readAsset(active, "Textures\\base.blp")).toString(), "LOCL", "old session retains its captured patches");
});

test("same relative MPQ replacement excludes the whole base source without writing through hardlinks", async (t) => {
  const { options } = await fixture(t);
  await put(join(options.patchRoot, "patch-a.MPQ", "Textures", "new.blp"), "NEW!");
  const active = await prepareLocalPatchSnapshot(options);
  assert.equal(await readAsset(active, "Textures\\base.blp"), undefined);
  assert.equal((await readAsset(active, "Textures\\new.blp")).toString(), "NEW!");
  assert.equal((await readFile(join(options.clientDirectory, "Data", "patch-A.MPQ", "Textures", "base.blp"))).toString(), "BASE");
  assert.equal((await readFile(join(active.dbcDirectory, "Spell.dbc"))).readUInt32LE(20), 1, "missing active DBC falls back to base dataset");
});

test("content SHA detects same-size same-mtime replacement and verifies cached snapshot bytes", async (t) => {
  const { options } = await fixture(t);
  const path = join(options.patchRoot, "custom.dataset.MPQ", "Textures", "added.blp");
  await put(path, "OLD!");
  const before = await stat(path);
  const old = await prepareLocalPatchSnapshot(options);
  assert.equal((await prepareLocalPatchSnapshot(options)).identity, old.identity);
  await writeFile(path, "NEW!"); await utimes(path, before.atime, before.mtime);
  const next = await prepareLocalPatchSnapshot(options);
  assert.notEqual(next.identity, old.identity);
  assert.equal((await readAsset(old, "Textures\\added.blp")).toString(), "OLD!");
  assert.equal((await readAsset(next, "Textures\\added.blp")).toString(), "NEW!");
  await writeFile(join(next.clientDirectory, "Data", "custom.dataset.mpq", "textures", "added.blp"), "BAD!");
  await assert.rejects(prepareLocalPatchSnapshot(options), /snapshot was modified/);
});

test("corrupt archives and malformed DBC fail before snapshot publication", async (t) => {
  const { options } = await fixture(t);
  const broken = join(options.patchRoot, "patch-Z.MPQ");
  await put(broken, "not an MPQ");
  await assert.rejects(prepareLocalPatchSnapshot(options), /Unreadable patch archive/);
  assert.deepEqual(await readdir(options.stateDirectory), []);
  await rm(broken);
  await put(join(broken, "DBFilesClient", "Spell.dbc"), "WDBC truncated");
  await assert.rejects(prepareLocalPatchSnapshot(options), /Invalid patched DBC/);
  assert.deepEqual(await readdir(options.stateDirectory), []);
});

test("patch junctions are rejected without traversing their targets", async (t) => {
  const { root, options } = await fixture(t);
  const outside = join(root, "outside");
  await mkdir(outside);
  await put(join(outside, "asset"), "outside");
  await symlink(outside, join(options.patchRoot, "patch-J.MPQ"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepareLocalPatchSnapshot(options), /links\/junctions/);
  assert.equal((await readFile(join(outside, "asset"))).toString(), "outside");
});

test("case-colliding patch names are rejected on case-sensitive filesystems", { skip: process.platform === "win32" }, async (t) => {
  const { options } = await fixture(t);
  await put(join(options.patchRoot, "patch-B.MPQ", "a"), "one");
  await put(join(options.patchRoot, "PATCH-b.mpq", "b"), "two");
  await assert.rejects(prepareLocalPatchSnapshot(options), /Case-colliding/);
});

test("startup regenerates client media and namespaces caches while retaining server-derived inputs", async (t) => {
  const { options } = await fixture(t);
  const basePatch = join(options.clientDirectory, "Data", "patch-A.MPQ");
  for (const table of CLIENT_MEDIA_DBC_TABLES) await put(join(basePatch, "DBFilesClient", `${table}.dbc`), dbc(3));
  for (const profile of PLAYABLE_CHARACTER_PROFILES) {
    const model = Buffer.alloc(0x140); model.write("MD20"); model.writeUInt32LE(264, 4);
    const skin = Buffer.alloc(96); skin.write("SKIN"); skin.writeUInt32LE(1, 0x1c); skin.writeUInt32LE(48, 0x20);
    skin.writeUInt16LE(3, 48 + 10);
    await put(join(basePatch, ...profile.modelPath.split(/[\\/]/)), model);
    await put(join(basePatch, ...profile.skinPath.split(/[\\/]/)), skin);
  }
  await put(join(options.patchRoot, "patch-B.MPQ", "DBFilesClient", "CharSections.dbc"), dbc(99));
  const environment = { CLIENT_PACK_DIR: options.clientDirectory, DBC_DIR: options.dbcDirectory,
    WOWCLIENT_PATCH_ROOT: options.patchRoot, WOWCLIENT_PATCH_STATE: options.stateDirectory,
    VISUAL_DBC_DIR: "old-visual", CREATURE_METADATA_FILE: "base-creatures", ITEM_METADATA_FILE: "base-items",
    MAPS_DIR: "base-maps", VMAPS_DIR: "base-vmaps", CLIENT_FILE_DIR: "old-client-files" };
  const active = await prepareLocalPatches(environment);
  assert.equal(environment.CLIENT_PACK_DIR, undefined);
  assert.equal(environment.CLIENT_DIR, active.clientDirectory);
  assert.equal(environment.DBC_DIR, active.dbcDirectory);
  assert.ok(environment.CLIENT_FILE_DIR.startsWith(active.generation));
  assert.ok(environment.WMO_DOODAD_CACHE_DIR.startsWith(active.generation));
  assert.equal((await readFile(join(environment.VISUAL_DBC_DIR, "CharSections.dbc"))).readUInt32LE(20), 99);
  assert.equal(environment.CREATURE_METADATA_FILE, "base-creatures");
  assert.equal(environment.ITEM_METADATA_FILE, "base-items");
  assert.equal(environment.MAPS_DIR, "base-maps");
  assert.equal(environment.VMAPS_DIR, "base-vmaps");
});

const writer = process.env.MPQ_TEST_BUILDER ?? "F:/tswowRoot/tswow-install/bin/mpqbuilder/mpqbuilder.exe";
test("native MPQ files add/read/replace actual compressed archive contents", { skip: !existsSync(writer) && "no standalone MPQ fixture writer" }, async (t) => {
  const { root, options } = await fixture(t);
  const payload = join(root, "payload.txt"), listing = join(root, "inputs.txt");
  const archive = join(options.patchRoot, "patch-B.MPQ");
  async function publish(bytes) {
    await writeFile(payload, bytes);
    await writeFile(listing, `${payload}\tTextures\\native.blp\n`);
    const process = spawnSync(writer, [listing, archive], { encoding: "utf8", windowsHide: true });
    assert.equal(process.status, 0, `${process.error ?? ""}\n${process.stdout}\n${process.stderr}`);
  }
  await publish("ARCHIVE-OLD");
  const before = await stat(archive);
  const old = await prepareLocalPatchSnapshot(options);
  assert.equal((await readAsset(old, "Textures\\native.blp")).toString(), "ARCHIVE-OLD");
  await publish("ARCHIVE-NEW");
  await utimes(archive, before.atime, before.mtime);
  const next = await prepareLocalPatchSnapshot(options);
  assert.notEqual(next.identity, old.identity);
  assert.equal((await readAsset(next, "Textures\\native.blp")).toString(), "ARCHIVE-NEW");
  assert.equal((await readAsset(old, "Textures\\native.blp")).toString(), "ARCHIVE-OLD");
});

test("foreign locale patches are rejected instead of participating in ruRU precedence", async (t) => {
  const { options } = await fixture(t);
  await put(join(options.patchRoot, "enUS", "patch-enUS-B.MPQ", "a"), "foreign");
  await assert.rejects(prepareLocalPatchSnapshot(options), /Foreign patch locale enUS/);
  await rm(join(options.patchRoot, "enUS"), { recursive: true });
  await put(join(options.patchRoot, "patch-enUS-C.MPQ", "a"), "foreign");
  await assert.rejects(prepareLocalPatchSnapshot(options), /Foreign patch locale enUS/);
});
test("CharBaseInfo byte fields are accepted while exact DBC file bounds remain mandatory", async (t) => {
  const { options } = await fixture(t);
  // Installed build 12340 has 79 records, two fields, two bytes per record, one string byte.
  const bytes = Buffer.alloc(179);
  bytes.write("WDBC"); bytes.writeUInt32LE(79, 4); bytes.writeUInt32LE(2, 8);
  bytes.writeUInt32LE(2, 12); bytes.writeUInt32LE(1, 16);
  bytes[20] = 1; bytes[21] = 2;
  const path = join(options.patchRoot, "patch-B.MPQ", "DBFilesClient", "CharBaseInfo.dbc");
  await put(path, bytes);
  await put(join(options.dbcDirectory, "CharBaseInfo.dbc"), bytes);
  const active = await prepareLocalPatchSnapshot(options);
  assert.deepEqual(await readFile(join(active.dbcDirectory, "CharBaseInfo.dbc")), bytes);
  await writeFile(path, bytes.subarray(0, bytes.length - 1));
  await assert.rejects(prepareLocalPatchSnapshot(options), /Invalid patched DBC CharBaseInfo.dbc: inconsistent size\/header/);
});
test("existing empty legacy DBC placeholders survive while a newly emptied runtime DBC fails", async (t) => {
  const { options } = await fixture(t);
  await put(join(options.dbcDirectory, "CharVariations.dbc"), Buffer.alloc(0));
  await put(join(options.clientDirectory, "Data", "patch-A.MPQ", "DBFilesClient", "CharVariations.dbc"), Buffer.alloc(0));
  await put(join(options.patchRoot, "patch-B.MPQ", "Textures", "new.blp"), "NEW!");
  const active = await prepareLocalPatchSnapshot(options);
  assert.equal((await readFile(join(active.dbcDirectory, "CharVariations.dbc"))).length, 0);
  await put(join(options.patchRoot, "patch-B.MPQ", "DBFilesClient", "Spell.dbc"), Buffer.alloc(0));
  await assert.rejects(prepareLocalPatchSnapshot(options), /Invalid patched DBC Spell.dbc: not WDBC/);
});
test("an icon patch preserves base addon discovery; only winning external TOCs add or update descriptors", async (t) => {
  const { options } = await fixture(t);
  await put(join(options.clientDirectory, "Data", "patch-A.MPQ", "Interface", "AddOns", "Hidden", "Hidden.toc"), "Hidden.lua\n");
  await put(join(options.clientDirectory, "Interface", "AddOns", "Kept", "Kept.toc"), "## LoadOnDemand: 1\nKept.lua\n");
  await put(join(options.patchRoot, "patch-B.MPQ", "Textures", "icon.blp"), "icon");
  let active = await prepareLocalPatchSnapshot(options);
  assert.deepEqual(active.addons, [{ name: "Kept", loadOnDemand: true }], "base MPQ addon remains unadvertised");
  // This external TOC loses to the base lettered patch and must not advertise its addon.
  await put(join(options.patchRoot, "patch-3.MPQ", "Interface", "AddOns", "Hidden", "Hidden.toc"), "## LoadOnDemand: 1\n");
  active = await prepareLocalPatchSnapshot(options);
  assert.deepEqual(active.addons, [{ name: "Kept", loadOnDemand: true }]);
  await put(join(options.patchRoot, "patch-B.MPQ", "Interface", "AddOns", "Hidden", "Hidden.toc"), "## LoadOnDemand: 1\n");
  await put(join(options.patchRoot, "patch-B.MPQ", "Interface", "AddOns", "NewAddon", "NewAddon.toc"), "New.lua\n");
  active = await prepareLocalPatchSnapshot(options);
  assert.deepEqual(active.addons, [
    { name: "hidden", loadOnDemand: true }, { name: "Kept", loadOnDemand: true }, { name: "newaddon", loadOnDemand: false },
  ]);
  await put(join(options.patchRoot, "patch-B.MPQ", "Interface", "AddOns", "Hidden", "Hidden.toc"), "## LoadOnDemand: 0\n");
  active = await prepareLocalPatchSnapshot(options);
  assert.equal(active.addons.find((addon) => addon.name === "hidden").loadOnDemand, false);
});