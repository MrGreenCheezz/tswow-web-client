// 23.10 (7.48): builds an HD texture set — client textures upscaled by a neural network on the GPU.
//
//   node tools/upscale-textures.mjs --set effects            build or bring up to date the effects set
//   node tools/upscale-textures.mjs --set effects --dry-run  say what would be done, touch nothing
//
// Options: --model realesr-animevideov3 (default; see MODEL below), --batch 150 (textures per GPU run),
// --max-side 512 (the largest side an upscaled texture may reach; 256 keeps ×4 to 64 px sources and ×2 to 128),
// --only <text> (paths containing it), --out <dir> (default HD_TEXTURE_DIR or .runtime/hd-textures),
// --gpu <id>, --lock-script <gpu-lock.mjs> --lock-owner <name> (wraps every GPU run in
// `node <script> acquire|release <name>`, released between batches and on failure), --restamp-only (no GPU:
// only refresh the stamps of entries whose BLP bytes did not change — what the gateway runs by itself when a
// TSWoW build republished the patch archives; an entry whose bytes did change waits for a full run).
//
// What it writes, in <out>/<set>/ (git-ignored: generated from the owner's client, never published to git):
// - `<id>.png` — one HD texture, `id` = sha1("hd-texture-v1\0<path>") (src/gateway/HdTextures.ts computes the
//   same name; the gateway never takes a file name from a request or from the manifest);
// - `<id>.png.src` — the same source stamp `data/textures` carries (tools/source-stamp.mjs): which archive won
//   the path. The gateway serves the HD copy only while that stamp matches the client as it is now, so a patch
//   that replaces the BLP falls back to the original at once; rerunning this tool rebuilds the entry (or only
//   restamps it when the BLP bytes did not change);
// - `manifest.json` — path → { scale, size, source sha1, grid, wrap }, plus the model and pipeline version. The
//   gateway's HD generation is a digest of it, so a rebuilt set reaches browsers under new URLs.
//
// Resumable: the manifest is rewritten after every batch and an entry whose source sha1, scale, model and
// pipeline match (and whose file is there) is skipped. Parallel-safe: one run per set at a time (a lock
// directory in the set), each run works in its own temporary folder, every file is renamed into place.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { decodeBlp } from "./blp.mjs";
import { effectsSet, worldSet, SET_NAMES } from "./hd-texture-set.mjs";
import { assemble, buildWorkImages, effectScale, fidelity, planLayout, ALPHA_SNAP, FIDELITY_LIMIT } from "./hd-texture-image.mjs";
import { downsample, MODELS, nativeScale, upscaleDirectory } from "./hd-texture-upscaler.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, repositoryRoot } from "./paths.mjs";
import { stampGenerated, stampIsCurrent, writeFileAtomic } from "./source-stamp.mjs";

/** Bumped when the pixel pipeline changes (padding, alpha handling, assembly), so every entry is rebuilt. */
export const PIPELINE = `hd-pipeline-2/pad8/snap${ALPHA_SNAP}/x4box`;
export const MANIFEST_SCHEMA = "hd-textures-1";
/**
 * 23.10: realesr-animevideov3. Compared on eight effect textures against realesrgan-x4plus and x4plus-anime
 * (.runtime/lane-upscale/compare/): x4plus draws hair-like streaks into soft smoke and cloud sheets and rings
 * dark outlines round runes; x4plus-anime flattens smoke into cel blobs and darkens it; animevideov3 keeps the
 * soft shapes soft and the hard edges clean, and is 4.7× faster (0.9 s against 4.3 s).
 */
export const MODEL = "realesr-animevideov3";

/** The same name the gateway computes (src/gateway/HdTextures.ts `hdTextureId`). */
export function hdTextureId(path) {
  return createHash("sha1").update(`hd-texture-v1\0${path.replaceAll("/", "\\").toLowerCase()}`).digest("hex");
}

export function hdTextureDirectory() {
  return resolve(process.env.HD_TEXTURE_DIR ?? join(repositoryRoot, ".runtime", "hd-textures"));
}

/** How a set decides each texture's scale. `world` is the later step: ×2 for up to 256 px a side. */
export const SCALE_POLICY = {
  effects: (width, height, maxSide = 512) => effectScale(width, height, maxSide),
  world: (width, height, maxSide = 1024) => (Math.max(width, height) <= 256 && Math.max(width, height) * 2 <= maxSide ? 2 : 1),
};

/** Whether a manifest entry still describes what would be built now. */
export function entryUpToDate(entry, wanted) {
  return entry !== undefined && entry.sourceSha1 === wanted.sourceSha1 && entry.scale === wanted.scale
    && entry.model === wanted.model && entry.pipeline === wanted.pipeline
    && JSON.stringify(entry.grid) === JSON.stringify(wanted.grid) && entry.wrap === wanted.wrap;
}

export function readManifest(file) {
  try {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (manifest?.schema === MANIFEST_SCHEMA && manifest.entries && typeof manifest.entries === "object") return manifest;
  } catch {
    // Absent or unreadable: start over.
  }
  return undefined;
}

function encodePng(image) {
  const png = new PNG({ width: image.width, height: image.height });
  png.data.set(image.data);
  return PNG.sync.write(png);
}

function decodePng(bytes) {
  const png = PNG.sync.read(bytes);
  return { width: png.width, height: png.height, data: png.data };
}

function parseArguments(argv) {
  const options = { set: undefined, model: MODEL, batch: 150, maxSide: undefined, only: undefined, out: undefined, gpu: undefined,
    lockScript: undefined, lockOwner: "upscale-textures", dryRun: false, restampOnly: false };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${name} needs a value`);
      return next;
    };
    switch (name) {
      case "--set": options.set = value(); break;
      case "--model": options.model = value(); break;
      case "--batch": options.batch = Number.parseInt(value(), 10); break;
      case "--max-side": options.maxSide = Number.parseInt(value(), 10); break;
      case "--only": options.only = value().replaceAll("/", "\\").toLowerCase(); break;
      case "--out": options.out = value(); break;
      case "--gpu": options.gpu = value(); break;
      case "--lock-script": options.lockScript = value(); break;
      case "--lock-owner": options.lockOwner = value(); break;
      case "--dry-run": options.dryRun = true; break;
      case "--restamp-only": options.restampOnly = true; break;
      default: throw new Error(`Unknown option ${name}`);
    }
  }
  if (!SET_NAMES.includes(options.set)) throw new Error(`--set must be one of ${SET_NAMES.join(", ")}`);
  if (!MODELS[options.model]) throw new Error(`--model must be one of ${Object.keys(MODELS).join(", ")}`);
  if (!Number.isInteger(options.batch) || options.batch < 1) throw new Error("--batch must be a positive integer");
  return options;
}

function lock(options, command) {
  if (!options.lockScript) return;
  const result = spawnSync(process.execPath, [options.lockScript, command, options.lockOwner], { stdio: "inherit" });
  if (command === "acquire" && result.status !== 0) throw new Error(`GPU lock was not acquired (${result.status})`);
}

/** One set directory, one run: the lock is a directory, created atomically; a stale one (2 h) is broken. */
function takeSetLock(setDirectory) {
  const lockDirectory = join(setDirectory, ".lock");
  try {
    mkdirSync(lockDirectory);
  } catch {
    if (Date.now() - statSync(lockDirectory).mtimeMs < 2 * 60 * 60 * 1000) {
      throw new Error(`Another run is building ${setDirectory} (remove ${lockDirectory} if it is not)`);
    }
    rmSync(lockDirectory, { recursive: true, force: true });
    mkdirSync(lockDirectory);
  }
  writeFileSync(join(lockDirectory, "pid"), String(process.pid));
  return () => rmSync(lockDirectory, { recursive: true, force: true });
}

async function writeManifest(file, manifest) {
  const sorted = Object.fromEntries(Object.entries(manifest.entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  await writeFileAtomic(file, `${JSON.stringify({ ...manifest, entries: sorted }, null, 1)}\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const started = Date.now();
  const setDirectory = join(options.out ? resolve(options.out) : hdTextureDirectory(), options.set);
  const manifestFile = join(setDirectory, "manifest.json");
  const archives = await clientArchives(clientDirectory());
  let releaseSetLock = () => undefined;
  try {
    const entries = options.set === "effects"
      ? await effectsSet(archives, (report) => console.log(`${report.models} spell models, ${report.read} read, ${report.missing} not in the client`))
      : await worldSet(archives);
    const selected = options.only ? entries.filter((entry) => entry.path.includes(options.only)) : entries;
    const previous = readManifest(manifestFile);
    const manifest = { schema: MANIFEST_SCHEMA, set: options.set, model: options.model, pipeline: PIPELINE,
      entries: { ...(previous?.entries ?? {}) } };
    const scaleOf = SCALE_POLICY[options.set];
    const queue = [];
    let upToDate = 0;
    let restamped = 0;
    let notScaled = 0;
    let undecodable = 0;
    if (!options.dryRun) {
      mkdirSync(setDirectory, { recursive: true });
      try {
        releaseSetLock = takeSetLock(setDirectory);
      } catch (error) {
        // A full run is building this set: it stamps every entry it writes, so a restamp has nothing to add.
        if (!options.restampOnly) throw error;
        console.log(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    for (const entry of selected) {
      const blp = await archives.read(entry.path);
      if (!blp) continue;
      let image;
      try {
        image = decodeBlp(blp);
      } catch {
        undecodable++;
        continue;
      }
      const scale = scaleOf(image.width, image.height, options.maxSide);
      const destination = join(setDirectory, `${hdTextureId(entry.path)}.png`);
      if (scale === 1) {
        notScaled++;
        if (manifest.entries[entry.path] && !options.dryRun) {
          delete manifest.entries[entry.path];
          rmSync(destination, { force: true });
          rmSync(`${destination}.src`, { force: true });
        }
        continue;
      }
      const layout = planLayout(image.width, image.height, { grids: entry.grids, wrap: entry.wrap, pad: 8 });
      const wanted = { sourceSha1: createHash("sha1").update(blp).digest("hex"), scale, model: options.model,
        pipeline: PIPELINE, grid: [layout.rows, layout.columns], wrap: layout.mode === "wrap" };
      if (entryUpToDate(manifest.entries[entry.path], wanted) && existsSync(destination)) {
        upToDate++;
        // Same bytes under a new archive (a republished patch): the HD copy is still right, only its stamp is not.
        if (!options.dryRun && !await stampIsCurrent(destination, archives, { paths: [entry.path] })) {
          await stampGenerated(destination, archives, { paths: [entry.path] });
          restamped++;
        }
        continue;
      }
      queue.push({ entry, image, layout, wanted, destination });
    }
    // A texture no spell model names any more leaves the set with its files (only on a full run).
    let pruned = 0;
    if (!options.only && !options.dryRun && !options.restampOnly) {
      const current = new Set(entries.map((entry) => entry.path));
      for (const path of Object.keys(manifest.entries)) {
        if (current.has(path)) continue;
        const destination = join(setDirectory, `${hdTextureId(path)}.png`);
        rmSync(destination, { force: true });
        rmSync(`${destination}.src`, { force: true });
        delete manifest.entries[path];
        pruned++;
      }
    }
    console.log(`${selected.length} textures in the ${options.set} set: ${upToDate} up to date (${restamped} restamped), `
      + `${queue.length} to build, ${notScaled} too large to upscale, ${undecodable} undecodable, ${pruned} pruned`);
    if (options.dryRun || options.restampOnly || queue.length === 0) {
      if (!options.dryRun && !options.restampOnly) await writeManifest(manifestFile, manifest);
      return;
    }

    let built = 0;
    let worst = 0;
    const rejected = [];
    let gpuMs = 0;
    let bytes = 0;
    const work = join(setDirectory, `.work-${process.pid}`);
    try {
      for (let first = 0; first < queue.length; first += options.batch) {
        const batch = queue.slice(first, first + options.batch);
        rmSync(work, { recursive: true, force: true });
        // One input folder per native scale the model is asked for: one GPU run each.
        const groups = new Map();
        for (const [index, job] of batch.entries()) {
          const native = nativeScale(options.model, job.wanted.scale);
          const input = join(work, `in-${native}`);
          if (!groups.has(native)) {
            groups.set(native, input);
            mkdirSync(input, { recursive: true });
          }
          const { colour, alpha } = buildWorkImages(job.image, job.layout);
          writeFileSync(join(input, `${index}-c.png`), encodePng(colour));
          if (alpha) writeFileSync(join(input, `${index}-a.png`), encodePng(alpha));
          job.native = native;
          job.hasAlpha = alpha !== undefined;
          job.name = index;
        }
        lock(options, "acquire");
        try {
          for (const [native, input] of groups) {
            const output = join(work, `out-${native}`);
            mkdirSync(output, { recursive: true });
            gpuMs += await upscaleDirectory({ input, output, model: options.model, scale: native, gpu: options.gpu });
          }
        } finally {
          lock(options, "release");
        }
        for (const job of batch) {
          const output = join(work, `out-${job.native}`);
          const factor = job.native / job.wanted.scale;
          const read = (suffix) => downsample(decodePng(readFileSync(join(output, `${job.name}-${suffix}.png`))), factor);
          const result = assemble(job.layout, job.wanted.scale, read("c"), job.hasAlpha ? read("a") : undefined);
          // A run that went wrong on the GPU must not ship: past the limit the original stays (see `fidelity`).
          const drift = fidelity(result, job.image, job.wanted.scale);
          if (drift.colour > FIDELITY_LIMIT || drift.alpha > FIDELITY_LIMIT) {
            rejected.push(`${job.entry.path} (colour ${drift.colour.toFixed(1)}, alpha ${drift.alpha.toFixed(1)})`);
            delete manifest.entries[job.entry.path];
            rmSync(job.destination, { force: true });
            rmSync(`${job.destination}.src`, { force: true });
            continue;
          }
          worst = Math.max(worst, drift.colour, drift.alpha);
          const png = encodePng(result);
          await writeFileAtomic(job.destination, png);
          await stampGenerated(job.destination, archives, { paths: [job.entry.path] });
          manifest.entries[job.entry.path] = { ...job.wanted, width: result.width, height: result.height,
            sourceWidth: job.image.width, sourceHeight: job.image.height, bytes: png.length };
          bytes += png.length;
          built++;
        }
        await writeManifest(manifestFile, manifest);
        console.log(`  ${built}/${queue.length} built (GPU ${Math.round(gpuMs / 1000)} s)`);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    console.log(`Built ${built} HD textures in ${Math.round((Date.now() - started) / 1000)} s `
      + `(GPU ${Math.round(gpuMs / 1000)} s), ${(bytes / 1048576).toFixed(1)} MB written to ${setDirectory}; `
      + `largest drift from the source ${worst.toFixed(1)}`);
    if (rejected.length) console.log(`Kept the original for ${rejected.length} (drift past ${FIDELITY_LIMIT}):\n  ${rejected.join("\n  ")}`);
  } finally {
    releaseSetLock();
    archives.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
