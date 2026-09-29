import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openClientArchives } from "../tools/mpq.mjs";
import { compareOriginalPatchWinner, originalStartupPatchRank } from "../tools/original-mpq-order.mjs";

function copy(name, relativeDataPath) {
  return { name, kind: "directory", relativeDataPath };
}

test("native startup searches locale wildcard patches before root wildcard patches", () => {
  const webOrder = [
    copy("patch-W.MPQ", "patch-W.MPQ"),
    copy("patch-ruRU-A.MPQ", "ruRU\\patch-ruRU-A.MPQ"),
  ];
  const result = compareOriginalPatchWinner(webOrder);
  assert.equal(result.status, "different");
  assert.equal(result.webClientWinner.name, "patch-W.MPQ");
  assert.equal(result.originalPatchWinner.name, "patch-ruRU-A.MPQ");

  const same = compareOriginalPatchWinner([
    copy("patch-ruRU-G.MPQ", "ruRU\\patch-ruRU-G.MPQ"),
    copy("patch-ruRU-A.MPQ", "ruRU\\patch-ruRU-A.MPQ"),
  ]);
  assert.equal(same.status, "same");
});

test("wildcard, exact and alternate patches keep their recovered startup phases", () => {
  assert.ok(originalStartupPatchRank("ruRU\\patch-ruRU-3.MPQ"));
  assert.ok(originalStartupPatchRank("patch-W.MPQ"));
  assert.equal(originalStartupPatchRank("ruRU\\patch-ruRU-22.MPQ"), undefined);
  assert.equal(originalStartupPatchRank("default.dataset.A.MPQ"), undefined);
  assert.equal(compareOriginalPatchWinner([
    copy("patch-ruRU.MPQ", "ruRU\\patch-ruRU.MPQ"),
    copy("patch.MPQ", "patch.MPQ"),
  ]).originalPatchWinner.name, "patch.MPQ");
  assert.equal(compareOriginalPatchWinner([
    copy("patch-W.MPQ", "patch-W.MPQ"),
    copy("alternate.MPQ", "alternate.MPQ"),
  ]).originalPatchWinner.name, "alternate.MPQ");
});

test("an unmodeled WebClient winner is reported as indeterminate", () => {
  const result = compareOriginalPatchWinner([
    copy("default.dataset.A.MPQ", "default.dataset.A.MPQ"),
    copy("patch-ruRU-A.MPQ", "ruRU\\patch-ruRU-A.MPQ"),
  ]);
  assert.equal(result.status, "indeterminate");
  assert.equal(result.originalPatchWinner.name, "patch-ruRU-A.MPQ");
  assert.equal(compareOriginalPatchWinner([copy("common.MPQ", "common.MPQ")]).status,
    "indeterminate");
});

test("copies exposes every holder with its path relative to Data", async () => {
  const client = await mkdtemp(join(tmpdir(), "webclient-original-order-"));
  try {
    const root = join(client, "Data", "patch-W.MPQ", "DBFilesClient");
    const locale = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", "DBFilesClient");
    await Promise.all([mkdir(root, { recursive: true }), mkdir(locale, { recursive: true })]);
    await Promise.all([
      writeFile(join(root, "Example.dbc"), "root"),
      writeFile(join(locale, "Example.dbc"), "locale"),
    ]);
    const chain = await openClientArchives(client);
    try {
      const copies = await chain.copies("dbfilesclient\\example.dbc");
      assert.deepEqual(copies, [
        copy("patch-W.MPQ", "patch-W.MPQ"),
        copy("patch-ruRU-A.MPQ", "ruRU\\patch-ruRU-A.MPQ"),
      ]);
      assert.equal(compareOriginalPatchWinner(copies).status, "different");
    } finally {
      chain.close();
    }
  } finally {
    await rm(client, { recursive: true, force: true });
  }
});
