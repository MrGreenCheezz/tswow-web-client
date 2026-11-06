// 10.27 — the world socket goes to the address of the realm list, as Wow.exe connects, and only to an
// address the gateway's own authserver announced.
//
// Three layers: the reading of the authserver's answers on one `/auth` connection (RealmListWatch),
// the parsing and keeping of the addresses (parseRealmAddress, AnnouncedRealms), and the real
// `startGateway` on port 0 between a TCP stand-in for the authserver and three stand-ins for world
// servers, each of which says who it is on connect.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import WebSocket from "ws";
import {
  AnnouncedRealms, REALM_ADDRESS_LIMIT, REALM_ADDRESS_TTL_MS, RealmListWatch, parseRealmAddress,
} from "../dist/code/gateway/RealmAddresses.js";
import { routeUpgrade } from "../dist/code/gateway/UpgradeGuard.js";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { parseRealmList } from "../dist/code/auth/AuthProtocol.js";
import { realmWorldUrl } from "../dist/code/browser/glue/GlueWorldConnector.js";

const ORIGIN = "http://127.0.0.1:5173";
const HOUR = 60 * 60_000;

/** A successful AUTH_LOGON_CHALLENGE answer, as in login-attempt-limiter.test.mjs. */
function challengeOk(flags = 0) {
  const extra = (flags & 1 ? 20 : 0) + (flags & 2 ? 12 : 0) + (flags & 4 ? 1 : 0);
  return Uint8Array.from([0x00, 0x00, 0x00, ...new Array(32).fill(0xb0), 1, 7, 32, ...new Array(32).fill(0xab),
    ...new Array(32).fill(0x5a), ...new Array(16).fill(0xc1), flags, ...new Array(extra).fill(0x10)]);
}
const PROOF_OK = Uint8Array.from([0x01, 0x00, ...new Array(20).fill(0x10), 0x00, 0x00, 0x80, 0x00, 0, 0, 0, 0, 0, 0]);
const PROOF_WRONG = Uint8Array.of(0x01, 0x04, 0x00, 0x00);
const concat = (...parts) => Uint8Array.from(parts.flatMap((part) => [...part]));

/** A REALM_LIST answer as `AuthSession::RealmListCallback` writes it for build 12340. */
function realmList(realms) {
  const body = [0, 0, 0, 0, realms.length & 0xff, realms.length >> 8];
  for (const [index, realm] of realms.entries()) {
    const flags = realm.offline ? 0x02 : 0x00;
    body.push(1, 0, flags, ...Buffer.from(`${realm.name}\0`), ...Buffer.from(`${realm.address}\0`),
      0, 0, 0, 0, 1, 1, index + 1);
  }
  body.push(0x10, 0x00);
  return Uint8Array.from([0x10, body.length & 0xff, body.length >> 8, ...body]);
}

function watched(bytes, chunkSize = bytes.length) {
  const heard = [];
  const watch = new RealmListWatch((addresses) => heard.push(addresses));
  for (let at = 0; at < bytes.length; at += chunkSize) watch.feed(bytes.subarray(at, at + chunkSize));
  return { heard, watch };
}

test("the realm lists after a successful login are read, however TCP cuts them", () => {
  const first = realmList([{ name: "Круг", address: "127.0.0.1:8085" }, { name: "Тест", address: "10.0.0.5:8086", offline: true }]);
  const second = realmList([{ name: "Круг", address: "127.0.0.1:8085" }]);
  assert.deepEqual(parseRealmList(first).map((realm) => realm.address), ["127.0.0.1:8085", "10.0.0.5:8086"],
    "the stand-in is a list the page itself reads");
  const stream = concat(challengeOk(), PROOF_OK, first, second);
  for (const chunkSize of [stream.length, 1, 7, 120]) {
    const { heard, watch } = watched(stream, chunkSize);
    assert.deepEqual(heard, [["127.0.0.1:8085", "10.0.0.5:8086"], ["127.0.0.1:8085"]], `chunks of ${chunkSize}`);
    assert.equal(watch.reading, true, "still reading for the next refresh");
  }
  // The security flags' extras are part of the challenge answer, not the start of the proof.
  for (const flags of [4, 7]) {
    assert.deepEqual(watched(concat(challengeOk(flags), PROOF_OK, second), 5).heard, [["127.0.0.1:8085"]], `flags ${flags}`);
  }
  // Nothing before the proof answer is whole: the 0x10 bytes inside the challenge are not a list.
  assert.deepEqual(watched(concat(challengeOk(4), PROOF_OK.subarray(0, 31))).heard, []);
});

test("a connection out of the login order teaches nothing and stops being read", () => {
  const list = realmList([{ name: "X", address: "198.51.100.7:8085" }]);
  const cases = {
    "a wrong password": concat(challengeOk(), PROOF_WRONG, list),
    "a refused challenge": concat(Uint8Array.of(0x00, 0x00, 0x04), list),
    "a list before any login": list,
    "a reconnect challenge": concat(Uint8Array.of(0x02, 0x00, ...new Array(32).fill(0)), list),
    "a list whose size does not match its realms": concat(challengeOk(), PROOF_OK, Uint8Array.of(0x10, 0x03, 0x00, 1, 2, 3)),
    "another command after the proof": concat(challengeOk(), PROOF_OK, Uint8Array.of(0x30, 0, 0), list),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    const { heard, watch } = watched(bytes, 3);
    assert.deepEqual(heard, [], name);
    assert.equal(watch.reading, false, name);
  }
});

test("a realm address is host and port, as the cores write it", () => {
  assert.deepEqual(parseRealmAddress("127.0.0.1:8085"), { host: "127.0.0.1", port: 8085 });
  assert.deepEqual(parseRealmAddress("logon.example.org:8129"), { host: "logon.example.org", port: 8129 });
  assert.deepEqual(parseRealmAddress("::1:8085"), { host: "::1", port: 8085 }, "to_string() of an IPv6 address");
  assert.deepEqual(parseRealmAddress("[2001:db8::7]:8085"), { host: "2001:db8::7", port: 8085 });
  for (const refused of ["127.0.0.1", "127.0.0.1:", ":8085", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:80a",
    "a b:8085", "user@host:8085", "host/path:8085", "[::1:8085", "\u0001:8085", "127.0.0.1:123456"]) {
    assert.equal(parseRealmAddress(refused), undefined, JSON.stringify(refused));
  }
});

test("announced addresses are kept for a day after the last list, at most a bounded number", () => {
  const realms = new AnnouncedRealms();
  realms.announce(["127.0.0.1:8085", "not an address"], 0);
  assert.deepEqual(realms.target("127.0.0.1:8085", REALM_ADDRESS_TTL_MS - 1), { host: "127.0.0.1", port: 8085 });
  assert.equal(realms.target("127.0.0.1:8085", REALM_ADDRESS_TTL_MS), undefined, "expired");
  assert.equal(realms.target("not an address", 1), undefined);
  assert.equal(realms.target("127.0.0.1:8086", 1), undefined, "never announced");
  assert.equal(REALM_ADDRESS_TTL_MS, 24 * HOUR);

  // A newer list renews an address; the oldest-renewed goes first past the limit.
  const bounded = new AnnouncedRealms({ limit: 3 });
  bounded.announce(["a:1", "b:1", "c:1"], 0);
  bounded.announce(["a:1"], 10);
  bounded.announce(["d:1"], 20);
  assert.equal(bounded.target("b:1", 30), undefined, "b was the oldest");
  for (const kept of ["a:1", "c:1", "d:1"]) assert.ok(bounded.target(kept, 30), kept);
  assert.equal(REALM_ADDRESS_LIMIT, 64);
});

test("a /world upgrade names its realm in the query; an empty one is a bad request", () => {
  const route = (url) => routeUpgrade({ url, headers: { origin: ORIGIN } }, { allowedOrigins: [ORIGIN] });
  assert.deepEqual(route("/world"), { kind: "world" });
  assert.deepEqual(route("/world?realm=127.0.0.1%3A8085"), { kind: "world", realm: "127.0.0.1:8085" });
  assert.deepEqual(route("/world?realm="), { kind: "refuse", status: 400 });
  assert.deepEqual(route("/auth?realm=x"), { kind: "auth" });
  // The page writes it so, and the gateway reads back what the realm list said.
  const url = new URL(realmWorldUrl("ws://gateway.test:8090/world", "[2001:db8::7]:8085"));
  assert.equal(url.pathname, "/world");
  assert.equal(url.searchParams.get("realm"), "[2001:db8::7]:8085");
});

/** A TCP stand-in that writes `hello` to every connection and counts them. */
async function standIn(onConnection) {
  const sockets = new Set();
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    get connections() { return connections; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** The first bytes a socket on `path` receives, or the status its upgrade was refused with. */
function firstAnswer(port, path) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { origin: ORIGIN });
    socket.on("error", () => {});
    socket.once("unexpected-response", (request, response) => {
      resolve({ status: response.statusCode });
      request.destroy();
    });
    socket.once("message", (data) => {
      resolve({ bytes: Buffer.from(data) });
      socket.close();
    });
    socket.once("close", () => reject(new Error(`${path} closed without an answer`)));
  });
}

test("the real gateway dials the announced realm, refuses the rest, and keeps /world on WORLD_HOST", async () => {
  const worlds = await Promise.all(["fixed", "first", "second"].map((name) => standIn((socket) => socket.write(name))));
  const [fixed, first, second] = worlds;
  const addresses = [`127.0.0.1:${first.port}`, `127.0.0.1:${second.port}`];
  const auth = await standIn((socket) => socket.write(concat(challengeOk(), PROOF_OK,
    realmList([{ name: "Один", address: addresses[0] }, { name: "Два", address: addresses[1] }]))));
  const options = {
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: auth.port },
    world: { host: "127.0.0.1", port: fixed.port },
    allowedOrigins: [ORIGIN],
    datasetPollMs: 0,
    loginAttempts: false,
  };
  const gateway = await startGateway(options);
  try {
    const realm = (address) => `/world?realm=${encodeURIComponent(address)}`;
    assert.deepEqual(await firstAnswer(gateway.port, realm(addresses[1])), { status: 403 }, "nothing announced yet");
    assert.equal(second.connections, 0, "a refused realm is never dialled");

    // One login's worth of answers through /auth, and the realm list is known.
    const login = await firstAnswer(gateway.port, "/auth");
    assert.ok(login.bytes.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await firstAnswer(gateway.port, realm(addresses[1]))).bytes.toString(), "second");
    assert.equal((await firstAnswer(gateway.port, realm(addresses[0]))).bytes.toString(), "first");
    assert.equal((await firstAnswer(gateway.port, "/world")).bytes.toString(), "fixed", "no realm: the gateway's own target");
    // A host the authserver never named is not dialled, even one that listens.
    assert.deepEqual(await firstAnswer(gateway.port, realm(`127.0.0.1:${fixed.port}`)), { status: 403 });
    assert.deepEqual(await firstAnswer(gateway.port, realm(`127.0.0.1:${auth.port}`)), { status: 403 });
    assert.equal(auth.connections, 1);
    assert.equal(fixed.connections, 1);
  } finally {
    await gateway.close();
  }

  // WORLD_FROM_REALMLIST=0: every world connection is the fixed one, whatever the page names.
  const pinned = await startGateway({ ...options, worldFromRealmList: false });
  try {
    await firstAnswer(pinned.port, "/auth");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await firstAnswer(pinned.port, `/world?realm=${encodeURIComponent(addresses[1])}`)).bytes.toString(), "fixed");
    assert.equal(second.connections, 1, "only the first gateway dialled it");
  } finally {
    await pinned.close();
    await auth.close();
    for (const world of worlds) await world.close();
  }
});
