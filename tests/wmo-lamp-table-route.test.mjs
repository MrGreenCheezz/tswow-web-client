// 24.10 (7.50): `/visual/wmo-lamps?path=<wmo>&v=1` (gateway/WmoLampTableRoute.ts) — a building's lamp table, read
// lazily from the WWM artifact `/visual/model` published, kept beside it and served like its siblings: origin checked,
// path and version validated, no file named by the request, immutable under the current visual generation, read
// again when the root is republished, one read for concurrent requests, and the model published first when absent.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startGateway, visualModelHash } from "../dist/code/gateway/Gateway.js";
import { IMMUTABLE, REVALIDATE } from "../dist/code/gateway/CachePolicy.js";
import { wmoLampTableStats } from "../dist/code/gateway/WmoLampTableRoute.js";
import { syntheticCity } from "./fixtures/wmo-lamp-city.mjs";

const ORIGIN = "http://127.0.0.1:5173";
const CITY = "World\\wmo\\Azeroth\\Buildings\\Stormwind\\Stormwind.wmo";

async function publish(directory, path) {
  const { root, files } = syntheticCity();
  const hash = visualModelHash(path);
  await writeFile(join(directory, `${hash}.bin`), root);
  for (const [index, bytes] of files) await writeFile(join(directory, `${hash}.g${String(index).padStart(3, "0")}.bin`), bytes);
  return hash;
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

const lamps = (path, extra = "") => `/visual/wmo-lamps?path=${encodeURIComponent(path)}&v=1${extra}`;
const get = (base, path, origin = ORIGIN) => fetch(`${base}${path}`, { headers: origin ? { origin } : {} });

test("a city's table: its open-air groups and their lanterns, read once, kept beside the artifact, immutable under vg", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-lamps-"));
  const client = join(root, "client");
  const visual = join(root, "visual");
  await mkdir(join(client, "Data"), { recursive: true });
  await writeFile(join(client, "Data", "common.MPQ"), "MPQ-test");
  await mkdir(visual);
  const hash = await publish(visual, CITY);
  try {
    await withGateway({ clientDirectory: client, visualModelsDirectory: visual }, async (base) => {
      const status = await (await get(base, "/client/patch-status?summary=1")).json();
      const vg = status.visualGeneration;
      assert.ok(vg, "the gateway publishes a visual generation");
      const builds = wmoLampTableStats.builds;
      const answer = await get(base, lamps(CITY, `&vg=${vg}`));
      assert.equal(answer.status, 200);
      assert.equal(answer.headers.get("access-control-allow-origin"), ORIGIN);
      assert.equal(answer.headers.get("cache-control"), IMMUTABLE);
      const table = await answer.json();
      assert.deepEqual(table.groups.map(([group]) => group), [0, 2, 3]);
      assert.deepEqual(table.groups[0][1].map((value) => Math.round(value * 100) / 100), [10, 20, 5]);
      assert.equal(table.groupCount, 4);
      assert.equal(wmoLampTableStats.builds, builds + 1);
      assert.ok((await stat(join(visual, `${hash}.lamps.json`))).isFile(), "kept beside the artifact");
      // Asked again — by any spelling of the path — it is the kept file: no second read.
      const again = await get(base, lamps(CITY.toUpperCase().replaceAll("\\", "/")));
      assert.equal(again.headers.get("cache-control"), REVALIDATE, "no vg: revalidated");
      assert.deepEqual(await again.json(), table);
      assert.equal((await get(base, lamps(CITY, "&vg=0000"))).headers.get("cache-control"), REVALIDATE, "another generation");
      assert.equal(wmoLampTableStats.builds, builds + 1);
      // A republished root (a patch, a namespace bump) is read again.
      const later = new Date(Date.now() + 5000);
      await utimes(join(visual, `${hash}.bin`), later, later);
      assert.deepEqual(await (await get(base, lamps(CITY))).json(), table);
      assert.equal(wmoLampTableStats.builds, builds + 2);
      // Concurrent first requests share one read.
      await rm(join(visual, `${hash}.lamps.json`));
      const answers = await Promise.all([0, 1, 2, 3].map(() => get(base, lamps(CITY))));
      assert.deepEqual(answers.map((response) => response.status), [200, 200, 200, 200]);
      assert.equal(wmoLampTableStats.builds, builds + 3);
      // Nothing but the table and its artifact in the directory: no temporary left behind.
      assert.deepEqual((await readdir(visual)).filter((name) => !name.startsWith(hash)), []);
      assert.deepEqual((await readdir(visual)).filter((name) => name.endsWith(".tmp")), []);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refusals: origin 403, version or path 400, a model with no artifact 404", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-lamps-"));
  const visual = join(root, "visual");
  await mkdir(visual);
  const hash = await publish(visual, CITY);
  try {
    await withGateway({ visualModelsDirectory: visual }, async (base) => {
      assert.equal((await get(base, lamps(CITY), "http://evil.example")).status, 403);
      assert.equal((await get(base, lamps(CITY), null)).status, 403);
      for (const bad of [
        `/visual/wmo-lamps?path=${encodeURIComponent(CITY)}&v=2`,
        `/visual/wmo-lamps?path=${encodeURIComponent(CITY)}`,
        lamps("World\\Generic\\Lamp.m2"),
        lamps("..\\..\\secret.wmo"),
        lamps("C:\\Windows\\x.wmo"),
        lamps(""),
      ]) {
        const answer = await get(base, bad);
        assert.equal(answer.status, 400, bad);
        assert.equal(answer.headers.get("access-control-allow-origin"), ORIGIN, "a refusal the page can read");
      }
      assert.equal((await get(base, lamps("World\\wmo\\Nowhere\\Nothing.wmo"))).status, 404, "no artifact, no generator");
      // A root whose group file went missing, with no generator to publish it again: nothing will make it (404, as
      // `/visual/model` answers that group); the page lights the lamp posts as groups arrive. Nothing is kept.
      await rm(join(visual, `${hash}.g000.bin`));
      assert.equal((await get(base, lamps(CITY))).status, 404);
      assert.deepEqual((await readdir(visual)).filter((name) => name.endsWith(".lamps.json")), [], "nothing kept");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a model not published yet is published on its lane first; a model the client lacks is a 404", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-lamps-"));
  const visual = join(root, "visual");
  await mkdir(visual);
  const published = [];
  let publishWithoutStreet = false;
  try {
    await withGateway({
      visualModelsDirectory: visual,
      generateVisualModel: async (path, hash) => {
        published.push(path);
        if (path.toLowerCase().includes("missing")) throw Object.assign(new Error("not in the client"), { exitCode: 3 });
        assert.equal(hash, visualModelHash(path));
        await publish(visual, path);
        if (publishWithoutStreet) await rm(join(visual, `${hash}.g000.bin`));
      },
    }, async (base) => {
      const answer = await get(base, lamps(CITY));
      assert.equal(answer.status, 200);
      assert.equal((await answer.json()).groups.length, 3);
      assert.deepEqual(published, [CITY]);
      assert.equal((await get(base, lamps(CITY))).status, 200);
      assert.deepEqual(published, [CITY], "published once");
      assert.equal((await get(base, lamps("World\\wmo\\Missing\\Missing.wmo"))).status, 404);
      // A half-published artifact (a group file gone) is published again, once, and then read.
      const hash = visualModelHash(CITY);
      await rm(join(visual, `${hash}.lamps.json`));
      await rm(join(visual, `${hash}.g002.bin`));
      const answer2 = await get(base, lamps(CITY));
      assert.equal(answer2.status, 200);
      assert.equal((await answer2.json()).groups.length, 3);
      assert.equal(published.length, 3, "published again once");
      // A generator that cannot make the group either: a failed read the page retries (500), never "no lamps".
      await rm(join(visual, `${hash}.lamps.json`));
      const broken = visualModelHash(CITY);
      await rm(join(visual, `${broken}.g000.bin`));
      publishWithoutStreet = true;
      assert.equal((await get(base, lamps(CITY))).status, 500);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the client-media latch covers the route like its siblings", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/gateway/Gateway.ts", import.meta.url), "utf8");
  assert.match(source, /\|\| pathname === "\/visual\/wmo-lamps"/);
});
