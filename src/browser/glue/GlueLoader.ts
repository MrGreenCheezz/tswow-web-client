import { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import { frameXmlAttribute, parseFrameXml } from "../ui/framexml_compat/FrameXmlParser.js";
import {
  FRAME_XML_FONT_ELEMENT,
  FRAME_XML_WIDGET_TYPES,
  type FrameXmlElement,
  type FrameXmlFrame,
} from "../ui/framexml_compat/FrameXmlTypes.js";
import type { GlueLuaVm } from "./GlueLua.js";

/**
 * Where the interface files come from.
 *
 * `undefined` means "this file does not exist", which is a normal outcome: the
 * real client skips a TOC entry it cannot find, and this corpus has four such
 * entries (`OptionsFrame.xml`, `RaceSelect.xml` and `SoundOptionsFrame.xml` are
 * zero bytes, and `..\SharedXML\SharedGlueStrings.lua` is absent from the
 * locale chain entirely). A provider must therefore distinguish "missing" from
 * "failed", and only the latter is an error.
 */
export interface GlueFileProvider {
  read(path: string): Promise<string | undefined>;
}

/** Reads from an in-memory map. Paths are matched case-insensitively. */
export function createFixtureProvider(
  files: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): GlueFileProvider {
  const map = new Map<string, string>();
  const entries = files instanceof Map
    ? files.entries()
    : Object.entries(files as Readonly<Record<string, string>>);
  for (const [path, source] of entries) map.set(normalizeGluePath(path), source);
  return {
    async read(path: string): Promise<string | undefined> {
      return map.get(normalizeGluePath(path));
    },
  };
}

export interface GlueHttpProviderOptions {
  /** Gateway origin, e.g. `http://127.0.0.1:8090`. */
  readonly gatewayOrigin: string;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Reads through the gateway's raw-interface route.
 *
 * Contract, from the route's own definition: `GET {origin}/client/file?path=`
 * answers `text/plain; charset=utf-8` for `.lua/.xml/.toc`, `404` when the MPQ
 * patch chain has no such file, and `5xx` when the chain itself failed. Only
 * the 404 is a skip; anything else is surfaced, because silently treating a
 * broken gateway as "file missing" would produce a login screen with half its
 * frames and no explanation.
 */
export function createHttpFileProvider(options: GlueHttpProviderOptions): GlueFileProvider {
  const origin = options.gatewayOrigin.replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    async read(path: string): Promise<string | undefined> {
      const url = new URL("/client/file", origin);
      url.searchParams.set("path", path.replaceAll("/", "\\"));
      const response = await doFetch(url.href, { headers: { accept: "text/plain" } });
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new Error(`${url.pathname}?path=${path} returned ${response.status}`);
      }
      return response.text();
    },
  };
}

/** Lowercase, forward-slash spelling used as the provider's lookup key. */
export function normalizeGluePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
}

/**
 * Resolve a reference relative to the file that made it.
 *
 * GlueXML.toc's second entry is `..\SharedXML\SharedGlueStrings.lua`, so `..`
 * has to work — but only down to `interface/`. Anything that would climb out of
 * the interface tree is refused rather than clamped, so a malformed reference
 * inside a patch archive cannot be turned into a request for an unrelated path.
 */
export function resolveGluePath(baseDirectory: string, reference: string): string | undefined {
  const base = normalizeGluePath(baseDirectory).split("/").filter(Boolean);
  const parts = normalizeGluePath(reference).split("/").filter(Boolean);
  const stack = [...base];
  for (const part of parts) {
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

export interface GlueTocEntry {
  readonly path: string;
  readonly kind: "xml" | "lua";
}

/**
 * Parse the interface TOC.
 *
 * `##` is the real file's "commented out" marker, not metadata: this corpus
 * uses it for `##DebugHook.lua`, `##CameraSelect.xml` and a prose note. Both
 * spellings are skipped, and everything else in order.
 */
export function parseGlueToc(source: string, directory: string): readonly GlueTocEntry[] {
  const entries: GlueTocEntry[] = [];
  for (const raw of source.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const resolved = resolveGluePath(directory, line);
    if (!resolved) continue;
    if (resolved.endsWith(".xml")) entries.push({ path: resolved, kind: "xml" });
    else if (resolved.endsWith(".lua")) entries.push({ path: resolved, kind: "lua" });
  }
  return entries;
}

export interface GlueLoadDiagnostic {
  readonly file: string;
  readonly scope: "toc" | "lua" | "xml" | "provider";
  readonly message: string;
}

export interface GlueLoadResult {
  readonly tocEntries: readonly GlueTocEntry[];
  /** Files actually read, in load order, including Include/Script expansion. */
  readonly loaded: readonly string[];
  /** TOC or Include entries the provider had no file for. */
  readonly missing: readonly string[];
  readonly roots: readonly FrameXmlFrame[];
  readonly templates: readonly string[];
  readonly diagnostics: readonly GlueLoadDiagnostic[];
}

export interface GlueLoaderOptions {
  readonly vm: GlueLuaVm;
  readonly bridge: FrameXmlUiBridge;
  readonly provider: GlueFileProvider;
  /** Runs after a Lua file has executed, before the next TOC/XML declaration starts. */
  readonly afterLuaFile?: (path: string) => void;
  /** Reports one TOC entry, including its nested XML Includes/Scripts, after execution. */
  readonly afterTocEntry?: (entry: GlueTocEntry, result: {
    readonly loaded: readonly string[];
    readonly missing: readonly string[];
    readonly diagnostics: readonly GlueLoadDiagnostic[];
  }) => void;
  /** Native add-on chunk varargs: add-on name and its stable private namespace table. */
  readonly luaArguments?: readonly unknown[];
  /** Guards against a cyclic Include chain and a pathological archive. */
  readonly maxFiles?: number;
  readonly maxDepth?: number;
}

const DEFAULT_MAX_FILES = 512;
const DEFAULT_MAX_DEPTH = 16;

/**
 * Walk a GlueXML TOC and bring the screens up.
 *
 * Order is the whole point. The corpus depends on it in three ways at once:
 * `GlueStrings.lua` must run before any XML so that `text="MANAGE_ACCOUNT"`
 * resolves; `GlueFonts.xml` before `GlueFontStyles.xml` so the font objects
 * have something to inherit from; and `GlueParent.xml` before every screen,
 * because each screen declares `parent="GlueParent"` by name.
 */
export class GlueLoader {
  readonly #vm: GlueLuaVm;
  readonly #bridge: FrameXmlUiBridge;
  readonly #provider: GlueFileProvider;
  readonly #afterLuaFile: ((path: string) => void) | undefined;
  readonly #afterTocEntry: GlueLoaderOptions["afterTocEntry"];
  readonly #luaArguments: readonly unknown[];
  readonly #maxFiles: number;
  readonly #maxDepth: number;
  readonly #loaded: string[] = [];
  readonly #missing: string[] = [];
  readonly #roots: FrameXmlFrame[] = [];
  readonly #diagnostics: GlueLoadDiagnostic[] = [];
  readonly #seenXml = new Set<string>();

  constructor(options: GlueLoaderOptions) {
    this.#vm = options.vm;
    this.#bridge = options.bridge;
    this.#provider = options.provider;
    this.#afterLuaFile = options.afterLuaFile;
    this.#afterTocEntry = options.afterTocEntry;
    this.#luaArguments = options.luaArguments ?? [];
    this.#maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.#maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  async load(tocPath = "interface/gluexml/gluexml.toc"): Promise<GlueLoadResult> {
    const path = normalizeGluePath(tocPath);
    const directory = path.slice(0, path.lastIndexOf("/") + 1);
    const source = await this.readFile(path, "toc");
    if (source === undefined) {
      return {
        tocEntries: [], loaded: [], missing: [...this.#missing], roots: [], templates: [],
        diagnostics: [...this.#diagnostics],
      };
    }
    const entries = parseGlueToc(source, directory);
    for (const entry of entries) {
      const loaded = this.#loaded.length;
      const missing = this.#missing.length;
      const diagnostics = this.#diagnostics.length;
      if (entry.kind === "lua") await this.loadLua(entry.path);
      else await this.loadXml(entry.path, 0);
      this.#afterTocEntry?.(entry, {
        loaded: this.#loaded.slice(loaded),
        missing: this.#missing.slice(missing),
        diagnostics: this.#diagnostics.slice(diagnostics),
      });
    }
    // Font objects flatten their inherits chain against the finished registry,
    // so this runs once the whole TOC has declared them.
    this.#bridge.registerFontObjects();
    return {
      tocEntries: entries,
      loaded: [...this.#loaded],
      missing: [...this.#missing],
      roots: [...this.#roots],
      templates: this.#bridge.registry.names,
      diagnostics: [...this.#diagnostics],
    };
  }

  private async readFile(path: string, scope: GlueLoadDiagnostic["scope"]): Promise<string | undefined> {
    if (this.#loaded.length >= this.#maxFiles) {
      this.#diagnostics.push({ file: path, scope, message: `file budget of ${this.#maxFiles} exhausted` });
      return undefined;
    }
    let source: string | undefined;
    try {
      source = await this.#provider.read(path);
    } catch (error) {
      this.#diagnostics.push({ file: path, scope: "provider", message: String(error) });
      return undefined;
    }
    if (source === undefined || source === "") {
      // A zero-byte file is how this corpus retires a screen (OptionsFrame.xml,
      // RaceSelect.xml and SoundOptionsFrame.xml are all 0 bytes); treat it the
      // same as absent rather than as a parse failure.
      this.#missing.push(path);
      return undefined;
    }
    this.#loaded.push(path);
    return source;
  }

  private async loadLua(path: string): Promise<void> {
    const source = await this.readFile(path, "lua");
    if (source === undefined) return;
    const before = this.#vm.errors.length;
    this.#vm.executeReported(source, `@${path}`, this.#luaArguments);
    for (const message of this.#vm.errors.slice(before)) {
      this.#diagnostics.push({ file: path, scope: "lua", message });
    }
    this.#afterLuaFile?.(path);
  }

  private async loadXml(path: string, depth: number): Promise<void> {
    if (depth > this.#maxDepth) {
      this.#diagnostics.push({ file: path, scope: "xml", message: `Include depth exceeds ${this.#maxDepth}` });
      return;
    }
    if (this.#seenXml.has(path)) return;
    this.#seenXml.add(path);
    const source = await this.readFile(path, "xml");
    if (source === undefined) return;
    const parsed = parseFrameXml(source);
    if (!parsed.root) {
      for (const message of parsed.diagnostics) {
        this.#diagnostics.push({ file: path, scope: "xml", message });
      }
      return;
    }
    for (const message of parsed.diagnostics) {
      this.#diagnostics.push({ file: path, scope: "xml", message });
    }
    const directory = path.slice(0, path.lastIndexOf("/") + 1);
    const children = parsed.root.name === "Ui" ? parsed.root.children : [parsed.root];
    for (const child of children) await this.applyDeclaration(child, path, directory, depth);
  }

  private async applyDeclaration(
    element: FrameXmlElement,
    path: string,
    directory: string,
    depth: number,
  ): Promise<void> {
    if (element.name === "Script") {
      const file = frameXmlAttribute(element, "file");
      if (file) {
        const resolved = resolveGluePath(directory, file);
        if (resolved) await this.loadLua(resolved);
        else this.#diagnostics.push({ file: path, scope: "xml", message: `Script file "${file}" escapes the interface tree` });
        return;
      }
      const body = element.text.trim();
      if (body) {
        const before = this.#vm.errors.length;
        this.#vm.executeReported(body, `@${path}:Script`);
        for (const message of this.#vm.errors.slice(before)) {
          this.#diagnostics.push({ file: path, scope: "lua", message });
        }
      }
      return;
    }
    if (element.name === "Include") {
      const file = frameXmlAttribute(element, "file");
      const resolved = file ? resolveGluePath(directory, file) : undefined;
      if (resolved) await this.loadXml(resolved, depth + 1);
      else this.#diagnostics.push({ file: path, scope: "xml", message: `Include file "${file ?? ""}" is unusable` });
      return;
    }
    const virtual = /^(?:1|true|yes)$/i.test(frameXmlAttribute(element, "virtual")?.trim() ?? "");
    if (element.name === FRAME_XML_FONT_ELEMENT || virtual) {
      this.#bridge.registerTemplateElement(element, path);
      return;
    }
    if (!FRAME_XML_WIDGET_TYPES.has(element.name)) return;
    const frame = this.#bridge.instantiate(element);
    if (frame && !frame.parent) this.#roots.push(frame);
  }
}
