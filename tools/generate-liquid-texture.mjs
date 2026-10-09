// One liquid's animated surface, published as a single vertical strip.
//
// `LiquidType.dbc` names a texture family per liquid — `XTextures\river\lake_a.%d.blp` for water,
// `ocean_h` for ocean, `lava` and `slime` for the other two — and the client walks thirty frames
// of it. Thirty separate downloads and thirty GPU textures for one surface is not worth it, so
// they go out as one 256 x 7680 picture and the shader picks the row of it that is this frame.
// Measured: 2.54 MB for water, 1.84 MB for lava, and only the classes a zone actually contains
// are ever asked for.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { decodeBlp } from "./blp.mjs";
import { openDbcFile } from "./dbc.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, dbcDirectory } from "./paths.mjs";
import { SOURCE_MISSING_EXIT, SourceMissing } from "./source-missing.mjs";
import { sourceStamp, writeSourceStamp } from "./source-stamp.mjs";

/** How many frames of a family the client cycles. Every family in this client ships exactly this. */
const FRAMES = 30;
/** A frame no larger than this; every family here is 256x256. */
const MAX_SIDE = 512;

/**
 * `LiquidType.SoundBank` is the classification, not the row id: twenty-six rows collapse onto
 * four families, and the TrinityCore map file records the same four as a flag byte per cell.
 */
export const LIQUID_CLASSES = ["water", "ocean", "magma", "slime"];
const SOUND_BANK = { water: 0, ocean: 1, magma: 2, slime: 3 };

/**
 * Resolves one animated family and also remembers the first frame that is not there yet.
 *
 * The missing path is an input just as much as the frames that exist: if a later patch adds it,
 * the generated strip must grow instead of remaining a permanently cached shorter animation.
 */
export async function liquidFrameInputs(archives, pattern, limit = FRAMES) {
  const paths = [];
  for (let frame = 1; frame <= limit; frame++) {
    const path = pattern.replace("%d", String(frame));
    if (!await archives.has(path)) return { paths, stampPaths: [...paths, path] };
    paths.push(path);
  }
  return { paths, stampPaths: paths };
}

/** The texture family for one class, taken from the lowest-numbered row that names one. */
export async function liquidTexturePattern(directory, liquidClass) {
  const bank = SOUND_BANK[liquidClass];
  if (bank === undefined) throw new Error(`${liquidClass} is not a liquid class`);
  const types = await openDbcFile(directory, "LiquidType");
  let best;
  for (const row of types.rows()) {
    if (types.int(row, "SoundBank") !== bank) continue;
    const pattern = types.string(row, "Texture", 0);
    if (!pattern || !pattern.includes("%d")) continue;
    const id = types.id(row);
    if (!best || id < best.id) best = { id, pattern };
  }
  if (!best) throw new Error(`No LiquidType row with a texture names sound bank ${bank}`);
  return best.pattern;
}

/** Where the strips are published; read on every call, so a long-lived worker follows the env. */
export function liquidDirectory() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", process.env.LIQUID_DIR ?? "data/liquid");
}

/**
 * Publishes one class's strip and its JSON beside it, out of an open chain (the persistent worker
 * calls this per job; the command line below calls it once). Leaves the chain open.
 */
export async function publishLiquidTexture(liquidClass, archives, destination = liquidDirectory()) {
  if (!LIQUID_CLASSES.includes(liquidClass)) throw new Error(`${liquidClass} is not a liquid class`);
  const pattern = await liquidTexturePattern(dbcDirectory(), liquidClass);
  return publishStrip(liquidClass, pattern, archives, destination);
}

// ---- 05.10-A7b-8 (7.09 slice A): one strip per LiquidType texture family ----------------------
//
// The class strips above stay exactly as they were (an older gateway asks for them, and its worker
// loads this file fresh): a family strip is a second, separate namespace, `family/<slug>.png|json`
// under the same directory, asked for by `/liquid/family/<slug>` only by a browser that read the v2
// table. Of the seven families in this client four are the class strips' own (`lake_a`, `ocean_h`,
// `lava`, `slime`, which the browser keeps taking from `/liquid/<class>`); `fast_a` (16 frames),
// `lavagreen` and `lavaorange` are the ones only this route publishes.

/** A family name: the lower-cased file name of `Texture[0]` without `.%d.blp`. */
export const LIQUID_FAMILY_SLUG = /^[a-z0-9_]{1,32}$/;

/** The family of a `LiquidType.Texture[0]` path (the same rule as the gateway's `liquidFamily`). */
export function liquidFamilyOf(texture) {
  const file = texture.replaceAll("/", "\\").split("\\").pop() ?? "";
  return file.replace(/(?:\.%d)?\.blp$/i, "").toLowerCase();
}

/** The animated pattern of a family, from the lowest-numbered row that names it. */
export async function liquidFamilyPattern(directory, family) {
  if (!LIQUID_FAMILY_SLUG.test(family)) throw new SourceMissing(`${family} is not a liquid family`);
  const types = await openDbcFile(directory, "LiquidType");
  let best;
  for (const row of types.rows()) {
    const pattern = types.string(row, "Texture", 0);
    if (!pattern || !pattern.includes("%d") || liquidFamilyOf(pattern) !== family) continue;
    const id = types.id(row);
    if (!best || id < best.id) best = { id, pattern };
  }
  if (!best) throw new SourceMissing(`No LiquidType row names the animated family ${family}`);
  return best.pattern;
}

/** Where family strips are published, beside the class strips. */
export function liquidFamilyDirectory(destination = liquidDirectory()) {
  return join(destination, "family");
}

/** Publishes one family's strip and JSON (`family/<slug>.png|json`). Leaves the chain open. */
export async function publishLiquidFamily(family, archives, destination = liquidDirectory()) {
  const pattern = await liquidFamilyPattern(dbcDirectory(), family);
  return publishStrip(family, pattern, archives, liquidFamilyDirectory(destination), true);
}

/**
 * The strip writer both namespaces share; for a class its bytes are those of the writer before
 * 05.10-A7b-8 (proved on the four class strips, `.runtime/re-2026-10-05/A7b-8`).
 */
async function publishStrip(liquidClass, pattern, archives, destination, missingIsSource = false) {
  const frames = [];
  const { paths: framePaths, stampPaths } = await liquidFrameInputs(archives, pattern);
  for (const path of framePaths) {
    const blp = await archives.read(path);
    if (!blp) throw new Error(`${path} disappeared while the liquid strip was being generated`);
    const decoded = decodeBlp(blp);
    if (decoded.width > MAX_SIDE || decoded.height > MAX_SIDE) throw new Error(`${path} is ${decoded.width}x${decoded.height}`);
    if (frames.length > 0 && (decoded.width !== frames[0].width || decoded.height !== frames[0].height)) {
      throw new Error(`${path} is a different size from frame 1`);
    }
    frames.push(decoded);
  }
  // Every present frame plus the first absence: changing either changes the strip.
  const stamp = await sourceStamp(archives, { paths: stampPaths, files: [join(dbcDirectory(), "LiquidType.dbc")] });
  if (frames.length === 0) {
    if (missingIsSource) throw new SourceMissing(`${pattern} has no frames in the client`); // 05.10-A7b-8
    throw new Error(`${pattern} has no frames in the client`);
  }

  const { width, height } = frames[0];
  const strip = new PNG({ width, height: height * frames.length });
  for (let frame = 0; frame < frames.length; frame++) strip.data.set(frames[frame].data, frame * width * height * 4);
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, `${liquidClass}.png`), PNG.sync.write(strip, { colorType: 6 }));
  await writeFile(join(destination, `${liquidClass}.json`), JSON.stringify({ frames: frames.length, width, height, source: pattern }));
  // Both halves are served under their own URL, so both carry the stamp.
  for (const file of [`${liquidClass}.png`, `${liquidClass}.json`]) {
    await writeSourceStamp(join(destination, file), stamp);
  }
  return { frames: frames.length, width, height, pattern };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  && process.argv[2] === "--family") {
  // 05.10-A7b-8: node tools/generate-liquid-texture.mjs --family <slug>
  const family = process.argv[3] ?? "";
  const archives = await clientArchives(clientDirectory());
  try {
    const result = await publishLiquidFamily(family, archives);
    console.log(`Generated liquid family ${family}: ${result.frames} frames of ${result.width}x${result.height} from ${result.pattern}`);
  } catch (error) {
    if (!(error instanceof SourceMissing)) throw error;
    console.error(error.message);
    process.exitCode = SOURCE_MISSING_EXIT;
  } finally {
    archives.close();
  }
} else if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const liquidClass = (process.argv[2] ?? "").toLowerCase();
  if (!LIQUID_CLASSES.includes(liquidClass)) {
    throw new Error(`Usage: node tools/generate-liquid-texture.mjs <${LIQUID_CLASSES.join("|")}>`);
  }
  const archives = await clientArchives(clientDirectory());
  let result;
  try {
    result = await publishLiquidTexture(liquidClass, archives);
  } finally {
    archives.close();
  }
  console.log(`Generated liquid ${liquidClass}: ${result.frames} frames of ${result.width}x${result.height} from ${result.pattern}`);
}
