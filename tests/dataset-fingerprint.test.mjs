import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DatasetFingerprint, fingerprintArchives, fingerprintDbc } from "../dist/code/gateway/DatasetFingerprint.js";
import { publishSound } from "../tools/generate-sound.mjs";
import { openClientArchives } from "../tools/mpq.mjs";
import { repositoryRoot } from "../tools/paths.mjs";
import {
  removeStampsUnder, sourceStamp, stampGenerated, stampIsCurrent, stampSidecar, writeSourceStamp,
} from "../tools/source-stamp.mjs";

// The dataset and the client are what the cost is measured against, and not every machine has them.
let dbcDirectory;
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  dbcDirectory = paths.dbcDirectory();
  clientDirectory = paths.clientDirectory();
} catch {
  dbcDirectory = undefined;
  clientDirectory = undefined;
}
const withDataset = { skip: dbcDirectory && clientDirectory ? false : "no tswow dataset on this machine" };

/** A client tree with one loose patch directory, which is how tswow ships a module's assets. */
async function looseClient(files) {
  const client = await mkdtemp(join(tmpdir(), "webclient-fingerprint-"));
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", ...path.split("\\"));
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents);
  }
  return client;
}

test("the fingerprint is the same twice over an unchanged tree and different after one byte", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-dbc-print-"));
  try {
    await writeFile(join(directory, "Spell.dbc"), "WDBC-one");
    await writeFile(join(directory, "Map.dbc"), "WDBC-two");
    const first = await fingerprintDbc(directory);
    assert.equal(first.files, 2);
    assert.equal((await fingerprintDbc(directory)).hash, first.hash, "reading the same tree twice must agree");

    // Same length, one byte different: a fingerprint that only compared sizes would miss this, and
    // a rebuilt DBC is very often exactly the same length as the one it replaces.
    //
    // The timestamp is moved by hand rather than left to the write. `mtimeMs` steps by about 1 ms
    // on this machine, and a same-length rewrite of an 8-byte file lands inside the same step: it
    // left the mtime identical in 29 of 40 tries, and replaying this test's own sequence 300 times
    // failed 51 of them on an idle machine. That was the clock being tested, not the fingerprint.
    const before = await stat(join(directory, "Spell.dbc"));
    await writeFile(join(directory, "Spell.dbc"), "WDBC-owo");
    await utimes(join(directory, "Spell.dbc"), before.atime, new Date(before.mtimeMs + 1_000));
    const second = await fingerprintDbc(directory);
    assert.equal((await stat(join(directory, "Spell.dbc"))).size, before.size, "the size must not be what changed");
    assert.notEqual(second.hash, first.hash, "one changed byte has to change the fingerprint");

    // And a table a module added is a change too, not just a table it edited.
    await writeFile(join(directory, "Custom.dbc"), "WDBC-new");
    const third = await fingerprintDbc(directory);
    assert.notEqual(third.hash, second.hash);
    assert.equal(third.files, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the dumps beside the dataset are watched too", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-dbc-print-"));
  try {
    const dump = join(directory, "items.json");
    await writeFile(dump, "[]");
    const first = await fingerprintDbc(undefined, [dump]);
    await writeFile(dump, "[[1,\"\",0,0,0,0,0]]");
    assert.notEqual((await fingerprintDbc(undefined, [dump])).hash, first.hash);
    // A file that is not there is not a change: a machine without the dumps must not look like a
    // machine whose dumps are being rewritten on every request.
    assert.equal((await fingerprintDbc(undefined, [join(directory, "absent.json")])).hash,
      (await fingerprintDbc(undefined, [])).hash);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the archive fingerprint sees a file appear inside a patch directory", async () => {
  const client = await looseClient({ "DBFilesClient\\Spell.dbc": "one" });
  try {
    const first = await fingerprintArchives(client);
    assert.equal(first.files, 1);
    assert.deepEqual([...first.loose.keys()], ["patch-ruru-a.mpq"]);
    assert.ok(first.loose.get("patch-ruru-a.mpq").has("dbfilesclient\\spell.dbc"),
      "the overlay's paths are keyed the way MPQ paths compare");

    await writeFile(join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", "DBFilesClient", "Item.dbc"), "two");
    const second = await fingerprintArchives(client);
    assert.notEqual(second.hash, first.hash);
    // The composition did not change: the same one directory is still the whole chain. That is the
    // difference between "a module edited its content" and "a module was installed", and only the
    // second one can change which source wins a path that was already cached.
    assert.equal(second.chain, first.chain);
  } finally {
    await rm(client, { recursive: true, force: true });
  }
});

test("the gateway computes the same chain digest as the archive chain itself", async () => {
  // Two implementations of one rule — `tools/mpq.mjs` ranks and opens the chain, the gateway only
  // walks it — and a stamp is compared across them. If they drift the stamps never match and every
  // cache entry regenerates on every epoch, so the agreement is pinned here.
  const client = await looseClient({ "DBFilesClient\\Spell.dbc": "one" });
  try {
    const chain = await openClientArchives(client);
    try {
      assert.equal((await fingerprintArchives(client)).chain, chain.chainDigest());
    } finally {
      chain.close();
    }
  } finally {
    await rm(client, { recursive: true, force: true });
  }
});

test("a source stamp names the file that won the path, and its size and mtime", async () => {
  const client = await looseClient({ "Tileset\\Test.blp": "BLP2-one" });
  const chain = await openClientArchives(client);
  try {
    const stamp = await sourceStamp(chain, { paths: ["Tileset\\Test.blp"] });
    assert.equal(stamp.sources.length, 1);
    const [source] = stamp.sources;
    assert.equal(source.name, "patch-ruRU-A.MPQ");
    assert.equal(source.kind, "directory");
    const stats = await stat(source.file);
    assert.equal(source.size, stats.size);
    assert.equal(source.mtimeMs, stats.mtimeMs);
    assert.deepEqual(source.above, [], "nothing outranks the only overlay there is");
    assert.equal(stamp.chain, chain.chainDigest());
  } finally {
    chain.close();
    await rm(client, { recursive: true, force: true });
  }
});

test("a stamped cache entry is dropped when its source changes, and kept when it does not", async () => {
  const client = await looseClient({ "Tileset\\Test.blp": "BLP2-one" });
  const cache = await mkdtemp(join(tmpdir(), "webclient-cache-"));
  const chain = await openClientArchives(client);
  try {
    const entry = join(cache, "texture.png");
    await writeFile(entry, "PNG-one");
    await writeSourceStamp(entry, await sourceStamp(chain, { paths: ["Tileset\\Test.blp"] }));

    const fingerprint = new DatasetFingerprint({ clientDirectory: client, intervalMs: 0 });
    await fingerprint.poll();
    await fingerprint.ensureCurrent(entry);
    assert.equal((await readFile(entry, "utf8")), "PNG-one", "an entry whose source is untouched stays");

    // Replaced, the way a module replaces a stock texture: same path, different bytes.
    await writeFile(join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", "Tileset", "Test.blp"), "BLP2-two-longer");
    await fingerprint.poll();
    await fingerprint.ensureCurrent(entry);
    await assert.rejects(readFile(entry), "the entry built from the old file has to go");
    await assert.rejects(readFile(stampSidecar(entry)), "and its stamp with it");
  } finally {
    chain.close();
    await rm(cache, { recursive: true, force: true });
    await rm(client, { recursive: true, force: true });
  }
});

test("an entry with no stamp beside it is served exactly as it stands", async () => {
  // Everything already under `data/` was written before stamps existed — 23,025 of the 24,796
  // published files on this machine, 21,068 of them item icons — and none of it can say what it
  // was built from. This used to ask for each of them to be rebuilt once so that it gained one,
  // which is one child process per entry on that family's serial lane: measured over sixteen
  // already-published, already-correct ground textures, 5,749 ms and 345 to 373 ms each, against
  // 125 ms and no process at all for the same sixteen served as they stand. `tools/restamp.mjs`
  // derives the same stamps in one pass — 21,513 of them in 6,297 ms — so there is nothing left
  // for the request path to do about it.
  const cache = await mkdtemp(join(tmpdir(), "webclient-cache-"));
  try {
    const entry = join(cache, "legacy.png");
    await writeFile(entry, "PNG-legacy");
    const before = await stat(entry);
    const fingerprint = new DatasetFingerprint({ dbcDirectory: cache, intervalMs: 0 });
    await fingerprint.poll();

    await fingerprint.ensureCurrent(entry);
    assert.equal(await readFile(entry, "utf8"), "PNG-legacy", "an unstamped entry is served untouched");
    assert.equal((await stat(entry)).mtimeMs, before.mtimeMs, "and not rewritten either");
    await assert.rejects(readFile(stampSidecar(entry)), "nothing here invents a stamp for it");

    // Kept rather than dropped: an entry nothing can vouch for is still the only answer the route
    // has, and deleting it turns a picture that probably works into a hole.
    await fingerprint.ensureCurrent(entry);
    assert.equal(await readFile(entry, "utf8"), "PNG-legacy");
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test("an entry is not dropped by a client that is not there to be compared", async () => {
  // `main.ts` warns and carries on when there is no client: the dataset still answers everything a
  // DBC can answer. The cache under `data/` is then full of entries whose stamps name archives and
  // overlays nothing can look at — and "cannot say" must not turn into "delete", or such a machine
  // would lose one entry per request and be unable to rebuild a single one of them.
  const client = await looseClient({ "Tileset\\Test.blp": "BLP2-one" });
  const cache = await mkdtemp(join(tmpdir(), "webclient-cache-"));
  const entry = join(cache, "texture.png");
  const chain = await openClientArchives(client);
  try {
    await writeFile(entry, "PNG-one");
    await writeSourceStamp(entry, await sourceStamp(chain, { paths: ["Tileset\\Test.blp"] }));
  } finally {
    chain.close();
  }
  try {
    // The client is gone from under the stamp, which is what a machine serving a published `data/`
    // without one looks like.
    await rm(client, { recursive: true, force: true });
    const fingerprint = new DatasetFingerprint({ dbcDirectory: cache, intervalMs: 0 });
    await fingerprint.poll();
    await fingerprint.ensureCurrent(entry);
    assert.equal(await readFile(entry, "utf8"), "PNG-one");
  } finally {
    await rm(cache, { recursive: true, force: true });
    await rm(client, { recursive: true, force: true });
  }
});

test("a poll reports a change once, and the epoch only moves when something moved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-dbc-print-"));
  try {
    await writeFile(join(directory, "Spell.dbc"), "WDBC-one");
    const fingerprint = new DatasetFingerprint({ dbcDirectory: directory, intervalMs: 0 });
    assert.deepEqual(await fingerprint.poll(), { epoch: 0, dbc: false, archives: false },
      "the first poll is the baseline, not a change");

    await writeFile(join(directory, "Spell.dbc"), "WDBC-two-longer");
    assert.deepEqual(await fingerprint.poll(), { epoch: 1, dbc: true, archives: false });
    assert.deepEqual(await fingerprint.poll(), { epoch: 1, dbc: false, archives: false },
      "the same change must not be reported twice, or every request drops every index");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("between polls the interval is respected, and concurrent callers share one walk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-dbc-print-"));
  try {
    await writeFile(join(directory, "Spell.dbc"), "WDBC-one");
    let clock = 1_000;
    const fingerprint = new DatasetFingerprint({ dbcDirectory: directory, intervalMs: 2_000, now: () => clock });
    await fingerprint.poll();

    await writeFile(join(directory, "Spell.dbc"), "WDBC-two-longer");
    clock += 1_999;
    assert.deepEqual(await fingerprint.poll(), { epoch: 0, dbc: false, archives: false },
      "inside the interval nothing is walked");
    clock += 1;
    const [first, second] = await Promise.all([fingerprint.poll(), fingerprint.poll()]);
    assert.deepEqual(first, { epoch: 1, dbc: true, archives: false });
    assert.deepEqual(second, first, "two requests in flight at once share the one answer");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an entry is dropped when a source is installed beside the one it was built from", async () => {
  // The rule that catches "a module was installed" rather than "a module edited its content". A
  // new patch directory can win a path away from the archive that used to answer it without
  // touching one file this entry knows about, so the composition of the chain is part of the stamp
  // and disagreeing about it is enough on its own.
  const client = await looseClient({ "Tileset\\Test.blp": "BLP2-one" });
  const cache = await mkdtemp(join(tmpdir(), "webclient-cache-"));
  const entry = join(cache, "texture.png");
  const chain = await openClientArchives(client);
  try {
    await writeFile(entry, "PNG-one");
    await writeSourceStamp(entry, await sourceStamp(chain, { paths: ["Tileset\\Test.blp"] }));
  } finally {
    chain.close();
  }
  try {
    const fingerprint = new DatasetFingerprint({ clientDirectory: client, intervalMs: 0 });
    await fingerprint.poll();
    await fingerprint.ensureCurrent(entry);
    assert.equal(await readFile(entry, "utf8"), "PNG-one", "the chain it was stamped against is still the chain");

    // A second module arrives. It does not carry this texture, and the file that does is untouched
    // — only the list of places that could carry it has changed.
    const installed = join(client, "Data", "ruRU", "patch-ruRU-B.MPQ", "Tileset");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "Other.blp"), "BLP2-other");
    await fingerprint.poll();
    await fingerprint.ensureCurrent(entry);
    await assert.rejects(readFile(entry), "a chain this entry was not built against has to be rechecked");
  } finally {
    await rm(cache, { recursive: true, force: true });
    await rm(client, { recursive: true, force: true });
  }
});

test("an entry is dropped when an overlay above its source gains the same path", async () => {
  // And the rule that catches the other half: the chain is the same chain, the winner's file is
  // untouched, and yet the answer to the path has changed because a directory that was searched
  // first — and did not have it — does now. The stamp carries those directories by name so that
  // the gateway, which never ranks the chain, can notice it without a second copy of the ranking.
  const client = await looseClient({ "Tileset\\Test.blp": "BLP2-one" });
  const higher = join(client, "Data", "ruRU", "patch-ruRU-B.MPQ");
  await mkdir(join(higher, "Tileset"), { recursive: true });
  await writeFile(join(higher, "Tileset", "Other.blp"), "BLP2-other");
  const cache = await mkdtemp(join(tmpdir(), "webclient-cache-"));
  const entry = join(cache, "texture.png");
  const chain = await openClientArchives(client);
  try {
    const stamp = await sourceStamp(chain, { paths: ["Tileset\\Test.blp"] });
    assert.equal(stamp.sources[0].name, "patch-ruRU-A.MPQ", "B is the letter above A, so A is the winner here");
    assert.deepEqual(stamp.sources[0].above, ["patch-ruRU-B.MPQ"], "and B is the overlay that was asked first");
    await writeFile(entry, "PNG-one");
    await writeSourceStamp(entry, stamp);
  } finally {
    chain.close();
  }
  try {
    const fingerprint = new DatasetFingerprint({ clientDirectory: client, intervalMs: 0 });
    await fingerprint.poll();
    await fingerprint.ensureCurrent(entry);
    assert.equal(await readFile(entry, "utf8"), "PNG-one", "nothing above it has the path yet");

    // The higher module starts overriding the same texture. Same chain, same file underneath it.
    await writeFile(join(higher, "Tileset", "Test.blp"), "BLP2-from-the-higher-overlay");
    await fingerprint.poll();
    await fingerprint.ensureCurrent(entry);
    await assert.rejects(readFile(entry), "the picture that wins this path is no longer the one this was built from");
  } finally {
    await rm(cache, { recursive: true, force: true });
    await rm(client, { recursive: true, force: true });
  }
});

test("a change that lands while the client cannot be walked is reported by the next poll", async () => {
  // The two halves are recomputed together and committed together. A tswow build rewrites the DBC
  // directory and the patch directory in the same run, so "the DBC hash is already new" and "the
  // walk of Data ran into a directory being replaced" are the same instant — and writing the first
  // half down before the second one throws would move the baseline past a change nobody was ever
  // told about. The DBC edit would then be invisible until somebody restarted the process, which
  // is the one thing this whole file exists to prevent.
  const directory = await mkdtemp(join(tmpdir(), "webclient-dbc-print-"));
  const client = await looseClient({ "Tileset\\Test.blp": "BLP2-one" });
  try {
    await writeFile(join(directory, "Spell.dbc"), "WDBC-one");
    const problems = [];
    const fingerprint = new DatasetFingerprint({
      dbcDirectory: directory,
      clientDirectory: client,
      intervalMs: 0,
      onProblem: (message) => problems.push(message),
    });
    assert.deepEqual(await fingerprint.poll(), { epoch: 0, dbc: false, archives: false });

    // The build rewrites the tables, and the walk lands in the hole where `Data` was.
    await writeFile(join(directory, "Spell.dbc"), "WDBC-two-longer");
    await rm(join(client, "Data"), { recursive: true, force: true });
    assert.deepEqual(await fingerprint.poll(), { epoch: 0, dbc: false, archives: false },
      "half a walk is not a fingerprint");
    assert.equal(problems.length, 1, "and a walk that has stopped working is said once, not once per poll");
    assert.deepEqual(await fingerprint.poll(), { epoch: 0, dbc: false, archives: false });
    assert.equal(problems.length, 1);

    // The build finishes.
    await mkdir(join(client, "Data", "ruRU", "patch-ruRU-A.MPQ"), { recursive: true });
    await writeFile(join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", "Test.blp"), "BLP2-one");
    const change = await fingerprint.poll();
    assert.equal(change.dbc, true, "the edit made while the client was unreadable still has to be reported");
    assert.equal(change.archives, true);
    assert.equal(problems.length, 2, "and the recovery is worth one line too");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(client, { recursive: true, force: true });
  }
});

test("a dataset being rebuilt under the gateway is not reported as a change", async () => {
  // A tswow build empties and rewrites the DBC directory. A walk that lands in the middle of it
  // throws, and reporting that as a change would drop every index twice — once for the hole and
  // once for the finished build.
  const directory = await mkdtemp(join(tmpdir(), "webclient-dbc-print-"));
  const problems = [];
  const fingerprint = new DatasetFingerprint({
    dbcDirectory: directory,
    intervalMs: 0,
    onProblem: (message) => problems.push(message),
  });
  await writeFile(join(directory, "Spell.dbc"), "WDBC-one");
  await fingerprint.poll();
  await rm(directory, { recursive: true, force: true });
  assert.deepEqual(await fingerprint.poll(), { epoch: 0, dbc: false, archives: false });
  // Not silently, though: the half second a build spends rewriting a directory and a drive that
  // has gone for good look exactly alike from in here, and only one of them ends.
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ENOENT|no such file/i);
});

test("a published file is skipped only while it still matches the file it came from", async () => {
  // What a generator asks before it steps over work it has done before. `access(destination)`
  // answers "there is a file with that name", which is a different question: the terrain layers
  // were skipped on that answer, and their names are hashes of a *path*, so a module that replaced
  // a ground texture published under the same name and was stepped over every time.
  const client = await looseClient({ "Tileset\\Grass.blp": "BLP2-one" });
  const cache = await mkdtemp(join(tmpdir(), "webclient-cache-"));
  const chain = await openClientArchives(client);
  const layer = join(cache, "layer.png");
  const inputs = { paths: ["Tileset\\Grass.blp"] };
  try {
    await writeFile(layer, "PNG-one");
    assert.equal(await stampIsCurrent(layer, chain, inputs), false, "a file with no stamp is not something to skip");
    await stampGenerated(layer, chain, inputs);
    assert.equal(await stampIsCurrent(layer, chain, inputs), true);

    await writeFile(join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", "Tileset", "Grass.blp"), "BLP2-two-and-longer");
    assert.equal(await stampIsCurrent(layer, chain, inputs), false, "the module replaced the grass");
  } finally {
    chain.close();
    await rm(cache, { recursive: true, force: true });
    await rm(client, { recursive: true, force: true });
  }
});

test("a publisher republishes an entry that cannot say where it came from", async () => {
  // The far end of an operator rerunning a bulk pass over an unstamped cache. Every publisher used
  // to stop at `access(destination)`, so `npm run assets:item-icons -- --all` would have answered
  // "already cached" and written nothing at all, and none of the 23,025 files already under
  // `data/` that a publisher owns could ever have become watchable that way. A sound stands in for
  // all of them: it is the one publisher whose republish is a copy rather than a decode, 0.42 ms
  // against the 285 ms the chain cost anyway.
  const client = await looseClient({ "Sound\\Character\\Test.wav": "RIFF-one" });
  const sounds = await mkdtemp(join(tmpdir(), "webclient-sound-"));
  const previous = process.env.SOUND_DIR;
  process.env.SOUND_DIR = sounds;
  const chain = await openClientArchives(client);
  try {
    const path = "Sound\\Character\\Test.wav";
    const first = await publishSound(path, chain);
    assert.equal(first.cached, false);
    assert.equal((await publishSound(path, chain)).cached, true, "a stamped file is cached");

    await rm(stampSidecar(first.destination));
    assert.equal((await publishSound(path, chain)).cached, false, "one that cannot say what it holds is not");
    await assert.doesNotReject(readFile(stampSidecar(first.destination)), "and it comes back with a stamp");
    assert.equal((await publishSound(path, chain)).cached, true);
  } finally {
    chain.close();
    if (previous === undefined) delete process.env.SOUND_DIR;
    else process.env.SOUND_DIR = previous;
    await rm(sounds, { recursive: true, force: true });
    await rm(client, { recursive: true, force: true });
  }
});

test("a ground texture that appears in a patch directory changes the published layer", withDataset, async () => {
  // The whole path, through the real generator: the ground the player walks on is published as
  // `data/terrain-layers/<sha1 of the BLP's path>.png`, and `/terrain-layer` cannot rebuild one —
  // an id does not say which path it came from. The tile does: every one of its ground textures is
  // in its own stamp, so the same edit makes the tile stale and rebuilding the tile is what
  // rewrites the layer. That last step is the one this pins; it used to be `access` and `continue`.
  const client = await mkdtemp(join(tmpdir(), "webclient-splat-client-"));
  const layers = await mkdtemp(join(tmpdir(), "webclient-splat-layers-"));
  const textures = await mkdtemp(join(tmpdir(), "webclient-splat-textures-"));
  const overlay = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ");
  const real = await openClientArchives(clientDirectory);
  try {
    // One tile of Azeroth as a module would ship it: a loose patch directory, and nothing else in
    // the chain. The ground textures are deliberately left out of the first run.
    await mkdir(join(overlay, "World", "Maps", "Azeroth"), { recursive: true });
    for (const name of ["Azeroth_32_32.adt", "Azeroth.wdt"]) {
      await writeFile(join(overlay, "World", "Maps", "Azeroth", name), await real.read(`World\\Maps\\Azeroth\\${name}`));
    }
    const generate = () => promisify(execFile)(
      process.execPath,
      [resolve(repositoryRoot, "tools/generate-terrain-splat.mjs"), "0", "32", "32"],
      { cwd: repositoryRoot, env: { ...process.env, CLIENT_DIR: client, TERRAIN_LAYER_DIR: layers, TERRAIN_TEXTURE_DIR: textures } },
    );

    const missing = /fell back to flat colour: ([^;\n]+)/.exec((await generate()).stderr);
    assert.ok(missing, "a tile whose ground textures are not in the chain has to say so");
    const ground = missing[1].trim();
    const id = createHash("sha1").update(`terrain-layer-v1\0${ground.toLowerCase()}`).digest("hex");
    const published = join(layers, `${id}.png`);
    const flat = await readFile(published);
    assert.deepEqual(JSON.parse(await readFile(stampSidecar(published), "utf8")).sources, [],
      "nothing in the chain answered that path, so the stamp names nothing");

    // The module ships the texture the tile asks for, under the path the tile asks for it by.
    await mkdir(join(overlay, dirname(ground)), { recursive: true });
    await writeFile(join(overlay, ground), await real.read(ground));
    await generate();

    const republished = await readFile(published);
    assert.ok(!republished.equals(flat), "the layer under that id has to be the module's picture now");
    assert.ok(republished.length > flat.length * 4, `expected a real ground texture, got ${republished.length} bytes`);
    const [source] = JSON.parse(await readFile(stampSidecar(published), "utf8")).sources;
    assert.equal(source.path, ground);
    assert.equal(source.name, "patch-ruRU-A.MPQ", "and it has to be able to say so next time");
  } finally {
    real.close();
    await rm(client, { recursive: true, force: true });
    await rm(layers, { recursive: true, force: true });
    await rm(textures, { recursive: true, force: true });
  }
});

test("the fingerprint of the real dataset costs less than 200 ms", withDataset, async () => {
  // The gateway walks both sets on the first request after the interval has run out, so this is
  // the worst a request can pay for the watch. Measured 8.4 ms over 247 dataset files and 33.5 ms
  // over 818 client files when it was written.
  //
  // Best of five, and a count as well as a clock: the whole suite runs its files in parallel, and
  // a walk that is 41.8 ms on its own has been seen at 329 ms with eighty other tests fighting it
  // for the disk. The count is the assertion that actually holds the design — the same walk over
  // the maps and vmaps beside the dataset is 5,744 and 15,087 files, 181.2 ms and 469.3 ms, and it
  // is the thing somebody would reach for next.
  let dbc;
  let archives;
  let best = Infinity;
  for (let run = 0; run < 5; run++) {
    const started = performance.now();
    dbc = await fingerprintDbc(dbcDirectory);
    archives = await fingerprintArchives(clientDirectory);
    best = Math.min(best, performance.now() - started);
  }
  assert.ok(dbc.files > 100, `expected the real DBC directory, got ${dbc.files} files`);
  assert.ok(archives.files > 100, `expected the real client, got ${archives.files} files`);
  assert.ok(dbc.files + archives.files < 2_000,
    `the fingerprint walks ${dbc.files + archives.files} files, which is no longer a cheap watch`);
  // 200 rather than the 100 the first cut asserted: with three worktrees building and testing at
  // once on this machine the best of five was measured at 109.1 ms, and the file count above is
  // the assertion that holds the design — the clock only catches a walk that grew by an order.
  assert.ok(best < 200,
    `the dataset fingerprint took ${best.toFixed(1)} ms over ${dbc.files} dataset and ${archives.files} client files`);
});

test("the source-stamp sweeper removes only provenance sidecars", async () => {
  // The ignored caches carry sidecars naming local client inputs, sizes and mtimes. The reusable
  // sweeper removes those records without touching an adjacent cache entry or ordinary web file.
  const built = await mkdtemp(join(tmpdir(), "webclient-built-"));
  try {
    await mkdir(join(built, "icons"), { recursive: true });
    await writeFile(join(built, "index.html"), "<!doctype html>");
    await writeFile(join(built, "icons", "1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeSourceStamp(join(built, "icons", "1.png"), { chain: "abc", sources: [], files: [] });
    await writeFile(join(built, "icons", "index.json"), "[1]\n");

    assert.equal(await removeStampsUnder(built), 1, "one sidecar, however deep it sits");
    await assert.rejects(() => stat(stampSidecar(join(built, "icons", "1.png"))));
    // At this utility layer the picture remains; Vite's production plugin removes the whole local
    // cache tree from dist after it has swept any sidecars elsewhere.
    assert.deepEqual(await readFile(join(built, "icons", "1.png")), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await stat(join(built, "icons", "index.json"));
    await stat(join(built, "index.html"));

    assert.equal(await removeStampsUnder(built), 0, "and nothing to do the second time");
    // A build that published nothing has no directory to sweep, which is not a failure.
    assert.equal(await removeStampsUnder(join(built, "no-such-place")), 0);
  } finally {
    await rm(built, { recursive: true, force: true });
  }
});

test("the production web directory is marked local-only and excludes public client caches", async () => {
  const built = join(repositoryRoot, "dist", "web");
  const warning = await readFile(join(built, "LOCAL_ONLY-NOT-FOR-REDISTRIBUTION.txt"), "utf8");
  assert.match(warning, /Do not redistribute, publish or publicly host it/);
  for (const name of ["icons", "creature-icons", "portraits"]) {
    await assert.rejects(() => stat(join(built, name)), { code: "ENOENT" }, name);
  }
});
