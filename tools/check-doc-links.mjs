// 13.02: every relative link in the project's Markdown documents points at something that exists.
//
//   node tools/check-doc-links.mjs [--anchors] [--json <out.json>] [--root <dir>]
//
// Scans docs/**/*.md, README.md, AGENTS.md, electron/README.md, web/README.md, online/README.md and
// bench/README.md. A link is `[text](target)` (or an image `![alt](target)`) outside fenced and inline
// code; a target with a scheme (http:, https:, mailto:, file:, ...) is not checked. A relative target
// is resolved against the folder of the file that links it and must exist on disk.
//
// Targets under `.runtime/` are local artefacts: git-ignored, absent on GitHub and in a fresh clone.
// They are allowed and listed separately, with whether this machine has them.
//
// With --anchors, a `#fragment` into a Markdown file must name one of its headings (GitHub-style slugs)
// or an `<a name|id="…">`. Exit code 1 when a link — or, with --anchors, an anchor — is broken.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Folders scanned recursively for `*.md`. */
export const DOC_LINK_FOLDERS = Object.freeze(["docs"]);
/** Single documents outside those folders. */
export const DOC_LINK_FILES = Object.freeze([
  "README.md", "AGENTS.md", "electron/README.md", "web/README.md", "online/README.md", "bench/README.md",
]);
/** The git-ignored folder of local artefacts (see .gitignore). */
export const LOCAL_ARTIFACT_FOLDER = ".runtime";

function markdownUnder(folder, out) {
  if (!existsSync(folder)) return out;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) markdownUnder(path, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(path);
  }
  return out;
}

/** The documents the check covers, as absolute paths, sorted. Missing single files are skipped. */
export function docLinkFiles(root = repositoryRoot) {
  const files = [];
  for (const folder of DOC_LINK_FOLDERS) markdownUnder(resolve(root, folder), files);
  for (const file of DOC_LINK_FILES) {
    const path = resolve(root, file);
    if (existsSync(path) && statSync(path).isFile()) files.push(path);
  }
  return files.sort();
}

/** The lines of a document with fenced blocks and inline code blanked, line numbers kept. */
function proseLines(text) {
  const lines = text.split(/\r?\n/);
  let fence;
  for (let index = 0; index < lines.length; index += 1) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(lines[index]);
    if (marker) {
      if (fence === undefined) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = undefined;
      lines[index] = "";
      continue;
    }
    if (fence !== undefined) {
      lines[index] = "";
      continue;
    }
    lines[index] = lines[index].replace(/(`+)[\s\S]*?\1/g, (code) => " ".repeat(code.length));
  }
  return lines;
}

const LINK = /!?\[(?:[^\][]|\[[^\]]*\])*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Every `[text](target)` of a Markdown text outside code: `{ line, target }`, 1-based lines. */
export function markdownLinks(text) {
  const links = [];
  proseLines(text).forEach((line, index) => {
    for (const match of line.matchAll(LINK)) {
      let target = match[1];
      if (target.startsWith("<")) target = target.slice(1, -1);
      links.push({ line: index + 1, target });
    }
  });
  return links;
}

function decoded(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function headingSlug(heading) {
  return heading.trim().toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function anchorsOf(file, cache) {
  let anchors = cache.get(file);
  if (anchors) return anchors;
  anchors = new Set();
  const seen = new Map();
  for (const line of proseLines(readFileSync(file, "utf8"))) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const base = headingSlug(heading[1]);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      anchors.add(count === 0 ? base : `${base}-${count}`);
    }
    for (const named of line.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) anchors.add(named[1]);
  }
  cache.set(file, anchors);
  return anchors;
}

function slash(path) {
  return path.split(sep).join("/");
}

/**
 * Check the documents under `root`.
 *
 * Returns `{ files, links, broken, localArtifacts, brokenAnchors }`: `files` are root-relative paths,
 * `links` counts the relative links checked (local artefacts included), and every listed link is
 * `{ file, line, target }` (local artefacts add `exists`).
 */
export function checkDocLinks({ root = repositoryRoot, anchors = false } = {}) {
  const absoluteRoot = resolve(root);
  const artifactFolder = resolve(absoluteRoot, LOCAL_ARTIFACT_FOLDER);
  const files = docLinkFiles(absoluteRoot);
  const anchorCache = new Map();
  const result = { files: files.map((file) => slash(relative(absoluteRoot, file))), links: 0, broken: [], localArtifacts: [], brokenAnchors: [] };
  for (const file of files) {
    const from = slash(relative(absoluteRoot, file));
    for (const { line, target } of markdownLinks(readFileSync(file, "utf8"))) {
      if (SCHEME.test(target)) continue;
      result.links += 1;
      const hash = target.indexOf("#");
      const pathPart = decoded(hash < 0 ? target : target.slice(0, hash));
      const fragment = hash < 0 ? "" : decoded(target.slice(hash + 1));
      const resolved = pathPart === "" ? file : resolve(dirname(file), pathPart);
      const exists = existsSync(resolved);
      if (resolved === artifactFolder || resolved.startsWith(artifactFolder + sep)) {
        result.localArtifacts.push({ file: from, line, target, exists });
        continue;
      }
      if (!exists) {
        result.broken.push({ file: from, line, target });
        continue;
      }
      if (anchors && fragment && resolved.toLowerCase().endsWith(".md") && statSync(resolved).isFile()) {
        const known = anchorsOf(resolved, anchorCache);
        if (!known.has(fragment) && !known.has(fragment.toLowerCase())) result.brokenAnchors.push({ file: from, line, target });
      }
    }
  }
  return result;
}

/** A plain-text report of {@link checkDocLinks}'s result. */
export function formatDocLinkReport(result, { anchors = false } = {}) {
  const missingArtifacts = result.localArtifacts.filter((link) => !link.exists).length;
  const lines = [
    `files=${result.files.length} relativeLinks=${result.links} broken=${result.broken.length}`
      + ` localArtifacts=${result.localArtifacts.length} (absent here: ${missingArtifacts})`
      + (anchors ? ` brokenAnchors=${result.brokenAnchors.length}` : ""),
  ];
  const section = (title, list, describe) => {
    if (list.length === 0) return;
    lines.push("", title);
    for (const link of list) lines.push(`  ${link.file}:${link.line}: ${link.target}${describe ? describe(link) : ""}`);
  };
  section("Broken links:", result.broken);
  section(`Local artefacts (${LOCAL_ARTIFACT_FOLDER}/, git-ignored — not on GitHub):`, result.localArtifacts,
    (link) => (link.exists ? "" : "  [absent on this machine]"));
  if (anchors) section("Broken anchors:", result.brokenAnchors);
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const at = args.indexOf(flag);
    if (at < 0) return undefined;
    const value = args[at + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };
  const known = new Set(["--anchors", "--json", "--root"]);
  for (const [index, arg] of args.entries()) {
    if (arg.startsWith("--") && !known.has(arg)) throw new Error(`Unknown option ${arg}. Usage: check-doc-links.mjs [--anchors] [--json <out.json>] [--root <dir>]`);
    if (!arg.startsWith("--") && !["--json", "--root"].includes(args[index - 1])) throw new Error(`Unexpected argument ${arg}`);
  }
  const anchors = args.includes("--anchors");
  const result = checkDocLinks({ root: valueOf("--root") ?? repositoryRoot, anchors });
  console.log(formatDocLinkReport(result, { anchors }));
  const json = valueOf("--json");
  if (json) writeFileSync(resolve(json), `${JSON.stringify(result, null, 1)}\n`);
  if (result.broken.length > 0 || (anchors && result.brokenAnchors.length > 0)) process.exitCode = 1;
}
