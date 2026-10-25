// 25.10 (serve S5): the gateway counts what its HTTP routes answered, per route class, without addresses.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import {
  GatewayTraffic, formatTrafficLine, parseTrafficReportEnv, startTrafficReporter, trafficRouteClass,
} from "../dist/code/gateway/GatewayTraffic.js";

const ORIGIN = "http://127.0.0.1:5173";

test("route classes are a closed list: two segments for /visual and /client, the first segment otherwise", () => {
  const cases = {
    "/client/file": "client-file", "/client/interface-bundle": "client-interface-bundle", "/dbc/spells": "dbc",
    "/dbc/light/0": "dbc", "/terrain/0/32/48": "terrain", "/terrain-splat/0/32/48/alpha.png": "terrain-splat",
    "/visual/model": "visual-model", "/visual/environment/0/1/2": "visual-environment", "/texture": "texture",
    "/item-icon/12": "item-icon", "/health": "health", "/gateway/traffic": "gateway",
    "/": "other", "/nonsense/x": "other", "/visual/unknown": "other", "/client": "other",
  };
  for (const [path, expected] of Object.entries(cases)) assert.equal(trafficRouteClass(path), expected, path);
});

test("counters: count, bytes, 200/304/other, total and max ms per class; an interval rolls over", () => {
  const traffic = new GatewayTraffic();
  traffic.record("dbc", 200, 1000, 5);
  traffic.record("dbc", 304, 0, 1);
  traffic.record("dbc", 500, 0, 30);
  traffic.record("texture", 200, 4 * 1024 * 1024, 12);
  const interval = traffic.rollInterval(60);
  assert.deepEqual(interval.get("dbc"), { count: 3, bytes: 1000, status200: 1, status304: 1, statusOther: 1, totalMs: 36, maxMs: 30 });
  const line = formatTrafficLine(interval, 60);
  assert.match(line, /^Gateway traffic, 60 s: 4 requests, 4\.0 MB — texture 1×\/4\.0 MB \(max 12 ms\); dbc 3×\/1 KB \(304 1, err 1, max 30 ms\)$/);
  assert.equal(formatTrafficLine(traffic.rollInterval(60), 60), undefined, "an idle interval prints nothing");
  const snapshot = traffic.snapshot();
  assert.equal(snapshot.totals.dbc.count, 3, "totals survive the roll");
  assert.equal(snapshot.lastInterval.texture.count, 1, "the last interval with traffic is kept");
  assert.doesNotMatch(JSON.stringify(snapshot), /127\.0\.0\.1|::1/, "no addresses");
});

test("the environment: on by default, 0 switches off, a bad interval throws", () => {
  assert.deepEqual(parseTrafficReportEnv({}, "C:\\x"), { intervalMs: 60_000, file: join("C:\\x", ".runtime", "logs", "gateway-traffic.json") });
  assert.equal(parseTrafficReportEnv({ GATEWAY_TRAFFIC_LOG: "0" }, "C:\\x"), undefined);
  assert.equal(parseTrafficReportEnv({ GATEWAY_TRAFFIC_INTERVAL_S: "10", GATEWAY_TRAFFIC_FILE: "D:\\t.json" }, "C:\\x").file, "D:\\t.json");
  assert.throws(() => parseTrafficReportEnv({ GATEWAY_TRAFFIC_INTERVAL_S: "1" }, "C:\\x"), /GATEWAY_TRAFFIC_INTERVAL_S/);
});

test("the reporter prints one line per interval with traffic and rewrites the snapshot file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-traffic-"));
  try {
    const traffic = new GatewayTraffic();
    const lines = [];
    const file = join(directory, "logs", "gateway-traffic.json");
    const reporter = startTrafficReporter(traffic, { intervalMs: 40, file, log: (line) => lines.push(line) });
    traffic.record("terrain", 200, 2048, 3);
    await new Promise((resolve) => setTimeout(resolve, 200));
    reporter.stop();
    assert.equal(lines.length, 1, "idle intervals after the first print nothing");
    assert.match(lines[0], /terrain 1×\/2 KB/);
    const written = JSON.parse(await readFile(file, "utf8"));
    assert.equal(written.totals.terrain.bytes, 2048);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a running gateway counts its answers; /gateway/traffic answers the snapshot to a loopback caller", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-traffic-gw-"));
  try {
    const body = Buffer.alloc(3000, 7);
    await writeFile(join(directory, "1.wdl"), body);
    const gateway = await startGateway({
      host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
      allowedOrigins: [ORIGIN], datasetPollMs: 0, horizonDirectory: directory,
    });
    try {
      const base = `http://127.0.0.1:${gateway.port}`;
      // Identity, so the byte count is the file's own size whatever S1 compresses.
      const headers = { origin: ORIGIN, "accept-encoding": "identity" };
      assert.equal((await (await fetch(`${base}/horizon/1`, { headers })).arrayBuffer()).byteLength, 3000);
      await (await fetch(`${base}/horizon/1`, { headers })).arrayBuffer();
      assert.equal((await fetch(`${base}/horizon/2`, { headers })).status, 404);
      await (await fetch(`${base}/health`)).text();
      const snapshot = await (await fetch(`${base}/gateway/traffic`)).json();
      assert.equal(snapshot.totals.horizon.count, 3);
      assert.equal(snapshot.totals.horizon.status200, 2);
      assert.equal(snapshot.totals.horizon.statusOther, 1);
      assert.equal(snapshot.totals.horizon.bytes, 6000);
      assert.equal(snapshot.totals.health.count, 1);
      assert.ok(snapshot.totals.horizon.maxMs >= 0);
    } finally {
      await gateway.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
