import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fingerprintArchives } from "../dist/code/gateway/DatasetFingerprint.js";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import {
  PatchStatusTracker, formatPatchStatusLine, patchGeneration as gatewayPatchGeneration, readPatchStatusChild,
  redactPatchReport,
} from "../dist/code/gateway/PatchStatus.js";
import {
  PATCH_STATUS_EXIT, formatPatchStatusReport, formatPatchSummaryLine, inspectLocalGateway, inspectPatchStatus,
  letteredPatches, patchGeneration, patchStatusExitCode, playersState, readBuildMarker, readPublication, tsAddonBlocks,
} from "../tools/patch-status.mjs";
import { repositoryRoot } from "../tools/paths.mjs";

const ORIGIN = "http://127.0.0.1:5173";

async function getJson(port, path, headers = { origin: ORIGIN }) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return { status: response.status, headers: response.headers, body };
}

/** Waits for a filesystem-watch-driven condition without sleeping a fixed amount. */
async function until(condition, what, timeoutMs = 3_000) {
  const started = Date.now();
  while (!await condition()) {
    if (Date.now() - started > timeoutMs) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function clientFixture() {
  const client = await mkdtemp(join(tmpdir(), "webclient-patch-status-"));
  const patch = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ");
  await mkdir(join(patch, "Tileset"), { recursive: true });
  await writeFile(join(patch, "Tileset", "One.blp"), "BLP-one");
  return { client, patch };
}

test("the offline tool and the gateway compute one patch generation", () => {
  const cases = [
    { archivesHash: "a1", chain: "c1", addons: [] },
    { archivesHash: undefined, chain: undefined, addons: [] },
    {
      archivesHash: "a2", chain: "c2",
      addons: [{ name: "Zeta", loadOnDemand: true }, { name: "alpha", loadOnDemand: false }],
    },
  ];
  for (const input of cases) assert.equal(patchGeneration(input), gatewayPatchGeneration(input));
  // Order-free over the add-on list, and sensitive to every input.
  assert.equal(
    gatewayPatchGeneration({ archivesHash: "a", chain: "c", addons: [{ name: "B", loadOnDemand: false }, { name: "a", loadOnDemand: true }] }),
    gatewayPatchGeneration({ archivesHash: "a", chain: "c", addons: [{ name: "a", loadOnDemand: true }, { name: "B", loadOnDemand: false }] }),
  );
  const base = gatewayPatchGeneration({ archivesHash: "a", chain: "c", addons: [] });
  assert.notEqual(base, gatewayPatchGeneration({ archivesHash: "b", chain: "c", addons: [] }));
  assert.notEqual(base, gatewayPatchGeneration({ archivesHash: "a", chain: "d", addons: [] }));
  assert.notEqual(base, gatewayPatchGeneration({ archivesHash: "a", chain: "c", addons: [{ name: "x", loadOnDemand: false }] }));
});

test("the tracker latches on the first change and memoises the child report per epoch", async () => {
  let now = 1_000;
  let reads = 0;
  let fail = false;
  const changes = [];
  const tracker = new PatchStatusTracker({
    archivesHash: "h", chain: "c", addons: [{ name: "A", loadOnDemand: false }],
    now: () => now,
    readDetails: async () => {
      reads++;
      if (fail) throw new Error("build still writing");
      return { schema: 1, summaryLine: `A(${reads})` };
    },
    onChange: (change) => changes.push(change),
    detailsTtlMs: 30_000,
  });
  assert.equal(tracker.generation, gatewayPatchGeneration({ archivesHash: "h", chain: "c", addons: [{ name: "A", loadOnDemand: false }] }));
  assert.deepEqual(
    { stale: tracker.summary().stale, changedAt: tracker.summary().changedAt, changes: tracker.summary().changes },
    { stale: false, changedAt: null, changes: 0 },
  );

  assert.equal((await tracker.details(1)).client.summaryLine, "A(1)");
  now += 10_000;
  assert.equal((await tracker.details(1)).client.summaryLine, "A(1)", "same epoch inside the TTL: no second child");
  assert.equal((await tracker.details(2)).client.summaryLine, "A(2)", "a new epoch reads again at once");
  now += 30_000;
  assert.equal((await tracker.details(2)).client.summaryLine, "A(3)", "the TTL covers the unwatched marker files");

  now = 50_000;
  tracker.noteArchivesChanged(3);
  now = 52_000;
  tracker.noteArchivesChanged(4);
  // Every request that waited on the walk of epoch 4 hears its answer: still one change.
  tracker.noteArchivesChanged(4);
  tracker.noteArchivesChanged(3);
  const summary = tracker.summary();
  assert.equal(summary.stale, true);
  assert.equal(summary.changedAt, new Date(50_000).toISOString(), "the latch time is the first change");
  assert.equal(summary.lastChangeAt, new Date(52_000).toISOString());
  assert.equal(summary.changes, 2);
  assert.equal(summary.generation, tracker.generation, "the generation is this process's, fixed for its life");
  assert.deepEqual(changes.map((change) => [change.first, change.epoch, change.changes]), [[true, 3, 1], [false, 4, 2]]);

  fail = true;
  const failed = await tracker.details(5);
  assert.equal(failed.client, null);
  assert.equal(failed.clientError, "build still writing");
  fail = false;
  now += 5_000;
  assert.equal((await tracker.details(5)).client.summaryLine, "A(5)", "a failure is remembered for five seconds only");

  assert.match(formatPatchStatusLine(await tracker.details(5)), /^Patches: generation [0-9a-f]{12} · A\(5\)$/);
  assert.match(formatPatchStatusLine(failed), /details unavailable: build still writing$/);
});

test("/client/patch-status answers through the latch, origin-checked and uncached", async () => {
  const { client, patch } = await clientFixture();
  const changes = [];
  let reads = 0;
  const addons = [{ name: "Foo", loadOnDemand: false }];
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [ORIGIN],
    clientDirectory: client,
    clientAddons: addons,
    // The watch has to notice the write, not the interval.
    datasetPollMs: 60_000,
    supervised: true,
    readPatchDetails: async () => {
      reads++;
      return { schema: 1, summaryLine: "A(1) · TSAddons 0" };
    },
    onClientPatchChange: (change) => changes.push(change),
  });
  try {
    const walk = await fingerprintArchives(client);
    const expected = gatewayPatchGeneration({ archivesHash: walk.hash, chain: walk.chain, addons });

    const summary = await getJson(gateway.port, "/client/patch-status?summary=1");
    assert.equal(summary.status, 200);
    assert.equal(summary.headers.get("cache-control"), "no-store");
    assert.equal(summary.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(summary.body.schema, 1);
    assert.equal(summary.body.generation, expected);
    assert.equal(summary.body.stale, false);
    assert.equal(summary.body.changedAt, null);
    assert.equal(summary.body.supervised, true);
    assert.deepEqual(summary.body.rootAddons, addons);
    assert.equal(summary.body.client, undefined, "the summary never runs the child");
    assert.equal(reads, 0);

    const full = await getJson(gateway.port, "/client/patch-status");
    assert.equal(full.body.client.summaryLine, "A(1) · TSAddons 0");
    await getJson(gateway.port, "/client/patch-status");
    assert.equal(reads, 1, "one child per epoch");

    assert.equal((await getJson(gateway.port, "/client/patch-status", {})).status, 403, "no Origin");
    assert.equal((await getJson(gateway.port, "/client/patch-status", { origin: "http://evil.test" })).status, 403);
    assert.deepEqual(gateway.connections(), { auth: 0, world: 0 });

    // A TSWoW build rewrites a file in the dev patch.
    await writeFile(join(patch, "Tileset", "One.blp"), "BLP-two-and-longer");
    await until(async () => (await getJson(gateway.port, "/client/addons")).status === 409, "the latch");
    const latched = await getJson(gateway.port, "/client/patch-status?summary=1");
    assert.equal(latched.status, 200, "the status route is exempt from the latch it reports");
    assert.equal(latched.body.stale, true);
    assert.equal(typeof latched.body.changedAt, "string");
    assert.equal(latched.body.generation, expected, "still the generation this process serves");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].first, true);
    assert.equal(gateway.patchSummary().stale, true);
    assert.equal((await getJson(gateway.port, "/client/patch-status")).body.stale, true);
    assert.equal(reads, 2, "the epoch moved, so the report was read again");
  } finally {
    await gateway.close();
    await rm(client, { recursive: true, force: true });
  }
});

test("an idle gateway latches a publish through checkPatchChain, with no request", async () => {
  const { client, patch } = await clientFixture();
  const changes = [];
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [ORIGIN],
    clientDirectory: client,
    datasetPollMs: 60_000,
    onClientPatchChange: (change) => changes.push(change),
  });
  try {
    assert.equal((await gateway.checkPatchChain()).stale, false);
    await writeFile(join(patch, "Tileset", "Two.blp"), "new file");
    await until(() => gateway.patchEventsPending, "the archive watch");
    const first = await gateway.checkPatchChain();
    assert.equal(first.stale, true);
    assert.deepEqual(changes.map((change) => [change.first, change.changes]), [[true, 1]]);
    assert.equal(gateway.patchEventsPending, false, "the walk consumed the event");

    await writeFile(join(patch, "Tileset", "Three.blp"), "another");
    await until(() => gateway.patchEventsPending, "the second write");
    await gateway.checkPatchChain();
    assert.deepEqual(changes.map((change) => [change.first, change.changes]), [[true, 1], [false, 2]]);
  } finally {
    await gateway.close();
    await rm(client, { recursive: true, force: true });
  }
});

test("one change seen by many requests sharing one walk is one change, told once", async () => {
  const { client, patch } = await clientFixture();
  const changes = [];
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [ORIGIN],
    clientDirectory: client,
    datasetPollMs: 60_000,
    onClientPatchChange: (change) => changes.push(change),
  });
  try {
    await writeFile(join(patch, "Tileset", "One.blp"), "BLP-two-and-longer");
    await until(() => gateway.patchEventsPending, "the archive watch");
    // The page's first burst after a publish: a dozen requests in flight on the one walk.
    const answers = await Promise.all(Array.from({ length: 12 }, () => getJson(gateway.port, "/client/patch-status?summary=1")));
    assert.ok(answers.every((answer) => answer.body.stale === true));
    assert.equal(changes.length, 1, "the supervisor hears one change, not one per waiting request");
    assert.equal(gateway.patchSummary().changes, 1);
    assert.equal(answers.at(-1).body.changes, 1);
  } finally {
    await gateway.close();
    await rm(client, { recursive: true, force: true });
  }
});

test("lettered patches are listed with kind, link target, file count and newest file", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-lettered-"));
  try {
    const client = join(root, "client");
    const data = join(client, "Data");
    const assets = join(root, "module-assets");
    await mkdir(join(data, "ruRU", "patch-ruRU-A.MPQ", "DBFilesClient"), { recursive: true });
    await mkdir(assets, { recursive: true });
    await writeFile(join(data, "ruRU", "patch-ruRU-A.MPQ", "DBFilesClient", "Spell.dbc"), "x");
    await writeFile(join(data, "ruRU", "patch-ruRU-A.MPQ", "readme.txt"), "y");
    await utimes(join(data, "ruRU", "patch-ruRU-A.MPQ", "readme.txt"), 1_700_000_000, 1_700_000_000);
    await utimes(join(data, "ruRU", "patch-ruRU-A.MPQ", "DBFilesClient", "Spell.dbc"), 1_700_000_100, 1_700_000_100);
    await writeFile(join(assets, "icon.blp"), "z");
    // TSWoW links a module's asset folder in as a letter (a junction on Windows).
    await symlink(assets, join(data, "ruRU", "patch-ruRU-C.MPQ"), "junction");
    await writeFile(join(data, "patch-A.MPQ"), Buffer.alloc(1234));
    await writeFile(join(data, "patch-B.MPQ"), "mpq");
    await writeFile(join(data, "common.MPQ"), "not lettered");
    await writeFile(join(data, "ruRU", "patch-ruRU-2.MPQ"), "numbered, not lettered");

    const patches = await letteredPatches(client);
    assert.deepEqual(patches.map((patch) => [patch.letter, patch.path, patch.kind]), [
      ["A", "patch-A.MPQ", "archive"],
      ["A", "ruRU\\patch-ruRU-A.MPQ", "directory"],
      ["B", "patch-B.MPQ", "archive"],
      ["C", "ruRU\\patch-ruRU-C.MPQ", "symlink"],
    ]);
    const [baseA, localeA, , linked] = patches;
    assert.equal(baseA.bytes, 1234);
    assert.equal(baseA.files, null);
    assert.equal(localeA.files, 2);
    assert.equal(localeA.newest, new Date(1_700_000_100 * 1000).toISOString());
    assert.equal(linked.files, 1);
    assert.equal(linked.target.toLowerCase(), assets.toLowerCase());
    assert.equal(linked.targetInInstall, null, "no install to be relative to");
    assert.equal(baseA.targetInInstall, null);
    // The route serves the target relative to the TSWoW install (`modules/<name>/assets`), never outside it.
    const inside = await letteredPatches(client, root);
    assert.equal(inside.find((patch) => patch.kind === "symlink").targetInInstall, "module-assets");
    const outside = await letteredPatches(client, join(root, "client"));
    assert.equal(outside.find((patch) => patch.kind === "symlink").targetInInstall, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only complete TSAddon blocks count, as in the browser boot", () => {
  const toc = [
    "## Interface: 30300",
    "## tsaddon-begin-lib",
    "RequireStub.lua",
    "## tsaddon-end-lib",
    "## tsaddon-begin: good",
    "TSAddons\\good\\addon.lua",
    "## tsaddon-end: good",
    "## tsaddon-begin: truncated",
    "TSAddons\\truncated\\addon.lua",
    "## tsaddon-begin: second",
    "TSAddons\\second\\a.lua",
    "TSAddons\\second\\b.lua",
    "## tsaddon-end: second",
    "## tsaddon-begin: mismatched",
    "TSAddons\\mismatched\\addon.lua",
    "## tsaddon-end: other",
  ].join("\r\n");
  const blocks = tsAddonBlocks(`﻿${toc}`);
  assert.deepEqual(blocks.map((block) => [block.name, block.lib, block.entries]), [
    ["__lib__", true, 1], ["good", false, 1], ["second", false, 2],
  ]);
  assert.match(blocks[1].blockSha1, /^[0-9a-f]{40}$/);
});

test("players are behind until a TSWoW or publisher publish covers the last build", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-publication-"));
  try {
    assert.deepEqual(await readBuildMarker(root), { file: join(root, "last-client-build.json"), marker: null });
    await writeFile(join(root, "last-client-build.json"), "{nope");
    assert.match((await readBuildMarker(root)).error, /not JSON/);
    const marker = { finishedAt: "2026-09-20T10:00:00.000Z", command: "build addon default.dataset", modules: ["x"], devPatch: "A", published: false };
    await writeFile(join(root, "last-client-build.json"), JSON.stringify(marker));
    assert.deepEqual((await readBuildMarker(root)).marker, marker);

    const patches = join(root, "patches");
    await mkdir(patches);
    assert.equal((await readPublication(patches)).present, false);
    const manifest = "WOWPATCH1\n";
    await writeFile(join(patches, "manifest.txt"), manifest);
    const sha = createHash("sha256").update(manifest).digest("hex");
    await writeFile(join(patches, "publication.json"), JSON.stringify({ publishedAt: "2026-09-20T11:00:00.000Z", manifestSha256: sha, counts: { files: 7 } }));
    const trusted = await readPublication(patches);
    assert.equal(trusted.trusted, true);
    assert.equal(trusted.files, 7);
    await writeFile(join(patches, "publication.json"), JSON.stringify({ publishedAt: "2026-09-20T11:00:00.000Z", manifestSha256: "0".repeat(64) }));
    const foreign = await readPublication(patches);
    assert.equal(foreign.trusted, false, "a publication.json of another manifest vouches for nothing");

    assert.equal(playersState(null, trusted), "unknown");
    assert.equal(playersState({ ...marker, published: true }, null), "published");
    assert.equal(playersState(marker, trusted), "published", "publish.bat updates publication.json, not the marker");
    assert.equal(playersState(marker, foreign), "behind");
    assert.equal(playersState({ ...marker, finishedAt: "2026-09-20T12:00:00.000Z" }, trusted), "behind");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the local gateway check tells current, latched, stale-by-generation, old and absent apart", async () => {
  const { client } = await clientFixture();
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [ORIGIN], clientDirectory: client, datasetPollMs: 60_000,
  });
  let addonsStatus = 409;
  const old = createServer((request, response) => {
    if (request.url === "/client/addons") {
      response.writeHead(addonsStatus, { "content-type": "application/json" });
      response.end(JSON.stringify(addonsStatus === 409 ? { error: "client_patch_chain_changed" } : { addons: [] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => old.listen(0, "127.0.0.1", resolve));
  try {
    const generation = gateway.patchSummary().generation;
    const current = await inspectLocalGateway({ port: gateway.port, origin: ORIGIN, generation });
    assert.deepEqual([current.running, current.supported, current.stale, current.current], [true, true, false, true]);
    const moved = await inspectLocalGateway({ port: gateway.port, origin: ORIGIN, generation: "f".repeat(40) });
    assert.deepEqual([moved.stale, moved.latched, moved.current], [true, false, false], "the disk moved on without a request yet");
    const refused = await inspectLocalGateway({ port: gateway.port, origin: "http://elsewhere.test", generation });
    assert.match(refused.error, /refused Origin/);

    const latchedOld = await inspectLocalGateway({ port: old.address().port, origin: ORIGIN, generation });
    assert.deepEqual([latchedOld.running, latchedOld.supported, latchedOld.stale], [true, false, true]);
    addonsStatus = 200;
    const quietOld = await inspectLocalGateway({ port: old.address().port, origin: ORIGIN, generation });
    assert.deepEqual([quietOld.supported, quietOld.stale], [false, false]);

    const closed = old.address().port;
    await new Promise((resolve) => old.close(resolve));
    const absent = await inspectLocalGateway({ port: closed, origin: ORIGIN, generation, timeoutMs: 1_000 });
    assert.deepEqual([absent.running, absent.stale], [false, false]);
  } finally {
    old.close();
    await gateway.close();
    await rm(client, { recursive: true, force: true });
  }
});

test("exit codes are bit flags", () => {
  const ok = { errors: [], players: "published", gateway: { stale: false } };
  assert.equal(patchStatusExitCode(ok), PATCH_STATUS_EXIT.ok);
  assert.equal(patchStatusExitCode({ ...ok, players: "behind" }), 4);
  assert.equal(patchStatusExitCode({ ...ok, gateway: { stale: true } }), 2);
  assert.equal(patchStatusExitCode({ ...ok, players: "behind", gateway: { stale: true } }), 6);
  assert.equal(patchStatusExitCode({ ...ok, players: "unknown", gateway: undefined }), 0);
  assert.equal(patchStatusExitCode({ ...ok, errors: ["no client"], gateway: { stale: true } }), 1);
});

async function installFixture() {
  const root = await mkdtemp(join(tmpdir(), "webclient-patch-report-"));
  const client = join(root, "client");
  const frameXml = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", "Interface", "FrameXML");
  const install = join(root, "tswow-install");
  const dataset = join(install, "modules", "default", "datasets", "dataset");
  await mkdir(join(frameXml, "TSAddons", "demo", "addon"), { recursive: true });
  await mkdir(join(install, "modules", "demo", "addon", "build"), { recursive: true });
  // A new module with addon sources that `build addon` has not delivered yet (minimap-hub today).
  await mkdir(join(install, "modules", "pending", "addon"), { recursive: true });
  await writeFile(join(install, "modules", "pending", "addon", "addon.ts"), "export {};");
  await writeFile(join(install, "modules", "pending", "addon", "global.d.ts"), "");
  await mkdir(join(install, "modules", "typings-only", "addon"), { recursive: true });
  await writeFile(join(install, "modules", "typings-only", "addon", "global.d.ts"), "");
  await mkdir(dataset, { recursive: true });
  await writeFile(join(frameXml, "FrameXML.toc"), [
    "## Interface: 30300", "UIParent.xml",
    "## tsaddon-begin: demo", "TSAddons\\demo\\addon\\addon.lua", "## tsaddon-end: demo",
  ].join("\n"));
  const copied = join(frameXml, "TSAddons", "demo", "addon", "addon.lua");
  const built = join(install, "modules", "demo", "addon", "build", "addon.lua");
  await writeFile(copied, "-- copied");
  await writeFile(built, "-- rebuilt");
  await utimes(copied, 1_700_000_000, 1_700_000_000);
  await utimes(built, 1_700_000_600, 1_700_000_600);
  await writeFile(join(dataset, "last-client-build.json"), JSON.stringify({
    finishedAt: "2026-09-20T10:00:00.000Z", command: "build addon default.dataset", modules: ["demo"], devPatch: "A", published: false,
  }));
  return { root, client, install, dataset };
}

test("the report reads the winning TOC, flags a module built but not copied, and says players are behind", async () => {
  const fixture = await installFixture();
  try {
    const report = await inspectPatchStatus({
      client: fixture.client, dataset: fixture.dataset, install: fixture.install, gateway: false,
    });
    assert.deepEqual(report.errors, []);
    assert.equal(report.frameXmlToc.source, "patch-ruRU-A.MPQ");
    assert.deepEqual(report.tsAddons.map((addon) => [addon.name, addon.patchFiles, addon.notCopied]), [["demo", 1, true]]);
    assert.deepEqual(report.addonsNotInToc, [{ name: "pending", built: false }], "typings alone are not a module's addon");
    assert.equal(report.players, "behind");
    assert.match(report.generation, /^[0-9a-f]{40}$/);
    assert.equal(report.summaryLine, formatPatchSummaryLine(report));
    assert.match(report.summaryLine, /^A\(2\) · TSAddons 1: demo · built but not copied: demo · not in the TOC yet: pending · last build .*, players behind$/);
    assert.equal(patchStatusExitCode(report), PATCH_STATUS_EXIT.playersBehind);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("`--json --no-gateway` prints exactly one JSON document, StormLib's chatter kept off stdout", async () => {
  const fixture = await installFixture();
  try {
    const run = (args) => spawnSync(process.execPath, [join(repositoryRoot, "tools", "patch-status.mjs"), ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        WEBCLIENT_SKIP_ENV: "1",
        CLIENT_DIR: fixture.client,
        TSWOW_INSTALL: fixture.install,
        TSWOW_DATASET: fixture.dataset,
      },
      timeout: 60_000,
    });
    const result = run(["--json", "--no-gateway"]);
    assert.equal(result.status, PATCH_STATUS_EXIT.playersBehind, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schema, 1);
    assert.equal(report.gateway, undefined);
    assert.deepEqual(report.tsAddons.map((addon) => addon.name), ["demo"]);
    assert.doesNotMatch(result.stdout, /StormLib|Heap resize/);

    const bad = run(["--jsn"]);
    assert.equal(bad.status, PATCH_STATUS_EXIT.error);
    assert.match(bad.stderr, /Unknown argument\(s\): --jsn/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the gateway's child runner takes the report on stdout and explains a child that had none", async () => {
  const fixture = await installFixture();
  try {
    const env = {
      ...process.env,
      WEBCLIENT_SKIP_ENV: "1",
      CLIENT_DIR: fixture.client,
      TSWOW_INSTALL: fixture.install,
      TSWOW_DATASET: fixture.dataset,
    };
    // Exit 4 (players behind) is a verdict, not a failure: the document decides.
    const report = await readPatchStatusChild({ script: join(repositoryRoot, "tools", "patch-status.mjs"), cwd: repositoryRoot, env });
    assert.equal(report.schema, 1);
    assert.match(report.summaryLine, /TSAddons 1: demo/);
    // What leaves the gateway carries letters, counts and times, not where things live on disk.
    const text = JSON.stringify(report);
    assert.ok(!text.includes(JSON.stringify(fixture.root).slice(1, -1)), "no absolute fixture path in the served report");
    assert.equal(report.clientDirectory, undefined);
    assert.equal(report.build.file, undefined);
    assert.equal(report.build.finishedAt, "2026-09-20T10:00:00.000Z");
    assert.equal(report.lettered[0].path, "ruRU\\patch-ruRU-A.MPQ", "the Data-relative path stays");

    const broken = join(fixture.root, "broken.mjs");
    await writeFile(broken, [
      "console.log('Initialized StormLib in debug mode');",
      "console.error('Initialized StormLib in debug mode');",
      "console.error('the client drive went away');",
      "console.error('Heap resize call from 1 to 2 took 0.1 msecs. Success: true');",
      "process.exitCode = 1;",
    ].join("\n"));
    await assert.rejects(
      readPatchStatusChild({ script: broken, cwd: repositoryRoot, env }),
      (error) => error.message === "the client drive went away",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

/** Every string anywhere in `value`. */
function strings(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const entry of value) strings(entry, found);
  else if (value && typeof value === "object") for (const entry of Object.values(value)) strings(entry, found);
  return found;
}

const MACHINE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\\\\[^\\\s]+\\/;

test("what leaves the gateway names modules and errors, never where they live on disk", async () => {
  const report = {
    schema: 1,
    clientDirectory: "F:\\Circle",
    lettered: [{
      letter: "B", path: "ruRU\\patch-ruRU-B.MPQ", kind: "symlink",
      target: "F:\\tswowRoot\\tswow-install\\modules\\baja-echoes\\assets",
      targetInInstall: "modules/baja-echoes/assets", newest: "2026-09-20T10:00:00.000Z",
    }],
    errors: ["the MPQ chain could not be read: C:\\Users\\x\\AppData\\Local\\Temp\\c\\Data does not exist"],
    generationError: "the client patch chain could not be walked: ENOENT: no such file or directory, scandir 'C:\\Program Files\\Circle\\Data'",
    buildError: "is not JSON: Unexpected token n in JSON at position 1",
    buildFile: "F:\\tswowRoot\\tswow-install\\modules\\default\\datasets\\dataset\\last-client-build.json",
    publication: { file: "\\\\nas\\share\\patches\\publication.json", present: true, error: "cannot be read: EACCES '\\\\nas\\share\\patches\\publication.json'" },
    summaryLine: "A(805) B(41) · TSAddons 1: demo · last build 2026-09-20 10:00, players behind",
    note: "asked http://127.0.0.1:8090/client/patch-status",
  };
  const check = (served) => {
    for (const text of strings(served)) assert.doesNotMatch(text, MACHINE_PATH, text);
    assert.doesNotMatch(JSON.stringify(served), /Program Files|AppData|tswowRoot|nas/);
    assert.equal(served.lettered[0].target, undefined);
    assert.equal(served.lettered[0].targetInInstall, "modules/baja-echoes/assets", "which module a linked letter is");
    assert.equal(served.errors[0], "the MPQ chain could not be read: <path> does not exist", "the words stay");
    assert.match(served.generationError, /scandir '<path>'$/);
    assert.equal(served.buildError, report.buildError);
    assert.equal(served.summaryLine, report.summaryLine);
    assert.equal(served.note, report.note, "a URL is not a drive path");
    assert.equal(served.lettered[0].newest, "2026-09-20T10:00:00.000Z");
  };
  check(redactPatchReport(report));

  // And through the child runner the gateway actually uses.
  const root = await mkdtemp(join(tmpdir(), "webclient-patch-redact-"));
  try {
    const stub = join(root, "stub.mjs");
    await writeFile(stub, `process.stdout.write(${JSON.stringify(JSON.stringify(report))} + "\\n");`);
    check(await readPatchStatusChild({ script: stub, cwd: repositoryRoot, env: process.env }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a client that cannot be walked is not blamed on the build, and a bad marker keeps its path local", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-patch-errors-"));
  try {
    const client = join(root, "client");
    const dataset = join(root, "dataset");
    await mkdir(client);
    await mkdir(dataset);
    await writeFile(join(dataset, "last-client-build.json"), "{half-written");
    const report = await inspectPatchStatus({ client, dataset, install: join(root, "install"), gateway: false });
    assert.match(report.generationError, /^the client patch chain could not be walked: /);
    assert.doesNotMatch(report.generationError, /build the WebClient/, "the dist code loaded; the client is what is missing");
    assert.match(report.buildError, /^is not JSON: /);
    assert.ok(!report.buildError.includes(root), "the served text has no path; buildFile carries it");
    const lines = formatPatchStatusReport(report);
    assert.ok(lines.some((line) => line.includes(join(dataset, "last-client-build.json")) && line.includes("is not JSON")),
      "the local CLI still says which file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
