import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { shadowWarning } from "../tools/check-shadowed-tables.mjs";
import { ARCHIVE_ORDER, archivePriority, openClientArchives } from "../tools/mpq.mjs";

// Ordering is pure and always testable. Reading needs the client, which not every machine has.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

function order(names) {
  return [...names].sort((left, right) => {
    const a = archivePriority(left);
    const b = archivePriority(right);
    if (a.tier !== b.tier) return b.tier - a.tier;
    if (a.rank !== b.rank) return b.rank - a.rank;
    return left.toLowerCase() < right.toLowerCase() ? 1 : -1;
  });
}

test("archives rank the way the client loads them", () => {
  // The old helper put every `patch*` in one bucket and broke ties on descending filename, so
  // patch.MPQ beat patch-2 and patch-3, and it dropped every locale archive below common.MPQ.
  assert.deepEqual(order([
    "common.MPQ", "common-2.MPQ", "expansion.MPQ", "lichking.MPQ",
    "patch.MPQ", "patch-2.MPQ", "patch-3.MPQ",
  ]), [
    "patch-3.MPQ", "patch-2.MPQ", "patch.MPQ", "lichking.MPQ", "expansion.MPQ",
    "common-2.MPQ", "common.MPQ",
  ]);

  // Locale beats base at every level, and the lettered custom patches beat the numbered ones.
  assert.deepEqual(order([
    "common.MPQ", "patch-3.MPQ", "locale-ruRU.MPQ", "expansion-locale-ruRU.MPQ",
    "lichking-locale-ruRU.MPQ", "patch-ruRU.MPQ", "patch-ruRU-2.MPQ", "patch-ruRU-3.MPQ",
    "patch-ruRU-A.MPQ", "patch-ruRU-B.MPQ",
  ]), [
    "patch-ruRU-B.MPQ", "patch-ruRU-A.MPQ", "patch-ruRU-3.MPQ", "patch-ruRU-2.MPQ",
    "patch-ruRU.MPQ", "lichking-locale-ruRU.MPQ", "expansion-locale-ruRU.MPQ", "locale-ruRU.MPQ",
    "patch-3.MPQ", "common.MPQ",
  ]);

  // The installer's rollback copy must never shadow anything live.
  assert.deepEqual(order(["backup-ruRU.MPQ", "common.MPQ"]), ["common.MPQ", "backup-ruRU.MPQ"]);
});

test("a lettered patch beats the whole locale chain, in either directory it can live in", () => {
  // Where tswow writes, and the reason this ordering is not cosmetic. `Client.Patch.UseLocale`
  // decides whether the built dataset lands in `Data\<loc>\patch-<loc>-A.MPQ` or in
  // `Data\patch-A.MPQ`, and `dataset.conf` leaves it off. Of the 798 files tswow writes into the
  // locale form on this machine, 713 also exist inside the ruRU archives — 245 DBCs, 224 lua,
  // 215 xml, 26 toc and the 3 class-sheet blp — so under the old ranking, which put a
  // base-lettered patch below `locale-ruRU.MPQ`, a default install served the stock copy of every
  // one of them.
  assert.deepEqual(order([
    "locale-ruRU.MPQ", "patch-A.MPQ", "patch-ruRU-A.MPQ", "patch-E.MPQ", "patch-ruRU-E.MPQ",
    "patch-ruRU-3.MPQ", "patch-ruRU.MPQ", "lichking-locale-ruRU.MPQ", "expansion-locale-ruRU.MPQ",
    "speech-ruRU.MPQ", "base-ruRU.MPQ", "patch-3.MPQ",
  ]), [
    // Same letter: the locale form wins the tie, and a later letter beats an earlier one whichever
    // directory either of them is in.
    "patch-ruRU-E.MPQ", "patch-E.MPQ", "patch-ruRU-A.MPQ", "patch-A.MPQ",
    "patch-ruRU-3.MPQ", "patch-ruRU.MPQ", "lichking-locale-ruRU.MPQ", "expansion-locale-ruRU.MPQ",
    "locale-ruRU.MPQ", "speech-ruRU.MPQ", "base-ruRU.MPQ", "patch-3.MPQ",
  ]);

  // And a name from no known family beats the locale chain too: `tswow build package` names its
  // output after the dataset, `default.dataset.A.MPQ`, which is none of the families above and is
  // the last thing that should lose to a stock archive. It still ranks below the lettered patches,
  // which are the ones the client is known to load.
  assert.deepEqual(
    order(["locale-ruRU.MPQ", "default.dataset.A.MPQ", "patch-A.MPQ", "patch-ruRU-3.MPQ", "patch-3.MPQ"]),
    ["patch-A.MPQ", "default.dataset.A.MPQ", "patch-ruRU-3.MPQ", "locale-ruRU.MPQ", "patch-3.MPQ"]);
});

test("a directory named *.MPQ is read as a loose overlay above the archive it outranks", async () => {
  const client = await mkdtemp(join(tmpdir(), "webclient-loose-"));
  try {
    // No real archive here, only the patch directory: the point is that the chain opens at all
    // and serves from it. The C++ helper skipped these entirely, which is why every tswow asset
    // and every patched DBC was invisible to the pipeline.
    const patch = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ");
    await mkdir(join(patch, "DBFilesClient"), { recursive: true });
    await writeFile(join(patch, "DBFilesClient", "Custom.dbc"), "patched");
    await mkdir(join(patch, "Creature", "WingedLion2"), { recursive: true });
    await writeFile(join(patch, "Creature", "WingedLion2", "WingedLion2.m2"), "MD20");

    const chain = await openClientArchives(client);
    try {
      assert.deepEqual(chain.sources, [{ name: "patch-ruRU-A.MPQ", kind: "directory" }]);
      // MPQ paths use backslashes and are case-insensitive; the on-disk names are neither.
      assert.equal((await chain.read("DBFilesClient\\Custom.dbc")).toString(), "patched");
      assert.equal((await chain.read("dbfilesclient/custom.dbc")).toString(), "patched");
      assert.equal((await chain.read("Creature\\WingedLion2\\WingedLion2.m2")).toString(), "MD20");
      assert.equal(await chain.read("DBFilesClient\\Absent.dbc"), undefined);

      const { files, missing } = await chain.readAll(["DBFilesClient\\Custom.dbc", "Nope.blp"]);
      assert.equal(files.size, 1);
      assert.deepEqual(missing, ["Nope.blp"]);
    } finally {
      chain.close();
    }
  } finally {
    await rm(client, { recursive: true, force: true });
  }
});

test("the live client resolves through the whole chain", withClient, async () => {
  const chain = await openClientArchives(clientDirectory);
  try {
    assert.deepEqual(chain.skipped, [], "every archive should open");
    assert.ok(chain.sources.length >= 7, `expected the full chain, got ${chain.sources.length}`);

    // Everything the pipeline needs must resolve, including the DBCs — which live only in the
    // locale archives, so this fails outright under the old precedence.
    for (const path of [
      "DBFilesClient\\Map.dbc",
      "DBFilesClient\\CreatureDisplayInfo.dbc",
      "Interface\\FrameXML\\UIParent.lua",
      "Character\\Human\\Male\\HumanMale.m2",
      "Character\\Human\\Male\\HumanMale00.skin",
      "World\\Maps\\Azeroth\\Azeroth.wdt",
      "Tileset\\Elwynn\\ElwynnGrassBase.blp",
    ]) {
      const data = await chain.read(path);
      assert.ok(data && data.length > 0, `${path} did not resolve`);
    }

    // Sound is reachable too, which is what the audio work will need.
    assert.ok(await chain.has("Sound\\Spells\\Dispel_Low_Base.wav"));
  } finally {
    chain.close();
  }
});

test("the chain digest carries the ranking, not just the names", async () => {
  // A generated file's stamp names the source that won each of its inputs, and a re-ranking hands a
  // path to a different source without one file, or one archive's name, changing. The digest is
  // hashed over the chain's *sorted* names so that the gateway — which never ranks anything — can
  // compute the same value, and sorted names cannot show a re-ranking. So the rule's own identity
  // leads them. Without it every `.src` sidecar written under the previous order would still look
  // current against a chain that no longer resolves the way those entries were built.
  const client = await mkdtemp(join(tmpdir(), "webclient-digest-"));
  try {
    await mkdir(join(client, "Data", "ruRU", "patch-ruRU-A.MPQ"), { recursive: true });
    await writeFile(join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", "Test.blp"), "BLP2");
    const chain = await openClientArchives(client);
    try {
      const composition = ["directory:patch-ruru-a.mpq"];
      assert.notEqual(
        chain.chainDigest(),
        createHash("sha1").update(composition.join("\n")).digest("hex"),
        "a digest over the names alone cannot notice that the ranking changed");
      assert.equal(
        chain.chainDigest(),
        createHash("sha1").update([ARCHIVE_ORDER, ...composition].join("\n")).digest("hex"));
    } finally {
      chain.close();
    }
  } finally {
    await rm(client, { recursive: true, force: true });
  }
});

test("a patch directory can say everything above it that answers one of its files", async () => {
  // The shape of the owner's own machine, one letter down: a tswow build in `patch-ruRU-A.MPQ` and
  // *two* things above it carrying one of the same tables. C is what the game reads, so what the
  // module built is not what the game reads and nothing in the client says so — and B is why the
  // report is the whole queue rather than the winner. Told only about C, an operator takes C out
  // and the path goes to B, which on the real machine is an older revision of the same table: the
  // repair that is offered has to be the one that works.
  const client = await mkdtemp(join(tmpdir(), "webclient-shadow-"));
  try {
    const built = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ");
    await mkdir(join(built, "DBFilesClient"), { recursive: true });
    await mkdir(join(built, "Creature", "WingedLion2"), { recursive: true });
    await writeFile(join(built, "DBFilesClient", "Spell.dbc"), "WDBC-built");
    await writeFile(join(built, "DBFilesClient", "GameObjectDisplayInfo.dbc"), "WDBC-built");
    await writeFile(join(built, "Creature", "WingedLion2", "WingedLion2.m2"), "MD20-built");
    for (const letter of ["B", "C"]) {
      const forgotten = join(client, "Data", "ruRU", `patch-ruRU-${letter}.MPQ`, "DBFilesClient");
      await mkdir(forgotten, { recursive: true });
      await writeFile(join(forgotten, "GameObjectDisplayInfo.dbc"), `WDBC-stale-${letter}`);
    }

    const chain = await openClientArchives(client);
    try {
      const path = "DBFilesClient\\GameObjectDisplayInfo.dbc";
      // One row per overlay that loses the path, in search order, each naming what outranks *it* —
      // so B, which loses to C, is a row of its own and is not confused with A's queue.
      const shadows = [
        { path, overlay: "patch-ruRU-B.MPQ", shadowedBy: ["patch-ruRU-C.MPQ"] },
        { path, overlay: "patch-ruRU-A.MPQ", shadowedBy: ["patch-ruRU-C.MPQ", "patch-ruRU-B.MPQ"] },
      ];
      assert.deepEqual(await chain.shadowedOverlayFiles(), shadows);
      // The prefix is what makes it cheap enough to run at startup, and it compares the way MPQ
      // paths compare — the caller's spelling of it is not the on-disk one.
      assert.deepEqual(await chain.shadowedOverlayFiles("dbfilesclient/"), shadows);
      assert.deepEqual(await chain.shadowedOverlayFiles("Creature\\"), [],
        "the model only one overlay carries is nobody's problem");

      // And the line the operator reads says how many archives have to move, not just the first.
      const queued = shadowWarning(shadows[1]);
      assert.match(queued, /patch-ruRU-C\.MPQ outranks it/);
      assert.match(queued, /Behind it, in order: patch-ruRU-B\.MPQ/);
      assert.match(queued, /all 2 have to leave Data/);
      assert.match(shadowWarning(shadows[0]), /Move patch-ruRU-C\.MPQ out of Data/);
    } finally {
      chain.close();
    }
  } finally {
    await rm(client, { recursive: true, force: true });
  }
});

test("a tswow patch directory wins over the archive it shadows", withClient, async () => {
  if (!existsSync(join(clientDirectory, "Data", "ruRU", "patch-ruRU-A.MPQ"))) return;
  const chain = await openClientArchives(clientDirectory);
  try {
    // tswow writes its built dataset into patch-ruRU-A.MPQ as a directory. Its Spell.dbc carries
    // the custom spells and must beat the stock one in patch-ruRU-3.MPQ; under the old ordering
    // the directory was not even enumerated.
    assert.equal(await chain.locate("DBFilesClient\\Spell.dbc"), "patch-ruRU-A.MPQ");
    const patched = await chain.read("DBFilesClient\\Spell.dbc");
    assert.ok(patched.subarray(0, 4).toString() === "WDBC");
  } finally {
    chain.close();
  }
});

/**
 * What this machine's own client is known to answer from somewhere other than the tswow build, and
 * everything it can be answered from — in rank order, so the first name is the copy the game reads
 * today and the rest are what would take over as each one leaves.
 *
 * `patch-ruRU-E.MPQ` and `patch-ruRU-D.MPQ` are two archives of one file each, both a copy of
 * `GameObjectDisplayInfo.dbc`, and both letters are later than the build's, so they beat the whole
 * built dataset for that one table. `patch-ruRU-F.MPQ` is the installed LoginScreenModule asset
 * junction; its five overlapping GlueXML files are the module's deliberate login-screen override.
 * Nothing in this repository can fix or choose those client overlays — they are files in the
 * owner's client, not lines of code — so the test's job is to keep every exception explained: a
 * shadow not in this list is a file a module built and the game will not read, and the build stops
 * until somebody knows why.
 *
 * Deliberately a *subset* check and not an equality one, and the subset is over the whole queue and
 * not over its head. Taking these archives out of `Data` is the fix this diagnostic exists to
 * prompt, and a test that failed when the owner took it would be a test punishing the repair —
 * which is exactly what pinning the single winner did, because removing E alone leaves D holding
 * the path and a green build would have gone red on the repair it asked for.
 */
const EXPLAINED_SHADOWS = new Map([
  ["dbfilesclient\\gameobjectdisplayinfo.dbc", ["patch-ruRU-E.MPQ", "patch-ruRU-D.MPQ"]],
  ["interface\\gluexml\\accountlogin.lua", ["patch-ruRU-F.MPQ"]],
  ["interface\\gluexml\\accountlogin.xml", ["patch-ruRU-F.MPQ"]],
  ["interface\\gluexml\\gluebuttons.lua", ["patch-ruRU-F.MPQ"]],
  ["interface\\gluexml\\gluebuttons.xml", ["patch-ruRU-F.MPQ"]],
  ["interface\\gluexml\\gluexml.toc", ["patch-ruRU-F.MPQ"]],
]);

test("nothing tswow built is shadowed except what is already explained", withClient, async (t) => {
  if (!existsSync(join(clientDirectory, "Data", "ruRU", "patch-ruRU-A.MPQ"))) return;
  const chain = await openClientArchives(clientDirectory);
  try {
    const shadowed = await chain.shadowedOverlayFiles();
    const found = new Set();
    for (const shadow of shadowed) {
      found.add(shadow.path.toLowerCase());
      t.diagnostic(`${shadow.overlay} holds ${shadow.path}, and the chain answers it from ${shadow.shadowedBy.join(", then ")}`);
      const explained = EXPLAINED_SHADOWS.get(shadow.path.toLowerCase()) ?? [];
      for (const name of shadow.shadowedBy) {
        // Every archive in the queue has to be one of the known ones: a new one appearing anywhere
        // in it changes what the game reads, whether or not it changes what the game reads *first*.
        assert.ok(
          explained.includes(name),
          `${shadow.path} in ${shadow.overlay} is now shadowed by ${name}, which nothing explains: ` +
          `the game client reads a copy of that file the dataset did not build`);
      }
    }
    // Measured on this machine when it was written: 798 files in `patch-ruRU-A.MPQ`, 797 of them
    // the chain's answer, and `patch-ruRU-B.MPQ` — the symlink into a module's asset tree — empty.
    // No count is asserted: the loop above names the offender, and a bare count could only repeat
    // it less clearly. What is worth saying is the other direction — when a known shadow stops
    // being one, the repair landed and the row above it is dead weight.
    t.diagnostic(`${shadowed.length} shadowed file(s) across the patch directories`);
    for (const [path, names] of EXPLAINED_SHADOWS) {
      if (found.has(path)) continue;
      t.diagnostic(`${path} is not shadowed any more — ${names.join(" and ")} are out of Data, and this row can go too`);
    }
  } finally {
    chain.close();
  }
});
