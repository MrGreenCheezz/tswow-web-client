/**
 * 10.29 (26.10): the first entry's trace — the measurement the preload list starts from (WORK_PLAN 10.29). Opt-in:
 * the page opened with `?first-entry-trace` records, from its first script to the world, every HTTP resource it
 * fetched (size on the wire, size decoded, when it started and ended) and every byte its WebSockets received,
 * against the moments that matter: the login screen, the character list, the loading screen, the world.
 *
 * `webclientFirstEntry()` in the console answers the summary; `webclientFirstEntry(true)` also saves the whole
 * trace as `first-entry-<time>.json`. Nothing here runs without the flag, and nothing leaves the page.
 * A resource served from the browser's cache shows a transfer of 0 (a warm entry); measure from a fresh profile.
 */

interface TraceResource {
  readonly url: string;
  readonly type: string;
  readonly transfer: number;
  readonly encoded: number;
  readonly decoded: number;
  readonly start: number;
  readonly end: number;
}

interface TraceMark {
  readonly name: string;
  readonly at: number;
}

interface Trace {
  readonly resources: TraceResource[];
  readonly marks: TraceMark[];
  socketBytes: number;
  socketMessages: number;
}

let trace: Trace | undefined;

/** Whether this page records its first entry. */
export function firstEntryTracing(): boolean {
  return trace !== undefined;
}

/** A moment of the entry (no-op without the flag); the first of each name is kept. */
export function firstEntryMark(name: string): void {
  if (trace === undefined || trace.marks.some((mark) => mark.name === name)) return;
  // The loading screen is also hidden before it is ever shown (a clean start): the world is the hide after it.
  if (name === "world" && !trace.marks.some((mark) => mark.name === "loading")) return;
  trace.marks.push({ name, at: Math.round(performance.now()) });
}

function keep(entry: PerformanceEntry): void {
  const resource = entry as PerformanceResourceTiming;
  trace!.resources.push({
    url: resource.name,
    type: resource.initiatorType,
    transfer: resource.transferSize,
    encoded: resource.encodedBodySize,
    decoded: resource.decodedBodySize,
    start: Math.round(resource.startTime),
    end: Math.round(resource.responseEnd),
  });
}

function byteLength(data: unknown): number {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return 0;
}

const MB = 1024 * 1024;

/** The trace summed up to each mark: what had come over the wire by then, and from where. */
export function firstEntrySummary(): unknown {
  if (trace === undefined) return "запись выключена: откройте страницу с ?first-entry-trace";
  const marks = [...trace.marks].sort((a, b) => a.at - b.at);
  const upTo = (at: number) => trace!.resources.filter((resource) => resource.end <= at);
  const megabytes = (bytes: number) => Math.round((bytes / MB) * 100) / 100;
  const byKind = new Map<string, { count: number; transfer: number; decoded: number }>();
  for (const resource of trace.resources) {
    let path = resource.url;
    try { path = new URL(resource.url).pathname; } catch { /* keep the raw name */ }
    const kind = path.split("/").filter(Boolean)[0] ?? "/";
    const row = byKind.get(kind) ?? { count: 0, transfer: 0, decoded: 0 };
    row.count++;
    row.transfer += resource.transfer;
    row.decoded += resource.decoded;
    byKind.set(kind, row);
  }
  return {
    marks: marks.map((mark) => {
      const done = upTo(mark.at);
      return {
        mark: mark.name, seconds: Math.round(mark.at / 100) / 10, requests: done.length,
        transferMB: megabytes(done.reduce((sum, resource) => sum + resource.transfer, 0)),
      };
    }),
    total: {
      requests: trace.resources.length,
      transferMB: megabytes(trace.resources.reduce((sum, resource) => sum + resource.transfer, 0)),
      decodedMB: megabytes(trace.resources.reduce((sum, resource) => sum + resource.decoded, 0)),
      socketMB: megabytes(trace.socketBytes), socketMessages: trace.socketMessages,
    },
    byPath: [...byKind].sort((a, b) => b[1].transfer - a[1].transfer).slice(0, 25)
      .map(([path, row]) => ({ path, count: row.count, transferMB: megabytes(row.transfer), decodedMB: megabytes(row.decoded) })),
  };
}

function save(): void {
  const blob = new Blob([JSON.stringify({ summary: firstEntrySummary(), ...trace }, null, 1)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `first-entry-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

/** Starts the recording when the page's address asks for it. Call first thing (main.ts). */
export function installFirstEntryTrace(win: Window & typeof globalThis = window): void {
  if (!new URLSearchParams(win.location.search).has("first-entry-trace")) return;
  trace = { resources: [], marks: [], socketBytes: 0, socketMessages: 0 };
  firstEntryMark("page");
  // The default buffer keeps 250 entries; the observer below sees every one anyway, the buffer is for
  // the entries that came before it (the page's own scripts).
  performance.setResourceTimingBufferSize?.(100_000);
  for (const entry of performance.getEntriesByType("resource")) keep(entry);
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) keep(entry); })
    .observe({ type: "resource" });
  const Native = win.WebSocket;
  const Counted = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
    const socket = new Native(url, protocols);
    socket.addEventListener("message", (event: MessageEvent) => {
      trace!.socketBytes += byteLength(event.data);
      trace!.socketMessages++;
    });
    return socket;
  } as unknown as typeof WebSocket;
  Object.assign(Counted, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  Counted.prototype = Native.prototype;
  win.WebSocket = Counted;
  (win as Window & { webclientFirstEntry?: (download?: boolean) => unknown }).webclientFirstEntry = (download = false) => {
    if (download) save();
    return firstEntrySummary();
  };
}
