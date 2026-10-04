// L10 — the Electron shell without Electron: where the page's gateway is (10.17: server.json and the
// command line instead of a fixed 8090) and whether the checkout's built gateway is stale (10.11,
// slice 3), plus source pins for the wiring in main.cjs and build.mjs, which need Electron to run.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  chooseGatewaySettings, gatewayTarget, insecureOriginsToTrust, parseGatewaySettings, playerServerConfig,
} = require("../electron/gateway-target.cjs");
const { describeStaleness, gatewayBuildState } = require("../electron/gateway.cjs");

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

test("server.json gateway settings: optional, checked, and said in words when wrong", () => {
  assert.deepEqual(parseGatewaySettings({ url: "http://203.0.113.10:8091/" }), {});
  assert.deepEqual(parseGatewaySettings(undefined), {});
  assert.deepEqual(parseGatewaySettings({ gatewayPort: 9000 }), { gatewayPort: 9000 });
  assert.deepEqual(parseGatewaySettings({ gatewayUrl: "https://gw.example:8443/ignored/path" }), { gatewayUrl: "https://gw.example:8443" });
  assert.throws(() => parseGatewaySettings({ gatewayPort: 99999 }, "C:/app/server.json"), /C:\/app\/server\.json: gatewayPort/);
  assert.throws(() => parseGatewaySettings({ gatewayPort: "9000" }), /gatewayPort/, "a JSON string is not a port");
  assert.throws(() => parseGatewaySettings({ gatewayPort: Number.NaN }, "--gateway-port"), /--gateway-port/);
  assert.throws(() => parseGatewaySettings({ gatewayUrl: "ftp://gw.example/" }), /gatewayUrl/);
  assert.throws(() => parseGatewaySettings({ gatewayUrl: "not a url" }), /gatewayUrl/);
});

test("the command line replaces server.json's gateway as a whole", () => {
  assert.deepEqual(chooseGatewaySettings({ gatewayUrl: "https://gw.example" }, {}), { gatewayUrl: "https://gw.example" });
  assert.deepEqual(chooseGatewaySettings({ gatewayUrl: "https://gw.example" }, { gatewayPort: 9100 }), { gatewayPort: 9100 });
});

test("the gateway is the page host's 8090 unless configured; a configured one reaches the page as ?gateway=", () => {
  const page = "http://203.0.113.10:8091/";
  assert.deepEqual(gatewayTarget(page), {
    origin: "http://203.0.113.10:8090", hostname: "203.0.113.10", port: 8090, pageUrl: page,
  });
  const moved = gatewayTarget(page, { gatewayPort: 9000 });
  assert.equal(moved.origin, "http://203.0.113.10:9000");
  assert.equal(moved.port, 9000);
  assert.equal(new URL(moved.pageUrl).searchParams.get("gateway"), "http://203.0.113.10:9000");
  assert.equal(new URL(moved.pageUrl).pathname, "/");
  const https = gatewayTarget("https://wow.example/?framexml=1");
  assert.equal(https.origin, "https://wow.example:8090", "the page's scheme, as Environment.gatewayOrigin does");
  const elsewhere = gatewayTarget("https://wow.example/?framexml=1", { gatewayUrl: "https://gw.example" });
  assert.deepEqual([elsewhere.hostname, elsewhere.port], ["gw.example", 443]);
  assert.equal(new URL(elsewhere.pageUrl).searchParams.get("framexml"), "1", "the page's own query stays");
  assert.equal(new URL(elsewhere.pageUrl).searchParams.get("gateway"), "https://gw.example");
  const asked = gatewayTarget("http://203.0.113.10:8091/?gateway=203.0.113.10:9100");
  assert.deepEqual([asked.origin, asked.pageUrl], ["http://203.0.113.10:9100", "http://203.0.113.10:8091/?gateway=203.0.113.10:9100"],
    "a ?gateway= the address already carries is where the page goes, so the shell waits there");
  const overridden = gatewayTarget("http://203.0.113.10:8091/?gateway=203.0.113.10:9100", { gatewayPort: 9200 });
  assert.equal(new URL(overridden.pageUrl).searchParams.get("gateway"), "http://203.0.113.10:9200");
  const ipv6 = gatewayTarget("http://[2001:db8::1]:8091/");
  assert.deepEqual([ipv6.origin, ipv6.hostname], ["http://[2001:db8::1]:8090", "[2001:db8::1]"]);
});

test("only a plain-http page on a public address, and its http gateway, are marked secure", () => {
  assert.deepEqual(insecureOriginsToTrust("http://203.0.113.10:8091/", "http://203.0.113.10:9000"),
    ["http://203.0.113.10:8091", "http://203.0.113.10:9000"]);
  assert.deepEqual(insecureOriginsToTrust("http://203.0.113.10:8091/", "https://gw.example"), ["http://203.0.113.10:8091"]);
  assert.deepEqual(insecureOriginsToTrust("http://127.0.0.1:5173/", "http://127.0.0.1:8090"), []);
  assert.deepEqual(insecureOriginsToTrust("https://wow.example/", "https://wow.example:8090"), []);
});

test("the player app's server.json carries the gateway only when it is not the default", () => {
  const url = "http://203.0.113.10:8091/";
  assert.deepEqual(playerServerConfig(url), { url, cpuClass: "none", priority: "normal" });
  assert.deepEqual(playerServerConfig(url, { gatewayPort: 8090 }), { url, cpuClass: "none", priority: "normal" });
  assert.deepEqual(playerServerConfig(url, { gatewayPort: 9000 }), { url, cpuClass: "none", priority: "normal", gatewayPort: 9000 });
  assert.deepEqual(playerServerConfig(url, { gatewayUrl: "https://gw.example" }),
    { url, cpuClass: "none", priority: "normal", gatewayUrl: "https://gw.example" });
});

test("the freshness check's exit codes: 0 stale, 1 current, anything else unknown and never blocking", () => {
  assert.deepEqual(describeStaleness(0, "Gateway build is stale: src/gateway/Gateway.ts changed after the last build.\n"),
    { stale: true, text: "Gateway build is stale: src/gateway/Gateway.ts changed after the last build." });
  assert.deepEqual(describeStaleness(1, "Gateway build is current.\n"), { stale: false });
  const crashed = describeStaleness(-1, "spawn node ENOENT");
  assert.equal(crashed.stale, false);
  assert.equal(crashed.unknown, true);
  assert.match(crashed.text, /ENOENT/);
  assert.equal(describeStaleness(2, "").stale, false);
});

test("gatewayBuildState asks the checkout's build-gateway.mjs and reads its answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webclient-electron-stale-"));
  const put = (path, text = "") => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const age = (path, seconds) => {
    const at = new Date(Date.now() - seconds * 1000);
    utimesSync(join(dir, path), at, at);
  };
  try {
    assert.equal((await gatewayBuildState(dir, { node: process.execPath })).unknown, true, "an older checkout without the tool is not a stale one");
    mkdirSync(join(dir, "tools"));
    for (const tool of ["build-gateway.mjs", "gateway-sources.mjs"]) copyFileSync(join(root, "tools", tool), join(dir, "tools", tool));
    put("tsconfig.json", "{}");
    put("tsconfig.gateway.json", JSON.stringify({ include: ["src/gateway/**/*.ts"] }));
    put("src/gateway/main.ts", "export {};\n");
    put("dist/code/gateway/main.js");
    for (const path of ["tsconfig.json", "tsconfig.gateway.json", "src/gateway/main.ts"]) age(path, 60);
    age("dist/code/gateway/main.js", 30);
    assert.deepEqual(await gatewayBuildState(dir, { node: process.execPath }), { stale: false });
    age("src/gateway/main.ts", 0);
    const stale = await gatewayBuildState(dir, { node: process.execPath });
    assert.equal(stale.stale, true);
    assert.match(stale.text, /src\/gateway\/main\.ts changed after the last build/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main.cjs takes the gateway from gateway-target.cjs and holds back a stale local gateway", () => {
  const main = read("electron/main.cjs");
  assert.doesNotMatch(main, /\$\{page\.hostname\}:\$\{GATEWAY_PORT\}/, "no gateway origin built from a fixed port");
  assert.doesNotMatch(main, /\bGATEWAY_PORT\b/, "no fixed gateway port left");
  assert.match(main, /require\("\.\/gateway-target\.cjs"\)/);
  assert.match(main, /gatewayTarget\(explicitUrl, gatewaySettings\)/, "the secure-origin switch uses the configured gateway");
  assert.match(main, /const pageUrl = await resolveGamePageUrl\(\)/, "the page gets ?gateway= when one is configured");
  assert.match(main, /listening\(gateway\.port, host\)/, "the player app waits for the configured gateway");
  assert.match(main, /--allow-stale/);
  assert.match(main, /showStaleGatewayBuild\(window, root\)/, "the built page checks freshness before starting a gateway");
  // L10-review: the built page with --gateway-url on another host probed 127.0.0.1:<that port>, tried
  // to start this checkout's gateway there and waited on 127.0.0.1 for good. A gateway elsewhere is
  // waited for where it is, like a players' server's; only a loopback one is started here.
  assert.match(main, /if \(remoteUrl !== undefined \|\| !LOOPBACK_HOSTS\.has\(gateway\.hostname\)\)/,
    "a configured gateway on another host is waited for, never started here");
  const build = read("electron/build.mjs");
  const files = /const APP_FILES = \[([^\]]*)\]/.exec(build)?.[1] ?? "";
  assert.ok(files.includes('"gateway-target.cjs"'), "gateway-target.cjs must be packed or the app cannot require it");
  assert.match(build, /playerServerConfig\(/, "server.json is written by the tested function");
});
