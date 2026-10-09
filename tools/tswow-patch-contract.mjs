/**
 * Proves that the browser client, the TSWoW dataset and the patch set offered to native clients
 * describe the same client build.
 *
 * There are deliberately two levels:
 *  - `inspectRuntimePatchAlignment` is the bounded gateway-start guard. It compares a handful of
 *    high-value DBCs with their actual winners in the complete client archive chain.
 *  - `inspectTswowPatchContract` is the operator audit used by `npm run patches:check`. It checks
 *    every dataset DBC, resolves the real MPQ chain, walks TSWoW's generated FrameXML entries and,
 *    when a publisher manifest exists, compares what native players receive with the live client.
 */

import "./env.mjs";

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { clientDirectory, datasetDirectory, tswowInstall } from "./paths.mjs";

const LETTERED_PATCH = /^patch-(?:[a-z]{4}-)?([a-z])\.mpq$/i;
const REQUIRED_CLIENT_NETWORK_CAPABILITY = "tswow-client-network-v1";
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CLIENT_NETWORK_RUNTIME = join(
  REPOSITORY_ROOT, "dist", "code", "browser", "framexml", "FrameXmlClientNetwork.js",
);
const MANIFEST_HEADER = "WOWPATCH1";
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])$/i;
const WINDOWS_FORBIDDEN_PATH_CHARACTER = /[<>:"|?*\u0000-\u001f]/;
const PROTECTED_ROOT_PATCH_FILE = /^(?:wow\.exe|wow\.exe\.wowpatcher-backup|wowpatcher\.exe|wowpatcher\.ini|wowpatcher-hook\.dll|wowpatcherinstall\.exe)$/i;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_ENTRIES = 50_000;
const DBC_ANCHORS = Object.freeze([
  "AreaTable.dbc",
  "ChrRaces.dbc",
  "Item.dbc",
  "Map.dbc",
  "Spell.dbc",
  "Talent.dbc",
]);

function assignment(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*${escaped}\\s*=\\s*(.*?)\\s*$`, "mi").exec(source);
  return match?.[1]?.trim();
}

function quoted(value) {
  if (!value) return undefined;
  const match = /^"([^"]*)"$/.exec(value);
  return match?.[1];
}

/** The subset of dataset.conf that decides the client-side patch shape. */
export function parseDatasetPatchConfig(source) {
  const build = Number.parseInt(assignment(source, "Dataset.GameBuild") ?? "12340", 10);
  const letter = (quoted(assignment(source, "Client.DevPatchLetter")) ?? "A").toUpperCase();
  const useLocale = /^(?:true|1)$/i.test(assignment(source, "Client.Patch.UseLocale") ?? "false");
  const clientPath = quoted(assignment(source, "Client.Path"));
  const mapping = assignment(source, "Package.Mapping") ?? '["A.MPQ:*"]';
  const binaryPatches = assignment(source, "Client.Patches") ?? "[]";
  return {
    build: Number.isInteger(build) ? build : 12340,
    letter: /^[A-Z]$/.test(letter) ? letter : "A",
    useLocale,
    clientPath,
    mapping,
    binaryPatches,
  };
}

/** Launcher.PatchPublisher from node.conf, without executing the publisher. */
export function parsePatchPublisher(source) {
  return quoted(assignment(source, "Launcher.PatchPublisher"));
}

/** Default.Client from node.conf: the native client TSWoW builds and launches. */
export function parseDefaultClient(source) {
  return quoted(assignment(source, "Default.Client"));
}

/** Dataset Client.Path takes precedence; both TSWoW settings are rooted at the installation. */
export function selectEffectiveDatasetClient({ clientPath, defaultClient, installRoot }) {
  const override = clientPath?.trim();
  const fallback = defaultClient?.trim();
  const configured = override || fallback;
  if (!configured) return undefined;
  return {
    configured,
    path: resolve(installRoot, configured),
    source: override ? "dataset.conf Client.Path" : "node.conf Default.Client",
  };
}

async function canonicalPath(value) {
  const path = await realpath(value);
  return { path, key: process.platform === "win32" ? path.toLowerCase() : path };
}

/** Strict enough to reject a partial or ambiguously parsed native-client manifest. */
export function parseWowPatchManifest(source) {
  if (Buffer.byteLength(source, "utf8") > MAX_MANIFEST_BYTES) {
    throw new Error("Patch manifest exceeds 4 MiB");
  }
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.shift() !== MANIFEST_HEADER) throw new Error(`Expected exact ${MANIFEST_HEADER} header`);
  const entries = [];
  const paths = new Set();
  for (const [index, raw] of lines.entries()) {
    if (!raw || raw.startsWith("#")) continue;
    const fields = raw.split("\t");
    if (fields.length !== 4 || !/^[0-9a-f]{64}$/i.test(fields[0] ?? "")) {
      throw new Error(`Invalid patch manifest row ${index + 2}`);
    }
    if (!/^[0-9]+$/.test(fields[1] ?? "")) {
      throw new Error(`Invalid patch size on row ${index + 2}`);
    }
    const size = Number(fields[1]);
    if (!Number.isSafeInteger(size)) throw new Error(`Invalid patch size on row ${index + 2}`);
    const path = (fields[2] ?? "").replaceAll("\\", "/");
    const parts = path.split("/");
    const rawUrl = fields[3] ?? "";
    let parsedUrl;
    try { parsedUrl = new URL(rawUrl); } catch { throw new Error(`Invalid patch URL on row ${index + 2}`); }
    if (!/^https?:\/\//i.test(rawUrl) || !/^(?:http|https):$/.test(parsedUrl.protocol) || !parsedUrl.hostname) {
      throw new Error(`Invalid patch URL on row ${index + 2}`);
    }
    if (!path || path.startsWith("/")
      || WINDOWS_FORBIDDEN_PATH_CHARACTER.test(path)
      || parts.some((part) => !part || part === "." || part === ".." || part.length > 255
        || /[. ]$/.test(part) || WINDOWS_RESERVED_BASENAME.test(part.split(".", 1)[0]))
      || (parts.length === 1 && PROTECTED_ROOT_PATCH_FILE.test(parts[0]))) {
      throw new Error(`Invalid patch path on row ${index + 2}`);
    }
    const key = path.toLowerCase();
    if (paths.has(key)) throw new Error(`Invalid patch path on row ${index + 2}: duplicate`);
    paths.add(key);
    if (entries.length >= MAX_MANIFEST_ENTRIES) throw new Error("Patch manifest has more than 50000 entries");
    entries.push({ sha256: fields[0].toLowerCase(), size, path, url: rawUrl });
  }
  return entries;
}

function localeSpelling(value) {
  const match = /^([a-z]{2})([a-z]{2})$/i.exec(value ?? "");
  return match ? `${match[1].toLowerCase()}${match[2].toUpperCase()}` : undefined;
}

async function findLocale(clientRoot, requested) {
  const wanted = localeSpelling(requested);
  if (wanted) return wanted;
  const entries = await readdir(join(clientRoot, "Data"), { withFileTypes: true });
  const locales = entries.filter((entry) => entry.isDirectory() && localeSpelling(entry.name)).map((entry) => entry.name);
  if (locales.length === 1) return localeSpelling(locales[0]);
  return undefined;
}

function expectedPatchPath(clientRoot, config, locale) {
  return config.useLocale
    ? join(clientRoot, "Data", locale, `patch-${locale}-${config.letter}.MPQ`)
    : join(clientRoot, "Data", `patch-${config.letter}.MPQ`);
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function compareFiles(left, right) {
  let a;
  let b;
  try { [a, b] = await Promise.all([stat(left), stat(right)]); } catch { return { equal: false, missing: true }; }
  if (!a.isFile() || !b.isFile()) return { equal: false, missing: true };
  if (a.size !== b.size) return { equal: false, missing: false, leftSize: a.size, rightSize: b.size };
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  return { equal: leftHash === rightHash, missing: false, leftSize: a.size, rightSize: b.size };
}

async function directoryKind(path) {
  try {
    const info = await stat(path);
    return info.isDirectory() ? "directory" : info.isFile() ? "archive" : "other";
  } catch {
    return "missing";
  }
}

/** Bounded to six tables, but resolved through the same complete chain the client actually reads. */
export async function inspectRuntimePatchAlignment(options) {
  const clientRoot = resolve(options.clientDirectory);
  const datasetRoot = resolve(options.datasetDirectory);
  const configFile = join(datasetRoot, "dataset.conf");
  const config = parseDatasetPatchConfig(await readFile(configFile, "utf8"));
  const locale = await findLocale(clientRoot, options.locale);
  const errors = [];
  const warnings = [];
  if (config.useLocale && !locale) {
    errors.push("Client.Patch.UseLocale=true, but the client locale could not be selected");
    return { ok: false, config, locale, expectedPatch: undefined, kind: "missing", checked: 0, errors, warnings };
  }
  const patch = expectedPatchPath(clientRoot, config, locale ?? "");
  const kind = await directoryKind(patch);
  if (kind === "missing") {
    // Package.Mapping may put the DBC package under another letter. The active winners below are
    // authoritative; the configured development path remains useful diagnostics, not a reason to
    // reject a byte-identical distributed package.
    warnings.push(`Configured development patch is missing: ${patch}; validating active DBC winners`);
  } else if (kind === "other") errors.push(`${patch} is not a patch file or directory`);

  let checked = 0;
  const winners = [];
  let chain;
  try {
    // Lazy by design: importing this audit for manifest parsing must not initialise StormLib. The
    // gateway startup path calls this function explicitly and needs the exact same A-Z/locale
    // precedence as every asset generator, including file-backed MPQs.
    const { openClientArchives } = await import("./mpq.mjs");
    chain = await openClientArchives(clientRoot);
    if (chain.skipped.length) {
      errors.push(`Client archive chain has unreadable source(s): ${chain.skipped.join(", ")}`);
    }
    for (const file of options.anchors ?? DBC_ANCHORS) {
      const datasetFile = join(options.dbcDirectory ?? join(datasetRoot, "dbc"), file);
      let dataset;
      try {
        dataset = await readFile(datasetFile);
      } catch {
        errors.push(`${file} is missing from dataset/dbc`);
        continue;
      }
      const internal = `DBFilesClient\\${file}`;
      const active = await chain.read(internal);
      const source = active === undefined ? undefined : await chain.locate(internal);
      if (active === undefined || source === undefined) {
        errors.push(`${file} has no readable active client source`);
        continue;
      }
      const equal = dataset.equals(active);
      winners.push({ name: file, source, equal });
      checked++;
      if (!equal) errors.push(`${file} differs between dataset/dbc and active source ${source}`);
    }
  } catch (error) {
    errors.push(`Client archive chain could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    chain?.close();
  }
  return { ok: errors.length === 0, config, locale, expectedPatch: patch, kind, checked, winners, errors, warnings };
}

async function dbcFiles(directory) {
  const names = [];
  const empty = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".dbc")) continue;
    if ((await stat(join(directory, entry.name))).size === 0) empty.push(entry.name);
    else names.push(entry.name);
  }
  names.sort((left, right) => left.localeCompare(right));
  empty.sort((left, right) => left.localeCompare(right));
  return { names, empty };
}

/** Pure policy for deciding whether the active MPQ winner is the intended dataset exception. */
export function classifyDatasetDbcWinner({
  name, source, equal, clientMediaTables = [], clientMediaSources = [],
}) {
  if (!source) return { level: "error", kind: "missing" };
  const archive = source.replaceAll("\\", "/").split("/").at(-1).toLowerCase();
  if (equal) return { level: "ok", kind: "active-match" };

  const table = name.replace(/\.dbc$/i, "").toLowerCase();
  const clientMedia = clientMediaTables.some((candidate) => candidate.toLowerCase() === table);
  if (clientMedia && LETTERED_PATCH.test(archive)) {
    return { level: "warning", kind: "client-media" };
  }
  const coordinatedSources = new Set(clientMediaSources.map((candidate) =>
    candidate.replaceAll("\\", "/").split("/").at(-1).toLowerCase()));
  if (table === "creaturefamily" && coordinatedSources.has(archive)) {
    return { level: "warning", kind: "creature-family" };
  }
  return { level: "error", kind: "unexpected-override" };
}

async function compareActiveDatasetDbcs(dbcRoot, chain, clientMediaTables) {
  const { names } = await dbcFiles(dbcRoot);
  const rows = [];
  for (const name of names) {
    const internal = `DBFilesClient\\${name}`;
    const dataset = await readFile(join(dbcRoot, name));
    const winner = await chain.read(internal);
    const source = winner === undefined ? undefined : await chain.locate(internal);
    rows.push({ name, source, equal: winner !== undefined && dataset.equals(winner) });
  }
  // CreatureFamily is not one of the extracted overlay tables, but the measured HD pack carries it
  // beside those tables. Tie that exception to an actual differing client-media winner rather than
  // to a magic W letter, so patch-ruRU-G and patch-B have the same semantics and an unrelated patch
  // cannot smuggle in a gameplay-table difference under the media exception.
  const media = new Set(clientMediaTables.map((name) => name.toLowerCase()));
  const clientMediaSources = rows
    .filter((row) => !row.equal && row.source
      && media.has(row.name.replace(/\.dbc$/i, "").toLowerCase())
      && LETTERED_PATCH.test(row.source.replaceAll("\\", "/").split("/").at(-1)))
    .map((row) => row.source);
  const issues = [];
  let matched = 0;
  for (const { name, source, equal } of rows) {
    const classification = classifyDatasetDbcWinner({
      name, source, equal, clientMediaTables, clientMediaSources,
    });
    if (classification.level === "ok") matched++;
    else issues.push({ name, source, equal, ...classification });
  }
  return { files: names.length, matched, issues };
}

function activeDbcMessage(issue) {
  if (issue.kind === "missing") return `${issue.name}: no active MPQ source resolves this dataset DBC`;
  if (issue.kind === "client-media") {
    return `${issue.name}: approved client-media override from ${issue.source} `
      + `(${issue.equal ? "byte-identical to" : "differs from"} dataset/dbc)`;
  }
  if (issue.kind === "creature-family") {
    return `${issue.name}: approved CreatureFamily override from ${issue.source} `
      + `(${issue.equal ? "byte-identical to" : "differs from"} dataset/dbc)`;
  }
  return `${issue.name}: unexpected differing active source ${issue.source}`;
}

function tocEntries(source, root) {
  const result = [];
  for (const raw of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !/\.(?:lua|xml)$/i.test(line)) continue;
    const normalised = line.replaceAll("/", "\\");
    if (normalised.split("\\").some((part) => !part || part === "." || part === "..")) continue;
    result.push(`${root}\\${normalised}`);
  }
  return result;
}

function tsAddonModules(source) {
  return [...source.matchAll(/^\s*##\s*tsaddon-begin\s*:\s*(\S+)\s*$/gim)].map((match) => match[1]);
}

async function walkPublishedSource(root, clientRoot, into) {
  const info = await stat(root);
  if (info.isFile()) {
    into.set(relative(clientRoot, root).split(sep).join("/"), root);
    return;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    await walkPublishedSource(join(root, entry.name), clientRoot, into);
  }
}

async function activeLetteredPatchFiles(clientRoot, firstLetter) {
  const result = new Map();
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const match = LETTERED_PATCH.exec(entry.name);
      if (match && match[1].toUpperCase() >= firstLetter) {
        await walkPublishedSource(absolute, clientRoot, result);
      } else if (entry.isDirectory()) {
        await walk(absolute);
      }
    }
  };
  await walk(join(clientRoot, "Data"));
  return result;
}

function isManifestPatchPath(path, firstLetter) {
  return path.split("/").some((part) => {
    const match = LETTERED_PATCH.exec(part);
    return match && match[1].toUpperCase() >= firstLetter;
  });
}

async function compareLocalManifestEntries(entries, root) {
  const missing = [];
  const different = [];
  for (const entry of entries) {
    const file = join(root, ...entry.path.split("/"));
    let info;
    try { info = await stat(file); } catch { missing.push(entry.path); continue; }
    if (!info.isFile()) {
      missing.push(entry.path);
    } else if (info.size !== entry.size || await sha256(file) !== entry.sha256) {
      different.push(entry.path);
    }
  }
  return { missing, different };
}

/** Verifies the publisher's local `files/` tree without contacting URLs or running publisher code. */
export async function inspectManifestPayloads(entries, manifestFile) {
  const payloadRoot = join(dirname(resolve(manifestFile)), "files");
  const { missing: payloadMissing, different: payloadDifferent } =
    await compareLocalManifestEntries(entries, payloadRoot);
  return { payloadRoot, payloadCount: entries.length, payloadMissing, payloadDifferent };
}

function isLetteredPatchPath(path) {
  return path.split("/").some((part) => LETTERED_PATCH.test(part));
}

/** Verifies non-MPQ runtime files in the installed client against the same manifest. */
export async function inspectManifestRuntime(entries, clientRoot) {
  const runtimeEntries = entries.filter((entry) => !isLetteredPatchPath(entry.path));
  const { missing: runtimeMissing, different: runtimeDifferent } =
    await compareLocalManifestEntries(runtimeEntries, clientRoot);
  return { runtimeCount: runtimeEntries.length, runtimeMissing, runtimeDifferent };
}

async function inspectPublishedManifest({ clientRoot, installRoot, firstLetter, manifestFile }) {
  let publisher;
  try { publisher = parsePatchPublisher(await readFile(join(installRoot, "node.conf"), "utf8")); } catch { /* optional */ }
  const inferred = publisher
    ? resolve(dirname(publisher), "..", "patches", "manifest.txt")
    : undefined;
  const file = resolve(manifestFile ?? process.env.TSWOW_PATCH_MANIFEST ?? inferred ?? "__missing_manifest__");
  if (await directoryKind(file) !== "archive") {
    return {
      present: false, file, publisher, current: 0, published: 0,
      missing: [], stale: [], different: [],
      payloadCount: 0, payloadMissing: [], payloadDifferent: [],
      runtimeCount: 0, runtimeMissing: [], runtimeDifferent: [],
    };
  }
  const entries = parseWowPatchManifest(await readFile(file, "utf8"));
  const [payload, runtime] = await Promise.all([
    inspectManifestPayloads(entries, file),
    inspectManifestRuntime(entries, clientRoot),
  ]);
  const insecure = entries.filter((entry) => new URL(entry.url).protocol === "http:").length;
  const published = new Map(entries
    .filter((entry) => isManifestPatchPath(entry.path, firstLetter))
    .map((entry) => [entry.path.toLowerCase(), entry]));
  const current = await activeLetteredPatchFiles(clientRoot, firstLetter);
  const currentByKey = new Map([...current].map(([path, absolute]) => [path.toLowerCase(), { path, absolute }]));
  const missing = [...currentByKey].filter(([key]) => !published.has(key)).map(([, item]) => item.path);
  const stale = [...published].filter(([key]) => !currentByKey.has(key)).map(([, item]) => item.path);
  const different = [];
  for (const [key, entry] of published) {
    const active = currentByKey.get(key);
    if (!active) continue;
    const info = await stat(active.absolute);
    if (info.size !== entry.size || await sha256(active.absolute) !== entry.sha256) different.push(entry.path);
  }
  return {
    present: true, file, publisher,
    current: current.size, published: published.size,
    missing, stale, different, insecure,
    ...payload,
    ...runtime,
  };
}

async function looseAddons(clientRoot) {
  const root = join(clientRoot, "Interface", "AddOns");
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.toLowerCase().startsWith("blizzard_"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/** The gateway's own add-on discovery, from the built code; undefined when it is not built. */
async function gatewayAddonDiscovery() {
  try {
    return await import(pathToFileURL(join(REPOSITORY_ROOT, "dist", "code", "gateway", "ClientAddons.js")).href);
  } catch {
    return undefined;
  }
}

/**
 * The "Loose AddOns" line: every root directory except `Blizzard_*` (what the browser host could
 * see), then — when the gateway's discovery is built — how many of them the browser actually loads
 * and which ones the `AddOns.txt` profile disables (9.07: «6 directories» against «3 load paths»
 * is the profile, not the loader).
 */
export async function looseAddonsMessage(clientRoot, discovery = gatewayAddonDiscovery) {
  const addons = await looseAddons(clientRoot);
  if (!addons.length) return undefined;
  let message = `${addons.length} root-level add-on director${addons.length === 1 ? "y is" : "ies are"} exposed to the browser FrameXML host; arbitrary add-on API compatibility still requires a runtime check: ${sample(addons)}`;
  const module = await discovery();
  if (module?.discoverClientAddons && module?.disabledByProfile) {
    const [enabled, disabled] = await Promise.all([
      module.discoverClientAddons(clientRoot), module.disabledByProfile(clientRoot),
    ]);
    message += `; of them ${enabled.length} load (an add-on is a directory with its own .toc)`
      + `, disabled by the AddOns.txt profile: ${disabled.length ? disabled.join(", ") : "none"}`;
  }
  return message;
}

function sample(values, limit = 8) {
  return values.length <= limit ? values.join(", ") : `${values.slice(0, limit).join(", ")} (+${values.length - limit})`;
}

/**
 * Import the compiled browser bridge and execute its codec/transport/lifecycle probe.
 *
 * This intentionally audits `dist`, not a source string: a green patch report therefore proves
 * that the build operators will actually serve contains an executable `_CLIENT_NETWORK` bridge.
 */
export async function inspectFrameXmlClientNetworkRuntime(
  moduleFile = DEFAULT_CLIENT_NETWORK_RUNTIME,
) {
  const resolvedModule = resolve(moduleFile);
  try {
    const runtime = await import(pathToFileURL(resolvedModule).href);
    if (typeof runtime.probeFrameXmlClientNetworkCapability !== "function") {
      return {
        ok: false,
        capability: undefined,
        moduleFile: resolvedModule,
        message: "compiled module exports no executable ClientNetwork capability probe",
      };
    }
    const result = runtime.probeFrameXmlClientNetworkCapability();
    if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
      return {
        ok: false,
        capability: undefined,
        moduleFile: resolvedModule,
        message: "compiled ClientNetwork capability probe returned an invalid result",
      };
    }
    if (result.capability !== REQUIRED_CLIENT_NETWORK_CAPABILITY) {
      return {
        ok: false,
        capability: result.capability,
        moduleFile: resolvedModule,
        message: `compiled capability ${String(result.capability)} does not satisfy ${REQUIRED_CLIENT_NETWORK_CAPABILITY}`,
      };
    }
    return {
      ok: result.ok,
      capability: result.capability,
      moduleFile: resolvedModule,
      message: String(result.message ?? (result.ok ? "probe passed" : "probe failed")),
    };
  } catch (error) {
    return {
      ok: false,
      capability: undefined,
      moduleFile: resolvedModule,
      message: `could not execute compiled ClientNetwork bridge: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Full, evidence-producing audit for an operator or CI attached to a real TSWoW installation. */
export async function inspectTswowPatchContract(options = {}) {
  const clientRoot = resolve(options.clientDirectory ?? clientDirectory());
  const configuredPack = process.env.CLIENT_PACK_DIR === undefined
    ? undefined : resolve(process.env.CLIENT_PACK_DIR);
  const autonomousPack = configuredPack !== undefined
    && (process.platform === "win32"
      ? configuredPack.toLowerCase() === clientRoot.toLowerCase()
      : configuredPack === clientRoot);
  const installRoot = resolve(options.tswowInstall ?? tswowInstall());
  const datasetRoot = resolve(options.datasetDirectory ?? datasetDirectory());
  const runtime = await inspectRuntimePatchAlignment({
    clientDirectory: clientRoot,
    datasetDirectory: datasetRoot,
    dbcDirectory: options.dbcDirectory ?? join(datasetRoot, "dbc"),
    locale: options.locale ?? process.env.CLIENT_LOCALE,
  });
  const results = [];
  let defaultClient;
  let nodeConfigError;
  try {
    defaultClient = parseDefaultClient(await readFile(join(installRoot, "node.conf"), "utf8"));
  } catch (error) {
    nodeConfigError = error;
  }
  const selected = selectEffectiveDatasetClient({
    clientPath: runtime.config.clientPath, defaultClient, installRoot,
  });
  if (!selected) {
    const detail = nodeConfigError
      ? `node.conf could not be read: ${nodeConfigError instanceof Error ? nodeConfigError.message : String(nodeConfigError)}`
      : "neither dataset.conf Client.Path nor node.conf Default.Client is set";
    results.push({ level: "warning", label: "TSWoW selected client", message: detail });
  } else {
    const label = `TSWoW selected client (${selected.source})`;
    try {
      const [configured, web] = await Promise.all([
        canonicalPath(selected.path), canonicalPath(clientRoot),
      ]);
      if (configured.key !== web.key) {
        results.push(autonomousPack
          ? {
            level: "ok", label: "Autonomous client pack",
            message: `${web.path} snapshots the client selected at ${configured.path}; byte alignment is checked below`,
          }
          : {
            level: "error", label,
            message: `${configured.path} is selected, but WebClient reads ${web.path}`,
          });
      } else {
        results.push({ level: "ok", label, message: `${web.path} is the effective dataset client` });
      }
    } catch (error) {
      results.push({
        level: "error", label,
        message: `could not canonicalize ${selected.path}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  results.push(...runtime.errors.map((message) => ({ level: "error", label: "Runtime dataset", message })));
  results.push(...runtime.warnings.map((message) => ({ level: "warning", label: "Runtime dataset", message })));
  if (runtime.ok) results.push({
    level: "ok", label: "Runtime dataset",
    message: `${runtime.checked} anchor DBCs match their active A-Z/locale-chain winners`,
  });

  const [{ openClientArchives }, { CLIENT_MEDIA_DBC_TABLES }] = await Promise.all([
    import("./mpq.mjs"),
    import("./extract-visual-dbc-overlay.mjs"),
  ]);
  let deliveredModules = [];
  const chain = await openClientArchives(clientRoot);
  try {
    if (chain.skipped.length) results.push({ level: "error", label: "MPQ chain", message: `could not open: ${chain.skipped.join(", ")}` });
    else results.push({ level: "ok", label: "MPQ chain", message: `${chain.sources.length} sources, priority ${chain.sources.map((source) => source.name).join(" > ")}` });
    const active = await compareActiveDatasetDbcs(
      options.dbcDirectory ?? join(datasetRoot, "dbc"),
      chain,
      CLIENT_MEDIA_DBC_TABLES,
    );
    results.push({
      level: "ok", label: "Active DBC winners",
      message: `${active.matched} of ${active.files} non-empty dataset DBCs resolve byte-identically from the active chain`,
    });
    for (const issue of active.issues) results.push({
      level: issue.level,
      label: "Active DBC winners",
      message: activeDbcMessage(issue),
    });
    const tocPath = "Interface\\FrameXML\\FrameXML.toc";
    const toc = await chain.read(tocPath);
    if (!toc) {
      results.push({ level: "error", label: "TSWoW interface", message: `${tocPath} does not resolve` });
    } else {
      const source = new TextDecoder("utf-8", { fatal: true }).decode(toc);
      const modules = tsAddonModules(source);
      deliveredModules = modules;
      const entries = tocEntries(source, "Interface\\FrameXML").filter((path) => path.toLowerCase().includes("\\tsaddons\\"));
      const missing = [];
      for (const entry of entries) if (!await chain.has(entry)) missing.push(entry);
      if (missing.length) results.push({ level: "error", label: "TSWoW interface", message: `TOC entries missing: ${sample(missing)}` });
      else results.push({
        level: "ok", label: "TSWoW interface",
        message: `${modules.length} module(s), ${entries.length} generated Lua/XML entries; source ${await chain.locate(tocPath)}: ${modules.join(", ") || "none"}`,
      });
    }
  } finally {
    chain.close();
  }
  if (deliveredModules.length) {
    const clientNetwork = await inspectFrameXmlClientNetworkRuntime(options.clientNetworkRuntime);
    results.push({
      level: clientNetwork.ok ? "ok" : "error",
      label: "TSWoW module runtime",
      message: clientNetwork.ok
        ? `${deliveredModules.length} TSAddon(s) execute in FrameXML; ${clientNetwork.capability} ${clientNetwork.message}`
        : `${deliveredModules.length} TSAddon(s) require _CLIENT_NETWORK, but ${clientNetwork.message}; build the WebClient before auditing`,
    });
  }

  const manifest = await inspectPublishedManifest({
    clientRoot, installRoot, firstLetter: runtime.config.letter,
    manifestFile: options.manifestFile,
  });
  if (!manifest.present) {
    results.push({ level: "warning", label: "Native updater", message: `no WOWPATCH1 manifest found at ${manifest.file}` });
  } else if (manifest.missing.length || manifest.stale.length || manifest.different.length) {
    if (manifest.missing.length) results.push({ level: "error", label: "Native updater", message: `${manifest.missing.length} live patch file(s) are not published: ${sample(manifest.missing)}` });
    if (manifest.different.length) results.push({ level: "error", label: "Native updater", message: `${manifest.different.length} published file(s) differ: ${sample(manifest.different)}` });
    if (manifest.stale.length) results.push({ level: "error", label: "Native updater", message: `${manifest.stale.length} published path(s) are stale: ${sample(manifest.stale)}` });
  } else {
    results.push({ level: "ok", label: "Native updater", message: `${manifest.current} active patch file(s) match ${manifest.file}` });
  }
  if (manifest.present) {
    if (manifest.payloadMissing.length) results.push({
      level: "error", label: "Patch payload",
      message: `${manifest.payloadMissing.length} manifest file(s) are missing under ${manifest.payloadRoot}: ${sample(manifest.payloadMissing)}`,
    });
    if (manifest.payloadDifferent.length) results.push({
      level: "error", label: "Patch payload",
      message: `${manifest.payloadDifferent.length} local payload(s) differ from manifest size/SHA-256: ${sample(manifest.payloadDifferent)}`,
    });
    if (!manifest.payloadMissing.length && !manifest.payloadDifferent.length) results.push({
      level: "ok", label: "Patch payload",
      message: `${manifest.payloadCount} local payload(s) match manifest size/SHA-256`,
    });
    if (manifest.runtimeMissing.length) results.push({
      level: "error", label: "Native runtime",
      message: `${manifest.runtimeMissing.length} manifest runtime file(s) are missing from ${clientRoot}: ${sample(manifest.runtimeMissing)}`,
    });
    if (manifest.runtimeDifferent.length) results.push({
      level: "error", label: "Native runtime",
      message: `${manifest.runtimeDifferent.length} installed runtime file(s) differ from manifest size/SHA-256: ${sample(manifest.runtimeDifferent)}`,
    });
    if (!manifest.runtimeMissing.length && !manifest.runtimeDifferent.length) results.push({
      level: "ok", label: "Native runtime",
      message: `${manifest.runtimeCount} non-patch runtime file(s) match manifest size/SHA-256`,
    });
  }
  if (manifest.present && manifest.insecure > 0) results.push({
    level: "warning", label: "Patch transport",
    message: `${manifest.insecure} manifest URL(s) use HTTP; executable Lua/DLL patch delivery is not authenticated`,
  });

  const addonsMessage = await looseAddonsMessage(clientRoot);
  if (addonsMessage) results.push({ level: "warning", label: "Loose AddOns", message: addonsMessage });
  results.push({
    level: "ok", label: "Native-only patches",
    message: `game build ${runtime.config.build}; ${runtime.config.binaryPatches} applies to Wow.exe/DLL and is intentionally not executed in the browser sandbox`,
  });
  return { ok: !results.some((entry) => entry.level === "error"), runtime, manifest, results };
}

function print(results) {
  for (const result of results) {
    const prefix = result.level === "ok" ? "OK" : result.level === "warning" ? "WARN" : "ERROR";
    console.log(`${prefix.padEnd(5)} ${result.label}: ${result.message}`);
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entry === import.meta.url) {
  try {
    const report = await inspectTswowPatchContract();
    print(report.results);
    const errors = report.results.filter((item) => item.level === "error").length;
    const warnings = report.results.filter((item) => item.level === "warning").length;
    console.log(`\nTSWoW patch contract: ${errors} error(s), ${warnings} warning(s).`);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`ERROR TSWoW patch contract: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
