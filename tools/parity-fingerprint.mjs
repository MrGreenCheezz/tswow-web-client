/**
 * Content fingerprint for a comparison run against WoW 3.3.5a.
 *
 * Run from the repository root and save stdout beside the scene capture. The manifest covers
 * current files, including uncommitted edits and locally generated protocol/client tables, so a
 * Git commit alone cannot be mistaken for the actual code that produced a frame. It deliberately
 * excludes caches, extracted game resources and credentials; those need separate source metadata.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourceDirectories = ['src', 'tools', 'tests', 'bench', 'examples', 'public', 'data/ui'];
const rootFiles = [
  'index.html', 'glue.html', 'framexml.html', 'character-lab.html',
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.mjs',
];
const codeExtensions = new Set(['.ts', '.tsx', '.mjs', '.js', '.json', '.html', '.css', '.svg', '.lua', '.xml', '.toc', '.dbd', '.ps1']);
const excludedDirectories = new Set(['node_modules', 'dist', 'cache', 'results', 'icons', 'creature-icons', 'portraits']);
const excludedPaths = new Set(['bench/build']);

function relativeName(path) {
  return relative(root, path).replaceAll('\\', '/');
}

function isSourceFile(path) {
  const name = relativeName(path);
  const extension = extname(name).toLowerCase();
  return codeExtensions.has(extension) || (name.startsWith('public/ui/') && extension === '.png');
}

async function collect(path, result) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name) && !excludedPaths.has(relativeName(child))) {
        await collect(child, result);
      }
    } else if (entry.isFile() && isSourceFile(child)) {
      result.push(child);
    }
  }
}

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const paths = [];
for (const directory of sourceDirectories) await collect(join(root, directory), paths);
for (const name of rootFiles) {
  try {
    await readFile(join(root, name));
    paths.push(join(root, name));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
paths.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);

const files = [];
const aggregate = createHash('sha256');
for (const path of paths) {
  const name = relativeName(path);
  const contents = await readFile(path);
  const sha256 = createHash('sha256').update(contents).digest('hex');
  files.push({ path: name, sha256 });
  aggregate.update(name).update('\0').update(sha256).update('\n');
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  gitHead: git('rev-parse', 'HEAD'),
  gitBranch: git('branch', '--show-current'),
  scope: 'runtime source, generator schemas, build/test scripts and source UI art; excludes caches, extracted resources, credentials',
  sha256: aggregate.digest('hex'),
  fileCount: files.length,
  files,
}, null, 2)}\n`);
