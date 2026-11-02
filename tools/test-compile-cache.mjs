import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';

// Transpiled TypeScript for tools/register-test-sources.mjs, kept on disk between test processes so
// that a process whose sources did not change never loads `typescript`. The entry name hashes the
// source text, the compiler version and the options: an edited source is a miss by construction, and
// worktrees and branches share one entry for one text. The path is not hashed because the options
// emit no source map and every source is .ts, so the output does not depend on it.
const require = createRequire(import.meta.url);
const compilerOptions = { target: 'es2022', module: 'es2022' };
const compiler = JSON.stringify([
  JSON.parse(readFileSync(require.resolve('typescript/package.json'), 'utf8')).version,
  compilerOptions,
]);
const defaultDirectory = fileURLToPath(new URL('../.runtime/test-compile-cache/', import.meta.url));
const pruneEveryMs = 24 * 60 * 60 * 1000;
const maxAgeMs = 14 * pruneEveryMs;

// Up to four processes write here at once (tools/run-tests.mjs). The entry appears whole or not at
// all, and it is flushed first so that a power cut cannot rename an unwritten file into place. On
// Windows the rename fails with EPERM while another process reads the target, which is then the same
// text. The cache only saves time: a full disk costs a compile next time, never a test.
function store(directory, entry, output) {
  const temporary = `${entry}.${process.pid}.${threadId}.tmp`;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporary, output, { flush: true });
    renameSync(temporary, entry);
  } catch {
    try { rmSync(temporary, { force: true }); } catch {}
  }
}

export function transpileCached(sourcePath, text, directory = defaultDirectory) {
  const hash = createHash('sha256').update(compiler).update('\0').update(text).digest('hex');
  const entry = join(directory, `${hash}.js`);
  try {
    return readFileSync(entry, 'utf8');
  } catch {}
  const output = require('typescript').transpileModule(text, { fileName: sourcePath, compilerOptions }).outputText;
  store(directory, entry, output);
  return output;
}

/**
 * Once a day drops what was written long ago, so old versions of edited sources do not pile up; a
 * live entry just compiles again. Once a day because looking at every entry takes 33 ms, a tenth of
 * a small test file's whole run.
 */
export function pruneCompileCache(directory = defaultDirectory, now = Date.now()) {
  const stamp = join(directory, 'pruned');
  try {
    if (now - statSync(stamp).mtimeMs < pruneEveryMs) return;
  } catch {}
  let names;
  try {
    names = readdirSync(directory);
    writeFileSync(stamp, '');
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(directory, name);
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) rmSync(path, { force: true });
    } catch {}
  }
}
