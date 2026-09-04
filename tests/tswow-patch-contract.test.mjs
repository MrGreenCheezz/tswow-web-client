import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  classifyDatasetDbcWinner,
  inspectFrameXmlClientNetworkRuntime,
  inspectManifestPayloads,
  inspectManifestRuntime,
  inspectRuntimePatchAlignment,
  parseDefaultClient,
  parseDatasetPatchConfig,
  parsePatchPublisher,
  parseWowPatchManifest,
  selectEffectiveDatasetClient,
} from "../tools/tswow-patch-contract.mjs";

test("TSAddon runtime audit executes the compiled ClientNetwork bridge, not a marker string", async () => {
  const compiled = await inspectFrameXmlClientNetworkRuntime();
  assert.equal(compiled.ok, true, compiled.message);
  assert.equal(compiled.capability, "tswow-client-network-v1");
  assert.match(compiled.message, /outbound, inbound and lifecycle probes/);

  // Dynamic ESM import canonicalizes every parent. The Windows temp path may use an 8.3 alias
  // outside the workspace sandbox, so keep this executable fixture inside the repository.
  const root = await mkdtemp(join(process.cwd(), ".client-network-capability-"));
  const markerOnly = join(root, "marker-only.mjs");
  try {
    await writeFile(markerOnly,
      'export const FRAME_XML_CLIENT_NETWORK_CAPABILITY = "tswow-client-network-v1";\n');
    const rejected = await inspectFrameXmlClientNetworkRuntime(markerOnly);
    assert.equal(rejected.ok, false);
    assert.match(rejected.message, /exports no executable ClientNetwork capability probe/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TSWoW dataset patch settings select the locale development patch", () => {
  const config = parseDatasetPatchConfig([
    "Dataset.GameBuild = 12340",
    'Client.DevPatchLetter = "C"',
    "Client.Patch.UseLocale = true",
    'Client.Path = "clients/dataset"',
    'Package.Mapping = ["A.MPQ:*"]',
    'Client.Patches = ["all"]',
  ].join("\n"));
  assert.deepEqual(config, {
    build: 12340,
    letter: "C",
    useLocale: true,
    clientPath: "clients/dataset",
    mapping: '["A.MPQ:*"]',
    binaryPatches: '["all"]',
  });
  assert.equal(parsePatchPublisher('Launcher.PatchPublisher = "F:\\\\patcher\\\\publish.mjs"'),
    "F:\\\\patcher\\\\publish.mjs");
  assert.equal(parseDefaultClient('Default.Client = "F:\\\\Circle"'), "F:\\\\Circle");
});

test("dataset Client.Path overrides Default.Client and relative paths use the install root", () => {
  const installRoot = join(tmpdir(), "tswow-install");
  assert.deepEqual(selectEffectiveDatasetClient({
    clientPath: "clients/dataset",
    defaultClient: "clients/default",
    installRoot,
  }), {
    configured: "clients/dataset",
    path: resolve(installRoot, "clients/dataset"),
    source: "dataset.conf Client.Path",
  });
  assert.deepEqual(selectEffectiveDatasetClient({
    clientPath: "   ",
    defaultClient: "clients/default",
    installRoot,
  }), {
    configured: "clients/default",
    path: resolve(installRoot, "clients/default"),
    source: "node.conf Default.Client",
  });
});

test("active dataset DBC winners use byte identity and arbitrary letter/locale media provenance", () => {
  const common = {
    clientMediaTables: ["CharSections", "EmotesTextSound"],
    clientMediaSources: ["patch-ruRU-G.MPQ"],
  };
  assert.deepEqual(classifyDatasetDbcWinner({
    ...common, name: "Spell.dbc", source: "PATCH-RURU-A.MPQ", equal: true,
  }), { level: "ok", kind: "active-match" });
  assert.deepEqual(classifyDatasetDbcWinner({
    ...common, name: "Spell.dbc", source: undefined, equal: false,
  }), { level: "error", kind: "missing" });
  assert.deepEqual(classifyDatasetDbcWinner({
    ...common, name: "CharSections.dbc", source: "patch-ruRU-G.MPQ", equal: false,
  }), { level: "warning", kind: "client-media" });
  assert.deepEqual(classifyDatasetDbcWinner({
    ...common, name: "CharSections.dbc", source: "patch-V.MPQ", equal: false,
  }), { level: "warning", kind: "client-media" });
  assert.deepEqual(classifyDatasetDbcWinner({
    ...common, name: "CharSections.dbc", source: "common.MPQ", equal: false,
  }), { level: "error", kind: "unexpected-override" });
  assert.deepEqual(classifyDatasetDbcWinner({
    ...common, name: "CreatureFamily.dbc", source: "patch-ruRU-G.MPQ", equal: false,
  }), { level: "warning", kind: "creature-family" });
  assert.deepEqual(classifyDatasetDbcWinner({
    ...common, name: "CreatureFamily.dbc", source: "patch-X.MPQ", equal: false,
  }), { level: "error", kind: "unexpected-override" });
  assert.deepEqual(classifyDatasetDbcWinner({
    ...common, name: "Spell.dbc", source: "patch-E.MPQ", equal: true,
  }), { level: "ok", kind: "active-match" });
  assert.deepEqual(classifyDatasetDbcWinner({
    ...common, name: "Spell.dbc", source: "patch-ruRU-A.MPQ", equal: false,
  }), { level: "error", kind: "unexpected-override" });
});

test("WOWPATCH1 rows retain the hash, size, safe relative path and URL", () => {
  const hash = "ab".repeat(32);
  const manifest = (path) => [
    "WOWPATCH1",
    `${hash}\t4\t${path}\thttps://patch.test/files/Test.lua`,
  ].join("\n");
  const entries = parseWowPatchManifest([
    "\uFEFFWOWPATCH1",
    "# publisher comment",
    "",
    `${hash}\t4\tData/ruRU/patch-ruRU-A.MPQ/Test.lua\thttps://patch.test/files/Test.lua`,
    "",
  ].join("\n"));
  assert.deepEqual(entries, [{
    sha256: hash,
    size: 4,
    path: "Data/ruRU/patch-ruRU-A.MPQ/Test.lua",
    url: "https://patch.test/files/Test.lua",
  }]);
  for (const unsafe of [
    "C:\\Data\\patch.mpq",
    "/Data/patch.mpq",
    "\\\\server\\share\\patch.mpq",
    "Data/file.lua:stream",
    "Data/./file.lua",
    "Data/../file.lua",
    "Data//file.lua",
    "Data/file.lua.",
    "Data/file.lua ",
    "Data/CON",
    "Data/prn.txt",
    "Data/COM1.dll",
    "Data/LPT9",
    "Data/CONIN$.txt",
    "Data/conout$",
    `Data/${"a".repeat(256)}`,
    "Data/bad<name>.lua",
  ]) {
    assert.throws(() => parseWowPatchManifest(manifest(unsafe)), /Invalid patch path/, unsafe);
  }
  assert.throws(() => parseWowPatchManifest([
    "WOWPATCH1",
    `${hash}\t4\tData/Patches/File.lua\thttps://patch.test/files/one`,
    `${hash}\t4\tdata\\patches\\FILE.LUA\thttps://patch.test/files/two`,
  ].join("\n")), /Invalid patch path.*duplicate/);
});

test("WOWPATCH1 matches native header, size, URL and protected-file rules", () => {
  const hash = "cd".repeat(32);
  const manifest = (size, path = "Data/file.bin", url = "https://patch.test/file.bin") => [
    "WOWPATCH1",
    `${hash}\t${size}\t${path}\t${url}`,
  ].join("\n");

  assert.throws(() => parseWowPatchManifest(` WOWPATCH1\n`), /exact WOWPATCH1 header/);
  assert.throws(() => parseWowPatchManifest(`WOWPATCH1 \n`), /exact WOWPATCH1 header/);
  for (const size of ["", "+1", "-1", "1e3", "9007199254740992"]) {
    assert.throws(() => parseWowPatchManifest(manifest(size)), /Invalid patch size/, size);
  }
  assert.equal(parseWowPatchManifest(manifest("0004"))[0].size, 4);

  for (const url of [
    "ftp://patch.test/file.bin",
    "file:///Data/file.bin",
    "/relative/file.bin",
    "https:/patch.test/file.bin",
    " https://patch.test/file.bin",
  ]) {
    assert.throws(() => parseWowPatchManifest(manifest("4", "Data/file.bin", url)),
      /Invalid patch URL/, url);
  }
  assert.equal(parseWowPatchManifest(manifest("4", "Data/file.bin", "HTTP://patch.test/file.bin"))[0].url,
    "HTTP://patch.test/file.bin");

  for (const protectedFile of [
    "Wow.exe",
    "WOW.EXE.WOWPATCHER-BACKUP",
    "WowPatcher.exe",
    "WowPatcher.ini",
    "wowpatcher-hook.dll",
    "WowPatcherInstall.exe",
  ]) {
    assert.throws(() => parseWowPatchManifest(manifest("4", protectedFile)),
      /Invalid patch path/, protectedFile);
  }
  assert.equal(parseWowPatchManifest(manifest("4", "Data/Wow.exe")).length, 1,
    "the native guard protects these names only at the client root");
});

test("WOWPATCH1 enforces the native manifest byte and entry caps", () => {
  assert.throws(() => parseWowPatchManifest(`WOWPATCH1\n#${"x".repeat(4 * 1024 * 1024)}`),
    /exceeds 4 MiB/);

  const hash = "ef".repeat(32);
  const rows = Array.from({ length: 50_001 }, (_, index) =>
    `${hash}\t0\tf${index.toString(36)}\thttp://a`);
  const manifest = ["WOWPATCH1", ...rows].join("\n");
  assert.ok(Buffer.byteLength(manifest, "utf8") <= 4 * 1024 * 1024,
    "the entry-cap fixture must reach the native row limit before the byte limit");
  assert.throws(() => parseWowPatchManifest(manifest), /more than 50000 entries/);
});

test("published files are checked independently against every manifest payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-patch-payload-"));
  const manifestFile = join(root, "manifest.txt");
  const payloadDirectory = join(root, "files", "Data");
  const payload = join(payloadDirectory, "patch-A.MPQ");
  const source = [
    "WOWPATCH1",
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\t3\tData/patch-A.MPQ\thttps://patch.test/Data/patch-A.MPQ",
  ].join("\n");
  try {
    await mkdir(payloadDirectory, { recursive: true });
    await Promise.all([writeFile(manifestFile, source), writeFile(payload, "abc")]);
    const entries = parseWowPatchManifest(source);
    const valid = await inspectManifestPayloads(entries, manifestFile);
    assert.deepEqual(valid.payloadMissing, []);
    assert.deepEqual(valid.payloadDifferent, []);

    await rm(payload);
    const missing = await inspectManifestPayloads(entries, manifestFile);
    assert.deepEqual(missing.payloadMissing, ["Data/patch-A.MPQ"]);
    assert.deepEqual(missing.payloadDifferent, []);

    await writeFile(payload, "abd");
    const changed = await inspectManifestPayloads(entries, manifestFile);
    assert.deepEqual(changed.payloadMissing, []);
    assert.deepEqual(changed.payloadDifferent, ["Data/patch-A.MPQ"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-patch manifest entries are checked against the installed native runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-native-runtime-"));
  const runtimeFile = join(root, "Utils", "runtime.dll");
  const source = [
    "WOWPATCH1",
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\t3\tUtils/runtime.dll\thttps://patch.test/Utils/runtime.dll",
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\t3\tData/patch-A.MPQ/file.bin\thttps://patch.test/Data/patch-A.MPQ/file.bin",
  ].join("\n");
  try {
    await mkdir(join(root, "Utils"), { recursive: true });
    await writeFile(runtimeFile, "abc");
    const entries = parseWowPatchManifest(source);
    const valid = await inspectManifestRuntime(entries, root);
    assert.equal(valid.runtimeCount, 1, "lettered patch payloads are not native runtime files");
    assert.deepEqual(valid.runtimeMissing, []);
    assert.deepEqual(valid.runtimeDifferent, []);

    await rm(runtimeFile);
    const missing = await inspectManifestRuntime(entries, root);
    assert.deepEqual(missing.runtimeMissing, ["Utils/runtime.dll"]);

    await writeFile(runtimeFile, "abd");
    const changed = await inspectManifestRuntime(entries, root);
    assert.deepEqual(changed.runtimeMissing, []);
    assert.deepEqual(changed.runtimeDifferent, ["Utils/runtime.dll"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the gateway guard validates the real A-Z/locale winner instead of only DevPatchLetter", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-tswow-contract-"));
  const client = join(root, "client");
  const dataset = join(root, "dataset");
  const patch = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ");
  const patchDbc = join(patch, "DBFilesClient");
  const datasetDbc = join(dataset, "dbc");
  try {
    await Promise.all([
      mkdir(patchDbc, { recursive: true }),
      mkdir(datasetDbc, { recursive: true }),
    ]);
    await writeFile(join(dataset, "dataset.conf"), [
      'Client.DevPatchLetter = "A"',
      "Client.Patch.UseLocale = true",
    ].join("\n"));
    await writeFile(join(datasetDbc, "Spell.dbc"), "WDBC-current");
    await writeFile(join(patchDbc, "Spell.dbc"), "WDBC-current");

    const aligned = await inspectRuntimePatchAlignment({
      clientDirectory: client,
      datasetDirectory: dataset,
      dbcDirectory: datasetDbc,
      locale: "ruRU",
      anchors: ["Spell.dbc"],
    });
    assert.equal(aligned.ok, true);
    assert.equal(aligned.checked, 1);
    assert.equal(aligned.winners[0].source, "patch-ruRU-A.MPQ");
    assert.match(aligned.expectedPatch, /Data[\\/]ruRU[\\/]patch-ruRU-A\.MPQ$/,
      "the WoW locale casing must stay ruRU rather than title-case ruRu");

    const latePatch = join(client, "Data", "ruRU", "patch-ruRU-G.MPQ");
    const latePatchDbc = join(latePatch, "DBFilesClient");
    await mkdir(latePatchDbc, { recursive: true });
    await writeFile(join(latePatchDbc, "Spell.dbc"), "WDBC-current");
    const lateAligned = await inspectRuntimePatchAlignment({
      clientDirectory: client,
      datasetDirectory: dataset,
      dbcDirectory: datasetDbc,
      locale: "ruRU",
      anchors: ["Spell.dbc"],
    });
    assert.equal(lateAligned.ok, true);
    assert.equal(lateAligned.winners[0].source, "patch-ruRU-G.MPQ",
      "the later locale patch must be the audited winner even though DevPatchLetter stays A");

    await writeFile(join(latePatchDbc, "Spell.dbc"), "WDBC-late-mismatch");
    const lateMismatch = await inspectRuntimePatchAlignment({
      clientDirectory: client,
      datasetDirectory: dataset,
      dbcDirectory: datasetDbc,
      locale: "ruRU",
      anchors: ["Spell.dbc"],
    });
    assert.equal(lateMismatch.ok, false);
    assert.match(lateMismatch.errors.join("\n"), /Spell\.dbc differs.*patch-ruRU-G\.MPQ/);

    await rm(latePatch, { recursive: true, force: true });
    const distributedPatch = join(client, "Data", "patch-B.MPQ");
    const distributedPatchDbc = join(distributedPatch, "DBFilesClient");
    await mkdir(distributedPatchDbc, { recursive: true });
    await writeFile(join(distributedPatchDbc, "Spell.dbc"), "WDBC-current");
    await rm(patch, { recursive: true, force: true });
    const distributed = await inspectRuntimePatchAlignment({
      clientDirectory: client,
      datasetDirectory: dataset,
      dbcDirectory: datasetDbc,
      locale: "ruRU",
      anchors: ["Spell.dbc"],
    });
    assert.equal(distributed.ok, true,
      "a Package.Mapping-style DBC package may legitimately use another root patch letter");
    assert.equal(distributed.winners[0].source, "patch-B.MPQ");
    assert.match(distributed.warnings.join("\n"), /Configured development patch is missing/);

    await rm(distributedPatch, { recursive: true, force: true });
    await writeFile(patch, Buffer.from("MPQ\u001a-test"));
    const archived = await inspectRuntimePatchAlignment({
      clientDirectory: client,
      datasetDirectory: dataset,
      dbcDirectory: datasetDbc,
      locale: "ruRU",
      anchors: ["Spell.dbc"],
    });
    assert.equal(archived.ok, false, "a file-backed MPQ cannot silently bypass the startup guard");
    assert.equal(archived.kind, "archive");
    assert.equal(archived.checked, 0);
    assert.match(archived.errors.join("\n"),
      /unreadable source|no readable active client source|No archive .* could be opened/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
