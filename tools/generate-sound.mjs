// Publishes the sound files of one `SoundEntries` row, keyed on their paths in the archives.
//
// A whole row at a time, and that is the point of the file. Nothing here decodes anything — a
// sound is `archives.read(path)` and `writeFile`, 0.42 ms for a footstep — so the entire cost of a
// miss is starting node and opening the archive chain: measured at 285 ms, of which 152 ms is the
// twenty-two sources. A footstep kit is five files. Asking for them one at a time is five
// processes and five chain opens for two milliseconds of reading, which is `generate-worldmap-art`
// twice over, and that tool exists for exactly this reason.
//
// The archives hold `.wav` and `.mp3` and not one `.ogg`, and a browser plays both without a
// conversion step, so there is nothing between the archive and `decodeAudioData`.

import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDbcFile } from "./dbc.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, dbcDirectory } from "./paths.mjs";
import { stampGenerated, stampSidecar } from "./source-stamp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Stable name for a sound. Case and separators vary between references to the same file. */
export function soundId(mpqPath) {
  return createHash("sha1").update(`sound-v1\0${normaliseSoundPath(mpqPath).toLowerCase()}`).digest("hex");
}

export function soundDirectory() {
  return resolve(root, process.env.SOUND_DIR ?? "data/sound");
}

/**
 * One spelling for a path that `SoundEntries` writes several ways.
 *
 * 45 of the 20,642 slots join their directory to their filename with a doubled separator and 26
 * carry a leading one. Left alone, those are 163 paths the archives do not have; normalised, the
 * misses are the 124 that genuinely are not in the client.
 */
export function normaliseSoundPath(value) {
  return value.replaceAll("/", "\\").replace(/\\+/g, "\\").replace(/^\\/, "");
}

/** True for a path that could name a sound inside the archives. */
export function validSoundPath(value) {
  return /^[A-Za-z0-9_ .&()'\\-]{1,240}\.(wav|mp3)$/i.test(value) && !value.includes("..");
}

export async function publishSound(mpqPath, archives) {
  const path = normaliseSoundPath(mpqPath);
  if (!validSoundPath(path)) throw new Error(`${mpqPath} is not a usable sound path`);
  const destination = join(soundDirectory(), `${soundId(path)}${extname(path).toLowerCase()}`);
  try {
    await access(destination);
    // Cached means "there, and able to say what it came from": an entry published before stamps
    // existed is never missing, so it is never regenerated, so this is the only place it can pick
    // one up. Copying a sound again costs 0.42 ms against the 285 ms the chain already cost.
    await access(stampSidecar(destination));
    return { destination, cached: true };
  } catch {
    // Not published yet, or published before it carried a stamp.
  }
  const data = await archives.read(path);
  if (!data) throw new Error(`${path} is not in the client`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, data);
  await stampGenerated(destination, archives, { paths: [path] });
  return { destination, cached: false, bytes: data.length };
}

/**
 * Every file `SoundEntries` lists on one row, in variant order.
 *
 * `DirectoryBase` already begins with `Sound\`. Adding the prefix here would miss all 20,642 of
 * them, which is the sort of mistake that looks like an empty client rather than like a bug.
 */
export function soundKitFiles(dbc, row) {
  const base = dbc.string(row, "DirectoryBase");
  const files = [];
  for (let variant = 0; variant < 10; variant++) {
    const file = dbc.string(row, "File", variant);
    if (!file) continue;
    files.push(normaliseSoundPath(`${base}\\${file}`));
  }
  return files;
}

/**
 * Which rows of `SoundEntries` name a given file, by normalised lowercase path.
 *
 * Built so that a request for one file can publish the whole kit it belongs to. One pass over
 * 12,941 rows, which is milliseconds against the 152 the archive chain costs.
 */
export function soundKitIndex(dbc) {
  const byPath = new Map();
  for (let row = 0; row < dbc.records; row++) {
    const files = soundKitFiles(dbc, row);
    for (const file of files) {
      const key = file.toLowerCase();
      if (!byPath.has(key)) byPath.set(key, files);
    }
  }
  return byPath;
}

/**
 * Publishes the kit a path belongs to, or just that path when no row claims it.
 *
 * A path with no row is not an error: `SMSG_PLAY_SOUND` carries a kit id and this tool is also
 * the one thing that can be pointed at a bare filename by hand.
 */
export async function publishSoundKit(mpqPath, archives, index) {
  const wanted = normaliseSoundPath(mpqPath);
  const kit = index?.get(wanted.toLowerCase()) ?? [wanted];
  let published = 0;
  let found = 0;
  let firstError;
  for (const path of kit) {
    try {
      const result = await publishSound(path, archives);
      found++;
      if (!result.cached) published++;
    } catch (error) {
      // 124 of the paths in `SoundEntries` are not in the archives at all. One missing variant
      // must not cost the other four, so only a kit that yielded nothing is a failure.
      if (path.toLowerCase() === wanted.toLowerCase()) firstError = error;
    }
  }
  if (found === 0) throw firstError ?? new Error(`${wanted} is not in the client`);
  return { kit: kit.length, found, published };
}

// Run directly: node tools/generate-sound.mjs "Sound\Character\Footsteps\mFootSmallDirtA.wav"
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const requested = process.argv.slice(2);
  if (requested.length === 0) throw new Error("Usage: node tools/generate-sound.mjs <mpq-path...>");
  const [archives, entries] = await Promise.all([
    clientArchives(clientDirectory()),
    openDbcFile(dbcDirectory(), "SoundEntries").catch(() => undefined),
  ]);
  const index = entries ? soundKitIndex(entries) : undefined;
  let published = 0;
  let files = 0;
  for (const path of requested) {
    const result = await publishSoundKit(path, archives, index);
    published += result.published;
    files += result.found;
  }
  console.log(`Published ${published} of ${files} sound files across ${requested.length} kit(s)`);
  archives.close();
}
