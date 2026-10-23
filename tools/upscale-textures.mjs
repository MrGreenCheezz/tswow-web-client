// 23.10 (7.48): builds an HD texture set — client textures upscaled by a neural network on the GPU.
//
//   node tools/upscale-textures.mjs --set effects            build or bring up to date the effects set
//   node tools/upscale-textures.mjs --set effects --dry-run  say what would be done, touch nothing
//
// Options: --model (default per set, SET_MODEL below: animevideov3 for effects, x4plus for the world), --batch 150 (textures per GPU run),
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
// The `world` set (23.10, step 2: ground textures and buildings' diffuse textures, ×2 up to 256 px a side) also gets
// a GPU-compressed form of every entry, made on the CPU after the GPU runs (`compressSet`, tools/hd-texture-bc7.mjs):
// - `<id>.wht` — BC7 with its full mip chain in a small container, what the gateway serves to the world routes (the
//   PNG beside it is only the compressor's input); level 1 onwards is the original texture, so only magnified texels
//   change; a ground texture is put on the terrain array's 512 side, opaque; `<id>.wht.src` — its stamp;
// - the manifest entry's `compressed` record (sizes, BC7 error, the HD-½-vs-original difference and, for a building
//   texture, `originalPng`: the sha1 of the PNG `/visual/texture` serves, by which the gateway finds it).
// `--compress-only` runs only that CPU pass (no GPU), `--no-compress` skips it, `--workers N` (default 4) threads.
//
// Resumable: the manifest is rewritten after every batch and an entry whose source sha1, scale, model and
// pipeline match (and whose file is there) is skipped. Parallel-safe: one run per set at a time (a lock
// directory in the set), each run works in its own temporary folder, every file is renamed into place.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
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
/**
 * 23.10 (7.48 step 2): the world set's model. On 40 sampled 256² building and ground textures (×4, 2×2 box, as built)
 * realesrgan-x4plus kept the stone grain, cloth folds and wood fibre that animevideov3 paints flat: Laplacian
 * sharpness 8.30 against 6.12 (a bilinear ×2 of the original: 3.96), drift back to the source 3.8 against 3.4 — and
 * on screen animevideov3's level 0 read 6 % softer than the original's magnified texels on Stormwind's cobbles. The
 * streaks it draws into soft smoke do not arise on these opaque surfaces. 4× the GPU time (11.5 s against 2.8 s).
 */
export const SET_MODEL = Object.freeze({ effects: MODEL, world: "realesrgan-x4plus" });

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
  const options = { set: undefined, model: undefined, batch: 150, maxSide: undefined, only: undefined, out: undefined, gpu: undefined,
    lockScript: undefined, lockOwner: "upscale-textures", dryRun: false, restampOnly: false,
    compress: true, compressOnly: false, workers: Math.max(1, Math.min(4, availableParallelism() - 2)) };
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
      case "--compress-only": options.compressOnly = true; break; // 23.10 (7.48)
      case "--no-compress": options.compress = false; break;
      case "--workers": options.workers = Number.parseInt(value(), 10); break;
      default: throw new Error(`Unknown option ${name}`);
    }
  }
  if (!SET_NAMES.includes(options.set)) throw new Error(`--set must be one of ${SET_NAMES.join(", ")}`);
  options.model ??= SET_MODEL[options.set];
  if (!MODELS[options.model]) throw new Error(`--model must be one of ${Object.keys(MODELS).join(", ")}`);
  if (!Number.isInteger(options.batch) || options.batch < 1) throw new Error("--batch must be a positive integer");
  if (!Number.isInteger(options.workers) || options.workers < 1) throw new Error("--workers must be a positive integer");
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

/**
 * 23.10 (7.48): bumped when the compressed form changes (encoder, mip filter, ground side), so every `.wht` is
 * rebuilt — on the CPU only, from the PNG beside it.
 */
export const COMPRESS_PIPELINE = "bc7-mode6-v2/hd0-original-mips/ground512";
/**
 * 23.10 (7.48): a ground texture's container is opaque — its `_s.blp` specular mask is not carried (the client uses the
 * HD ground only where the glint is not drawn; with the mask in alpha BC7 cost the colour 1.7 % sharpness).
 */
const GROUND_COMPRESS_PIPELINE = `${COMPRESS_PIPELINE}/opaque`;

/** 23.10 (7.48): whether a world-set path is a ground texture (the terrain array's layers). */
function isGround(path) {
  return path.startsWith("tileset\\");
}

/** 23.10 (7.48): the pipeline a compressed entry of `path` must have been made by. */
export function compressPipeline(path) {
  return isGround(path) ? GROUND_COMPRESS_PIPELINE : COMPRESS_PIPELINE;
}

/** 23.10 (7.48): the compressed form beside an HD PNG (`<id>.wht`, src/gateway/HdTextures.ts names it the same). */
export function compressedFile(png) {
  return png.replace(/\.png$/, ".wht");
}

/** An entry's files: the HD PNG, its compressed form and both stamps. */
function removeEntryFiles(png) {
  for (const file of [png, compressedFile(png)]) {
    rmSync(file, { force: true });
    rmSync(`${file}.src`, { force: true });
  }
}

/**
 * 23.10 (7.48): the world set's compressed forms (tools/hd-texture-bc7.mjs) — every entry whose `.wht` is missing
 * or was made by another pipeline (`compressPipeline`), on `options.workers` threads (CPU only). A ground texture
 * (`tileset\`) is put on the terrain array's 512 side, opaque. Level 1 onwards of every container is the original
 * texture (tools/hd-texture-bc7.mjs). The manifest entry gains
 * `compressed: { pipeline, width, height, levels, bytes, opaque, error, halfError, originalPng }`; the file is stamped
 * like the PNG, so the gateway serves it only while it matches the client.
 */
async function compressSet(manifest, manifestFile, setDirectory, archives, options) {
  const jobs = [];
  for (const [path, entry] of Object.entries(manifest.entries)) {
    if (options.only && !path.includes(options.only)) continue;
    const png = join(setDirectory, `${hdTextureId(path)}.png`);
    const destination = compressedFile(png);
    if (!existsSync(png)) continue;
    if (entry.compressed?.pipeline === compressPipeline(path) && existsSync(destination)) continue;
    jobs.push({ path, png, destination, ground: isGround(path) });
  }
  console.log(`${jobs.length} HD textures to compress (BC7) on ${options.workers} threads`);
  if (options.dryRun || jobs.length === 0) return;
  const started = Date.now();
  const workers = Array.from({ length: Math.min(options.workers, jobs.length) },
    () => new Worker(new URL("./hd-texture-compress-worker.mjs", import.meta.url)));
  let next = 0;
  let done = 0;
  let failed = 0;
  let bytes = 0;
  let sinceWrite = 0;
  const failures = [];
  try {
    await Promise.all(workers.map((worker) => new Promise((resolveWorker, rejectWorker) => {
      let current;
      const feed = async () => {
        while (next < jobs.length) {
          const job = jobs[next];
          const id = next++;
          const blp = await archives.read(job.path);
          if (!blp) {
            failed++;
            continue;
          }
          current = job;
          worker.postMessage({ id, png: job.png, destination: job.destination, ground: job.ground,
            blp: new Uint8Array(blp), // a compact copy: a view would clone its whole pool slab
          });

          return;
        }
        current = undefined;
        resolveWorker();
      };
      worker.on("error", rejectWorker);
      worker.on("message", (answer) => {
        void (async () => {
          const job = current;
          if (answer.ok && job && manifest.entries[job.path]) {
            const { ok: _ok, id: _id, ...result } = answer;
            await stampGenerated(job.destination, archives, { paths: [job.path] });
            manifest.entries[job.path].compressed = { pipeline: compressPipeline(job.path), ...result,
            };
            bytes += answer.bytes;
            done++;
            if (++sinceWrite >= 250) {
              sinceWrite = 0;
              await writeManifest(manifestFile, manifest);
              console.log(`  ${done}/${jobs.length} compressed (${Math.round((Date.now() - started) / 1000)} s)`);
            }
          } else {
            failed++;
            if (job) failures.push(`${job.path}: ${answer.reason ?? "entry gone"}`);
          }
          await feed();
        })().catch(rejectWorker);
      });
      void feed().catch(rejectWorker);
    })));
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    await writeManifest(manifestFile, manifest);
  }
  console.log(`Compressed ${done} HD textures in ${Math.round((Date.now() - started) / 1000)} s, `
    + `${(bytes / 1048576).toFixed(1)} MB of BC7${failed ? `; ${failed} failed` : ""}`);
  if (failures.length) console.log(`  ${failures.slice(0, 20).join("\n  ")}`);
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
      : await worldSet(archives, (report) => console.log(`${report.ground} ground textures, ${report.roots} root WMOs, `
        + `${report.wmoTextures} more building textures`));
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
          removeEntryFiles(destination);
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
        // 23.10 (7.48): and its compressed form, which carries a stamp of its own.
        const compressed = compressedFile(destination);
        if (!options.dryRun && existsSync(compressed) && !await stampIsCurrent(compressed, archives, { paths: [entry.path] })) {
          await stampGenerated(compressed, archives, { paths: [entry.path] });
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
        removeEntryFiles(destination);
        delete manifest.entries[path];
        pruned++;
      }
    }
    console.log(`${selected.length} textures in the ${options.set} set: ${upToDate} up to date (${restamped} restamped), `
      + `${queue.length} to build, ${notScaled} too large to upscale, ${undecodable} undecodable, ${pruned} pruned`);
    const compressing = options.set === "world" && options.compress && !options.restampOnly; // 23.10 (7.48)
    if (options.dryRun || options.restampOnly || options.compressOnly || queue.length === 0) {
      if (options.compressOnly && queue.length > 0) console.log(`  ${queue.length} wait for a GPU run (not built by --compress-only)`);
      if (!options.dryRun && !options.restampOnly) await writeManifest(manifestFile, manifest);
      if (compressing) await compressSet(manifest, manifestFile, setDirectory, archives, options);
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
            removeEntryFiles(job.destination);
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
    if (compressing) await compressSet(manifest, manifestFile, setDirectory, archives, options); // 23.10 (7.48)
  } finally {
    releaseSetLock();
    archives.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
