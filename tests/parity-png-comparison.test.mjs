import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';

function image(changedPixel, red) {
  const png = new PNG({ width: 4, height: 2 });
  png.data.fill(0);
  for (let pixel = 0; pixel < 8; pixel++) png.data[pixel * 4 + 3] = 255;
  if (changedPixel !== null) png.data[changedPixel * 4] = red;
  return PNG.sync.write(png);
}

test('PNG comparison distinguishes a WebClient mismatch from natural original-frame variation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'webclient-parity-png-'));
  try {
    const first = join(directory, 'original-1.png');
    const second = join(directory, 'original-2.png');
    const webclient = join(directory, 'webclient.png');
    const regions = join(directory, 'regions.json');
    const output = join(directory, 'output');
    await Promise.all([
      writeFile(first, image(null, 0)),
      writeFile(second, image(0, 10)),
      writeFile(webclient, image(2, 100)),
      writeFile(regions, JSON.stringify([
        { name: 'left', x: 0, y: 0, width: 2, height: 2 },
        { name: 'right', x: 2, y: 0, width: 2, height: 2 },
      ])),
    ]);
    execFileSync(process.execPath, [
      'tools/compare-parity-png.mjs', '--original', first, '--original', second,
      '--webclient', webclient, '--regions', regions, '--out-dir', output,
    ], { cwd: new URL('..', import.meta.url) });

    const report = JSON.parse(await readFile(join(output, 'metrics.json'), 'utf8'));
    assert.equal(report.acceptanceThreshold, null);
    assert.deepEqual(report.regions.map((region) => region.name), ['full', 'left', 'right']);
    const [full, left, right] = report.regions;
    const tolerance = 1e-12;
    assert.ok(Math.abs(full.originalRepeatMaeRange.max - 10 / (8 * 3 * 255)) < tolerance);
    assert.ok(Math.abs(full.webclientMaeRange.min - 100 / (8 * 3 * 255)) < tolerance);
    assert.ok(Math.abs(full.webclientMaeRange.max - 110 / (8 * 3 * 255)) < tolerance);
    assert.equal(left.webclientToOriginal[0].meanAbsoluteErrorRgb, 0);
    assert.equal(right.webclientToOriginal[0].changedPixelFraction, 1 / 4);
    assert.equal(right.originalRepeatPairs[0].meanAbsoluteErrorRgb, 0);

    const overlay = PNG.sync.read(await readFile(join(output, 'overlay.png')));
    const heatmap = PNG.sync.read(await readFile(join(output, 'heatmap.png')));
    assert.equal(overlay.data[2 * 4], 50, 'overlay blends the first original and WebClient');
    assert.equal(heatmap.data[2 * 4], 255, 'heatmap marks the different pixel');
    assert.equal(heatmap.data[1 * 4], 0, 'heatmap leaves matching pixels black');
  } finally {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('webclient-parity-png-')) {
      throw new Error(`Refusing to remove an unexpected test directory: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
  }
});
