// 25.10 — the players' site in front of the game (bat\32): routes, open registration and the SRP6
// verifier the page computes for TrinityCore's auth database.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { accountSql, createRegistrar, loginDatabase, validateRegistration } from "../tools/account-register.mjs";
import { playerSiteHandler } from "../tools/player-site.mjs";
import { computeSrpProof } from "../dist/code/auth/Srp6.js";
import { registrationData, sha1 } from "../site/srp.js";

const N = 0x894b645e89e1535bbdad5b8b290650530801b18ebfbf5e8fab3c82872a3e9bb7n;
const G = 7n;
const siteRoot = fileURLToPath(new URL("../site", import.meta.url));

const nodeSha1 = (...parts) => new Uint8Array(parts.reduce((hash, part) => hash.update(part), createHash("sha1")).digest());
const fromLe = (bytes) => [...bytes].reverse().reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
const toLe = (value, length) => Uint8Array.from({ length }, (_, index) => Number((value >> BigInt(index * 8)) & 0xffn));
function modPow(base, exponent, modulus) {
  let result = 1n;
  for (let factor = base % modulus, power = exponent; power > 0n; power >>= 1n, factor = (factor * factor) % modulus) {
    if (power & 1n) result = (result * factor) % modulus;
  }
  return result;
}

test("the page's SHA-1 is SHA-1", () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 200]) {
    const bytes = randomBytes(length);
    assert.deepEqual(sha1(new Uint8Array(bytes)), nodeSha1(bytes), `length ${length}`);
  }
});

test("a verifier made on the page lets the login of src/auth through an authserver-side SRP6 check", async () => {
  const salt = new Uint8Array(randomBytes(32));
  const data = registrationData("Friend42", "Secret!pass", salt);
  assert.equal(data.username, "FRIEND42");
  assert.equal(data.salt, Buffer.from(salt).toString("hex"));
  // TrinityCore's formula, independently: v = g ^ SHA1(s ‖ SHA1(U ":" P)) mod N, little-endian.
  const x = fromLe(nodeSha1(salt, nodeSha1(Buffer.from("FRIEND42:SECRET!PASS"))));
  const v = modPow(G, x, N);
  assert.equal(data.verifier, Buffer.from(toLe(v, 32)).toString("hex"));

  // The authserver's half (AuthSession / SRP6): B = 3v + g^b; the client proves M1 typed in lower case.
  const b = fromLe(randomBytes(19));
  const B = toLe((3n * v + modPow(G, b, N)) % N, 32);
  const proof = await computeSrpProof("friend42", "secret!pass", { B, g: Uint8Array.of(7), N: toLe(N, 32), salt });
  const A = fromLe(proof.A);
  const u = fromLe(nodeSha1(proof.A, B));
  const S = toLe(modPow((A * modPow(v, u, N)) % N, b, N), 32);
  const even = nodeSha1(S.filter((_, i) => i % 2 === 0));
  const odd = nodeSha1(S.filter((_, i) => i % 2 === 1));
  const K = Uint8Array.from({ length: 40 }, (_, i) => (i % 2 ? odd : even)[i >> 1]);
  const ng = nodeSha1(toLe(N, 32)).map((byte, i) => byte ^ nodeSha1(Uint8Array.of(7))[i]);
  const M1 = nodeSha1(ng, nodeSha1(Buffer.from("FRIEND42")), salt, proof.A, B, K);
  assert.deepEqual(proof.M1, M1);

  const wrong = await computeSrpProof("friend42", "other-pass", { B, g: Uint8Array.of(7), N: toLe(N, 32), salt });
  assert.notDeepEqual(wrong.M1, M1, "another password does not pass");
});

test("the page refuses names and passwords the server or the clients would read differently", () => {
  for (const name of ["ab", "seventeen_chars_x", "имя", "with space", "a-b"]) assert.throws(() => registrationData(name, "password1"));
  for (const password of ["short", "seventeen-chars-x", "with space", "пароль123"]) assert.throws(() => registrationData("Friend", password));
});

test("the server validates what it writes and builds TrinityCore's two statements", () => {
  const good = registrationData("Friend", "password1");
  const checked = validateRegistration(good);
  assert.equal(checked.username, "FRIEND");
  const sql = accountSql(checked);
  assert.match(sql, /^INSERT INTO account \(username, salt, verifier, reg_mail, email, joindate\) VALUES \('FRIEND', 0x[0-9a-f]{64}, 0x[0-9a-f]{64}, '', '', NOW\(\)\);/);
  assert.match(sql, /INSERT INTO realmcharacters \(realmid, acctid, numchars\) SELECT realmlist\.id, account\.id, 0 FROM realmlist, account LEFT JOIN realmcharacters ON acctid = account\.id WHERE acctid IS NULL;$/);

  assert.equal(validateRegistration({ ...good, username: "x'; DROP TABLE account; --" }).error, "bad-username");
  assert.equal(validateRegistration({ ...good, salt: "00".repeat(32) }).error, "bad-request");
  assert.equal(validateRegistration({ ...good, verifier: "zz".repeat(32) }).error, "bad-request");
  assert.equal(validateRegistration({ ...good, verifier: Buffer.from(toLe(N, 32)).toString("hex") }).error, "bad-request", "v ≥ N");
  assert.equal(validateRegistration({ ...good, verifier: "00".repeat(32) }).error, "bad-request", "v = 0");
  assert.equal(validateRegistration(null).error, "bad-request");
  assert.equal(validateRegistration([]).error, "bad-username");

  assert.deepEqual(loginDatabase('# c\nLoginDatabaseInfo = "127.0.0.1;3306;u;p;auth"\n'), { host: "127.0.0.1", port: "3306", user: "u", password: "p", database: "auth" });
  assert.throws(() => loginDatabase("WorldDatabaseInfo = \"a;b;c;d;e\""));
});

test("the registrar answers taken names, failures and too many attempts", async () => {
  const names = new Set();
  let failing = false;
  const run = async (sql) => {
    if (failing) throw new Error("mysql down");
    const name = /VALUES \('([A-Z0-9]+)'/.exec(sql)[1];
    if (names.has(name)) return "duplicate";
    names.add(name);
    return "ok";
  };
  let clock = 0;
  const register = createRegistrar({ run, now: () => clock, log: () => {} });
  const data = (name) => registrationData(name, "password1");

  assert.deepEqual(await register("1.1.1.1", data("Alpha")), { status: 201, body: { ok: true, username: "ALPHA" } });
  assert.deepEqual(await register("2.2.2.2", data("alpha")), { status: 409, body: { error: "taken" } }, "names compare upper-cased");
  assert.equal((await register("1.1.1.1", { username: "x" })).status, 400);
  failing = true;
  assert.deepEqual(await register("3.3.3.3", data("Gamma")), { status: 503, body: { error: "unavailable" } });
  failing = false;

  assert.equal((await register("1.1.1.1", data("Beta"))).status, 201);
  assert.equal((await register("1.1.1.1", data("Delta"))).status, 201);
  assert.deepEqual(await register("1.1.1.1", data("Epsilon")), { status: 429, body: { error: "too-many" } }, "three accounts an hour per address");
  clock += 61 * 60_000;
  assert.equal((await register("1.1.1.1", data("Epsilon"))).status, 201, "an hour later again");

  for (let i = 0; i < 20; i++) await register("4.4.4.4", { username: "x" });
  assert.deepEqual(await register("4.4.4.4", data("Zeta")), { status: 429, body: { error: "too-many" } }, "twenty requests in ten minutes");

  const parallel = await Promise.all(["Eta", "eta", "ETA"].map((name, i) => register(`5.5.5.${i}`, data(name))));
  assert.deepEqual(parallel.map((r) => r.status).sort(), [201, 409, 409], "one at a time: one wins");
});

/** Raw request: fetch would follow redirects and hide them. */
function call(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function serving(options, run) {
  const web = await mkdtemp(join(tmpdir(), "webclient-site-"));
  await mkdir(join(web, "assets"));
  await writeFile(join(web, "index.html"), "<!doctype html><title>the game</title>");
  await writeFile(join(web, "glue.html"), "<!doctype html><title>bench</title>");
  await writeFile(join(web, "assets", "main-1a2B3c_D.js"), "console.log(1)");
  const manifest = join(web, "latest.json");
  await writeFile(manifest, "{}");
  const server = createServer(playerSiteHandler({ webRoot: web, siteRoot, files: { "/player/latest.json": manifest }, ...options }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(server.address().port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(web, { recursive: true, force: true });
  }
}

test("the site answers /, the game moves to /play/, the app goes straight to the game", async () => {
  await serving({}, async (port) => {
    const landing = await call(port, "/");
    assert.equal(landing.status, 200);
    assert.match(landing.text, /Регистрация/);
    assert.match((await call(port, "/index.html")).text, /Регистрация/);
    assert.match((await call(port, "/site/site.css")).headers["content-type"], /text\/css/);
    assert.equal((await call(port, "/site/srp.js")).status, 200);

    assert.match((await call(port, "/play/")).text, /the game/);
    assert.match((await call(port, "/play/index.html")).text, /the game/);
    assert.deepEqual([(await call(port, "/play?x=1")).status, (await call(port, "/play?x=1")).headers.location], [301, "/play/?x=1"]);
    assert.equal((await call(port, "/assets/main-1a2B3c_D.js")).status, 200, "bundles stay at /assets");
    assert.equal((await call(port, "/play/assets/main-1a2B3c_D.js")).status, 200, "and relative paths under /play/ work");
    assert.equal((await call(port, "/player/latest.json")).status, 200, "the app's updates stay where installed apps look");
    assert.equal((await call(port, "/glue.html")).status, 404, "benches stay private");
    assert.equal((await call(port, "/play/glue.html")).status, 404);
    assert.equal((await call(port, "/site/../index.html")).status, 200, "normalised by URL, still the site");

    const app = { "user-agent": "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Electron/33.2.0 Safari/537.36" };
    const fromApp = await call(port, "/", { headers: app });
    assert.deepEqual([fromApp.status, fromApp.headers.location], [302, "/play/"]);
    assert.equal((await call(port, "/play/", { headers: app })).status, 200);
  });
});

test("/api/register takes a small JSON POST and hands it to the registrar", async () => {
  const seen = [];
  const register = async (address, body) => {
    seen.push([address, body]);
    return { status: 201, body: { ok: true, username: body.username } };
  };
  await serving({ register }, async (port) => {
    const json = { "content-type": "application/json" };
    const ok = await call(port, "/api/register", { method: "POST", headers: json, body: JSON.stringify({ username: "A" }) });
    assert.deepEqual([ok.status, JSON.parse(ok.text), ok.headers["cache-control"]], [201, { ok: true, username: "A" }, "no-store"]);
    assert.equal(seen[0][0], "127.0.0.1");
    assert.equal((await call(port, "/api/register")).status, 405);
    assert.equal((await call(port, "/api/register", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
    assert.equal((await call(port, "/api/register", { method: "POST", headers: json, body: "not json" })).status, 400);
    assert.equal((await call(port, "/api/register", { method: "POST", headers: json, body: "null" })).status, 400);
    // A body over 1 KB is cut off: the connection closes, or a 400 gets out first.
    const oversize = await call(port, "/api/register", { method: "POST", headers: json, body: "x".repeat(64 * 1024) })
      .then((r) => r.status, () => "closed");
    assert.ok(oversize === 400 || oversize === "closed", String(oversize));
    assert.equal(seen.length, 1);
    assert.deepEqual(JSON.parse((await call(port, "/api/site")).text), { registration: true });
  });
  await serving({}, async (port) => {
    const closed = await call(port, "/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.deepEqual([closed.status, JSON.parse(closed.text)], [403, { error: "closed" }]);
    assert.deepEqual(JSON.parse((await call(port, "/api/site")).text), { registration: false });
  });
});
