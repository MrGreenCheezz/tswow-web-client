import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { captureNativeProfile } from '../tools/parity-native-profile.mjs';

test('native profile reports only allowlisted settings and redacts profile identities and unknown add-ons', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webclient-native-profile-'));
  const profile = join(root, 'WTF/Account/PrivateAccount/PrivateRealm/PrivateCharacter/AddOns.txt');
  const installed = join(root, 'Interface/AddOns');
  try {
    await mkdir(dirname(profile), { recursive: true });
    await mkdir(join(installed, '!WCollectionsLoader'), { recursive: true });
    await mkdir(join(installed, 'PrivateCharacter'), { recursive: true });
    await writeFile(join(root, 'WTF/Config.wtf'), [
      'SET accountName "PrivateAccount"',
      'SET realmName "PrivateRealm"',
      'SET gxResolution "2560x1440"',
      'SET farclip "1277"',
      'SET locale "ruRU"',
      'SET uiScale "PrivateCharacter"',
      '',
    ].join('\n'));
    await writeFile(profile, '!WCollectionsLoader: disabled\nPrivateCharacter: enabled\n');

    const captured = await captureNativeProfile(root);
    assert.deepEqual(captured.config.values, { farclip: '1277', gxResolution: '2560x1440', locale: 'ruRU' });
    assert.equal(captured.config.rejectedAllowedValues, 1);
    assert.equal(captured.addOns.scannedFileCount, 1);
    assert.deepEqual(captured.addOns.profiles[0].explicitDisabled, ['!WCollectionsLoader']);
    assert.deepEqual(captured.addOns.profiles[0].explicitEnabled, []);
    assert.equal(captured.addOns.profiles[0].redactedEntries, 1);
    const output = JSON.stringify(captured);
    for (const secret of ['PrivateAccount', 'PrivateRealm', 'PrivateCharacter']) {
      assert.equal(output.includes(secret), false);
    }
  } finally {
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('webclient-native-profile-')) {
      throw new Error(`Refusing to remove an unexpected test directory: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
  }
});
