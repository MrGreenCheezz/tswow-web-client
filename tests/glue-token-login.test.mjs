import assert from "node:assert/strict";
import test from "node:test";
import { GlueRuntime } from "../dist/code/browser/glue/GlueRuntime.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { loginToRealmList } from "../dist/code/auth/login.js";

/**
 * 10.10 — an account with an authenticator (TrinityCore `account.totp_secret`): the challenge says
 * `securityFlags & 4` and carries one more byte (AuthSession.cpp:420-438); the proof then ends in
 * `u8 length` + the code (:473-496). The code is typed after the challenge, so the login waits for
 * `TokenEntered` and sends nothing before it.
 */

const N_LE = (() => {
  let value = 0x894b645e89e1535bbdad5b8b290650530801b18ebfbf5e8fab3c82872a3e9bb7n;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index++) { bytes[index] = Number(value & 0xffn); value >>= 8n; }
  return bytes;
})();

function challenge(securityFlags) {
  const body = [
    ...Array.from({ length: 32 }, (_, index) => index + 3), // B
    1, 7, // g
    32, ...N_LE, // N
    ...Array.from({ length: 32 }, (_, index) => index + 1), // salt
    ...new Array(16).fill(0), // crc salt
    securityFlags,
  ];
  return Uint8Array.from([0x00, 0x00, 0x00, ...body, ...(securityFlags & 4 ? [1] : [])]);
}

/**
 * A byte stream that answers the challenge, then answers any proof with WOW_FAIL_UNKNOWN_ACCOUNT —
 * the core's answer to a code that does not validate — and records what was sent.
 */
function authStream(securityFlags) {
  const sent = [];
  let inbox = challenge(securityFlags);
  let waiting;
  let closed = false;
  const deliver = () => {
    if (!waiting || inbox.length < waiting.length) return;
    const { length, resolve } = waiting;
    waiting = undefined;
    const out = inbox.slice(0, length);
    inbox = inbox.slice(length);
    resolve(out);
  };
  return {
    sent,
    get closed() { return closed; },
    send(bytes) {
      sent.push(Uint8Array.from(bytes));
      if (bytes[0] === 0x01) {
        inbox = Uint8Array.from([...inbox, 0x01, 0x04, 0x00, 0x00]);
        deliver();
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

const settle = async () => { for (let round = 0; round < 20; round++) await new Promise((resolve) => setImmediate(resolve)); };

async function tokenGlue(securityFlags) {
  const stream = authStream(securityFlags);
  const events = [];
  const runtime = new GlueRuntime({
    provider: createFixtureProvider({ "Interface/GlueXML/GlueXML.toc": "## Interface: 30300\n" }),
    api: { locale: "ruRU", authUrl: "ws://gateway/auth", connect: async () => stream },
  });
  await runtime.load();
  const original = runtime.api.fireEvent.bind(runtime.api);
  runtime.api.fireEvent = (event, ...args) => { events.push([event, ...args]); return original(event, ...args); };
  const lua = (source) => {
    runtime.vm.setGlobal("__result", undefined);
    const outcome = runtime.vm.execute(`__result = (function() ${source} end)()`, "@glue-token-probe");
    assert.equal(outcome.ok, true, `${source}: ${outcome.error ?? ""}`);
    return runtime.vm.getGlobal("__result");
  };
  return { runtime, stream, events, lua };
}

test("a code is asked for after the challenge, and nothing is sent before it", async () => {
  const { runtime, stream, events, lua } = await tokenGlue(4);
  try {
    const done = runtime.api.login("TESTER", "secret");
    await settle();
    assert.equal(stream.sent.length, 1, "only the challenge so far");
    assert.equal(stream.sent[0][0], 0x00);
    assert.deepEqual(events.slice(-2).map(([event]) => event), ["CLOSE_STATUS_DIALOG", "PLAYER_ENTER_TOKEN"]);

    lua('TokenEntered("123456"); return 1');
    await done;
    const proof = stream.sent[1];
    assert.equal(proof[0], 0x01);
    assert.equal(proof[proof.length - 8], 4, "the security flags byte says a token follows");
    assert.deepEqual([...proof.slice(-7)], [6, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36]);
    assert.ok(events.some(([event, type]) => event === "OPEN_STATUS_DIALOG" && type === "CANCEL"),
      "TokenEntered puts the CANCEL dialog back up (0x4d8080)");
    // The core answers a wrong code with 0x04, the same as an unknown account or a wrong password.
    const last = events.filter(([event]) => event === "OPEN_STATUS_DIALOG").at(-1);
    assert.equal(last[1], "OKAY");
  } finally {
    runtime.close();
  }
});

test("CancelLogin while the code dialog is up drops the login and sends no proof", async () => {
  const { runtime, stream, events, lua } = await tokenGlue(4);
  try {
    const done = runtime.api.login("TESTER", "secret");
    await settle();
    events.length = 0;
    lua("CancelLogin(); return 1");
    await done;
    assert.equal(stream.sent.length, 1);
    assert.equal(stream.closed, true);
    assert.equal(events.some(([event, type]) => event === "OPEN_STATUS_DIALOG" && type === "OKAY"), false,
      "a cancel is not an error");
    lua('TokenEntered("123456"); return 1');
    await settle();
    assert.equal(stream.sent.length, 1, "a late code goes nowhere");
  } finally {
    runtime.close();
  }
});

test("a code that is not six digits is refused as the core refuses a bad one", async () => {
  const { runtime, stream, events, lua } = await tokenGlue(4);
  try {
    const done = runtime.api.login("TESTER", "secret");
    await settle();
    lua('TokenEntered("12"); return 1');
    await done;
    assert.equal(stream.sent.length, 1, "no proof with a code the core cannot accept");
    const last = events.filter(([event]) => event === "OPEN_STATUS_DIALOG").at(-1);
    assert.equal(last[1], "OKAY");
  } finally {
    runtime.close();
  }
});

test("an account without a code is never asked for one", async () => {
  const { runtime, stream, events } = await tokenGlue(0);
  try {
    await runtime.api.login("TESTER", "secret");
    assert.equal(events.some(([event]) => event === "PLAYER_ENTER_TOKEN"), false);
    assert.equal(stream.sent.length, 2);
    assert.equal(stream.sent[1].at(-1), 0, "security flags 0, nothing after");
  } finally {
    runtime.close();
  }
});

test("GetUsesToken remembers what SetUsesToken said", async () => {
  const { runtime, lua } = await tokenGlue(0);
  try {
    assert.equal(lua("return GetUsesToken()"), false);
    lua("SetUsesToken(true); return 1");
    assert.equal(lua("return GetUsesToken()"), true);
    lua("SetUsesToken(false); return 1");
    assert.equal(lua("return GetUsesToken()"), false);
    lua("SetUsesToken(1); return 1");
    assert.equal(lua("return GetUsesToken()"), true);
  } finally {
    runtime.close();
  }
});

test("loginToRealmList asks for the code only when the challenge wants one", async () => {
  let asked = 0;
  const stream = authStream(4);
  await assert.rejects(loginToRealmList(stream, {
    username: "tester", password: "x", onTokenRequired: async () => { asked++; return "000123"; },
  }), (error) => error.code === 4);
  assert.equal(asked, 1);
  assert.deepEqual([...stream.sent[1].slice(-7)], [6, 0x30, 0x30, 0x30, 0x31, 0x32, 0x33]);

  const refused = authStream(4);
  await assert.rejects(loginToRealmList(refused, {
    username: "tester", password: "x", onTokenRequired: async () => { throw new Error("cancelled"); },
  }), /cancelled/);
  assert.equal(refused.sent.length, 1);
});
