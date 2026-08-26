import assert from "node:assert/strict";
import test from "node:test";
import {
  CUSTOM_STRING_NPOS,
  customFieldSize,
  customMessageSize,
  decodeCustom,
  encodeCustom,
  parseCustomMessages,
} from "../dist/code/world/CustomCodec.js";
import { buildCustomPacket, CUSTOM_MAX_SEND_BODY } from "../dist/code/world/CustomPacket.js";

const message = (fields, extra = {}) => ({ name: "test.Message", opcode: 4001, direction: "both", fields, ...extra });
const field = (name, type) => ({ name, type });

/**
 * The whole message and nothing else.
 *
 * `assert.throws(fn, /re/)` matches `String(error)`, which begins "RangeError: " — so a `^` anchor
 * there tests the class name rather than the field name, and these assertions are about the field
 * name being at the front of the message and about it being a `RangeError` at all.
 */
const says = (text) => (error) => {
  assert.ok(error instanceof RangeError, `expected a RangeError, got ${error}`);
  assert.equal(error.message, text);
  return true;
};

test("every primitive matches the bytes a C++ memcpy of that type would leave", () => {
  // `CustomPacketBase::Write<T>` is `WriteBytes(sizeof(value), (char const*)&value)` on x86, so
  // each of these is the little-endian image of the C++ type and nothing else.
  const cases = [
    ["u8", { kind: "u8" }, 200, [0xc8]],
    ["i8", { kind: "i8" }, -3, [0xfd]],
    ["u16", { kind: "u16" }, 0xbeef, [0xef, 0xbe]],
    ["i16", { kind: "i16" }, -2, [0xfe, 0xff]],
    ["u32", { kind: "u32" }, 0xdeadbeef, [0xef, 0xbe, 0xad, 0xde]],
    ["i32", { kind: "i32" }, -2, [0xfe, 0xff, 0xff, 0xff]],
    ["u64", { kind: "u64" }, 0x0102030405060708n, [0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]],
    ["i64", { kind: "i64" }, -2n, [0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]],
    ["f32", { kind: "f32" }, 1.5, [0x00, 0x00, 0xc0, 0x3f]],
    ["f64", { kind: "f64" }, 1.5, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0x3f]],
  ];

  for (const [name, type, value, bytes] of cases) {
    const schema = message([field("only", type)]);
    assert.deepEqual([...encodeCustom(schema, { only: value })], bytes, name);
    assert.deepEqual(decodeCustom(schema, Uint8Array.from(bytes)), { value: { only: value }, remainder: 0 }, name);
    assert.equal(customFieldSize(type), bytes.length, name);
  }
});

test("a string is a u32 length and raw bytes, with no terminator", () => {
  // `CustomPacketWrite::WriteString` writes `Write<totalSize_t>(length)` then the bytes
  // (`CustomPacketWrite.cpp:34-41`); `totalSize_t` is uint32.
  const schema = message([field("text", { kind: "string" })]);
  assert.deepEqual([...encodeCustom(schema, { text: "hi" })], [0x02, 0, 0, 0, 0x68, 0x69]);
  assert.deepEqual([...encodeCustom(schema, { text: "" })], [0, 0, 0, 0]);
  // Two bytes of UTF-8 for one character: the length is bytes, not characters.
  assert.deepEqual([...encodeCustom(schema, { text: "é" })], [0x02, 0, 0, 0, 0xc3, 0xa9]);
  assert.equal(decodeCustom(schema, Uint8Array.of(0x02, 0, 0, 0, 0xc3, 0xa9)).value.text, "é");
  assert.equal(customMessageSize(schema), undefined, "a string makes the message variable-length");

  // A cstring is the other shape tswow can write: bytes then one zero, no length.
  const zeroTerminated = message([field("text", { kind: "cstring" })]);
  assert.deepEqual([...encodeCustom(zeroTerminated, { text: "hi" })], [0x68, 0x69, 0x00]);
  assert.equal(decodeCustom(zeroTerminated, Uint8Array.of(0x68, 0x69, 0x00)).value.text, "hi");
});

test("a string of exactly 65,535 bytes is refused in both directions", () => {
  // `ReadString` reads its length with a default of TotalSizeNpos and returns the default when the
  // two match (`CustomPacketRead.cpp:19-20`), without consuming the string — so tswow would read
  // every later field of that message from the wrong offset.
  assert.equal(CUSTOM_STRING_NPOS, 65_535);
  const schema = message([field("text", { kind: "string" })], { direction: "in" });
  const npos = new Uint8Array(4 + CUSTOM_STRING_NPOS);
  new DataView(npos.buffer).setUint32(0, CUSTOM_STRING_NPOS, true);
  assert.throws(() => decodeCustom(schema, npos), (error) => error.message.includes("text") && error.message.includes("65535"));

  // Refused before the socket-size check gets a look in, so the reason given is the real one.
  const outbound = message([field("text", { kind: "string" })], { opcode: 4002 });
  assert.throws(
    () => encodeCustom(outbound, { text: "x".repeat(CUSTOM_STRING_NPOS) }),
    (error) => error.message.startsWith("text:") && error.message.includes("65535"),
  );

  // One byte short of it is an ordinary string, and the decoder has no size ceiling of its own:
  // the server may fragment a message far larger than anything this client can send.
  const shorter = new Uint8Array(4 + CUSTOM_STRING_NPOS - 1).fill(0x78);
  new DataView(shorter.buffer).setUint32(0, CUSTOM_STRING_NPOS - 1, true);
  assert.equal(decodeCustom(schema, shorter).value.text.length, CUSTOM_STRING_NPOS - 1);
});

test("fixedString and array keep the old fixed-stride layout, capacity and all", () => {
  // `@MsgString(n)`: a u8 length then n bytes whether they are used or not.
  const tag = message([field("tag", { kind: "fixedString", size: 4 })]);
  assert.deepEqual([...encodeCustom(tag, { tag: "ab" })], [0x02, 0x61, 0x62, 0x00, 0x00]);
  assert.deepEqual(decodeCustom(tag, Uint8Array.of(0x02, 0x61, 0x62, 0xff, 0xff)), { value: { tag: "ab" }, remainder: 0 });
  assert.equal(customMessageSize(tag), 5);
  assert.throws(() => encodeCustom(tag, { tag: "abcde" }), /tag: 5 bytes do not fit in fixedString\(4\)/);

  // `@MsgPrimitiveArray(n)`: a u8 count then n slots, so the reader can trust the stride.
  const prices = message([field("prices", { kind: "array", capacity: 3, of: { kind: "u16" } })]);
  assert.deepEqual([...encodeCustom(prices, { prices: [1, 2] })], [0x02, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00]);
  // The whole receipt, not just the value: a decoder that stopped at the count would produce the
  // same two prices and leave the unused slot behind as a remainder, which is the next field's
  // offset gone wrong.
  assert.deepEqual(decodeCustom(prices, Uint8Array.of(0x02, 0x01, 0x00, 0x02, 0x00, 0x09, 0x09)),
    { value: { prices: [1, 2] }, remainder: 0 });
  assert.equal(customMessageSize(prices), 7);
  assert.throws(() => encodeCustom(prices, { prices: [1, 2, 3, 4] }), /prices: 4 items do not fit in array\(3\)/);

  // `@MsgStringArray(n, len)` is `array(n, fixedString(len))`, and it still occupies its capacity.
  const names = message([field("names", { kind: "array", capacity: 2, of: { kind: "fixedString", size: 2 } })]);
  assert.deepEqual([...encodeCustom(names, { names: ["ab"] })], [0x01, 0x02, 0x61, 0x62, 0x00, 0x00, 0x00]);
  assert.deepEqual(decodeCustom(names, Uint8Array.of(0x01, 0x02, 0x61, 0x62, 0x00, 0x00, 0x00)),
    { value: { names: ["ab"] }, remainder: 0 });

  // `@MsgClass`: the nested fields inline, with nothing around them.
  const nested = message([
    field("where", { kind: "nested", fields: [field("x", { kind: "f32" }), field("y", { kind: "f32" })] }),
    field("level", { kind: "u8" }),
  ]);
  assert.deepEqual([...encodeCustom(nested, { where: { x: 1.5, y: -1.5 }, level: 80 })],
    [0x00, 0x00, 0xc0, 0x3f, 0x00, 0x00, 0xc0, 0xbf, 0x50]);
  assert.deepEqual(decodeCustom(nested, encodeCustom(nested, { where: { x: 1.5, y: -1.5 }, level: 80 })).value,
    { where: { x: 1.5, y: -1.5 }, level: 80 });
  assert.equal(customMessageSize(nested), 9);
});

test("an unused array slot may hold anything: it is stepped over, not decoded", () => {
  // `CreateCustomPacket(op, size)` preallocates and never clears the tail, so the slots a
  // livescript reserved and did not fill are uninitialised heap. Decoding them meant a message was
  // thrown away over bytes this decoder discards anyway, and encoding is no help: it zero-fills the
  // padding, so a round trip never produces the shape the server does.
  const names = message([field("names", { kind: "array", capacity: 3, of: { kind: "fixedString", size: 2 } })]);
  const heap = Uint8Array.of(0x01, 0x02, 0x61, 0x62, 0xff, 0xde, 0xad, 0xff, 0xbe, 0xef);

  assert.deepEqual(decodeCustom(names, heap), { value: { names: ["ab"] }, remainder: 0 });

  // Every used slot is still checked, and the stride is still walked so the next field lands right.
  const after = message([
    field("names", { kind: "array", capacity: 2, of: { kind: "fixedString", size: 2 } }),
    field("level", { kind: "u8" }),
  ]);
  assert.deepEqual(decodeCustom(after, Uint8Array.of(0x01, 0x02, 0x61, 0x62, 0xff, 0xde, 0xad, 0x50)),
    { value: { names: ["ab"], level: 80 }, remainder: 0 });
  assert.throws(() => decodeCustom(after, Uint8Array.of(0x01, 0xff, 0x61, 0x62, 0x00, 0x00, 0x00, 0x50)),
    says("names[0]: fixedString(2) was given a length of 255"));
});

test("u64 takes a bigint or a safe integer and refuses anything that would round", () => {
  const schema = message([field("id", { kind: "u64" })]);
  assert.deepEqual([...encodeCustom(schema, { id: 258n })], [0x02, 0x01, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...encodeCustom(schema, { id: 258 })], [0x02, 0x01, 0, 0, 0, 0, 0, 0]);
  assert.equal(decodeCustom(schema, Uint8Array.of(0x02, 0x01, 0, 0, 0, 0, 0, 0)).value.id, 258n);

  // 2^53 is where a double stops being able to name every integer, and the wire is 64 bits wide.
  assert.throws(() => encodeCustom(schema, { id: 2 ** 53 }), /id: u64 needs a bigint or a safe integer/);
  assert.throws(() => encodeCustom(schema, { id: -1n }), /id: -1 is outside the u64 range/);
  assert.throws(() => encodeCustom(schema, { id: "3" }), /id: u64 needs a bigint or a safe integer/);
  assert.throws(() => encodeCustom(schema, { id: 1n << 64n }), /outside the u64 range/);

  const signed = message([field("id", { kind: "i64" })]);
  assert.deepEqual([...encodeCustom(signed, { id: -1n })], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  assert.throws(() => encodeCustom(signed, { id: 1n << 63n }), /outside the i64 range/);
});

test("a trailing remainder is reported and a shortfall is thrown, naming the field", () => {
  const schema = message([field("gold", { kind: "u32" }), field("level", { kind: "u8" })]);

  // `CreateCustomPacket(op, 100)` preallocates 100 bytes and sends all of them, so a message that
  // is longer than its schema is the normal case rather than a fault.
  const padded = new Uint8Array(100);
  new DataView(padded.buffer).setUint32(0, 4242, true);
  padded[4] = 80;
  assert.deepEqual(decodeCustom(schema, padded), { value: { gold: 4242, level: 80 }, remainder: 95 });

  // Running out is not: on a transport with no framing it means the two sides disagree, and the
  // field it stopped at is the whole diagnosis.
  assert.throws(() => decodeCustom(schema, Uint8Array.of(1, 2, 3, 4)), (error) => {
    assert.ok(error instanceof RangeError);
    assert.match(error.message, /^level: /);
    return true;
  });
  assert.throws(() => decodeCustom(schema, new Uint8Array(0)), (error) => error.message.startsWith("gold: "));

  const inner = message([field("where", { kind: "nested", fields: [field("x", { kind: "f32" })] })]);
  assert.throws(() => decodeCustom(inner, Uint8Array.of(1, 2)), (error) => error.message.startsWith("where.x: "));
});

test("a value that cannot be printed is still named, and still a RangeError", () => {
  // `decodeCustom` hands u64 and i64 back as bigint, so a decoded guid arriving at a u32 field is
  // one line of module code away — and `JSON.stringify` throws on a bigint, which lost both the
  // field name and the promised RangeError to `TypeError: Do not know how to serialize a BigInt`.
  const gold = message([field("gold", { kind: "u32" })]);
  assert.throws(() => encodeCustom(gold, { gold: 5n }), (error) => {
    assert.ok(error instanceof RangeError);
    assert.equal(error.message, "gold: u32 needs an integer, got bigint 5");
    return true;
  });
  const text = message([field("text", { kind: "string" })]);
  assert.throws(() => encodeCustom(text, { text: 5n }), says("text: string needs a string, got bigint 5"));

  // A cycle is the other thing `JSON.stringify` refuses; the type is all that is left to say.
  const circular = {};
  circular.self = circular;
  assert.throws(() => encodeCustom(gold, { gold: circular }), (error) => {
    assert.ok(error instanceof RangeError);
    assert.equal(error.message, "gold: u32 needs an integer, got object");
    return true;
  });
});

test("a field whose name reads like the reader's own error still gets named", () => {
  // The wrapper used to skip anything whose message already started with the field's name, so that
  // a nested field would not be named twice. `PacketReader` opens its two errors with "Packet
  // underflow at N" and "Unterminated string at N" (`PacketReader.ts:23`, `:79`) — so `P`, `Pa`,
  // ... `Packet`, `U` ... `Unterminated` were exactly the names that lost the naming.
  const named = message([field("Packet", { kind: "u32" })], { direction: "in" });
  assert.throws(() => decodeCustom(named, Uint8Array.of(1)), (error) => {
    assert.ok(error instanceof RangeError);
    assert.equal(error.message, "Packet: Packet underflow at 0: need 4, have 1");
    return true;
  });
  const terminator = message([field("Unterminated", { kind: "cstring" })], { direction: "in" });
  assert.throws(() => decodeCustom(terminator, Uint8Array.of(0x61)), says("Unterminated: Unterminated string at 0"));

  // And a nested field is still named once, with the whole path, rather than twice.
  const nested = message([field("where", { kind: "nested", fields: [field("x", { kind: "f32" })] })], { direction: "in" });
  assert.throws(() => decodeCustom(nested, Uint8Array.of(1, 2)), says("where.x: Packet underflow at 0: need 4, have 2"));
});

test("a capacity the count byte cannot hold is refused in both directions", () => {
  // `parseCustomMessages` caps both at 255, but a schema written in TypeScript can say 300 and
  // `PacketWriter.u8` masks (`PacketWriter.ts:22`): `array(300, u8)` carrying 300 items encoded to
  // 301 bytes whose count byte read 44, and decoded back to 44 items — 256 of them lost in silence.
  const wide = message([field("slots", { kind: "array", capacity: 300, of: { kind: "u8" } })]);
  assert.throws(() => encodeCustom(wide, { slots: new Array(300).fill(1) }), says("slots: array(300) does not fit the u8 that counts it: 0..255"));
  assert.throws(() => decodeCustom(wide, new Uint8Array(301)), says("slots: array(300) does not fit the u8 that counts it: 0..255"));

  const long = message([field("tag", { kind: "fixedString", size: 300 })]);
  assert.throws(() => encodeCustom(long, { tag: "x" }), says("tag: fixedString(300) does not fit the u8 that counts it: 0..255"));
  assert.throws(() => decodeCustom(long, new Uint8Array(301)), says("tag: fixedString(300) does not fit the u8 that counts it: 0..255"));

  // Decode was the looser of the two the other way as well: without a stride there is no way to
  // step over the slots past the count, and it used to try to read them instead.
  const loose = message([field("texts", { kind: "array", capacity: 2, of: { kind: "string" } })]);
  assert.throws(() => encodeCustom(loose, { texts: [] }), says("texts: an array of a variable-length type has no stride"));
  assert.throws(() => decodeCustom(loose, new Uint8Array(9)), says("texts: an array of a variable-length type has no stride"));
});

test("direction decides which way a message may be translated", () => {
  const inbound = message([field("gold", { kind: "u32" })], { direction: "in" });
  const outbound = message([field("gold", { kind: "u32" })], { direction: "out" });

  assert.throws(() => encodeCustom(inbound, { gold: 1 }), /never encodes it/);
  assert.throws(() => decodeCustom(outbound, Uint8Array.of(1, 0, 0, 0)), /never decodes it/);
  assert.equal(decodeCustom(inbound, Uint8Array.of(1, 0, 0, 0)).value.gold, 1);
  assert.deepEqual([...encodeCustom(outbound, { gold: 1 })], [1, 0, 0, 0]);
});

test("an outbound message too big for the socket is refused at load, naming the field", () => {
  const fits = {
    messages: [{
      name: "mod.Fits",
      opcode: 10,
      direction: "out",
      fields: [{ name: "body", type: "fixedString", size: 200 }],
    }],
  };
  assert.deepEqual(parseCustomMessages(fits).problems, []);
  assert.equal(customMessageSize(parseCustomMessages(fits).messages[0]), 201);

  // 51 arrays of 255 bytes each is 13,056 bytes, and the socket stops at 10,229.
  const fields = Array.from({ length: 51 }, (_, index) => ({
    name: `slot${index}`,
    type: "array",
    capacity: 255,
    of: { type: "u8" },
  }));
  const tooBig = { messages: [{ name: "mod.TooBig", opcode: 11, direction: "out", fields }] };
  const parsed = parseCustomMessages(tooBig);
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.problems.length, 1);
  assert.match(parsed.problems[0], /^mod\.TooBig\.slot39: /);
  assert.match(parsed.problems[0], /CUSTOM_MAX_SEND_BODY/);

  // The same shape is legal inbound: the server may fragment up to its 8 MB quota.
  const inbound = { messages: [{ name: "mod.TooBig", opcode: 11, direction: "in", fields }] };
  assert.deepEqual(parseCustomMessages(inbound).problems, []);
  assert.equal(customMessageSize(parseCustomMessages(inbound).messages[0]), 51 * 256);

  // A `nested` with no fixed size of its own is charged the floor of what it holds, not one byte:
  // 65,281 bytes of array plus a string's four-byte length is unsendable however short the string
  // is, and counting it as 1 let the message load without a word and fail at the first encode.
  const wrapped = {
    messages: [{
      name: "mod.Wrapped",
      opcode: 12,
      direction: "out",
      fields: [{
        name: "wrap",
        type: "nested",
        fields: [
          { name: "big", type: "array", capacity: 255, of: { type: "fixedString", size: 255 } },
          { name: "text", type: "string" },
        ],
      }],
    }],
  };
  const wrappedParse = parseCustomMessages(wrapped);
  assert.deepEqual(wrappedParse.messages, []);
  assert.equal(wrappedParse.problems.length, 1);
  assert.match(wrappedParse.problems[0], /^mod\.Wrapped\.wrap: the message is already 65285 bytes here/);
});

test("an outbound message with nothing to send is refused at load, because the frame would be a kick", () => {
  // `"fields": []` is how "the player pressed Close" wants to be written, and it is the one shape
  // the transport cannot carry: a six-byte frame is `NO_HEADER` on the server and the player is
  // kicked. `buildCustomPacket` refuses it too, but by then the button has been pressed.
  const silent = { messages: [{ name: "mod.Close", opcode: 30, direction: "out", fields: [] }] };
  const parsed = parseCustomMessages(silent);
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.problems.length, 1);
  assert.match(parsed.problems[0], /^mod\.Close: an outbound message with no fields/);
  assert.match(parsed.problems[0], /NO_HEADER/);

  // "both" is an outbound direction too, and so is a message whose only field is an empty `nested`.
  assert.match(parseCustomMessages([{ name: "mod.Close", opcode: 30, fields: [] }]).problems[0], /NO_HEADER/);
  assert.match(
    parseCustomMessages([{ name: "mod.Hollow", opcode: 31, fields: [{ name: "wrap", type: "nested", fields: [] }] }]).problems[0],
    /^mod\.Hollow: an outbound message with no fields/,
  );

  // One byte is enough, and it is exactly what the transport will carry.
  const button = parseCustomMessages([{ name: "mod.Close", opcode: 30, direction: "out", fields: [{ name: "pad", type: "u8" }] }]);
  assert.deepEqual(button.problems, []);
  assert.equal(buildCustomPacket(30, encodeCustom(button.messages[0], { pad: 0 })).byteLength, 7);

  // Inbound is left alone: nothing this client does can send it, so nothing it does can get
  // anybody kicked with it.
  assert.deepEqual(parseCustomMessages([{ name: "mod.Tick", opcode: 32, direction: "in", fields: [] }]).problems, []);
});

test("a body that crosses the socket limit while encoding names the field it crossed at", () => {
  const schema = message([field("head", { kind: "u32" }), field("text", { kind: "string" })], { direction: "out" });
  assert.equal(encodeCustom(schema, { head: 1, text: "x".repeat(CUSTOM_MAX_SEND_BODY - 8) }).byteLength, CUSTOM_MAX_SEND_BODY);
  assert.throws(
    () => encodeCustom(schema, { head: 1, text: "x".repeat(CUSTOM_MAX_SEND_BODY - 7) }),
    (error) => error.message.startsWith("text:") && error.message.includes("10230"),
  );
  // And what does fit is exactly what the transport will carry.
  const body = encodeCustom(schema, { head: 1, text: "x".repeat(CUSTOM_MAX_SEND_BODY - 8) });
  assert.equal(buildCustomPacket(schema.opcode, body).byteLength, CUSTOM_MAX_SEND_BODY + 6);
});

test("a definition file is validated as a whole and reports every problem it has", () => {
  const parsed = parseCustomMessages({
    messages: [
      { name: "mod.Good", opcode: 20, fields: [{ name: "a", type: "u8" }, { name: "b", type: "string" }] },
      { name: "mod.NoOpcode", fields: [] },
      { name: "mod.BadDirection", opcode: 21, direction: "sideways", fields: [] },
      { name: "mod.BadType", opcode: 22, fields: [{ name: "a", type: "u128" }] },
      { name: "mod.Duplicate", opcode: 23, fields: [{ name: "a", type: "u8" }, { name: "a", type: "u8" }] },
      { name: "mod.LooseArray", opcode: 24, fields: [{ name: "a", type: "array", capacity: 2, of: { type: "string" } }] },
      { name: "mod.WideString", opcode: 25, fields: [{ name: "a", type: "fixedString", size: 256 }] },
      { name: "mod.Silent", opcode: 26, direction: "out", fields: [] },
      { name: "mod.Good", opcode: 27, fields: [{ name: "a", type: "u8" }] },
    ],
  });

  assert.deepEqual(parsed.messages.map((entry) => entry.name), ["mod.Good"]);
  assert.deepEqual(parsed.messages[0].direction, "both", "direction defaults to both");
  assert.equal(parsed.problems.length, 8);
  assert.match(parsed.problems[0], /mod\.NoOpcode: "opcode" must be a uint16/);
  assert.match(parsed.problems[1], /mod\.BadDirection: "direction"/);
  assert.match(parsed.problems[2], /mod\.BadType\.a: unknown field type "u128"/);
  assert.match(parsed.problems[3], /mod\.Duplicate\.fields\[1\]: "a" is declared twice/);
  assert.match(parsed.problems[4], /mod\.LooseArray\.a: an array item must have a fixed size/);
  assert.match(parsed.problems[5], /mod\.WideString\.a: fixedString needs a "size" from 1 to 255/);
  assert.match(parsed.problems[6], /mod\.Silent: an outbound message with no fields/);
  assert.match(parsed.problems[7], /mod\.Good: declared twice in one file/);

  // A bare array is accepted too, because that is what a hand-written module file usually is.
  const bare = [{ name: "mod.Bare", opcode: 28, fields: [{ name: "a", type: "u8" }] }];
  assert.deepEqual(parseCustomMessages(bare).messages.map((entry) => entry.name), ["mod.Bare"]);
  assert.deepEqual(parseCustomMessages("nonsense").messages, []);
  assert.match(parseCustomMessages("nonsense").problems[0], /expected/);
});

test("a parsed definition round-trips through the codec it was written for", () => {
  const { messages, problems } = parseCustomMessages({
    messages: [{
      name: "shop.State",
      opcode: 4001,
      direction: "both",
      doc: "What the shop window shows.",
      fields: [
        { name: "gold", type: "u32", doc: "copper, as the server counts it" },
        { name: "title", type: "string" },
        { name: "tag", type: "fixedString", size: 6 },
        { name: "prices", type: "array", capacity: 4, of: { type: "u32" } },
        { name: "seller", type: "nested", fields: [{ name: "entry", type: "u32" }, { name: "rank", type: "i8" }] },
      ],
    }],
  });

  assert.deepEqual(problems, []);
  const schema = messages[0];
  assert.equal(schema.fields[0].doc, "copper, as the server counts it");
  const value = { gold: 123456, title: "Лавка", tag: "shop", prices: [10, 20], seller: { entry: 4, rank: -1 } };
  const encoded = encodeCustom(schema, value);

  assert.equal(encoded.byteLength, 4 + (4 + 10) + 7 + 17 + 5);
  assert.deepEqual(decodeCustom(schema, encoded), { value, remainder: 0 });
});
