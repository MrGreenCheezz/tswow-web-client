import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";
import { CUSTOM_MAX_SEND_BODY } from "./CustomPacket.js";

/**
 * A schema for the flat byte stream inside a tswow custom packet.
 *
 * The transport carries no type information at all — six bytes of header and then whatever the
 * livescript wrote, field after field, with nothing to say where one ends. Both sides therefore
 * need the same list of fields in the same order, and this is that list.
 *
 * The obvious alternative was tswow's own `@Message` / `@MsgClass` / `@MsgPrimitive` decorators,
 * and they are not an option: they are declared in four `global.d.ts` copies and implemented
 * nowhere. The generators behind them were deleted by `5b043c15` ("remove all old addon message
 * systems") and `75357fa8`, taking `MessagePlugin.ts`, `BinReader.ts`, `AddonMessage.ts`,
 * `TSMessageBuffer` and `tswow-packet-def.ts` with them. So the schema lives in JSON beside the
 * module's windows, and the codec can still spell the old fixed-stride layout — `fixedString` and
 * `array` with a capacity — for a module that writes those bytes by hand.
 *
 * ## The JSON a module ships
 *
 * `modules/<mod>/content/messages/<name>.json`, loaded by М3. Either a `{ "messages": [...] }`
 * object or a bare array of message objects:
 *
 * ```json
 * {
 *   "messages": [{
 *     "name": "shop.State",
 *     "opcode": 4001,
 *     "direction": "in",
 *     "doc": "What the shop window shows.",
 *     "fields": [
 *       { "name": "gold",   "type": "u32" },
 *       { "name": "title",  "type": "string" },
 *       { "name": "tag",    "type": "fixedString", "size": 12 },
 *       { "name": "prices", "type": "array", "capacity": 8, "of": { "type": "u32" } },
 *       { "name": "seller", "type": "nested", "fields": [{ "name": "entry", "type": "u32" }] }
 *     ]
 *   }]
 * }
 * ```
 *
 * `name` is module-qualified and unique across the client, `opcode` is a `uint16` the module
 * author allocates by hand (tswow's `ids.txt` allocator died with `75357fa8`, so М3's loader
 * refusing two modules that claim the same number is the whole of the substitute), and `direction`
 * is `"in"`, `"out"` or `"both"` — a message declared `"in"` is never encoded, and vice versa.
 *
 * ## What each field is on the wire
 *
 * | type | bytes | source |
 * |---|---|---|
 * | `u8` `i8` | 1 | `Write<T>` is `memcpy(sizeof(T))`, `CustomPacketBase.h:48-52` |
 * | `u16` `i16` | 2 LE | as above |
 * | `u32` `i32` `f32` | 4 LE | as above |
 * | `u64` `i64` `f64` | 8 LE | as above; the two integers decode to `bigint` |
 * | `string` | `u32` length then the bytes, no terminator | `CustomPacketWrite.cpp:34-41` |
 * | `cstring` | the bytes then one `0` | `WriteStringNullTerm`, `CustomPacketWrite.cpp:50-57` |
 * | `fixedString(n)` | `u8` length then exactly `n` bytes | legacy `@MsgString(n)` |
 * | `array(capacity, of)` | `u8` count then exactly `capacity` slots | legacy `@Msg*Array(n)` |
 * | `nested` | the fields inline, nothing around them | legacy `@MsgClass` |
 *
 * Three traps are worth knowing before writing a schema, all of them the server's:
 *
 * * **A `string` of exactly 65,535 bytes is unreadable.** `ReadString` reads its length with a
 *   default of `TotalSizeNpos` and returns that default when the two match
 *   (`CustomPacketRead.cpp:19-20`); `TotalSizeNpos` is `UINT16_MAX` even though the length field is
 *   32 bits (`CustomPacketDefines.h:9-10`). Worse, the default is returned *without consuming the
 *   string*, so every later field in that message is read from the wrong offset. This codec refuses
 *   that length in both directions rather than let the two sides silently disagree.
 * * **`u64` and `i64` do not survive tswow's Lua.** `ClientNetwork.lua:73-74` dispatches
 *   `READ_UINT32` for both 64-bit readers, and `TSPacketRead::ReadUInt64` returns
 *   `double(Read(def))` (`TSCustomPacket.h:81-82`), so a livescript sees at most 53 bits and the
 *   Lua addon sees the low 32. Eight bytes still go on the wire, because that is what the C++
 *   writes; expect the other side to round.
 * * **`CreateCustomPacket(opcode, size)`'s size becomes payload.** It preallocates and the
 *   preallocation is never trimmed (`CustomPacketBase.cpp:25-52`, `:151-182`), so
 *   `CreateCustomPacket(op, 100)` plus one `WriteUInt32` sends 100 bytes, 96 of them uninitialised
 *   heap. {@link decodeCustom} therefore reads what the schema declares and reports the rest as a
 *   remainder instead of throwing — and, for the same reason, steps over an `array`'s slots past
 *   its count rather than decoding them: that reserved tail is the same uninitialised heap, and a
 *   `0xff` sitting in it is not a reason to throw the message away.
 *
 * One rule of the transport reaches back into the schema: an outbound message must have at least
 * one byte to send, so `"fields": []` is refused at load. A frame carrying nothing but its
 * six-byte header is what the server calls `NO_HEADER`, and it answers that with a kick — see
 * `CUSTOM_MIN_SEND_BODY`. A "the player pressed Close" message needs a field, even a `u8` the
 * livescript ignores.
 */

export type CustomNumericKind =
  | "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "f32" | "f64";

export type CustomFieldType =
  | { readonly kind: CustomNumericKind }
  /** Eight bytes, decoded to `bigint` because 64 bits do not fit in a double. */
  | { readonly kind: "u64" | "i64" }
  /** `u32` length then UTF-8 bytes, no terminator. */
  | { readonly kind: "string" }
  /** UTF-8 bytes then one `0`. Nothing in tswow's Lua bridge writes these, but C++ can. */
  | { readonly kind: "cstring" }
  /** `u8` length then exactly `size` bytes, the way `@MsgString(n)` laid it out. */
  | { readonly kind: "fixedString"; readonly size: number }
  /** `u8` count then exactly `capacity` slots, used or not, the way `@Msg*Array(n)` laid it out. */
  | { readonly kind: "array"; readonly capacity: number; readonly of: CustomFieldType }
  /** The fields inline, with nothing around them. */
  | { readonly kind: "nested"; readonly fields: readonly CustomField[] };

export interface CustomField {
  readonly name: string;
  readonly type: CustomFieldType;
  readonly doc?: string;
}

export type CustomDirection = "in" | "out" | "both";

export interface CustomMessage {
  /** Module-qualified and unique: `"shop.State"`. */
  readonly name: string;
  readonly opcode: number;
  readonly direction: CustomDirection;
  readonly fields: readonly CustomField[];
  readonly doc?: string;
}

export type CustomValue = Record<string, unknown>;

export interface CustomDecoded {
  readonly value: CustomValue;
  /**
   * Bytes past the last declared field. Not an error — see the `CreateCustomPacket` trap above —
   * but worth showing in the diagnostics window, because it is also what a schema that has fallen
   * behind the livescript looks like.
   */
  readonly remainder: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The length that `ReadString` mistakes for "nothing was written" (`CustomPacketDefines.h:10`). */
export const CUSTOM_STRING_NPOS = 65_535;

/** `u8` count in front of a `fixedString` or an `array`, so neither can be longer than this. */
const CUSTOM_COUNT_MAX = 255;

const NUMERIC_SIZES: Readonly<Record<CustomNumericKind | "u64" | "i64", number>> = {
  u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, f64: 8, u64: 8, i64: 8,
};

const INTEGER_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  u8: [0, 0xff],
  i8: [-0x80, 0x7f],
  u16: [0, 0xffff],
  i16: [-0x8000, 0x7fff],
  u32: [0, 0xffff_ffff],
  i32: [-0x8000_0000, 0x7fff_ffff],
};

const BIG_RANGES: Readonly<Record<"u64" | "i64", readonly [bigint, bigint]>> = {
  u64: [0n, 0xffff_ffff_ffff_ffffn],
  i64: [-0x8000_0000_0000_0000n, 0x7fff_ffff_ffff_ffffn],
};

/**
 * How many bytes one field always takes, or `undefined` when it depends on the value.
 *
 * Only `string` and `cstring` are variable; the legacy array and string shapes are not, which is
 * the whole reason the old `@Message` layout could put every field at a fixed offset.
 */
export function customFieldSize(type: CustomFieldType): number | undefined {
  switch (type.kind) {
    case "string":
    case "cstring":
      return undefined;
    case "fixedString":
      return 1 + type.size;
    case "array": {
      const inner = customFieldSize(type.of);
      return inner === undefined ? undefined : 1 + inner * type.capacity;
    }
    case "nested": {
      let total = 0;
      for (const field of type.fields) {
        const size = customFieldSize(field.type);
        if (size === undefined) return undefined;
        total += size;
      }
      return total;
    }
    default:
      return NUMERIC_SIZES[type.kind];
  }
}

/** The whole message's size, or `undefined` when any field of it is variable-length. */
export function customMessageSize(message: CustomMessage): number | undefined {
  return customFieldSize({ kind: "nested", fields: message.fields });
}

/**
 * The fewest bytes one field can ever occupy.
 *
 * The same number as {@link customFieldSize} wherever that is defined; where it is not, an empty
 * `string` is still its four-byte length and an empty `cstring` is still its terminator. A `nested`
 * is the sum of its fields' floors rather than a flat 1, which is what {@link firstOversizeField}
 * needs: a `nested` holding a 65,281-byte array and one `string` has no fixed size at all, and
 * charging it a single byte let a message that can never be sent load without a word and then fail
 * on the first attempt to encode it.
 */
function customFieldMinSize(type: CustomFieldType): number {
  switch (type.kind) {
    case "string":
      return 4;
    case "cstring":
      return 1;
    case "array":
      return 1 + customFieldMinSize(type.of) * type.capacity;
    case "nested": {
      let total = 0;
      for (const field of type.fields) total += customFieldMinSize(field.type);
      return total;
    }
    default:
      return customFieldSize(type) ?? 0;
  }
}

/**
 * A `RangeError` that already has a field name in front of it.
 *
 * {@link decodeFields} decides whether to add one, and it used to decide by reading the message
 * text — anything already starting with the field's name was left alone, so that a `nested` field's
 * error was not named twice. `PacketReader` opens its own two errors with "Packet underflow at N"
 * and "Unterminated string at N" (`PacketReader.ts:23`, `:79`), so a field called `Packet`, `Pa`,
 * `U` or `Unterminated` looked like it had been named when it had not: `RangeError: Packet
 * underflow at 0: need 4, have 1` reads as a named field and is not one. The class carries the
 * fact instead of the prose, and every message this codec raises still is a `RangeError`.
 */
class NamedFieldError extends RangeError {}

function fail(path: string, reason: string): never {
  throw new NamedFieldError(`${path}: ${reason}`);
}

/**
 * Refuses a `fixedString` or an `array` whose length cannot fit in the byte that carries it.
 *
 * {@link parseCustomMessages} already caps both at {@link CUSTOM_COUNT_MAX}, so a schema loaded
 * from JSON can never reach here; a schema built in TypeScript can, and `PacketWriter.u8` masks
 * (`PacketWriter.ts:22`), so `array(300, u8)` carrying 300 items used to encode 301 bytes whose
 * count byte read 44 and decode back to 44 items — a silent loss of 256 of them, with nothing
 * thrown on either side. The two entry points now enforce what the loader does.
 */
function checkCounted(length: number, what: string, path: string): void {
  if (!Number.isInteger(length) || length < 0 || length > CUSTOM_COUNT_MAX) {
    fail(path, `${what} does not fit the u8 that counts it: 0..${CUSTOM_COUNT_MAX}`);
  }
}

function encodeField(writer: PacketWriter, type: CustomFieldType, value: unknown, path: string): void {
  switch (type.kind) {
    case "u8": case "i8": case "u16": case "i16": case "u32": case "i32": {
      const range = INTEGER_RANGES[type.kind];
      if (typeof value !== "number" || !Number.isInteger(value)) fail(path, `${type.kind} needs an integer, got ${describe(value)}`);
      if (range && (value < range[0] || value > range[1])) fail(path, `${value} is outside the ${type.kind} range ${range[0]}..${range[1]}`);
      writer[type.kind](value);
      return;
    }
    case "f32": case "f64": {
      if (typeof value !== "number") fail(path, `${type.kind} needs a number, got ${describe(value)}`);
      writer[type.kind](value);
      return;
    }
    case "u64": case "i64": {
      writer[type.kind](toBigInt(type.kind, value, path));
      return;
    }
    case "string": {
      if (typeof value !== "string") fail(path, `string needs a string, got ${describe(value)}`);
      const bytes = encoder.encode(value);
      // The one length tswow's own reader cannot tell from "absent"; see the header comment.
      if (bytes.byteLength === CUSTOM_STRING_NPOS) {
        fail(path, `a string of exactly ${CUSTOM_STRING_NPOS} bytes reads as the default on the other side and swallows the rest of the message`);
      }
      writer.u32(bytes.byteLength).bytes(bytes);
      return;
    }
    case "cstring": {
      if (typeof value !== "string") fail(path, `cstring needs a string, got ${describe(value)}`);
      if (value.includes("\0")) fail(path, "a cstring cannot contain a null byte: it is the terminator");
      writer.cString(value);
      return;
    }
    case "fixedString": {
      if (typeof value !== "string") fail(path, `fixedString needs a string, got ${describe(value)}`);
      checkCounted(type.size, `fixedString(${type.size})`, path);
      const bytes = encoder.encode(value);
      if (bytes.byteLength > type.size) fail(path, `${bytes.byteLength} bytes do not fit in fixedString(${type.size})`);
      writer.u8(bytes.byteLength).bytes(bytes).bytes(new Uint8Array(type.size - bytes.byteLength));
      return;
    }
    case "array": {
      if (!Array.isArray(value)) fail(path, `array needs an array, got ${describe(value)}`);
      checkCounted(type.capacity, `array(${type.capacity})`, path);
      if (value.length > type.capacity) fail(path, `${value.length} items do not fit in array(${type.capacity})`);
      const stride = customFieldSize(type.of);
      if (stride === undefined) fail(path, "an array of a variable-length type has no stride");
      writer.u8(value.length);
      for (const [index, item] of value.entries()) encodeField(writer, type.of, item, `${path}[${index}]`);
      // The unused slots still travel: the old layout always occupied its full capacity, and a
      // reader that trusts the stride would otherwise read the next field out of this one's tail.
      writer.bytes(new Uint8Array((type.capacity - value.length) * stride));
      return;
    }
    case "nested": {
      if (typeof value !== "object" || value === null) fail(path, `nested needs an object, got ${describe(value)}`);
      encodeFields(writer, type.fields, value as CustomValue, path);
      return;
    }
  }
}

function encodeFields(writer: PacketWriter, fields: readonly CustomField[], value: CustomValue, path: string): void {
  for (const field of fields) {
    const where = path ? `${path}.${field.name}` : field.name;
    const before = writer.length;
    encodeField(writer, field.type, value[field.name], where);
    if (writer.length > CUSTOM_MAX_SEND_BODY) {
      fail(where, `the body reached ${writer.length} bytes here (it was ${before} before this field),`
        + ` over CUSTOM_MAX_SEND_BODY (${CUSTOM_MAX_SEND_BODY}): the worldserver closes the socket on a larger frame`);
    }
  }
}

function decodeField(reader: PacketReader, type: CustomFieldType, path: string): unknown {
  switch (type.kind) {
    case "u8": case "i8": case "u16": case "i16": case "u32": case "i32":
    case "f32": case "f64": case "u64": case "i64":
      return reader[type.kind]();
    case "string": {
      const length = reader.u32();
      if (length === CUSTOM_STRING_NPOS) {
        fail(path, `a string length of ${CUSTOM_STRING_NPOS} is tswow's "nothing was written" marker, so the sender and this schema disagree`);
      }
      return decoder.decode(reader.bytes(length));
    }
    case "cstring":
      return reader.cString();
    case "fixedString": {
      checkCounted(type.size, `fixedString(${type.size})`, path);
      const length = reader.u8();
      if (length > type.size) fail(path, `fixedString(${type.size}) was given a length of ${length}`);
      const raw = reader.bytes(type.size);
      return decoder.decode(raw.subarray(0, length));
    }
    case "array": {
      checkCounted(type.capacity, `array(${type.capacity})`, path);
      const stride = customFieldSize(type.of);
      if (stride === undefined) fail(path, "an array of a variable-length type has no stride");
      const count = reader.u8();
      if (count > type.capacity) fail(path, `array(${type.capacity}) was given a count of ${count}`);
      const items: unknown[] = [];
      for (let index = 0; index < count; index++) items.push(decodeField(reader, type.of, `${path}[${index}]`));
      // The slots past `count` are stepped over, not read. They are exactly the bytes
      // `CreateCustomPacket(op, size)` preallocated and never wrote — uninitialised heap, per the
      // third trap in this file's header — so decoding them threw away whole messages over content
      // that is discarded either way: `array(3, fixedString(2))` holding one name, with 0xff left
      // in a reserved slot, died on "names[1]: fixedString(2) was given a length of 255". The
      // stride still has to be walked, or every later field reads from the wrong offset; the copy
      // `bytes` makes is the price of raising the same underflow the rest of the codec relies on.
      reader.bytes((type.capacity - count) * stride);
      return items;
    }
    case "nested":
      return decodeFields(reader, type.fields, path);
  }
}

function decodeFields(reader: PacketReader, fields: readonly CustomField[], path: string): CustomValue {
  const value: CustomValue = {};
  for (const field of fields) {
    const where = path ? `${path}.${field.name}` : field.name;
    try {
      value[field.name] = decodeField(reader, field.type, where);
    } catch (error) {
      // The reader's own underflow message says the offset but not the field, and on a transport
      // with no framing the field name is the whole diagnosis: it says exactly where the two
      // schemas parted company. A `nested` field's error already carries the full path, and says
      // so by its class, so it travels up untouched.
      if (error instanceof NamedFieldError || !(error instanceof RangeError)) throw error;
      throw new NamedFieldError(`${where}: ${error.message}`);
    }
  }
  return value;
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  // Only ever called while building somebody else's error message, so it must not raise one of its
  // own. `JSON.stringify` throws on a bigint and on a cycle, and a bigint is the likeliest thing to
  // arrive at the wrong field: `decodeCustom` hands u64 and i64 back as bigint, so feeding a
  // decoded guid into a u32 is one line of module code away, and answering that with
  // `TypeError: Do not know how to serialize a BigInt` throws away the field name this whole
  // function exists to supply.
  if (typeof value === "bigint") return `bigint ${value}`;
  let printed: string | undefined;
  try {
    printed = JSON.stringify(value) ?? undefined;
  } catch {
    printed = undefined;
  }
  return printed === undefined ? typeof value : `${typeof value} ${printed.slice(0, 40)}`;
}

function toBigInt(kind: "u64" | "i64", value: unknown, path: string): bigint {
  const range = BIG_RANGES[kind];
  let big: bigint;
  if (typeof value === "bigint") {
    big = value;
  } else if (typeof value === "number") {
    // A number past 2^53 has already lost the bits it would need; taking it would write a value the
    // caller never asked for and no later check could notice.
    if (!Number.isSafeInteger(value)) fail(path, `${kind} needs a bigint or a safe integer, and ${value} is neither`);
    big = BigInt(value);
  } else {
    fail(path, `${kind} needs a bigint or a safe integer, got ${describe(value)}`);
  }
  if (big < range[0] || big > range[1]) fail(path, `${big} is outside the ${kind} range`);
  return big;
}

/**
 * Value to bytes, without the six-byte fragment header.
 *
 * Throws `RangeError` naming the field: a wrong type, a value out of range, or the point at which
 * the body crossed {@link CUSTOM_MAX_SEND_BODY}.
 */
export function encodeCustom(message: CustomMessage, value: CustomValue): Uint8Array {
  if (message.direction === "in") {
    throw new RangeError(`${message.name}: declared direction "in", so this client never encodes it`);
  }
  const writer = new PacketWriter();
  encodeFields(writer, message.fields, value, "");
  return writer.toUint8Array();
}

/**
 * Bytes to value.
 *
 * Throws on underflow — on a transport with no framing, running out of bytes means the two sides
 * disagree about the schema, and guessing would hand a window a field the sender never wrote.
 * Tolerates a remainder, and reports how big it was.
 */
export function decodeCustom(message: CustomMessage, body: Uint8Array): CustomDecoded {
  if (message.direction === "out") {
    throw new RangeError(`${message.name}: declared direction "out", so this client never decodes it`);
  }
  const reader = new PacketReader(body);
  const value = decodeFields(reader, message.fields, "");
  return { value, remainder: reader.remaining };
}

/* ---------------------------------------------------------------------------------------------
 * Loading and checking a definition file
 * ------------------------------------------------------------------------------------------- */

export interface CustomMessageParse {
  readonly messages: CustomMessage[];
  /** Every problem found, not just the first: a module author fixing one file wants the whole list. */
  readonly problems: string[];
}

const DIRECTIONS = new Set(["in", "out", "both"]);
const SIMPLE_KINDS = new Set(Object.keys(NUMERIC_SIZES).concat("string", "cstring"));

function parseType(raw: unknown, path: string, problems: string[]): CustomFieldType | undefined {
  if (typeof raw !== "object" || raw === null) {
    problems.push(`${path}: a field type must be an object with a "type"`);
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const kind = record["type"];
  if (typeof kind !== "string") {
    problems.push(`${path}: "type" must be a string`);
    return undefined;
  }
  if (SIMPLE_KINDS.has(kind)) return { kind } as CustomFieldType;

  if (kind === "fixedString") {
    const size = record["size"];
    if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > CUSTOM_COUNT_MAX) {
      problems.push(`${path}: fixedString needs a "size" from 1 to ${CUSTOM_COUNT_MAX} (the length in front of it is one byte)`);
      return undefined;
    }
    return { kind: "fixedString", size };
  }

  if (kind === "array") {
    const capacity = record["capacity"];
    if (typeof capacity !== "number" || !Number.isInteger(capacity) || capacity < 1 || capacity > CUSTOM_COUNT_MAX) {
      problems.push(`${path}: array needs a "capacity" from 1 to ${CUSTOM_COUNT_MAX} (the count in front of it is one byte)`);
      return undefined;
    }
    const of = parseType(record["of"], `${path}.of`, problems);
    if (!of) return undefined;
    if (customFieldSize(of) === undefined) {
      // The layout this mirrors reserved every slot whether it was used or not, which only works
      // when a slot has a fixed width. `array(n, fixedString(len))` is how the old
      // `@MsgStringArray(n, len)` is spelled here.
      problems.push(`${path}: an array item must have a fixed size; wrap a string as fixedString(n)`);
      return undefined;
    }
    return { kind: "array", capacity, of };
  }

  if (kind === "nested") {
    const fields = parseFields(record["fields"], path, problems);
    return fields ? { kind: "nested", fields } : undefined;
  }

  problems.push(`${path}: unknown field type "${kind}"`);
  return undefined;
}

function parseFields(raw: unknown, path: string, problems: string[]): CustomField[] | undefined {
  if (!Array.isArray(raw)) {
    problems.push(`${path}: "fields" must be an array`);
    return undefined;
  }
  const fields: CustomField[] = [];
  const seen = new Set<string>();
  // One bad field condemns the message rather than being skipped: a schema with a hole in it would
  // decode every field after the hole from the wrong offset, which is worse than not loading.
  let sound = true;
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null) {
      problems.push(`${path}.fields[${index}]: a field must be an object`);
      sound = false;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = record["name"];
    if (typeof name !== "string" || !name) {
      problems.push(`${path}.fields[${index}]: "name" must be a non-empty string`);
      sound = false;
      continue;
    }
    if (seen.has(name)) {
      problems.push(`${path}.fields[${index}]: "${name}" is declared twice`);
      sound = false;
      continue;
    }
    seen.add(name);
    const type = parseType(record, `${path}.${name}`, problems);
    if (!type) {
      sound = false;
      continue;
    }
    const doc = record["doc"];
    fields.push(typeof doc === "string" ? { name, type, doc } : { name, type });
  }
  return sound ? fields : undefined;
}

function parseMessage(raw: unknown, path: string, problems: string[]): CustomMessage | undefined {
  if (typeof raw !== "object" || raw === null) {
    problems.push(`${path}: a message must be an object`);
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const name = record["name"];
  if (typeof name !== "string" || !name) {
    problems.push(`${path}: "name" must be a non-empty string`);
    return undefined;
  }
  const opcode = record["opcode"];
  if (typeof opcode !== "number" || !Number.isInteger(opcode) || opcode < 0 || opcode > 0xffff) {
    problems.push(`${name}: "opcode" must be a uint16`);
    return undefined;
  }
  const direction = record["direction"] ?? "both";
  if (typeof direction !== "string" || !DIRECTIONS.has(direction)) {
    problems.push(`${name}: "direction" must be "in", "out" or "both"`);
    return undefined;
  }
  const fields = parseFields(record["fields"], name, problems);
  if (!fields) return undefined;

  const doc = record["doc"];
  const message: CustomMessage = typeof doc === "string"
    ? { name, opcode, direction: direction as CustomDirection, fields, doc }
    : { name, opcode, direction: direction as CustomDirection, fields };

  const unsendable = emptyBodyProblem(message) ?? firstOversizeField(message);
  if (unsendable) problems.push(unsendable);
  return unsendable ? undefined : message;
}

/**
 * A message this client could only ever send as a header-only frame.
 *
 * `"fields": []` is the obvious way to spell "the player pressed Close", and it is the one shape
 * the transport cannot carry: the server reads a six-byte frame as `NO_HEADER` and kicks
 * (`CustomPacketBuffer.cpp:24-27`, and see `CUSTOM_MIN_SEND_BODY`). {@link buildCustomPacket}
 * refuses it, but by then the player has pressed the button; said here, the module author hears it
 * when the file loads.
 *
 * Inbound only-empty messages are left alone for the same reason the size ceiling is: nothing this
 * client does can send one, so nothing it does can get anybody kicked with one.
 */
function emptyBodyProblem(message: CustomMessage): string | undefined {
  if (message.direction === "in") return undefined;
  // `undefined` means a variable field, and every variable field writes at least its length or its
  // terminator — so only a message that is fixed at zero bytes can never fill a frame.
  if (customMessageSize(message) !== 0) return undefined;
  return `${message.name}: an outbound message with no fields encodes to nothing, and a custom frame carrying`
    + " only its header is what the worldserver kicks for (NO_HEADER); give it at least one field";
}

/**
 * The field at which an outbound message outgrows the socket, if any.
 *
 * Only for a message this client can send. Inbound messages are not capped here and must not be:
 * the server may fragment up to the 8,000,000-byte buffer quota, and refusing an 80 KB
 * server-to-client message at load time would forbid something the transport handles.
 */
function firstOversizeField(message: CustomMessage): string | undefined {
  if (message.direction === "in") return undefined;
  let total = 0;
  for (const field of message.fields) {
    // A variable field contributes its floor, and the fixed fields around it are what a "this can
    // never be sent" verdict has to rest on.
    total += customFieldMinSize(field.type);
    if (total > CUSTOM_MAX_SEND_BODY) {
      return `${message.name}.${field.name}: the message is already ${total} bytes here, over CUSTOM_MAX_SEND_BODY`
        + ` (${CUSTOM_MAX_SEND_BODY}), so it could never be sent`;
    }
  }
  return undefined;
}

/**
 * Validates one definition file into messages.
 *
 * Collects problems rather than throwing on the first, because the caller is a module author
 * looking at their own JSON and the second mistake is as interesting as the first. A message with a
 * problem is left out of `messages`; the rest still load.
 */
export function parseCustomMessages(raw: unknown): CustomMessageParse {
  const problems: string[] = [];
  const source = Array.isArray(raw) ? raw : (typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["messages"] : undefined);
  if (!Array.isArray(source)) {
    return { messages: [], problems: ['expected {"messages": [...]} or a bare array of messages'] };
  }

  const messages: CustomMessage[] = [];
  const names = new Set<string>();
  for (const [index, entry] of source.entries()) {
    const message = parseMessage(entry, `messages[${index}]`, problems);
    if (!message) continue;
    if (names.has(message.name)) {
      problems.push(`${message.name}: declared twice in one file`);
      continue;
    }
    names.add(message.name);
    messages.push(message);
  }
  return { messages, problems };
}
