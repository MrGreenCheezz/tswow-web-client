import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';

const sourceScript = resolve(import.meta.dirname, '../tools/parity-core-fingerprint.mjs');

test('core fingerprint tracks edited gameplay sources and excludes unrelated files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'webclient-core-fingerprint-'));
  const script = join(directory, 'tools/parity-core-fingerprint.mjs');
  const game = join(directory, 'core/src/server/game');
  const handler = join(game, 'Handlers/QuestHandler.cpp');
  const header = join(game, 'Server/Protocol/Opcodes.h');
  const unrelated = join(directory, 'core/src/server/shared/Log.cpp');
  const note = join(game, 'README.txt');

  function fingerprint() {
    return JSON.parse(execFileSync(process.execPath, [script], {
      cwd: directory,
      env: { ...process.env, TRINITYCORE_DIR: join(directory, 'core') },
      encoding: 'utf8',
    }));
  }

  try {
    for (const path of [script, handler, header, unrelated]) await mkdir(dirname(path), { recursive: true });
    await copyFile(sourceScript, script);
    await writeFile(join(directory, 'tools/env.mjs'), '');
    await writeFile(handler, 'void handle() {}\n');
    await writeFile(header, '#define OPCODE 1\n');
    await writeFile(unrelated, 'void log() {}\n');
    await writeFile(note, 'not gameplay source\n');

    const first = fingerprint();
    assert.deepEqual(first.files.map(({ path }) => path), [
      'Handlers/QuestHandler.cpp', 'Server/Protocol/Opcodes.h',
    ]);
    assert.equal(first.sha256, fingerprint().sha256);

    await writeFile(handler, 'void handle() { changed(); }\n');
    const changed = fingerprint();
    assert.notEqual(changed.sha256, first.sha256);

    await writeFile(unrelated, 'void log() { changed(); }\n');
    await writeFile(note, 'changed note\n');
    assert.equal(fingerprint().sha256, changed.sha256);
  } finally {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('webclient-core-fingerprint-')) {
      throw new Error(`Refusing to remove an unexpected test directory: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
  }
});
