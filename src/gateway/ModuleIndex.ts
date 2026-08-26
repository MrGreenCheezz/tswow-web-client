import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * What every tswow module on this machine ships for the web client, and where to fetch it.
 *
 * A module author edits a file on disk; the browser has no way to see a disk. This is the routes in
 * between — an index that says what exists, a reader that hands one file over, and a writer that
 * is switched off — and nothing else. М3 shaped it so that М6 could only ever *add* keys, and М6
 * did exactly that: a `ModuleEntry` grew `windows` and `css` beside `messages`, and a browser
 * written against М3's JSON goes on working.
 *
 * ## Why the index is rebuilt on every request
 *
 * Because the point of it is to notice an edit. Every other index in this gateway is memoised for
 * the life of the process (`Gateway.ts`'s `??=` holders), which is right for a DBC that only
 * changes when the dataset is rebuilt and wrong for a file the author is editing while looking at
 * the game: М6 re-polls this index every two seconds and rebuilds the window whose sha1 moved.
 * Measured on this machine, warm, median of 20 runs — and then the whole procedure four times over,
 * because a single median of a directory scan is not reproducible to the digit: the scan of
 * `data/ui` plus the configured TSWoW modules as measured — two modules, no schema
 * files — lands between 0.20 and 0.31 ms, and two modules holding four schema files across both
 * roots between 0.93 and 1.28 ms. Both are less than the round trip that asked for them.
 *
 * ## Why sha1 and not mtime alone
 *
 * mtime says a file was written; sha1 says its contents changed. An editor that saves on every
 * keystroke moves the first constantly and the second only when there is something to rebuild, and
 * a rebuild throws away the window's state.
 */

/** One definition file, as the index lists it. */
export interface ModuleFileEntry {
  /** The bare filename, which is also the last path segment of its route. */
  readonly file: string;
  /**
   * Which root this copy came from: `"draft"` for `data/ui`, `"module"` for a tswow module.
   *
   * Per file rather than per module, and that is the whole fix behind it: a draft shadows one
   * *file*, not a module, so `shop/shop.json` can be a draft while `shop/prices.json` beside it is
   * still the module's own. A source on the module would have to lie about one of the two, and the
   * one thing the browser has to be able to say is which copy it is holding.
   */
  readonly source: string;
  readonly sha1: string;
  readonly mtimeMs: number;
  readonly bytes: number;
}

export interface ModuleEntry {
  readonly module: string;
  readonly messages: ModuleFileEntry[];
  /** `content/ui/*.json` — one window definition each. Added by М6; `messages` kept as it was. */
  readonly windows: ModuleFileEntry[];
  /** `content/css/*.css` — module stylesheets, scoped to `[data-module]` by the loader. */
  readonly css: ModuleFileEntry[];
}

export interface ModuleIndex {
  readonly modules: ModuleEntry[];
}

/** A root to scan, as `tools/paths.mjs`'s `moduleDirectories()` describes one. */
export interface ModuleRoot {
  readonly root: string;
  /** The level between `<module>` and the definition directories; `"content"` or `""`. */
  readonly inner: string;
  readonly source: string;
}

/**
 * The definition kinds a module may ship, and which key of a {@link ModuleEntry} each fills.
 *
 * The route validation follows from this table rather than from a second copy of the same regular
 * expressions, and so does the scan: adding a kind is a row here.
 *
 * The route name and the directory name are the same word except for `ui`, whose files are listed
 * under `windows` — the index is a list of *what a module ships*, and «windows» is what a modder
 * calls them, while `/modules/ui/…` is the address the studio's own directory name gives them.
 */
export interface ModuleFileKind {
  readonly directory: string;
  readonly extension: string;
  readonly key: "messages" | "windows" | "css";
}

/**
 * A null prototype, because the kind is a path segment out of a URL.
 *
 * With an ordinary object literal `MODULE_FILE_KINDS["constructor"]` is a function and
 * `"constructor" in MODULE_FILE_KINDS` is true, so `/modules/constructor/shop/x.undefined` walked
 * into the file block, read `.extension` off `Object` and answered 500 with a stack trace in the
 * log — where a kind nobody declares gets a 404. {@link moduleFileKind} is the second lock on the
 * same door, so that neither a caller that forgets `Object.hasOwn` nor a table that is rebuilt as a
 * literal one day can reopen it.
 */
export const MODULE_FILE_KINDS: Readonly<Record<string, ModuleFileKind>> = Object.assign(
  Object.create(null) as Record<string, ModuleFileKind>,
  {
    messages: { directory: "messages", extension: ".json", key: "messages" },
    ui: { directory: "ui", extension: ".json", key: "windows" },
    css: { directory: "css", extension: ".css", key: "css" },
  } as Record<string, ModuleFileKind>,
);

/** One declared kind by name, and nothing for a name that is not one. */
export function moduleFileKind(kind: string): ModuleFileKind | undefined {
  return Object.hasOwn(MODULE_FILE_KINDS, kind) ? MODULE_FILE_KINDS[kind] : undefined;
}

/**
 * Modules listed at once, and files listed per module.
 *
 * A ceiling rather than a paging scheme: the index is answered on a request from a browser that is
 * about to fetch every file in it, so an unbounded answer is an unbounded number of round trips.
 * 64 × 64 is two orders of magnitude over what the owner's studio writes — one file per screen —
 * and a module that hits it has a generator loose in its directory.
 */
const MAX_MODULES = 64;
const MAX_FILES_PER_MODULE = 64;

/** The largest definition file the routes will read. Answered as 413, never truncated. */
export const MAX_MODULE_FILE_BYTES = 256 * 1024;

/** A module name that can be a directory and a URL segment, and cannot be `..`. */
export function validModuleName(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/**
 * A definition filename.
 *
 * The same shape as {@link validModuleName} plus the kind's extension, which by construction rules
 * out `..`, a separator of either kind and an absolute path — the three things `validTexturePath`
 * checks for by hand on a path that has to be allowed to hold separators. This one does not.
 */
export function validModuleFileName(value: string, kind: string): boolean {
  const spec = moduleFileKind(kind);
  if (!spec) return false;
  if (!value.toLowerCase().endsWith(spec.extension)) return false;
  return validModuleName(value.slice(0, value.length - spec.extension.length));
}

async function listFiles(directory: string, extension: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
      .map((entry) => entry.name)
      .sort();
  } catch {
    // A module with no directory of this kind is the normal case, not a failure: measured today,
    // one of the two modules on this machine ships `ui/` and neither ships `messages/` or `css/`.
    return [];
  }
}

async function describe(directory: string, file: string, source: string): Promise<ModuleFileEntry | undefined> {
  try {
    const stats = await stat(join(directory, file));
    // A file over the ceiling is left out of the index rather than listed and then refused with a
    // 413: the browser fetches everything the index names, and listing something unfetchable would
    // turn one bad file into a failed load every time the index is polled.
    if (!stats.isFile() || stats.size > MAX_MODULE_FILE_BYTES) return undefined;
    const data = await readFile(join(directory, file));
    return {
      file,
      source,
      sha1: createHash("sha1").update(data).digest("hex"),
      mtimeMs: Math.round(stats.mtimeMs),
      bytes: stats.size,
    };
  } catch {
    return undefined;
  }
}

/** Where one module's definitions of a kind live, under one root. */
export function moduleFileDirectory(root: ModuleRoot, module: string, kind: string): string | undefined {
  const spec = moduleFileKind(kind);
  if (!spec || !validModuleName(module)) return undefined;
  return root.inner ? join(root.root, module, root.inner, spec.directory) : join(root.root, module, spec.directory);
}

/**
 * Everything the browser may ask for, scanned now.
 *
 * A root that does not exist is not an error — `data/ui` is absent until somebody drafts something,
 * and a machine with no tswow install has no modules — so it contributes nothing and the index is
 * still an index. A module with no definition files at all is left out entirely, which is what
 * keeps today's answer `{"modules":[]}` rather than two empty rows.
 *
 * ## Why the roots are merged per file rather than listed one after another
 *
 * Because {@link readModuleFile} answers per file, from the first root that has it, and an index
 * that says anything else is a lie the browser cannot check. Listing both copies of a shadowed
 * `shop/shop.json` — which is what this did until the review caught it — published one entry whose
 * sha1 the route would never return, made the loader fetch the same URL twice, and had the second
 * copy refused by the registry as a collision *with its own module*: «module "shop": shop.State is
 * already defined by module "shop"». М6 would have taken the phantom sha1 as a permanent change
 * and rebuilt that window on every two-second poll, forever.
 *
 * So: one entry per module, one file entry per name, taken from the first root that has that name,
 * and every file entry carries the root it came from. A module whose draft holds one of its three
 * files still lists all three — one draft and two module copies — which is what «shadowing» has to
 * mean if a draft is to be tried without moving the rest of the module out of the way.
 */
export async function readModuleIndex(roots: readonly ModuleRoot[]): Promise<ModuleIndex> {
  const byModule = new Map<string, { messages: ModuleFileEntry[]; windows: ModuleFileEntry[]; css: ModuleFileEntry[] }>();
  for (const root of roots) {
    let names: string[];
    try {
      names = (await readdir(root.root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && validModuleName(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch {
      continue;
    }
    for (const module of names) {
      const listed = byModule.get(module);
      if (!listed && byModule.size >= MAX_MODULES) continue;
      const lists = listed ?? { messages: [], windows: [], css: [] };
      for (const [kind, spec] of Object.entries(MODULE_FILE_KINDS)) {
        const directory = moduleFileDirectory(root, module, kind);
        if (!directory) continue;
        const into = lists[spec.key];
        for (const file of await listFiles(directory, spec.extension)) {
          if (into.length >= MAX_FILES_PER_MODULE) break;
          if (!validModuleFileName(file, kind)) continue;
          // Claimed by an earlier root, so this copy is the one the route will not answer with.
          if (into.some((entry) => entry.file === file)) continue;
          const entry = await describe(directory, file, root.source);
          if (entry) into.push(entry);
        }
      }
      // A module with nothing at all for this client is left out entirely, which is what keeps an
      // answer of `{"modules":[]}` rather than one empty row per module directory on the machine.
      const anything = lists.messages.length + lists.windows.length + lists.css.length;
      if (anything && !listed) byModule.set(module, lists);
    }
  }
  // Sorted by name at the end rather than left in the order the roots were walked: which root a
  // file came from is a fact about this machine, and a list that reshuffles itself the day somebody
  // drafts one file is a list nothing can be compared against. The same order `listFiles` uses.
  const byName = (left: ModuleFileEntry, right: ModuleFileEntry): number => (left.file < right.file ? -1 : 1);
  const modules: ModuleEntry[] = [];
  for (const [module, lists] of byModule) {
    modules.push({
      module,
      messages: lists.messages.sort(byName),
      windows: lists.windows.sort(byName),
      css: lists.css.sort(byName),
    });
  }
  return { modules };
}

export type ModuleFileResult =
  | { readonly kind: "file"; readonly data: Buffer }
  | { readonly kind: "missing" }
  | { readonly kind: "too-large"; readonly bytes: number };

/**
 * One definition file by module and name, from the first root that has it.
 *
 * First rather than merged, and `moduleDirectories()` puts `data/ui` first for that reason: a draft
 * shadowing a module's own file is how a change is tried before it is written into the module.
 * {@link readModuleIndex} walks the same roots in the same order and lists exactly the copy this
 * returns, so the `source` and the `sha1` beside a file are facts about the bytes the browser will
 * be handed rather than about a file it can never reach.
 */
export async function readModuleFile(
  roots: readonly ModuleRoot[], kind: string, module: string, file: string,
): Promise<ModuleFileResult> {
  if (!validModuleName(module) || !validModuleFileName(file, kind)) return { kind: "missing" };
  for (const root of roots) {
    const directory = moduleFileDirectory(root, module, kind);
    if (!directory) continue;
    const path = join(directory, file);
    try {
      const stats = await stat(path);
      if (!stats.isFile()) continue;
      if (stats.size > MAX_MODULE_FILE_BYTES) return { kind: "too-large", bytes: stats.size };
      return { kind: "file", data: await readFile(path) };
    } catch {
      continue;
    }
  }
  return { kind: "missing" };
}

/* ---------------------------------------------------------------------------------------------
 * Writing one back
 * ------------------------------------------------------------------------------------------- */

/**
 * Whether a request came from this machine.
 *
 * `node:net` writes an IPv4 address as itself and an IPv4-mapped IPv6 one as `::ffff:127.0.0.1`,
 * so both spellings of the loopback address have to be recognised — a check for `"127.0.0.1"`
 * alone refuses a browser on the same machine whenever the socket happened to be opened over IPv6,
 * which is the ordinary case for `localhost` on Windows.
 *
 * This is deliberately about the *socket* and not about a header: `X-Forwarded-For` and `Host` are
 * written by whoever is talking, and the whole point of this check is that the writer cannot be
 * somewhere else.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const bare = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return bare === "127.0.0.1" || bare === "::1" || bare.startsWith("127.");
}

export type ModuleWriteResult =
  | { readonly kind: "written"; readonly path: string }
  | { readonly kind: "bad-name" }
  | { readonly kind: "too-large"; readonly bytes: number }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Writes one definition file into the **first** root, which is the drafts directory.
 *
 * First rather than "wherever the file is now", and that is the safety property rather than a
 * convenience: the builder overlay (М8) saves what somebody is editing, and a gateway that could
 * overwrite a file inside the configured TSWoW modules would be able to rewrite a module's
 * shipped source from a web page. A draft shadows the module's copy for reading — see
 * {@link readModuleFile} — so the edit takes effect immediately and the module's own file is still
 * there to go back to.
 */
export async function writeModuleFile(
  roots: readonly ModuleRoot[], kind: string, module: string, file: string, data: Buffer,
): Promise<ModuleWriteResult> {
  if (!validModuleName(module) || !validModuleFileName(file, kind)) return { kind: "bad-name" };
  if (data.byteLength > MAX_MODULE_FILE_BYTES) return { kind: "too-large", bytes: data.byteLength };
  const root = roots[0];
  if (!root) return { kind: "failed", reason: "no module directory is configured" };
  const directory = moduleFileDirectory(root, module, kind);
  if (!directory) return { kind: "bad-name" };
  const path = join(directory, file);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return { kind: "written", path };
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
