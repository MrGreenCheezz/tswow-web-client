import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { pruneCompileCache, transpileCached } from '../tools/test-compile-cache.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'webclient-compile-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('an unchanged source comes from disk, an edited source compiles again', (t) => {
  const directory = temporaryDirectory(t);
  assert.equal(transpileCached('a.ts', 'export const a: number = 1;\n', directory), 'export const a = 1;\n');
  const [entry] = readdirSync(directory);
  writeFileSync(join(directory, entry), '// served from disk\n');
  assert.equal(transpileCached('a.ts', 'export const a: number = 1;\n', directory), '// served from disk\n');

  assert.equal(transpileCached('a.ts', 'export const a: number = 2;\n', directory), 'export const a = 2;\n');
  assert.equal(readdirSync(directory).length, 2);
  assert.equal(readFileSync(join(directory, entry), 'utf8'), '// served from disk\n');
});

test('the output is the compiler\'s own and one text has one entry, wherever the file lies', (t) => {
  const directory = temporaryDirectory(t);
  const text = 'import type { A } from "./a.js";\nimport { b } from "./b.js";\nexport class C<T> { #d: T | A = b as T; get d() { return this.#d; } }\n';
  const expected = ts.transpileModule(text, {
    fileName: 'a.ts',
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  assert.equal(transpileCached(join(root, 'src', 'a.ts'), text, directory), expected);
  assert.equal(transpileCached(join(root, 'other', 'src', 'a.ts'), text, directory), expected);
  assert.equal(readdirSync(directory).length, 1);
});

test('a cache that cannot be written costs a compile, not a test', (t) => {
  const file = join(temporaryDirectory(t), 'not-a-directory');
  writeFileSync(file, '');
  assert.equal(transpileCached('a.ts', 'export const a: number = 1;\n', file), 'export const a = 1;\n');
  assert.equal(transpileCached('a.ts', 'export const a: number = 1;\n', file), 'export const a = 1;\n');
});

test('four processes filling one cache leave whole entries and no temporary files', async (t) => {
  const directory = temporaryDirectory(t);
  const script = `
    import { transpileCached } from ${JSON.stringify(new URL('../tools/test-compile-cache.mjs', import.meta.url).href)};
    for (let index = 0; index < 10; index += 1) {
      const line = 'export const a' + index + ': number = ' + index + ';\\n';
      const output = transpileCached('a.ts', line.repeat(500), ${JSON.stringify(directory)});
      if (output !== ('export const a' + index + ' = ' + index + ';\\n').repeat(500)) process.exit(2);
    }`;
  const exits = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' }).on('exit', resolve).on('error', reject);
  })));
  assert.deepEqual(exits, [0, 0, 0, 0]);
  assert.equal(readdirSync(directory).length, 10);
  assert.equal(readdirSync(directory).every((name) => /^[0-9a-f]{64}\.js$/.test(name)), true);
});

test('the hook: a process whose sources did not change does not load typescript', () => {
  const script = `
    import { createRequire } from 'node:module';
    const { validAssetPath } = await import('./dist/code/gateway/AssetPath.js');
    const loaded = Object.keys(createRequire(import.meta.url).cache).some((path) => /typescript[\\\\/]lib[\\\\/]typescript\\.js$/.test(path));
    console.log(JSON.stringify({ works: validAssetPath('world/a.blp'), loaded }));`;
  const run = () => {
    const result = spawnSync(process.execPath, ['--import', './tools/register-test-sources.mjs', '--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(run().works, true);
  assert.deepEqual(run(), { works: true, loaded: false });
});

test('pruning drops what was written long ago, at most once a day', (t) => {
  const directory = temporaryDirectory(t);
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const writeOld = (name) => {
    writeFileSync(join(directory, name), '');
    utimesSync(join(directory, name), new Date(now - 15 * day), new Date(now - 15 * day));
  };
  writeFileSync(join(directory, 'recent.js'), '');
  writeOld('old.js');
  writeOld('old.js.1.0.tmp');
  pruneCompileCache(directory, now);
  assert.deepEqual(readdirSync(directory), ['pruned', 'recent.js']);

  writeOld('old.js');
  pruneCompileCache(directory, now + day / 2);
  assert.deepEqual(readdirSync(directory), ['old.js', 'pruned', 'recent.js']);
  pruneCompileCache(directory, now + 2 * day);
  assert.deepEqual(readdirSync(directory), ['pruned', 'recent.js']);

  pruneCompileCache(join(directory, 'absent'), now);
});
