// What a generated file under `data/` was built from.
//
// Every cache in `data/` is keyed on a path or an id and on nothing else: `/texture` on
// sha1(`texture-v1\0<path>`), `/item-icon` on the display id, the terrain families on the map and
// the grid cell. That key does not change when the bytes behind it do, so a module that replaces a
// texture, or a dataset rebuild that moves an icon, is served the old picture for as long as the
// file sits there — the client has no way to know it is stale.
//
// A stamp is the missing half. Beside each generated file the generator writes `<file>.src`: the
// archive or loose overlay that won each input path, that file's size and mtime, the composition
// of the archive chain, and the plain files (a DBC, say) the generator also read. The gateway
// compares it against the dataset as it is now and regenerates that one entry when they disagree.
// Deleting `data/` wholesale is not an alternative: 109 MB of models would go with one replaced
// texture.

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** What a stamp is called beside the file it describes. `DatasetFingerprint.ts` reads the same. */
export const STAMP_SUFFIX = ".src";

/** The sidecar beside a generated file. `src/gateway/DatasetFingerprint.ts` reads the same name. */
export function stampSidecar(destination) {
  return `${destination}${STAMP_SUFFIX}`;
}

/**
 * Drops every stamp under a directory tree, and says how many there were.
 *
 * One caller, and it is the build. Two of the caches live in `public/` rather than in `data/` —
 * the spell and creature-family icons, which were published beside the page long before there was
 * a route for them — and `vite build` copies `public/` into `dist/web` verbatim. So the sidecars
 * shipped: measured on this machine, 3,204 of them totalling 1,475,029 bytes, each naming the
 * client directory the picture came out of, the dataset table beside it, and the size and mtime of
 * both. That is this machine's disk layout, and it has no business being fetchable from the page.
 * The pictures stay; only their bookkeeping is swept out of the copy.
 */
export async function removeStampsUnder(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    // No such directory: a build that published nothing has no stamps to drop either.
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) removed += await removeStampsUnder(child);
    else if (entry.name.endsWith(STAMP_SUFFIX)) {
      await rm(child, { force: true });
      removed++;
    }
  }
  return removed;
}

/**
 * Whether a file that is already on disk was built from the dataset as it is now.
 *
 * For a generator that skips work it has done before. `access(destination)` alone answers "there
 * is a file there", which is a different question: the terrain layers were skipped that way, so a
 * module that replaced a ground texture had the tile around it rebuilt and went on being drawn
 * with the old grass for the life of the machine.
 *
 * The comparison is over the serialised stamp because both sides are built by `sourceStamp` in
 * the same field order. A sidecar written by an older shape therefore compares unequal, which
 * republishes a file that may not have needed it — the safe direction of the two.
 */
export async function stampIsCurrent(destination, archives, inputs) {
  try {
    await stat(destination);
    const previous = await readFile(stampSidecar(destination), "utf8");
    return previous === JSON.stringify(await sourceStamp(archives, inputs));
  } catch {
    // No file, or no stamp beside it: not something to skip.
    return false;
  }
}

/**
 * Collects the stamp of everything one generated file was built from.
 *
 * Separate from writing it because several generators close the chain before they write their
 * output, and the chain is what answers where a path came from.
 */
export async function sourceStamp(archives, { paths = [], files = [], generation } = {}) {
  const sources = [];
  const missingSources = [];
  for (const path of paths) {
    const source = await archives.sourceOf(path);
    if (source) sources.push(source);
    else if (typeof archives.absenceOf === "function") {
      // A fallback *was* built from the fact that this path did not exist. Remember every loose
      // overlay that can gain it and every archive that can be replaced in place; otherwise the
      // first real asset a later TSWoW patch supplies leaves the fallback cached forever.
      missingSources.push(await archives.absenceOf(path));
    }
  }
  const plain = [];
  const missingFiles = [];
  for (const file of files) {
    try {
      const stats = await stat(file);
      plain.push({ file, size: stats.size, mtimeMs: stats.mtimeMs });
    } catch {
      // This is an absence condition, not a permanently stale input: the gateway invalidates the
      // entry only if the file later appears.
      missingFiles.push(file);
    }
  }
  return {
    ...(typeof generation === "string" && generation ? { generation } : {}),
    chain: archives.chainDigest(),
    sources,
    files: plain,
    ...(missingSources.length ? { missingSources } : {}),
    ...(missingFiles.length ? { missingFiles } : {}),
  };
}

/** Writes the stamp beside the file it describes. */
export async function writeSourceStamp(destination, stamp) {
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(stampSidecar(destination), JSON.stringify(stamp));
}

/** Both halves, for the common case of a generator that still holds the chain open. */
export async function stampGenerated(destination, archives, inputs) {
  await writeSourceStamp(destination, await sourceStamp(archives, inputs));
}
