import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { GlueSession, realmTypeRules } from "../dist/code/browser/glue/GlueSession.js";
import { GlueRuntime } from "../dist/code/browser/glue/GlueRuntime.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { readRealmList } from "../dist/code/auth/login.js";
import { PacketWriter } from "../dist/code/protocol/index.js";

/**
 * 10.08 — the realm dialog: a fresh list on every `RequestRealmList` while the auth connection is
 * open, and PvP/RP from Cfg_Configs rather than from three named types.
 */

function realm(id, extra = {}) {
  return { type: 0, locked: false, flags: 0, name: `Мир ${id}`, address: "127.0.0.1:8085", population: 0,
    characters: 0, timezone: 1, id, build: undefined, ...extra };
}

function recording(refreshRealms) {
  const events = [];
  const session = new GlueSession({ fireEvent: (event, ...args) => events.push([event, ...args]), refreshRealms });
  session.beginSession({ username: "T", sessionKey: new Uint8Array(40), realms: [realm(1, { population: 0.5 })] });
  return { session, events };
}

const settle = async () => { for (let round = 0; round < 6; round++) await new Promise((resolve) => setImmediate(resolve)); };

test("RequestRealmList re-reads the list and then opens the dialog over it", async () => {
  let answer = [realm(1, { population: 2, characters: 4 }), realm(2)];
  let asked = 0;
  const { session, events } = recording(() => { asked++; return Promise.resolve(answer); });
  session.requestRealmList();
  session.requestRealmList();
  assert.deepEqual(events, [], "the dialog waits for the answer");
  await settle();
  assert.equal(asked, 1, "one question at a time");
  assert.deepEqual(events, [["OPEN_REALM_LIST"]]);
  assert.equal(session.realmRow(1, 1).numCharacters, 4);
  assert.equal(session.realmRow(1, 2).name, "Мир 2");
  answer = [realm(1, { flags: 0x02 })];
  session.requestRealmList();
  await settle();
  assert.equal(session.realmRow(1, 1).realmDown, true, "status follows the authserver");
});

test("a failed refresh keeps the old list and still answers", async () => {
  const { session, events } = recording(() => Promise.reject(new Error("closed")));
  session.requestRealmList();
  await settle();
  assert.deepEqual(events, [["OPEN_REALM_LIST"]]);
  assert.equal(session.realmRow(1, 1).name, "Мир 1");
});

test("without an open auth connection the dialog opens at once, as before", () => {
  const { session, events } = recording(() => undefined);
  session.requestRealmList();
  assert.deepEqual(events, [["OPEN_REALM_LIST"]]);
  const plain = recording(undefined);
  plain.session.requestRealmList();
  assert.deepEqual(plain.events, [["OPEN_REALM_LIST"]]);
});

test("an answer for a session that has ended is dropped", async () => {
  let release;
  const { session, events } = recording(() => new Promise((resolve) => { release = resolve; }));
  session.requestRealmList();
  session.beginSession({ username: "U", sessionKey: new Uint8Array(40), realms: [realm(7)] });
  release([realm(9)]);
  await settle();
  assert.equal(session.realmRow(1, 1).name, "Мир 7");
  assert.deepEqual(events, []);
});

test("PvP and RP come from Cfg_Configs: 1, 3, 5, 8, 10, 12 and 6, 7, 8", () => {
  const pvp = [];
  const rp = [];
  for (let type = 0; type <= 16; type++) {
    if (realmTypeRules(type).pvp) pvp.push(type);
    if (realmTypeRules(type).rp) rp.push(type);
  }
  assert.deepEqual(pvp, [1, 3, 5, 8, 10, 12]);
  assert.deepEqual(rp, [6, 7, 8]);
  const { session } = recording(undefined);
  session.beginSession({ username: "T", sessionKey: new Uint8Array(40), realms: [realm(1, { type: 3 }), realm(2, { type: 7 })] });
  assert.equal(session.realmRow(1, 1).pvp, true);
  assert.equal(session.realmRow(1, 2).rp, true);
  assert.equal(session.realmRow(1, 2).pvp, false);
});

test("readRealmList asks with REALM_LIST and reads one answer", async () => {
  const payload = new PacketWriter()
    .u32(0).u16(1)
    .u8(1).u8(0).u8(0).cString("Мир").cString("127.0.0.1:8085").f32(1.5).u8(3).u8(1).u8(1)
    .u8(0x10).u8(0)
    .toUint8Array();
  const answer = Uint8Array.from([0x10, payload.length & 0xff, payload.length >> 8, ...payload]);
  let offset = 0;
  const sent = [];
  const realms = await readRealmList({
    send: (bytes) => sent.push([...bytes]),
    readExactly: async (length) => { const out = answer.slice(offset, offset + length); offset += length; return out; },
    close() {},
  });
  assert.deepEqual(sent, [[0x10, 0, 0, 0, 0]]);
  assert.equal(realms.length, 1);
  assert.equal(realms[0].name, "Мир");
  assert.equal(realms[0].type, 1);
});

/* --- the kept auth connection ends where the world begins ---------------------------------- */

const SRP_N = 0x894b645e89e1535bbdad5b8b290650530801b18ebfbf5e8fab3c82872a3e9bb7n;
const SRP_G = 7n;
const sha1 = (...parts) => {
  const hash = createHash("sha1");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};
const fromLe = (bytes) => { let value = 0n; for (let at = bytes.length - 1; at >= 0; at--) value = (value << 8n) | BigInt(bytes[at]); return value; };
const toLe = (value, length) => { const out = new Uint8Array(length); for (let at = 0; at < length; at++) { out[at] = Number(value & 0xffn); value >>= 8n; } return out; };
const modPow = (base, exponent, modulus) => {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) { if (exponent & 1n) result = (result * base) % modulus; base = (base * base) % modulus; exponent >>= 1n; }
  return result;
};
const interleave = (secret) => {
  const even = new Uint8Array(16);
  const odd = new Uint8Array(16);
  for (let at = 0; at < 16; at++) { even[at] = secret[at * 2]; odd[at] = secret[at * 2 + 1]; }
  let first = 0;
  while (first < 32 && secret[first] === 0) first++;
  if (first & 1) first++;
  const left = sha1(even.subarray(first / 2));
  const right = sha1(odd.subarray(first / 2));
  const key = new Uint8Array(40);
  for (let at = 0; at < 20; at++) { key[at * 2] = left[at]; key[at * 2 + 1] = right[at]; }
  return key;
};

/** An authserver that accepts TEST:PASSWORD and answers every REALM_LIST, as AuthSession does. */
function fakeAuthServer() {
  const salt = Uint8Array.from({ length: 32 }, (_, at) => at + 1);
  const b = fromLe(Uint8Array.from({ length: 32 }, (_, at) => 0x51 + at));
  const verifier = modPow(SRP_G, fromLe(sha1(salt, sha1(new TextEncoder().encode("TEST:PASSWORD")))), SRP_N);
  const B = toLe((modPow(SRP_G, b, SRP_N) + 3n * verifier) % SRP_N, 32);
  const realmPayload = new PacketWriter()
    .u32(0).u16(1)
    .u8(0).u8(0).u8(0).cString("Arthas Realm").cString("127.0.0.1:8085").f32(0.5).u8(1).u8(1).u8(1)
    .u8(0x10).u8(0)
    .toUint8Array();
  let inbox = new Uint8Array(0);
  let waiting;
  const counts = { realmLists: 0 };
  let closed = false;
  const push = (bytes) => { inbox = Uint8Array.from([...inbox, ...bytes]); deliver(); };
  const deliver = () => {
    if (!waiting || inbox.length < waiting.length) return;
    const { length, resolve } = waiting;
    waiting = undefined;
    const out = inbox.slice(0, length);
    inbox = inbox.slice(length);
    resolve(out);
  };
  return {
    counts,
    get closed() { return closed; },
    send(bytes) {
      if (closed) throw new Error("send on a closed stream");
      if (bytes[0] === 0x00) {
        push([0x00, 0x00, 0x00, ...B, 1, 7, 32, ...toLe(SRP_N, 32), ...salt, ...new Array(16).fill(0), 0]);
      } else if (bytes[0] === 0x01) {
        const A = bytes.slice(1, 33);
        const M1 = bytes.slice(33, 53);
        const u = fromLe(sha1(A, B));
        const secret = modPow((fromLe(A) * modPow(verifier, u, SRP_N)) % SRP_N, b, SRP_N);
        const M2 = sha1(A, M1, interleave(toLe(secret, 32)));
        push([0x01, 0x00, ...M2, 0, 0, 0x80, 0, 0, 0, 0, 0, 0, 0]);
      } else if (bytes[0] === 0x10) {
        counts.realmLists += 1;
        push([0x10, realmPayload.length & 0xff, realmPayload.length >> 8, ...realmPayload]);
      }
    },
    readExactly(length) {
      return new Promise((resolve, reject) => {
        if (closed) { reject(new Error("closed")); return; }
        waiting = { length, resolve, reject };
        deliver();
      });
    },
    close() {
      closed = true;
      const pending = waiting;
      waiting = undefined;
      pending?.reject(new Error("closed"));
    },
  };
}

test("the auth connection serves the realm dialog at character select and is closed on entering the world", async () => {
  const auth = fakeAuthServer();
  const events = [];
  const character = {
    guid: 1n, name: "Arthas", race: 1, classId: 1, gender: 0, skin: 0, face: 0, hairStyle: 0, hairColor: 0,
    facialHair: 0, level: 10, zone: 12, map: 0, x: 0, y: 0, z: 0, guildId: 0, flags: 0, customizeFlags: 0,
    firstLogin: false, petDisplayId: 0, petLevel: 0, petFamily: 0, equipment: [],
  };
  const runtime = new GlueRuntime({
    provider: createFixtureProvider({ "Interface/GlueXML/GlueXML.toc": "## Interface: 30300\n" }),
    api: {
      locale: "enUS",
      authUrl: "ws://gateway/auth",
      connect: async () => auth,
      enterWorld: (request) => events.push(["ENTER", request.character.name]),
      session: { connect: async () => ({ characters: async () => [{ ...character }], deleteCharacter: async () => 71, close() {} }) },
    },
  });
  await runtime.load();
  const original = runtime.api.fireEvent.bind(runtime.api);
  runtime.api.fireEvent = (event, ...args) => { events.push([event, ...args]); return original(event, ...args); };
  const lua = (source) => {
    const outcome = runtime.vm.execute(source, "@glue-realm-keepalive");
    assert.equal(outcome.ok, true, `${source}: ${outcome.error ?? ""}`);
  };
  try {
    await runtime.api.login("TEST", "PASSWORD");
    await settle();
    assert.equal(auth.closed, false, "kept for RequestRealmList at character select");
    assert.equal(auth.counts.realmLists, 1);
    lua("RequestRealmList()");
    await settle();
    assert.equal(auth.counts.realmLists, 2, "the dialog re-reads the list on the same connection");

    await runtime.session.connect(runtime.session.realmPosition("Arthas Realm").realm);
    await settle();
    lua("SelectCharacter(1); EnterWorld()");
    assert.deepEqual(events.filter(([event]) => event === "ENTER"), [["ENTER", "Arthas"]]);
    assert.equal(auth.closed, true, "an in-world player holds no authserver socket");

    events.length = 0;
    lua("RequestRealmList()");
    await settle();
    assert.equal(auth.counts.realmLists, 2, "nothing is sent on the closed connection");
    assert.deepEqual(events.filter(([event]) => event === "OPEN_REALM_LIST"), [["OPEN_REALM_LIST"]],
      "back at character select the dialog opens over the list it has");
  } finally {
    runtime.close();
  }
});
