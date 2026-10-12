// The gateway's half of the opt-in supervisor protocol (tools/gateway-supervisor.mjs).
//
// `tools/start-gateway.mjs` forks `main.js` with an IPC channel when GATEWAY_RESTART_ON_PATCH=1 and
// restarts it after a settled TSWoW build. Everything the child says and does on that channel lives
// here rather than in `main.ts`, which starts a real gateway the moment it is imported: a test drives
// this file with the real `GatewaySupervisor` and a fake gateway, so the two halves of the protocol
// cannot drift apart without one failing.
//
//   child → { type: "ready", generation, pid } · { type: "patch-chain-changed", at, first, epoch, changes }
//         · { type: "status", auth, world, stale, lastChangeAt, declined? }
//   parent → { type: "status?" } · { type: "shutdown", reason: "restart" | "stop", force? }
//          · { type: "restart-at", at: number | null }

import type { ClientPatchChange, PatchStatusSummary } from "./PatchStatus.js";

export type SupervisorMessage = Readonly<Record<string, unknown>>;

/**
 * 10.15 (C): the close code of every bridged socket a forced restart drops — the restart after a
 * TSWoW build that connected players held back past GATEWAY_RESTART_DEADLINE_MIN. The page reads the
 * code, not the reason (`describeFailure` in src/browser/glue/GlueMessages.ts), and says that the
 * server is restarting after an update rather than that the connection was lost.
 */
export const GATEWAY_RESTART_CLOSE = 4001;
/** The close frame's reason beside it, for logs; well inside the frame's 123 bytes. */
export const GATEWAY_RESTART_CLOSE_REASON = "Gateway restarting after an update";

/** What of a running gateway the protocol needs; `RunningGateway` has all of it. */
export interface SupervisedGateway {
  patchSummary(): PatchStatusSummary;
  checkPatchChain(): Promise<PatchStatusSummary>;
  readonly patchEventsPending: boolean;
  connections(): { auth: number; world: number };
  /**
   * 10.15 (C): when the supervisor will restart this process although players are connected (epoch
   * ms), or `undefined` once that is withdrawn; `/client/patch-status` reports it as `restartAt`.
   * Optional so that a stub gateway without it still speaks the protocol.
   */
  scheduleRestart?(at: number | undefined): void;
  /**
   * 10.15 (C): closes every bridged socket with `code` before a forced restart and resolves once
   * they have closed, or after a bound; absent, `shutdown` terminates them as it always did.
   */
  closeSessions?(code: number, reason: string): Promise<void>;
}

export interface SupervisorChannel {
  send(message: SupervisorMessage): void;
  onMessage(listener: (message: unknown) => void): void;
  onDisconnect(listener: () => void): void;
}

export interface SuperviseGatewayOptions {
  /** Closes the gateway and leaves the process (`main.ts`'s `shutdown`). */
  readonly shutdown: (code: number) => void;
  /** For tests. */
  readonly now?: () => number;
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  /** The fallback walk for a volume whose archive watch drops events. */
  readonly idleWalkMs?: number;
}

/** What `onClientPatchChange` forwards to the supervisor. */
export function patchChangeMessage(change: ClientPatchChange): SupervisorMessage {
  return { type: "patch-chain-changed", ...change };
}

/**
 * This process's IPC channel to the supervisor. A send racing the supervisor's own exit fails
 * asynchronously; without a callback that failure is an 'error' event on `process`, which nothing
 * listens to and which would take the gateway down with it.
 */
export function processSupervisorChannel(): SupervisorChannel {
  return {
    send: (message) => { process.send?.(message, undefined, undefined, () => undefined); },
    onMessage: (listener) => { process.on("message", listener); },
    onDisconnect: (listener) => { process.once("disconnect", listener); },
  };
}

const IDLE_WALK_MS = 15_000;

/** Says `ready`, answers the supervisor, and keeps an idle gateway's latch current. */
export function superviseGateway(
  gateway: SupervisedGateway,
  channel: SupervisorChannel,
  options: SuperviseGatewayOptions,
): { readonly stop: () => void } {
  const now = options.now ?? Date.now;
  const every = options.setInterval ?? ((callback: () => void, ms: number): unknown => setInterval(callback, ms));
  const cancel = options.clearInterval ?? ((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>));
  const idleWalkMs = options.idleWalkMs ?? IDLE_WALK_MS;
  let stopped = false;
  const status = (extra: Record<string, unknown> = {}): void => {
    const summary = gateway.patchSummary();
    channel.send({ type: "status", ...gateway.connections(), stale: summary.stale, lastChangeAt: summary.lastChangeAt, ...extra });
  };
  // With no page open nothing asks the gateway anything, so nothing would ever poll the
  // fingerprint and the supervisor would wait on a latch that cannot close. The archive watch
  // makes the per-second check one comparison; a full walk (62-80 ms measured over F:\Circle's
  // 1,269 patch files) runs only when it reports a write, plus once every fifteen seconds for a
  // volume whose watch drops events — about 0.5% of one core while idle, and only when supervised.
  let lastWalk = now();
  let walking = false;
  const idle = every(() => {
    if (walking || (!gateway.patchEventsPending && now() - lastWalk < idleWalkMs)) return;
    walking = true;
    lastWalk = now();
    void gateway.checkPatchChain().catch(() => undefined).finally(() => { walking = false; });
  }, 1_000);
  (idle as { unref?: () => void } | undefined)?.unref?.();
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    cancel(idle);
  };
  const leave = (forcedRestart = false): void => {
    if (stopped) return;
    stop();
    const closeSessions = forcedRestart ? gateway.closeSessions?.bind(gateway) : undefined;
    if (!closeSessions) {
      options.shutdown(0);
      return;
    }
    // 10.15 (C): the players this restart drops are told why — a close frame with 4001 — before
    // `shutdown` terminates whatever has not closed by then. Bounded by `closeSessions` itself.
    void closeSessions(GATEWAY_RESTART_CLOSE, GATEWAY_RESTART_CLOSE_REASON)
      .catch(() => undefined)
      .finally(() => options.shutdown(0));
  };
  channel.onMessage((message) => {
    if (stopped || typeof message !== "object" || message === null) return;
    const { type, reason, force, at } = message as { type?: unknown; reason?: unknown; force?: unknown; at?: unknown };
    if (type === "status?") {
      status();
    } else if (type === "restart-at") {
      // 10.15 (C): the page counts the forced restart down from the summary; null withdraws it.
      gateway.scheduleRestart?.(typeof at === "number" && Number.isFinite(at) ? at : undefined);
    } else if (type === "shutdown") {
      // The supervisor counted the sessions a moment ago; one may have connected since, and
      // `close()` terminates every bridged socket. A restart is declined rather than drop a player
      // in the middle of the world; the supervisor waits for them again. A stop always leaves, and
      // so does a restart past the owner's deadline (`force`, 10.15 B, GATEWAY_RESTART_DEADLINE_MIN),
      // which closes the sessions with GATEWAY_RESTART_CLOSE first.
      if (reason === "restart" && force !== true) {
        const sessions = gateway.connections();
        if (sessions.auth + sessions.world > 0) {
          status({ declined: true });
          return;
        }
      }
      leave(reason === "restart" && force === true);
    }
  });
  // A supervisor that died must not leave an orphan holding the port.
  channel.onDisconnect(leave);
  channel.send({ type: "ready", generation: gateway.patchSummary().generation, pid: process.pid });
  return { stop };
}
