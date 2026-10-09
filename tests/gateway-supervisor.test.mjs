import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { patchChangeMessage, superviseGateway } from "../dist/code/gateway/SupervisedGateway.js";
import { GatewaySupervisor, SUPERVISOR_DEFAULTS, restartDecision, supervisorOptionsFromEnv } from "../tools/gateway-supervisor.mjs";
import { repositoryRoot } from "../tools/paths.mjs";

test("the restart decision waits for a quiet chain, a finished build and an empty world", () => {
  const base = { latchAt: 100_000, lastChangeAt: 100_000, childStartedAt: 50_000 };
  assert.deepEqual(restartDecision({ ...base, latchAt: undefined, now: 200_000 }), { action: "wait", reason: "current" });
  assert.deepEqual(restartDecision({ ...base, now: 104_999 }), { action: "wait", reason: "writing" });
  assert.deepEqual(restartDecision({ ...base, lastChangeAt: 103_000, now: 107_000 }), { action: "wait", reason: "writing" },
    "every later change restarts the quiet window");
  assert.deepEqual(restartDecision({ ...base, now: 105_000 }), { action: "wait", reason: "build" }, "no marker yet");
  assert.deepEqual(restartDecision({ ...base, now: 105_000, markerFinishedAt: 40_000 }), { action: "wait", reason: "build" },
    "a marker from before this gateway started is an older build");
  assert.deepEqual(restartDecision({ ...base, now: 105_000, markerFinishedAt: 60_000 }), { action: "wait", reason: "build" },
    "a marker long before the latch is not the build that caused it");
  assert.deepEqual(restartDecision({ ...base, now: 105_000, markerFinishedAt: 85_000 }), { action: "ask" },
    "a latch noticed late (idle fallback walk) still pairs with its marker");
  assert.deepEqual(restartDecision({ ...base, now: 105_000, markerFinishedAt: 104_000 }), { action: "ask" });
  assert.deepEqual(restartDecision({ ...base, now: 105_000, markerFinishedAt: 104_000, clients: { auth: 0, world: 1 } }),
    { action: "wait", reason: "players" });
  assert.deepEqual(restartDecision({ ...base, now: 105_000, markerFinishedAt: 104_000, clients: { auth: 1, world: 0 } }),
    { action: "wait", reason: "players" }, "a login in progress counts too");
  assert.deepEqual(restartDecision({ ...base, now: 105_000, markerFinishedAt: 104_000, clients: { auth: 0, world: 0 } }),
    { action: "restart", reason: "build-finished" });
  assert.deepEqual(
    restartDecision({ ...base, now: 100_000 + SUPERVISOR_DEFAULTS.buildTimeoutMs, clients: { auth: 0, world: 0 } }),
    { action: "restart", reason: "timeout" }, "edits that write no marker restart after the timeout");
});

/** A child process as the supervisor sees it: IPC messages in and out, and an exit. */
class FakeChild extends EventEmitter {
  sent = [];
  killed = false;
  channelOpen = true;

  send(message, callback) {
    if (!this.channelOpen) {
      // Node reports a closed channel asynchronously, through the callback or an 'error' event.
      queueMicrotask(() => (callback ? callback(new Error("Channel closed")) : this.emit("error", new Error("Channel closed"))));
      return false;
    }
    this.sent.push(message);
    callback?.(null);
    return true;
  }

  kill() {
    this.killed = true;
  }

  reply(message) {
    this.emit("message", message);
  }

  exit(code = 0, signal = null) {
    this.channelOpen = false;
    this.emit("exit", code, signal);
  }
}

function harness({ marker } = {}) {
  let now = 0;
  const timers = new Map();
  let nextTimer = 1;
  const children = [];
  const logs = [];
  const exits = [];
  const state = { marker };
  const deps = {
    fork: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    readMarker: async () => state.marker,
    now: () => now,
    setInterval: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: now + ms, every: ms }); return id; },
    clearInterval: (id) => timers.delete(id),
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    log: (message) => logs.push(message),
    exit: (code) => exits.push(code),
  };
  /** Moves the manual clock, firing due timers in order and letting their promises settle. */
  async function advance(ms) {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.every) timer.at += timer.every;
      else timers.delete(id);
      timer.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }
    now = until;
  }
  return { deps, children, logs, exits, state, advance, get now() { return now; } };
}

test("a settled build with nobody connected restarts the forked gateway once", async () => {
  const h = harness();
  const supervisor = new GatewaySupervisor(h.deps);
  supervisor.start();
  assert.equal(h.children.length, 1);
  const first = h.children[0];
  first.reply({ type: "ready", generation: "aaaa" });
  assert.equal(supervisor.phase, "running");
  await h.advance(10_000);
  assert.deepEqual(first.sent, [], "a current gateway is left alone");

  first.reply({ type: "patch-chain-changed", first: true });
  await h.advance(2_000);
  first.reply({ type: "patch-chain-changed", first: false });
  await h.advance(4_000);
  assert.deepEqual(first.sent, [], "still writing: the second change restarted the quiet window");
  await h.advance(2_000);
  assert.deepEqual(first.sent, [], "quiet, but no build marker yet");

  h.state.marker = new Date(h.now).toISOString();
  await h.advance(1_000);
  assert.deepEqual(first.sent, [{ type: "status?" }], "the build finished: count the players");
  first.reply({ type: "status", auth: 0, world: 2 });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.sent.filter((message) => message.type === "shutdown").length, 0, "two players in the world");
  assert.ok(h.logs.some((line) => /waiting for 2 connected session/.test(line)));

  await h.advance(1_000);
  assert.equal(first.sent.at(-1).type, "status?", "asks again while players are what it waits for");
  first.reply({ type: "status", auth: 0, world: 0 });
  await h.advance(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(first.sent.at(-1), { type: "shutdown", reason: "restart" });
  assert.equal(supervisor.phase, "restarting");

  first.exit(0);
  assert.equal(h.children.length, 2, "forked again, without a rebuild");
  const second = h.children[1];
  second.reply({ type: "ready", generation: "bbbb" });
  assert.equal(supervisor.phase, "running");
  assert.equal(supervisor.restarts, 1);
  assert.ok(h.logs.some((line) => /gateway restarted \(generation bbbb\)/.test(line)));
  await h.advance(30_000);
  assert.deepEqual(second.sent, [], "the new gateway starts unlatched");
  assert.deepEqual(h.exits, []);
});

test("without a marker the supervisor restarts after the build timeout", async () => {
  const h = harness();
  const supervisor = new GatewaySupervisor(h.deps, { buildTimeoutMs: 60_000 });
  supervisor.start();
  const child = h.children[0];
  child.reply({ type: "ready" });
  child.reply({ type: "patch-chain-changed" });
  await h.advance(59_000);
  assert.deepEqual(child.sent, []);
  await h.advance(1_000);
  assert.deepEqual(child.sent, [{ type: "status?" }]);
  child.reply({ type: "status", auth: 0, world: 0 });
  await h.advance(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(child.sent.at(-1), { type: "shutdown", reason: "restart" });
  assert.ok(h.logs.some((line) => /no build marker after 60 s/.test(line)));
});

test("a child that ignores shutdown is killed, and a restart that dies before ready is retried", async () => {
  const h = harness();
  const supervisor = new GatewaySupervisor(h.deps, { buildTimeoutMs: 0, quietMs: 0, retryDelaysMs: [2_000, 5_000] });
  supervisor.start();
  const first = h.children[0];
  first.reply({ type: "ready" });
  first.reply({ type: "patch-chain-changed" });
  await h.advance(1_000);
  first.reply({ type: "status", auth: 0, world: 0 });
  await h.advance(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(first.sent.at(-1), { type: "shutdown", reason: "restart" });
  await h.advance(SUPERVISOR_DEFAULTS.shutdownTimeoutMs);
  assert.equal(first.killed, true);
  first.exit(null, "SIGTERM");

  // The chain moved under the new child's startup (a build still writing): it exits unready.
  const second = h.children[1];
  second.exit(1);
  assert.equal(supervisor.phase, "waiting-retry");
  await h.advance(1_999);
  assert.equal(h.children.length, 2);
  await h.advance(1);
  assert.equal(h.children.length, 3, "retried after the first delay");
  h.children[2].exit(1);
  await h.advance(5_000);
  assert.equal(h.children.length, 4, "then after the next");
  h.children[3].reply({ type: "ready" });
  assert.equal(supervisor.phase, "running");
  assert.deepEqual(h.exits, []);
});

test("a failed first start, or a clean exit, ends the supervisor like an unsupervised gateway", () => {
  const failedStart = harness();
  new GatewaySupervisor(failedStart.deps).start();
  failedStart.children[0].exit(1);
  assert.deepEqual(failedStart.exits, [1]);
  assert.equal(failedStart.children.length, 1, "no restart loop over a broken configuration");

  // Ctrl+C reaching the child first: it leaves with 0, and that is not a crash.
  const clean = harness();
  new GatewaySupervisor(clean.deps).start();
  clean.children[0].reply({ type: "ready" });
  clean.children[0].exit(0);
  assert.deepEqual(clean.exits, [0]);
  assert.equal(clean.children.length, 1);
});

test("10.15 (A): a running gateway that crashes is started again, with growing pauses", async () => {
  const h = harness();
  const supervisor = new GatewaySupervisor(h.deps);
  supervisor.start();
  h.children[0].reply({ type: "ready" });
  h.children[0].exit(3);
  assert.deepEqual(h.exits, [], "the supervisor stays");
  assert.equal(supervisor.phase, "waiting-retry");
  assert.ok(h.logs.some((line) => /gateway exited \(code 3\); restarting in 1 s \(crash 1 of 5 allowed in 10 min\)/.test(line)),
    h.logs.join("\n"));
  await h.advance(999);
  assert.equal(h.children.length, 1);
  await h.advance(1);
  assert.equal(h.children.length, 2, "forked again after 1 s");
  h.children[1].reply({ type: "ready" });
  assert.equal(supervisor.phase, "running");
  h.children[1].exit(null, "SIGKILL");
  await h.advance(1_999);
  assert.equal(h.children.length, 2);
  await h.advance(1);
  assert.equal(h.children.length, 3, "the second crash waits 2 s");
  assert.deepEqual(h.exits, []);
});

test("10.15 (A): a sixth crash inside ten minutes ends the supervisor; crashes spread wider do not add up", async () => {
  const h = harness();
  const supervisor = new GatewaySupervisor(h.deps);
  supervisor.start();
  const crashOnce = async () => {
    const child = h.children.at(-1);
    child.reply({ type: "ready" });
    child.exit(1);
    await h.advance(60_000);
  };
  for (let crash = 0; crash < 5; crash++) await crashOnce();
  assert.deepEqual(h.exits, []);
  assert.equal(h.children.length, 6, "five restarts");
  h.children.at(-1).reply({ type: "ready" });
  h.children.at(-1).exit(7);
  assert.deepEqual(h.exits, [7], "the sixth crash in the window is not hidden");
  assert.ok(h.logs.some((line) => /crashed 6 times in 10 min \(code 7\); giving up/.test(line)));
  assert.equal(supervisor.phase, "exited");

  const spread = harness();
  new GatewaySupervisor(spread.deps).start();
  for (let crash = 0; crash < 8; crash++) {
    const child = spread.children.at(-1);
    child.reply({ type: "ready" });
    await spread.advance(5 * 60_000);
    child.exit(1);
    await spread.advance(60_000);
  }
  assert.deepEqual(spread.exits, [], "one crash every six minutes never reaches five in ten");
  assert.equal(spread.children.length, 9);
});

test("10.15 (A): a stop during the pause after a crash forks nothing", async () => {
  const h = harness();
  const supervisor = new GatewaySupervisor(h.deps);
  supervisor.start();
  h.children[0].reply({ type: "ready" });
  h.children[0].exit(1);
  supervisor.stop();
  await h.advance(120_000);
  assert.equal(h.children.length, 1);
  assert.deepEqual(h.exits, [0]);
});

test("10.15: GATEWAY_SUPERVISE alone restarts crashes and leaves a patch change to the owner", async () => {
  const h = harness({ marker: new Date(0).toISOString() });
  const supervisor = new GatewaySupervisor(h.deps, { restartOnPatch: false, buildTimeoutMs: 0, quietMs: 0 });
  supervisor.start();
  const child = h.children[0];
  child.reply({ type: "ready" });
  child.reply({ type: "patch-chain-changed" });
  await h.advance(300_000);
  assert.deepEqual(child.sent, [], "no status?, no shutdown");
  assert.ok(h.logs.some((line) => /restart the gateway yourself/.test(line)));
  child.exit(1);
  await h.advance(1_000);
  assert.equal(h.children.length, 2, "a crash is still restarted");
});

test("10.15: the supervisor options come from the environment, and a bad deadline is refused", () => {
  assert.deepEqual(supervisorOptionsFromEnv({}), { restartOnPatch: false });
  assert.deepEqual(supervisorOptionsFromEnv({ GATEWAY_RESTART_ON_PATCH: "1" }), { restartOnPatch: true });
  assert.deepEqual(supervisorOptionsFromEnv({ GATEWAY_RESTART_ON_PATCH: "1", GATEWAY_RESTART_DEADLINE_MIN: "15" }),
    { restartOnPatch: true, playerDeadlineMs: 15 * 60_000 });
  assert.deepEqual(supervisorOptionsFromEnv({ GATEWAY_RESTART_DEADLINE_MIN: "" }), { restartOnPatch: false });
  for (const bad of ["-1", "1.5", "soon", "100000"]) {
    assert.throws(() => supervisorOptionsFromEnv({ GATEWAY_RESTART_DEADLINE_MIN: bad }), /GATEWAY_RESTART_DEADLINE_MIN/);
  }
  assert.equal(SUPERVISOR_DEFAULTS.playerDeadlineMs, 0, "by default players hold a restart back for ever");
});

test("10.15 (B): past the owner's deadline players no longer hold the restart back", () => {
  const base = { latchAt: 100_000, lastChangeAt: 100_000, childStartedAt: 50_000, markerFinishedAt: 104_000 };
  const players = { auth: 0, world: 2 };
  assert.deepEqual(restartDecision({ ...base, now: 200_000, clients: players, settledAt: 105_000 }),
    { action: "wait", reason: "players" }, "no deadline: wait for ever");
  assert.deepEqual(restartDecision({ ...base, now: 704_999, clients: players, settledAt: 105_000, playerDeadlineMs: 600_000 }),
    { action: "wait", reason: "players" });
  assert.deepEqual(restartDecision({ ...base, now: 705_000, clients: players, settledAt: 105_000, playerDeadlineMs: 600_000 }),
    { action: "restart", reason: "deadline", force: true });
  assert.deepEqual(restartDecision({ ...base, now: 105_000, playerDeadlineMs: 600_000, settledAt: undefined }),
    { action: "ask" }, "the deadline counts from when the build settled, not from the latch");
});

test("10.15 (B): the supervisor forces the restart at the deadline and the gateway leaves with players", async () => {
  const h = harness();
  const gateways = supervisedGateways(h);
  const supervisor = new GatewaySupervisor(h.deps, { buildTimeoutMs: 0, quietMs: 0, playerDeadlineMs: 60_000 });
  supervisor.start();
  await flush();
  const [first] = gateways;
  first.sessions = [{ auth: 0, world: 1 }];
  first.channel.send(patchChangeMessage({ at: new Date(h.now).toISOString(), first: true, epoch: 1, changes: 1 }));
  await flush();
  await h.advance(30_000);
  await flush();
  assert.deepEqual(first.shutdowns, [], "inside the deadline the player keeps the gateway");
  await h.advance(31_000);
  await flush();
  assert.deepEqual(h.children[0].sent.at(-1), { type: "shutdown", reason: "restart", force: true });
  assert.deepEqual(first.shutdowns, [0], "a forced restart is not declined");
  assert.ok(h.logs.some((line) => /players held the restart back for 1 min/.test(line)));
  await flush();
  assert.equal(h.children.length, 2);
});

test("Ctrl+C asks the child to close and leaves with it; a closed channel is not a crash", async () => {
  const h = harness();
  const supervisor = new GatewaySupervisor(h.deps);
  supervisor.start();
  const child = h.children[0];
  child.reply({ type: "ready" });
  // Ctrl+C reaches both processes: the child is already leaving when the supervisor asks.
  child.channelOpen = false;
  supervisor.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.phase, "stopping");
  // However the child goes (here: killed once the shutdown timed out), a requested stop is not a crash.
  child.exit(null, "SIGTERM");
  assert.deepEqual(h.exits, [0]);
  assert.equal(h.children.length, 1, "no restart after a stop");

  const late = harness();
  const lateSupervisor = new GatewaySupervisor(late.deps);
  lateSupervisor.start();
  late.children[0].reply({ type: "ready" });
  // An IPC error event with no listener would throw out of EventEmitter.emit.
  assert.doesNotThrow(() => late.children[0].emit("error", new Error("EPIPE")));
});

/** Lets queued microtasks and the supervisor's marker read run. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test("a status? that is never answered is asked again, so a latched gateway is not stuck", async () => {
  const h = harness({ marker: new Date(0).toISOString() });
  const supervisor = new GatewaySupervisor(h.deps, { buildTimeoutMs: 0, quietMs: 0, statusTimeoutMs: 5_000 });
  supervisor.start();
  const child = h.children[0];
  child.reply({ type: "ready" });
  child.reply({ type: "patch-chain-changed" });
  await h.advance(1_000);
  assert.deepEqual(child.sent, [{ type: "status?" }]);
  await h.advance(3_000);
  assert.equal(child.sent.length, 1, "inside the timeout: one question in flight");
  await h.advance(2_000);
  assert.deepEqual(child.sent, [{ type: "status?" }, { type: "status?" }]);
  assert.equal(h.logs.filter((line) => /did not answer status\?/.test(line)).length, 1);
  await h.advance(10_000);
  assert.equal(h.logs.filter((line) => /did not answer status\?/.test(line)).length, 1, "said once, not every five seconds");
  child.reply({ type: "status", auth: 0, world: 0 });
  await flush();
  assert.deepEqual(child.sent.at(-1), { type: "shutdown", reason: "restart" });
});

/**
 * The real child half (src/gateway/SupervisedGateway.ts) behind each forked child, over an in-memory
 * channel, around a fake gateway: the protocol is tested from both ends, not against a re-implementation.
 */
function supervisedGateways(h) {
  const gateways = [];
  h.deps.fork = () => {
    const child = new FakeChild();
    h.children.push(child);
    const gateway = {
      summary: { generation: `gen${h.children.length}`, stale: false, lastChangeAt: null },
      /** Session counts in the order `connections()` is asked; the last one repeats. */
      sessions: [{ auth: 0, world: 0 }],
      pending: false,
      walks: 0,
      shutdowns: [],
      patchSummary() { return this.summary; },
      async checkPatchChain() { this.walks++; this.pending = false; return this.summary; },
      get patchEventsPending() { return this.pending; },
      connections() { return { ...(this.sessions.length > 1 ? this.sessions.shift() : this.sessions[0]) }; },
    };
    let toChild;
    const channel = {
      // Replies arrive as the supervisor's 'message' events, after it has attached its listener.
      send: (message) => { queueMicrotask(() => { if (child.channelOpen) child.reply(message); }); },
      onMessage: (listener) => { toChild = listener; },
      onDisconnect: (listener) => { gateway.disconnect = listener; },
    };
    const send = child.send.bind(child);
    child.send = (message, callback) => {
      const sent = send(message, callback);
      if (sent) queueMicrotask(() => toChild?.(message));
      return sent;
    };
    gateway.channel = channel;
    gateway.handle = superviseGateway(gateway, channel, {
      shutdown: (code) => {
        gateway.shutdowns.push(code);
        queueMicrotask(() => child.exit(code));
      },
      now: () => h.now,
      setInterval: h.deps.setInterval,
      clearInterval: h.deps.clearInterval,
    });
    gateways.push(gateway);
    return child;
  };
  return gateways;
}

test("the gateway's own half: ready, the idle walk, status, a declined restart, and leaving", async () => {
  const h = harness();
  const gateways = supervisedGateways(h);
  const supervisor = new GatewaySupervisor(h.deps, { buildTimeoutMs: 0, quietMs: 0 });
  supervisor.start();
  await flush();
  assert.equal(supervisor.phase, "running", "the child said ready");
  const [first] = gateways;

  // No page open: the idle walk runs on a watch event, or every fifteen seconds without one.
  first.pending = true;
  await h.advance(1_000);
  assert.equal(first.walks, 1);
  await h.advance(10_000);
  assert.equal(first.walks, 1);
  await h.advance(5_000);
  assert.equal(first.walks, 2);

  // The walk latched: main.ts forwards the tracker's change through the same channel.
  first.summary = { ...first.summary, stale: true, lastChangeAt: new Date(h.now).toISOString() };
  first.channel.send(patchChangeMessage({ at: new Date(h.now).toISOString(), first: true, epoch: 1, changes: 1 }));
  await flush();
  // Counted at zero, then a player logs in before the shutdown arrives.
  first.sessions = [{ auth: 0, world: 0 }, { auth: 1, world: 0 }, { auth: 1, world: 0 }];
  await h.advance(1_000);
  await flush();
  assert.deepEqual(h.children[0].sent.slice(-2), [{ type: "status?" }, { type: "shutdown", reason: "restart" }]);
  assert.deepEqual(first.shutdowns, [], "the gateway declined: a session connected after the count");
  assert.equal(supervisor.phase, "running");
  assert.ok(h.logs.some((line) => /a session connected before the restart/.test(line)));

  // The player leaves; the next count is zero at both moments and the restart goes through.
  first.sessions = [{ auth: 0, world: 0 }];
  await h.advance(1_000);
  await flush();
  assert.deepEqual(first.shutdowns, [0]);
  await flush();
  assert.equal(h.children.length, 2, "forked again");
  await flush();
  assert.equal(supervisor.phase, "running");
  assert.ok(h.logs.some((line) => /gateway restarted \(generation gen2\)/.test(line)));

  // A stop is never declined, whoever is connected; and a lost supervisor takes the gateway down.
  const [, second] = gateways;
  second.sessions = [{ auth: 0, world: 3 }];
  supervisor.stop();
  await flush();
  assert.deepEqual(h.children[1].sent.at(-1), { type: "shutdown", reason: "stop" });
  assert.deepEqual(second.shutdowns, [0]);
  assert.deepEqual(h.exits, [0]);

  const orphan = harness();
  const lones = supervisedGateways(orphan);
  new GatewaySupervisor(orphan.deps).start();
  const [lone] = lones;
  lone.disconnect();
  assert.deepEqual(lone.shutdowns, [0], "no supervisor: nothing may keep the port");
  lone.disconnect();
  assert.deepEqual(lone.shutdowns, [0], "once");
});

test("the gateway's status answer carries what the supervisor reads", async () => {
  const h = harness();
  const gateways = supervisedGateways(h);
  new GatewaySupervisor(h.deps).start();
  await flush();
  const [gateway] = gateways;
  gateway.sessions = [{ auth: 2, world: 1 }];
  gateway.summary = { generation: "g", stale: true, lastChangeAt: "2026-09-25T09:00:00.000Z" };
  const answers = [];
  h.children[0].on("message", (message) => { if (message.type === "status") answers.push(message); });
  h.children[0].send({ type: "status?" });
  await flush();
  assert.deepEqual(answers, [{ type: "status", auth: 2, world: 1, stale: true, lastChangeAt: "2026-09-25T09:00:00.000Z" }]);
});

test("the real fork: IPC, GATEWAY_SUPERVISED, the TSWoW marker and a restart, against a stub gateway", async () => {
  // Never the real gateway: a stub process around a fake gateway, speaking through the real child
  // half (SupervisedGateway.ts over process IPC), and logging what it saw.
  const root = await mkdtemp(join(tmpdir(), "webclient-supervisor-"));
  const dataset = join(root, "dataset");
  await mkdir(dataset);
  const log = join(root, "stub.log");
  const stub = join(root, "stub-gateway.mjs");
  const childHalf = pathToFileURL(join(repositoryRoot, "dist", "code", "gateway", "SupervisedGateway.js")).href;
  await writeFile(stub, [
    'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    `import { patchChangeMessage, processSupervisorChannel, superviseGateway } from ${JSON.stringify(childHalf)};`,
    "const log = process.env.STUB_LOG;",
    "let starts = 0;",
    'try { starts = readFileSync(log, "utf8").split("\\n").filter((line) => line.startsWith("start")).length; } catch {}',
    'appendFileSync(log, `start ${process.env.GATEWAY_SUPERVISED} ${typeof process.send}\\n`);',
    "const summary = () => ({ generation: `gen${starts}`, stale: starts === 0, lastChangeAt: null });",
    "const gateway = {",
    "  patchSummary: summary, checkPatchChain: async () => summary(), patchEventsPending: false,",
    "  connections: () => ({ auth: 0, world: 0 }),",
    "};",
    "const channel = processSupervisorChannel();",
    'superviseGateway(gateway, channel, { shutdown: (code) => { appendFileSync(log, "shutdown\\n"); process.exit(code); } });',
    "if (starts === 0) setTimeout(() => {",
    "  channel.send(patchChangeMessage({ at: new Date().toISOString(), first: true, epoch: 1, changes: 1 }));",
    "  // The build ends: TSWoW writes its marker after the patch.",
    '  writeFileSync(join(process.env.TSWOW_DATASET, "last-client-build.json"), JSON.stringify({ finishedAt: new Date(Date.now() + 5).toISOString() }));',
    "}, 100);",
  ].join("\n"));
  const driver = join(root, "driver.mjs");
  await writeFile(driver, [
    `import { runGatewaySupervisor } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "tools", "gateway-supervisor.mjs")).href)};`,
    `await runGatewaySupervisor({ entry: new URL(${JSON.stringify(pathToFileURL(stub).href)}), options: { quietMs: 300, tickMs: 50 } });`,
  ].join("\n"));
  // Run the driver the way this file runs (the same --import hooks), so it loads the same sources.
  const execArgv = process.execArgv.filter((argument) => !argument.startsWith("--test"));
  const supervisor = spawn(process.execPath, [...execArgv, driver], {
    cwd: repositoryRoot,
    env: { ...process.env, WEBCLIENT_SKIP_ENV: "1", TSWOW_DATASET: dataset, STUB_LOG: log },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  supervisor.stdout.setEncoding("utf8").on("data", (data) => { output += data; });
  supervisor.stderr.setEncoding("utf8").on("data", (data) => { output += data; });
  const exited = new Promise((resolve) => supervisor.once("exit", resolve));
  try {
    const started = Date.now();
    let lines = [];
    while (lines.filter((line) => line.startsWith("start")).length < 2) {
      if (Date.now() - started > 20_000) assert.fail(`no restart within 20 s:\n${output}\n${lines.join("\n")}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      try { lines = (await readFile(log, "utf8")).split("\n").filter(Boolean); } catch { lines = []; }
    }
    assert.deepEqual(lines, ["start 1 function", "shutdown", "start 1 function"],
      "forked with IPC and GATEWAY_SUPERVISED=1, asked to shut down, forked again");
    assert.match(output, /the TSWoW build finished and nobody is connected: restarting the gateway/);
    assert.match(output, /gateway restarted \(generation gen1\)/);
  } finally {
    supervisor.kill();
    await exited;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
