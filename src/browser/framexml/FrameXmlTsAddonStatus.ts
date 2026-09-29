import { parseGlueToc, type GlueLoaderOptions } from "../glue/GlueLoader.js";
import { frameXmlTsAddonBlocks } from "./FrameXmlCorpus.js";

/** Successful execution is separate from the behavioral scenarios run by tswow-addons:check. */
export interface FrameXmlTsAddonStatus {
  readonly module: string;
  readonly ok: boolean;
  readonly loaded: readonly string[];
  readonly errors: readonly string[];
}

interface TrackedBlock {
  readonly name: string;
  readonly entries: ReadonlySet<string>;
  readonly pending: Set<string>;
  readonly loaded: Set<string>;
  readonly errors: string[];
}

/** Tracks real TOC execution, including shared TSWoW libraries and nested XML failures. */
export class FrameXmlTsAddonTracker {
  readonly #blocks: TrackedBlock[];

  constructor(toc: string, directory: string) {
    this.#blocks = frameXmlTsAddonBlocks(toc).map((block) => {
      const entries = new Set(parseGlueToc(block.lines.join("\n"), directory).map((entry) => entry.path));
      return { name: block.name, entries, pending: new Set(entries), loaded: new Set<string>(), errors: [] };
    });
  }

  record(
    entry: Parameters<NonNullable<GlueLoaderOptions["afterTocEntry"]>>[0],
    result: Parameters<NonNullable<GlueLoaderOptions["afterTocEntry"]>>[1],
    luaErrors: readonly string[],
  ): void {
    for (const block of this.#blocks) {
      if (!block.entries.has(entry.path)) continue;
      block.pending.delete(entry.path);
      for (const path of result.loaded) block.loaded.add(path);
      block.errors.push(
        ...result.missing.map((path) => `Missing ${path}`),
        ...result.diagnostics.map((diagnostic) => `${diagnostic.file}: ${diagnostic.message}`),
        ...luaErrors,
      );
    }
  }

  get results(): readonly FrameXmlTsAddonStatus[] {
    const errorsFor = (block: TrackedBlock): string[] => [
      ...block.errors,
      ...[...block.pending].map((path) => `Not executed: ${path}`),
    ];
    const libraryErrors = this.#blocks.filter((block) => block.name === "__lib__")
      .flatMap(errorsFor).map((error) => `TSWoW library: ${error}`);
    return this.#blocks.filter((block) => block.name !== "__lib__").map((block) => {
      const errors = [...new Set([...libraryErrors, ...errorsFor(block)])];
      return { module: block.name, ok: errors.length === 0, loaded: [...block.loaded], errors };
    });
  }
}
