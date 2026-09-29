// `npm run patches:status` — which TSWoW client patches are on disk, and who is behind them.
//
// Read-only and local. It answers the three questions a TSWoW build leaves behind:
//   1. What the client is now: every lettered patch (letter, archive/directory/link, link target,
//      file count, newest file), the TSAddon blocks of the *winning* FrameXML.toc, the root
//      Interface/AddOns the gateway would serve, and the generation hash of all of it.
//   2. Whether the running gateway still serves it. A build that rewrites a patch latches the
//      gateway into 409 `client_patch_chain_changed` until it is restarted; this asks the gateway
//      on 127.0.0.1 (never auth 3724 or world 8085) and compares generations.
//   3. Whether players have it: TSWoW's `last-client-build.json` marker against the native
//      publisher's `patches/publication.json`.
//
// The gateway runs this with `--json --no-gateway` in a child for `/client/patch-status` and its
// startup line, because reading the winning TOC opens the MPQ chain and the gateway never does.
//
// Exit codes are bit flags so a script can test the one it cares about:
//   0  nothing to do
//   1  the status could not be computed (no client, unreadable TOC, bad arguments)
//   2  the local gateway is stale: restart it (`npm run gateway`) and reload the page
//   4  players are behind: the last client build is not published (run `publish` in TSWoW)
//   6  both 2 and 4

import "./env.mjs";

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { clientDirectory, datasetDirectory, repositoryRoot, tswowInstall } from "./paths.mjs";
import { parsePatchPublisher } from "./tswow-patch-contract.mjs";

export const PATCH_STATUS_EXIT = Object.freeze({ ok: 0, error: 1, gatewayStale: 2, playersBehind: 4 });

const LETTERED_PATCH = /^patch-(?:([a-z]{4})-)?([a-z])\.mpq$/i;
const LOCALE_DIRECTORY = /^[a-z]{2}[A-Z]{2}$/;
const FRAMEXML_TOC = "Interface/FrameXML/FrameXML.toc";
const BUILD_MARKER = "last-client-build.json";
const PUBLICATION = "publication.json";

/**
 * The same formula as `patchGeneration` in src/gateway/PatchStatus.ts. Duplicated rather than
 * imported because this file runs without a build (the dist copy may predate it);
 * tests/patch-status.test.mjs fails if the two ever disagree.
 */
export function patchGeneration({ archivesHash, chain, addons }) {
  const lines = addons
    .map((addon) => `addon:${addon.name.toLowerCase()}:${addon.loadOnDemand ? 1 : 0}`)
    .sort();
  return createHash("sha1").update([
    "patch-generation-1",
    `archives:${archivesHash ?? "none"}`,
    `chain:${chain ?? "none"}`,
    ...lines,
  ].join("\n")).digest("hex");
}

/** Files under a directory (links followed): how many, and the newest mtime. */
async function treeStats(directory) {
  let files = 0;
  let newest = 0;
  const walk = async (current) => {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      let isDirectory = entry.isDirectory();
      let info;
      if (entry.isSymbolicLink() || !isDirectory) {
        try { info = await stat(absolute); } catch { continue; }
        isDirectory = info.isDirectory();
      }
      if (isDirectory) {
        await walk(absolute);
        continue;
      }
      files++;
      if (info.mtimeMs > newest) newest = info.mtimeMs;
    }
  };
  await walk(directory);
  return { files, newestMs: newest || null };
}

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/** `target` relative to the TSWoW install (`modules/<name>/assets`), or null outside it. */
function inInstall(install, target) {
  if (!install || !target) return null;
  const inside = relative(install, target);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return null;
  return inside.split(sep).join("/");
}

/**
 * Every lettered patch under `Data` and its locale folders, in letter order (a locale form after
 * the base form of the same letter). A TSWoW module's asset folder is linked in as a letter, so
 * the link and its target are reported as they are, not resolved away; `targetInInstall` names
 * the same target relative to `install`, which is what `/client/patch-status` may serve.
 */
export async function letteredPatches(client, install) {
  const data = join(client, "Data");
  const found = [];
  const scan = async (directory, locale) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const match = LETTERED_PATCH.exec(entry.name);
      if (!match) {
        if (locale === undefined && LOCALE_DIRECTORY.test(entry.name) && entry.isDirectory()) await scan(absolute, entry.name);
        continue;
      }
      let info;
      try { info = await lstat(absolute); } catch { continue; }
      const record = {
        letter: match[2].toUpperCase(),
        locale: match[1] ? match[1] : null,
        name: entry.name,
        path: relative(data, absolute).split(sep).join("\\"),
        kind: "archive",
        target: null,
        targetInInstall: null,
        files: null,
        bytes: null,
        newest: null,
      };
      let target = info;
      if (info.isSymbolicLink()) {
        record.kind = "symlink";
        try { record.target = resolve(dirname(absolute), await readlink(absolute)); } catch { /* reported as a dangling link */ }
        record.targetInInstall = inInstall(install, record.target);
        try { target = await stat(absolute); } catch { found.push({ ...record, error: "dangling link" }); continue; }
      } else if (info.isDirectory()) {
        record.kind = "directory";
      }
      if (target.isDirectory()) {
        const tree = await treeStats(absolute);
        record.files = tree.files;
        record.newest = iso(tree.newestMs);
      } else {
        record.bytes = target.size;
        record.newest = iso(target.mtimeMs);
      }
      found.push(record);
    }
  };
  await scan(data, undefined);
  return found.sort((left, right) => left.letter.localeCompare(right.letter)
    || (left.locale === null ? 0 : 1) - (right.locale === null ? 0 : 1)
    || left.path.localeCompare(right.path));
}

/**
 * The complete generated TSAddon blocks of a FrameXML.toc, in the rule the browser boot uses
 * (`frameXmlTsAddonBlocks` in FrameXmlCorpus.ts): a block counts only from `## tsaddon-begin: x`
 * to its own `## tsaddon-end: x`; a truncated or mismatched block is dropped, because the page
 * drops it too. The shared `-lib` block is reported separately.
 */
export function tsAddonBlocks(toc) {
  const blocks = [];
  let current;
  const marker = (line) => {
    const lib = /^\s*##\s*tsaddon-(begin|end)-lib\s*$/i.exec(line);
    if (lib) return { kind: lib[1].toLowerCase(), name: "__lib__" };
    const module = /^\s*##\s*tsaddon-(begin|end)\s*:\s*(\S+)\s*$/i.exec(line);
    return module ? { kind: module[1].toLowerCase(), name: module[2] } : undefined;
  };
  for (const line of toc.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const found = marker(line);
    if (found?.kind === "begin") {
      current = { name: found.name, lines: [line] };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (found?.kind !== "end") continue;
    if (found.name.toLowerCase() === current.name.toLowerCase()) blocks.push(current);
    current = undefined;
  }
  return blocks.map((block) => ({
    name: block.name,
    lib: block.name === "__lib__",
    entries: block.lines.filter((line) => line.trim() && !line.trim().startsWith("#")).length,
    blockSha1: createHash("sha1").update(block.lines.join("\n")).digest("hex"),
  }));
}

/** TSWoW's marker (runtime/PatchPublisher.ts `ClientBuildMarker`), or null before the first build. */
export async function readBuildMarker(dataset) {
  const file = join(dataset, BUILD_MARKER);
  let text;
  try { text = await readFile(file, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return { file, marker: null };
    return { file, marker: null, error: error.message };
  }
  try {
    const marker = JSON.parse(text);
    if (typeof marker?.finishedAt !== "string") return { file, marker: null, error: "has no finishedAt" };
    return { file, marker };
  } catch (error) {
    return { file, marker: null, error: `is not JSON: ${error.message}` };
  }
}

/**
 * The native publisher's output root: `TSWOW_PATCH_MANIFEST`'s folder, else the one beside
 * node.conf's `Launcher.PatchPublisher` (`<publisher>/../patches`), as `patches:check` finds it.
 */
async function publisherRoot(install) {
  if (process.env.TSWOW_PATCH_MANIFEST) return dirname(resolve(process.env.TSWOW_PATCH_MANIFEST));
  try {
    const publisher = parsePatchPublisher(await readFile(join(install, "node.conf"), "utf8"));
    return publisher ? resolve(dirname(publisher), "..", "patches") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `publication.json`, trusted only when its `manifestSha256` is the hash of the manifest.txt beside
 * it — wow-autopatcher's own rule (publish-status.mjs `readPublishedState`): a leftover from an
 * older publisher describes a different manifest and must not vouch for this one.
 */
export async function readPublication(root) {
  if (!root) return null;
  const file = join(root, PUBLICATION);
  let publication;
  try { publication = JSON.parse(await readFile(file, "utf8")); } catch (error) {
    let manifestAt = null;
    try { manifestAt = (await stat(join(root, "manifest.txt"))).mtime.toISOString(); } catch { /* no manifest either */ }
    return error?.code === "ENOENT"
      ? { file, present: false, trusted: false, manifestAt }
      : { file, present: true, trusted: false, manifestAt, error: `cannot be read: ${error.message}` };
  }
  let manifestSha256 = null;
  let manifestAt = null;
  try {
    const [bytes, info] = await Promise.all([readFile(join(root, "manifest.txt")), stat(join(root, "manifest.txt"))]);
    manifestSha256 = createHash("sha256").update(bytes).digest("hex");
    manifestAt = info.mtime.toISOString();
  } catch { /* judged below */ }
  const trusted = manifestSha256 !== null && publication?.manifestSha256 === manifestSha256;
  return {
    file, present: true, trusted, manifestAt,
    publishedAt: typeof publication?.publishedAt === "string" ? publication.publishedAt : null,
    files: typeof publication?.counts?.files === "number" ? publication.counts.files : null,
    ...(trusted ? {} : { error: "describes a different manifest.txt (ignored)" }),
  };
}

/**
 * Whether players have the last client build.
 *
 * The marker's own `published` flag is set only by TSWoW's publishes; a publish run through
 * wow-autopatcher/publish.bat updates publication.json instead. So either proves it, compared
 * against the build's `finishedAt` (the ENG/PUB contract).
 */
export function playersState(marker, publication) {
  if (!marker) return "unknown";
  const finished = Date.parse(marker.finishedAt);
  if (marker.published === true) return "published";
  if (publication?.trusted && publication.publishedAt && Date.parse(publication.publishedAt) >= finished) return "published";
  return "behind";
}

/** The newest file of `modules/<name>/addon/build`, where TSWoW compiles a module's addon. */
async function moduleBuildNewest(install, name) {
  if (!install || !/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  const tree = await treeStats(join(install, "modules", name, "addon", "build"));
  return tree.files ? iso(tree.newestMs) : null;
}

/**
 * Modules with addon sources (`modules/<name>/addon/*.ts`) and no block in the winning TOC: written
 * but never delivered by `build addon` — a new module such as minimap-hub before its first build.
 * `Dataset.Modules = ["all"]` in this installation, so every such module is expected there.
 */
async function addonsNotInToc(install, tsAddons) {
  if (!install) return [];
  const delivered = new Set(tsAddons.map((addon) => addon.name.toLowerCase()));
  let modules;
  try { modules = await readdir(join(install, "modules"), { withFileTypes: true }); } catch { return []; }
  const missing = [];
  for (const entry of modules) {
    if (!entry.isDirectory() || delivered.has(entry.name.toLowerCase())) continue;
    let files;
    try { files = await readdir(join(install, "modules", entry.name, "addon")); } catch { continue; }
    if (!files.some((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))) continue;
    const build = await treeStats(join(install, "modules", entry.name, "addon", "build"));
    missing.push({ name: entry.name, built: build.files > 0 });
  }
  return missing.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * StormLib (the WebAssembly build `mpq.mjs` uses) prints its banner and every heap resize on
 * stdout. This process's stdout is a report — for `--json` it is the one document the gateway
 * parses — so the chain is only ever opened inside this.
 */
async function withoutStormLibChatter(work) {
  const write = process.stdout.write;
  process.stdout.write = function discard(chunk, encoding, callback) {
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") done();
    return true;
  };
  try {
    return await work();
  } finally {
    process.stdout.write = write;
  }
}

/** The winning FrameXML.toc, its source, and per TSAddon block where its files are on disk. */
async function frameXmlTocState(client, install) {
  return withoutStormLibChatter(async () => {
    const { openClientArchives } = await import("./mpq.mjs");
    const chain = await openClientArchives(client);
    try {
      const bytes = await chain.read(FRAMEXML_TOC);
      if (!bytes) return { toc: null, tsAddons: [], error: `${FRAMEXML_TOC} does not resolve` };
      const source = await chain.sourceOf(FRAMEXML_TOC);
      const toc = { source: source?.name ?? null, kind: source?.kind ?? null, file: source?.file ?? null, modified: iso(source?.mtimeMs) };
      const blocks = tsAddonBlocks(new TextDecoder("utf-8").decode(bytes));
      const tsAddons = [];
      for (const block of blocks.filter((candidate) => !candidate.lib)) {
        // Only a loose (directory) winner has files to date; inside a real MPQ there is no mtime.
        const folder = source?.kind === "directory" ? join(dirname(source.file), "TSAddons", block.name) : undefined;
        const patch = folder ? await treeStats(folder) : { files: null, newestMs: null };
        const buildNewest = await moduleBuildNewest(install, block.name);
        const patchNewest = iso(patch.newestMs);
        tsAddons.push({
          name: block.name,
          entries: block.entries,
          blockSha1: block.blockSha1,
          patchFiles: patch.files,
          patchNewest,
          buildNewest,
          // Windows' CopyFile keeps mtimes, so a copied module's newest file is the same instant in
          // both trees; a newer build output is one `build addon` compiled and did not copy.
          notCopied: buildNewest !== null && patchNewest !== null && Date.parse(buildNewest) > Date.parse(patchNewest) + 1000,
        });
      }
      return { toc, tsAddons, lib: blocks.some((block) => block.lib), notInToc: await addonsNotInToc(install, tsAddons) };
    } finally {
      chain.close();
    }
  });
}

/**
 * The inputs of the gateway's generation, from the same dist code the gateway runs. The two ways
 * this fails want different remedies, so they say different things: code that will not load needs
 * a WebClient build; a walk that fails needs the client (a missing `Data`, a build mid-write).
 */
async function currentGeneration(client) {
  const dist = (name) => pathToFileURL(join(repositoryRoot, "dist", "code", "gateway", name)).href;
  let modules;
  try {
    modules = await Promise.all([import(dist("DatasetFingerprint.js")), import(dist("ClientAddons.js"))]);
  } catch (error) {
    throw new Error(`the gateway's dist code could not be loaded (${error.message}); build the WebClient first`);
  }
  const [{ fingerprintArchives }, { discoverClientAddons }] = modules;
  let walk;
  let addons;
  try {
    [walk, addons] = await Promise.all([
      fingerprintArchives(client),
      discoverClientAddons(client, process.env.CLIENT_ADDONS_FILE ? { addonsFile: process.env.CLIENT_ADDONS_FILE } : {}),
    ]);
  } catch (error) {
    throw new Error(`the client patch chain could not be walked: ${error.message}`);
  }
  return {
    generation: patchGeneration({ archivesHash: walk.hash, chain: walk.chain, addons }),
    addons: addons.map((addon) => ({ name: addon.name, loadOnDemand: addon.loadOnDemand })),
  };
}

function getJson({ port, path, origin, timeoutMs }) {
  return new Promise((resolveJob) => {
    const call = httpRequest({ host: "127.0.0.1", port, path, headers: { origin, accept: "application/json" }, timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = undefined; }
        resolveJob({ status: response.statusCode, body });
      });
    });
    call.once("timeout", () => call.destroy(new Error(`no answer in ${timeoutMs} ms`)));
    call.once("error", (error) => resolveJob({ status: 0, error: error.code === "ECONNREFUSED" ? "not running" : error.message }));
    call.end();
  });
}

/**
 * Asks the local gateway — 127.0.0.1 only, whatever GATEWAY_HOST says — what it serves.
 *
 * A gateway older than `/client/patch-status` answers it 404; its `/client/addons` is latched with
 * the rest of the client-media routes, so a 409 there still tells a stale one apart.
 */
export async function inspectLocalGateway({ port, origin, generation, timeoutMs = 2_000 }) {
  const url = `http://127.0.0.1:${port}`;
  const status = await getJson({ port, path: "/client/patch-status?summary=1", origin, timeoutMs });
  if (status.status === 0) return { url, running: false, stale: false, error: status.error };
  if (status.status === 200 && status.body?.schema === 1) {
    const differs = generation !== null && generation !== undefined && status.body.generation !== generation;
    return {
      url, running: true, supported: true,
      stale: status.body.stale === true || differs,
      latched: status.body.stale === true,
      generation: status.body.generation,
      current: generation === null || generation === undefined ? null : !differs,
      supervised: status.body.supervised === true,
      startedAt: status.body.startedAt,
      changedAt: status.body.changedAt,
    };
  }
  if (status.status === 403) {
    return { url, running: true, supported: true, stale: false, error: `refused Origin ${origin} (set ALLOWED_ORIGINS)` };
  }
  const addons = await getJson({ port, path: "/client/addons", origin, timeoutMs });
  const latched = addons.status === 409 && addons.body?.error === "client_patch_chain_changed";
  return {
    url, running: true, supported: false, stale: latched, latched,
    error: `no /client/patch-status (answered ${status.status}); built before it`,
  };
}

/** The whole report. `gateway: false` skips the HTTP check (the gateway's own child). */
export async function inspectPatchStatus({ client, dataset, install, gateway = true, port, origin } = {}) {
  const report = { schema: 1, checkedAt: new Date().toISOString(), errors: [] };
  let clientRoot = client;
  try { clientRoot ??= clientDirectory(); } catch (error) { report.errors.push(error.message); }
  let installRoot = install;
  try { installRoot ??= tswowInstall(); } catch { installRoot = undefined; }
  let datasetRoot = dataset;
  try { datasetRoot ??= datasetDirectory(); } catch { datasetRoot = undefined; }
  report.clientDirectory = clientRoot ?? null;
  report.generation = null;
  report.lettered = [];
  report.frameXmlToc = null;
  report.tsAddons = [];
  report.addonsNotInToc = [];
  report.rootAddons = [];
  if (clientRoot) {
    report.lettered = await letteredPatches(clientRoot, installRoot);
    try {
      const current = await currentGeneration(clientRoot);
      report.generation = current.generation;
      report.rootAddons = current.addons;
    } catch (error) {
      report.generationError = error.message;
    }
    try {
      const state = await frameXmlTocState(clientRoot, installRoot);
      report.frameXmlToc = state.toc;
      report.tsAddons = state.tsAddons;
      report.addonsNotInToc = state.notInToc ?? [];
      if (state.error) report.errors.push(state.error);
    } catch (error) {
      report.errors.push(`the MPQ chain could not be read: ${error.message}`);
    }
  }
  const build = datasetRoot ? await readBuildMarker(datasetRoot) : { file: null, marker: null };
  report.build = build.marker ? { file: build.file, ...build.marker } : null;
  report.buildFile = build.file;
  // The words only: the file is `buildFile`, which the gateway does not serve.
  if (build.error) report.buildError = build.error;
  report.publication = await readPublication(installRoot ? await publisherRoot(installRoot) : undefined);
  report.players = playersState(build.marker, report.publication);
  if (gateway) {
    const allowed = (process.env.ALLOWED_ORIGINS ?? "http://127.0.0.1:5173").split(",").map((value) => value.trim())
      .filter((value) => value && value !== "*");
    report.gateway = await inspectLocalGateway({
      port: port ?? Number.parseInt(process.env.GATEWAY_PORT ?? "8090", 10),
      origin: origin ?? allowed[0] ?? "http://127.0.0.1:5173",
      generation: report.generation,
    });
  }
  report.summaryLine = formatPatchSummaryLine(report);
  return report;
}

export function patchStatusExitCode(report) {
  if (report.errors.length) return PATCH_STATUS_EXIT.error;
  return (report.gateway?.stale ? PATCH_STATUS_EXIT.gatewayStale : 0)
    | (report.players === "behind" ? PATCH_STATUS_EXIT.playersBehind : 0);
}

/** Local wall-clock minutes: the owner compares these with the TSWoW console and Explorer. */
function shortTime(value) {
  if (!value) return "?";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "?";
  const two = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** One line: the gateway prints it at startup after its own generation. */
export function formatPatchSummaryLine(report) {
  const letters = report.lettered.map((patch) => (patch.files === null ? `${patch.letter}[mpq]` : `${patch.letter}(${patch.files})`));
  const addons = report.tsAddons.map((addon) => addon.name);
  const parts = [letters.length ? letters.join(" ") : "no lettered patches"];
  parts.push(`TSAddons ${addons.length}${addons.length ? `: ${addons.join(", ")}` : ""}`);
  const notCopied = report.tsAddons.filter((addon) => addon.notCopied).map((addon) => addon.name);
  if (notCopied.length) parts.push(`built but not copied: ${notCopied.join(", ")}`);
  const pending = (report.addonsNotInToc ?? []).map((addon) => addon.name);
  if (pending.length) parts.push(`not in the TOC yet: ${pending.join(", ")}`);
  parts.push(report.build ? `last build ${shortTime(report.build.finishedAt)}, players ${report.players}` : "no TSWoW build marker yet");
  return parts.join(" · ");
}

function bytesText(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

export function formatPatchStatusReport(report) {
  const lines = [];
  lines.push(`Client ${report.clientDirectory ?? "(not found)"}${report.generation ? ` · generation ${report.generation.slice(0, 12)}` : ""}`);
  if (report.generationError) lines.push(`  generation: ${report.generationError}`);
  lines.push(`Lettered patches (${report.lettered.length}):`);
  for (const patch of report.lettered) {
    const size = patch.files === null ? bytesText(patch.bytes ?? 0) : `${patch.files} files`;
    const target = patch.target ? ` -> ${patch.target}` : "";
    lines.push(`  ${patch.letter}  ${patch.path.padEnd(28)} ${patch.kind.padEnd(9)} ${size.padEnd(10)} newest ${shortTime(patch.newest)}${target}${patch.error ? ` (${patch.error})` : ""}`);
  }
  if (report.frameXmlToc) {
    lines.push(`FrameXML.toc: ${report.frameXmlToc.source} (${shortTime(report.frameXmlToc.modified)}), ${report.tsAddons.length} TSAddon block(s)`);
    for (const addon of report.tsAddons) {
      const files = addon.patchFiles === null ? "" : `${addon.patchFiles} files, `;
      const stale = addon.notCopied ? "  BUILT BUT NOT COPIED: run `build addon` again" : "";
      lines.push(`  ${addon.name.padEnd(22)} ${files}patch ${shortTime(addon.patchNewest)} · build ${shortTime(addon.buildNewest)}${stale}`);
    }
    for (const addon of report.addonsNotInToc ?? []) {
      lines.push(`  ${addon.name.padEnd(22)} NOT IN THE TOC: ${addon.built ? "built, not copied" : "never built"} — run \`build addon\``);
    }
  }
  lines.push(`Root AddOns (${report.rootAddons.length}): ${report.rootAddons.map((addon) => addon.name).join(", ") || "none"}`);
  if (report.build) {
    const published = report.build.published ? `published ${shortTime(report.build.publishedAt)}` : "not published by TSWoW";
    lines.push(`TSWoW build: ${shortTime(report.build.finishedAt)} — ${report.build.command} (${published})${report.build.publishError ? ` · publish failed: ${report.build.publishError}` : ""}`);
  } else {
    lines.push(`TSWoW build: no marker yet (${report.buildFile ?? "dataset not found"}); it appears after the first build with the rebuilt console`);
  }
  if (report.buildError) lines.push(`  ${report.buildFile} ${report.buildError}`);
  const publication = report.publication;
  if (!publication) lines.push("Native publication: publisher not configured (node.conf Launcher.PatchPublisher)");
  else if (!publication.present) lines.push(`Native publication: no publication.json yet${publication.manifestAt ? ` (manifest.txt ${shortTime(publication.manifestAt)})` : ""}`);
  else lines.push(`Native publication: ${shortTime(publication.publishedAt)}, ${publication.files ?? "?"} files${publication.trusted ? "" : ` — ${publication.error}`}`);
  lines.push(`Players: ${report.players === "behind" ? "BEHIND the last build — run `publish` in the TSWoW console" : report.players}`);
  const gateway = report.gateway;
  if (gateway) {
    let state;
    if (!gateway.running) state = `${gateway.error ?? "not running"}`;
    else if (gateway.stale) state = `STALE — restart the gateway and reload the page${gateway.supervised ? " (its supervisor will restart it once the build settles and nobody is in the world)" : ""}`;
    else if (gateway.supported) state = gateway.current === null ? "running (generation not compared)" : "current";
    else state = "running, not latched";
    lines.push(`Gateway ${gateway.url}: ${state}${gateway.error && gateway.running ? ` · ${gateway.error}` : ""}`);
  }
  for (const error of report.errors) lines.push(`ERROR ${error}`);
  return lines;
}

function usage() {
  return [
    "usage: node tools/patch-status.mjs [--json] [--no-gateway]",
    "  --json        print the report as one JSON document",
    "  --no-gateway  do not ask the local gateway (127.0.0.1:GATEWAY_PORT) what it serves",
    "exit: 0 ok · 1 error · 2 gateway stale · 4 players behind (bit flags; 6 = both)",
  ].join("\n");
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entry === import.meta.url) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => !["--json", "--no-gateway", "--help", "-h"].includes(arg));
  if (args.includes("--help") || args.includes("-h") || unknown.length) {
    if (unknown.length) console.error(`Unknown argument(s): ${unknown.join(" ")}`);
    console.error(usage());
    process.exitCode = unknown.length ? PATCH_STATUS_EXIT.error : PATCH_STATUS_EXIT.ok;
  } else {
    try {
      const report = await inspectPatchStatus({ gateway: !args.includes("--no-gateway") });
      if (args.includes("--json")) process.stdout.write(`${JSON.stringify(report)}\n`);
      else console.log(formatPatchStatusReport(report).join("\n"));
      process.exitCode = patchStatusExitCode(report);
    } catch (error) {
      console.error(`ERROR patch status: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = PATCH_STATUS_EXIT.error;
    }
  }
}

export const PATCH_STATUS_TOOL = fileURLToPath(import.meta.url);
