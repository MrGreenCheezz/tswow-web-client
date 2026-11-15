// 10.30 (15.11) — registration and password change from the login screen: the gateway's /account routes
// (AccountRoutes.ts, AccountSelfService.ts, AccountSql.ts) and the page's client (GlueAccountClient.ts), with
// a stand-in for the auth database (the query layer injected) and an authserver-side SRP6 in this file. Nothing
// here reaches a real database: the only SqlRunner used is `memoryAuthDatabase` below.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import { AccountSelfService } from "../dist/code/gateway/AccountSelfService.js";
import { serveAccountRoute, parseAccountRoutesEnv, parseReservedAccountNames } from "../dist/code/gateway/AccountRoutes.js";
import { mysqlScript, sqlParamLiteral, parseBatchRows, loginDatabase } from "../dist/code/gateway/AccountSql.js";
import { GlueAccountClient } from "../dist/code/browser/glue/GlueAccountClient.js";
import { makeRegistrationData } from "../dist/code/auth/SrpRegistration.js";
import { passwordChangeMessage, bytesToHex } from "../dist/code/auth/AccountWire.js";
import { hmacSha1 } from "../dist/code/auth/Sha1.js";

const N = 0x894b645e89e1535bbdad5b8b290650530801b18ebfbf5e8fab3c82872a3e9bb7n;
const G = 7n;
const ORIGIN = "http://127.0.0.1:5173";

const sha1 = (...parts) => new Uint8Array(parts.reduce((hash, part) => hash.update(part), createHash("sha1")).digest());
const fromLe = (bytes) => [...bytes].reverse().reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
const toLe = (value, length) => Uint8Array.from({ length }, (_, index) => Number((value >> BigInt(index * 8)) & 0xffn));
const hex = (bytes) => Buffer.from(bytes).toString("hex");
function modPow(base, exponent, modulus) {
  let result = 1n;
  for (let factor = base % modulus, power = exponent; power > 0n; power >>= 1n, factor = (factor * factor) % modulus) {
    if (power & 1n) result = (result * factor) % modulus;
  }
  return result;
}

const TC_COLUMNS = ["id", "username", "salt", "verifier", "session_key_auth", "session_key_bnet", "totp_secret", "email",
  "reg_mail", "joindate", "last_ip", "last_attempt_ip", "failed_logins", "locked", "lock_country", "last_login", "online",
  "expansion", "mutetime", "mutereason", "muteby", "locale", "os", "timezone_offset", "recruiter"];
const AC_COLUMNS = ["id", "username", "salt", "verifier", "session_key", "totp_secret", "email", "reg_mail", "joindate",
  "last_ip", "last_attempt_ip", "failed_logins", "locked", "lock_country", "last_login", "online", "expansion", "Flags",
  "mutetime", "mutereason", "muteby", "locale", "os", "recruiter", "totaltime"];

/**
 * The stand-in for the auth database: understands exactly the constant statements the service sends (by their
 * text) and keeps `account` rows in memory, with the unique name key. Records every statement it ran.
 */
function memoryAuthDatabase({ columns = TC_COLUMNS, fail, now = () => Date.now(), beforeUpdate } = {}) {
  const accounts = [];
  const statements = [];
  const keyColumn = columns.includes("session_key_auth") ? "session_key_auth" : "session_key";
  // As MySQL: a freshness condition in the text is applied by the database's clock (`now`), and only when present.
  const FRESH = "last_login >= NOW() - INTERVAL 300 SECOND";
  const fresh = (row, text) => !text.includes(FRESH) || (row.lastLogin !== undefined && now() - row.lastLogin <= 300_000);
  let rowCount = 0;
  const run = async (list) => {
    if (fail) return { ok: false, errno: fail };
    const rows = [];
    for (const statement of list) {
      statements.push(statement);
      const { text, params } = statement;
      if (text === "START TRANSACTION" || text === "COMMIT") {
        // One script per call; a failing statement stops it before COMMIT (batch mode), which the checks below model.
      } else if (text.startsWith("SELECT COLUMN_NAME FROM information_schema.COLUMNS")) {
        rows.push(...columns.map((column) => [column]));
      } else if (text.startsWith("INSERT INTO account ")) {
        const [username, salt, verifier, regMail, email] = params;
        if (accounts.some((row) => row.username === username)) return { ok: false, errno: 1062 };
        accounts.push({ id: accounts.length + 1, username, salt, verifier, regMail, email, key: null });
      } else if (text.startsWith("INSERT INTO realmcharacters")) {
        // TrinityCore's init statement: nothing to model here.
      } else if (text.startsWith(`SELECT id, HEX(${keyColumn}) FROM account WHERE username = ?`)) {
        const row = accounts.find((account) => account.username === params[0] && fresh(account, text));
        if (row) rows.push([String(row.id), row.key ? hex(row.key).toUpperCase() : "NULL"]);
      } else if (text.startsWith("UPDATE account SET salt = ?, verifier = ?")) {
        beforeUpdate?.(accounts);
        const setsKey = text.includes(`${keyColumn} = ? WHERE`);
        const keyed = text.includes(`AND ${keyColumn} = ?`);
        const id = params[setsKey ? 3 : 2];
        const row = accounts.find((account) => account.id === id && fresh(account, text)
          && (!keyed || (account.key && hex(account.key) === hex(params[4]))));
        rowCount = row ? 1 : 0;
        if (row) Object.assign(row, { salt: params[0], verifier: params[1], ...(setsKey ? { key: params[2] } : {}) });
      } else if (text === "SELECT ROW_COUNT()") {
        rows.push([String(rowCount)]);
      } else {
        throw new Error(`unexpected statement: ${text}`);
      }
    }
    return { ok: true, rows };
  };
  return { run, accounts, statements };
}

/**
 * An authserver-side SRP6 over the stand-in's rows, as TrinityCore's AuthSession does it: the challenge from
 * the stored salt and verifier, the proof checked, and on success the session key K written into the row
 * (LOGIN_UPD_LOGONPROOF) before the proof answer is sent. Implements `BinaryByteStream`.
 */
function authServer(db) {
  let inbox = new Uint8Array(0);
  let waiting;
  let state;
  const push = (bytes) => {
    inbox = Uint8Array.from([...inbox, ...bytes]);
    deliver();
  };
  const deliver = () => {
    if (!waiting || inbox.length < waiting.length) return;
    const { length, resolve } = waiting;
    waiting = undefined;
    const out = inbox.slice(0, length);
    inbox = inbox.slice(length);
    resolve(out);
  };
  const interleave = (secret) => {
    let first = 0;
    while (first < 32 && secret[first] === 0) first++;
    if (first & 1) first++;
    const even = [], odd = [];
    for (let index = first; index < 32; index += 2) { even.push(secret[index]); odd.push(secret[index + 1]); }
    const evenHash = sha1(Uint8Array.from(even)), oddHash = sha1(Uint8Array.from(odd));
    const key = new Uint8Array(40);
    for (let index = 0; index < 20; index++) { key[index * 2] = evenHash[index]; key[index * 2 + 1] = oddHash[index]; }
    return key;
  };
  return {
    logins: 0,
    send(bytes) {
      if (bytes[0] === 0x00) {
        const name = new TextDecoder().decode(bytes.slice(34, 34 + bytes[33]));
        const row = db.accounts.find((account) => account.username === name);
        if (!row) { push([0x00, 0x00, 0x04]); return; }
        const b = fromLe(randomBytes(19));
        const v = fromLe(row.verifier);
        const B = toLe((3n * v + modPow(G, b, N)) % N, 32);
        state = { row, b, v, B, name };
        push([0x00, 0x00, 0x00, ...B, 1, 7, 32, ...toLe(N, 32), ...row.salt, ...new Array(16).fill(0), 0]);
      } else if (bytes[0] === 0x01) {
        const A = bytes.slice(1, 33), M1 = bytes.slice(33, 53);
        const u = fromLe(sha1(A, state.B));
        const S = toLe(modPow((fromLe(A) * modPow(state.v, u, N)) % N, state.b, N), 32);
        const K = interleave(S);
        const nHash = sha1(toLe(N, 32)), gHash = sha1(Uint8Array.of(7));
        const ng = nHash.map((value, index) => value ^ gHash[index]);
        const expected = sha1(ng, sha1(new TextEncoder().encode(state.name)), state.row.salt, A, state.B, K);
        if (Buffer.compare(Buffer.from(expected), Buffer.from(M1)) !== 0) { push([0x01, 0x04, 0x03, 0x00]); return; }
        state.row.key = K; // LOGIN_UPD_LOGONPROOF: the key and last_login = NOW() in one statement
        state.row.lastLogin = Date.now();
        this.logins++;
        push([0x01, 0x00, ...sha1(A, M1, K), 0, 0, 0x80, 0, 0, 0, 0, 0, 0, 0]);
      } else if (bytes[0] === 0x10) {
        push([0x10, 8, 0, 0, 0, 0, 0, 0, 0, 0x10, 0x00]);
      }
    },
    readExactly(length) {
      return new Promise((resolve, reject) => { waiting = { length, resolve, reject }; deliver(); });
    },
    close() {},
  };
}

/** A real loopback HTTP server with only the account routes, and a `fetch` that sends the page's Origin. */
async function accountGateway(service, { allowedOrigins = [ORIGIN], peer } = {}) {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://gateway.local").pathname;
    void serveAccountRoute(request, response, pathname, {
      service, allowedOrigins, peerAddress: peer ?? ((req) => req.socket.remoteAddress),
    }).then((handled) => { if (!handled) response.writeHead(404).end(); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pageFetch = (input, init = {}) => fetch(input, { ...init, headers: { ...(init.headers ?? {}), origin: ORIGIN } });
  return { origin, pageFetch, close: () => new Promise((resolve) => server.close(resolve)) };
}

const fixedSalt = (fill) => () => new Uint8Array(32).fill(fill);

async function registration(name, password, fill = 9) {
  const data = await makeRegistrationData(name, password, new Uint8Array(32).fill(fill));
  return { username: data.username, salt: hex(data.salt), verifier: hex(data.verifier) };
}

test("the query layer sends every value as a hex literal through a prepared statement", () => {
  const hostile = "x'); DROP TABLE account; -- \\";
  assert.equal(sqlParamLiteral(hostile), `X'${Buffer.from(hostile).toString("hex")}'`);
  assert.equal(sqlParamLiteral(new Uint8Array([0, 255])), "X'00ff'");
  assert.equal(sqlParamLiteral(42), "42");
  assert.throws(() => sqlParamLiteral(2 ** 60), RangeError);
  const script = mysqlScript([{ text: "SELECT id FROM account WHERE username = ?", params: [hostile] }]);
  assert.equal(script.includes("DROP"), false, "no character of the value is in the script");
  assert.match(script, /^SET @webclient_0_0 = X'[0-9a-f]+';\nPREPARE webclient_statement FROM 'SELECT id FROM account WHERE username = \?';\nEXECUTE webclient_statement USING @webclient_0_0;\n$/);
  assert.throws(() => mysqlScript([{ text: "SELECT ?", params: [] }]), /placeholder/);
  assert.throws(() => mysqlScript([{ text: "SELECT 1; SELECT 2", params: [] }]), /one statement/);
  assert.deepEqual(parseBatchRows("7\tAB\n8\tNULL\n"), [["7", "AB"], ["8", "NULL"]]);
  // tswow's Windows mysql.exe ends its batch lines with CRLF (seen on the 15.11 scratch-server run).
  assert.deepEqual(parseBatchRows("7\tAB\r\n8\tNULL\r\n"), [["7", "AB"], ["8", "NULL"]]);
  assert.deepEqual(loginDatabase('LoginDatabaseInfo = "h;3306;u;p;auth"'), { host: "h", port: "3306", user: "u", password: "p", database: "auth" });
});

test("registration writes TrinityCore's two statements with the browser's salt and verifier", async () => {
  const db = memoryAuthDatabase();
  const log = [];
  const service = new AccountSelfService({ run: db.run, log: (line) => log.push(line) });
  const body = await registration("newbie", "secret");
  const answer = await service.register("203.0.113.9", body);
  assert.equal(answer.status, 201);
  assert.deepEqual(answer.body, { ok: true, username: "NEWBIE" });
  const insert = db.statements.find((statement) => statement.text.startsWith("INSERT INTO account "));
  assert.equal(insert.text, "INSERT INTO account (username, salt, verifier, reg_mail, email, joindate) VALUES (?, ?, ?, ?, ?, NOW())");
  assert.deepEqual([insert.params[0], hex(insert.params[1]), hex(insert.params[2]), insert.params[3], insert.params[4]],
    ["NEWBIE", body.salt, body.verifier, "", ""]);
  assert.ok(db.statements.some((statement) => statement.text.startsWith("INSERT INTO realmcharacters")));
  assert.deepEqual(log, ["Account NEWBIE: registered from 203.0.113.9"], "the name, the outcome, the address group key");

  const again = await service.register("203.0.113.10", await registration("NEWBIE", "other"));
  assert.deepEqual([again.status, again.body], [409, { error: "taken" }]);
  assert.equal(db.accounts.length, 1);
});

test("bad names, bad verifiers and reserved names never reach the database", async () => {
  const db = memoryAuthDatabase();
  const service = new AccountSelfService({ run: db.run, reserved: ["admin"], log: () => {} });
  const good = await registration("fine", "pw");
  for (const username of ["", "x".repeat(17), "имя", "a b", "a'b", 5]) {
    assert.equal((await service.register("a", { ...good, username })).status, 400, String(username));
  }
  for (const patch of [{ salt: "00".repeat(32) }, { salt: "ab" }, { verifier: "00".repeat(32) },
    { verifier: hex(toLe(N, 32)) }, { verifier: "zz".repeat(32) }]) {
    assert.deepEqual((await service.register("b", { ...good, ...patch })).body, { error: "bad-request" });
  }
  assert.deepEqual((await service.register("c", await registration("Admin", "pw"))).body, { error: "taken" });
  assert.equal(db.statements.length, 0);
});

test("accounts are limited per address and overall, and requests per address", async () => {
  const db = memoryAuthDatabase();
  let now = 1_000_000;
  const service = new AccountSelfService({
    run: db.run, now: () => now, log: () => {},
    limits: { accountsPerAddress: 2, accountsOverall: 3, requestsPerAddress: 5 },
  });
  assert.equal((await service.register("a", await registration("one", "pw"))).status, 201);
  assert.equal((await service.register("a", await registration("two", "pw"))).status, 201);
  assert.deepEqual((await service.register("a", await registration("three", "pw"))).body, { error: "too-many" });
  assert.equal((await service.register("b", await registration("four", "pw"))).status, 201);
  assert.deepEqual((await service.register("c", await registration("five", "pw"))).body, { error: "too-many" }, "overall");
  for (let index = 0; index < 3; index++) await service.register("a", {});
  assert.deepEqual((await service.register("a", {})).body, { error: "too-many" }, "requests per address");
  now += 61 * 60_000;
  assert.equal((await service.register("c", await registration("five", "pw"))).status, 201, "the window slides");
});

test("a database failure says unavailable and logs only the name and the error number", async () => {
  const log = [];
  const service = new AccountSelfService({ run: memoryAuthDatabase({ fail: 1045 }).run, log: (line) => log.push(line) });
  const answer = await service.register("198.51.100.1", await registration("someone", "pw"));
  assert.deepEqual([answer.status, answer.body], [503, { error: "unavailable" }]);
  assert.deepEqual(log, ["Account SOMEONE: registration failed (auth database unreachable) from 198.51.100.1"]);
});

test("an unknown account table is refused before anything is written", async () => {
  const db = memoryAuthDatabase({ columns: ["id", "username", "sha_pass_hash", "v", "s"] });
  const service = new AccountSelfService({ run: db.run, log: () => {} });
  assert.deepEqual((await service.register("a", await registration("old", "pw"))).body, { error: "unsupported-schema" });
  assert.equal(db.accounts.length, 0);
});

for (const [core, columns] of [["TrinityCore", TC_COLUMNS], ["AzerothCore", AC_COLUMNS]]) {
  test(`${core}: register on the page, log in, change the password, log in with the new one`, async () => {
    const db = memoryAuthDatabase({ columns });
    const log = [];
    const service = new AccountSelfService({ run: db.run, log: (line) => log.push(line) });
    const gateway = await accountGateway(service);
    const servers = [];
    const client = new GlueAccountClient({
      gatewayOrigin: gateway.origin, authUrl: "ws://gateway/auth", fetch: gateway.pageFetch,
      connect: async () => { const server = authServer(db); servers.push(server); return server; },
    });
    try {
      assert.equal(await client.available(), true);
      assert.deepEqual(await client.register("Hero", "first"), { ok: true, username: "HERO" });
      const oldVerifier = hex(db.accounts[0].verifier);

      const wrong = await client.changePassword("hero", "nope", "second");
      assert.equal(wrong.ok, false);
      assert.equal(wrong.error, "auth");
      assert.equal(wrong.cause.code, 4, "the authserver's own refusal");
      assert.equal(hex(db.accounts[0].verifier), oldVerifier);

      assert.deepEqual(await client.changePassword("hero", "first", "second"), { ok: true, username: "HERO" });
      assert.notEqual(hex(db.accounts[0].verifier), oldVerifier);
      const keyRead = db.statements.find((statement) => statement.text.startsWith("SELECT id, HEX("));
      assert.equal(keyRead.text, `SELECT id, HEX(${core === "TrinityCore" ? "session_key_auth" : "session_key"}) FROM account WHERE username = ? AND last_login >= NOW() - INTERVAL 300 SECOND`);

      // The new verifier is the one the authserver now checks: the old password fails, the new one passes.
      assert.equal((await client.changePassword("hero", "first", "third")).error, "auth");
      assert.deepEqual(await client.changePassword("hero", "second", "third"), { ok: true, username: "HERO" });
      assert.deepEqual(log, ["Account HERO: registered from 127.0.0.1", "Account HERO: password changed from 127.0.0.1", "Account HERO: password changed from 127.0.0.1"]);
    } finally {
      await gateway.close();
    }
  });
}

test("a change without a login of that account is refused and writes nothing", async () => {
  const db = memoryAuthDatabase();
  const service = new AccountSelfService({ run: db.run, log: () => {} });
  await service.register("x", await registration("victim", "secret"));
  await service.register("y", await registration("attacker", "mine"));
  const updates = () => db.statements.filter((statement) => statement.text.startsWith("UPDATE")).length;
  const fresh = await registration("victim", "hijacked", 3);
  const nonce = () => service.passwordNonce("z", { username: "victim" }).body.nonce;

  // No login yet: no session key in the row.
  assert.deepEqual((await service.changePassword("z", { ...fresh, nonce: nonce(), proof: "00".repeat(20) })).body, { error: "not-proven" });

  // The victim logged in somewhere; the attacker has its own key, not the victim's.
  Object.assign(db.accounts[0], { key: new Uint8Array(randomBytes(40)), lastLogin: Date.now() });
  Object.assign(db.accounts[1], { key: new Uint8Array(randomBytes(40)), lastLogin: Date.now() });
  const issued = nonce();
  const attackerProof = bytesToHex(hmacSha1(db.accounts[1].key, passwordChangeMessage("VICTIM",
    Buffer.from(issued, "hex"), Buffer.from(fresh.salt, "hex"), Buffer.from(fresh.verifier, "hex"))));
  assert.deepEqual((await service.changePassword("z", { ...fresh, nonce: issued, proof: attackerProof })).body, { error: "not-proven" });

  // A proof with the right key but for other values, or with a spent, foreign or expired nonce.
  const sign = (n, values = fresh) => bytesToHex(hmacSha1(db.accounts[0].key, passwordChangeMessage("VICTIM",
    Buffer.from(n, "hex"), Buffer.from(values.salt, "hex"), Buffer.from(values.verifier, "hex"))));
  const other = await registration("victim", "different", 4);
  const n1 = nonce();
  assert.deepEqual((await service.changePassword("z", { ...fresh, nonce: n1, proof: sign(n1, other) })).body, { error: "not-proven" });
  assert.deepEqual((await service.changePassword("z", { ...fresh, nonce: n1, proof: sign(n1) })).body, { error: "not-proven" }, "spent");
  const foreign = service.passwordNonce("z", { username: "attacker" }).body.nonce;
  assert.deepEqual((await service.changePassword("z", { ...fresh, nonce: foreign, proof: sign(foreign) })).body, { error: "not-proven" });
  assert.equal(updates(), 0);

  // The real owner's proof goes through, once.
  const n2 = nonce();
  assert.equal((await service.changePassword("z", { ...fresh, nonce: n2, proof: sign(n2) })).status, 200);
  assert.equal((await service.changePassword("z", { ...fresh, nonce: n2, proof: sign(n2) })).status, 403, "no replay");
  assert.equal(updates(), 1);
});

test("a nonce expires", async () => {
  let now = 0;
  const db = memoryAuthDatabase();
  const service = new AccountSelfService({ run: db.run, now: () => now, log: () => {} });
  await service.register("x", await registration("late", "pw"));
  Object.assign(db.accounts[0], { key: new Uint8Array(randomBytes(40)), lastLogin: Date.now() });
  const fresh = await registration("late", "new", 5);
  const issued = service.passwordNonce("x", { username: "late" }).body.nonce;
  const proof = bytesToHex(hmacSha1(db.accounts[0].key, passwordChangeMessage("LATE",
    Buffer.from(issued, "hex"), Buffer.from(fresh.salt, "hex"), Buffer.from(fresh.verifier, "hex"))));
  now += 2 * 60_000 + 1;
  assert.deepEqual((await service.changePassword("x", { ...fresh, nonce: issued, proof })).body, { error: "not-proven" });
});

test("the routes: disabled unless switched on, page origins only, JSON POSTs only", async () => {
  assert.equal(parseAccountRoutesEnv({}), false);
  assert.equal(parseAccountRoutesEnv({ GATEWAY_ACCOUNTS: "0" }), false);
  assert.equal(parseAccountRoutesEnv({ GATEWAY_ACCOUNTS: "1" }), true);
  assert.deepEqual(parseReservedAccountNames({ GATEWAY_ACCOUNTS_RESERVED: " admin, gm ,," }), ["admin", "gm"]);

  const off = await accountGateway(undefined);
  try {
    const status = await off.pageFetch(`${off.origin}/account/status`);
    assert.deepEqual([status.status, await status.json()], [200, { enabled: false }]);
    for (const path of ["/account/register", "/account/password/nonce", "/account/password"]) {
      const answer = await off.pageFetch(`${off.origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.deepEqual([answer.status, await answer.json()], [403, { error: "disabled" }], path);
    }
  } finally {
    await off.close();
  }

  const db = memoryAuthDatabase();
  const on = await accountGateway(new AccountSelfService({ run: db.run, log: () => {} }));
  try {
    const foreign = await fetch(`${on.origin}/account/register`, {
      method: "POST", headers: { origin: "http://evil.example", "content-type": "application/json" }, body: "{}",
    });
    assert.equal(foreign.status, 403);
    assert.equal(await foreign.text(), "");
    const none = await fetch(`${on.origin}/account/status`);
    assert.equal(none.status, 403, "no Origin, no answer");

    const preflight = await on.pageFetch(`${on.origin}/account/register`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "POST");

    const plain = await on.pageFetch(`${on.origin}/account/register`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    assert.equal(plain.status, 415);
    const getRegister = await on.pageFetch(`${on.origin}/account/register`);
    assert.equal(getRegister.status, 405);
    const broken = await on.pageFetch(`${on.origin}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    assert.equal(broken.status, 400);
    const huge = await on.pageFetch(`${on.origin}/account/register`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "x".repeat(5000) }),
    }).catch(() => undefined);
    assert.ok(huge === undefined || huge.status >= 400, "an oversized body is refused");
    assert.equal(db.statements.length, 0);
  } finally {
    await on.close();
  }
});

// ---- After the review (reg12-review.md) ----

/** A registered account whose owner "just logged in": key K and last_login now, as LOGIN_UPD_LOGONPROOF leaves them. */
async function loggedIn(service, db, name, age = 0) {
  await service.register("setup", await registration(name, "old", 7));
  const row = db.accounts.find((account) => account.username === name.toUpperCase());
  Object.assign(row, { key: new Uint8Array(randomBytes(40)), lastLogin: Date.now() - age });
  return row;
}

function changeBody(service, address, row, values, key = row.key) {
  const nonce = service.passwordNonce(address, { username: row.username }).body.nonce;
  const proof = bytesToHex(hmacSha1(key, passwordChangeMessage(row.username, Buffer.from(nonce, "hex"),
    Buffer.from(values.salt, "hex"), Buffer.from(values.verifier, "hex"))));
  return { ...values, nonce, proof };
}

test("F1: parallel registrations from one address make exactly the per-address limit, from many exactly the overall one", async () => {
  const db = memoryAuthDatabase();
  const service = new AccountSelfService({ run: db.run, log: () => {} });
  const bodies = await Promise.all(Array.from({ length: 10 }, (_, index) => registration(`burst${index}`, "pw")));
  const answers = await Promise.all(bodies.map((body) => service.register("198.51.100.7", body)));
  assert.equal(answers.filter((answer) => answer.status === 201).length, 3);
  assert.equal(db.accounts.length, 3);

  const db2 = memoryAuthDatabase();
  const wide = new AccountSelfService({ run: db2.run, log: () => {}, limits: { maxQueued: 100 } });
  const many = await Promise.all(Array.from({ length: 40 }, (_, index) => registration(`wide${index}`, "pw")));
  const results = await Promise.all(many.map((body, index) => wide.register(`198.51.100.${index}`, body)));
  assert.equal(results.filter((answer) => answer.status === 201).length, 30);
  assert.equal(db2.accounts.length, 30);
});

test("F1: a refusal that wrote nothing gives its reservation back", async () => {
  const db = memoryAuthDatabase();
  const service = new AccountSelfService({ run: db.run, log: () => {}, limits: { accountsPerAddress: 2 } });
  assert.equal((await service.register("a", await registration("dup", "pw"))).status, 201);
  assert.equal((await service.register("a", await registration("dup", "pw"))).status, 409);
  assert.equal((await service.register("a", await registration("second", "pw"))).status, 201, "the taken name did not count");
  assert.deepEqual((await service.register("a", await registration("third", "pw"))).body, { error: "too-many" });
});

test("F2: garbage change attempts from many addresses do not use up the overall budget; each address is capped", async () => {
  const db = memoryAuthDatabase();
  const service = new AccountSelfService({ run: db.run, log: () => {} });
  const row = await loggedIn(service, db, "owner");
  const values = await registration("owner", "new", 8);
  for (let address = 0; address < 12; address++) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const body = changeBody(service, `203.0.113.${address}`, row, values, new Uint8Array(40));
      assert.equal((await service.changePassword(`203.0.113.${address}`, body)).status, 403);
    }
  }
  const sixth = changeBody(service, "203.0.113.0", row, values, new Uint8Array(40));
  assert.deepEqual((await service.changePassword("203.0.113.0", sixth)).body, { error: "too-many" }, "per address, every attempt counts");
  assert.equal((await service.changePassword("192.0.2.1", changeBody(service, "192.0.2.1", row, values))).status, 200,
    "the real owner's change still goes through");
});

test("F2: the overall change budget counts proven changes", async () => {
  const db = memoryAuthDatabase();
  const service = new AccountSelfService({ run: db.run, log: () => {}, limits: { changesOverall: 2 } });
  for (const [index, name] of ["one", "two", "three"].entries()) {
    const row = await loggedIn(service, db, name);
    const answer = await service.changePassword(`192.0.2.${index}`, changeBody(service, `192.0.2.${index}`, row, await registration(name, "n", 9)));
    assert.equal(answer.status, index < 2 ? 200 : 429, name);
  }
});

test("F3: a login older than five minutes by the database's clock is refused, and nothing is written", async () => {
  const db = memoryAuthDatabase();
  const service = new AccountSelfService({ run: db.run, log: () => {} });
  const row = await loggedIn(service, db, "stale", 301_000);
  const before = hex(row.verifier);
  const answer = await service.changePassword("a", changeBody(service, "a", row, await registration("stale", "n", 9)));
  assert.deepEqual(answer.body, { error: "not-proven" });
  assert.equal(hex(row.verifier), before);
});

test("F3: the change replaces the key with 40 fresh bytes; the same key cannot change it again", async () => {
  const db = memoryAuthDatabase();
  const service = new AccountSelfService({ run: db.run, log: () => {} });
  const row = await loggedIn(service, db, "once");
  const key = Uint8Array.from(row.key);
  assert.equal((await service.changePassword("a", changeBody(service, "a", row, await registration("once", "n1", 9)))).status, 200);
  assert.equal(row.key.length, 40);
  assert.notEqual(row.key, null);
  assert.notEqual(hex(row.key), hex(key), "the used key is dead");
  const again = await service.changePassword("a", changeBody(service, "a", row, await registration("once", "n2", 10), key));
  assert.deepEqual(again.body, { error: "not-proven" });
});

test("F3: the write is conditional on the checked key still being the stored one", async () => {
  let row;
  // Between the read and the write another login (or change) replaces the key.
  const db = memoryAuthDatabase({ beforeUpdate: () => { row.key = new Uint8Array(randomBytes(40)); } });
  const service = new AccountSelfService({ run: db.run, log: () => {} });
  row = await loggedIn(service, db, "racer");
  const before = hex(row.verifier);
  const answer = await service.changePassword("a", changeBody(service, "a", row, await registration("racer", "n", 9)));
  assert.deepEqual(answer.body, { error: "not-proven" });
  assert.equal(hex(row.verifier), before);
});

test("nonce caps: a few per address, and the whole store", async () => {
  let now = 0;
  const service = new AccountSelfService({ run: memoryAuthDatabase().run, now: () => now, log: () => {}, limits: { maxNonces: 5 } });
  for (let index = 0; index < 3; index++) assert.equal(service.passwordNonce("a", { username: "x" }).status, 200);
  assert.deepEqual(service.passwordNonce("a", { username: "x" }).body, { error: "too-many" });
  assert.equal(service.passwordNonce("b", { username: "x" }).status, 200);
  assert.equal(service.passwordNonce("c", { username: "x" }).status, 200);
  assert.deepEqual(service.passwordNonce("d", { username: "x" }).body, { error: "busy" });
  now += 2 * 60_000 + 1;
  assert.equal(service.passwordNonce("d", { username: "x" }).status, 200, "expired nonces make room");
});

test("the queue admits exactly maxQueued operations", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const db = memoryAuthDatabase();
  const service = new AccountSelfService({ run: async (list) => { await gate; return db.run(list); }, log: () => {}, limits: { maxQueued: 2 } });
  const first = service.register("a", await registration("q1", "pw"));
  const second = service.register("b", await registration("q2", "pw"));
  assert.deepEqual((await service.register("c", await registration("q3", "pw"))).body, { error: "busy" });
  release();
  assert.deepEqual([(await first).status, (await second).status], [201, 201]);
});

test("the counters forget the oldest address beyond maxAddresses", async () => {
  const service = new AccountSelfService({ run: memoryAuthDatabase().run, log: () => {}, limits: { maxAddresses: 2, requestsPerAddress: 1 } });
  assert.equal(service.passwordNonce("a", { username: "x" }).status, 200);
  assert.deepEqual(service.passwordNonce("a", { username: "x" }).body, { error: "too-many" });
  service.passwordNonce("b", { username: "x" });
  service.passwordNonce("c", { username: "x" });
  assert.equal(service.passwordNonce("a", { username: "x" }).status, 200, "a was evicted: memory stays bounded");
});

test("a run that ended at its commit point answers «may have happened» and keeps the reservation", async () => {
  const log = [];
  const db = memoryAuthDatabase();
  let cut = false;
  const service = new AccountSelfService({
    run: async (list) => (cut && list.some((statement) => statement.text.startsWith("INSERT INTO account"))
      ? { ok: false, errno: 2013, uncertain: true } : db.run(list)), // e.g. the connection lost during COMMIT
    log: (line) => log.push(line), limits: { accountsPerAddress: 1 },
  });
  cut = true;
  const answer = await service.register("a", await registration("slow", "pw"));
  assert.deepEqual([answer.status, answer.body], [504, { error: "uncertain" }]);
  assert.deepEqual(log, ["Account SLOW: registration outcome unknown (ended at the commit point) from a"]);
  cut = false;
  assert.deepEqual((await service.register("a", await registration("other", "pw"))).body, { error: "too-many" });
});

test("a run that ended before its commit point is a plain retryable failure and gives the reservation back", async () => {
  const db = memoryAuthDatabase();
  let cut = true;
  const service = new AccountSelfService({
    run: async (list) => (cut && list.some((statement) => statement.text.startsWith("INSERT INTO account"))
      ? { ok: false, errno: undefined } : db.run(list)), // e.g. the timer fired while the client was still connecting
    log: () => {}, limits: { accountsPerAddress: 1 },
  });
  assert.deepEqual((await service.register("a", await registration("slow", "pw"))).body, { error: "unavailable" });
  cut = false;
  assert.equal((await service.register("a", await registration("slow", "pw"))).status, 201, "nothing was counted");
});

test("the commit point is marked in the script right before the statement that may commit", () => {
  const script = mysqlScript([{ text: "START TRANSACTION", params: [] }, { text: "SELECT ?", params: [1] },
    { text: "COMMIT", params: [], commitPoint: true }]);
  assert.match(script, /EXECUTE webclient_statement USING @webclient_1_0;\nSELECT 'webclient:commit-point';\nCOMMIT;\n$/);
  assert.equal(mysqlScript([{ text: "SELECT 1", params: [] }]).includes("commit-point"), false);
});

test("many addresses cannot evict the overall counters", async () => {
  const db = memoryAuthDatabase();
  const service = new AccountSelfService({ run: db.run, log: () => {}, limits: { maxAddresses: 2, accountsOverall: 2 } });
  assert.equal((await service.register("a", await registration("g1", "pw"))).status, 201);
  assert.equal((await service.register("b", await registration("g2", "pw"))).status, 201);
  for (let index = 0; index < 5; index++) service.passwordNonce(`flood${index}`, { username: "x" });
  assert.deepEqual((await service.register("c", await registration("g3", "pw"))).body, { error: "too-many" },
    "the overall budget survives the flood of addresses");
});

test("the route keys limits by the socket address, IPv6 by /64 and mapped IPv4 as IPv4", async () => {
  const service = new AccountSelfService({ run: memoryAuthDatabase().run, log: () => {}, limits: { requestsPerAddress: 2 } });
  const gateway = await accountGateway(service, { peer: (request) => request.headers["x-test-peer"] });
  const nonce = (peer) => gateway.pageFetch(`${gateway.origin}/account/password/nonce`, {
    method: "POST", headers: { "content-type": "application/json", "x-test-peer": peer }, body: JSON.stringify({ username: "x" }),
  }).then((response) => response.status);
  try {
    assert.deepEqual([await nonce("2001:db8:1:2::1"), await nonce("2001:db8:1:2:ffff::9"), await nonce("2001:db8:1:2::7")], [200, 200, 429]);
    assert.equal(await nonce("2001:db8:1:3::1"), 200, "another /64");
    assert.deepEqual([await nonce("::ffff:203.0.113.5"), await nonce("203.0.113.5"), await nonce("203.0.113.5")], [200, 200, 429]);
  } finally {
    await gateway.close();
  }
});

test("the forms refuse to start with * in ALLOWED_ORIGINS; a dedicated DB user replaces the conf's", async () => {
  const { createAccountService, accountDatabase } = await import("../dist/code/gateway/AccountServiceSetup.js");
  const lines = [];
  assert.equal(await createAccountService({ GATEWAY_ACCOUNTS: "1" }, process.cwd(), ["http://a", "*"], (line) => lines.push(line)), undefined);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /NOT started.*ALLOWED_ORIGINS contains \*/);
  const conf = { host: "h", port: "3306", user: "root", password: "p", database: "auth" };
  assert.deepEqual(accountDatabase(conf, {}), conf);
  assert.deepEqual(accountDatabase(conf, { GATEWAY_ACCOUNTS_DB_USER: "webreg", GATEWAY_ACCOUNTS_DB_PASSWORD: "q" }),
    { ...conf, user: "webreg", password: "q" });
});
