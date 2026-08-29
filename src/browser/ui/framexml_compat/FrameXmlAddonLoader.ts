import { FrameXmlUiBridge } from "./FrameXmlRuntime.js";
import { parseFrameXml } from "./FrameXmlParser.js";
import {
  FRAME_XML_WIDGET_TYPES,
  type FrameXmlDiagnostic,
  type FrameXmlElement,
  type FrameXmlFrame,
} from "./FrameXmlTypes.js";

/** A resource map supplied by a trusted host; this module only reads it. */
export type FrameXmlAddonFiles =
  | ReadonlyMap<string, string>
  | Readonly<Record<string, string>>;

export interface FrameXmlAddonBundle {
  /** Display name used to scope diagnostics. */
  readonly name?: string;
  readonly addonName?: string;
  readonly toc?: string;
  readonly tocSource?: string;
  readonly files?: FrameXmlAddonFiles;
  readonly resources?: FrameXmlAddonFiles;
}

export interface FrameXmlAddonLimits {
  /** Maximum number of resource names accepted from the bundle. */
  readonly maxFiles: number;
  /** Maximum UTF-8 bytes retained from the TOC and referenced source files. */
  readonly maxBytes: number;
  /** Maximum recursive Include depth. */
  readonly maxDepth: number;
  /** Maximum expanded XML/Lua file operations, including repeated includes. */
  readonly maxEntries: number;
}

export interface FrameXmlAddonLoaderOptions {
  readonly limits?: Partial<FrameXmlAddonLimits>;
}

export interface FrameXmlAddonTocEntry {
  readonly path: string;
  readonly kind: "xml" | "lua";
}

export interface FrameXmlAddonTocParseResult {
  readonly ok: boolean;
  readonly metadata: Readonly<Record<string, string>>;
  readonly entries: readonly FrameXmlAddonTocEntry[];
  readonly diagnostics: readonly string[];
}

export interface FrameXmlAddonEntry {
  readonly path: string;
  readonly kind: "xml" | "lua";
  readonly source: string;
  readonly origin: "toc" | "include" | "script";
  readonly includedFrom?: string;
}

export interface FrameXmlAddonLuaChunk {
  readonly path: string;
  readonly source: string;
  readonly origin: "toc" | "script";
  readonly includedFrom?: string;
}

export type FrameXmlAddonDiagnosticScope =
  | "toc"
  | "resource"
  | "xml"
  | "template"
  | "addon"
  | "script";

export interface FrameXmlAddonDiagnostic {
  readonly addon: string;
  readonly file?: string;
  readonly scope: FrameXmlAddonDiagnosticScope;
  /** Includes the addon/file context so plain-text logs remain actionable. */
  readonly message: string;
}

export interface FrameXmlAddonBundleLoadResult {
  readonly ok: boolean;
  readonly addon: string;
  readonly metadata: Readonly<Record<string, string>>;
  /** Entries directly listed by the TOC, in source order. */
  readonly tocEntries: readonly FrameXmlAddonTocEntry[];
  /** XML and Lua resources after Include/Script expansion, in load order. */
  readonly entries: readonly FrameXmlAddonEntry[];
  readonly xmlFiles: readonly string[];
  /** Lua is intentionally inert and is never passed to an evaluator. */
  readonly luaChunks: readonly FrameXmlAddonLuaChunk[];
  /** One bridge/registry is created for this addon and no other addon. */
  readonly bridge: FrameXmlUiBridge;
  readonly uiBridge: FrameXmlUiBridge;
  readonly roots: readonly FrameXmlFrame[];
  readonly diagnostics: readonly FrameXmlAddonDiagnostic[];
  readonly nativeHudUnaffected: true;
}

export interface FrameXmlNormalizedPath {
  readonly path: string;
  readonly error?: never;
}

export interface FrameXmlInvalidPath {
  readonly error: string;
  readonly path?: never;
}

export type FrameXmlAddonPathResult = FrameXmlNormalizedPath | FrameXmlInvalidPath;

const DEFAULT_LIMITS: FrameXmlAddonLimits = Object.freeze({
  maxFiles: 1024,
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 32,
  maxEntries: 4096,
});

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function effectiveLimits(options: FrameXmlAddonLoaderOptions): FrameXmlAddonLimits {
  return Object.freeze({
    maxFiles: positiveLimit(options.limits?.maxFiles, DEFAULT_LIMITS.maxFiles),
    maxBytes: positiveLimit(options.limits?.maxBytes, DEFAULT_LIMITS.maxBytes),
    maxDepth: positiveLimit(options.limits?.maxDepth, DEFAULT_LIMITS.maxDepth),
    maxEntries: positiveLimit(options.limits?.maxEntries, DEFAULT_LIMITS.maxEntries),
  });
}

/** Count UTF-8 bytes without depending on a platform-specific encoder. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) {
      bytes += 1;
    } else if (unit <= 0x7ff) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff
      && index + 1 < value.length
      && (value.charCodeAt(index + 1) ?? 0) >= 0xdc00
      && (value.charCodeAt(index + 1) ?? 0) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else {
      // This matches UTF-8 replacement encoding for an unpaired surrogate.
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Normalize a FrameXML resource name to a case-insensitive slash path.
 * Deliberately rejects traversal instead of resolving it, so the result can
 * never escape the addon's virtual root.
 */
export function normalizeFrameXmlAddonPath(value: string): FrameXmlAddonPathResult {
  if (typeof value !== "string") return { error: "path is not a string" };
  const raw = value.trim();
  if (!raw) return { error: "path is empty" };
  if (raw.includes("\0")) return { error: "path contains a NUL character" };

  const slashPath = raw.replaceAll("\\", "/");
  if (slashPath.startsWith("/") || slashPath.startsWith("//")) {
    return { error: "absolute and network-relative paths are not allowed" };
  }
  if (/^[A-Za-z]:($|\/)/.test(slashPath)) {
    return { error: "drive-qualified paths are not allowed" };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(slashPath)) {
    return { error: "URL and scheme-qualified paths are not allowed" };
  }

  // Check percent-decoded spelling too. A resource named %2e%2e/file must not
  // become traversal if a future host happens to decode names before lookup.
  let decoded = slashPath;
  try {
    decoded = decodeURIComponent(slashPath);
  } catch {
    return { error: "path contains malformed percent-encoding" };
  }
  if (decoded.includes("\0")) return { error: "path contains an encoded NUL character" };
  if (decoded !== slashPath && (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)
    || decoded.startsWith("/") || decoded.startsWith("//"))) {
    return { error: "encoded absolute or URL paths are not allowed" };
  }

  const segments = slashPath.split("/");
  const decodedSegments = decoded.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "..")
    || decodedSegments.some((segment) => segment === "..")) {
    return { error: "path traversal is not allowed" };
  }
  const normalized = segments.filter((segment) => segment !== "." && segment !== "").join("/").toLowerCase();
  if (!normalized) return { error: "path is empty after normalization" };
  return { path: normalized };
}

function extensionOf(path: string): "xml" | "lua" | undefined {
  if (path.endsWith(".xml")) return "xml";
  if (path.endsWith(".lua")) return "lua";
  return undefined;
}

function asRecord(files: FrameXmlAddonFiles | undefined): Iterable<readonly [string, string]> {
  if (!files) return [];
  if (typeof (files as ReadonlyMap<string, string>).entries === "function") {
    return (files as ReadonlyMap<string, string>).entries();
  }
  const record = files as Readonly<Record<string, string>>;
  return Object.keys(record).map((key) => [key, record[key]!] as const);
}

/** Parse only the declarative TOC surface; comments and unknown file types are ignored. */
export function parseFrameXmlAddonToc(source: string): FrameXmlAddonTocParseResult {
  if (typeof source !== "string") {
    return { ok: false, metadata: {}, entries: [], diagnostics: ["TOC source must be a string"] };
  }
  const metadata: Record<string, string> = {};
  const entries: FrameXmlAddonTocEntry[] = [];
  const diagnostics: string[] = [];
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber]?.trim() ?? "";
    if (!line || line.startsWith("#")) {
      if (line.startsWith("##") && !line.startsWith("###")) {
        const separator = line.indexOf(":", 2);
        if (separator < 0) {
          diagnostics.push(`TOC line ${lineNumber + 1} metadata has no colon`);
          continue;
        }
        const key = line.slice(2, separator).trim();
        if (!key) {
          diagnostics.push(`TOC line ${lineNumber + 1} metadata key is empty`);
          continue;
        }
        metadata[key] = line.slice(separator + 1).trim();
      }
      continue;
    }
    const normalized = normalizeFrameXmlAddonPath(line);
    if ("error" in normalized) {
      diagnostics.push(`TOC line ${lineNumber + 1}: ${normalized.error}`);
      continue;
    }
    const kind = extensionOf(normalized.path);
    if (!kind) continue;
    entries.push({ path: normalized.path, kind });
  }
  return {
    ok: diagnostics.length === 0,
    metadata: Object.freeze({ ...metadata }),
    entries: Object.freeze(entries),
    diagnostics: Object.freeze([...diagnostics]),
  };
}

/** Short alias useful to hosts that already call their manifest a TOC. */
export const parseFrameXmlToc = parseFrameXmlAddonToc;

interface Resource {
  readonly path: string;
  readonly source: string;
}

function isParserDiagnostic(value: FrameXmlDiagnostic): value is FrameXmlDiagnostic {
  return value !== undefined;
}

/**
 * Static, capability-safe addon bundle loader. It owns one in-memory bridge
 * per load, resolves XML includes, and retains Lua source without evaluating it.
 */
export class FrameXmlAddonLoader {
  readonly #limits: FrameXmlAddonLimits;

  constructor(options: FrameXmlAddonLoaderOptions = {}) {
    this.#limits = effectiveLimits(options);
  }

  load(bundle: FrameXmlAddonBundle): FrameXmlAddonBundleLoadResult {
    return this.loadAddon(bundle);
  }

  loadAddon(bundle: FrameXmlAddonBundle): FrameXmlAddonBundleLoadResult {
    const addon = (bundle.name ?? bundle.addonName ?? "unnamed-addon").trim() || "unnamed-addon";
    const tocSource = bundle.toc ?? bundle.tocSource;
    const diagnostics: FrameXmlAddonDiagnostic[] = [];
    const metadata: Readonly<Record<string, string>> = {};
    const tocEntries: FrameXmlAddonTocEntry[] = [];
    const entries: FrameXmlAddonEntry[] = [];
    const xmlFiles: string[] = [];
    const luaChunks: FrameXmlAddonLuaChunk[] = [];
    const roots: FrameXmlFrame[] = [];
    const bridge = new FrameXmlUiBridge();
    const resources = new Map<string, Resource>();
    const byteAccounted = new Set<string>();
    const activeIncludes: string[] = [];
    let bytes = 0;
    let operationCount = 0;

    const report = (
      scope: FrameXmlAddonDiagnosticScope,
      message: string,
      file?: string,
    ): void => {
      const context = file ? `${addon}/${file}` : addon;
      diagnostics.push({
        addon,
        ...(file === undefined ? {} : { file }),
        scope,
        message: `[${context}] ${message}`,
      });
    };

    const account = (resource: Resource): boolean => {
      if (byteAccounted.has(resource.path)) return true;
      const next = bytes + utf8ByteLength(resource.source);
      if (next > this.#limits.maxBytes) {
        report("resource", `referenced source exceeds ${this.#limits.maxBytes} byte budget`, resource.path);
        return false;
      }
      bytes = next;
      byteAccounted.add(resource.path);
      return true;
    };

    for (const [rawPath, source] of asRecord(bundle.files ?? bundle.resources)) {
      const normalized = normalizeFrameXmlAddonPath(rawPath);
      if ("error" in normalized) {
        report("resource", `resource path "${rawPath}" rejected: ${normalized.error}`);
        continue;
      }
      if (typeof source !== "string") {
        report("resource", "resource source must be a string", normalized.path);
        continue;
      }
      if (resources.size >= this.#limits.maxFiles) {
        report("resource", `resource count exceeds ${this.#limits.maxFiles} file limit`, normalized.path);
        continue;
      }
      if (resources.has(normalized.path)) {
        report("resource", `duplicate case/slash-normalized resource path from "${rawPath}"`, normalized.path);
        continue;
      }
      resources.set(normalized.path, { path: normalized.path, source });
    }

    if (tocSource === undefined) {
      report("toc", "addon has no TOC source");
    } else if (!account({ path: "<toc>", source: tocSource })) {
      report("toc", "TOC was not loaded because the byte budget was exceeded");
    } else {
      const parsedToc = parseFrameXmlAddonToc(tocSource);
      Object.assign(metadata, parsedToc.metadata);
      tocEntries.push(...parsedToc.entries);
      for (const message of parsedToc.diagnostics) report("toc", message);
    }

    const sourceFor = (path: string, from: string | undefined): Resource | undefined => {
      const resource = resources.get(path);
      if (!resource) {
        report("resource", `referenced file "${path}" is missing`, from ?? path);
        return undefined;
      }
      if (!account(resource)) return undefined;
      return resource;
    };

    const countOperation = (path: string): boolean => {
      operationCount += 1;
      if (operationCount <= this.#limits.maxEntries) return true;
      report("addon", `expanded file count exceeds ${this.#limits.maxEntries} entry limit`, path);
      return false;
    };

    const retainLua = (
      path: string,
      origin: "toc" | "script",
      includedFrom: string | undefined,
    ): void => {
      if (!countOperation(path)) return;
      const resource = sourceFor(path, includedFrom);
      if (!resource) return;
      const chunk: FrameXmlAddonLuaChunk = {
        path,
        source: resource.source,
        origin,
        ...(includedFrom === undefined ? {} : { includedFrom }),
      };
      luaChunks.push(chunk);
      entries.push({ ...chunk, kind: "lua" });
    };

    const resolveReference = (
      rawPath: string | undefined,
      kind: "xml" | "lua",
      from: string,
    ): string | undefined => {
      if (rawPath === undefined || !rawPath.trim()) {
        report(kind === "xml" ? "xml" : "script", `${kind === "xml" ? "Include" : "Script"} file attribute is empty`, from);
        return undefined;
      }
      const normalized = normalizeFrameXmlAddonPath(rawPath);
      if ("error" in normalized) {
        report(kind === "xml" ? "xml" : "script", `referenced path "${rawPath}" rejected: ${normalized.error}`, from);
        return undefined;
      }
      if (extensionOf(normalized.path) !== kind) {
        report(kind === "xml" ? "xml" : "script", `referenced path must be a .${kind} file`, from);
        return undefined;
      }
      const separator = from.lastIndexOf("/");
      const directory = separator < 0 ? "" : from.slice(0, separator + 1);
      const relative = normalizeFrameXmlAddonPath(`${directory}${normalized.path}`);
      if ("error" in relative) {
        report(kind === "xml" ? "xml" : "script", `referenced path "${rawPath}" is outside the addon root: ${relative.error}`, from);
        return undefined;
      }
      return relative.path;
    };

    const processXml = (path: string, origin: "toc" | "include", includedFrom?: string, depth = 0): void => {
      if (activeIncludes.includes(path)) {
        report("xml", `Include cycle detected: ${[...activeIncludes, path].join(" -> ")}`, includedFrom ?? path);
        return;
      }
      if (depth > this.#limits.maxDepth) {
        report("xml", `Include depth exceeds ${this.#limits.maxDepth} level limit`, path);
        return;
      }
      if (!countOperation(path)) return;
      const resource = sourceFor(path, includedFrom);
      if (!resource) return;
      const parsed = parseFrameXml(resource.source);
      if (!parsed.root || !parsed.ok) {
        for (const message of parsed.diagnostics) report("xml", message, path);
        return;
      }
      if (parsed.root.name !== "Ui" && !FRAME_XML_WIDGET_TYPES.has(parsed.root.name)) {
        report("addon", `FrameXML root <${parsed.root.name}> is not <Ui> or a supported widget`, path);
        return;
      }

      activeIncludes.push(path);
      const visit = (element: FrameXmlElement): void => {
        const name = element.name.toLowerCase();
        if (/^(?:1|true|yes)$/i.test(element.attributes["virtual"]?.trim() ?? "")
          && element.attributes["name"]?.trim()) {
          // Register declarations at their source position. This makes a
          // template declared before an Include visible to the included file,
          // while preserving the TOC/include order for later declarations.
          bridge.registry.registerTemplate(element.attributes["name"]!, element, path);
        }
        if (name === "include") {
          const target = resolveReference(element.attributes["file"], "xml", path);
          if (target) processXml(target, "include", path, depth + 1);
          return;
        }
        if (name === "script" && element.attributes["file"] !== undefined) {
          const target = resolveReference(element.attributes["file"], "lua", path);
          if (target) retainLua(target, "script", path);
          return;
        }
        for (const child of element.children) visit(child);
      };
      visit(parsed.root);
      activeIncludes.pop();

      // `visit` already registered virtual declarations in the exact expanded
      // TOC/Include order. Registering the whole parent document again here
      // would move declarations from before an Include after that Include.
      const loaded = bridge.loadAddon(resource.source, { registerTemplates: false });
      for (const diagnostic of loaded.diagnostics) {
        if (!isParserDiagnostic(diagnostic)) continue;
        report(diagnostic.scope, diagnostic.message, path);
      }
      roots.push(...loaded.roots);
      const entry: FrameXmlAddonEntry = {
        path,
        kind: "xml",
        source: resource.source,
        origin,
        ...(includedFrom === undefined ? {} : { includedFrom }),
      };
      entries.push(entry);
      xmlFiles.push(path);
    };

    for (const tocEntry of tocEntries) {
      if (tocEntry.kind === "xml") processXml(tocEntry.path, "toc");
      else retainLua(tocEntry.path, "toc", undefined);
    }

    const resultDiagnostics = Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })));
    const resultMetadata = Object.freeze({ ...metadata });
    const resultTocEntries = Object.freeze(tocEntries.map((entry) => Object.freeze({ ...entry })));
    const resultEntries = Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
    const resultLua = Object.freeze(luaChunks.map((chunk) => Object.freeze({ ...chunk })));
    const resultRoots = Object.freeze([...roots]);
    return {
      ok: resultDiagnostics.length === 0,
      addon,
      metadata: resultMetadata,
      tocEntries: resultTocEntries,
      entries: resultEntries,
      xmlFiles: Object.freeze([...xmlFiles]),
      luaChunks: resultLua,
      bridge,
      uiBridge: bridge,
      roots: resultRoots,
      diagnostics: resultDiagnostics,
      nativeHudUnaffected: true,
    };
  }
}

export function loadFrameXmlAddon(
  bundle: FrameXmlAddonBundle,
  options: FrameXmlAddonLoaderOptions = {},
): FrameXmlAddonBundleLoadResult {
  return new FrameXmlAddonLoader(options).loadAddon(bundle);
}
