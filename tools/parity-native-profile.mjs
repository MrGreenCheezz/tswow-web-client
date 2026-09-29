/**
 * Read-only, privacy-scoped snapshot of the selected original client's Config.wtf
 * and AddOns.txt files. Writes JSON to stdout; never emits account, realm, or
 * character directory names or non-allowlisted Config.wtf values.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sourceClientDirectory } from './paths.mjs';

const numericKeys = new Set([
  'Gamma', 'checkAddonVersion', 'componentTextureLevel', 'environmentDetail',
  'extShadowQuality', 'farclip', 'groundEffectDensity', 'groundEffectDist',
  'gxColorBits', 'gxDepthBits', 'gxFixLag', 'gxMaximize', 'gxMultisampleQuality',
  'gxRefresh', 'gxTripleBuffer', 'gxVSync', 'gxWindow', 'particleDensity',
  'projectedTextures', 'shadowLevel', 'showToolsUI', 'specular',
  'textureFilteringMode', 'uiScale', 'useUiScale', 'videoOptionsVersion',
  'weatherDensity',
]);
const safeAddonNames = new Set([
  '!WCollectionsLoader', 'WCollections', 'WCollectionsDressUp',
]);
const safeLocales = new Set(['deDE', 'enGB', 'enUS', 'esES', 'esMX', 'frFR', 'koKR', 'ruRU', 'zhCN', 'zhTW']);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function parseAllowlistedConfig(bytes) {
  const values = new Map();
  const conflicts = new Set();
  let rejectedAllowedValues = 0;
  for (const line of bytes.toString('latin1').split(/\r?\n/)) {
    const match = /^SET\s+([A-Za-z][A-Za-z0-9_]*)\s+"([^"]*)"\s*$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    const allowed = numericKeys.has(key)
      ? /^-?\d+(?:\.\d+)?$/.test(value)
      : key === 'gxResolution'
        ? /^\d{3,5}x\d{3,5}$/.test(value)
        : key === 'locale'
          ? safeLocales.has(value)
          : false;
    if (!numericKeys.has(key) && key !== 'gxResolution' && key !== 'locale') continue;
    if (!allowed) {
      rejectedAllowedValues++;
      conflicts.add(key);
      continue;
    }
    if (values.has(key) && values.get(key) !== value) conflicts.add(key);
    values.set(key, value);
  }
  for (const key of conflicts) values.delete(key);
  return {
    values: Object.fromEntries([...values].sort(([a], [b]) => a.localeCompare(b, 'en'))),
    conflictingKeys: [...conflicts].sort(),
    rejectedAllowedValues,
  };
}

export function parseSafeAddons(bytes, installedNames = new Set()) {
  const entries = new Map();
  const conflicts = new Set();
  let redactedEntries = 0;
  let unparsedLines = 0;
  for (const line of bytes.toString('latin1').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^(.+?):\s*(enabled|disabled)\s*$/i.exec(line);
    if (!match) {
      unparsedLines++;
      continue;
    }
    const [, name, state] = match;
    if (!safeAddonNames.has(name) || !installedNames.has(name)) {
      redactedEntries++;
      continue;
    }
    const normalizedState = state.toLowerCase();
    if (entries.has(name) && entries.get(name) !== normalizedState) conflicts.add(name);
    entries.set(name, normalizedState);
  }
  for (const name of conflicts) entries.delete(name);
  return {
    explicitEnabled: [...entries].filter(([, state]) => state === 'enabled').map(([name]) => name).sort(),
    explicitDisabled: [...entries].filter(([, state]) => state === 'disabled').map(([name]) => name).sort(),
    conflictingEntries: [...conflicts].sort(),
    redactedEntries,
    unparsedLines,
  };
}

async function filesNamed(directory, name, found) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await filesNamed(path, name, found);
    else if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) found.push(path);
  }
}

async function optionalRead(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('Could not read original-client profile input', { cause: error });
  }
}

export async function captureNativeProfile(clientRoot) {
  const root = resolve(clientRoot);
  const wtf = join(root, 'WTF');
  const configBytes = await optionalRead(join(wtf, 'Config.wtf'));
  const config = configBytes === null
    ? { status: 'missing', sha256: null, bytes: 0, values: {}, conflictingKeys: [], rejectedAllowedValues: 0 }
    : { status: 'found', sha256: sha256(configBytes), bytes: configBytes.length, ...parseAllowlistedConfig(configBytes) };

  let installedNames = new Set();
  try {
    installedNames = new Set((await readdir(join(root, 'Interface', 'AddOns'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('Could not list original-client AddOns', { cause: error });
  }

  const addonPaths = [];
  try {
    await filesNamed(wtf, 'AddOns.txt', addonPaths);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('Could not find original-client AddOns.txt', { cause: error });
  }
  const groups = new Map();
  for (const path of addonPaths) {
    const bytes = await optionalRead(path);
    if (bytes === null) continue;
    const digest = sha256(bytes);
    const relativeParts = relative(wtf, path).split(sep);
    const scope = relativeParts[0]?.toLowerCase() === 'account' && relativeParts.length === 5
      ? 'character'
      : relativeParts[0]?.toLowerCase() === 'account' && relativeParts.length === 3
        ? 'account'
        : 'other';
    const id = `${scope}:${digest}`;
    const existing = groups.get(id);
    if (existing) existing.fileCount++;
    else groups.set(id, {
      scope,
      sha256: digest,
      bytes: bytes.length,
      fileCount: 1,
      ...parseSafeAddons(bytes, installedNames),
    });
  }
  const profiles = [...groups.values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.sha256.localeCompare(b.sha256));
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    source: 'selected CLIENT_DIR; no identity-bearing paths or non-allowlisted CVar values recorded',
    config,
    addOns: {
      status: profiles.length > 0 ? 'found' : 'missing',
      scannedFileCount: addonPaths.length,
      installedDirectoryCount: installedNames.size,
      profiles,
      note: 'Only explicit AddOns.txt enabled/disabled entries are reported; unlisted installed directories have unknown runtime state.',
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await captureNativeProfile(sourceClientDirectory());
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch {
    process.stderr.write('Native profile capture failed; check the selected CLIENT_DIR and input file access.\n');
    process.exitCode = 1;
  }
}
