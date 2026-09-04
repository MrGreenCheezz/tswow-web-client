import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  CLIENT_PACK_MANIFEST,
  buildClientPack,
  inspectClientPackSource,
  verifyClientPack,
} from "../tools/client-pack.mjs";
import { openClientArchives } from "../tools/mpq.mjs";

const execFileAsync = promisify(execFile);

async function fixtureClient(root) {
  await mkdir(join(root, "Data", "ruRU", "patch-ruRU-A.MPQ", "DBFilesClient"), { recursive: true });
  await mkdir(join(root, "Interface", "AddOns", "Example"), { recursive: true });
  await mkdir(join(root, "Fonts"), { recursive: true });
  await writeFile(join(root, "Data", "common.MPQ"), "archive-bytes");
  await writeFile(
    join(root, "Data", "ruRU", "patch-ruRU-A.MPQ", "DBFilesClient", "Spell.dbc"),
    "WDBC-patched",
  );
  await writeFile(join(root, "Interface", "AddOns", "Example", "Example.toc"), "Example.lua\n");
  await writeFile(join(root, "Interface", "AddOns", "Example", "Example.lua"), "ExampleLoaded = true\n");
  await writeFile(join(root, "Fonts", "Custom.ttf"), "font-bytes");
  await writeFile(join(root, "Wow.exe"), "native executable is not a browser asset");
}

test("a locally built client pack remains complete after its source client is removed", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "webclient-pack-"));
  const client = join(sandbox, "client");
  const pack = join(sandbox, "pack");
  try {
    await fixtureClient(client);
    const plan = await inspectClientPackSource(client);
    assert.equal(plan.fileCount, 5);
    assert.equal(plan.totalBytes > 0, true);
    assert.deepEqual(plan.roots, ["Data", "Interface/AddOns", "Fonts"]);

    const manifest = await buildClientPack({ clientDirectory: client, outputDirectory: pack });
    assert.equal(manifest.kind, "tswow-web-client-pack");
    assert.equal(manifest.fileCount, 5);
    assert.deepEqual(manifest.archiveSources.map((source) => [source.path, source.kind]), [
      ["Interface/AddOns", "directory"],
      ["Data/ruRU/patch-ruRU-A.MPQ", "directory"],
      ["Data/common.MPQ", "archive"],
    ]);
    assert.equal((await readFile(join(pack, "Data", "common.MPQ"), "utf8")), "archive-bytes");
    assert.equal((await readFile(join(pack, "Interface", "AddOns", "Example", "Example.lua"), "utf8")),
      "ExampleLoaded = true\n");
    await assert.rejects(readFile(join(pack, "Wow.exe")), /ENOENT/);

    await rm(client, { recursive: true, force: true });
    const verified = await verifyClientPack(pack);
    assert.equal(verified.ok, true);
    assert.deepEqual(verified.missing, []);
    assert.deepEqual(verified.modified, []);
    assert.deepEqual(verified.unexpected, []);
    assert.equal(verified.manifest.contentDigest, manifest.contentDigest);
    const chain = await openClientArchives(pack);
    try {
      assert.equal(chain.chainDigest(), manifest.archiveChainDigest);
      assert.equal(await chain.locate("Interface\\AddOns\\Example\\Example.lua"), "Interface/AddOns");
    } finally {
      chain.close();
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("verification rejects missing, changed, and unexpected pack content", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "webclient-pack-"));
  const client = join(sandbox, "client");
  const pack = join(sandbox, "pack");
  try {
    await fixtureClient(client);
    await buildClientPack({ clientDirectory: client, outputDirectory: pack });
    await writeFile(join(pack, "Interface", "AddOns", "Example", "Example.lua"), "ExampleLoaded = nil!\n");
    await rm(join(pack, "Fonts", "Custom.ttf"));
    await writeFile(join(pack, "Data", "unexpected.bin"), "unexpected");

    const verified = await verifyClientPack(pack);
    assert.equal(verified.ok, false);
    assert.deepEqual(verified.missing, ["Fonts/Custom.ttf"]);
    assert.deepEqual(verified.modified, ["Interface/AddOns/Example/Example.lua"]);
    assert.deepEqual(verified.unexpected, ["Data/unexpected.bin"]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("CLIENT_PACK_DIR wins over CLIENT_DIR for every existing generator", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "webclient-pack-path-"));
  const client = join(sandbox, "client");
  const pack = join(sandbox, "pack");
  try {
    await fixtureClient(client);
    await buildClientPack({ clientDirectory: client, outputDirectory: pack });
    const script = [
      "import('./tools/paths.mjs')",
      ".then((paths) => process.stdout.write(paths.clientDirectory()))",
      ".catch((error) => { console.error(error); process.exitCode = 1; });",
    ].join("");
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: resolve("."),
      env: {
        ...process.env,
        WEBCLIENT_SKIP_ENV: "1",
        CLIENT_DIR: client,
        CLIENT_PACK_DIR: pack,
      },
    });
    assert.equal(resolve(stdout), resolve(pack));
    const parsed = JSON.parse(await readFile(join(pack, CLIENT_PACK_MANIFEST), "utf8"));
    assert.equal(parsed.schema, 1);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
