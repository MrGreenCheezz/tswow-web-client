// 23.10 (7.48): `/texture` serving the HD sets (gateway/HdTextures.ts): only to an `hd=` request, only a current
// copy, never a file named by the request; immutable only under both generations; switched off, nothing changes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { IMMUTABLE, REVALIDATE } from "../dist/code/gateway/CachePolicy.js";
import { HdTextureSets, hdTextureId, parseHdTexturesEnv } from "../dist/code/gateway/HdTextures.js";

const ORIGIN = "http://127.0.0.1:5173";
const PATH = "Spells\\Clouds8x8.blp";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "webclient-hd-textures-"));
  const client = join(root, "client");
  const textures = join(root, "textures");
  const hd = join(root, "hd");
  await mkdir(join(client, "Data"), { recursive: true });
  await writeFile(join(client, "Data", "common.MPQ"), "MPQ-test");
  await mkdir(textures);
  const originalId = createHash("sha1").update(`texture-v1\0${PATH.toLowerCase()}`).digest("hex");
  await writeFile(join(textures, `${originalId}.png`), "PNG-original");
  await mkdir(join(hd, "effects"), { recursive: true });
  await writeFile(join(hd, "effects", "manifest.json"), JSON.stringify({ schema: "hd-textures-1", entries: {} }));
  await writeFile(join(hd, "effects", `${hdTextureId(PATH)}.png`), "PNG-hd");
  return { root, client, textures, hd };
}

async function withGateway(options, run) {
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [ORIGIN], datasetPollMs: 0, ...options,
  });
  try {
    return await run(`http://127.0.0.1:${gateway.port}`);
  } finally {
    await gateway.close();
  }
}

const status = async (base) => (await fetch(`${base}/client/patch-status?summary=1`, { headers: { origin: ORIGIN } })).json();
const ask = (base, query, headers = {}) => fetch(`${base}/texture?${query}`, { headers: { origin: ORIGIN, ...headers } });

test("an hd= request gets the HD copy while it is current, the original otherwise; a plain request never sees it", async () => {
  const { root, client, textures, hd } = await fixture();
  let current = true;
  const staleSets = [];
  try {
    await withGateway({
      clientDirectory: client, texturesDirectory: textures,
      hdTextures: { sets: new HdTextureSets(hd, { refreshMs: 0, onStale: (set) => staleSets.push(set) }), isCurrent: async () => current },
    }, async (base) => {
      const { visualGeneration: vg, hdTextureGeneration: hg } = await status(base);
      assert.match(hg, /^[0-9a-f]{20}$/, "the HD generation is published");
      const path = `path=${encodeURIComponent(PATH)}`;

      const plain = await ask(base, `${path}&vg=${vg}`);
      assert.equal(await plain.text(), "PNG-original", "no hd=: the original, exactly as before");
      assert.equal(plain.headers.get("cache-control"), IMMUTABLE);

      const pinned = await ask(base, `${path}&vg=${vg}&hd=${hg}`);
      assert.equal(pinned.status, 200);
      assert.equal(await pinned.text(), "PNG-hd");
      assert.equal(pinned.headers.get("cache-control"), IMMUTABLE, "under both generations");
      assert.equal((await ask(base, `${path}&vg=${vg}&hd=00000000000000000000`)).headers.get("cache-control"), REVALIDATE,
        "an older HD generation is revalidated");
      assert.equal((await ask(base, `${path}&hd=${hg}`)).headers.get("cache-control"), REVALIDATE, "no vg: revalidated");
      const again = await ask(base, `${path}&vg=${vg}&hd=${hg}`, { "if-none-match": pinned.headers.get("etag") });
      assert.equal(again.status, 304);

      // Another spelling of the same path is the same HD file (the key is the lowercased, backslashed path).
      assert.equal(await (await ask(base, `path=${encodeURIComponent("spells/CLOUDS8X8.BLP")}&hd=${hg}`)).text(), "PNG-hd");

      // A patch replaced the BLP: the stamp no longer matches, the original answers, revalidated (not pinned).
      current = false;
      const stale = await ask(base, `${path}&vg=${vg}&hd=${hg}`);
      assert.equal(await stale.text(), "PNG-original");
      assert.equal(stale.headers.get("cache-control"), REVALIDATE);
      await ask(base, `${path}&hd=${hg}`);
      assert.deepEqual(staleSets, ["effects"], "the gateway is told once a minute to restamp the set (no GPU)");

      // A path the set does not hold: the original route, revalidated because hd= was asked.
      current = true;
      const other = await ask(base, `path=${encodeURIComponent("Spells\\Missing.blp")}&hd=${hg}`);
      assert.equal(other.status, 404);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hd= cannot reach outside the set: traversal and absolute paths are refused before any file is named", async () => {
  const { root, client, textures, hd } = await fixture();
  try {
    // A file a traversal would aim at, beside the set.
    await writeFile(join(hd, "secret.png"), "SECRET");
    await withGateway({
      clientDirectory: client, texturesDirectory: textures,
      hdTextures: { sets: new HdTextureSets(hd, { refreshMs: 0 }), isCurrent: async () => true },
    }, async (base) => {
      const { hdTextureGeneration: hg } = await status(base);
      for (const bad of ["..\\secret.blp", "spells\\..\\..\\secret.blp", "C:\\Windows\\win.ini", "spells\\a.png", ""]) {
        const response = await ask(base, `path=${encodeURIComponent(bad)}&hd=${hg}`);
        assert.equal(response.status, 400, bad);
        assert.notEqual(await response.text(), "SECRET");
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("switched off (HD_TEXTURES=0, bat/32 by default): no generation published and hd= ignored", async () => {
  const { root, client, textures } = await fixture();
  try {
    await withGateway({ clientDirectory: client, texturesDirectory: textures }, async (base) => {
      const published = await status(base);
      assert.equal("hdTextureGeneration" in published, false);
      const response = await ask(base, `path=${encodeURIComponent(PATH)}&hd=whatever`);
      assert.equal(await response.text(), "PNG-original");
    });
    assert.equal(parseHdTexturesEnv({}), true, "on by default for the owner's own play");
    assert.equal(parseHdTexturesEnv({ HD_TEXTURES: "0" }), false);
    assert.equal(parseHdTexturesEnv({ HD_TEXTURES: "off" }), false);
    assert.equal(parseHdTexturesEnv({ HD_TEXTURES: "1" }), true);
    // Public serving (bat/32) forces the switch off unless the owner opts players in; the gateway reads the switch.
    const server = readFileSync(new URL("../tools/start-server.mjs", import.meta.url), "utf8");
    assert.match(server, /process\.env\.HD_TEXTURES = process\.env\.PUBLIC_HD_TEXTURES\?\.trim\(\) === "1" \? "1" : "0";/);
    const configuration = readFileSync(new URL("../src/gateway/GatewayConfiguration.ts", import.meta.url), "utf8");
    assert.match(configuration, /parseHdTexturesEnv\(process\.env\) \? \{\s*hdTextures:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the HD generation is a digest of the sets' manifests; odd directory names are not sets", async () => {
  const { root, hd } = await fixture();
  try {
    let now = 0;
    const sets = new HdTextureSets(hd, { refreshMs: 1000, now: () => now });
    const first = await sets.generation();
    await writeFile(join(hd, "effects", "manifest.json"), JSON.stringify({ schema: "hd-textures-1", entries: { a: 1 } }));
    assert.equal(await sets.generation(), first, "read at most once a refresh");
    now = 2000;
    const second = await sets.generation();
    assert.notEqual(second, first, "a rebuilt set is a new generation");
    await mkdir(join(hd, "Bad.Name"));
    await writeFile(join(hd, "Bad.Name", "manifest.json"), "{}");
    await writeFile(join(hd, "Bad.Name", `${hdTextureId(PATH)}.png`), "X");
    now = 4000;
    assert.equal(await sets.generation(), second);
    assert.equal(await new HdTextureSets(join(root, "nowhere")).generation(), undefined, "no sets, no generation");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
