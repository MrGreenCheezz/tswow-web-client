// Reading the client's archives, in process.
//
// This replaces tools/mpqextractor/main.cpp, which was spawned once per generator run and cost
// ~244 ms every time because it reopened all nineteen archives; the same reads through StormLib's
// WebAssembly build measure 6.9 ms per file with the chain held open. Two correctness bugs go with
// it. The C++ helper enumerated only regular files ending in `.mpq`, so it never saw
// `patch-ruRU-A.MPQ` and `patch-ruRU-B.MPQ` — which on a tswow client are *directories* holding
// the patched DBCs and the modules' assets, exactly the content this project exists to serve. And
// its precedence put `patch.MPQ` above `patch-2`/`patch-3` and every locale archive below
// `common.MPQ`, so stale revisions and unlocalised art won.
//
// The real client loads archives in ascending priority and lets later ones win. This module keeps
// the same ranking and searches from the top down, first hit wins.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { FS, MPQ } from "@wowserhq/stormjs";

/**
 * The identity of the ranking below, folded into `chainDigest()`.
 *
 * A generated file's stamp records which source won each of its inputs. Re-ranking the chain hands
 * a path to a different source without any file, and any archive's name, having changed — and the
 * digest is hashed over the chain's *names* precisely so that a reader who has never ranked them
 * can compute it, which leaves it blind to the ranking itself. Bumping this is what makes every
 * stamp written under the previous order stale, so those entries are rebuilt rather than served out
 * of a chain that no longer resolves the way they were built. `DatasetFingerprint.ts` carries the
 * same constant, and `tests/dataset-fingerprint.test.mjs` pins the two together. It also advances
 * when provenance gains a new winner-changing condition: order-3 records real MPQs searched above
 * a lower winner, so order-2 sidecars are rebuilt instead of trusted without that guard.
 */
export const ARCHIVE_ORDER = "order-3";

/** Rank of an archive by name; higher wins. Ties break on the trailing digit or letter. */
export function archivePriority(name) {
  const lower = name.toLowerCase().replace(/\.mpq$/, "");

  // `backup-<loc>` is the installer's rollback copy and must never shadow anything live.
  if (/^backup-/.test(lower)) return { tier: -1, rank: 0 };

  // The lettered patches, base and locale together at the very top, the locale form winning the tie
  // on the same letter: patch-ruRU-E > patch-E > patch-ruRU-A > patch-A > locale-ruRU > …
  //
  // This is where tswow writes its built dataset, and which of the two directories it writes into
  // is a setting: `Client.Patch.UseLocale` (Client.ts:50-58) sends it to `Data\<loc>\patch-<loc>-A`
  // when it is on and to `Data\patch-A.MPQ` when it is off, and `dataset.conf` leaves it off,
  // documented as "almost always used with enUS clients". This machine has it on, so both forms
  // have to rank the same way or a default install serves the stock tables instead of the module's:
  // of the 798 files tswow writes into `patch-ruRU-A.MPQ` here, 713 also exist inside the ruRU
  // archives below — 245 DBCs, 224 lua, 215 xml, 26 toc and 3 blp — and with the base form ranked
  // under the locale chain, as it was, every one of them would have lost. The three pictures are
  // worth naming: `UI-CHARACTERCREATE-CLASSES.BLP`, `ICONS-CLASSES.BLP` and
  // `UI-Classes-Circles.blp`, the class sheets a module that adds a class has to replace, which is
  // what makes this ranking load-bearing for art and not only for tables.
  //
  // That the real client ranks them this way is an inference, not a reading of Wow.exe: tswow on an
  // enUS client with UseLocale off works, and enUS `DBFilesClient` lives in `locale-enUS.MPQ`, so
  // `patch-A.MPQ` must beat it. The archive-name string table proves only that both forms are
  // enumerated (`patch-%s-?` beside `patch-?`), not the order they are loaded in.
  let match = /^patch-(?:([a-z]{4})-)?([a-z])$/.exec(lower);
  if (match) return { tier: 16, rank: (match[2].charCodeAt(0) - 96) * 2 + (match[1] ? 1 : 0) };

  // Locale families.
  match = /^patch-[a-z]{4}-(\d)$/.exec(lower);
  if (match) return { tier: 14, rank: Number(match[1]) };
  if (/^patch-[a-z]{4}$/.test(lower)) return { tier: 13, rank: 0 };
  if (/^lichking-locale-/.test(lower)) return { tier: 12, rank: 0 };
  if (/^expansion-locale-/.test(lower)) return { tier: 11, rank: 0 };
  if (/^locale-/.test(lower)) return { tier: 10, rank: 0 };
  // Speech holds only sound, so it never collides; keep it below the art archives regardless.
  if (/speech-/.test(lower)) return { tier: 9, rank: 0 };
  if (/^base-/.test(lower)) return { tier: 8, rank: 0 };

  // Base families.
  match = /^patch-(\d)$/.exec(lower);
  if (match) return { tier: 7, rank: Number(match[1]) };
  if (lower === "patch") return { tier: 6, rank: 0 };
  if (lower === "lichking") return { tier: 5, rank: 0 };
  if (lower === "expansion") return { tier: 4, rank: 0 };
  if (lower === "common-2") return { tier: 3, rank: 0 };
  if (lower === "common") return { tier: 2, rank: 0 };

  // Anything else a server operator dropped in: above the whole locale chain, below the lettered
  // patches. `tswow build package` names its output after the dataset — `default.dataset.A.MPQ`
  // (Package.ts:107) — which matches none of the families above and is exactly the content that
  // must not lose to a stock locale archive.
  return { tier: 15, rank: -1 };
}

function comparePriority(left, right) {
  const a = left.priority ?? archivePriority(left.name);
  const b = right.priority ?? archivePriority(right.name);
  if (a.tier !== b.tier) return b.tier - a.tier;
  if (a.rank !== b.rank) return b.rank - a.rank;
  return left.name.toLowerCase() < right.name.toLowerCase() ? 1 : -1;
}

/** A loose filesystem source: a directory-shaped MPQ or the client's `Interface/AddOns`. */
class LooseSource {
  #root;
  #prefix;
  #index;

  constructor(name, root, prefix = "") {
    this.name = name;
    this.kind = "directory";
    this.file = root;
    this.#root = root;
    this.#prefix = prefix.replaceAll("/", "\\").replace(/\\+$/, "");
  }

  async #load() {
    if (this.#index) return this.#index;
    const index = new Map();
    const walk = async (directory) => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const absolute = join(directory, entry.name);
        // Symlinks are how tswow points a patch directory at a module's asset tree, so follow
        // them; withFileTypes reports the link itself, not its target.
        let directoryEntry = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            directoryEntry = (await stat(absolute)).isDirectory();
          } catch {
            continue;
          }
        }
        if (directoryEntry) await walk(absolute);
        else {
          const local = relative(this.#root, absolute);
          const virtual = this.#prefix ? `${this.#prefix}\\${local}` : local;
          index.set(key(virtual), absolute);
        }
      }
    };
    await walk(this.#root);
    this.#index = index;
    return index;
  }

  async has(path) {
    return (await this.#load()).has(key(path));
  }

  /** The file on disk that answers this path, which is the file a cache's stamp names. */
  async fileOf(path) {
    return (await this.#load()).get(key(path));
  }

  /** Everything this overlay holds under `prefix`, in the spelling it has on disk. */
  async paths(prefix = "") {
    const index = await this.#load();
    const wanted = key(prefix);
    return [...index.values()]
      .map((absolute) => {
        const local = relative(this.#root, absolute).replaceAll(sep, "\\");
        return this.#prefix ? `${this.#prefix}\\${local}` : local;
      })
      .filter((path) => !wanted || key(path).startsWith(wanted));
  }

  async read(path) {
    const absolute = (await this.#load()).get(key(path));
    return absolute ? readFile(absolute) : undefined;
  }

  async size() {
    return (await this.#load()).size;
  }

  close() {}
}

class ArchiveSource {
  #handle;

  constructor(name, file, handle) {
    this.name = name;
    this.kind = "archive";
    // The archive file itself: a stamp cannot name a file inside an MPQ, but the archive's own
    // size and mtime answer the same question — the contents cannot change without it changing.
    this.file = file;
    this.#handle = handle;
  }

  async has(path) {
    return this.#handle.hasFile(path.replaceAll("/", "\\"));
  }

  async fileOf(path) {
    return this.#handle.hasFile(path.replaceAll("/", "\\")) ? this.file : undefined;
  }

  /**
   * Everything the archive's own listfile names under `prefix`.
   *
   * StormLib matches the mask against the whole internal name and `*` crosses the backslash, so
   * one mask enumerates a subtree. It answers out of `(listfile)`, which every archive of this
   * client carries — checked: all twenty have one — and which an archive built by hand need not,
   * so this is what the chain *can see* and `has` stays what the chain *holds*. Cross-checked on
   * this machine over the whole of `Item\TextureComponents\`: 57,540 `has` answers and the
   * enumeration agree on all 57,540.
   */
  async paths(prefix = "") {
    try {
      return this.#handle.search(`${prefix.replaceAll("/", "\\")}*`).map((file) => String(file.fileName));
    } catch {
      // An archive with no listfile answers nothing rather than taking the chain down with it.
      return [];
    }
  }

  async read(path) {
    const internal = path.replaceAll("/", "\\");
    if (!this.#handle.hasFile(internal)) return undefined;
    const file = this.#handle.openFile(internal);
    try {
      return Buffer.from(file.read());
    } finally {
      file.close();
    }
  }

  close() {
    this.#handle.close();
  }
}

/** MPQ paths are case-insensitive and slash-agnostic; the index key normalises both. */
function key(path) {
  return path.replaceAll("/", "\\").replaceAll(sep, "\\").toLowerCase();
}

let mountCounter = 0;

/**
 * Opens every archive and patch directory under `<client>/Data`, plus loose `Interface/AddOns`,
 * highest priority first.
 *
 * The handle is meant to be held for the life of the process. Opening the full chain measures
 * ~185 ms, which is the entire cost the old helper paid on every single file.
 */
export async function openClientArchives(clientDirectory) {
  const dataDirectory = join(clientDirectory, "Data");
  if (!existsSync(dataDirectory)) throw new Error(`${dataDirectory} does not exist`);

  const found = [];
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (!/\.mpq$/i.test(entry.name)) {
        let isDirectory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            isDirectory = (await stat(absolute)).isDirectory();
          } catch {
            continue;
          }
        }
        if (isDirectory) await walk(absolute);
        continue;
      }
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDirectory = (await stat(absolute)).isDirectory();
        } catch {
          continue;
        }
      }
      found.push({ name: entry.name, absolute, isDirectory });
    }
  };
  await walk(dataDirectory);
  const addonsDirectory = join(clientDirectory, "Interface", "AddOns");
  if (existsSync(addonsDirectory)) {
    try {
      if ((await stat(addonsDirectory)).isDirectory()) {
        // Native add-ons are explicit filesystem content and win over a same-named built-in add-on
        // in an MPQ. Only the Interface/AddOns virtual subtree is exposed by this source.
        found.push({
          name: "Interface/AddOns",
          absolute: addonsDirectory,
          isDirectory: true,
          virtualPrefix: "Interface\\AddOns",
          priority: { tier: 17, rank: 0 },
        });
      }
    } catch {
      // A disappearing optional add-on directory contributes nothing to this snapshot.
    }
  }
  found.sort(comparePriority);

  // StormLib runs under Emscripten and only sees its own virtual filesystem, so Data is mounted
  // there. Each chain gets its own mount point because the module is a process-wide singleton.
  const mount = `/webclient-mpq-${mountCounter++}`;
  FS.mkdir(mount);
  FS.mount(FS.filesystems.NODEFS, { root: dataDirectory }, mount);

  const sources = [];
  const skipped = [];
  for (const entry of found) {
    if (entry.isDirectory) {
      sources.push(new LooseSource(entry.name, entry.absolute, entry.virtualPrefix));
      continue;
    }
    const virtualPath = `${mount}/${relative(dataDirectory, entry.absolute).replaceAll(sep, "/")}`;
    try {
      sources.push(new ArchiveSource(entry.name, entry.absolute, await MPQ.open(virtualPath, "r")));
    } catch (error) {
      skipped.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (sources.length === 0) throw new Error(`No archive under ${dataDirectory} could be opened`);

  // What the chain is made of, as a hash. A generated cache records it so that a source appearing
  // or disappearing — a new module patch directory, an archive installed or removed — is noticed
  // on the next read, since either can change which file wins a path without touching any file
  // the cache already knows about. It is hashed over the *sorted* names rather than over the
  // search order so that a reader who has not ranked them can still compute the same digest, and
  // over what the walk found rather than over what opened, so a corrupt archive that StormLib
  // refuses does not make every stamp disagree forever. `ARCHIVE_ORDER` leads it because sorted
  // names cannot show a re-ranking, and a re-ranking is the other way a path changes hands.
  const composition = found
    .map((entry) => `${entry.isDirectory ? "directory" : "archive"}:${entry.name.toLowerCase()}`)
    .sort();
  const digest = createHash("sha1").update([ARCHIVE_ORDER, ...composition].join("\n")).digest("hex");

  return {
    /** Sources in the order they are searched, highest priority first. */
    get sources() {
      return sources.map((source) => ({ name: source.name, kind: source.kind }));
    },
    /** Archives that failed to open. Empty on a healthy client. */
    get skipped() {
      return skipped;
    },
    async has(path) {
      for (const source of sources) if (await source.has(path)) return true;
      return false;
    },
    /** The highest-priority copy of `path`, or undefined when nothing carries it. */
    async read(path) {
      for (const source of sources) {
        const data = await source.read(path);
        if (data) return data;
      }
      return undefined;
    },
    /**
     * Every path any source holds under `prefix`, lowercased and deduplicated.
     *
     * The union, not the winner: the question this answers is "is there a file here at all", which
     * is what decides whether a client asking for it gets a picture or a 404, and priority does not
     * enter into it. Loose overlays are walked; archives are read out of their listfiles, so an
     * archive without one contributes nothing (see `ArchiveSource.paths`).
     *
     * Measured on this machine over `Item\TextureComponents\`: 268 ms and 20,361 distinct paths on
     * a chain already open, against 1,724 ms for asking `has` about the 57,540 spellings the
     * `ItemDisplayInfo` names imply. The two agree on every one of the 57,540.
     */
    async list(prefix = "") {
      const paths = new Set();
      for (const source of sources) {
        for (const path of await source.paths(prefix)) paths.add(key(path));
      }
      return paths;
    },
    /** Which source a path resolves to. For diagnostics and tests. */
    async locate(path) {
      for (const source of sources) if (await source.has(path)) return source.name;
      return undefined;
    },
    /**
     * Files a patch **directory** holds that the chain answers from somewhere else, and everything
     * ranked above it that carries them — `{ path, overlay, shadowedBy }`, `shadowedBy` in search
     * order, so `shadowedBy[0]` is the copy the game actually reads.
     *
     * The case this exists for is on the owner's own machine. tswow builds its dataset into
     * `patch-ruRU-A.MPQ`, and `patch-ruRU-E.MPQ` — a 705 KB archive installed years ago and
     * forgotten — carries one of the same tables, `DBFilesClient\GameObjectDisplayInfo.dbc`. E is
     * the later letter, so E wins, and the real game client reads that copy: the day a module adds
     * a gameobject display, the client will not see it, and nothing anywhere will say why. Today it
     * is invisible because E's copy is byte-identical to the built one (5,892,387 bytes, 45,748
     * rows, sha1 e18aaad3f06621bbbdec634be6b2363bfb6bde92).
     *
     * The whole queue is reported rather than the winner alone because the winner alone is a trap.
     * `patch-ruRU-D.MPQ` sits between E and the build carrying the same one table, an older
     * revision of it (2,559,062 bytes, 18,647 rows, sha1
     * 4854a551dfcb6e07e1437bb72384c3185079abd5), so an operator told only about E would take E out
     * and hand the path to D — 45,748 rows replaced by 18,647, strictly worse than before, and
     * still not the table the module built.
     *
     * Only directories are asked about: an archive is not something a module writes into, and the
     * question is always "did the thing that was built lose to the thing that was installed".
     * `prefix` narrows it to one subtree — the gateway asks about `DBFilesClient\` at startup,
     * which is 245 of the 798 files here. Only what outranks each overlay is probed — three sources
     * above the build directory, where asking `locate` had to walk down to the overlay itself and
     * through the whole chain for anything it did not find: 20.5 ms for those 245 including the walk
     * that indexes the directories, and 7.9 ms for all 798 once that walk is warm.
     */
    async shadowedOverlayFiles(prefix = "") {
      const wanted = key(prefix);
      const shadowed = [];
      for (const [position, source] of sources.entries()) {
        if (source.kind !== "directory") continue;
        for (const path of await source.paths()) {
          if (wanted && !key(path).startsWith(wanted)) continue;
          // Only what outranks the overlay can shadow it, and that is the whole answer: the chain's
          // winner is the first source in this list, and when the list comes back empty the overlay
          // is the winner itself.
          const shadowedBy = [];
          for (const above of sources.slice(0, position)) {
            if (await above.has(path)) shadowedBy.push(above.name);
          }
          if (shadowedBy.length > 0) shadowed.push({ path, overlay: source.name, shadowedBy });
        }
      }
      return shadowed;
    },
    /** The composition of the chain, as a hash. See `digest` above. */
    chainDigest(order = ARCHIVE_ORDER) {
      return order === ARCHIVE_ORDER
        ? digest
        : createHash("sha1").update([order, ...composition].join("\n")).digest("hex");
    },
    /**
     * Everything a generated file has to record about one of its inputs: which source won the
     * path, the file that source is, and that file's size and mtime.
     *
     * `above` is the loose overlays that were searched first and did not have it. A directory can
     * gain a file without the chain's composition changing, and that file would then win the path.
     * `aboveArchives` is the same guard for real MPQs: replacing one in place can make it start
     * carrying a path that previously fell through to a lower source. Archives StormLib could not
     * open are included conservatively, because repairing one is exactly such a replacement.
     */
    async sourceOf(path) {
      const above = [];
      const aboveArchives = [];
      const opened = new Map(sources.map((source) => [source.file, source]));
      for (const entry of found) {
        const source = opened.get(entry.absolute);
        if (!source) {
          if (!entry.isDirectory) {
            try {
              const stats = await stat(entry.absolute);
              aboveArchives.push({ file: entry.absolute, size: stats.size, mtimeMs: stats.mtimeMs });
            } catch {
              // The chain fingerprint notices an unopened archive disappearing or reappearing.
            }
          }
          continue;
        }
        const file = await source.fileOf(path);
        if (file === undefined) {
          if (source.kind === "directory") above.push(source.name);
          else {
            try {
              const stats = await stat(source.file);
              aboveArchives.push({ file: source.file, size: stats.size, mtimeMs: stats.mtimeMs });
            } catch {
              // A disappearing archive changes the chain fingerprint before this stamp is used.
            }
          }
          continue;
        }
        const stats = await stat(file);
        return {
          path, name: source.name, kind: source.kind, file,
          size: stats.size, mtimeMs: stats.mtimeMs, above, aboveArchives,
        };
      }
      return undefined;
    },
    /**
     * What could make a path that is absent today appear without changing the chain's names.
     *
     * A loose overlay can gain the path while keeping the same directory name. A real MPQ can be
     * replaced in place while keeping the same archive name. Cache stamps record both facts so a
     * generated fallback does not survive the patch that finally supplies its source asset.
     */
    async absenceOf(path) {
      const loose = sources.filter((source) => source.kind === "directory").map((source) => source.name);
      const archives = [];
      // `found`, not only successfully opened sources: repairing a corrupt archive in place is
      // another way an absent path can appear under an unchanged chain composition.
      for (const entry of found) {
        if (entry.isDirectory) continue;
        try {
          const stats = await stat(entry.absolute);
          archives.push({ file: entry.absolute, size: stats.size, mtimeMs: stats.mtimeMs });
        } catch {
          // The chain fingerprint will notice an archive that disappears or reappears.
        }
      }
      return { path, loose, archives };
    },
    /** Reads many paths, reporting the misses rather than throwing on the first one. */
    async readAll(paths) {
      const files = new Map();
      const missing = [];
      for (const path of paths) {
        const data = await this.read(path);
        if (data) files.set(path, data);
        else missing.push(path);
      }
      return { files, missing };
    },
    close() {
      for (const source of sources) source.close();
      sources.length = 0;
    },
  };
}

/** One chain per client directory, shared by everything in the process. */
const chains = new Map();

export function clientArchives(clientDirectory) {
  let chain = chains.get(clientDirectory);
  if (!chain) {
    chain = openClientArchives(clientDirectory);
    chains.set(clientDirectory, chain);
  }
  return chain;
}
