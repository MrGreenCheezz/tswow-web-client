/**
 * 25.10 (serve S3): the interface corpus a screen needs, as one answer instead of one request a file.
 *
 * The glue screens and the world UI read their Lua/XML/TOC through `/client/file`, one file a request:
 * the GlueXML TOC closure and FrameXML's (≈660 files, ≈16 MB on this client) — and since XML names its
 * `Include`s only once it is parsed, part of that is a waterfall of round trips. For a player across the
 * internet each of those is a full round trip, and every later session revalidates all of them again.
 *
 * `walkInterfaceCorpus` follows a set of TOCs the way the browser's loaders do (GlueLoader.ts
 * `parseGlueToc`/`resolveGluePath`, FrameXmlCorpus.ts `scan`): TOC lines, `#` lines skipped, `.lua`/`.xml`
 * entries resolved against the TOC's directory and refused when they climb out of `interface/`; an XML
 * file's `<Include file>` and `<Script file>` resolved against its own directory. It reads every such
 * reference anywhere in the file (comments removed), not only the top-level ones the loaders follow, so
 * the bundle is a superset of what a loader asks for — never a different corpus: what is in it is the
 * very file `/client/file` serves, and anything the loader asks for that is not in it is fetched by the
 * old route (`InterfaceBundleClient.ts`), so add-ons loaded later, module files and drafts work as before.
 *
 * The gateway keeps no parser of its own beyond these two patterns, which is the browser/gateway
 * boundary: it lists and reads files, the browser decides what they mean.
 */

/** The bundle sets the browser asks for. */
export const INTERFACE_BUNDLE_SETS = ["glue", "world"] as const;
export type InterfaceBundleSet = typeof INTERFACE_BUNDLE_SETS[number];

export const INTERFACE_BUNDLE_SCHEMA = "interface-bundle-1";
export const GLUE_TOC = "interface/gluexml/gluexml.toc";
export const FRAMEXML_TOC = "interface/framexml/framexml.toc";

/** Lowercase, forward slashes, no leading slash — GlueLoader.ts `normalizeGluePath`. */
export function normalizeInterfacePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
}

/** GlueLoader.ts `resolveGluePath`: `..` works down to `interface/`, anything climbing out is refused. */
export function resolveInterfacePath(baseDirectory: string, reference: string): string | undefined {
  const stack = normalizeInterfacePath(baseDirectory).split("/").filter(Boolean);
  for (const part of normalizeInterfacePath(reference).split("/").filter(Boolean)) {
    if (part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return undefined;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  if (stack[0] !== "interface") return undefined;
  return stack.join("/");
}

function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

/** The `.lua`/`.xml` entries of a TOC, in order (GlueLoader.ts `parseGlueToc`). */
export function interfaceTocEntries(source: string, tocPath: string): string[] {
  const directory = directoryOf(normalizeInterfacePath(tocPath));
  const entries: string[] = [];
  for (const raw of source.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const resolved = resolveInterfacePath(directory, line);
    if (resolved && (resolved.endsWith(".xml") || resolved.endsWith(".lua"))) entries.push(resolved);
  }
  return entries;
}

const REFERENCE = /<\s*(?:Include|Script)\b[^>]*?\bfile\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** Every `<Include file>` / `<Script file>` of an XML file, resolved against its directory (comments removed). */
export function interfaceXmlReferences(source: string, xmlPath: string): string[] {
  const directory = directoryOf(normalizeInterfacePath(xmlPath));
  const references: string[] = [];
  for (const match of source.replace(/<!--[\s\S]*?-->/g, "").matchAll(REFERENCE)) {
    const resolved = resolveInterfacePath(directory, match[1] ?? match[2] ?? "");
    if (resolved && (resolved.endsWith(".xml") || resolved.endsWith(".lua"))) references.push(resolved);
  }
  return references;
}

export interface InterfaceCorpus {
  /** Path → text, in the order the walk met them. Zero-byte files are kept (a loader skips them itself). */
  readonly files: Map<string, string>;
  /** Paths the chain does not hold (what `/client/file` answers 404 for). */
  readonly absent: string[];
  /** Paths whose read failed (a 500 there): left out of both lists, so the browser asks the old route. */
  readonly failed: string[];
  /** Whether a bound stopped the walk early. */
  readonly truncated: boolean;
}

export interface WalkOptions {
  /** `undefined`: the chain has no such file. Throws: the read failed. */
  readonly read: (path: string) => Promise<string | undefined>;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly concurrency?: number;
}

/**
 * Reads the closure of `tocs` (see the file comment), a few files at a time. Bounded: 4,096 files and
 * 64 MB of text by default, far above the 3.3.5a corpus (≈660 files).
 */
/** `tocOnly`: TOCs read but not followed (an installed add-on whose TOC is read for its metadata alone). */
export async function walkInterfaceCorpus(
  tocs: readonly string[], options: WalkOptions, tocOnly: readonly string[] = [],
): Promise<InterfaceCorpus> {
  const maxFiles = options.maxFiles ?? 4096;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const concurrency = options.concurrency ?? 8;
  const files = new Map<string, string>();
  const absent: string[] = [];
  const failed: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  let bytes = 0;
  let truncated = false;
  const enqueue = (path: string): void => {
    if (seen.has(path)) return;
    if (seen.size >= maxFiles) {
      truncated = true;
      return;
    }
    seen.add(path);
    queue.push(path);
  };
  for (const toc of tocs) enqueue(normalizeInterfacePath(toc));
  const leaves = new Set<string>();
  for (const toc of tocOnly) {
    const path = normalizeInterfacePath(toc);
    if (!seen.has(path)) leaves.add(path);
    enqueue(path);
  }

  const visit = async (path: string): Promise<void> => {
    let source: string | undefined;
    try {
      source = await options.read(path);
    } catch {
      failed.push(path);
      return;
    }
    if (source === undefined) {
      absent.push(path);
      return;
    }
    bytes += source.length;
    if (bytes > maxBytes) {
      truncated = true;
      return;
    }
    files.set(path, source);
    if (leaves.has(path)) return;
    if (path.endsWith(".toc")) for (const entry of interfaceTocEntries(source, path)) enqueue(entry);
    else if (path.endsWith(".xml")) for (const reference of interfaceXmlReferences(source, path)) enqueue(reference);
  };

  // A pool over a queue that grows as files are read: workers wait for the ones in flight before giving up.
  const inFlight = new Set<Promise<void>>();
  while (queue.length > 0 || inFlight.size > 0) {
    while (queue.length > 0 && inFlight.size < concurrency) {
      const run = visit(queue.shift()!).finally(() => inFlight.delete(run));
      inFlight.add(run);
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
  }
  return { files, absent, failed, truncated };
}

/** An add-on name as Wow.exe and ClientAddons.ts accept it. */
export const INTERFACE_ADDON_NAME = /^[!A-Za-z0-9_][!A-Za-z0-9_-]{0,63}$/;

/** One add-on's TOC path. */
export function interfaceAddonToc(name: string): string {
  const lower = name.toLowerCase();
  return `interface/addons/${lower}/${lower}.toc`;
}

/**
 * The TOCs of one set whose closure is read: GlueXML for `glue`; FrameXML for `world`, plus the add-ons the
 * browser names (the ones its world mount loads or prefetches in the loading window).
 */
export function interfaceBundleTocs(set: InterfaceBundleSet, addons: readonly string[]): string[] {
  if (set === "glue") return [GLUE_TOC];
  return [FRAMEXML_TOC, ...addons.map(interfaceAddonToc)];
}

/** The answer's JSON: `{ schema, set, files: { path: text }, absent: [path] }`. */
export function encodeInterfaceBundle(set: InterfaceBundleSet, corpus: InterfaceCorpus): string {
  return JSON.stringify({ schema: INTERFACE_BUNDLE_SCHEMA, set, files: Object.fromEntries(corpus.files), absent: corpus.absent });
}
