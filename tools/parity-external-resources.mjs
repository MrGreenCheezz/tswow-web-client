/**
 * Read-only resource snapshot for a parity capture against the selected 3.3.5a client.
 *
 * Run with the source hook so the gateway's current TypeScript fingerprint is used:
 *   node --import ./tools/register-test-sources.mjs tools/parity-external-resources.mjs --output parity/parity-external-resources.json
 *
 * The output file is JSON. StormLib writes diagnostics to stdout, so shell redirection is
 * unsuitable for the manifest. It contains resolved paths and hashes, never config contents.
 * MPQ files are identified by metadata (and a few resolved virtual file hashes); loose
 * patches, add-ons and dataset DBCs are hashed in full. Large MPQs are not read end-to-end.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fingerprintArchives, fingerprintDbc } from '../dist/code/gateway/DatasetFingerprint.js';
import { openClientArchives } from './mpq.mjs';
import {
  clientDirectory, datasetDirectory, dbcDirectory, interfaceDirectory, mapsDirectory,
  sourceClientDirectory, vmapsDirectory,
} from './paths.mjs';

const TARGET_DBC = new Set([
  'areatable.dbc', 'charsections.dbc', 'chrraces.dbc', 'gameobjectdisplayinfo.dbc',
  'item.dbc', 'map.dbc', 'spell.dbc',
]);
const TARGET_VIRTUAL_FILES = [
  'DBFilesClient\\AreaTable.dbc',
  'DBFilesClient\\GameObjectDisplayInfo.dbc',
  'DBFilesClient\\Map.dbc',
  'DBFilesClient\\Spell.dbc',
  'Interface\\FrameXML\\Constants.lua',
  'Interface\\GlueXML\\AccountLogin.lua',
  'Interface\\GlueXML\\GlueXML.toc',
];
const SMALL_MPQ_HASH_LIMIT = 32 * 1024 * 1024;

function slash(path) {
  return path.replaceAll(sep, '/');
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Recursively gather regular files, following junctions while preventing link cycles. */
export async function collectFiles(root) {
  const found = [];
  const visited = new Set();
  async function walk(directory) {
    const canonical = await realpath(directory);
    if (visited.has(canonical.toLowerCase())) return;
    visited.add(canonical.toLowerCase());
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const info = entry.isSymbolicLink() ? await stat(absolute) : null;
      if (entry.isDirectory() || info?.isDirectory()) await walk(absolute);
      else if (entry.isFile() || info?.isFile()) found.push(absolute);
    }
  }
  await walk(root);
  found.sort((a, b) => {
    const left = slash(relative(root, a)).toLowerCase();
    const right = slash(relative(root, b)).toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return found;
}

/** Full content identity; path names are part of the hash so renames are detected. */
export async function contentTree(root, selected = new Set()) {
  const files = await collectFiles(root);
  const aggregate = createHash('sha256');
  const targets = {};
  let bytes = 0;
  let previous = '';
  for (const absolute of files) {
    const path = slash(relative(root, absolute)).toLowerCase();
    if (path === previous) throw new Error(`Duplicate case-insensitive resource path: ${path}`);
    previous = path;
    const { size } = await stat(absolute);
    const sha256 = await sha256File(absolute);
    bytes += size;
    aggregate.update(path).update('\0').update(String(size)).update('\0').update(sha256).update('\n');
    if (selected.has(path)) targets[path] = { bytes: size, sha256 };
  }
  return { files: files.length, bytes, sha256: aggregate.digest('hex'), targets };
}

async function treeCount(root) {
  const files = await collectFiles(root);
  let bytes = 0;
  for (const file of files) bytes += (await stat(file)).size;
  return { files: files.length, bytes, identity: 'file count and byte total only; no content hash' };
}

async function archiveEntries(client) {
  const data = join(client, 'Data');
  const entries = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const info = await stat(absolute);
      if (!/\.mpq$/i.test(entry.name)) {
        if (info.isDirectory()) await walk(absolute);
        continue;
      }
      entries.push({
        name: entry.name,
        kind: info.isDirectory() ? 'directory' : 'archive',
        path: slash(relative(client, absolute)),
        realPath: await realpath(absolute),
        absolute,
        size: info.isFile() ? info.size : null,
        mtimeMs: info.isFile() ? info.mtimeMs : null,
        sha256: info.isFile() && info.size <= SMALL_MPQ_HASH_LIMIT
          ? await sha256File(absolute) : null,
      });
    }
  }
  await walk(data);
  const addons = join(client, 'Interface', 'AddOns');
  try {
    if ((await stat(addons)).isDirectory()) {
      entries.push({
        name: 'Interface/AddOns', kind: 'directory', path: 'Interface/AddOns',
        realPath: await realpath(addons), absolute: addons, size: null, mtimeMs: null,
      });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return entries;
}

async function virtualTargets(chain) {
  const targets = [];
  for (const path of TARGET_VIRTUAL_FILES) {
    const winner = await chain.locate(path);
    const contents = await chain.read(path);
    targets.push(contents
      ? { path, winner, bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') }
      : { path, winner: null, missing: true });
  }
  return targets;
}

export async function captureExternalResources() {
  // sourceClientDirectory() deliberately ignores CLIENT_PACK_DIR: this captures the selected
  // installed native client, while effectiveClientRoot records a pack override if one is active.
  const clientRoot = resolve(sourceClientDirectory());
  const datasetRoot = resolve(datasetDirectory());
  const dbcRoot = resolve(dbcDirectory());
  const mapRoot = resolve(mapsDirectory());
  const vmapRoot = resolve(vmapsDirectory());
  const uiRoot = resolve(interfaceDirectory());
  const paths = {
    sourceClientRoot: await realpath(clientRoot),
    effectiveClientRoot: await realpath(clientDirectory()),
    datasetRoot: await realpath(datasetRoot),
    dbcRoot: await realpath(dbcRoot),
    mapsRoot: await realpath(mapRoot),
    vmapsRoot: await realpath(vmapRoot),
    interfaceRoot: await realpath(uiRoot),
  };

  const firstDbc = await fingerprintDbc(dbcRoot);
  const firstArchives = await fingerprintArchives(clientRoot);
  const chain = await openClientArchives(clientRoot);
  try {
    if (chain.chainDigest() !== firstArchives.chain) {
      throw new Error('Archive chain changed or differs from gateway fingerprint');
    }
    const entries = await archiveEntries(clientRoot);
    const byName = new Map(entries.map((entry) => [`${entry.kind}:${entry.name.toLowerCase()}`, entry]));
    if (byName.size !== entries.length) throw new Error('Ambiguous duplicate archive source names');
    const ordered = chain.sources.map((source, priority) => {
      const entry = byName.get(`${source.kind}:${source.name.toLowerCase()}`);
      if (!entry) throw new Error(`Opened source missing from Data inventory: ${source.name}`);
      return { priority, ...entry };
    });
    const opened = new Set(ordered.map((entry) => `${entry.kind}:${entry.name.toLowerCase()}`));
    const unopened = entries.filter((entry) => !opened.has(`${entry.kind}:${entry.name.toLowerCase()}`));
    const looseSources = [];
    for (const entry of ordered.filter((source) => source.kind === 'directory')) {
      const content = await contentTree(entry.absolute);
      looseSources.push({ name: entry.name, path: entry.path, realPath: entry.realPath, ...content });
    }
    const dbc = await contentTree(dbcRoot, TARGET_DBC);
    const wowExe = join(clientRoot, 'Wow.exe');
    const exeStats = await stat(wowExe);
    const targets = await virtualTargets(chain);
    const dbcClientComparison = targets
      .filter((target) => target.path.startsWith('DBFilesClient\\'))
      .map((target) => {
        const datasetName = target.path.slice('DBFilesClient\\'.length).toLowerCase();
        const dataset = dbc.targets[datasetName] ?? null;
        return {
          path: target.path,
          clientWinner: target.winner,
          matchesDataset: dataset && !target.missing
            ? dataset.sha256 === target.sha256 : null,
        };
      });
    const datasetInventory = {
      maps: await treeCount(mapRoot),
      vmaps: await treeCount(vmapRoot),
      interface: await treeCount(uiRoot),
    };
    const wowExeIdentity = { bytes: exeStats.size, sha256: await sha256File(wowExe) };
    const finalDbc = await fingerprintDbc(dbcRoot);
    const finalArchives = await fingerprintArchives(clientRoot);
    if (firstDbc.hash !== finalDbc.hash || firstDbc.files !== finalDbc.files ||
        firstArchives.hash !== finalArchives.hash || firstArchives.chain !== finalArchives.chain ||
        firstArchives.files !== finalArchives.files) {
      throw new Error('External resources changed while the baseline was being captured');
    }
    if (dbc.files !== firstDbc.files) throw new Error('DBC content walk differs from gateway input count');
    return {
      schemaVersion: 1,
      scope: 'read-only native client and selected TSWoW dataset; no credentials or configuration contents',
      paths,
      gatewayMetadata: {
        dbcSha1: firstDbc.hash, dbcFiles: firstDbc.files,
        archiveSha1: firstArchives.hash, archiveWatchedFiles: firstArchives.files,
        archiveChainSha1: firstArchives.chain,
      },
      content: {
        wowExe: wowExeIdentity,
        dbc,
        looseSources,
        virtualTargets: targets,
        dbcClientComparison,
      },
      archiveChain: ordered.map(({ absolute: _absolute, ...entry }) => entry),
      unopenedSources: unopened.map(({ absolute: _absolute, ...entry }) => entry),
      stormLibSkipped: chain.skipped,
      datasetInventory,
      limitations: [
        'MPQs above 32 MiB are not hashed end-to-end; metadata and selected winner bytes identify the observed chain, not every byte of each large MPQ.',
        'Maps, vmaps and extracted Interface are counted but not content-hashed.',
        'The selected source paths do not prove which realm or native process was running.',
        'The snapshot does not establish visual or gameplay parity without paired live captures.',
      ],
    };
  } finally {
    chain.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== '--output') {
    throw new Error('Usage: parity-external-resources.mjs --output <manifest.json>');
  }
  const output = resolve(process.argv[3]);
  const manifest = await captureExternalResources();
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stderr.write(`Wrote external resource baseline: ${output}\n`);
}
