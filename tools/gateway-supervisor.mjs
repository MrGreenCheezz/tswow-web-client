// The opt-in supervisor `npm run gateway` becomes with GATEWAY_RESTART_ON_PATCH=1.
//
// A TSWoW `build addon` / `build data` rewrites the client patches under a running gateway, which
// then latches its client-media routes into 409 `client_patch_chain_changed` until it is restarted
// (Gateway.ts). Restarting it by hand after every build is the whole chore; this does it — but only
// when doing so cannot hurt anybody:
//   * the build has settled: no fingerprint change for `quietMs` AND TSWoW's
//     `last-client-build.json` says a build finished after the latch — or, for edits that write no
//     marker (a module's linked asset folder, a console not rebuilt yet), `buildTimeoutMs` passed;
//   * nobody is bridged: the gateway also carries the /auth and /world sockets, and a restart would
//     drop a player in the middle of the world.
// It restarts the already-built `dist/code/gateway/main.js`; it never rebuilds, and it never
// starts or stops the auth/world servers — the only process it owns is the gateway it forked.
//
// Protocol with the child (src/gateway/SupervisedGateway.ts, wired by main.ts), over the fork IPC
// channel:
//   child → { type: "ready", generation } · { type: "patch-chain-changed", at, first, epoch }
//         · { type: "status", auth, world, stale, declined? }
//   parent → { type: "status?" } · { type: "shutdown", reason: "restart" | "stop" }
// A child that counts a session when a restart's `shutdown` arrives stays up and answers a
// `status` with `declined: true` instead: the players were counted a moment earlier, and one may
// have connected since. A `stop` (Ctrl+C) is never declined.

import { fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SUPERVISOR_DEFAULTS = Object.freeze({
  /** No fingerprint change for this long: the build has stopped writing. */
  quietMs: 5_000,
  /** Without a newer build marker, restart this long after the latch anyway. */
  buildTimeoutMs: 120_000,
  /**
   * The child notices a write within a second through the archive watch, but a volume whose watch
   * drops events is caught by its fifteen-second fallback walk; a marker finished that much before
   * the latch still belongs to the build that caused it.
   */
  noticeSlackMs: 20_000,
  tickMs: 1_000,
  /** A `status?` with no answer for this long is asked again: an unanswered one must not wait forever. */
  statusTimeoutMs: 5_000,
  /** A child that does not leave after `shutdown` is killed. */
  shutdownTimeoutMs: 15_000,
  /** Waits before retrying a restarted child that died before it was ready (a build still writing). */
  retryDelaysMs: Object.freeze([2_000, 5_000, 15_000, 60_000]),
});

/**
 * Whether to restart now, and if not, what is being waited for. Pure, so every branch is a test.
 *
 * `clients` is undefined until the child has answered a `status?`; the answer is asked for only
 * once the build has settled, which is the only moment it matters.
 */
export function restartDecision({
  now, latchAt, lastChangeAt, markerFinishedAt, childStartedAt, clients,
  quietMs = SUPERVISOR_DEFAULTS.quietMs,
  buildTimeoutMs = SUPERVISOR_DEFAULTS.buildTimeoutMs,
  noticeSlackMs = SUPERVISOR_DEFAULTS.noticeSlackMs,
}) {
  if (latchAt === undefined) return { action: "wait", reason: "current" };
  if (now - (lastChangeAt ?? latchAt) < quietMs) return { action: "wait", reason: "writing" };
  const built = markerFinishedAt !== undefined && Number.isFinite(markerFinishedAt)
    && markerFinishedAt > (childStartedAt ?? Number.NEGATIVE_INFINITY)
    && markerFinishedAt >= latchAt - noticeSlackMs;
  if (!built && now - latchAt < buildTimeoutMs) return { action: "wait", reason: "build" };
  if (clients === undefined) return { action: "ask" };
  if (clients.auth + clients.world > 0) return { action: "wait", reason: "players" };
  return { action: "restart", reason: built ? "build-finished" : "timeout" };
}

/**
 * The supervisor's lifecycle around one forked gateway at a time.
 *
 * Everything with a side effect is injected — `fork`, the marker read, the clock, the timers,
 * `exit` — so tests drive it with a fake child and a manual clock and never touch a real gateway.
 */
export class GatewaySupervisor {
  #deps;
  #options;
  #child;
  /** starting · running · restarting · stopping · exited */
  #phase = "idle";
  #restarts = 0;
  #failedStarts = 0;
  #childStartedAt;
  #latchAt;
  #lastChangeAt;
  #clients;
  #asked = false;
  #askedAt = 0;
  #reasked = false;
  #waitingFor;
  #tick;
  #killTimer;
  #retryTimer;
  #reading = false;

  constructor(deps, options = {}) {
    this.#deps = deps;
    this.#options = { ...SUPERVISOR_DEFAULTS, ...options };
  }

  get phase() { return this.#phase; }
  get restarts() { return this.#restarts; }

  start() {
    this.#spawn();
    this.#tick = this.#deps.setInterval(() => { void this.#onTick(); }, this.#options.tickMs);
  }

  /** SIGINT/SIGTERM: ask the child to close, wait for it, and leave with it. */
  stop() {
    if (this.#phase === "stopping" || this.#phase === "exited") return;
    const previous = this.#phase;
    this.#phase = "stopping";
    this.#deps.clearTimeout(this.#retryTimer);
    if (!this.#child || previous === "waiting-retry") {
      this.#finish(0);
      return;
    }
    this.#shutdownChild("stop");
  }

  #spawn() {
    this.#phase = "starting";
    this.#latchAt = undefined;
    this.#lastChangeAt = undefined;
    this.#clients = undefined;
    this.#asked = false;
    this.#reasked = false;
    this.#waitingFor = undefined;
    const child = this.#deps.fork();
    this.#child = child;
    child.on("message", (message) => this.#onMessage(child, message));
    // A send racing the child's own exit (Ctrl+C reaches both processes) fails asynchronously as an
    // 'error' event, and an unhandled one would take the supervisor down with it.
    child.on("error", (error) => { if (child === this.#child) this.#deps.log(`gateway IPC: ${error.message}`); });
    child.once("exit", (code, signal) => this.#onExit(child, code, signal));
  }

  #onMessage(child, message) {
    if (child !== this.#child || typeof message !== "object" || message === null) return;
    const now = this.#deps.now();
    if (message.type === "ready") {
      if (this.#phase !== "starting") return;
      this.#phase = "running";
      this.#childStartedAt = now;
      this.#failedStarts = 0;
      if (this.#restarts > 0) this.#deps.log(`gateway restarted (generation ${String(message.generation ?? "?").slice(0, 12)})`);
    } else if (message.type === "patch-chain-changed") {
      if (this.#latchAt === undefined) {
        this.#latchAt = now;
        this.#deps.log("client patches changed; the gateway restarts once the build settles and nobody is in the world");
      }
      this.#lastChangeAt = now;
      // A change after the players were counted is a new build: count again when it settles.
      this.#clients = undefined;
      this.#asked = false;
    } else if (message.type === "status") {
      this.#clients = { auth: Number(message.auth) || 0, world: Number(message.world) || 0 };
      this.#asked = false;
      this.#reasked = false;
      if (this.#phase === "restarting") {
        // Only a declined restart answers now: a session connected between the count and the
        // shutdown. Stay on this child and wait for the sessions again.
        const count = this.#clients.auth + this.#clients.world;
        if (count === 0) return;
        this.#deps.clearTimeout(this.#killTimer);
        this.#phase = "running";
        this.#waitingFor = "players";
        this.#deps.log(`a session connected before the restart: waiting for ${count} connected session(s) to leave`);
        return;
      }
      void this.#evaluate();
    }
  }

  async #readMarker() {
    try {
      const finishedAt = await this.#deps.readMarker();
      const parsed = finishedAt === undefined ? Number.NaN : Date.parse(finishedAt);
      return Number.isFinite(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async #onTick() {
    if (this.#phase !== "running" || this.#latchAt === undefined || this.#reading) return;
    // Counted players go stale: ask again on every tick while that is what is being waited for.
    if (this.#waitingFor === "players") this.#clients = undefined;
    await this.#evaluate();
  }

  async #evaluate() {
    if (this.#phase !== "running" || this.#latchAt === undefined || this.#reading) return;
    this.#reading = true;
    let markerFinishedAt;
    try { markerFinishedAt = await this.#readMarker(); } finally { this.#reading = false; }
    if (this.#phase !== "running") return;
    const decision = restartDecision({
      now: this.#deps.now(),
      latchAt: this.#latchAt,
      lastChangeAt: this.#lastChangeAt,
      markerFinishedAt,
      childStartedAt: this.#childStartedAt,
      clients: this.#clients,
      quietMs: this.#options.quietMs,
      buildTimeoutMs: this.#options.buildTimeoutMs,
      noticeSlackMs: this.#options.noticeSlackMs,
    });
    if (decision.action === "ask") {
      const now = this.#deps.now();
      if (this.#asked && now - this.#askedAt < this.#options.statusTimeoutMs) return;
      if (this.#asked && !this.#reasked) {
        this.#reasked = true;
        this.#deps.log(`the gateway did not answer status? in ${Math.round(this.#options.statusTimeoutMs / 1000)} s; asking again`);
      }
      this.#asked = true;
      this.#askedAt = now;
      this.#send(this.#child, { type: "status?" });
      return;
    }
    if (decision.action === "wait") {
      if (decision.reason !== this.#waitingFor) {
        this.#waitingFor = decision.reason;
        if (decision.reason === "players") {
          const count = this.#clients.auth + this.#clients.world;
          this.#deps.log(`waiting for ${count} connected session(s) to leave before restarting`);
        }
      }
      return;
    }
    this.#deps.log(decision.reason === "build-finished"
      ? "the TSWoW build finished and nobody is connected: restarting the gateway"
      : `no build marker after ${Math.round(this.#options.buildTimeoutMs / 1000)} s and nobody is connected: restarting the gateway`);
    this.#phase = "restarting";
    this.#shutdownChild("restart");
  }

  #shutdownChild(reason) {
    const child = this.#child;
    if (!this.#send(child, { type: "shutdown", reason })) child.kill();
    this.#deps.clearTimeout(this.#killTimer);
    this.#killTimer = this.#deps.setTimeout(() => {
      if (this.#child === child) child.kill();
    }, this.#options.shutdownTimeoutMs);
  }

  /** False when the channel is already gone; a late failure is swallowed by the callback. */
  #send(child, message) {
    try {
      child.send(message, () => undefined);
      return true;
    } catch {
      return false;
    }
  }

  #onExit(child, code, signal) {
    if (child !== this.#child) return;
    this.#deps.clearTimeout(this.#killTimer);
    this.#child = undefined;
    const phase = this.#phase;
    if (phase === "stopping") {
      this.#finish(0);
      return;
    }
    if (phase === "restarting") {
      this.#restarts++;
      this.#spawn();
      return;
    }
    if (phase === "starting" && this.#restarts > 0) {
      // A restarted child that dies before it is ready is most often a build that was still
      // writing (startup refuses a chain that moves under it). Retry, with growing pauses.
      const delays = this.#options.retryDelaysMs;
      const delay = delays[Math.min(this.#failedStarts, delays.length - 1)];
      this.#failedStarts++;
      this.#deps.log(`the restarted gateway exited before it was ready (${signal ?? `code ${code}`}); retrying in ${Math.round(delay / 1000)} s`);
      this.#phase = "waiting-retry";
      this.#retryTimer = this.#deps.setTimeout(() => {
        if (this.#phase === "waiting-retry") {
          this.#restarts++;
          this.#spawn();
        }
      }, delay);
      return;
    }
    // The first start failing, or a running gateway crashing, ends the supervisor the way it would
    // end an unsupervised `npm run gateway`: restarting a crash in a loop would hide it.
    this.#finish(code ?? 1);
  }

  #finish(code) {
    this.#phase = "exited";
    this.#deps.clearInterval(this.#tick);
    this.#deps.clearTimeout(this.#retryTimer);
    this.#deps.exit(code);
  }
}

/** The real thing: fork the built gateway, read the TSWoW marker, forward Ctrl+C. `options` is for tests. */
export async function runGatewaySupervisor({ entry, options = {} }) {
  const { datasetDirectory } = await import("./paths.mjs");
  let marker;
  try { marker = join(datasetDirectory(), "last-client-build.json"); } catch { marker = undefined; }
  const supervisor = new GatewaySupervisor({
    fork: () => fork(fileURLToPath(entry), [], {
      execArgv: process.execArgv,
      env: { ...process.env, GATEWAY_SUPERVISED: "1" },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    }),
    readMarker: async () => {
      if (!marker) return undefined;
      const value = JSON.parse(await readFile(marker, "utf8"));
      return typeof value?.finishedAt === "string" ? value.finishedAt : undefined;
    },
    now: Date.now,
    setInterval, clearInterval, setTimeout, clearTimeout,
    log: (message) => console.log(`[gateway supervisor] ${message}`),
    exit: (code) => process.exit(code),
  }, options);
  console.log("[gateway supervisor] GATEWAY_RESTART_ON_PATCH=1: the gateway restarts itself after a settled TSWoW build");
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => supervisor.stop());
  supervisor.start();
}
