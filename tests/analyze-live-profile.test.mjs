import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { SourceMapGenerator } = createRequire(import.meta.url)('source-map-js');

// A freeze window is the gap before a long animation frame: samples inside it are attributed through
// the build's source map to source functions; samples outside it count as ordinary frame cost.
test('freeze windows name source functions through the build source map', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'analyze-live-profile-'));
  try {
    const map = new SourceMapGenerator({ file: 'main-abc.js' });
    // Minified line 1: `a` at column 10 is decodeTile, `b` at column 40 is drawFrame.
    map.addMapping({ generated: { line: 1, column: 9 }, original: { line: 120, column: 2 },
      source: '../../src/browser/Terrain.ts', name: 'decodeTile' });
    map.addMapping({ generated: { line: 1, column: 39 }, original: { line: 50, column: 0 },
      source: '../../src/browser/game/Loop.ts', name: 'drawFrame' });
    await mkdir(join(directory, 'maps', 'assets'), { recursive: true });
    await writeFile(join(directory, 'maps', 'assets', 'main-abc.js.map'), map.toString());
    // The shipped bundle, so a Long Animation Frame's character offset resolves to a line/column.
    await mkdir(join(directory, 'web', 'assets'), { recursive: true });
    await writeFile(join(directory, 'web', 'assets', 'main-abc.js'), 'x'.repeat(60));
    const capture = {
      version: 2, recordedAt: '2026-09-27T00:00:00.000Z', entrySupport: { jsProfiler: 'enabled' },
      frameColumns: ['rafAtMs', 'callbackStartMs', 'cpuMs', 'intervalMs', 'failed'],
      frames: [[100, 100, 5, 16, 0], [116, 116, 5, 16, 0], [236, 236, 6, 120, 0], [252, 252, 5, 16, 0]],
      summary: { intervals: { count: 4 } },
      events: {
        slowPackets: [{ atMs: 150, opcode: 0x1f6, bytes: 9000, ms: 60 }],
        longAnimationFrames: [{ atMs: 120, durationMs: 110, blockingDurationMs: 60,
          scripts: [{ file: 'main-abc.js', function: 'a', charPosition: 12, invokerType: 'user-callback',
            invoker: 'FrameRequestCallback', durationMs: 100 }] }],
        checkpoints: [{ atMs: 90, heap: { usedMB: 400, totalMB: 500 } }, { atMs: 300, heap: { usedMB: 320, totalMB: 500 } }],
      },
      jsProfile: {
        sampleIntervalMs: 16, bufferFull: false, resources: ['main-abc.js'],
        frames: [['a', 0, 1, 10], ['b', 0, 1, 40]],
        stacks: [[1, -1], [0, 0]],
        // Inside (116, 236]: decodeTile under drawFrame twice, drawFrame alone, then idle until 250
        // (billed at most two periods). 110, 250 and 266 are ordinary frames.
        samples: { atMs: [110, 130, 146, 162, 178, 250, 266], stackId: [0, 1, 1, 0, -1, 0, 0] },
      },
    };
    const input = join(directory, 'capture.json'), output = join(directory, 'report.json');
    await writeFile(input, JSON.stringify(capture));
    execFileSync(process.execPath, ['bench/analyze-live-profile.mjs', input, '--maps', join(directory, 'maps'),
      '--web', join(directory, 'web'), '--out', output], { stdio: 'pipe' });
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.profile.framesResolvedBySourceMap, 2);
    assert.equal(report.summary.longWindows, 1);
    const [window] = report.windows;
    assert.equal(window.fromMs, 116);
    assert.equal(window.toMs, 236);
    assert.equal(window.profile.self[0].what, 'decodeTile (src/browser/Terrain.ts:120)');
    assert.equal(window.profile.self[0].ms, 32, 'two samples of 16 ms each');
    assert.equal(window.profile.idleMs, 32, 'a gap in sampling is capped at two periods');
    assert.deepEqual(window.profile.inclusive.map((row) => row.what),
      ['drawFrame (src/browser/game/Loop.ts:50)', 'decodeTile (src/browser/Terrain.ts:120)']);
    assert.equal(window.slowPackets[0].opcode, 0x1f6);
    assert.ok(window.longAnimationFrames[0].scripts[0].endsWith('@decodeTile (src/browser/Terrain.ts:120)'),
      'a LoAF entry point is named through the bundle offset and the map');
    assert.deepEqual(window.heap, { beforeMB: 400, afterMB: 320, deltaMB: -80 });
    assert.equal(report.ordinary.self[0].what, 'drawFrame (src/browser/game/Loop.ts:50)',
      'samples outside every window are the ordinary cost');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
