import { CUSTOM_MAX_SEND_BODY } from "../../world/CustomPacket.js";
import { GlueLuaVm } from "../glue/GlueLua.js";

/** Machine-readable runtime capability consumed by the patch audit and focused integration test. */
export const FRAME_XML_CLIENT_NETWORK_CAPABILITY = "tswow-client-network-v1";

/** `LuaNetworkOpcode` from TSWoW's `ClientNetwork.lua` / `ClientNetwork.cpp`. */
export const FRAME_XML_CLIENT_NETWORK_OPCODES = Object.freeze({
  WRITE_SIZE: 0,
  READ_SIZE: 1,
  WRITE_UINT8: 2,
  WRITE_INT8: 3,
  WRITE_UINT16: 4,
  WRITE_INT16: 5,
  WRITE_UINT32: 6,
  WRITE_INT32: 7,
  WRITE_UINT64: 8,
  WRITE_INT64: 9,
  WRITE_FLOAT: 10,
  WRITE_DOUBLE: 11,
  WRITE_STRING: 12,
  READ_UINT8: 13,
  READ_INT8: 14,
  READ_UINT16: 15,
  READ_INT16: 16,
  READ_UINT32: 17,
  READ_INT32: 18,
  READ_UINT64: 19,
  READ_INT64: 20,
  READ_FLOAT: 21,
  READ_DOUBLE: 22,
  READ_STRING: 23,
  MAKE_CUSTOM_PACKET: 24,
  SEND_CUSTOM_PACKET: 25,
  RESET_CUSTOM_PACKET: 26,
} as const);

export interface FrameXmlClientNetworkTransport {
  sendRaw(opcode: number, body: Uint8Array): void;
  on(opcode: number, handler: (body: Uint8Array, opcode: number) => void): () => void;
}

export interface FrameXmlClientNetworkCapabilityProbe {
  readonly capability: string;
  readonly ok: boolean;
  readonly message: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function number(value: unknown, fallback = 0): number {
  const converted = Number(value ?? fallback);
  return Number.isFinite(converted) ? converted : fallback;
}

function integer(value: unknown, fallback = 0): number {
  return Math.trunc(number(value, fallback));
}

function int64(value: unknown, signed: boolean): bigint {
  const converted = BigInt(integer(value));
  return signed ? BigInt.asIntN(64, converted) : BigInt.asUintN(64, converted);
}

/**
 * `CustomPacketWrite`, including its surprising `initialSize` contract.
 *
 * The native implementation treats the size passed to `CreateCustomPacket` as already-existing
 * payload, writes from byte zero, and never trims the reserved tail. JavaScript zero-fills that
 * tail instead of publishing native heap bytes, while retaining the same length and offsets.
 */
class LuaPacketWrite {
  readonly opcode: number;
  #bytes: Uint8Array;
  #length: number;
  #offset = 0;

  constructor(opcode: number, initialSize: number) {
    if (!Number.isInteger(opcode) || opcode < 0 || opcode > 0xffff) {
      throw new RangeError(`custom opcode ${opcode} is not a uint16`);
    }
    if (!Number.isInteger(initialSize) || initialSize < 0 || initialSize > CUSTOM_MAX_SEND_BODY) {
      throw new RangeError(
        `custom packet reserve ${initialSize} is outside 0..${CUSTOM_MAX_SEND_BODY}`,
      );
    }
    this.opcode = opcode;
    this.#bytes = new Uint8Array(initialSize);
    this.#length = initialSize;
  }

  get size(): number {
    return this.#length;
  }

  body(): Uint8Array {
    return this.#bytes.slice(0, this.#length);
  }

  u8(value: number): void { this.#fixed(1, (view, at) => view.setUint8(at, value)); }
  i8(value: number): void { this.#fixed(1, (view, at) => view.setInt8(at, value)); }
  u16(value: number): void { this.#fixed(2, (view, at) => view.setUint16(at, value, true)); }
  i16(value: number): void { this.#fixed(2, (view, at) => view.setInt16(at, value, true)); }
  u32(value: number): void { this.#fixed(4, (view, at) => view.setUint32(at, value, true)); }
  i32(value: number): void { this.#fixed(4, (view, at) => view.setInt32(at, value, true)); }
  u64(value: bigint): void { this.#fixed(8, (view, at) => view.setBigUint64(at, value, true)); }
  i64(value: bigint): void { this.#fixed(8, (view, at) => view.setBigInt64(at, value, true)); }
  f32(value: number): void { this.#fixed(4, (view, at) => view.setFloat32(at, value, true)); }
  f64(value: number): void { this.#fixed(8, (view, at) => view.setFloat64(at, value, true)); }

  string(value: string): void {
    const bytes = encoder.encode(value);
    this.u32(bytes.byteLength);
    this.#write(bytes);
  }

  #fixed(size: number, write: (view: DataView, offset: number) => void): void {
    const at = this.#reserve(size);
    write(new DataView(this.#bytes.buffer), at);
  }

  #write(bytes: Uint8Array): void {
    const at = this.#reserve(bytes.byteLength);
    this.#bytes.set(bytes, at);
  }

  #reserve(size: number): number {
    const end = this.#offset + size;
    if (end > CUSTOM_MAX_SEND_BODY) {
      throw new RangeError(
        `custom packet ${this.opcode} reached ${end} bytes, over ${CUSTOM_MAX_SEND_BODY}`,
      );
    }
    if (end > this.#bytes.byteLength) {
      let capacity = Math.max(16, this.#bytes.byteLength || 1);
      while (capacity < end) capacity = Math.min(CUSTOM_MAX_SEND_BODY, capacity * 2);
      const grown = new Uint8Array(capacity);
      grown.set(this.#bytes);
      this.#bytes = grown;
    }
    const at = this.#offset;
    this.#offset = end;
    if (end > this.#length) this.#length = end;
    return at;
  }
}

/** Bounds-safe form of `CustomPacketRead`: underflow returns the native default without advancing. */
class LuaPacketRead {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get size(): number {
    return this.#bytes.byteLength;
  }

  reset(): void {
    this.#offset = 0;
  }

  u8(fallback = 0): number { return this.#fixed(1, fallback, (at) => this.#view.getUint8(at)); }
  i8(fallback = 0): number { return this.#fixed(1, fallback, (at) => this.#view.getInt8(at)); }
  u16(fallback = 0): number { return this.#fixed(2, fallback, (at) => this.#view.getUint16(at, true)); }
  i16(fallback = 0): number { return this.#fixed(2, fallback, (at) => this.#view.getInt16(at, true)); }
  u32(fallback = 0): number { return this.#fixed(4, fallback, (at) => this.#view.getUint32(at, true)); }
  i32(fallback = 0): number { return this.#fixed(4, fallback, (at) => this.#view.getInt32(at, true)); }
  u64(fallback = 0): number {
    return Number(this.#fixed(8, BigInt(integer(fallback)), (at) => this.#view.getBigUint64(at, true)));
  }
  i64(fallback = 0): number {
    return Number(this.#fixed(8, BigInt(integer(fallback)), (at) => this.#view.getBigInt64(at, true)));
  }
  f32(fallback = 0): number { return this.#fixed(4, fallback, (at) => this.#view.getFloat32(at, true)); }
  f64(fallback = 0): number { return this.#fixed(8, fallback, (at) => this.#view.getFloat64(at, true)); }

  string(): string {
    // A missing length prefix and the perfectly valid uint32 length 65,535 must not share a
    // sentinel. Match the native bounds rule directly: underflow returns empty and does not move
    // the cursor, while any present prefix (including 0xffff) advances past its four bytes.
    if (4 > this.#bytes.byteLength - this.#offset) return "";
    const at = this.#offset;
    const length = this.#view.getUint32(at, true);
    this.#offset += 4;
    if (length === 0) return "";
    if (length > this.#bytes.byteLength - this.#offset) return "";
    const bodyAt = this.#offset;
    this.#offset += length;
    return decoder.decode(this.#bytes.subarray(bodyAt, bodyAt + length));
  }

  #fixed<T>(size: number, fallback: T, read: (offset: number) => T): T {
    if (size > this.#bytes.byteLength - this.#offset) return fallback;
    const at = this.#offset;
    this.#offset += size;
    return read(at);
  }
}

/**
 * Installed as soon as the real `ClientNetwork.lua` has run.
 *
 * Registrations made while the TOC was loading already live in `__callbacks`, so they are scanned
 * once. Future (including LoD) calls are observed by wrapping the real helper rather than replacing
 * its callback table or dispatch semantics.
 */
const CALLBACK_PRELUDE = `
do
  local original = rawget(_G, "OnCustomPacket")
  local wrapped = rawget(_G, "__fxClientNetworkOnCustomPacket")
  if type(original) == "function" and original ~= wrapped then
    __fxClientNetworkOriginalOnCustomPacket = original
    __fxClientNetworkOnCustomPacket = function(opcode, callback)
      local result = __fxClientNetworkOriginalOnCustomPacket(opcode, callback)
      __fxClientNetworkSubscribe(opcode)
      return result
    end
    OnCustomPacket = __fxClientNetworkOnCustomPacket
    __fxClientNetworkCallbacksArmed = true
  end
  local callbacks = rawget(_G, "__callbacks")
  if type(callbacks) == "table" then
    for opcode, _ in pairs(callbacks) do __fxClientNetworkSubscribe(opcode) end
  end
end
`;

/** Wire-compatible `_CLIENT_NETWORK` host for TSWoW's unmodified ClientNetwork.lua. */
export class FrameXmlClientNetworkBridge {
  readonly #vm: GlueLuaVm;
  readonly #transport: FrameXmlClientNetworkTransport;
  readonly #writes = new Map<number, LuaPacketWrite>();
  readonly #subscriptions = new Map<number, () => void>();
  #nextWriteId = 0;
  #read: LuaPacketRead | undefined;
  #installed = false;
  #callbacksArmed = false;
  #closed = false;

  readonly #runCallback: (callback: () => void) => void;
  readonly #onChange: ((opcodes: ReadonlySet<number>) => void) | undefined;

  /**
   * `onChange` hears the set of opcodes the Lua is subscribed to whenever it grows, and the empty
   * set at `close()` — what the JSON windows of the same content-studio screen step aside for (9.08).
   */
  constructor(
    vm: GlueLuaVm,
    transport: FrameXmlClientNetworkTransport,
    runCallback: (callback: () => void) => void = (callback) => callback(),
    onChange?: (opcodes: ReadonlySet<number>) => void,
  ) {
    this.#vm = vm;
    this.#transport = transport;
    this.#runCallback = runCallback;
    this.#onChange = onChange;
  }

  /** The custom opcodes the Lua has an `OnCustomPacket` subscription for. */
  opcodes(): ReadonlySet<number> {
    return new Set(this.#subscriptions.keys());
  }

  /** Register the C-API globals before any FrameXML/TSAddon Lua executes. */
  install(): void {
    if (this.#installed || this.#closed) return;
    this.#installed = true;
    this.#vm.setGlobal("_FRAME_XML_CLIENT_NETWORK_CAPABILITY", FRAME_XML_CLIENT_NETWORK_CAPABILITY);
    this.#vm.registerGlobal("__fxClientNetworkSubscribe", (args) => {
      this.#subscribe(integer(args[0], -1));
      return [];
    });
    this.#vm.registerGlobal("_CLIENT_NETWORK", (args) => this.#call(args));
  }

  /** Arm callback observation once the owner library has defined `OnCustomPacket`. */
  activateCallbacks(): void {
    if (this.#callbacksArmed || this.#closed) return;
    const result = this.#vm.execute(CALLBACK_PRELUDE, "@FrameXmlClientNetwork:callbacks");
    if (!result.ok) throw new Error(`FrameXML ClientNetwork callback bridge failed: ${result.error}`);
    this.#callbacksArmed = this.#vm.getGlobal("__fxClientNetworkCallbacksArmed") === true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const had = this.#subscriptions.size > 0;
    for (const unsubscribe of this.#subscriptions.values()) unsubscribe();
    this.#subscriptions.clear();
    this.#writes.clear();
    this.#read = undefined;
    if (had) this.#notify();
  }

  #notify(): void {
    try { this.#onChange?.(this.opcodes()); } catch { /* an observer must not break the Lua call */ }
  }

  #call(args: readonly unknown[]): readonly unknown[] {
    if (this.#closed) return [];
    const operation = integer(args[0], -1);
    const id = integer(args[1], -1);
    const write = this.#writes.get(id);
    const fallback = number(args[1]);
    const op = FRAME_XML_CLIENT_NETWORK_OPCODES;
    switch (operation) {
      case op.WRITE_SIZE: return [write?.size ?? 0];
      case op.READ_SIZE: return [this.#read?.size ?? 0];
      case op.WRITE_UINT8: write?.u8(number(args[2])); return [];
      case op.WRITE_INT8: write?.i8(number(args[2])); return [];
      case op.WRITE_UINT16: write?.u16(number(args[2])); return [];
      case op.WRITE_INT16: write?.i16(number(args[2])); return [];
      case op.WRITE_UINT32: write?.u32(number(args[2])); return [];
      case op.WRITE_INT32: write?.i32(number(args[2])); return [];
      case op.WRITE_UINT64: write?.u64(int64(args[2], false)); return [];
      case op.WRITE_INT64: write?.i64(int64(args[2], true)); return [];
      case op.WRITE_FLOAT: write?.f32(number(args[2])); return [];
      case op.WRITE_DOUBLE: write?.f64(number(args[2])); return [];
      case op.WRITE_STRING: write?.string(String(args[2] ?? "")); return [];
      case op.READ_UINT8: return [this.#read?.u8(fallback) ?? fallback];
      case op.READ_INT8: return [this.#read?.i8(fallback) ?? fallback];
      case op.READ_UINT16: return [this.#read?.u16(fallback) ?? fallback];
      case op.READ_INT16: return [this.#read?.i16(fallback) ?? fallback];
      case op.READ_UINT32: return [this.#read?.u32(fallback) ?? fallback];
      case op.READ_INT32: return [this.#read?.i32(fallback) ?? fallback];
      case op.READ_UINT64: return [this.#read?.u64(fallback) ?? fallback];
      case op.READ_INT64: return [this.#read?.i64(fallback) ?? fallback];
      case op.READ_FLOAT: return [this.#read?.f32(fallback) ?? fallback];
      case op.READ_DOUBLE: return [this.#read?.f64(fallback) ?? fallback];
      case op.READ_STRING: return [this.#read?.string() ?? ""];
      case op.MAKE_CUSTOM_PACKET: {
        const opcode = integer(args[1]);
        const initialSize = integer(args[2]);
        const writerId = this.#freeWriteId();
        this.#writes.set(writerId, new LuaPacketWrite(opcode, initialSize));
        return [writerId];
      }
      case op.SEND_CUSTOM_PACKET: {
        if (!write) return [];
        this.#writes.delete(id);
        this.#transport.sendRaw(write.opcode, write.body());
        return [];
      }
      case op.RESET_CUSTOM_PACKET:
        this.#read?.reset();
        return [];
      default:
        throw new RangeError(`invalid LuaNetworkOpcode ${operation}`);
    }
  }

  #freeWriteId(): number {
    while (this.#writes.has(this.#nextWriteId)) this.#nextWriteId = (this.#nextWriteId + 1) >>> 0;
    const id = this.#nextWriteId;
    this.#nextWriteId = (this.#nextWriteId + 1) >>> 0;
    return id;
  }

  #subscribe(opcode: number): void {
    if (this.#closed || !Number.isInteger(opcode) || opcode < 0 || opcode > 0xffff
      || this.#subscriptions.has(opcode)) return;
    const unsubscribe = this.#transport.on(opcode, (body) => {
      if (this.#closed) return;
      const previous = this.#read;
      this.#read = new LuaPacketRead(body);
      const fire = this.#vm.globalFunction("__FireCustomPacket");
      try {
        if (fire) this.#runCallback(() => { this.#vm.call(fire, [opcode], 0); });
      } finally {
        if (fire) this.#vm.release(fire);
        this.#read = previous;
      }
    });
    this.#subscriptions.set(opcode, unsubscribe);
    this.#notify();
  }
}

/**
 * Execute the transport, codec, callback and teardown paths used by the production host.
 *
 * The operator patch audit imports the compiled browser module and calls this function. That makes
 * its green result evidence that an executable bridge exists in the build being audited, rather
 * than a source-text/string claim that `_CLIENT_NETWORK` is supported.
 */
export function probeFrameXmlClientNetworkCapability(): FrameXmlClientNetworkCapabilityProbe {
  const sent: Array<{ readonly opcode: number; readonly body: Uint8Array }> = [];
  const handlers = new Map<number, Set<(body: Uint8Array, opcode: number) => void>>();
  const listenerGroups = (): number => handlers.size;
  const transport: FrameXmlClientNetworkTransport = {
    sendRaw: (opcode, body) => { sent.push({ opcode, body: body.slice() }); },
    on: (opcode, handler) => {
      const current = handlers.get(opcode) ?? new Set();
      current.add(handler);
      handlers.set(opcode, current);
      return () => {
        current.delete(handler);
        if (current.size === 0) handlers.delete(opcode);
      };
    },
  };
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlClientNetworkBridge(vm, transport);
  try {
    bridge.install();
    const loaded = vm.execute(`
      __callbacks = {}
      function OnCustomPacket(opcode, callback)
        __callbacks[opcode] = __callbacks[opcode] or {}
        table.insert(__callbacks[opcode], callback)
      end
      function __FireCustomPacket(opcode)
        for _, callback in pairs(__callbacks[opcode] or {}) do
          callback()
          _CLIENT_NETWORK(26)
        end
      end
      OnCustomPacket(41, function() __fxClientNetworkProbeInbound = _CLIENT_NETWORK(22) end)
      local writer = _CLIENT_NETWORK(24, 42, 0)
      _CLIENT_NETWORK(11, writer, 7)
      _CLIENT_NETWORK(25, writer)
    `, "@FrameXmlClientNetwork:capability-probe");
    if (!loaded.ok) {
      return {
        capability: FRAME_XML_CLIENT_NETWORK_CAPABILITY,
        ok: false,
        message: loaded.error ?? "Lua capability probe failed without an error message",
      };
    }
    bridge.activateCallbacks();
    const inbound = new Uint8Array(8);
    new DataView(inbound.buffer).setFloat64(0, 13, true);
    for (const handler of handlers.get(41) ?? []) handler(inbound, 41);

    const outbound = sent[0];
    const outboundValue = outbound && outbound.body.byteLength === 8
      ? new DataView(outbound.body.buffer, outbound.body.byteOffset, 8).getFloat64(0, true)
      : undefined;
    const marker = vm.getGlobal("_FRAME_XML_CLIENT_NETWORK_CAPABILITY");
    const inboundValue = vm.getGlobal("__fxClientNetworkProbeInbound");
    if (marker !== FRAME_XML_CLIENT_NETWORK_CAPABILITY
      || sent.length !== 1 || outbound?.opcode !== 42 || outboundValue !== 7
      || listenerGroups() !== 1 || inboundValue !== 13) {
      return {
        capability: FRAME_XML_CLIENT_NETWORK_CAPABILITY,
        ok: false,
        message: "compiled bridge failed its outbound/inbound wire probe",
      };
    }
    bridge.close();
    if (listenerGroups() !== 0) {
      return {
        capability: FRAME_XML_CLIENT_NETWORK_CAPABILITY,
        ok: false,
        message: "compiled bridge left a custom-packet subscription after close",
      };
    }
    return {
      capability: FRAME_XML_CLIENT_NETWORK_CAPABILITY,
      ok: true,
      message: "compiled bridge passed outbound, inbound and lifecycle probes",
    };
  } catch (error) {
    return {
      capability: FRAME_XML_CLIENT_NETWORK_CAPABILITY,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    bridge.close();
    vm.close();
  }
}
