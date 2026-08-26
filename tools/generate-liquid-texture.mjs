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

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const liquidClass = (process.argv[2] ?? "").toLowerCase();
  if (!LIQUID_CLASSES.includes(liquidClass)) {
    throw new Error(`Usage: node tools/generate-liquid-texture.mjs <${LIQUID_CLASSES.join("|")}>`);
  }
  const destination = resolve(root, process.env.LIQUID_DIR ?? "data/liquid");
  const pattern = await liquidTexturePattern(dbcDirectory(), liquidClass);
  const archives = await clientArchives(clientDirectory());
  const frames = [];
  const framePaths = [];
  for (let frame = 1; frame <= FRAMES; frame++) {
    const blp = await archives.read(pattern.replace("%d", String(frame)));
    if (!blp) break;
    framePaths.push(pattern.replace("%d", String(frame)));
    const decoded = decodeBlp(blp);
    if (decoded.width > MAX_SIDE || decoded.height > MAX_SIDE) throw new Error(`${pattern} frame ${frame} is ${decoded.width}x${decoded.height}`);
    if (frames.length > 0 && (decoded.width !== frames[0].width || decoded.height !== frames[0].height)) {
      throw new Error(`${pattern} frame ${frame} is a different size from frame 1`);
    }
    frames.push(decoded);
  }
  // All thirty frames, because a module that replaces any one of them changes the strip.
  const stamp = await sourceStamp(archives, { paths: framePaths, files: [join(dbcDirectory(), "LiquidType.dbc")] });
  archives.close();
  if (frames.length === 0) throw new Error(`${pattern} has no frames in the client`);

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
  console.log(`Generated liquid ${liquidClass}: ${frames.length} frames of ${width}x${height} from ${pattern}`);
}
