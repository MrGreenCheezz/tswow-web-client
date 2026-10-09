/**
 * ARC-4: the Lua VM of the interface — PUC Lua 5.1.5 compiled to WebAssembly (`lua51.wasm`, built by
 * `tools/lua-wasm/build.mjs`; manifest `tools/lua-wasm/BUILD.json`).
 *
 * One module instance per JS realm serves every Lua state (each is its own `lua_State` in the same
 * linear memory). It is instantiated once, at import, with a top-level `await`, so the API above it
 * (`LuaApi.ts`) stays synchronous like fengari's. In a browser the file is fetched next to this
 * module (Vite emits it as an asset; the bench serves it beside the harness); under Node (tests,
 * tools) it is read from disk through `process.getBuiltinModule`, which no bundler follows.
 *
 * The WASI imports are local stubs — no `node:wasi`, nothing a page lacks: the clock works, `fd_write`
 * goes to the console, everything else answers EBADF/ENOSYS/ENOTCAPABLE.
 */

export interface LuaWasmExports {
  readonly memory: WebAssembly.Memory;
  _initialize(): void;
  [name: string]: unknown;
}

/** What loading cost: for telemetry and the load measurement. */
export const luaWasmLoad = { url: "", bytes: 0, compileMs: 0, instantiateMs: 0 };

const EBADF = 8;
const ENOSYS = 52;
const ENOTCAPABLE = 76;

let memory: WebAssembly.Memory | undefined;
let buffer: ArrayBuffer | undefined;
let bytes = new Uint8Array(0);
let data = new DataView(new ArrayBuffer(0));

/** The linear memory as bytes; re-opened when `memory.grow` detached the previous buffer. */
export function luaHeap(): Uint8Array {
  if (memory!.buffer !== buffer) {
    buffer = memory!.buffer as ArrayBuffer;
    bytes = new Uint8Array(buffer);
    data = new DataView(buffer);
  }
  return bytes;
}

/** The linear memory as a DataView (same freshness rule as {@link luaHeap}). */
export function luaView(): DataView {
  luaHeap();
  return data;
}

/** The host-call dispatcher `LuaApi.ts` installs: (state pointer, function index) → result count, or −1. */
let hostCall: (state: number, index: number) => number = () => {
  throw new Error("lua51.wasm: no host-call dispatcher installed");
};
export function setLuaHostCall(dispatch: (state: number, index: number) => number): void {
  hostCall = dispatch;
}

const consoleDecoder = new TextDecoder();
const wasi = {
  environ_get: () => 0,
  environ_sizes_get: (countPtr: number, sizePtr: number) => {
    luaView().setUint32(countPtr, 0, true);
    data.setUint32(sizePtr, 0, true);
    return 0;
  },
  clock_time_get: (id: number, _precision: bigint, timePtr: number) => {
    // 0 realtime; 1 monotonic; 2/3 process/thread CPU time (os.clock) — performance.now(), as fengari's os.clock.
    const nanoseconds = id === 0 ? BigInt(Date.now()) * 1_000_000n : BigInt(Math.round(performance.now() * 1e6));
    luaView().setBigUint64(timePtr, nanoseconds, true);
    return 0;
  },
  fd_close: () => EBADF,
  fd_fdstat_get: (fd: number, ptr: number) => {
    if (fd > 2) return EBADF;
    const view = luaView();
    for (let at = 0; at < 24; at++) view.setUint8(ptr + at, 0);
    view.setUint8(ptr, 2); // character device
    view.setBigUint64(ptr + 8, 0xffffffffn, true);
    view.setBigUint64(ptr + 16, 0xffffffffn, true);
    return 0;
  },
  fd_fdstat_set_flags: () => ENOSYS,
  fd_prestat_get: () => EBADF,
  fd_prestat_dir_name: () => EBADF,
  fd_read: () => EBADF,
  fd_renumber: () => EBADF,
  fd_seek: () => EBADF,
  fd_write: (fd: number, iovs: number, count: number, writtenPtr: number) => {
    const view = luaView();
    let text = "";
    let total = 0;
    for (let index = 0; index < count; index++) {
      const ptr = view.getUint32(iovs + index * 8, true);
      const length = view.getUint32(iovs + index * 8 + 4, true);
      text += consoleDecoder.decode(bytes.subarray(ptr, ptr + length));
      total += length;
    }
    (fd === 2 ? console.error : console.log)(`[lua51.wasm] ${text}`);
    view.setUint32(writtenPtr, total, true);
    return 0;
  },
  path_open: () => ENOTCAPABLE,
  proc_exit: (code: number) => {
    throw new Error(`lua51.wasm called proc_exit(${code}) (Lua panic)`);
  },
};

async function wasmBytes(url: URL): Promise<Uint8Array> {
  if (url.protocol === "file:") {
    const nodeProcess = (globalThis as { process?: { getBuiltinModule?: (name: string) => unknown } }).process;
    const fs = nodeProcess?.getBuiltinModule?.("node:fs") as { readFileSync(path: URL): Uint8Array; existsSync(path: URL): boolean } | undefined;
    if (!fs) throw new Error("lua51.wasm: a file: URL outside Node");
    // `tsc` emits this module to dist/code without the binary, and the source test hook runs src/ under
    // dist/code URLs: the committed artifact lives beside the source.
    const source = fs.existsSync(url) ? url : new URL(url.href.replace("/dist/code/", "/src/"));
    return fs.readFileSync(source);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`lua51.wasm: ${response.status} for ${url.href}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function instantiate(): Promise<LuaWasmExports> {
  const url = new URL("./lua51.wasm", import.meta.url);
  luaWasmLoad.url = url.href;
  const source = await wasmBytes(url);
  luaWasmLoad.bytes = source.length;
  let started = performance.now();
  const module = await WebAssembly.compile(source as BufferSource);
  luaWasmLoad.compileMs = performance.now() - started;
  started = performance.now();
  const instance = await WebAssembly.instantiate(module, {
    env: {
      wl_host_call: (state: number, index: number) => hostCall(state, index),
      wl_tz_offset: (seconds: number) => -new Date(seconds * 1000).getTimezoneOffset() * 60,
    },
    wasi_snapshot_preview1: wasi,
  });
  const exports = instance.exports as unknown as LuaWasmExports;
  memory = exports.memory;
  luaHeap();
  exports._initialize();
  luaWasmLoad.instantiateMs = performance.now() - started;
  return exports;
}

/** The module's exports; every C API call goes through these. */
export const luaWasm: LuaWasmExports = await instantiate();
