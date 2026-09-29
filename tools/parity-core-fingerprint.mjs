/**
 * Read-only fingerprint of the selected TrinityCore gameplay sources.
 *
 * Hashes the current files, including uncommitted edits. This identifies the source tree used
 * for protocol review; it does not prove that a running worldserver was built from those files.
 * Save stdout with the corresponding WebClient and resource fingerprints.
 */
import './env.mjs';

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const coreRoot = resolve(process.env.TRINITYCORE_DIR ?? join(projectRoot, '..', 'tswow', 'cores', 'TrinityCore'));
const gameRoot = join(coreRoot, 'src', 'server', 'game');
const sourceExtensions = new Set(['.cpp', '.h', '.hpp', '.inl']);

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: coreRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

async function collect(directory, paths) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path, paths);
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name).toLowerCase())) paths.push(path);
  }
}

const paths = [];
await collect(gameRoot, paths);
paths.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);

const aggregate = createHash('sha256');
const files = [];
let bytes = 0;
for (const path of paths) {
  const name = relative(gameRoot, path).replaceAll('\\', '/');
  const contents = await readFile(path);
  const sha256 = createHash('sha256').update(contents).digest('hex');
  bytes += contents.length;
  files.push({ path: name, sha256 });
  aggregate.update(name).update('\0').update(sha256).update('\n');
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  coreRoot,
  gitHead: git('rev-parse', 'HEAD'),
  gitBranch: git('branch', '--show-current'),
  scope: 'src/server/game C++ source and headers only; current contents, including uncommitted edits',
  sha256: aggregate.digest('hex'),
  fileCount: files.length,
  bytes,
  files,
}, null, 2)}\n`);
