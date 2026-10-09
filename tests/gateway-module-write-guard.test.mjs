import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import {
  assertModuleWritePolicy, isLoopbackOrigin, moduleWritePolicyProblem, moduleWriteRefusal,
} from "../dist/code/gateway/ModuleWritePolicy.js";

/**
 * 10.04 — `MODULE_UI_WRITE=1` next to `ALLOWED_ORIGINS=*` (or any non-loopback page) lets any page
 * open in the owner's browser `PUT` into the modules every player is served. Two layers: the
 * gateway refuses to start with that configuration, and the route refuses a write that does not
 * look like the owner's own page even when the configuration was bypassed.
 */

// The doctor (`tools/check-config.mjs`) keeps a plain-JS copy; it must answer the same table.
process.env.WEBCLIENT_SKIP_ENV = "1";
const { moduleWriteProblem } = await import("../tools/check-config.mjs");

const TABLE = [
  // [moduleWrite, host, origins, refused?]
  [true, "127.0.0.1", ["*"], true],
  [true, "0.0.0.0", ["http://127.0.0.1:5173"], true],
  [true, "127.0.0.1", ["http://192.168.1.5:5173"], true],
  [true, "127.0.0.1", ["http://127.0.0.1:5173", "http://gw.example.net"], true],
  [true, "127.0.0.1", ["http://127.0.0.1:5173", "http://localhost:5173", "http://[::1]:5173"], false],
  [true, "localhost", ["http://localhost:5173"], false],
  [false, "0.0.0.0", ["*"], false],
];

test("writing is accepted only on a loopback-only gateway", () => {
  for (const [moduleWrite, host, allowedOrigins, refused] of TABLE) {
    const label = `${moduleWrite} ${host} ${allowedOrigins.join(",")}`;
    const problem = moduleWritePolicyProblem({ moduleWrite, host, allowedOrigins });
    assert.equal(problem !== undefined, refused, label);
    if (refused) {
      assert.throws(() => assertModuleWritePolicy({ moduleWrite, host, allowedOrigins }), /MODULE_UI_WRITE=1/, label);
    } else {
      assert.doesNotThrow(() => assertModuleWritePolicy({ moduleWrite, host, allowedOrigins }), label);
    }
    const doctor = moduleWriteProblem({
      MODULE_UI_WRITE: moduleWrite ? "1" : "0", GATEWAY_HOST: host, ALLOWED_ORIGINS: allowedOrigins.join(","),
    });
    assert.equal(doctor, problem, `doctor and gateway agree: ${label}`);
  }
  // The message names the variables to change, which is the whole point of refusing to start.
  assert.match(moduleWritePolicyProblem({ moduleWrite: true, host: "0.0.0.0", allowedOrigins: ["*"] }),
    /GATEWAY_HOST=0\.0\.0\.0.*ALLOWED_ORIGINS contains \*/);
});

test("one PUT must look like the owner's own page", () => {
  const local = { origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-site" };
  assert.equal(moduleWriteRefusal(local, "127.0.0.1"), undefined);
  assert.equal(moduleWriteRefusal({ origin: "http://localhost:5173" }, "::ffff:127.0.0.1"), undefined);
  assert.ok(moduleWriteRefusal(local, "192.0.2.1"), "a remote socket");
  assert.ok(moduleWriteRefusal(local, undefined), "no socket address");
  assert.ok(moduleWriteRefusal({ ...local, "x-forwarded-for": "203.0.113.9" }, "127.0.0.1"), "a proxy");
  assert.ok(moduleWriteRefusal({ ...local, forwarded: "for=203.0.113.9" }, "127.0.0.1"));
  assert.ok(moduleWriteRefusal({ ...local, "x-real-ip": "203.0.113.9" }, "127.0.0.1"));
  // A loopback page on the other loopback name (localhost:5173 -> 127.0.0.1:8090, which 10.03 lets a
  // link choose) is "cross-site" to the browser, yet it is the owner's own page: the Origin says so,
  // and ALLOWED_ORIGINS has already admitted that exact origin before this check runs.
  assert.equal(moduleWriteRefusal({ origin: "http://localhost:5173", "sec-fetch-site": "cross-site" }, "127.0.0.1"), undefined);
  assert.ok(moduleWriteRefusal({ origin: "https://evil.example" }, "127.0.0.1"), "a foreign page");
  assert.ok(moduleWriteRefusal({}, "127.0.0.1"), "no Origin at all");
  assert.equal(isLoopbackOrigin("http://127.8.9.10:1"), true);
  assert.equal(isLoopbackOrigin("http://127.0.0.1.evil.example"), false);
  assert.equal(isLoopbackOrigin("null"), false);
});

test("the route refuses a write that the configuration check would have caught", async () => {
  const draftRoot = await mkdtemp(join(tmpdir(), "webclient-drafts-"));
  const roots = [{ root: draftRoot, inner: "", source: "draft" }];
  const body = JSON.stringify({ kind: "addon", id: "guarded", params: { screen: {} } });
  // `startGateway` itself does not assert the policy (the configuration does), so this gateway is
  // the "bypassed" case: every origin allowed and writing on.
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["*"],
    moduleDirectories: roots,
    moduleWrite: true,
  });
  try {
    const url = `http://127.0.0.1:${gateway.port}/modules/ui/shop/guarded.json`;
    const put = (headers) => fetch(url, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body });
    assert.equal((await put({ origin: "https://evil.example" })).status, 405, "a foreign page");
    assert.equal((await put({ origin: "http://127.0.0.1:5173", "x-forwarded-for": "203.0.113.9" })).status, 405);
    await assert.rejects(readFile(join(draftRoot, "shop", "ui", "guarded.json")), "nothing was written");
    // The preflight offers PUT only to a page on this machine.
    const preflight = (origin) => fetch(url, {
      method: "OPTIONS", headers: { origin, "access-control-request-method": "PUT" },
    });
    assert.equal((await preflight("https://evil.example")).headers.get("access-control-allow-methods"), "GET");
    assert.equal((await preflight("http://127.0.0.1:5173")).headers.get("access-control-allow-methods"), "GET, PUT");
    // And the owner's own page still writes.
    assert.equal((await put({ origin: "http://127.0.0.1:5173" })).status, 204);
    assert.equal((await put({ origin: "http://localhost:5173", "sec-fetch-site": "cross-site" })).status, 204,
      "the owner's page under the other loopback name");
    assert.equal(await readFile(join(draftRoot, "shop", "ui", "guarded.json"), "utf8"), body);
  } finally {
    await gateway.close();
    await rm(draftRoot, { recursive: true, force: true });
  }
});
