import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  heapProfileModeOfFile, measuredSpan, resultPathOfHeapProfile, scenarioOfHeapProfile, summarizeHeapProfile, survivorShares,
} from '../bench/analyze-heap-profile.mjs';

// P1-03a: the analyser reads `<scenario>.promoted.heapprofile` beside `<scenario>.heapprofile`.

const frame = (functionName, lineNumber = 4) => ({ functionName, url: 'http://127.0.0.1/vendor.js', lineNumber, columnNumber: 0 });
const node = (functionName, selfSize, children = []) => ({ callFrame: frame(functionName), selfSize, children });
const MB = 1048576;
// Two allocating nodes under a root: 3 MB in `#drawUnit`, 1 MB in `update` called from it.
const promotedProfile = { head: { callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 }, selfSize: 0,
  children: [node('drawUnit', 3 * MB, [node('update', 1 * MB)])] } };
const allProfile = { head: { callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 }, selfSize: 0,
  children: [node('drawUnit', 12 * MB, [node('update', 1 * MB)]), node('scavengeOnly', 3 * MB)] } };
const byName = (callFrame) => callFrame.functionName;

test('the mode, scenario and neighbouring result come from the file name', () => {
  assert.equal(heapProfileModeOfFile('bench/results/x/city.promoted.heapprofile'), 'promoted');
  assert.equal(heapProfileModeOfFile('bench/results/x/city.heapprofile'), 'all');
  assert.equal(scenarioOfHeapProfile('bench/results/x/world-crowd-64.promoted.heapprofile'), 'world-crowd-64');
  assert.equal(scenarioOfHeapProfile('city.heapprofile'), 'city');
  assert.equal(resultPathOfHeapProfile(join('r', 'stamp-1', 'city.heapprofile')).endsWith(join('r', 'stamp-1.json')), true);
});

test('self and inclusive sums, survivor shares in [0, 1] for nested profiles', () => {
  const promoted = summarizeHeapProfile(promotedProfile, byName);
  assert.equal(promoted.total, 4 * MB);
  assert.equal(promoted.self.get('drawUnit'), 3 * MB);
  assert.equal(promoted.inclusive.get('drawUnit'), 4 * MB);
  const all = summarizeHeapProfile(allProfile, byName);
  const shares = survivorShares(promoted.self, all.self);
  assert.equal(shares.get('drawUnit'), 0.25);
  assert.equal(shares.get('update'), 1);
  assert.equal(survivorShares(new Map([['only', 5]]), all.self).get('only'), null);
});

test('measured span is read from the scenario of the neighbouring result', () => {
  const result = { scenarios: [{ scenario: 'movement', summary: { frameCount: 100, measuredSeconds: 2 } },
    { scenario: 'city', summary: { frameCount: 200, measuredSeconds: 4 } }] };
  assert.deepEqual(measuredSpan(result, 'city'), { frameCount: 200, measuredSeconds: 4 });
  assert.throws(() => measuredSpan(result, 'world-crowd-64'), /no measured frames/);
});

test('the command labels a promoted profile and prints per-frame and survivor columns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'heap-profile-'));
  try {
    await mkdir(join(dir, 'stamp'));
    const promotedPath = join(dir, 'stamp', 'city.promoted.heapprofile');
    const allPath = join(dir, 'stamp', 'city.heapprofile');
    await writeFile(promotedPath, JSON.stringify(promotedProfile));
    await writeFile(allPath, JSON.stringify(allProfile));
    await writeFile(join(dir, 'stamp.json'), JSON.stringify({ scenarios: [{ scenario: 'city', summary: { frameCount: 1024, measuredSeconds: 8 } }] }));
    const script = fileURLToPath(new URL('../bench/analyze-heap-profile.mjs', import.meta.url));
    const run = (args) => promisify(execFile)(process.execPath, [script, ...args, '--map', join(dir, 'none.map')]);
    const { stdout } = await run([promotedPath, '--per-frame', '--vs', allPath]);
    const lines = stdout.split('\n');
    assert.match(lines[0], /^\s+4\.0 MB promoted\s+4\.00 KB\/frame\s+0\.50 MB\/s$/);
    assert.match(stdout, /1024 frames, 8\.00 s measured/);
    assert.match(stdout, /16\.0 MB sampled in city\.heapprofile; survivor share 25\.0%/);
    assert.match(stdout, /3\.0 MB  75\.0%\s+3\.00 KB\/frame\s+0\.38 MB\/s\s+25\.0%  drawUnit vendor\.js:5/);
    const plain = (await run([allPath])).stdout;
    assert.match(plain.split('\n')[0], /^\s+16\.0 MB sampled$/, 'mode all keeps the old heading');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
