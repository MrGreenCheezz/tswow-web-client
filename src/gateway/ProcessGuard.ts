/**
 * The gateway's last line against an exception nothing else caught, and its one way out (1.03).
 *
 * Without it one error that escaped a listener ended the process, and with it every player's session
 * and — under `online/start-server.bat` — the page they play from. Two kinds of escape are told apart:
 *
 * - **Socket noise** ({@link SOCKET_NOISE_CODES}): the network being the network. One journal line,
 *   and the process goes on — unless more of it arrives than `burst` allows, which is a loop and not
 *   a network, and is then treated like the second kind.
 * - **Anything else** is a defect: the whole stack goes to the journal and `shutdown(1)` runs, once —
 *   an orderly close and a non-zero exit that the supervisor (`tools/gateway-supervisor.mjs`) sees.
 *   A failed `accept` is always this kind, whatever its code ({@link stopsAccepting}).
 *
 * `ERR_INVALID_URL` and its kind are not noise: they are fixed where they are thrown (UpgradeGuard.ts),
 * never silenced here. `main.ts` installs this only after `startGateway` has resolved, because a
 * gateway that cannot start (no client, the port taken) must go on failing the ordinary way.
 */

/**
 * Error codes a socket produces on its own: a peer that reset, went away or stopped answering.
 *
 * Only what the network causes. `ERR_HTTP_HEADERS_SENT`, say, is not here: it is thrown synchronously
 * by `writeHead`/`setHeader` on a response that was already answered, which is this program's
 * mistake, whatever the peer did.
 */
export const SOCKET_NOISE_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_SOCKET_CLOSED",
]);

/**
 * Whether an error is a listening server's failed `accept`.
 *
 * On Windows that is the last connection the server ever takes: when libuv cannot queue the next
 * accept — creating its socket, or AcceptEx itself, fails — it clears the handle's listening flag and
 * reports the error once (`uv__process_tcp_accept_req`), and Node does not listen again. The code can
 * be anything, ECONNRESET included (AcceptEx reports a peer that reset before it was accepted that
 * way), so this is decided by the syscall and never by the code.
 */
export function stopsAccepting(error: unknown): boolean {
  return property(error, "syscall") === "accept";
}

export function isSocketNoise(error: unknown): boolean {
  const code = property(error, "code");
  return typeof code === "string" && SOCKET_NOISE_CODES.has(code) && !stopsAccepting(error);
}

/**
 * The `error` listener of an HTTP server that is already listening (`startGateway`, after `listen`).
 *
 * After `listen` the error a server emits is a failed accept, and it is thrown on — exactly as it was
 * before there was a listener, only with a line that says what it means: a gateway that answers its
 * existing sessions but never accepts another player, nor `/health`, looks alive to the supervisor
 * and is worse than one that stops. The process guard turns the throw into an orderly `shutdown(1)`;
 * without one, Node ends the process. The same on every platform (elsewhere libuv does go on
 * listening), because one conservative rule beats a branch that no test on this machine takes.
 * Anything else is only logged, and the server goes on.
 */
export function listeningServerError(error: unknown, log: (message: string) => void = journalLine): void {
  if (stopsAccepting(error)) {
    const code = property(error, "code");
    log(`Gateway: the HTTP server stopped accepting connections (accept ${typeof code === "string" ? code : "failed"}); `
      + "on Windows it never accepts again, so the gateway is shutting down.");
    throw error;
  }
  log(`Gateway: HTTP server error: ${details(error)}`);
}

type GuardedEvent = "uncaughtException" | "unhandledRejection";

/** What the guard listens on: `process`, or an EventEmitter in a test. */
export interface ProcessGuardTarget {
  on(event: GuardedEvent, listener: (error: unknown) => void): unknown;
  off(event: GuardedEvent, listener: (error: unknown) => void): unknown;
}

export interface ProcessGuardOptions {
  target?: ProcessGuardTarget;
  /** One call per journal entry; `console.error` by default. */
  log?: (message: string) => void;
  /** Closes what can be closed and exits with `code`. Called at most once. */
  shutdown: (code: number) => void;
  /** A monotonic clock in milliseconds; `performance.now` by default. */
  now?: () => number;
  /** More socket errors than `count` inside `windowMs` are not noise. */
  burst?: { count: number; windowMs: number };
}

/** Installs the two listeners; the function returned takes them off again. */
export function installProcessGuard(options: ProcessGuardOptions): () => void {
  const target = options.target ?? process;
  const log = options.log ?? journalLine;
  const now = options.now ?? (() => performance.now());
  const { count, windowMs } = options.burst ?? { count: 20, windowMs: 10_000 };
  const recentNoise: number[] = [];
  let shuttingDown = false;

  // Nothing in here may throw: a throw out of an `uncaughtException` listener ends the process on the
  // spot (exit code 7), without the orderly close this exists for.
  const journal = (message: string): void => {
    try {
      log(message);
    } catch {
      // The journal itself is gone; the decision still stands.
    }
  };

  const fail = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    journal("Gateway: shutting down with exit code 1.");
    try {
      options.shutdown(1);
    } catch (failure) {
      journal(`Gateway: shutdown failed: ${details(failure)}`);
    }
  };

  const classify = (event: GuardedEvent, error: unknown): void => {
    if (isSocketNoise(error)) {
      const at = now();
      while (recentNoise.length > 0 && at - (recentNoise[0] ?? at) >= windowMs) recentNoise.shift();
      recentNoise.push(at);
      if (recentNoise.length <= count) {
        journal(`Gateway: ${event} ignored as socket noise: ${summary(error)}`);
        return;
      }
      journal(`Gateway: more than ${count} socket errors within ${windowMs} ms is not noise (${event}): ${details(error)}`);
    } else {
      journal(`Gateway: ${event}: ${details(error)}`);
    }
    fail();
  };

  const handle = (event: GuardedEvent, error: unknown): void => {
    try {
      classify(event, error);
    } catch {
      // Only a failure of the guard's own bookkeeping gets here; what it could not classify is a
      // defect all the same.
      journal(`Gateway: ${event} that the process guard could not classify.`);
      fail();
    }
  };

  const onException = (error: unknown): void => handle("uncaughtException", error);
  const onRejection = (reason: unknown): void => handle("unhandledRejection", reason);
  target.on("uncaughtException", onException);
  target.on("unhandledRejection", onRejection);
  return () => {
    target.off("uncaughtException", onException);
    target.off("unhandledRejection", onRejection);
  };
}

export interface ShutdownOptions {
  /** Closes what the process holds. Runs once, however many callers ask to leave. */
  close: () => Promise<void>;
  exit?: (code: number) => void;
  log?: (message: string) => void;
  /** Starts the cap's timer; by default an unref'd `setTimeout`. */
  setTimer?: (callback: () => void, ms: number) => void;
}

/**
 * The process's one way out: `shutdown(code, capMs?)`.
 *
 * `close` runs once, and the process exits with the highest code anyone asked for: a defect's 1 is
 * not turned back into 0 by the Ctrl+C or supervisor stop that was already closing when it happened.
 * A close that fails still exits, with at least 1. `capMs` bounds how long that caller waits — the
 * process guard's call, since a close that hangs must not keep a broken process alive — and the
 * journal says when the cap was what ended it. A call without a cap waits as long as the close takes,
 * as a Ctrl+C always has.
 */
export function createShutdown(options: ShutdownOptions): (code: number, capMs?: number) => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? journalLine;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => { setTimeout(callback, ms).unref(); });
  let exitCode = 0;
  let closing = false;
  let exited = false;
  const leave = (): void => {
    if (exited) return;
    exited = true;
    exit(exitCode);
  };
  return (code, capMs) => {
    exitCode = Math.max(exitCode, code);
    if (capMs !== undefined) {
      setTimer(() => {
        if (exited) return;
        log(`Gateway: the shutdown did not finish within ${capMs} ms; exiting with code ${exitCode}.`);
        leave();
      }, capMs);
    }
    if (closing) return;
    closing = true;
    let closed: Promise<void>;
    try {
      closed = options.close();
    } catch (error) {
      closed = Promise.reject(error);
    }
    closed.then(leave, (error: unknown) => {
      exitCode = Math.max(exitCode, 1);
      log(`Gateway: closing failed: ${details(error)}`);
      leave();
    });
  };
}

function journalLine(message: string): void {
  console.error(message);
}

/** A property of a thrown value; undefined when there is none, or when reading it throws. */
function property(value: unknown, name: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  try {
    return (value as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

/** One line: the code and the message. */
function summary(error: unknown): string {
  const code = property(error, "code");
  const message = property(error, "message");
  return `${typeof code === "string" ? code : ""} ${typeof message === "string" ? message : ""}`.replace(/\s+/g, " ").trim();
}

/** The whole stack when there is one, and something readable when the thrown value is not an Error. */
function details(error: unknown): string {
  const stack = property(error, "stack");
  if (typeof stack === "string") return stack;
  try {
    return String(error);
  } catch {
    return "(a thrown value that cannot be read)";
  }
}
