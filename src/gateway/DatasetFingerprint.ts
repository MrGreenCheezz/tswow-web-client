// Noticing that the dataset changed, without a route that lets the network ask for it.
//
// Every DBC index the gateway serves is memoised for the life of the process, and every file under
// `data/` is keyed on a path or an id and on nothing else. Both were written when the dataset was
// something an operator built once. Under tswow it is edited while the gateway is running: a module
// adds a spell, rebuilds, and the answer to `/dbc/spells` is fixed until somebody restarts the
// process — which is the single reason a module's work is invisible in the client.
//
// The obvious fix is a reload route, and it is the wrong one here. README says it plainly: the
// gateway on `0.0.0.0` is an unauthenticated pipe and «Origin is a header the caller chooses, so it
// is not a control». A route that drops every cache is a route that costs the machine its whole
// asset cache to anyone who can reach the port. So nothing asks: the gateway watches the dataset
// itself, by fingerprint, and invalidates what actually changed.
//
// Two sets are watched, because they answer to different owners and cost different amounts.
// `dbc` is the dataset's DBC directory — 247 tables — plus the two dumps, which do not live beside
// them but in the repo's own `data/`: 249 files, 9.2 ms, and a change there drops the memoised
// indexes. `archives` is the client's `Data` directory: the 20 archive files themselves and the 798
// files under the `patch-*.MPQ` *directories*, which is where tswow writes a module's assets,
// 34.1 ms for the 818 together. Maps and vmaps are deliberately not watched: 5,744 and 15,087
// files, measured at 181.2 ms and 469.3 ms on this machine, four and eleven times the whole of the
// walk that is done, for two trees a module does not edit by hand.

import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/** One input file of a generated cache entry, as it was when the entry was written. */
export interface StampedFile {
  file: string;
  size: number;
  mtimeMs: number;
}

/** Which source won one path, and the file that source is. Written by `tools/source-stamp.mjs`. */
export interface StampedSource extends StampedFile {
  path: string;
  name: string;
  kind: "archive" | "directory";
  /** Loose overlays ranked above the winner. One of them gaining this path makes the entry stale. */
  above: string[];
  /** Real MPQs searched above the winner, plus any unopened MPQ tracked conservatively. */
  aboveArchives?: StampedFile[];
}

/** A source path that did not exist when a generated fallback was published. */
export interface StampedMissingSource {
  path: string;
  /** Loose overlays that can gain the path without changing the chain composition. */
  loose: string[];
  /** Real MPQs that can be replaced in place and start carrying the path. */
  archives: StampedFile[];
}

export interface CacheStamp {
  /** Generator/schema family; a route may require it to turn over legacy bytes once. */
  generation?: string;
  /** The composition of the archive chain, hashed over its sorted names. */
  chain: string;
  sources: StampedSource[];
  files: StampedFile[];
  /** Archive paths whose absence contributed to the generated result. */
  missingSources?: StampedMissingSource[];
  /** Plain files whose absence contributed to the generated result. */
  missingFiles?: string[];
}

export interface DatasetChange {
  /** Bumped whenever either set changed; a per-epoch memo is dropped by comparing against it. */
  epoch: number;
  dbc: boolean;
  archives: boolean;
}

export interface DatasetFingerprintOptions {
  /** The dataset's DBC directory. Without it the DBC half is not watched. */
  dbcDirectory?: string | undefined;
  /** Dataset-derived files that do not live in the DBC directory: the creature and item dumps. */
  dbcFiles?: readonly string[] | undefined;
  /** The client, i.e. the directory holding `Data`. Without it the archive half is not watched. */
  clientDirectory?: string | undefined;
  /** How often the fingerprint may be recomputed. What that costs is at the top of this file. */
  intervalMs?: number | undefined;
  /**
   * Let archive writes invalidate the interval immediately. The periodic walk remains the
   * fallback for filesystems on which `fs.watch` is unavailable or drops an event.
   */
  watchArchives?: boolean | undefined;
  /** For tests: the clock the interval is measured on. */
  now?: (() => number) | undefined;
  /**
   * Told when a walk starts failing and when it works again. Defaults to a warning on the console.
   *
   * A walk that throws is answered with «nothing changed», which is right for the half second a
   * build spends rewriting a directory and wrong for a drive that has gone away: from the outside
   * both look like a quiet dataset, and only one of them ends. Said once per streak rather than
   * once per poll, or a client left unplugged for an hour writes 1,800 identical lines.
   */
  onProblem?: ((message: string) => void) | undefined;
}

/** The suffix `tools/source-stamp.mjs` writes its sidecar under. */
const STAMP_SUFFIX = ".src";
/**
 * The identity of the ranking in `tools/mpq.mjs`, which leads the chain digest.
 *
 * The digest is hashed over the chain's sorted names so that this file, which never ranks anything,
 * can compute the same value — and sorted names cannot show that the ranking itself has changed,
 * though a change there hands paths to different sources. So the rule's own name is hashed with
 * them. It is duplicated rather than imported because `tools/` is plain .mjs run before anything is
 * compiled; `tests/dataset-fingerprint.test.mjs` fails the build if the two ever disagree. The
 * generation also turns over provenance schemas that could otherwise miss a winner change:
 * order-3 records real MPQs searched above a lower source.
 */
const ARCHIVE_ORDER = "order-3";
/**
 * Past this many checked entries the memo is emptied rather than grown.
 *
 * It holds one key per generated file this process has served since the last change, and the
 * largest family on this machine is 21,071 item icons, so a session cannot reach it honestly —
 * this is the bound that stops a long-lived gateway from holding a key for every file that ever
 * existed under `data/`.
 */
const VERIFIED_LIMIT = 65_536;

interface ArchiveWalk {
  hash: string;
  /** The composition digest, computed the way `tools/mpq.mjs` computes it. */
  chain: string;
  /** Per loose overlay, the paths it holds, normalised the way MPQ paths compare. */
  loose: Map<string, Set<string>>;
  files: number;
}

/** MPQ paths are case-insensitive and slash-agnostic; the same key rule as `tools/mpq.mjs`. */
function archiveKey(path: string): string {
  return path.replaceAll("/", "\\").toLowerCase();
}

async function stampOf(file: string): Promise<StampedFile | undefined> {
  try {
    const stats = await stat(file);
    return { file, size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Every file under one directory, as `(path, size, mtime)`.
 *
 * Size and mtime rather than content: hashing 247 DBC files is 130 MB of reading, and the question
 * is only ever "did anything change", which a build cannot answer with the same size and the same
 * timestamp.
 */
async function walkFiles(directory: string, into: string[], prefix = ""): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      // Symlinks are how tswow points a patch directory at a module's asset tree.
      try {
        isDirectory = (await stat(absolute)).isDirectory();
      } catch {
        continue;
      }
    }
    if (isDirectory) {
      // Lowercased on the way in, because these keys are compared against MPQ paths.
      await walkFiles(absolute, into, `${prefix}${entry.name.toLowerCase()}\\`);
      continue;
    }
    const stats = await stampOf(absolute);
    if (stats) into.push(`${prefix}${entry.name.toLowerCase()}|${stats.size}|${stats.mtimeMs}`);
  }
}

/**
 * Index loose add-on paths without statting every Lua/XML/media file on the periodic request path.
 * TOCs alone define installation, dependencies and load policy, so only they contribute mtimes to
 * the coarse fingerprint. Individual served files still carry source stamps and are checked on a
 * new gateway/process epoch; an autonomous pack is immutable for the lifetime of that process.
 */
async function walkAddonPaths(
  directory: string,
  held: Set<string>,
  lines: string[],
  prefix = "interface\\addons\\",
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    let directoryEntry = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try { directoryEntry = (await stat(absolute)).isDirectory(); } catch { continue; }
    }
    if (directoryEntry) {
      await walkAddonPaths(absolute, held, lines, `${prefix}${entry.name.toLowerCase()}\\`);
      continue;
    }
    const path = `${prefix}${entry.name.toLowerCase()}`;
    held.add(path);
    if (!entry.name.toLowerCase().endsWith(".toc")) continue;
    const stats = await stampOf(absolute);
    if (stats) lines.push(`interface/addons|${path}|${stats.size}|${stats.mtimeMs}`);
  }
}

function digest(lines: string[]): string {
  // Sorted, because a directory listing is not ordered by anything the caller controls, and a
  // fingerprint that changes with the order of a readdir is a fingerprint that reports noise.
  return createHash("sha1").update(lines.sort().join("\n")).digest("hex");
}

/** The fingerprint of the dataset tables: the DBC directory and the dumps that travel with it. */
export async function fingerprintDbc(directory: string | undefined, files: readonly string[] = []): Promise<{ hash: string; files: number }> {
  const lines: string[] = [];
  if (directory) await walkFiles(directory, lines);
  for (const file of files) {
    const stats = await stampOf(file);
    if (stats) lines.push(`${file.toLowerCase()}|${stats.size}|${stats.mtimeMs}`);
  }
  return { hash: digest(lines), files: lines.length };
}

/**
 * The fingerprint of the client's archive chain.
 *
 * Mirrors `openClientArchives`: an entry named `*.MPQ` is a source whether it is a file or a
 * directory, and anything else that is a directory is walked into.
 */
export async function fingerprintArchives(clientDirectory: string): Promise<ArchiveWalk> {
  const lines: string[] = [];
  const composition: string[] = [];
  const loose = new Map<string, Set<string>>();

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDirectory = (await stat(absolute)).isDirectory();
        } catch {
          continue;
        }
      }
      if (!/\.mpq$/i.test(entry.name)) {
        if (isDirectory) await walk(absolute);
        continue;
      }
      composition.push(`${isDirectory ? "directory" : "archive"}:${entry.name.toLowerCase()}`);
      if (!isDirectory) {
        const stats = await stampOf(absolute);
        if (stats) lines.push(`${entry.name.toLowerCase()}||${stats.size}|${stats.mtimeMs}`);
        continue;
      }
      const held = new Set<string>();
      const inner: string[] = [];
      await walkFiles(absolute, inner);
      for (const line of inner) {
        lines.push(`${entry.name.toLowerCase()}|${line}`);
        held.add(line.slice(0, line.indexOf("|")));
      }
      loose.set(entry.name.toLowerCase(), held);
    }
  };

  await walk(join(clientDirectory, "Data"));
  const addonsDirectory = join(clientDirectory, "Interface", "AddOns");
  try {
    if ((await stat(addonsDirectory)).isDirectory()) {
      const name = "interface/addons";
      composition.push(`directory:${name}`);
      const held = new Set<string>();
      await walkAddonPaths(addonsDirectory, held, lines);
      loose.set(name, held);
    }
  } catch {
    // Root-level add-ons are optional. Their directory appearing later changes the chain digest.
  }
  return {
    hash: digest(lines),
    chain: createHash("sha1").update([ARCHIVE_ORDER, ...composition.sort()].join("\n")).digest("hex"),
    loose,
    files: lines.length,
  };
}

function parseStamp(value: unknown): CacheStamp | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<CacheStamp>;
  if ((record.generation !== undefined && typeof record.generation !== "string")
    || typeof record.chain !== "string" || !Array.isArray(record.sources) || !Array.isArray(record.files)) return undefined;
  const stampedFile = (candidate: unknown): StampedFile | undefined => {
    if (typeof candidate !== "object" || candidate === null) return undefined;
    const file = candidate as Partial<StampedFile>;
    return typeof file.file === "string" && file.file.length > 0
      && typeof file.size === "number" && Number.isFinite(file.size) && file.size >= 0
      && typeof file.mtimeMs === "number" && Number.isFinite(file.mtimeMs)
      ? { file: file.file, size: file.size, mtimeMs: file.mtimeMs }
      : undefined;
  };
  const sources: StampedSource[] = [];
  for (const candidate of record.sources) {
    const file = stampedFile(candidate);
    if (!file || typeof candidate !== "object" || candidate === null) return undefined;
    const source = candidate as Partial<StampedSource>;
    if (typeof source.path !== "string" || source.path.length === 0
      || typeof source.name !== "string" || source.name.length === 0
      || (source.kind !== "archive" && source.kind !== "directory")
      || (source.above !== undefined
        && (!Array.isArray(source.above) || !source.above.every((name) => typeof name === "string")))
      || (source.aboveArchives !== undefined && !Array.isArray(source.aboveArchives))) {
      return undefined;
    }
    const aboveArchives: StampedFile[] = [];
    for (const candidate of source.aboveArchives ?? []) {
      const archive = stampedFile(candidate);
      if (!archive) return undefined;
      aboveArchives.push(archive);
    }
    sources.push({
      ...file,
      path: source.path,
      name: source.name,
      kind: source.kind,
      above: source.above ?? [],
      ...(aboveArchives.length ? { aboveArchives } : {}),
    });
  }
  const files: StampedFile[] = [];
  for (const candidate of record.files) {
    const file = stampedFile(candidate);
    if (!file) return undefined;
    files.push(file);
  }
  const missingSources: StampedMissingSource[] = [];
  if (record.missingSources !== undefined) {
    if (!Array.isArray(record.missingSources)) return undefined;
    for (const candidate of record.missingSources) {
      if (typeof candidate !== "object" || candidate === null) return undefined;
      const missing = candidate as Partial<StampedMissingSource>;
      if (typeof missing.path !== "string" || missing.path.length === 0
        || !Array.isArray(missing.loose) || !missing.loose.every((name) => typeof name === "string")
        || !Array.isArray(missing.archives)) return undefined;
      const archives: StampedFile[] = [];
      for (const archive of missing.archives) {
        const file = stampedFile(archive);
        if (!file) return undefined;
        archives.push(file);
      }
      missingSources.push({ path: missing.path, loose: [...missing.loose], archives });
    }
  }
  const missingFiles = record.missingFiles ?? [];
  if (!Array.isArray(missingFiles) || !missingFiles.every((file) => typeof file === "string" && file.length > 0)) {
    return undefined;
  }
  return {
    ...(record.generation ? { generation: record.generation } : {}),
    chain: record.chain,
    sources,
    files,
    ...(missingSources.length ? { missingSources } : {}),
    ...(missingFiles.length ? { missingFiles: [...missingFiles] } : {}),
  };
}

/**
 * Watches the dataset and says what has to be forgotten.
 *
 * Nothing here polls on a timer: an idle gateway costs nothing, and the 42.8 ms of the two walks
 * are paid by the first request after the interval has run out. A gateway also asks for an
 * archive watch: its event only marks the next request dirty, so steady-state `/texture` requests
 * still cost one clock read rather than the whole archive walk. The interval remains the fallback
 * because filesystem notifications are deliberately hints, not durable journal records. Forced
 * onto every request, the same 192 reads of `/texture` measure a median of 40.7 ms each instead of
 * 0.62 ms.
 */
export class DatasetFingerprint {
  readonly #dbcDirectory: string | undefined;
  readonly #dbcFiles: readonly string[];
  readonly #clientDirectory: string | undefined;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #report: (message: string) => void;

  /** True while the walks are throwing, so a streak is reported at both ends and not in between. */
  #failing = false;
  #dbcHash: string | undefined;
  #archivesHash: string | undefined;
  #chain: string | undefined;
  #loose = new Map<string, Set<string>>();
  #epoch = 0;
  #checkedAt: number | undefined;
  #pending: Promise<DatasetChange> | undefined;
  /** Incremented by the filesystem callback; a counter cannot lose an event that lands mid-walk. */
  #archiveRevision = 0;
  /** Revision included in the last complete archive walk. */
  #cleanArchiveRevision = 0;
  #archiveWatcher: FSWatcher | undefined;
  /** Cache file → the epoch its stamp was last checked in. */
  readonly #verified = new Map<string, number>();
  /** One filesystem stat per source path and epoch, shared by every cache entry that names it. */
  readonly #sourceStats = new Map<string, Promise<StampedFile | undefined>>();

  constructor(options: DatasetFingerprintOptions) {
    this.#dbcDirectory = options.dbcDirectory;
    this.#dbcFiles = options.dbcFiles ?? [];
    this.#clientDirectory = options.clientDirectory;
    this.#intervalMs = options.intervalMs ?? 2_000;
    this.#now = options.now ?? Date.now;
    this.#report = options.onProblem ?? ((message) => console.warn(`Dataset fingerprint: ${message}`));
    if (options.watchArchives && this.#clientDirectory !== undefined) {
      try {
        // TSWoW publishes both real MPQ files and directory-shaped MPQs, whose changed file may be
        // several levels below Data. Recursive watch is available on the desktop platforms this
        // gateway supports. If a volume cannot provide it, the interval walk below still works.
        this.#archiveWatcher = watch(
          join(this.#clientDirectory, "Data"),
          { recursive: true, persistent: false },
          () => { this.#archiveRevision++; },
        );
        this.#archiveWatcher.on("error", (error) => {
          this.#archiveRevision++;
          this.#report(`archive change notifications stopped: ${error.message}; using periodic fingerprint fallback`);
          this.#archiveWatcher?.close();
          this.#archiveWatcher = undefined;
        });
      } catch (error) {
        this.#report(
          `archive change notifications are unavailable: ${error instanceof Error ? error.message : String(error)}; `
          + "using periodic fingerprint fallback",
        );
      }
    }
  }

  /** Releases the optional filesystem notification handle. */
  close(): void {
    this.#archiveWatcher?.close();
    this.#archiveWatcher = undefined;
  }

  /** True when there is something to watch at all. */
  get watching(): boolean {
    return this.#dbcDirectory !== undefined || this.#dbcFiles.length > 0 || this.#clientDirectory !== undefined;
  }

  /**
   * Whether one stamped file still belongs to the watched dataset/client.
   *
   * Unlike `ensureCurrent`, this is read-only. Startup configuration uses it to decide whether an
   * ignored client-media DBC overlay can be paired with the active archive chain; deleting an
   * extracted table merely because its source pack is currently disabled would make switching
   * back needlessly destructive.
   */
  async isCurrent(cacheFile: string, options: { requireStamp?: boolean } = {}): Promise<boolean> {
    if (!this.watching) return !options.requireStamp;
    // `poll()` deliberately keeps serving through a temporarily unreadable dataset, but startup
    // overlay selection is a stricter question: without a successful client snapshot there is no
    // evidence that an extracted HD table belongs to the active archive chain.
    if (options.requireStamp && this.#clientDirectory !== undefined && this.#chain === undefined) {
      return false;
    }
    let stamp: CacheStamp | undefined;
    try {
      stamp = parseStamp(JSON.parse(await readFile(`${cacheFile}${STAMP_SUFFIX}`, "utf8")) as unknown);
    } catch {
      return !options.requireStamp;
    }
    if (!stamp) return !options.requireStamp;
    return !await this.#stale(stamp);
  }

  /**
   * Recomputes at most once per interval, and reports what changed since the last time it did.
   *
   * Concurrent callers share one walk: on a busy gateway the alternative is one walk per request
   * in flight when the interval runs out.
   */
  async poll(options: { force?: boolean } = {}): Promise<DatasetChange> {
    if (this.#pending) return this.#pending;
    const now = this.#now();
    const invalidated = this.#archiveRevision !== this.#cleanArchiveRevision;
    if (!options.force && !invalidated
      && this.#checkedAt !== undefined && now - this.#checkedAt < this.#intervalMs) {
      return { epoch: this.#epoch, dbc: false, archives: false };
    }
    const archiveRevision = this.#archiveRevision;
    this.#pending = this.#recompute().then(({ change, complete }) => {
      // Do not consume an event after a failed walk, or one that arrived while the walk was in
      // progress. In both cases the next request bypasses the interval and tries the whole atomic
      // snapshot again.
      if (complete) this.#cleanArchiveRevision = archiveRevision;
      return change;
    }).finally(() => {
      this.#pending = undefined;
      this.#checkedAt = this.#now();
    });
    return this.#pending;
  }

  async #recompute(): Promise<{ change: DatasetChange; complete: boolean }> {
    let dbc: { hash: string; files: number };
    let archives: ArchiveWalk | undefined;
    try {
      // Both walks before anything is written down. A tswow build rewrites `dataset/dbc` and
      // `patch-ruRU-A.MPQ` in the same run, so "the DBC hash is already new" and "the Data walk
      // ran into a directory being replaced" are the same instant — and committing the first
      // half and then throwing would move the baseline past a change nobody was ever told about.
      // The DBC edit would then stay invisible until somebody restarted the process, which is the
      // one thing this file exists to prevent. Same for a `Data` directory that goes away for
      // good: without this, every DBC edit for the rest of the process's life is swallowed.
      dbc = await fingerprintDbc(this.#dbcDirectory, this.#dbcFiles);
      archives = this.#clientDirectory === undefined ? undefined : await fingerprintArchives(this.#clientDirectory);
    } catch (error) {
      // A dataset half-written by a build in progress, or a directory that is not there yet.
      // Keeping the last fingerprint means the next poll sees the finished state as the change,
      // rather than reporting the middle of a build as one and then reporting the end as another.
      if (!this.#failing) {
        this.#failing = true;
        this.#report(`${error instanceof Error ? error.message : String(error)} — nothing is being watched until this clears`);
      }
      return { change: { epoch: this.#epoch, dbc: false, archives: false }, complete: false };
    }
    if (this.#failing) {
      this.#failing = false;
      this.#report("the dataset can be read again");
    }
    const dbcChanged = this.#dbcHash !== undefined && dbc.hash !== this.#dbcHash;
    const archivesChanged = archives !== undefined && this.#archivesHash !== undefined && archives.hash !== this.#archivesHash;
    this.#dbcHash = dbc.hash;
    if (archives !== undefined) {
      this.#archivesHash = archives.hash;
      this.#chain = archives.chain;
      this.#loose = archives.loose;
    }
    if (dbcChanged || archivesChanged) {
      this.#epoch++;
      this.#sourceStats.clear();
    }
    return { change: { epoch: this.#epoch, dbc: dbcChanged, archives: archivesChanged }, complete: true };
  }

  #sourceStamp(file: string): Promise<StampedFile | undefined> {
    let pending = this.#sourceStats.get(file);
    if (!pending) {
      pending = stampOf(file);
      this.#sourceStats.set(file, pending);
    }
    return pending;
  }

  /**
   * Brings one generated file into line with the dataset before it is served.
   *
   * Three cases, and the third is the one that decides what a first zone visit costs.
   *
   * A stamp that agrees with the dataset costs one memo lookup for the rest of the epoch. A stamp
   * that disagrees means the entry was built out of something that has since moved, so it goes and
   * the caller's ordinary miss path rebuilds it — that one file and no other: `data/visual-models`
   * is 112 MB and `data/item-icons` is 21,071 files, and one replaced texture is no reason to pay
   * for either again.
   *
   * No stamp at all means the entry was published before stamps existed, and on this machine that
   * is 23,025 of the 24,796 published files. This used to ask for it to be rebuilt, once, so that
   * it gained one — right for a cache that fills a file at a time, and wrong for a whole tree that
   * a bulk pass filled, because every one of those entries would then be a generator process on
   * its family's serial lane: a texture is 308 ms, a city WMO or a terrain tile is seconds, and a
   * player walking into a zone whose art is all published and all correct would wait minutes for
   * pictures that never changed. `ef685e6` measured that shape for the 3,204 published spell icons
   * — sixteen requests, sixteen processes, 5,921 ms — and `tools/restamp.mjs` is the general
   * answer: one process, off the request path, that derives each entry's stamp from its inputs
   * without rendering anything.
   *
   * So an entry with no stamp is served exactly as it stands. It is unwatched until that pass
   * reaches it, which is the price of not stalling the request, and the pass is started once at
   * startup rather than by a request.
   */
  async ensureCurrent(cacheFile: string, options: { requireStamp?: boolean; generation?: string } = {}): Promise<void> {
    // With neither a dataset nor a client configured there is nothing for a stamp to be measured
    // against and no epoch will ever move, so every answer this could give would be a guess. A
    // gateway handed only a directory of published assets — which is what several of the tests
    // are, and what a machine serving somebody else's `data/` would be — serves them as they are.
    if (!this.watching) return;
    if (this.#verified.get(cacheFile) === this.#epoch) return;
    let stamp: CacheStamp | undefined;
    try {
      stamp = parseStamp(JSON.parse(await readFile(`${cacheFile}${STAMP_SUFFIX}`, "utf8")) as unknown);
    } catch {
      if (options.requireStamp || options.generation !== undefined) {
        // A coordinated visual M2/BLP pack must not reuse an unstamped legacy PNG from the stock
        // client. Keep the default unstamped-cache policy for broad scenery/icon caches, but let
        // the caller that knows the bytes must match the current visual pack force regeneration.
        await unlink(cacheFile).catch(() => undefined);
        await unlink(`${cacheFile}${STAMP_SUFFIX}`).catch(() => undefined);
        return;
      }
      // No stamp, or an unreadable one: served as it stands, and remembered as such for this
      // epoch. A stamp the restamp pass writes a moment later is therefore not read until the
      // epoch moves — which is exactly when it starts to matter, since nothing was stale until
      // something in the dataset moved.
    }
    if (options.generation !== undefined && stamp?.generation !== options.generation) {
      await unlink(cacheFile).catch(() => undefined);
      await unlink(`${cacheFile}${STAMP_SUFFIX}`).catch(() => undefined);
      return;
    }
    if (stamp && await this.#stale(stamp)) {
      await unlink(cacheFile).catch(() => undefined);
      await unlink(`${cacheFile}${STAMP_SUFFIX}`).catch(() => undefined);
      return;
    }
    if (this.#verified.size >= VERIFIED_LIMIT) this.#verified.clear();
    this.#verified.set(cacheFile, this.#epoch);
  }

  async #stale(stamp: CacheStamp): Promise<boolean> {
    // Nothing can be said about the archive half of a stamp without a client to say it against,
    // and "cannot say" must not become "delete": a machine serving a published `data/` with no
    // client beside it would lose one entry per request and be unable to rebuild a single one.
    // The plain files below are the dataset's own and are watched either way.
    if (this.#clientDirectory !== undefined) {
      // A source appearing or disappearing can change which file wins a path without touching any
      // file this entry knows about, so the composition is checked first and settles it alone.
      if (this.#chain !== undefined && stamp.chain !== this.#chain) return true;
      for (const source of stamp.sources) {
        for (const name of source.above ?? []) {
          if (this.#loose.get(name.toLowerCase())?.has(archiveKey(source.path))) return true;
        }
        for (const archive of source.aboveArchives ?? []) {
          const current = await this.#sourceStamp(archive.file);
          if (!current || current.size !== archive.size || current.mtimeMs !== archive.mtimeMs) return true;
        }
        const current = await this.#sourceStamp(source.file);
        if (!current) {
          // Whatever supplied the generated bytes is gone. The composition check normally catches
          // an archive removal first, but treating the direct evidence as stale also covers a
          // same-name source being replaced between the two snapshots.
          return true;
        }
        if (current.size !== source.size || current.mtimeMs !== source.mtimeMs) return true;
      }
      for (const missing of stamp.missingSources ?? []) {
        const path = archiveKey(missing.path);
        for (const name of missing.loose) {
          if (this.#loose.get(name.toLowerCase())?.has(path)) return true;
        }
        for (const archive of missing.archives) {
          const current = await this.#sourceStamp(archive.file);
          if (!current || current.size !== archive.size || current.mtimeMs !== archive.mtimeMs) return true;
        }
      }
    }
    for (const file of stamp.files) {
      const current = await this.#sourceStamp(file.file);
      if (!current || current.size !== file.size || current.mtimeMs !== file.mtimeMs) return true;
    }
    for (const file of stamp.missingFiles ?? []) if (await this.#sourceStamp(file)) return true;
    return false;
  }
}
