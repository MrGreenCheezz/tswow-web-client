import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { disabledClientAddons, discoverClientAddons } from '../dist/code/gateway/ClientAddons.js';

test('AddOns.txt honors explicit disabled states without guessing from absent or conflicting lines', () => {
  assert.deepEqual([...disabledClientAddons([
    '!Loader: disabled', 'CORE: enabled', 'Core: disabled', 'Unlisted: enabled',
    '../escape: disabled', 'Plain: disabled',
  ].join('\n'))].sort(), ['!loader', 'plain']);
});

test('identical native profiles disable add-ons while divergent profiles require an explicit choice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webclient-addon-profile-'));
  try {
    for (const [name, toc] of [
      ['!Loader', 'Loader.lua\n'],
      ['Core', '## LoadOnDemand: 1\nCore.lua\n'],
      ['Optional', 'Optional.lua\n'],
      ['WCollections', 'Collections.lua\n'],
    ]) {
      const directory = join(root, 'Interface', 'AddOns', name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${name}.toc`), toc);
    }
    const first = join(root, 'WTF', 'Account', 'Local Account', 'Realm One', 'Character One', 'AddOns.txt');
    const second = join(root, 'WTF', 'Account', 'Local Account', 'Realm One', 'Character Two', 'AddOns.txt');
    await mkdir(join(root, 'WTF', 'Account', 'Local Account', 'Realm One', 'Character One'), { recursive: true });
    await mkdir(join(root, 'WTF', 'Account', 'Local Account', 'Realm One', 'Character Two'), { recursive: true });
    const shared = '!Loader: disabled\nWCollections: disabled\nOptional: enabled\n';
    await writeFile(first, shared);
    await writeFile(second, shared);

    const consensus = await discoverClientAddons(root);
    assert.deepEqual(consensus, [
      { name: 'Core', loadOnDemand: true },
      { name: 'Optional', loadOnDemand: false },
    ]);
    assert.ok(!JSON.stringify(consensus).includes('Local Account'), 'profile identity stays out of the public descriptor');

    await writeFile(second, 'Core: disabled\n');
    const ambiguous = await discoverClientAddons(root);
    assert.deepEqual(ambiguous.map((addon) => addon.name), ['!Loader', 'Core', 'Optional', 'WCollections']);

    const selected = await discoverClientAddons(root, {
      addonsFile: 'Account/Local Account/Realm One/Character One/AddOns.txt',
    });
    assert.deepEqual(selected, consensus);

    const outside = join(root, 'outside', 'AddOns.txt');
    await mkdir(join(root, 'outside'));
    await writeFile(outside, 'Core: disabled\n');
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => { warnings.push(String(message)); };
    try {
      const ignored = await discoverClientAddons(root, { addonsFile: outside });
      assert.deepEqual(ignored, ambiguous, 'a file outside CLIENT_DIR/WTF must not select an add-on state');
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(warnings.length > 0);
    assert.ok(warnings.every((warning) => !warning.includes(root) && !warning.includes('Local Account')),
      'warnings must not expose profile paths or names');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('includeDisabled lists profile-disabled add-ons too, and disabledByProfile names them (9.07)', async () => {
  const { disabledByProfile } = await import('../dist/code/gateway/ClientAddons.js');
  const root = await mkdtemp(join(tmpdir(), 'webclient-addon-disabled-'));
  try {
    for (const name of ['X', 'Kept']) {
      const directory = join(root, 'Interface', 'AddOns', name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${name}.toc`), `${name}.lua\n`);
    }
    // A directory with no TOC is not an add-on, disabled or not.
    await mkdir(join(root, 'Interface', 'AddOns', 'Blizzard_Stub'), { recursive: true });
    const profile = join(root, 'WTF', 'Account', 'A', 'R', 'C');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'AddOns.txt'), 'X: disabled\nMissing: disabled\nBlizzard_Stub: disabled\n');

    assert.deepEqual((await discoverClientAddons(root)).map((addon) => addon.name), ['Kept']);
    assert.deepEqual((await discoverClientAddons(root, { includeDisabled: true })).map((addon) => addon.name), ['Kept', 'X']);
    assert.deepEqual(await disabledByProfile(root), ['X'], 'only installed add-ons with a TOC are named');

    // Divergent profiles disable nothing, so nothing is named.
    const other = join(root, 'WTF', 'Account', 'A', 'R', 'D');
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'AddOns.txt'), 'Kept: disabled\n');
    assert.deepEqual(await disabledByProfile(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
