import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';

const sourceScript = resolve(import.meta.dirname, '../tools/parity-fingerprint.mjs');

test('parity fingerprint tracks source inputs and ignores generated output and secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'webclient-parity-fingerprint-'));
  const script = join(directory, 'tools/parity-fingerprint.mjs');
  const generatedTable = join(directory, 'src/generated/protocol-data/opcodes.ts');
  const schema = join(directory, 'tools/dbd/Spell.dbd');
  const benchmark = join(directory, 'bench/cpu-policy.ps1');
  const sourceArt = join(directory, 'public/ui/background.png');
  const generatedBundle = join(directory, 'bench/build/harness.js');
  const extractedIcon = join(directory, 'public/icons/icon.png');
  const secret = join(directory, '.env');

  function fingerprint() {
    return JSON.parse(execFileSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' }));
  }

  try {
    for (const path of [script, generatedTable, schema, benchmark, sourceArt, generatedBundle, extractedIcon]) {
      await mkdir(dirname(path), { recursive: true });
    }
    await copyFile(sourceScript, script);
    await Promise.all([
      writeFile(schema, 'LAYOUT 12340\n'),
      writeFile(generatedTable, 'export const OPCODE = 1;\n'),
      writeFile(benchmark, 'Write-Output benchmark\n'),
      writeFile(sourceArt, Buffer.from([137, 80, 78, 71])),
      writeFile(generatedBundle, 'generated = true;\n'),
      writeFile(extractedIcon, Buffer.from([137, 80, 78, 71])),
      writeFile(secret, 'PRIVATE_TOKEN=do-not-hash\n'),
    ]);

    const first = fingerprint();
    const second = fingerprint();
    assert.equal(first.sha256, second.sha256);
    assert.deepEqual(first.files, second.files);
    assert.deepEqual(first.files.map(({ path }) => path), [
      'bench/cpu-policy.ps1',
      'public/ui/background.png',
      'src/generated/protocol-data/opcodes.ts',
      'tools/dbd/Spell.dbd',
      'tools/parity-fingerprint.mjs',
    ]);

    await writeFile(sourceArt, Buffer.from([137, 80, 78, 72]));
    const changedArt = fingerprint();
    assert.notEqual(changedArt.sha256, first.sha256);

    await writeFile(schema, 'LAYOUT 12341\n');
    const changedSchema = fingerprint();
    assert.notEqual(changedSchema.sha256, changedArt.sha256);

    await writeFile(generatedTable, 'export const OPCODE = 2;\n');
    const changedGeneratedTable = fingerprint();
    assert.notEqual(changedGeneratedTable.sha256, changedSchema.sha256);

    await Promise.all([
      writeFile(generatedBundle, 'generated = false;\n'),
      writeFile(extractedIcon, Buffer.from([1, 2, 3, 4])),
      writeFile(secret, 'PRIVATE_TOKEN=another-secret\n'),
    ]);
    assert.equal(fingerprint().sha256, changedGeneratedTable.sha256);
  } finally {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('webclient-parity-fingerprint-')) {
      throw new Error(`Refusing to remove an unexpected test directory: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
  }
});
