// The picture beside a spell's name, and the one a hunter pet family shows on its tab.
//
// Three modes. `--all` is the operator's bulk pass out of `build-assets.bat`: every row of both
// tables, an index beside them, and anything left over from an older dataset swept away. A run
// named with ids is what the gateway spawns on a cache miss, the same way `/item-icon` spawns
// `generate-item-icon.mjs` — because a module that adds a `SpellIcon` row used to show nothing at
// all until somebody remembered to rerun this script.
//
// All three write a source stamp beside each picture, so the gateway can tell an icon built from
// the dataset as it is now from one built from the dataset as it was; `tools/source-stamp.mjs`
// carries the reason. `--restamp` is the third mode and exists only for the pictures that were
// published before any of that: it writes no picture at all, it proves the one already on disk is
// the one this dataset decodes to and stamps it, and it drops the ones that fail that proof so the
// gateway republishes them a picture at a time. The gateway spawns it once, off the request path,
// the first time it serves an icon with no stamp beside it — 3,204 of them on this machine, and
// asking for them one at a time cost 370 ms each on one serial lane.

import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blpToPng } from "./blp-png.mjs";
import { openDbcFile } from "./dbc.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, dbcDirectory } from "./paths.mjs";
import { sourceStamp, stampSidecar, writeSourceStamp } from "./source-stamp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The two tables, and where each one's pictures are published. */
const FAMILIES = {
  spell: {
    table: "SpellIcon",
    field: "TextureFilename",
    directory: resolve(root, process.env.SPELL_ICON_DIR ?? "public/icons"),
    label: "spell icons",
  },
  family: {
    table: "CreatureFamily",
    field: "IconFile",
    directory: resolve(root, process.env.CREATURE_ICON_DIR ?? "public/creature-icons"),
    label: "creature-family icons",
  },
};

const arguments_ = process.argv.slice(2);
const all = arguments_.length === 1 && arguments_[0] === "--all";
const restamping = arguments_.length === 1 && arguments_[0] === "--restamp";
const wantsFamily = arguments_[0] === "--family";
const requested = (wantsFamily ? arguments_.slice(1) : arguments_).map(Number);
if (!all && !restamping && (requested.length === 0 || !requested.every((id) => Number.isInteger(id) && id > 0))) {
  throw new Error("Usage: node tools/generate-spell-icons.mjs --all | --restamp | [--family] <icon-id...>");
}

/**
 * The archive chain, opened on the first miss and closed once at the very end.
 *
 * One chain for the whole run and not one per table: `clientArchives` hands the same object to
 * every caller in the process, so closing it after the spell icons would leave the family icons
 * reading a chain with no sources in it and publishing nothing at all.
 */
let chain;
async function archiveChain() {
  chain ??= await clientArchives(clientDirectory());
  return chain;
}

try {
  if (all) {
    const spells = await publish(FAMILIES.spell, undefined);
    const families = await publish(FAMILIES.family, undefined);
    console.log(`Generated ${spells.written} spell icons and ${families.written} creature-family icons`);
    const removed = spells.removed + families.removed;
    if (removed > 0) console.log(`Removed ${removed} icon(s) left over from a previous dataset`);
  } else if (restamping) {
    const spells = await restamp(FAMILIES.spell);
    const families = await restamp(FAMILIES.family);
    // On stderr, unlike the two modes around it, and that is deliberate. This is the mode the
    // gateway spawns at startup, and it is the only one whose report an operator ever sees:
    // `main.ts` relays the child's stderr and throws its stdout away, because StormLib's
    // WebAssembly build writes its banner and every heap resize onto stdout. `tools/restamp.mjs`
    // reports on stderr for the same reason; `--all` is run by hand from `build-assets.bat` and
    // keeps its report where a person running it will see it.
    process.stderr.write(`Stamped ${spells.stamped + families.stamped} published icon(s) that carried no stamp\n`);
    const dropped = spells.dropped + families.dropped;
    if (dropped > 0) process.stderr.write(`Dropped ${dropped} that this dataset no longer decodes to\n`);
  } else {
    await publish(FAMILIES[wantsFamily ? "family" : "spell"], requested);
  }
} finally {
  chain?.close();
}

/**
 * Which picture each id of one table names, by the id.
 *
 * @param {{table: string, field: string}} family
 */
async function tablePaths(family) {
  const dbc = await openDbcFile(dbcDirectory(), family.table);
  const paths = new Map();
  for (const row of dbc.rows()) {
    const id = dbc.id(row);
    const name = dbc.string(row, family.field).replaceAll("/", "\\");
    // The tables name the picture without its extension — every stock row of both does — but a
    // module author writing the row by hand may well type it, and `Foo.blp.blp` is in no archive.
    if (id > 0 && name) paths.set(id, name.toLowerCase().endsWith(".blp") ? name : `${name}.blp`);
  }
  return paths;
}

/**
 * Publishes one table's icons: all of them, or the ids that were asked for.
 *
 * @param {{table: string, field: string, directory: string, label: string}} family
 * @param {number[] | undefined} ids ids to publish, or undefined for the whole table
 */
async function publish(family, ids) {
  const bulk = ids === undefined;
  const paths = await tablePaths(family);

  await mkdir(family.directory, { recursive: true });
  const wanted = bulk ? [...paths.keys()] : [...new Set(ids)];
  // Published *and* stamped: an icon written before stamps existed is one the gateway cannot
  // check, and it only ever gets a stamp by being written again. The bulk pass rewrites everything
  // for that reason and does not ask.
  const cached = new Set();
  if (!bulk) {
    for (const id of wanted) {
      try {
        await access(join(family.directory, `${id}.png`));
        await access(stampSidecar(join(family.directory, `${id}.png`)));
        cached.add(id);
      } catch {
        // Not published yet, or published before it carried a stamp.
      }
    }
  }

  // Several ids can name one file, so each file is read and decoded once and written out under
  // every id that asked for it — the same shape `generate-item-icon.mjs` uses for display ids.
  const byFile = new Map();
  const unresolved = [];
  for (const id of wanted) {
    if (cached.has(id)) continue;
    const path = paths.get(id);
    if (!path) {
      // No row at all, or a row that names no file. In the bulk pass there is nothing to say —
      // 7 of the 40 `CreatureFamily` rows have an empty `IconFile` and always have. In a named
      // run it is the answer: the route that asked has to hear that this id has no picture, or
      // its lane never remembers the failure and every request for it spawns this process again.
      unresolved.push(id);
      continue;
    }
    const key = path.toLowerCase();
    const group = byFile.get(key) ?? { path, ids: [] };
    group.ids.push(id);
    byFile.set(key, group);
  }

  const groups = [...byFile.values()];
  const published = [...cached];
  let written = 0;
  let absent = 0;
  let undecodable = 0;
  if (groups.length > 0) {
    const archives = await archiveChain();
    for (const { path, ids: sharing } of groups) {
      const blp = await archives.read(path);
      if (!blp) {
        absent++;
        unresolved.push(...sharing);
        continue;
      }
      let png;
      try {
        png = blpToPng(blp);
      } catch (error) {
        undecodable++;
        unresolved.push(...sharing);
        if (undecodable <= 5) console.warn(`  ${path}: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      // Two inputs, not one: the BLP, and the table that said it was this id's picture. A module
      // that repoints an existing icon at another file changes neither the id nor the name of the
      // file it replaced, so without the table's own stamp the old picture would go on being
      // served.
      const stamp = await sourceStamp(archives, {
        paths: [path],
        files: [join(dbcDirectory(), `${family.table}.dbc`)],
      });
      for (const id of sharing) {
        const file = join(family.directory, `${id}.png`);
        await writeFile(file, png);
        await writeSourceStamp(file, stamp);
        published.push(id);
        written++;
      }
    }
  }

  if (absent > 0) console.warn(`${absent} of ${groups.length} ${family.label} are not in the client`);
  if (undecodable > 0) console.warn(`${undecodable} of ${groups.length} ${family.label} could not be decoded`);

  let removed = 0;
  if (bulk) {
    const keep = published.sort((left, right) => left - right);
    await writeFile(join(family.directory, "index.json"), JSON.stringify(keep) + "\n");
    // This pass owns the directory, so anything it did not just write came from a dataset that is
    // no longer the one in use. Leaving those behind serves icons the server has never heard of.
    removed = await removeStale(family.directory, keep);
  } else if (unresolved.length > 0) {
    // A named request that produced nothing is an error: the route that asked remembers the
    // failure for five minutes instead of respawning this process for every player who has that
    // spell on a bar.
    throw new Error(`No icon found for ${family.table} ${unresolved.join(", ")}`);
  }
  return { written, removed };
}

/**
 * Gives every published picture that carries no stamp one, without writing a picture.
 *
 * The pass the gateway asks for, and the reason it writes nothing: it runs while the gateway is
 * serving that very directory, and `public/icons` is also what the dev server watches. So each
 * unstamped picture is compared against what this dataset decodes to now — the encoder is
 * deterministic, measured over the 3,204 published here as the same sha1 across two full bulk
 * passes — and only the sidecar is written. A picture that does not match, or whose id this table
 * no longer names, is dropped instead of being repainted under a reader: the route republishes it
 * on its own lane the next time somebody asks, which is one 370 ms miss rather than a torn PNG a
 * browser would cache for a day.
 *
 * @param {{table: string, field: string, directory: string, label: string}} family
 */
async function restamp(family) {
  let names;
  try {
    names = await readdir(family.directory);
  } catch {
    // Nothing published for this family yet, which is not this pass's business.
    return { stamped: 0, dropped: 0 };
  }
  const unstamped = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".png")) continue;
    const id = Number(name.slice(0, -4));
    if (!Number.isInteger(id) || id <= 0) continue;
    const file = join(family.directory, name);
    try {
      await access(stampSidecar(file));
    } catch {
      unstamped.push({ id, file });
    }
  }
  if (unstamped.length === 0) return { stamped: 0, dropped: 0 };

  const paths = await tablePaths(family);
  const archives = await archiveChain();
  const dbcFile = join(dbcDirectory(), `${family.table}.dbc`);
  // Several ids share a file here too — 3,204 spell icons over 3,171 pictures — so each one is
  // read and decoded once for all of them.
  const decoded = new Map();
  let stamped = 0;
  let dropped = 0;
  for (const { id, file } of unstamped) {
    const path = paths.get(id);
    if (path && !decoded.has(path.toLowerCase())) {
      const blp = await archives.read(path);
      let png;
      try {
        png = blp ? blpToPng(blp) : undefined;
      } catch {
        // Undecodable now is undecodable for the route as well; the picture goes with it.
        png = undefined;
      }
      decoded.set(path.toLowerCase(), png);
    }
    const png = path ? decoded.get(path.toLowerCase()) : undefined;
    if (png && (await readFile(file)).equals(png)) {
      await writeSourceStamp(file, await sourceStamp(archives, { paths: [path], files: [dbcFile] }));
      stamped++;
    } else {
      await rm(file, { force: true });
      dropped++;
    }
  }
  if (dropped > 0) console.warn(`${dropped} of ${unstamped.length} published ${family.label} are not what this dataset decodes to`);
  return { stamped, dropped };
}

async function removeStale(directory, keep) {
  const wanted = new Set(keep.map((id) => `${id}.png`));
  let removed = 0;
  for (const name of await readdir(directory)) {
    if (!name.toLowerCase().endsWith(".png") || wanted.has(name)) continue;
    await rm(join(directory, name));
    // The stamp describes a file that is gone; on its own it would name a picture nothing serves.
    await rm(stampSidecar(join(directory, name)), { force: true });
    removed++;
  }
  return removed;
}
