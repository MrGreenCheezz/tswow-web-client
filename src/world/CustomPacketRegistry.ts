import {
  decodeCustom, encodeCustom, type CustomDirection, type CustomMessage, type CustomValue,
} from "./CustomCodec.js";

/**
 * Who owns which custom opcode, what the last message on it decoded to, and what nobody claimed.
 *
 * The transport (`CustomPacket.ts`) turns fragments into whole bodies and the codec
 * (`CustomCodec.ts`) turns a body into a value; neither knows that two modules exist. This is the
 * part that does. It answers four questions a module author asks in this order:
 *
 * 1. *Did my message arrive?* — a per-opcode counter, and the last value it decoded to.
 * 2. *Did it arrive as something else?* — the decode error, named by field, kept beside the counter.
 * 3. *Did somebody else take my number?* — {@link CustomPacketRegistry.define} refuses the second
 *    claim and names both modules.
 * 4. *Is the server sending something I never declared?* — the unclaimed ring, with the raw bytes.
 *
 * ## Why a duplicate opcode is refused rather than resolved
 *
 * tswow used to allocate message ids out of an `ids.txt`; the allocator went with `75357fa8` along
 * with the rest of the `@Message` machinery, and the owner's own content studio replaced it with a
 * comment in the Lua it generates — «Опкоды должны быть уникальны на весь сервер», beside the two
 * constants it writes (`tswow-content-studio/server/codegen/addon.mjs:1171-1176`). So the numbers
 * are hand-allocated, collisions are a matter of time, and this refusal is the whole of what is
 * left of the allocator. It names both modules because the module that loaded second is not
 * necessarily the one that is wrong.
 *
 * The refusal covers both directions even though the two directions ride different world opcodes —
 * inbound on `CMSG_EMOTE`'s number and outbound on `CMSG_CUSTOM`'s, so 4001-in and 4001-out could
 * technically coexist here. They are refused anyway, because the studio's rule is the one the
 * livescript author is reading, and a client that quietly allowed what the server's own guidance
 * forbids would teach a module author a rule this codebase cannot enforce anywhere else.
 *
 * ## What a failed handler does not do
 *
 * Nothing to the others. A schema in JSON that has fallen a field behind its livescript makes
 * `decodeCustom` throw *by design*, so a throwing subscriber is the ordinary case here rather than
 * the exotic one; every call is wrapped on its own and the failure is reported as a problem.
 */

/** Samples kept for one unclaimed opcode: enough to recognise a layout, few enough to bound. */
const SAMPLE_LIMIT = 4;
/** Bytes kept per sample. The diagnostics window shows them as hex, two characters a byte. */
const SAMPLE_BYTES = 256;
/**
 * Opcodes remembered at once.
 *
 * A ring rather than a cap, evicted least-recently-seen first and never taking a claimed opcode
 * while an unclaimed one is there to take instead. 64 is well over what a module ships — the studio
 * writes two constants per screen — and costs at most 64 × 4 × 256 = 65,536 bytes of samples.
 */
const TRAFFIC_LIMIT = 64;
/** Problems kept for the diagnostics window; the oldest is dropped past this. */
const PROBLEM_LIMIT = 32;

/**
 * The entry backlog's bounds (9.03). Starting numbers, not measured: 2 MiB is a quarter of the
 * reassembly quota (`CUSTOM_BUFFER_QUOTA`), 30 s is the `CMSG_PING` period the transport's own tail
 * timeout uses, 512 messages is generous headroom. Take the held count and size at a live entry
 * (`customPackets.backlog` before the release, 14.01) and adjust.
 */
export const CUSTOM_BACKLOG_MAX_MESSAGES = 512;
export const CUSTOM_BACKLOG_MAX_BYTES = 2 * 1024 * 1024;
export const CUSTOM_BACKLOG_TTL_MS = 30_000;

/** What {@link CustomPacketRegistry.offer} did with one message. */
export type CustomOfferResult =
  /** A schema or a subscriber took it now. */
  | "delivered"
  /** The entry backlog holds it (or delivered it in an overflow release and reported it itself). */
  | "held"
  /** Nothing claimed it and nothing holds it: the caller records it as unhandled. */
  | "unclaimed";

export interface CustomBacklogOptions {
  /** The consumers to wait for, by name (`"modules"`, `"lua"`). Empty: no backlog. */
  readonly expect: readonly string[];
  readonly maxMessages?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly ttlMs?: number | undefined;
}

export interface CustomBacklogState {
  readonly holding: boolean;
  readonly queued: number;
  readonly bytes: number;
  /** The consumers not yet ready, sorted. */
  readonly waiting: readonly string[];
  /** How the last backlog ended, for the diagnostics pane; undefined before the first release. */
  readonly lastRelease: { readonly reason: string; readonly messages: number } | undefined;
}

interface EntryBacklog {
  readonly waiting: Set<string>;
  readonly queue: { readonly opcode: number; readonly body: Uint8Array }[];
  bytes: number;
  readonly maxMessages: number;
  readonly maxBytes: number;
  cancel: () => void;
  releaseQueued: boolean;
}

const defaultSchedule = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

export type CustomPacketProblemKind =
  /** A message arrived and its declared schema could not read it. */
  | "decode"
  /** A subscriber threw while being handed a message. */
  | "handler"
  /** A message arrived on an opcode declared outbound-only. */
  | "direction";

export interface CustomPacketProblem {
  readonly kind: CustomPacketProblemKind;
  readonly opcode: number;
  /** The message that claims the opcode, when one does. */
  readonly name: string | undefined;
  readonly at: number;
  /** Ready to show, and the same sentence `onPacketError` is given. */
  readonly text: string;
}

/** One opcode's traffic, as the diagnostics window wants it. */
export interface CustomOpcodeSummary {
  readonly opcode: number;
  /** The message claiming the opcode right now, or `undefined` for an unclaimed one. */
  readonly name: string | undefined;
  readonly module: string | undefined;
  readonly direction: CustomDirection | undefined;
  /**
   * True while something here can *read* an inbound message on this opcode.
   *
   * A message declared `"out"` is not one of them — nothing can decode it — which is why this is
   * exactly what {@link CustomPacketRegistry.deliver} answers, and why it is the wrong question for
   * the window and for the ring. See {@link declared}.
   */
  readonly claimed: boolean;
  /**
   * True while any schema or raw subscriber owns the opcode, whichever way it points.
   *
   * Split from {@link claimed} because the two questions gave the same answer for every message
   * except an outbound one, and got that one backwards twice over: the ring evicted a module's own
   * `"out"` opcode as if it were noise from a stray script, and the window painted it in the
   * no-schema colour under the heading «схемы нет» — for a message whose schema is loaded and whose
   * name is printed on the same line.
   */
  readonly declared: boolean;
  readonly received: number;
  readonly receivedBytes: number;
  readonly sent: number;
  readonly sentBytes: number;
  readonly decoded: number;
  readonly failed: number;
  /** Bytes past the last declared field on the last decode. See `CustomCodec`'s third trap. */
  readonly remainder: number;
  readonly value: CustomValue | undefined;
  readonly error: string | undefined;
  readonly firstSeen: number;
  readonly lastSeen: number;
  /** Raw bodies kept for an opcode nothing decoded, hex-encoded. */
  readonly samples: string[];
}

export interface CustomDefineResult {
  /** The messages that are now live. A message whose name or opcode was taken is not among them. */
  readonly defined: readonly CustomMessage[];
  /** One sentence per refusal, naming both claimants. Empty when the whole file loaded. */
  readonly problems: readonly string[];
}

export interface CustomPacketRegistryOptions {
  /**
   * Where an encoded message goes. `WorldClient.sendCustomPacket` in the client; absent in a test
   * that only decodes, and then {@link CustomPacketRegistry.send} says so rather than dropping it.
   */
  readonly send?: ((opcode: number, body: Uint8Array) => void) | undefined;
  readonly onProblem?: ((problem: CustomPacketProblem) => void) | undefined;
  /** Injected by the tests; `Date.now` in the client. */
  readonly clock?: (() => number) | undefined;
  /** The entry backlog's fallback timer; `setTimeout`/`clearTimeout` unless a test replaces it. */
  readonly schedule?: ((run: () => void, ms: number) => () => void) | undefined;
  /**
   * A message the entry backlog held and nothing claimed when it was released. The live path's
   * `"unclaimed"` answer is the caller's to record; this is the same record for held messages.
   */
  readonly onBacklogUnclaimed?: ((opcode: number, body: Uint8Array) => void) | undefined;
}

export type CustomRawHandler = (body: Uint8Array, opcode: number) => void;
export type CustomMessageHandler = (value: CustomValue, message: CustomMessage) => void;

interface OpcodeTraffic {
  received: number;
  receivedBytes: number;
  sent: number;
  sentBytes: number;
  decoded: number;
  failed: number;
  remainder: number;
  value: CustomValue | undefined;
  error: string | undefined;
  firstSeen: number;
  lastSeen: number;
  readonly samples: Uint8Array[];
}

const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export class CustomPacketRegistry {
  readonly #send: ((opcode: number, body: Uint8Array) => void) | undefined;
  readonly #onProblem: ((problem: CustomPacketProblem) => void) | undefined;
  readonly #clock: () => number;
  readonly #byName = new Map<string, CustomMessage>();
  readonly #byOpcode = new Map<number, CustomMessage>();
  /** Which module defined each message, so `forget` can take back exactly what it gave. */
  readonly #owner = new Map<string, string>();
  readonly #rawHandlers = new Map<number, Set<CustomRawHandler>>();
  readonly #messageHandlers = new Map<string, Set<CustomMessageHandler>>();
  readonly #latest = new Map<string, CustomValue>();
  readonly #traffic = new Map<number, OpcodeTraffic>();
  #revision = 0;
  readonly #schedule: (run: () => void, ms: number) => () => void;
  readonly #onBacklogUnclaimed: ((opcode: number, body: Uint8Array) => void) | undefined;
  #backlog: EntryBacklog | undefined;
  #lastRelease: { reason: string; messages: number } | undefined;
  /** The last few decode and handler failures, for the diagnostics window. */
  readonly problems: CustomPacketProblem[] = [];

  constructor(options: CustomPacketRegistryOptions = {}) {
    this.#send = options.send;
    this.#onProblem = options.onProblem;
    this.#clock = options.clock ?? Date.now;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#onBacklogUnclaimed = options.onBacklogUnclaimed;
  }

  /**
   * Starts holding every incoming message until each named consumer has called
   * {@link consumerReady}, the bounds overflow, or the fallback timer fires (9.03).
   *
   * Why one FIFO for every opcode rather than a replay per subscriber: the consumers come up late —
   * the JSON windows after `/modules/index`, the TSWoW Lua after the whole FrameXML load — and a
   * module's order between its own opcodes (state, then delta) must survive. A replay on `on()`
   * would also run a Lua callback inside `OnCustomPacket(...)`, before the add-on has finished its
   * own load, which the real client never does. The cost is that a live message waits for the
   * slowest consumer, at most `ttlMs`; every module of this install waits for a client-ready
   * handshake anyway. The real TSWoW client simply loses such a message: this is a deliberate,
   * bounded improvement on it, not fidelity.
   *
   * A no-op with an empty `expect` or while a backlog is already holding.
   */
  beginBacklog(options: CustomBacklogOptions): void {
    if (this.#backlog || options.expect.length === 0) return;
    const backlog: EntryBacklog = {
      waiting: new Set(options.expect),
      queue: [],
      bytes: 0,
      maxMessages: options.maxMessages ?? CUSTOM_BACKLOG_MAX_MESSAGES,
      maxBytes: options.maxBytes ?? CUSTOM_BACKLOG_MAX_BYTES,
      cancel: () => {},
      releaseQueued: false,
    };
    backlog.cancel = this.#schedule(() => {
      if (this.#backlog === backlog) this.flushBacklog("timeout");
    }, options.ttlMs ?? CUSTOM_BACKLOG_TTL_MS);
    this.#backlog = backlog;
    this.#revision++;
  }

  /**
   * One whole message from the transport: held while the entry backlog is, else {@link deliver}ed.
   * The body is kept as given — the transport hands over a copy.
   */
  offer(opcode: number, body: Uint8Array): CustomOfferResult {
    const backlog = this.#backlog;
    if (!backlog) return this.deliver(opcode, body) ? "delivered" : "unclaimed";
    backlog.queue.push({ opcode, body });
    backlog.bytes += body.byteLength;
    this.#revision++;
    if (backlog.queue.length > backlog.maxMessages || backlog.bytes > backlog.maxBytes) {
      // Released early, in order, the newest message last; reported like any other held one.
      const claimed = this.#release("overflow");
      return claimed.at(-1) === true ? "delivered" : "held";
    }
    return "held";
  }

  /**
   * One expected consumer is subscribed. When the last one is, the backlog is released on a
   * microtask — so the consumer's own `finally` has finished before any of its handlers run.
   */
  consumerReady(name: string): void {
    const backlog = this.#backlog;
    if (!backlog || !backlog.waiting.delete(name)) return;
    this.#revision++;
    if (backlog.waiting.size > 0 || backlog.releaseQueued) return;
    backlog.releaseQueued = true;
    queueMicrotask(() => {
      if (this.#backlog === backlog) this.flushBacklog("ready");
    });
  }

  /** Releases the backlog now: every held message in arrival order, through {@link deliver}. */
  flushBacklog(reason: string): void {
    this.#release(reason);
  }

  /** Drops the backlog without delivering it and cancels its timer (a world session ending). */
  dispose(): void {
    const backlog = this.#backlog;
    if (!backlog) return;
    this.#backlog = undefined;
    backlog.cancel();
    this.#revision++;
  }

  /** The backlog as the diagnostics pane shows it. */
  get backlog(): CustomBacklogState {
    const backlog = this.#backlog;
    return {
      holding: backlog !== undefined,
      queued: backlog?.queue.length ?? 0,
      bytes: backlog?.bytes ?? 0,
      waiting: backlog ? [...backlog.waiting].sort() : [],
      lastRelease: this.#lastRelease,
    };
  }

  /** Ends the backlog and delivers what it held; answers whether each message was claimed. */
  #release(reason: string): boolean[] {
    const backlog = this.#backlog;
    if (!backlog) return [];
    // Cleared first: a handler that sends or subscribes meets the live path, and the queue is not
    // kept after the release, so a later `forget` + `define` never sees these messages again.
    this.#backlog = undefined;
    backlog.cancel();
    this.#lastRelease = { reason, messages: backlog.queue.length };
    this.#revision++;
    const claimed: boolean[] = [];
    for (const { opcode, body } of backlog.queue.splice(0)) {
      const taken = this.deliver(opcode, body);
      claimed.push(taken);
      if (!taken) this.#onBacklogUnclaimed?.(opcode, body);
    }
    return claimed;
  }

  /**
   * Registers one module's messages.
   *
   * A name or an opcode somebody else already claimed is refused and the message is left out; the
   * rest of the file still loads, because a module author fixing one collision would rather see the
   * other nine messages working than have the file disappear. The same reasoning as
   * `parseCustomMessages`, which collects problems instead of throwing on the first.
   */
  define(messages: readonly CustomMessage[], moduleName: string): CustomDefineResult {
    const defined: CustomMessage[] = [];
    const problems: string[] = [];
    for (const message of messages) {
      const byName = this.#byName.get(message.name);
      if (byName) {
        problems.push(`module "${moduleName}": ${message.name} is already defined by ${this.#describe(byName)},`
          + ` so this copy is ignored`);
        continue;
      }
      const byOpcode = this.#byOpcode.get(message.opcode);
      if (byOpcode) {
        problems.push(`module "${moduleName}": ${message.name} wants opcode ${message.opcode}, which`
          + ` ${this.#describe(byOpcode)} already claims for ${byOpcode.name};`
          + ` a custom opcode may only be claimed once`);
        continue;
      }
      this.#byName.set(message.name, message);
      this.#byOpcode.set(message.opcode, message);
      this.#owner.set(message.name, moduleName);
      this.#revision++;
      defined.push(message);
    }
    // Deliberately not pushed into `problems`: that list is the wire log, and everything on it is
    // reported to `onPacketError`, which writes into the world status line as «пакет 0x102: …».
    // A collision between two files on disk is not a packet, and saying it was would put a load
    // error where the player looks for a network one. The loader keeps its own list and the
    // diagnostics tab shows both.
    return { defined, problems };
  }

  /**
   * Takes back everything one module defined, and returns how many messages that was.
   *
   * Only the schemas, and deliberately only those. Two things it does not take:
   *
   * * **The traffic counters.** They are facts about the wire rather than about the module, and an
   *   opcode that keeps arriving after its module was unloaded is exactly what somebody debugging a
   *   hot reload needs to see. It reads as unclaimed from here on, which is what it is.
   * * **The subscriptions by name.** A subscriber is a window, not a schema, and М6's hot reload is
   *   `forget` followed by `define` — dropping them here would silently disconnect every window the
   *   reload did not happen to rebuild. They come off through the function `on` returned.
   *
   * The last decoded value *does* go: it was decoded by a schema that no longer exists, and a
   * binding reading it after a reload would be reading a shape nothing guarantees any more.
   */
  forget(moduleName: string): number {
    let dropped = 0;
    for (const [name, owner] of [...this.#owner]) {
      if (owner !== moduleName) continue;
      const message = this.#byName.get(name);
      if (message) this.#byOpcode.delete(message.opcode);
      this.#byName.delete(name);
      this.#owner.delete(name);
      this.#latest.delete(name);
      this.#revision++;
      dropped++;
    }
    return dropped;
  }

  /** Every module with at least one message defined, in the order they first defined one. */
  modules(): string[] {
    return [...new Set(this.#owner.values())];
  }

  message(name: string): CustomMessage | undefined {
    return this.#byName.get(name);
  }

  messages(): CustomMessage[] {
    return [...this.#byName.values()];
  }

  /**
   * Subscribes by message name (decoded) or by opcode (raw bytes).
   *
   * The name form is bound late — the handler is looked up when a packet arrives, not when it is
   * registered — so a window may subscribe before its module's schema has loaded and keep working
   * across a hot reload that drops and redefines the message. The raw form is what М1's
   * `WorldClient.onCustomPacket` is, and a module that would rather read its own bytes uses it.
   */
  on(opcode: number, handler: CustomRawHandler): () => void;
  on(name: string, handler: CustomMessageHandler): () => void;
  on(nameOrOpcode: string | number, handler: CustomRawHandler | CustomMessageHandler): () => void {
    if (typeof nameOrOpcode === "number") {
      const opcode = nameOrOpcode;
      const raw = handler as CustomRawHandler;
      let handlers = this.#rawHandlers.get(opcode);
      if (!handlers) {
        handlers = new Set();
        this.#rawHandlers.set(opcode, handlers);
      }
      handlers.add(raw);
      return () => {
        const registered = this.#rawHandlers.get(opcode);
        if (!registered?.delete(raw)) return;
        // An opcode nobody listens to any more goes back to being unclaimed, which is what the
        // diagnostics window reports it as — and what `deliver` has to answer `false` for, or the
        // world loop stops counting it as an unhandled packet.
        if (registered.size === 0) this.#rawHandlers.delete(opcode);
      };
    }
    const name = nameOrOpcode;
    const decoded = handler as CustomMessageHandler;
    let handlers = this.#messageHandlers.get(name);
    if (!handlers) {
      handlers = new Set();
      this.#messageHandlers.set(name, handlers);
    }
    handlers.add(decoded);
    return () => {
      const registered = this.#messageHandlers.get(name);
      if (!registered?.delete(decoded)) return;
      if (registered.size === 0) this.#messageHandlers.delete(name);
    };
  }

  /** The last value one message decoded to, for a window binding to read as `msg.<name>.<field>`. */
  latest(name: string): CustomValue | undefined {
    return this.#latest.get(name);
  }

  /** Encodes through a declared message and sends it. Throws `RangeError` naming the message. */
  send(name: string, value: CustomValue): void {
    const message = this.#byName.get(name);
    if (!message) {
      throw new RangeError(`No custom message called "${name}" is defined`
        + `${this.#byName.size ? `; this client knows ${[...this.#byName.keys()].slice(0, 8).join(", ")}` : " and none is"}`);
    }
    this.sendRaw(message.opcode, encodeCustom(message, value));
  }

  /** The bytes of one message, for a module that builds its own body. */
  sendRaw(opcode: number, body: Uint8Array): void {
    if (!this.#send) throw new Error(`Custom opcode ${opcode} cannot be sent: this registry has no connection`);
    this.#send(opcode, body);
    const traffic = this.#trafficFor(opcode);
    traffic.sent++;
    traffic.sentBytes += body.byteLength;
    this.#revision++;
  }

  /**
   * One whole message from the transport. Answers whether anything claimed it.
   *
   * `false` is the world loop's cue to file the packet as unhandled, which is the only record a
   * module message with no listener leaves anywhere else.
   */
  deliver(opcode: number, body: Uint8Array): boolean {
    const now = this.#clock();
    const traffic = this.#trafficFor(opcode);
    traffic.received++;
    traffic.receivedBytes += body.byteLength;
    traffic.lastSeen = now;
    this.#revision++;

    const message = this.#byOpcode.get(opcode);
    const raw = this.#rawHandlers.get(opcode);
    let claimed = false;

    if (message && message.direction === "out") {
      // Declared as something this client sends, and the server sent it back. Nothing here can
      // decode it — `decodeCustom` refuses an "out" message on purpose — but the number is claimed,
      // so saying "unclaimed opcode, here is the hex" would send the author looking for a missing
      // schema they are in fact holding. Name it and say which half is wrong.
      traffic.failed++;
      traffic.error = `declared direction "out"`;
      this.#problem({
        kind: "direction",
        opcode,
        name: message.name,
        at: now,
        text: `custom opcode ${opcode}: ${message.name} is declared direction "out" and arrived from the server;`
          + ` change it to "in" or "both" to decode it`,
      });
    } else if (message) {
      claimed = true;
      try {
        const decoded = decodeCustom(message, body);
        traffic.decoded++;
        traffic.remainder = decoded.remainder;
        traffic.value = decoded.value;
        traffic.error = undefined;
        this.#latest.set(message.name, decoded.value);
        for (const handler of [...this.#messageHandlers.get(message.name) ?? []]) {
          try {
            handler(decoded.value, message);
          } catch (error) {
            this.#handlerProblem(opcode, message.name, error, now);
          }
        }
      } catch (error) {
        traffic.failed++;
        const text = error instanceof Error ? error.message : String(error);
        traffic.error = text;
        this.#problem({ kind: "decode", opcode, name: message.name, at: now, text: `custom opcode ${opcode}: ${text}` });
      }
    }

    if (raw?.size) {
      claimed = true;
      // A copy: a handler that unsubscribes itself would otherwise mutate the set being walked.
      for (const handler of [...raw]) {
        try {
          handler(body, opcode);
        } catch (error) {
          this.#handlerProblem(opcode, message?.name, error, now);
        }
      }
    }

    // Bytes are kept only for a message nothing read: a claimed opcode has its decoded value, and
    // holding the raw body as well would grow with every packet of a working module.
    if (!claimed && traffic.samples.length < SAMPLE_LIMIT) traffic.samples.push(body.slice(0, SAMPLE_BYTES));
    return claimed;
  }

  /**
   * Every opcode this session saw or sent on, plus every one a schema claims, busiest first.
   *
   * The silent rows are there because the first question a module author asks is not «how many»
   * but «did the client load my file at all, and on which number» — and a message that has not
   * carried anything yet appeared in no list on the screen: not here, because nothing had arrived,
   * and not in the file lines, which name files rather than messages. It reads as «тишина», with
   * every counter at zero and `firstSeen` still 0, because none of those are facts yet.
   */
  summary(): CustomOpcodeSummary[] {
    const rows: CustomOpcodeSummary[] = [];
    for (const [opcode, traffic] of this.#traffic) rows.push(this.#row(opcode, traffic));
    for (const opcode of this.#byOpcode.keys()) {
      if (!this.#traffic.has(opcode)) rows.push(this.#row(opcode, undefined));
    }
    return rows.sort((left, right) =>
      (right.received + right.sent) - (left.received + left.sent) || left.opcode - right.opcode);
  }

  /** The opcodes no schema and no subscriber owns, with the bytes that arrived on them. */
  unclaimed(): CustomOpcodeSummary[] {
    return this.summary().filter((row) => !row.declared && row.received > 0);
  }

  /** Drops every schema, subscription, counter and sample. Used when a world session ends. */
  clear(): void {
    this.dispose();
    this.#byName.clear();
    this.#byOpcode.clear();
    this.#owner.clear();
    this.#rawHandlers.clear();
    this.#messageHandlers.clear();
    this.#latest.clear();
    this.#traffic.clear();
    this.problems.length = 0;
    this.#revision++;
  }

  /**
   * How many times anything here changed: a message, a counter, a value, a problem.
   *
   * The diagnostics window's «Пакеты» pane is redrawn from the render loop and there is nothing
   * else to redraw it: a message on an opcode a schema claims never reaches the unhandled-opcode
   * list that used to be the pane's only cue, so the counters the pane exists to show stood still
   * while packets arrived, and the author had to close and reopen the window after each one.
   * Comparing this number is what keeps the redraw free while nothing is happening — which is most
   * frames — instead of rebuilding two dozen blocks sixty times a second.
   */
  get revision(): number {
    return this.#revision;
  }

  /** How many subscriptions are live. The unload test asserts this comes back to where it started. */
  get listenerCount(): number {
    let total = 0;
    for (const handlers of this.#rawHandlers.values()) total += handlers.size;
    for (const handlers of this.#messageHandlers.values()) total += handlers.size;
    return total;
  }

  /**
   * Which module a message belongs to, said so that two of these read as two modules.
   *
   * `${module}.${name}` was the obvious spelling and it is wrong here: a message name is already
   * module-qualified by convention — the studio writes `shop.State` — so joining them produced
   * `shop.shop.State`, and the whole point of the sentence is that the reader can tell the two
   * claimants apart at a glance.
   */
  #describe(message: CustomMessage): string {
    const owner = this.#owner.get(message.name);
    return owner ? `module "${owner}"` : "an unnamed module";
  }

  /** One row of {@link summary}; `traffic` is absent for a schema that has not carried anything. */
  #row(opcode: number, traffic: OpcodeTraffic | undefined): CustomOpcodeSummary {
    const message = this.#byOpcode.get(opcode);
    return {
      opcode,
      name: message?.name,
      module: message ? this.#owner.get(message.name) : undefined,
      direction: message?.direction,
      claimed: this.#claims(opcode),
      declared: this.#owns(opcode),
      received: traffic?.received ?? 0,
      receivedBytes: traffic?.receivedBytes ?? 0,
      sent: traffic?.sent ?? 0,
      sentBytes: traffic?.sentBytes ?? 0,
      decoded: traffic?.decoded ?? 0,
      failed: traffic?.failed ?? 0,
      remainder: traffic?.remainder ?? 0,
      value: traffic?.value,
      error: traffic?.error,
      firstSeen: traffic?.firstSeen ?? 0,
      lastSeen: traffic?.lastSeen ?? 0,
      samples: traffic?.samples.map(hex) ?? [],
    };
  }

  /** Whether anything can read this opcode right now: a schema that decodes, or a raw subscriber. */
  #claims(opcode: number): boolean {
    const message = this.#byOpcode.get(opcode);
    return (message !== undefined && message.direction !== "out") || (this.#rawHandlers.get(opcode)?.size ?? 0) > 0;
  }

  /**
   * Whether the opcode belongs to somebody: any schema at all, or a raw subscriber.
   *
   * Wider than {@link #claims} by exactly one case — a message declared `"out"` — and that case is
   * the reason the two exist. This is the question for anything that decides how to *treat* the
   * opcode: what the ring may evict, and what the window may call schemaless.
   */
  #owns(opcode: number): boolean {
    return this.#byOpcode.has(opcode) || (this.#rawHandlers.get(opcode)?.size ?? 0) > 0;
  }

  #trafficFor(opcode: number): OpcodeTraffic {
    const existing = this.#traffic.get(opcode);
    if (existing) {
      // Re-inserted so the map's own order stays least-recently-seen first, which is what the ring
      // evicts by.
      this.#traffic.delete(opcode);
      this.#traffic.set(opcode, existing);
      return existing;
    }
    if (this.#traffic.size >= TRAFFIC_LIMIT) this.#evict();
    const now = this.#clock();
    const traffic: OpcodeTraffic = {
      received: 0, receivedBytes: 0, sent: 0, sentBytes: 0, decoded: 0, failed: 0,
      remainder: 0, value: undefined, error: undefined, firstSeen: now, lastSeen: now, samples: [],
    };
    this.#traffic.set(opcode, traffic);
    return traffic;
  }

  /**
   * Makes room for one more opcode.
   *
   * Least recently seen first, and an opcode nothing claims before one a module owns. Plain
   * insertion order would have been simpler and would have got this exactly backwards: a module's
   * own opcode is registered before anything arrives, so it is the *first* entry in the map, and a
   * server or a stray script spraying numbers would have pushed it out of the very window that was
   * opened to watch it.
   *
   * By {@link #owns} rather than {@link #claims}: a message this client only ever *sends* is owned
   * by a module just as much as one it reads, and asking the narrower question here evicted its
   * sent-counters as noise — the one number that says whether the button did anything.
   */
  #evict(): void {
    let victim: number | undefined;
    for (const opcode of this.#traffic.keys()) {
      if (this.#owns(opcode)) continue;
      victim = opcode;
      break;
    }
    victim ??= this.#traffic.keys().next().value;
    if (victim !== undefined) this.#traffic.delete(victim);
  }

  #handlerProblem(opcode: number, name: string | undefined, error: unknown, at: number): void {
    this.#problem({
      kind: "handler",
      opcode,
      name,
      at,
      text: `custom opcode ${opcode}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  #problem(problem: CustomPacketProblem): void {
    this.problems.push(problem);
    if (this.problems.length > PROBLEM_LIMIT) this.problems.shift();
    this.#revision++;
    this.#onProblem?.(problem);
  }
}
