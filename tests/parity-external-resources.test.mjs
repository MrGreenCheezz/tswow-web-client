import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { contentTree } from '../tools/parity-external-resources.mjs';

test('external content fingerprint binds file paths and detects a same-size, same-mtime rewrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webclient-external-fingerprint-'));
  try {
    await mkdir(join(root, 'nested'));
    const table = join(root, 'Spell.dbc');
    await writeFile(table, 'WDBC-one');
    await writeFile(join(root, 'nested', 'Map.dbc'), 'WDBC-two');
    const selected = new Set(['spell.dbc']);
    const original = await contentTree(root, selected);
    assert.equal(original.files, 2);
    assert.equal(original.bytes, 16);
    assert.equal(original.sha256,
      '467f91a6405cf85ea55eb246cef45bd51269541fdd1528ef74901201cb4915fd',
      'the path ordering and digest serialization are part of the manifest format');
    assert.equal((await contentTree(root, selected)).sha256, original.sha256);
    assert.deepEqual(Object.keys(original.targets), ['spell.dbc']);

    const before = await stat(table);
    await writeFile(table, 'WDBC-owo');
    await utimes(table, before.atime, before.mtime);
    const edited = await contentTree(root, selected);
    assert.notEqual(edited.sha256, original.sha256,
      'content identity must not rely on file size or modification time');
    assert.notEqual(edited.targets['spell.dbc'].sha256, original.targets['spell.dbc'].sha256);

    await rename(table, join(root, 'Other.dbc'));
    const renamed = await contentTree(root, selected);
    assert.notEqual(renamed.sha256, edited.sha256, 'path identity is part of the digest');
    assert.deepEqual(renamed.targets, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
