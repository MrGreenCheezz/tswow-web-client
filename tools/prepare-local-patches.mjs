/** Offline patch snapshots for an installed immutable RuntimeBundle.
 * Only MPQ inputs are portable here. SQL metadata and extracted maps/vmaps remain base inputs.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { ARCHIVE_ORDER, openClientArchives } from "./mpq.mjs";

const SCHEMA = "local-patches-2";
const key = (path) => path.replaceAll("\\", "/").toLowerCase();
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function optionalStat(path) {
  try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
/** Reject links in every ancestor as well as within the tree (including Windows junctions). */
async function physicalPath(path) {
  let current = resolve(path);
  while (true) {
    const info = await optionalStat(current);
    if (info?.isSymbolicLink()) throw new Error(`Patch paths must not contain links/junctions: ${current}`);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
async function tree(root, prefix = "", hashFiles = false) {
  const entries = [];
  const seen = new Set();
  async function walk(source, path) {
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error(`Patch paths must not contain links/junctions: ${source}`);
    if (!info.isDirectory() && !info.isFile()) throw new Error(`Unsupported patch entry: ${source}`);
    const id = key(path);
    if (seen.has(id)) throw new Error(`Case-colliding patch paths: ${path}`);
    seen.add(id);
    const entry = { path, source, directory: info.isDirectory(), size: info.size };
    if (!entry.directory && hashFiles) entry.sha256 = await fileHash(source);
    entries.push(entry);
    if (entry.directory) {
      for (const name of (await readdir(source)).sort()) await walk(join(source, name), path ? `${path}/${name}` : name);
    }
  }
  await walk(root, prefix);
  return entries;
}
async function patchInputs(root, locale) {
  await physicalPath(root);
  const info = await optionalStat(root);
  if (!info) return { entries: [], roots: [] };
  if (!info.isDirectory()) throw new Error(`Patch root is not a directory: ${root}`);
  const entries = [];
  const roots = [];
  const seen = new Set();
  async function discover(directory, prefix, inLocale = false) {
    for (const name of (await readdir(directory)).sort()) {
      const source = join(directory, name);
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw new Error(`Patch paths must not contain links/junctions: ${source}`);
      const path = `${prefix}/${name}`;
      const patchLocale = /^patch-([a-z]{4})(?:-|\.mpq$)/i.exec(name)?.[1];
      if (patchLocale && locale && patchLocale.toLowerCase() !== locale.toLowerCase()) throw new Error(`Foreign patch locale ${patchLocale}; expected ${locale}`);
      if (seen.has(key(path))) throw new Error(`Case-colliding patch paths: ${path}`);
      seen.add(key(path));
      if (/\.mpq$/i.test(name)) {
        roots.push(key(path));
        entries.push(...await tree(source, path, true));
      } else if (!inLocale && /^[a-z]{4}$/i.test(name) && info.isDirectory()) {
        if (locale && name.toLowerCase() !== locale.toLowerCase()) throw new Error(`Foreign patch locale ${name}; expected ${locale}`);
        await discover(source, path, true);
      }
    }
  }
  await discover(root, "Data");
  return { entries, roots };
}
function inputIdentity(inputs) {
  return inputs.entries.map(({ path, directory, sha256 }) => [key(path), directory ? "directory" : sha256]);
}
function outputPath(path) {
  const parts = key(path).split("/");
  parts[0] = { data: "Data", interface: "Interface", fonts: "Fonts" }[parts[0]] ?? parts[0];
  if (parts[0] === "Interface" && parts[1] === "addons") parts[1] = "AddOns";
  return parts.join("/");
}
function validateDbc(bytes, name) {
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "WDBC") throw new Error(`Invalid patched DBC ${name}: not WDBC`);
  const records = bytes.readUInt32LE(4), fields = bytes.readUInt32LE(8);
  const recordSize = bytes.readUInt32LE(12), strings = bytes.readUInt32LE(16);
  // WDBC integers can be narrower than 32 bits (CharBaseInfo: two byte fields).
  // Table-specific layouts are checked by consumers; preparation enforces exact file bounds.
  const end = 20 + records * recordSize + strings;
  if (fields === 0 || recordSize === 0 || !Number.isSafeInteger(end) || end !== bytes.length) {
    throw new Error(`Invalid patched DBC ${name}: inconsistent size/header`);
  }
}
async function extractDbcs(client, baseDbc, destination) {
  const chain = await openClientArchives(client);
  try {
    if (chain.skipped.length) throw new Error(`Unreadable patch archive(s): ${chain.skipped.join("; ")}`);
    const names = new Map();
    for (const name of await readdir(baseDbc)) if (/^[a-z0-9_]+\.dbc$/i.test(name)) names.set(name.toLowerCase(), name);
    for (const path of await chain.list("DBFilesClient\\")) {
      const match = /^dbfilesclient\\([a-z0-9_]+\.dbc)$/i.exec(path);
      if (match && !names.has(match[1].toLowerCase())) names.set(match[1].toLowerCase(), match[1]);
    }
    await mkdir(destination, { recursive: true });
    const files = [];
    for (const name of [...names.values()].sort()) {
      const baseBytes = await readFile(join(baseDbc, name)).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      const bytes = await chain.read(`DBFilesClient\\${name}`) ?? baseBytes;
      if (bytes === undefined) throw new Error(`Missing active DBC ${name}`);
      // Some shipped datasets retain unused empty placeholders (12340 CharVariations).
      // Preserve only an already-empty base table; a patch cannot truncate a runtime table.
      if (!(bytes.length === 0 && baseBytes?.length === 0)) validateDbc(bytes, name);
      await writeFile(join(destination, name), bytes, { flag: "wx" });
      files.push({ name, sha256: digest(bytes) });
    }
    return files;
  } finally { chain.close(); }
}
/** Retain loose base add-ons and opt in only TOCs whose winning source is an external patch. */
export async function discoverArchiveAddons(clientDirectory, externalRoots, baseClientDirectory) {
  const chain = await openClientArchives(clientDirectory);
  try {
    if (chain.skipped.length) throw new Error(`Unreadable patch archive(s): ${chain.skipped.join("; ")}`);
    const { discoverClientAddons } = await import("../dist/code/gateway/ClientAddons.js");
    const addons = new Map((await discoverClientAddons(baseClientDirectory)).map((addon) => [addon.name.toLowerCase(), addon]));
    for (const path of await chain.list("Interface\\AddOns\\")) {
      const match = /^interface\\addons\\([!a-z0-9_][!a-z0-9_-]*)\\\1\.toc$/i.exec(path);
      if (!match) continue;
      const winner = await chain.sourceOf(path);
      const winnerPath = winner ? key(relative(clientDirectory, winner.file)) : "";
      if (!externalRoots.some((root) => winnerPath === root || winnerPath.startsWith(`${root}/`))) continue;
      const source = (await chain.read(path))?.toString("utf8");
      if (source === undefined) throw new Error(`Active add-on TOC is unreadable: ${path}`);
      addons.set(match[1].toLowerCase(), { name: match[1], loadOnDemand: /^\s*##\s*LoadOnDemand\s*:\s*(?:1|true|yes)\s*$/im.test(source) });
    }
    return [...addons.values()].sort((left, right) => left.name.localeCompare(right.name, "en", { sensitivity: "base" }));
  } finally { chain.close(); }
}
/** Returns undefined for no patches; callers retain the original base configuration in that case. */
export async function prepareLocalPatchSnapshot({ clientDirectory, dbcDirectory, patchRoot, stateDirectory, locale = "ruRU" }) {
  for (const path of [clientDirectory, dbcDirectory, patchRoot, stateDirectory]) await physicalPath(path);
  const inputs = await patchInputs(patchRoot, locale);
  if (!inputs.roots.length) return undefined;
  const baseManifest = await readFile(join(clientDirectory, "client-pack.json"));
  const baseDbcs = (await tree(dbcDirectory, "", true)).filter((entry) => !entry.directory && /\.dbc$/i.test(entry.path));
  const identity = digest(JSON.stringify([SCHEMA, ARCHIVE_ORDER, locale.toLowerCase(), digest(baseManifest), inputIdentity(inputs),
    baseDbcs.map(({ path, sha256 }) => [path, sha256])]));
  const generation = join(stateDirectory, identity);
  const client = join(generation, "client");
  const dbc = join(generation, "dbc");
  const expected = new Map();
  for (const root of ["Data", "Interface/AddOns", "Fonts"]) {
    if (!await optionalStat(join(clientDirectory, root))) continue;
    for (const entry of await tree(join(clientDirectory, root), root)) {
      const id = key(entry.path);
      if (inputs.roots.some((patch) => id === patch || id.startsWith(`${patch}/`))) continue;
      expected.set(id, entry);
    }
  }
  for (const entry of inputs.entries) expected.set(key(entry.path), { ...entry, overlay: true });
  // Add parents of external locale directories absent from the base.
  for (const entry of [...expected.values()]) {
    let path = key(entry.path);
    while (path.includes("/")) {
      path = path.slice(0, path.lastIndexOf("/"));
      if (!expected.has(path)) expected.set(path, { path, directory: true });
      else if (!expected.get(path).directory) throw new Error(`Conflicting patch file/directory: ${path}`);
    }
  }
  async function verifyPublished() {
    await physicalPath(generation);
    await physicalPath(join(generation, "snapshot.json"));
    const receipt = JSON.parse(await readFile(join(generation, "snapshot.json"), "utf8"));
    if (receipt.identity !== identity || !Array.isArray(receipt.dbcs) || !Array.isArray(receipt.addons)) throw new Error("Invalid local patch snapshot receipt");
    const actual = (await tree(client)).filter((entry) => entry.path);
    if (actual.length !== expected.size) throw new Error("Local patch snapshot has missing/unexpected client entries");
    for (const entry of actual) {
      const planned = expected.get(key(entry.path));
      if (!planned || entry.directory !== planned.directory || (!entry.directory && entry.size !== planned.size)) {
        throw new Error(`Local patch snapshot was modified: ${entry.path}`);
      }
      if (planned.overlay && !entry.directory && await fileHash(entry.source) !== planned.sha256) {
        throw new Error(`Local patch snapshot was modified: ${entry.path}`);
      }
    }
    const tables = (await tree(dbc)).filter((entry) => !entry.directory);
    if (tables.length !== receipt.dbcs.length) throw new Error("Local patch snapshot DBC set was modified");
    for (const entry of tables) {
      const table = receipt.dbcs.find(({ name }) => name === entry.path);
      if (!table || await fileHash(entry.source) !== table.sha256) throw new Error(`Local patch snapshot DBC was modified: ${entry.path}`);
    }
    return receipt.addons;
  }
  if (await optionalStat(generation)) {
    const addons = await verifyPublished();
    return { identity, generation, clientDirectory: client, dbcDirectory: dbc, addons };
  }
  await mkdir(stateDirectory, { recursive: true });
  const staging = await mkdtemp(join(stateDirectory, ".staging-"));
  try {
    const stagedClient = join(staging, "client");
    for (const entry of [...expected.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      const destination = join(stagedClient, outputPath(entry.path));
      if (entry.directory) { await mkdir(destination, { recursive: true }); continue; }
      await mkdir(dirname(destination), { recursive: true });
      if (entry.overlay) {
        await copyFile(entry.source, destination);
        if (await fileHash(destination) !== entry.sha256) throw new Error(`Patch changed while copying: ${entry.path}`);
      } else {
        // No large-file copy fallback: state and base must support same-volume hardlinks.
        try { await link(entry.source, destination); }
        catch (error) { throw new Error(`Cannot hardlink immutable base file ${entry.path}; patch state must be on the same volume: ${error.message}`); }
      }
    }
    const dbcs = await extractDbcs(stagedClient, dbcDirectory, join(staging, "dbc"));
    const addons = await discoverArchiveAddons(stagedClient, inputs.roots, clientDirectory);
    if (JSON.stringify(inputIdentity(await patchInputs(patchRoot, locale))) !== JSON.stringify(inputIdentity(inputs))) {
      throw new Error("Patch inputs changed during preparation; retry after copying has finished");
    }
    await writeFile(join(staging, "snapshot.json"), JSON.stringify({ schema: SCHEMA, identity, dbcs, addons }), { flag: "wx" });
    try { await rename(staging, generation); }
    catch (error) { if (!await optionalStat(generation)) throw error; await verifyPublished(); }
    return { identity, generation, clientDirectory: client, dbcDirectory: dbc, addons };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

const CACHE_DIRECTORIES = Object.freeze({
  ITEM_ICON_DIR: "item-icons", SPELL_ICON_DIR: "icons", CREATURE_ICON_DIR: "creature-icons",
  TERRAIN_TEXTURE_DIR: "terrain-textures", TERRAIN_LAYER_DIR: "terrain-layers",
  VISUAL_TILE_DIR: "visual-tiles", VISUAL_MODEL_DIR: "visual-models", HORIZON_DIR: "horizon",
  TEXTURE_DIR: "textures", MINIMAP_DIR: "minimap", WORLD_MAP_ZONE_MAP_DIR: "worldmap-zone-maps",
  SOUND_DIR: "sound", CLIENT_FILE_DIR: "client-files", LIQUID_DIR: "liquid",
  WMO_DOODAD_CACHE_DIR: "visual-wmo-doodads",
});
/** Called only after start-local-assets has verified the original client-pack manifest. */
export async function prepareLocalPatches(environment = process.env) {
  if (!environment.WOWCLIENT_PATCH_ROOT && !environment.WOWCLIENT_PATCH_STATE) return undefined;
  if (!environment.WOWCLIENT_PATCH_ROOT || !environment.WOWCLIENT_PATCH_STATE) throw new Error("Local patches require both WOWCLIENT_PATCH_ROOT and WOWCLIENT_PATCH_STATE");
  const result = await prepareLocalPatchSnapshot({
    clientDirectory: environment.CLIENT_PACK_DIR,
    dbcDirectory: environment.DBC_DIR,
    patchRoot: environment.WOWCLIENT_PATCH_ROOT,
    stateDirectory: environment.WOWCLIENT_PATCH_STATE,
    locale: environment.CLIENT_LOCALE ?? "ruRU",
  });
  if (!result) return undefined;
  const { extractClientMediaDbcs } = await import("./extract-visual-dbc-overlay.mjs");
  const visual = await extractClientMediaDbcs({ clientDirectory: result.clientDirectory,
    outputDirectory: join(result.generation, "visual-dbc") });
  environment.CLIENT_DIR = result.clientDirectory;
  delete environment.CLIENT_PACK_DIR;
  environment.DBC_DIR = result.dbcDirectory;
  environment.VISUAL_DBC_DIR = visual;
  for (const [name, directory] of Object.entries(CACHE_DIRECTORIES)) environment[name] = join(result.generation, "cache", directory);
  environment.TEMP = environment.TMP = join(result.generation, "tmp");
  await mkdir(environment.TEMP, { recursive: true });
  console.error(`Local MPQ patches: ${result.identity}; active DBCs and media rebuilt locally. SQL metadata and extracted maps/vmaps remain installed-base data.`);
  return result;
}
