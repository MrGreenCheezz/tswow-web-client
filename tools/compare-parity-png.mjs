/**
 * Diagnostic PNG comparison for paired original WoW / WebClient captures.
 * Images must already have the same camera, scale, resolution and frame timing.
 * This tool measures differences; it does not decide whether a scene passes.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const usage = `Usage: node tools/compare-parity-png.mjs \\
  --original original-1.png [--original original-2.png ...] \\
  --webclient webclient.png --out-dir output-directory \\
  [--regions regions.json] [--threshold 16]

regions.json: [{"name":"world","x":0,"y":0,"width":1280,"height":600}]
The full frame is always measured. The threshold affects only the changed-pixel
fraction; it is a diagnostic pixel threshold, not an acceptance threshold.\n`;

function parseArguments(args) {
  const options = { originals: [], threshold: 16 };
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === '--help' || option === '-h') return { help: true };
    if (!['--original', '--webclient', '--out-dir', '--regions', '--threshold'].includes(option)) {
      throw new Error(`Unknown argument: ${option}`);
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
    if (option === '--original') options.originals.push(value);
    else if (option === '--webclient') options.webclient = value;
    else if (option === '--out-dir') options.outDir = value;
    else if (option === '--regions') options.regions = value;
    else options.threshold = Number(value);
  }
  if (!options.originals.length || !options.webclient || !options.outDir) {
    throw new Error('At least one --original, --webclient and --out-dir are required.');
  }
  if (!Number.isInteger(options.threshold) || options.threshold < 0 || options.threshold > 255) {
    throw new Error('--threshold must be an integer from 0 to 255.');
  }
  return options;
}

async function loadImage(path) {
  const image = PNG.sync.read(await readFile(path));
  if (!image.width || !image.height || image.data.length !== image.width * image.height * 4) {
    throw new Error(`Invalid RGBA PNG: ${path}`);
  }
  return image;
}

function validateRegions(specification, width, height) {
  if (specification !== undefined && !Array.isArray(specification)) {
    throw new Error('Region file must contain a JSON array.');
  }
  const regions = [{ name: 'full', x: 0, y: 0, width, height }];
  const names = new Set(['full']);
  for (const region of specification ?? []) {
    if (!region || typeof region.name !== 'string' || !region.name.trim() || names.has(region.name)) {
      throw new Error('Every region needs a unique, nonempty name other than "full".');
    }
    if (![region.x, region.y, region.width, region.height].every(Number.isInteger) ||
        region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 ||
        region.x + region.width > width || region.y + region.height > height) {
      throw new Error(`Region "${region.name}" is outside the ${width}x${height} image.`);
    }
    names.add(region.name);
    regions.push({ name: region.name, x: region.x, y: region.y,
      width: region.width, height: region.height });
  }
  return regions;
}

function compareRegion(first, second, region, threshold) {
  let absolute = 0;
  let squared = 0;
  let changed = 0;
  let maxChannelDifference = 0;
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      const offset = (y * first.width + x) * 4;
      let pixelMaximum = 0;
      // Captures are expected to be opaque; compare their visible RGB on black
      // if a PNG does contain transparency.
      for (let channel = 0; channel < 3; channel++) {
        const a = Math.round(first.data[offset + channel] * first.data[offset + 3] / 255);
        const b = Math.round(second.data[offset + channel] * second.data[offset + 3] / 255);
        const difference = Math.abs(a - b);
        absolute += difference;
        squared += difference * difference;
        pixelMaximum = Math.max(pixelMaximum, difference);
      }
      if (pixelMaximum > threshold) changed++;
      maxChannelDifference = Math.max(maxChannelDifference, pixelMaximum);
    }
  }
  const pixels = region.width * region.height;
  return {
    pixelCount: pixels,
    meanAbsoluteErrorRgb: absolute / (pixels * 3 * 255),
    rootMeanSquareErrorRgb: Math.sqrt(squared / (pixels * 3)) / 255,
    changedPixelFraction: changed / pixels,
    maxChannelDifference,
  };
}

function summarize(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    min: sorted[0],
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    max: sorted.at(-1),
  };
}

function makeDiagnosticImages(original, webclient) {
  const overlay = new PNG({ width: original.width, height: original.height });
  const heatmap = new PNG({ width: original.width, height: original.height });
  for (let offset = 0; offset < original.data.length; offset += 4) {
    let maximum = 0;
    for (let channel = 0; channel < 3; channel++) {
      const a = Math.round(original.data[offset + channel] * original.data[offset + 3] / 255);
      const b = Math.round(webclient.data[offset + channel] * webclient.data[offset + 3] / 255);
      overlay.data[offset + channel] = Math.round((a + b) / 2);
      maximum = Math.max(maximum, Math.abs(a - b));
    }
    overlay.data[offset + 3] = 255;
    // Fourfold brightness makes small errors visible. Use JSON metrics for magnitude.
    heatmap.data[offset] = Math.min(255, maximum * 4);
    heatmap.data[offset + 1] = 0;
    heatmap.data[offset + 2] = 0;
    heatmap.data[offset + 3] = 255;
  }
  return { overlay, heatmap };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  const originalPaths = options.originals.map((path) => resolve(path));
  const webclientPath = resolve(options.webclient);
  const [webclient, ...originals] = await Promise.all(
    [webclientPath, ...originalPaths].map(loadImage),
  );
  for (const [index, original] of originals.entries()) {
    if (original.width !== webclient.width || original.height !== webclient.height) {
      throw new Error(`Image size mismatch: original ${index + 1} is ${original.width}x${original.height}; ` +
        `WebClient is ${webclient.width}x${webclient.height}. Align captures before comparing.`);
    }
  }
  const regionSpecification = options.regions
    ? JSON.parse(await readFile(options.regions, 'utf8')) : undefined;
  const regions = validateRegions(regionSpecification, webclient.width, webclient.height);
  const report = {
    schemaVersion: 1,
    width: webclient.width,
    height: webclient.height,
    rgbCompositeBackground: 'black',
    diagnosticChangedPixelThreshold: options.threshold,
    acceptanceThreshold: null,
    referenceOriginal: basename(originalPaths[0]),
    webclient: basename(webclientPath),
    originalImages: originalPaths.map((path) => basename(path)),
    regions: regions.map((region) => {
      const webclientToOriginal = originals.map((original, index) => ({
        originalIndex: index,
        ...compareRegion(original, webclient, region, options.threshold),
      }));
      const originalPairs = [];
      for (let i = 0; i < originals.length; i++) {
        for (let j = i + 1; j < originals.length; j++) {
          originalPairs.push({ originalIndices: [i, j],
            ...compareRegion(originals[i], originals[j], region, options.threshold) });
        }
      }
      return {
        ...region,
        webclientToOriginal,
        webclientMaeRange: summarize(webclientToOriginal.map((item) => item.meanAbsoluteErrorRgb)),
        originalRepeatPairs: originalPairs,
        originalRepeatMaeRange: summarize(originalPairs.map((item) => item.meanAbsoluteErrorRgb)),
      };
    }),
  };
  const outputDirectory = resolve(options.outDir);
  await mkdir(outputDirectory, { recursive: true });
  const { overlay, heatmap } = makeDiagnosticImages(originals[0], webclient);
  await Promise.all([
    writeFile(join(outputDirectory, 'metrics.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(join(outputDirectory, 'overlay.png'), PNG.sync.write(overlay)),
    writeFile(join(outputDirectory, 'heatmap.png'), PNG.sync.write(heatmap)),
  ]);
  process.stdout.write(`${join(outputDirectory, 'metrics.json')}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n${usage}`);
    process.exitCode = 1;
  });
}
