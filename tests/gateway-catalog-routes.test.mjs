import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// М2 «Новый DBC-маршрут», the gateway half (docs/implementation/line-A3.ru.md): the catalog routes
// of gateway/CatalogRoutes.ts through their one connection point in Gateway.ts — 403 for a foreign
// Origin, 400 for another `?v=`, 200 JSON never cached, 500 on a table that does not match
// DBCfmt.h with the memo dropped so the next request reads the disk again, and the memo living in
// DatasetIndexes so a rebuilt dataset is served without a restart. The handler listens on
// 127.0.0.1 port 0 over a synthetic DBC directory; nothing here talks to the running gateway.
const { createGatewayAssetHandler } = await import("../dist/code/gateway/Gateway.js");
const { CATALOG_ROUTES, serveCatalogRoute } = await import("../dist/code/gateway/CatalogRoutes.js");
const { AREA_TRIGGERS_VERSION } = await import("../dist/code/gateway/AreaTriggerMetadata.js");

const ORIGIN = "http://127.0.0.1:5173";
const ROUTE = "/dbc/area-triggers";

/** A WDBC image of AreaTrigger rows, `niffffffff` unless a wrong layout is asked for. */
function areaTriggerDbc(rows, { fields = 10, recordSize = 40 } = {}) {
  const data = Buffer.alloc(20 + rows.length * recordSize + 1);
  data.write("WDBC", 0, "latin1");
  data.writeUInt32LE(rows.length, 4);
  data.writeUInt32LE(fields, 8);
  data.writeUInt32LE(recordSize, 12);
  data.writeUInt32LE(1, 16);
  rows.forEach((row, index) => {
    const at = 20 + index * recordSize;
    data.writeInt32LE(row[0], at);
    data.writeInt32LE(row[1], at + 4);
    for (let field = 2; field < 10 && field * 4 < recordSize; field++) data.writeFloatLE(row[field], at + field * 4);
  });
  return data;
}

const DEEPRUN = [2166, 369, 76.027, 10.5043, -4.29659, 0, 9.417, 19, 20.64, 0];
const STORMWIND = [2173, 0, -8346.46, 514.031, 96.5989, 10, 0, 0, 0, 0];

async function listen(dbcDirectory, datasetPollMs = 3_600_000) {
  const assets = await createGatewayAssetHandler({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [ORIGIN],
    ...(dbcDirectory ? { dbcDirectory } : {}),
    datasetPollMs,
  });
  const server = createServer(assets.handle);
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: (path, origin = ORIGIN) => fetch(`${base}${path}`, origin ? { headers: { origin } } : {}),
    async close() {
      await new Promise((resolve) => { server.close(resolve); });
      assets.close();
    },
  };
}

async function dataset(rows, layout) {
  const directory = await mkdtemp(join(tmpdir(), "catalog-routes-"));
  await writeFile(join(directory, "AreaTrigger.dbc"), areaTriggerDbc(rows, layout));
  return directory;
}

test("the table names area-triggers at the version its loader answers with", () => {
  const route = CATALOG_ROUTES.find((candidate) => candidate.pathname === ROUTE);
  assert.ok(route, "the 2.01 route is a row of the table");
  assert.equal(route.version, AREA_TRIGGERS_VERSION);
  assert.equal(new Set(CATALOG_ROUTES.map((candidate) => candidate.pathname)).size, CATALOG_ROUTES.length);
});

test("403 without an allowed Origin, 400 for another ?v=, 200 JSON never cached", async () => {
  const directory = await dataset([STORMWIND, DEEPRUN]);
  const gateway = await listen(directory);
  try {
    assert.equal((await gateway.get(`${ROUTE}?v=1`, null)).status, 403, "no Origin at all");
    assert.equal((await gateway.get(`${ROUTE}?v=1`, "http://evil.example")).status, 403);

    const wrong = await gateway.get(`${ROUTE}?v=2`);
    assert.equal(wrong.status, 400);
    assert.equal(wrong.headers.get("access-control-allow-origin"), ORIGIN, "the page can read why");
    assert.equal((await gateway.get(ROUTE)).status, 400, "a request that names no shape");

    const response = await gateway.get(`${ROUTE}?v=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
    const body = await response.json();
    assert.equal(body.version, AREA_TRIGGERS_VERSION);
    assert.deepEqual(body.triggers, [DEEPRUN, STORMWIND], "ascending by id, floats as the file holds them");
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("500 on a table that does not match DBCfmt.h, and the next request reads the disk again", async () => {
  const directory = await dataset([DEEPRUN], { fields: 9, recordSize: 36 });
  // An hour between dataset polls: the recovery below is the route dropping its failed memo, not
  // DatasetFingerprint noticing the file changed.
  const gateway = await listen(directory, 3_600_000);
  try {
    const broken = await gateway.get(`${ROUTE}?v=1`);
    assert.equal(broken.status, 500);
    assert.equal(broken.headers.get("access-control-allow-origin"), ORIGIN);
    await writeFile(join(directory, "AreaTrigger.dbc"), areaTriggerDbc([DEEPRUN]));
    const fixed = await gateway.get(`${ROUTE}?v=1`);
    assert.equal(fixed.status, 200, "a rejected read is not what the next request is served");
    assert.deepEqual((await fixed.json()).triggers, [DEEPRUN]);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a rebuilt dataset is served without a restart: the memo is a DatasetIndexes field", async () => {
  const directory = await dataset([DEEPRUN]);
  const gateway = await listen(directory, 0);
  try {
    assert.deepEqual((await (await gateway.get(`${ROUTE}?v=1`)).json()).triggers, [DEEPRUN]);
    assert.deepEqual((await (await gateway.get(`${ROUTE}?v=1`)).json()).triggers, [DEEPRUN], "memoised");
    await writeFile(join(directory, "AreaTrigger.dbc"), areaTriggerDbc([STORMWIND, DEEPRUN]));
    assert.deepEqual((await (await gateway.get(`${ROUTE}?v=1`)).json()).triggers, [DEEPRUN, STORMWIND]);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("without a DBC directory the route is simply not there", async () => {
  const gateway = await listen(undefined);
  try {
    assert.equal((await gateway.get(`${ROUTE}?v=1`)).status, 404);
  } finally {
    await gateway.close();
  }
});

test("two requests at once share one read; a loader that throws is a 500, not a crash", async () => {
  let loads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const routes = [
    { pathname: "/dbc/slow", version: 3, load: async () => { loads++; await gate; return { version: 3 }; } },
    { pathname: "/dbc/throws", version: 1, load: () => { throw new Error("synchronous"); } },
  ];
  const cache = new Map();
  const server = createServer((request, response) => {
    void serveCatalogRoute(request, response, new URL(request.url, "http://gateway.local"), cache,
      { dbcDirectory: "unused", allowedOrigins: [ORIGIN] }, routes).then((served) => {
      if (!served) response.writeHead(404).end();
    });
  });
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = fetch(`${base}/dbc/slow?v=3`, { headers: { origin: ORIGIN } });
    const second = fetch(`${base}/dbc/slow?v=3`, { headers: { origin: ORIGIN } });
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    release();
    const answers = await Promise.all([first, second]);
    assert.deepEqual(answers.map((answer) => answer.status), [200, 200]);
    assert.equal(loads, 1);
    const thrown = await fetch(`${base}/dbc/throws?v=1`, { headers: { origin: ORIGIN } });
    assert.equal(thrown.status, 500);
    assert.equal(cache.has("/dbc/throws"), false, "the failure is not memoised");
    assert.equal((await fetch(`${base}/dbc/other?v=1`, { headers: { origin: ORIGIN } })).status, 404,
      "a path outside the table is left to the caller");
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
});
