// 10.01 — failed logins counted per player address in the gateway, because the authserver sees every
// player as the gateway itself.
//
// Three layers: the reading of the authserver's answers (AuthLoginVerdict.ts), the limiter with an
// injected clock (LoginAttemptLimiter.ts), and the real `startGateway` on port 0 relaying to a TCP
// stand-in for the authserver that answers a wrong or a right password. Player addresses are
// documentation ranges (203.0.113.0/24, 2001:db8::/32); the test addresses reach the limiter through
// the gateway's existing `peerAddress` seam, never through a header the gateway itself would read.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import WebSocket from "ws";
import { AUTH_VERDICT_PREFIX_LIMIT, AuthAnswerWatch, authLoginVerdict } from "../dist/code/gateway/AuthLoginVerdict.js";
import {
  LOGIN_ATTEMPT_DEFAULTS, LOGIN_REFUSED_CLOSE, LoginAttemptLimiter, loginAttemptKey, loginRefusalReason,
  parseLoginAttemptEnv, watchLoginAttempt,
} from "../dist/code/gateway/LoginAttemptLimiter.js";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { describeFailure } from "../dist/code/browser/glue/GlueMessages.js";
import { TransportClosedError } from "../dist/code/transport/WebSocketByteStream.js";

const ORIGIN = "http://127.0.0.1:5173";
const MINUTE = 60_000;

/** A successful AUTH_LOGON_CHALLENGE answer as `LogonChallengeCallback` writes it. */
function challengeOk({ flags = 0, gLength = 1, nLength = 32, extra } = {}) {
  const extraLength = (flags & 1 ? 20 : 0) + (flags & 2 ? 12 : 0) + (flags & 4 ? 1 : 0);
  const bytes = [0x00, 0x00, 0x00, ...new Array(32).fill(0xb0), gLength, ...new Array(gLength).fill(7),
    nLength, ...new Array(nLength).fill(0xab), ...new Array(32).fill(0x5a), ...new Array(16).fill(0xc1), flags];
  // Extras that read like a successful proof answer, so a parser that forgot them gets it wrong.
  const fill = extra ?? Array.from({ length: extraLength }, (_, index) => (index % 2 === 0 ? 0x01 : 0x00));
  assert.equal(fill.length, extraLength);
  return Uint8Array.from([...bytes, ...fill]);
}
const PROOF_WRONG = Uint8Array.of(0x01, 0x04, 0x00, 0x00);
const PROOF_OK = Uint8Array.from([0x01, 0x00, ...new Array(20).fill(0x33), 0x00, 0x00, 0x80, 0x00, 0, 0, 0, 0, 0, 0]);
const concat = (...parts) => Uint8Array.from(parts.flatMap((part) => [...part]));

/** Feeds `bytes` one at a time and returns the verdict and how many bytes it took to reach it. */
function verdictByteByByte(bytes) {
  for (let length = 0; length <= bytes.length; length++) {
    const verdict = authLoginVerdict(bytes.subarray(0, length));
    if (verdict !== undefined) return { verdict, at: length };
  }
  return { verdict: undefined, at: bytes.length };
}

test("the authserver's answers decide one attempt: wrong account or password, success, or neither", () => {
  assert.equal(authLoginVerdict(new Uint8Array(0)), undefined);
  // AUTH_LOGON_CHALLENGE refusals: an unknown account counts; bans, suspension, version, busy do not.
  assert.deepEqual(verdictByteByByte(Uint8Array.of(0x00, 0x00, 0x04)), { verdict: "failure", at: 3 });
  assert.equal(authLoginVerdict(Uint8Array.of(0x00, 0x00, 0x05)), "failure", "WOW_FAIL_INCORRECT_PASSWORD");
  for (const code of [0x03, 0x08, 0x09, 0x0c, 0x10, 0x19]) {
    assert.equal(authLoginVerdict(Uint8Array.of(0x00, 0x00, code)), "other", `challenge result ${code}`);
  }
  // A successful challenge waits for the proof answer, exactly where the challenge ends.
  const challenge = challengeOk();
  assert.equal(challenge.length, 119, "TrinityCore's answer for an account without security flags");
  assert.deepEqual(verdictByteByByte(concat(challenge, PROOF_WRONG)), { verdict: "failure", at: 121 });
  assert.deepEqual(verdictByteByByte(concat(challenge, PROOF_OK)), { verdict: "success", at: 121 });
  assert.equal(authLoginVerdict(concat(challenge, [0x01, 0x05])), "failure");
  assert.equal(authLoginVerdict(concat(challenge, [0x01, 0x09])), "other", "version refused after a right password");
  assert.equal(authLoginVerdict(concat(challenge, [0x10, 0x00])), "other", "anything but a proof answer");
  // The security flags' extras are skipped: authenticator (1 byte), and PIN + matrix + token (33).
  for (const flags of [4, 1 | 2 | 4, 2]) {
    const withFlags = challengeOk({ flags });
    assert.equal(authLoginVerdict(concat(withFlags, PROOF_WRONG)), "failure", `flags ${flags}`);
    assert.equal(authLoginVerdict(withFlags), undefined, `flags ${flags}: still waiting for the proof`);
  }
  // g and N are read by their own lengths, not assumed to be TrinityCore's 1 and 32.
  assert.equal(authLoginVerdict(concat(challengeOk({ gLength: 2, nLength: 64 }), PROOF_OK)), "success");
  // AUTH_RECONNECT_CHALLENGE: an unknown account counts, so the reconnect path enumerates nothing.
  assert.equal(authLoginVerdict(Uint8Array.of(0x02, 0x04)), "failure");
  assert.equal(authLoginVerdict(Uint8Array.of(0x02, 0x00, 1, 2, 3)), "other");
  assert.equal(authLoginVerdict(Uint8Array.of(0x02)), undefined);
  // Anything else first is not a login this reader knows.
  assert.equal(authLoginVerdict(Uint8Array.of(0x10, 0x05, 0x00)), "other");
  // The largest challenge answer the layout allows still decides inside the prefix limit.
  const largest = concat(challengeOk({ flags: 7, gLength: 255, nLength: 255 }), PROOF_WRONG.subarray(0, 2));
  assert.equal(largest.length, AUTH_VERDICT_PREFIX_LIMIT);
  assert.equal(authLoginVerdict(largest), "failure");
});

test("the watch takes TCP's chunks as they come and reports one verdict", () => {
  const verdicts = [];
  const watch = new AuthAnswerWatch((verdict) => verdicts.push(verdict));
  const stream = concat(challengeOk({ flags: 4 }), PROOF_WRONG, PROOF_OK);
  for (const byte of stream) watch.feed(Uint8Array.of(byte));
  assert.deepEqual(verdicts, ["failure"], "the first deciding answer only");
  assert.equal(watch.verdict, "failure");

  // One chunk far larger than the prefix it needs.
  const big = [];
  const bigWatch = new AuthAnswerWatch((verdict) => big.push(verdict));
  bigWatch.feed(concat(challengeOk(), PROOF_OK, new Uint8Array(64 * 1024)));
  assert.deepEqual(big, ["success"]);
});

test("watchLoginAttempt settles from the backend's bytes, or with nothing when the browser leaves", () => {
  const settled = [];
  const attempt = { settle: (verdict) => settled.push(verdict) };
  const backend = new EventEmitter();
  const client = new EventEmitter();
  watchLoginAttempt(backend, client, attempt);
  backend.emit("data", Buffer.from(challengeOk()));
  assert.deepEqual(settled, []);
  backend.emit("data", Buffer.from(PROOF_OK));
  assert.deepEqual(settled, ["success"]);
  assert.equal(backend.listenerCount("data"), 0, "the realm list that follows is not read");

  const undecided = [];
  const quiet = new EventEmitter();
  const leaving = new EventEmitter();
  watchLoginAttempt(quiet, leaving, { settle: (verdict) => undecided.push(verdict) });
  quiet.emit("data", Buffer.of(0x00, 0x00, 0x03));
  leaving.emit("close");
  assert.deepEqual(undecided, [undefined, undefined], "a ban decides nothing; the close settles too (the limiter ignores the second)");
});

function clock(start = 1_000_000) {
  const time = { now: start };
  return { time, now: () => time.now };
}

/** One whole attempt: admitted, then settled with `verdict`. Returns the admission. */
function attempt(limiter, key, verdict) {
  const admission = limiter.admit(key);
  if (admission.ok) admission.attempt.settle(verdict);
  return admission;
}

test("five failures within the window lock an address out for the lockout, then it starts afresh", () => {
  const { time, now } = clock();
  const lockouts = [];
  const limiter = new LoginAttemptLimiter({ now, onLockout: (lockout) => lockouts.push(lockout) });
  assert.deepEqual(limiter.limits, LOGIN_ATTEMPT_DEFAULTS);
  for (let index = 0; index < 5; index++) {
    assert.equal(attempt(limiter, "203.0.113.5", "failure").ok, true, `attempt ${index + 1}`);
    time.now += 1000;
  }
  assert.deepEqual(lockouts, [{ key: "203.0.113.5", failures: 5, windowMs: 15 * MINUTE, lockoutMs: 15 * MINUTE }]);
  const refused = limiter.admit("203.0.113.5");
  assert.equal(refused.ok, false);
  assert.equal(refused.retryAfterMs, 15 * MINUTE - 1000);
  assert.equal(limiter.admit("203.0.113.6").ok, true, "another address is not touched");

  time.now += 15 * MINUTE - 1001;
  assert.equal(limiter.admit("203.0.113.5").ok, false, "a millisecond before the end");
  time.now += 1;
  for (let index = 0; index < 4; index++) assert.equal(attempt(limiter, "203.0.113.5", "failure").ok, true);
  assert.equal(lockouts.length, 1, "after a lockout the full budget again, not a relock on the next mistake");
  assert.equal(attempt(limiter, "203.0.113.5", "failure").ok, true);
  assert.equal(lockouts.length, 2);
});

test("failures leave the window one by one, and a success clears them", () => {
  const { time, now } = clock();
  const limiter = new LoginAttemptLimiter({ now, limits: { maxFailures: 3, windowMs: 10 * MINUTE, lockoutMs: MINUTE } });
  attempt(limiter, "a", "failure");
  time.now += 5 * MINUTE;
  attempt(limiter, "a", "failure");
  attempt(limiter, "a", "failure"); // the third within ten minutes: locked
  assert.equal(limiter.admit("a").ok, false);

  // Sliding: two failures, the first ages out, so two more fit before the third in a window.
  attempt(limiter, "b", "failure");
  time.now += 6 * MINUTE;
  attempt(limiter, "b", "failure");
  time.now += 4 * MINUTE; // the first is exactly ten minutes old: out
  assert.equal(attempt(limiter, "b", "failure").ok, true);
  const busy = limiter.admit("b");
  assert.equal(busy.ok, true, "two in the window, one slot left");
  busy.attempt.settle(undefined);

  // A success empties the count; the address is then forgotten altogether.
  attempt(limiter, "c", "failure");
  attempt(limiter, "c", "failure");
  attempt(limiter, "c", "success");
  attempt(limiter, "c", "failure");
  attempt(limiter, "c", "failure");
  assert.equal(limiter.admit("c").ok, true, "two failures since the success, not four");
});

test("unanswered attempts hold the budget, so a parallel burst gets no more guesses than the limit", () => {
  const { time, now } = clock();
  const limiter = new LoginAttemptLimiter({ now, limits: { maxFailures: 3 } });
  const open = [limiter.admit("burst"), limiter.admit("burst"), limiter.admit("burst")];
  assert.ok(open.every((admission) => admission.ok));
  const fourth = limiter.admit("burst");
  assert.equal(fourth.ok, false, "three answers outstanding");
  assert.equal(fourth.retryAfterMs, 1000, "no failure yet: an answer is a second away");
  open[0].attempt.settle(undefined); // closed undecided: the slot comes back
  open[0].attempt.settle("failure"); // and settling twice changes nothing
  assert.equal(attempt(limiter, "burst", "failure").ok, true);
  time.now += 2000;
  const refused = limiter.admit("burst");
  assert.equal(refused.ok, false, "one failure and two outstanding");
  assert.equal(refused.retryAfterMs, 15 * MINUTE - 2000, "until that failure leaves the window");
  open[1].attempt.settle("failure");
  open[2].attempt.settle("failure");
  assert.equal(limiter.admit("burst").ok, false, "locked");
  assert.equal(limiter.size, 1);
});

test("the table is bounded: empty entries go at once, expired ones and then the oldest under pressure", () => {
  const { time, now } = clock();
  const limiter = new LoginAttemptLimiter({ now, limits: { maxFailures: 2, maxEntries: 3, windowMs: MINUTE, lockoutMs: MINUTE } });
  attempt(limiter, "quiet", undefined);
  attempt(limiter, "fine", "success");
  assert.equal(limiter.size, 0, "an address that holds nothing is not kept");

  attempt(limiter, "old", "failure");
  time.now += MINUTE; // its failure has left the window
  attempt(limiter, "x", "failure");
  attempt(limiter, "y", "failure");
  attempt(limiter, "z", "failure"); // full: "old" is swept, nothing that still counts is lost
  assert.equal(limiter.size, 3);
  attempt(limiter, "x", "failure"); // x locked, and now the most recently used
  assert.equal(limiter.admit("x").ok, false);

  attempt(limiter, "w", "failure"); // full of live entries: the least recently used (y) goes
  assert.equal(limiter.size, 3);
  assert.equal(limiter.admit("x").ok, false, "the locked address was used last, so it stays");
  attempt(limiter, "y", "failure");
  assert.equal(limiter.admit("y").ok, true, "y was forgotten, so this was its first failure again");

  for (let index = 0; index < 1000; index++) attempt(limiter, `203.0.113.${index % 256}-${index}`, "failure");
  assert.equal(limiter.size, 3, "a thousand addresses later, still the cap");
});

test("limits are checked like the bridge's: a value that would switch the limit off throws", () => {
  assert.throws(() => new LoginAttemptLimiter({ limits: { maxFailures: 0 } }), RangeError);
  assert.throws(() => new LoginAttemptLimiter({ limits: { maxFailures: 2.5 } }), RangeError);
  assert.throws(() => new LoginAttemptLimiter({ limits: { windowMs: 0 } }), RangeError);
  assert.throws(() => new LoginAttemptLimiter({ limits: { lockoutMs: Number.NaN } }), RangeError);
  assert.throws(() => new LoginAttemptLimiter({ limits: { maxEntries: 0 } }), RangeError);
});

test("an address is counted by the socket's spelling of it, IPv6 by its /64", () => {
  assert.equal(loginAttemptKey("203.0.113.7"), "203.0.113.7");
  assert.equal(loginAttemptKey("::ffff:203.0.113.7"), "203.0.113.7", "IPv4-mapped is the same player");
  assert.equal(loginAttemptKey("::FFFF:203.0.113.7"), "203.0.113.7");
  assert.equal(loginAttemptKey("127.0.0.1"), "127.0.0.1", "loopback is counted like anyone");
  assert.equal(loginAttemptKey("::1"), "::1");
  assert.equal(loginAttemptKey("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.equal(loginAttemptKey("2001:0DB8:0001:0002:ffff::1"), "2001:db8:1:2::/64", "same /64, other host");
  assert.equal(loginAttemptKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(loginAttemptKey("::2:3:4:5:6:7:8"), "0:2:3:4::/64");
  assert.equal(loginAttemptKey("64:ff9b::203.0.113.7"), "64:ff9b:0:0::/64", "a dotted tail fills two groups");
  assert.equal(loginAttemptKey("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(loginAttemptKey(undefined), "unknown");
  assert.equal(loginAttemptKey(""), "unknown");
});

test("the environment sets the limits in minutes; 0 failures switches the limit off; nonsense refuses to start", () => {
  assert.deepEqual(parseLoginAttemptEnv({}), LOGIN_ATTEMPT_DEFAULTS);
  assert.deepEqual(parseLoginAttemptEnv({
    GATEWAY_LOGIN_MAX_FAILURES: " 8 ", GATEWAY_LOGIN_WINDOW_MIN: "30", GATEWAY_LOGIN_LOCKOUT_MIN: "0.5",
  }), { ...LOGIN_ATTEMPT_DEFAULTS, maxFailures: 8, windowMs: 30 * MINUTE, lockoutMs: 30_000 });
  assert.equal(parseLoginAttemptEnv({ GATEWAY_LOGIN_MAX_FAILURES: "0" }), false);
  for (const [name, value] of [
    ["GATEWAY_LOGIN_MAX_FAILURES", "-1"], ["GATEWAY_LOGIN_MAX_FAILURES", "2.5"], ["GATEWAY_LOGIN_MAX_FAILURES", "five"],
    ["GATEWAY_LOGIN_MAX_FAILURES", "1001"], ["GATEWAY_LOGIN_WINDOW_MIN", "0"], ["GATEWAY_LOGIN_WINDOW_MIN", "1441"],
    ["GATEWAY_LOGIN_LOCKOUT_MIN", "soon"], ["GATEWAY_LOGIN_LOCKOUT_MIN", "-5"],
  ]) {
    assert.throws(() => parseLoginAttemptEnv({ [name]: value }), new RegExp(name), `${name}=${value}`);
  }
});

test("the refusal reason fits a WebSocket close frame and says when to come back", () => {
  assert.equal(LOGIN_REFUSED_CLOSE, 4290);
  assert.equal(loginRefusalReason(15 * MINUTE), "Too many login attempts; retry in 900 s");
  assert.equal(loginRefusalReason(1), "Too many login attempts; retry in 1 s");
  assert.ok(Buffer.byteLength(loginRefusalReason(24 * 60 * MINUTE)) <= 123);
});

/**
 * An authserver stand-in: a challenge (0x00) gets a successful challenge answer, a proof (0x01) gets
 * WOW_FAIL_UNKNOWN_ACCOUNT when its second byte is 0xEE, a success otherwise.
 */
async function authserverStub() {
  const sockets = new Set();
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      if (chunk[0] === 0x00) socket.write(challengeOk());
      else if (chunk[0] === 0x01) socket.write(chunk[1] === 0xee ? PROOF_WRONG : PROOF_OK);
    });
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

const ACCOUNT = "SECRETACCOUNT";
/** A logon challenge carrying an account name, enough for the stub (it reads the command only). */
const CHALLENGE = Uint8Array.from([0x00, 0x08, 30 + ACCOUNT.length, 0x00, ...Buffer.from("WoW\0"), 3, 3, 5, 0x34, 0x30,
  ...new Array(20).fill(0), ACCOUNT.length, ...Buffer.from(ACCOUNT)]);

/**
 * One login through the gateway as `peer`: the challenge, then a proof with the right or wrong
 * password. Resolves once the socket is closed — with the proof answer's result byte, or with the
 * close code and reason when the gateway closed it first — so the next login never overlaps this one.
 */
function login(port, peer, password) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/auth`, { origin: ORIGIN, headers: { "x-test-peer": peer } });
    let received = Buffer.alloc(0);
    let proofSent = false;
    let answer;
    socket.on("error", (error) => reject(error));
    socket.once("unexpected-response", (_, response) => reject(new Error(`upgrade answered ${response.statusCode}`)));
    socket.once("open", () => socket.send(CHALLENGE));
    socket.on("message", (data) => {
      received = Buffer.concat([received, data]);
      if (!proofSent && received.length >= 119) {
        proofSent = true;
        received = received.subarray(119);
        socket.send(Uint8Array.of(0x01, password === "right" ? 0x00 : 0xee));
      }
      if (proofSent && received.length >= 2 && answer === undefined) {
        answer = { result: received[1] };
        socket.close();
      }
    });
    socket.once("close", (code, reason) => resolve(answer ?? { closed: code, reason: reason.toString() }));
  });
}

test("the real gateway refuses an address after its failed logins, and only that address", async () => {
  const backend = await authserverStub();
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: backend.port },
    world: { host: "127.0.0.1", port: backend.port },
    allowedOrigins: [ORIGIN],
    datasetPollMs: 0,
    // The test's players: the seam the module-write route already has, read by the limiter too.
    peerAddress: (request) => request.headers["x-test-peer"] ?? request.socket.remoteAddress,
    loginAttempts: { maxFailures: 3, windowMs: MINUTE, lockoutMs: MINUTE },
  });
  try {
    for (let index = 0; index < 3; index++) {
      assert.deepEqual(await login(gateway.port, "203.0.113.10", "wrong"), { result: 0x04 }, `wrong password ${index + 1}`);
    }
    assert.equal(backend.connections, 3);
    const refused = await login(gateway.port, "203.0.113.10", "right");
    assert.equal(refused.closed, LOGIN_REFUSED_CLOSE);
    assert.match(refused.reason, /^Too many login attempts; retry in (59|60) s$/);
    assert.equal(backend.connections, 3, "the refused login never reached the authserver");
    // The same player written IPv4-mapped, as a dual-stack socket would report it.
    assert.equal((await login(gateway.port, "::ffff:203.0.113.10", "right")).closed, LOGIN_REFUSED_CLOSE);
    // What the page shows for that close: the client's LOGIN_TOO_FAST, in Russian when no corpus has it.
    const shown = describeFailure(new TransportClosedError(refused.closed, refused.reason, true), "auth");
    assert.equal(shown.key, "LOGIN_TOO_FAST");
    assert.match(shown.text, /Слишком много попыток/);

    // The lockout is logged once, with the address and without the account name.
    const lockoutLines = warnings.filter((line) => line.includes("logins within"));
    assert.equal(lockoutLines.length, 1, warnings.join("\n"));
    assert.match(lockoutLines[0], /203\.0\.113\.10 failed 3 logins within 1 min; its \/auth connections are refused for 1 min/);
    assert.ok(!warnings.some((line) => line.includes(ACCOUNT)));

    // Another player is untouched, and a success in between clears that player's own count.
    for (const password of ["wrong", "wrong", "right", "wrong", "wrong"]) {
      assert.deepEqual(await login(gateway.port, "203.0.113.20", password), { result: password === "right" ? 0x00 : 0x04 });
    }
    assert.deepEqual(await login(gateway.port, "203.0.113.20", "right"), { result: 0x00 }, "two failures since the success");
    assert.equal(backend.connections, 9);
  } finally {
    console.warn = warn;
    await gateway.close();
    await backend.close();
  }
});

test("loginAttempts: false relays every login, as before the limit", async () => {
  const backend = await authserverStub();
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: backend.port },
    world: { host: "127.0.0.1", port: backend.port },
    allowedOrigins: [ORIGIN],
    datasetPollMs: 0,
    loginAttempts: false,
  });
  try {
    for (let index = 0; index < 7; index++) {
      assert.deepEqual(await login(gateway.port, "ignored", "wrong"), { result: 0x04 });
    }
    assert.equal(backend.connections, 7);
  } finally {
    await gateway.close();
    await backend.close();
  }
});
