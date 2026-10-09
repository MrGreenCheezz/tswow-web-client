// 10.11 (L10): which TypeScript the gateway is compiled from, and whether dist/code is older than
// it — without loading the compiler.
//
// tsconfig.gateway.json names the roots (src/gateway, the client-data implementations); tsc then
// follows every relative import, type-only ones included, and compiles those files too. The walk
// below follows the same specifiers, so `node tools/build-gateway.mjs --check` and the Electron
// shell (electron/gateway.cjs) judge freshness by exactly the files a gateway build would write
// (tests/gateway-build.test.mjs compares the walk with `tsc --listFilesOnly`). The whole-tree
// tools/gateway-build-stale.mjs also counts page sources, so an edit to a browser file made the
// gateway look stale.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** `import … from "x"` and `export … from "x"`, with or without `type`. */
const FROM_STATEMENT = /(?:^|[;}\n])[ \t]*(import|export)(\s+type)?\s+([\w$\s{},*]*?)\s*from\s*["']([^"']+)["']/g;
/** `import "x";` — a module loaded for its side effects. */
const SIDE_EFFECT = /(?:^|[;}\n])[ \t]*import\s*["']([^"']+)["']/g;
/** `import("x")` with a literal specifier. */
const DYNAMIC = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Whether the braces of an import or re-export name types only (`{ type A, type B }`): TypeScript drops it. */
function typeOnlyBraces(body) {
  const trimmed = body.trim();
  if (!/^\{[^}]*\}$/.test(trimmed)) return false;
  const names = trimmed.slice(1, -1).split(",").map((name) => name.trim()).filter(Boolean);
  return names.length > 0 && names.every((name) => /^type\s/.test(name));
}

/**
 * The module specifiers of one source, in source order: `{ specifier, typeOnly }`. `typeOnly` is
 * an import or re-export that TypeScript erases (`import type`, `export type`, braces of `type`
 * names only); the file it names is still compiled, but nothing loads it at run time.
 */
export function importSpecifiers(text) {
  const found = [];
  for (const match of text.matchAll(FROM_STATEMENT)) {
    found.push({ at: match.index, specifier: match[4], typeOnly: Boolean(match[2]) || typeOnlyBraces(match[3]) });
  }
  for (const match of text.matchAll(SIDE_EFFECT)) found.push({ at: match.index, specifier: match[1], typeOnly: false });
  for (const match of text.matchAll(DYNAMIC)) found.push({ at: match.index, specifier: match[1], typeOnly: false });
  return found.sort((a, b) => a.at - b.at).map(({ specifier, typeOnly }) => ({ specifier, typeOnly }));
}

/** The .ts file a relative specifier names (`./X.js` → `X.ts`), or undefined (a package, a missing file). */
function resolveSource(fromFile, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const target = resolve(dirname(fromFile), specifier);
  const base = /\.m?js$/.exec(target);
  const candidates = base
    ? (base[0] === ".mjs" ? [`${target.slice(0, -4)}.mts`] : [`${target.slice(0, -3)}.ts`, `${target.slice(0, -3)}.d.ts`])
    : target.endsWith(".ts") ? [target] : [];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function* typescriptFiles(directory, recursive) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (recursive) yield* typescriptFiles(path, true);
    } else if (entry.name.endsWith(".ts")) {
      yield path;
    }
  }
}

/** The files one `include` pattern of the gateway tsconfig matches; only the two shapes it uses. */
function expandInclude(root, pattern) {
  const recursive = /^(.+)\/\*\*\/\*\.ts$/.exec(pattern);
  if (recursive) return [...typescriptFiles(resolve(root, recursive[1]), true)];
  const flat = /^(.+)\/\*\.ts$/.exec(pattern);
  if (flat) return [...typescriptFiles(resolve(root, flat[1]), false)];
  throw new Error(`tsconfig.gateway.json: include pattern "${pattern}" is not one the freshness walk understands (dir/**/*.ts or dir/*.ts)`);
}

/**
 * L10-review: a tsconfig as tsc reads it — JSON with `//` and `/* *\/` comments and trailing commas.
 * Plain JSON.parse threw on the first comment someone added, after tsc had compiled the file happily.
 */
export function parseTsconfigText(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      if (c === "}" || c === "]") out = out.replace(/,\s*$/, "");
      out += c;
    }
  }
  return JSON.parse(out);
}

/** The sources the gateway tsconfig names itself (its `include`), before any import is followed. */
export function gatewayRoots(root) {
  const config = parseTsconfigText(readFileSync(join(root, "tsconfig.gateway.json"), "utf8")); // L10-review
  if (!Array.isArray(config.include)) throw new Error("tsconfig.gateway.json has no include list");
  return config.include.flatMap((pattern) => expandInclude(root, pattern));
}

/** Walks from the gateway roots; `follow(entry)` picks which imports to follow. Sorted absolute paths. */
function walk(root, follow) {
  const seen = new Set();
  const edges = [];
  const queue = gatewayRoots(root);
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const entry of importSpecifiers(readFileSync(file, "utf8"))) {
      if (!follow(entry)) continue;
      const target = resolveSource(file, entry.specifier);
      if (target === undefined) continue;
      edges.push({ from: file, specifier: entry.specifier, target });
      if (!seen.has(target)) queue.push(target);
    }
  }
  return { files: [...seen].sort(), edges };
}

/** Every source a gateway build compiles (type-only imports included), sorted absolute paths. */
export function gatewaySources(root) {
  return walk(root, () => true).files;
}

/**
 * Imports of page code (`src/browser`) the running gateway would load: value imports reached from
 * the gateway roots through value imports only. A type import compiles the file but loads nothing.
 */
export function runtimeBrowserImports(root) {
  const browser = resolve(root, "src", "browser");
  const posix = (path) => relative(root, path).replaceAll("\\", "/");
  return walk(root, (entry) => !entry.typeOnly).edges
    .filter((edge) => !relative(browser, edge.target).startsWith(".."))
    .map((edge) => ({ from: posix(edge.from), specifier: edge.specifier }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.specifier.localeCompare(b.specifier));
}

function modifiedAt(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * The first reason dist/code is older than the gateway's sources, or undefined when it is current:
 * `{ source, reason: "never compiled" | "changed" }`, `source` relative to `root`. The two tsconfig
 * files count against the compiled gateway/main.js, since a changed option changes every output.
 */
export function staleGatewaySource(root, { outDir = join(root, "dist", "code") } = {}) {
  const sourceRoot = resolve(root, "src");
  const posix = (path) => relative(root, path).replaceAll("\\", "/");
  for (const source of gatewaySources(root)) {
    if (source.endsWith(".d.ts")) continue;
    const compiled = join(outDir, relative(sourceRoot, source)).replace(/\.m?ts$/, (ext) => (ext === ".mts" ? ".mjs" : ".js"));
    const compiledAt = modifiedAt(compiled);
    if (compiledAt === undefined) return { source: posix(source), reason: "never compiled" };
    if ((modifiedAt(source) ?? 0) > compiledAt) return { source: posix(source), reason: "changed" };
  }
  const entryAt = modifiedAt(join(outDir, "gateway", "main.js"));
  for (const config of ["tsconfig.json", "tsconfig.gateway.json"]) {
    const at = modifiedAt(join(root, config));
    if (at !== undefined && entryAt !== undefined && at > entryAt) return { source: config, reason: "changed" };
  }
  return undefined;
}

/**
 * Walks compiled JavaScript from `entries` (paths relative to `outDir`) through its relative
 * imports. `reached` lists the files loaded, `missing` the imports that name no file — a module
 * the gateway would fail to load. Both relative to `outDir`, sorted.
 */
export function missingRuntimeImports(outDir, entries) {
  const posix = (path) => relative(outDir, path).replaceAll("\\", "/");
  const seen = new Set();
  const missing = [];
  const queue = [];
  for (const entry of entries) {
    const file = resolve(outDir, entry);
    if (existsSync(file)) queue.push(file);
    else missing.push({ from: "(entry)", specifier: entry });
  }
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    seen.add(file);
    for (const { specifier } of importSpecifiers(text)) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      const target = resolve(dirname(file), specifier);
      if (existsSync(target)) {
        if (!seen.has(target)) queue.push(target);
      } else {
        missing.push({ from: posix(file), specifier });
      }
    }
  }
  return {
    reached: [...seen].map(posix).sort(),
    missing: missing.sort((a, b) => a.from.localeCompare(b.from) || a.specifier.localeCompare(b.specifier)),
  };
}
