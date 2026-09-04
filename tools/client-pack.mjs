/**
 * Builds a local-only, self-contained snapshot of the original client's asset roots.
 *
 * MPQ files and loose `*.MPQ` directories are copied without conversion. The gateway can point
 * every existing generator at the finished directory through `CLIENT_PACK_DIR`; it therefore no
 * longer needs the source installation after the snapshot has been published.
 */

import { constants, createReadStream, existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ARCHIVE_ORDER, archivePriority } from "./mpq.mjs";
import { repositoryRoot, sourceClientDirectory } from "./paths.mjs";

export const CLIENT_PACK_MANIFEST = "client-pack.json";
export const CLIENT_PACK_NOTICE = "LOCAL_ONLY-NOT-FOR-REDISTRIBUTION.txt";
export const CLIENT_PACK_KIND = "tswow-web-client-pack";
export const CLIENT_PACK_SCHEMA = 1;

const PACK_ROOTS = Object.freeze([
  { path: "Data", required: true },
  { path: "Interface/AddOns", required: false },
  { path: "Fonts", required: false },
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portablePath(value) {
  return value.split(sep).join("/");
}

function diskPath(root, portable) {
  return join(root, ...portable.split("/"));
}

function inside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Walks symlink/junction targets as real content so the resulting pack has no source dependency. */
async function walk(path, portable, entries, ancestors = new Set()) {
  const link = await lstat(path);
  const info = link.isSymbolicLink() ? await stat(path) : link;
  if (info.isDirectory()) {
    const canonical = await realpath(path);
    const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (ancestors.has(identity)) throw new Error(`Directory link cycle while packing ${path}`);
    entries.push({ path: portable, type: "directory", source: path });
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(identity);
    const children = await readdir(path, { withFileTypes: true });
    children.sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      await walk(join(path, child.name), `${portable}/${child.name}`, entries, nextAncestors);
    }
    return;
  }
  if (!info.isFile()) throw new Error(`Client pack input is neither a file nor a directory: ${path}`);
  entries.push({
    path: portable,
    type: "file",
    source: path,
    size: info.size,
    mtimeMs: info.mtimeMs,
  });
}

async function sourcePlan(clientDirectory) {
  const root = resolve(clientDirectory);
  if (!await isDirectory(join(root, "Data"))) throw new Error(`${root} has no Data directory`);
  const entries = [];
  const roots = [];
  for (const candidate of PACK_ROOTS) {
    const path = diskPath(root, candidate.path);
    if (!await isDirectory(path)) {
      if (candidate.required) throw new Error(`${root} has no ${candidate.path} directory`);
      continue;
    }
    roots.push(candidate.path);
    const parts = candidate.path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      if (!entries.some((entry) => entry.path === parent)) {
        entries.push({ path: parent, type: "directory", source: diskPath(root, parent) });
      }
    }
    await walk(path, candidate.path, entries);
  }
  entries.sort((left, right) => compareText(left.path, right.path));
  return { root, roots, entries };
}

function planSummary(plan) {
  const files = plan.entries.filter((entry) => entry.type === "file");
  return Object.freeze({
    roots: Object.freeze([...plan.roots]),
    fileCount: files.length,
    directoryCount: plan.entries.length - files.length,
    totalBytes: files.reduce((total, entry) => total + entry.size, 0),
  });
}

/** Counts the snapshot inputs without hashing or copying their contents. */
export async function inspectClientPackSource(clientDirectory) {
  return planSummary(await sourcePlan(clientDirectory));
}

function stablePlan(plan) {
  return plan.entries.map((entry) => entry.type === "file"
    ? `${entry.type}\0${entry.path}\0${entry.size}\0${entry.mtimeMs}`
    : `${entry.type}\0${entry.path}`);
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function contentDigest(entries) {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.type);
    hash.update("\0");
    hash.update(entry.path);
    if (entry.type === "file") {
      hash.update("\0");
      hash.update(String(entry.size));
      hash.update("\0");
      hash.update(entry.sha256);
    }
    hash.update("\n");
  }
  return hash.digest("hex");
}

function isTopLevelArchive(entry) {
  if (entry.type === "directory" && entry.path.toLowerCase() === "interface/addons") return true;
  const parts = entry.path.split("/");
  if (parts[0]?.toLowerCase() !== "data" || !/\.mpq$/i.test(parts.at(-1) ?? "")) return false;
  return !parts.slice(1, -1).some((part) => /\.mpq$/i.test(part));
}

function compareArchiveSources(left, right) {
  const a = left.path.toLowerCase() === "interface/addons"
    ? { tier: 17, rank: 0 } : archivePriority(basename(left.path));
  const b = right.path.toLowerCase() === "interface/addons"
    ? { tier: 17, rank: 0 } : archivePriority(basename(right.path));
  if (a.tier !== b.tier) return b.tier - a.tier;
  if (a.rank !== b.rank) return b.rank - a.rank;
  return compareText(right.path.toLowerCase(), left.path.toLowerCase());
}

function archiveManifest(entries) {
  const sources = entries
    .filter(isTopLevelArchive)
    .map((entry) => Object.freeze({
      path: entry.path,
      name: entry.path.toLowerCase() === "interface/addons" ? "Interface/AddOns" : basename(entry.path),
      kind: entry.type === "directory" ? "directory" : "archive",
    }))
    .sort(compareArchiveSources);
  const composition = sources
    .map((source) => `${source.kind}:${source.name.toLowerCase()}`)
    .sort();
  return {
    sources: Object.freeze(sources),
    digest: createHash("sha1").update([ARCHIVE_ORDER, ...composition].join("\n")).digest("hex"),
  };
}

async function copyPlan(plan, staging) {
  const manifestEntries = [];
  for (const entry of plan.entries) {
    const destination = diskPath(staging, entry.path);
    if (entry.type === "directory") {
      await mkdir(destination, { recursive: true });
      manifestEntries.push(Object.freeze({ path: entry.path, type: "directory" }));
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    // FICLONE is an independent copy where the filesystem supports it and a normal copy elsewhere.
    await copyFile(entry.source, destination, constants.COPYFILE_FICLONE);
    const copied = await stat(destination);
    manifestEntries.push(Object.freeze({
      path: entry.path,
      type: "file",
      size: copied.size,
      sha256: await sha256(destination),
    }));
  }
  return manifestEntries;
}

function assertSafeDestination(source, output) {
  if (inside(source, output) || inside(output, source)) {
    throw new Error(`Client pack source and output must be separate trees: ${source} / ${output}`);
  }
  const root = resolve(output);
  if (root === dirname(root)) throw new Error(`Refusing to use a filesystem root as a client pack: ${root}`);
}

async function assertReplaceablePack(output) {
  if (!existsSync(output)) return;
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(output, CLIENT_PACK_MANIFEST), "utf8"));
  } catch {
    throw new Error(`Refusing to replace ${output}: it is not an existing client pack`);
  }
  if (manifest?.kind !== CLIENT_PACK_KIND || manifest?.schema !== CLIENT_PACK_SCHEMA) {
    throw new Error(`Refusing to replace ${output}: its client-pack manifest is not supported`);
  }
}

async function publishStaging(staging, output) {
  const backup = `${output}.previous-${randomUUID()}`;
  let movedPrevious = false;
  try {
    if (existsSync(output)) {
      await rename(output, backup);
      movedPrevious = true;
    }
    await rename(staging, output);
  } catch (error) {
    if (movedPrevious && !existsSync(output)) await rename(backup, output).catch(() => {});
    throw error;
  }
  if (movedPrevious) await rm(backup, { recursive: true, force: true });
}

/** Builds and atomically publishes a self-contained local client snapshot. */
export async function buildClientPack(options) {
  const source = resolve(options.clientDirectory);
  const output = resolve(options.outputDirectory);
  assertSafeDestination(source, output);
  await assertReplaceablePack(output);
  const plan = await sourcePlan(source);
  const staging = join(dirname(output), `.${basename(output)}.building-${randomUUID()}`);
  await mkdir(dirname(output), { recursive: true });
  try {
    await mkdir(staging);
    const entries = await copyPlan(plan, staging);
    const after = await sourcePlan(source);
    if (JSON.stringify(stablePlan(after)) !== JSON.stringify(stablePlan(plan))) {
      throw new Error("The source client changed while its client pack was being built; retry after patching finishes");
    }
    const summary = planSummary(plan);
    const archives = archiveManifest(entries);
    const manifest = Object.freeze({
      schema: CLIENT_PACK_SCHEMA,
      kind: CLIENT_PACK_KIND,
      createdAt: new Date().toISOString(),
      targetBuild: 12340,
      locale: process.env.CLIENT_LOCALE ?? null,
      archiveOrder: ARCHIVE_ORDER,
      archiveChainDigest: archives.digest,
      archiveSources: archives.sources,
      roots: summary.roots,
      fileCount: summary.fileCount,
      directoryCount: summary.directoryCount,
      totalBytes: summary.totalBytes,
      contentDigest: contentDigest(entries),
      entries: Object.freeze(entries),
    });
    await writeFile(join(staging, CLIENT_PACK_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(
      join(staging, CLIENT_PACK_NOTICE),
      "LOCAL-ONLY CLIENT PACK\n\n"
        + "Built from the user's own World of Warcraft client for local use by TSWoW WebClient.\n"
        + "Do not commit, upload, publish, or redistribute this directory.\n",
      "utf8",
    );
    await publishStaging(staging, output);
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function validateManifest(value, directory) {
  if (value?.schema !== CLIENT_PACK_SCHEMA || value?.kind !== CLIENT_PACK_KIND || !Array.isArray(value.entries)) {
    throw new Error(`${directory} does not contain a supported ${CLIENT_PACK_MANIFEST}`);
  }
  const seen = new Set();
  for (const entry of value.entries) {
    if (!entry || typeof entry.path !== "string" || !entry.path || entry.path.includes("\\")
      || entry.path.startsWith("/") || entry.path.split("/").includes("..")
      || !["file", "directory"].includes(entry.type) || seen.has(entry.path)) {
      throw new Error(`${directory} contains an invalid client-pack manifest entry`);
    }
    if (entry.type === "file"
      && (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? ""))) {
      throw new Error(`${directory} contains invalid file metadata for ${entry.path}`);
    }
    seen.add(entry.path);
  }
  const ordered = [...value.entries].sort((left, right) => compareText(left.path, right.path));
  if (contentDigest(ordered) !== value.contentDigest) {
    throw new Error(`${directory} has a client-pack manifest with an invalid content digest`);
  }
  return { ...value, entries: ordered };
}

async function packPlan(packDirectory) {
  const entries = [];
  const children = await readdir(packDirectory, { withFileTypes: true });
  children.sort((left, right) => compareText(left.name, right.name));
  for (const child of children) {
    if (child.name === CLIENT_PACK_MANIFEST || child.name === CLIENT_PACK_NOTICE) continue;
    await walk(join(packDirectory, child.name), portablePath(child.name), entries);
  }
  entries.sort((left, right) => compareText(left.path, right.path));
  return entries;
}

/** Verifies every path, size and (unless disabled) byte hash in a published pack. */
export async function verifyClientPack(packDirectory, options = {}) {
  const directory = resolve(packDirectory);
  const manifest = validateManifest(
    JSON.parse(await readFile(join(directory, CLIENT_PACK_MANIFEST), "utf8")),
    directory,
  );
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const actualEntries = await packPlan(directory);
  const actual = new Map(actualEntries.map((entry) => [entry.path, entry]));
  const missing = [];
  const modified = [];
  const unexpected = [];
  for (const entry of manifest.entries) {
    const found = actual.get(entry.path);
    if (!found) {
      missing.push(entry.path);
      continue;
    }
    if (found.type !== entry.type) {
      modified.push(entry.path);
      continue;
    }
    if (entry.type === "file") {
      if (found.size !== entry.size
        || (options.hashes !== false && await sha256(found.source) !== entry.sha256)) modified.push(entry.path);
    }
  }
  for (const entry of actualEntries) if (!expected.has(entry.path)) unexpected.push(entry.path);
  return Object.freeze({
    ok: missing.length === 0 && modified.length === 0 && unexpected.length === 0,
    manifest,
    missing: Object.freeze(missing),
    modified: Object.freeze(modified),
    unexpected: Object.freeze(unexpected),
  });
}

function option(arguments_, name) {
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

function printBytes(bytes) {
  return `${(bytes / (1024 ** 3)).toFixed(2)} GiB`;
}

async function main(arguments_) {
  const command = arguments_[0];
  const output = resolve(option(arguments_, "--output")
    ?? process.env.CLIENT_PACK_DIR
    ?? join(repositoryRoot, "dist/client-pack"));
  if (command === "build") {
    const source = resolve(option(arguments_, "--client") ?? sourceClientDirectory());
    if (arguments_.includes("--dry-run")) {
      const plan = await inspectClientPackSource(source);
      console.log(`Client pack dry run: ${plan.fileCount} files, ${plan.directoryCount} directories, ${printBytes(plan.totalBytes)}`);
      console.log(`Source: ${source}`);
      console.log(`Output: ${output}`);
      return;
    }
    const manifest = await buildClientPack({ clientDirectory: source, outputDirectory: output });
    console.log(`Built client pack ${manifest.contentDigest}`);
    console.log(`${manifest.fileCount} files, ${manifest.directoryCount} directories, ${printBytes(manifest.totalBytes)}`);
    console.log(`Set CLIENT_PACK_DIR=${output} to use it without the source client.`);
    return;
  }
  if (command === "verify") {
    const result = await verifyClientPack(output);
    for (const [label, values] of [
      ["missing", result.missing],
      ["modified", result.modified],
      ["unexpected", result.unexpected],
    ]) {
      if (values.length) console.error(`${label}: ${values.slice(0, 20).join(", ")}${values.length > 20 ? " …" : ""}`);
    }
    console.log(`Client pack ${result.ok ? "is valid" : "is invalid"}: ${result.manifest.contentDigest}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error(
    "Usage:\n"
      + "  node tools/client-pack.mjs build [--client <path>] [--output <path>] [--dry-run]\n"
      + "  node tools/client-pack.mjs verify [--output <path>]",
  );
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entry === import.meta.url) await main(process.argv.slice(2));
