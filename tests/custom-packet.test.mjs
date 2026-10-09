import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldConnection } from "../dist/code/world/WorldConnection.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { ByteQueue } from "../dist/code/transport/ByteQueue.js";
import { PacketWriter } from "../dist/code/protocol/index.js";
import {
  buildCustomPacket,
  CUSTOM_BUFFER_QUOTA,
  CUSTOM_HEADER_SIZE,
  CUSTOM_MAX_FRAGMENT_SIZE,
  CUSTOM_MAX_SEND_BODY,
  CUSTOM_MIN_FRAGMENT_SIZE,
  CUSTOM_MIN_SEND_BODY,
  CUSTOM_PACKET_ERROR_CODES,
  CustomPacketReassembler,
  parseCustomFragment,
  readCustomHeader,
} from "../dist/code/world/CustomPacket.js";

/**
 * A fragment written by hand rather than by `buildCustomPacket`, so that the layout the tests
 * assert against comes from `CustomPacketChunk.h:9-15` and not from the code under test.
 */
function fragment(fragmentId, totalFrags, opcode, body) {
  const bytes = new Uint8Array(CUSTOM_HEADER_SIZE + body.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, fragmentId, true);
  view.setUint16(2, totalFrags, true);
  view.setUint16(4, opcode, true);
  bytes.set(Uint8Array.from(body), CUSTOM_HEADER_SIZE);
  return bytes;
}

/** A fragment big enough to pass the server's 25,000-byte floor for a non-final fragment. */
function bigFragment(fragmentId, totalFrags, opcode, fill) {
  const body = new Uint8Array(CUSTOM_MIN_FRAGMENT_SIZE).fill(fill);
  return fragment(fragmentId, totalFrags, opcode, body);
}

test("the six-byte header is fragmentId, totalFrags, opcode, little-endian in that order", () => {
  const built = buildCustomPacket(0x1234, Uint8Array.of(0xaa, 0xbb));

  assert.deepEqual([...built], [0, 0, 1, 0, 0x34, 0x12, 0xaa, 0xbb]);
  assert.deepEqual(readCustomHeader(built), { fragmentId: 0, totalFrags: 1, opcode: 0x1234 });

  // The report's own vector: opcode 7 carrying u32 42, f32 1.5 and the string "hi".
  const body = Uint8Array.of(0x2a, 0, 0, 0, 0, 0, 0xc0, 0x3f, 0x02, 0, 0, 0, 0x68, 0x69);
  assert.deepEqual(
    [...buildCustomPacket(7, body)],
    [0x00, 0x00, 0x01, 0x00, 0x07, 0x00, 0x2a, 0, 0, 0, 0, 0, 0xc0, 0x3f, 0x02, 0, 0, 0, 0x68, 0x69],
  );

  const parsed = parseCustomFragment(fragment(3, 9, 0x51f, [1, 2, 3]));
  assert.deepEqual(parsed.header, { fragmentId: 3, totalFrags: 9, opcode: 0x51f });
  assert.deepEqual([...parsed.body], [1, 2, 3]);
  assert.throws(() => readCustomHeader(Uint8Array.of(1, 2, 3)), RangeError);
});

test("a one-fragment message goes out and comes back the same bytes", () => {
  const body = Uint8Array.from({ length: 200 }, (_, index) => index & 0xff);
  const reassembler = new CustomPacketReassembler();

  const receipt = reassembler.receive(buildCustomPacket(4001, body));

  assert.equal(receipt.kind, "message");
  assert.equal(receipt.opcode, 4001);
  assert.equal(receipt.totalFrags, 1);
  assert.deepEqual([...receipt.body], [...body]);
  assert.equal(reassembler.pendingBytes, 0);
  assert.deepEqual(reassembler.warnings, []);
});

test("10,229 body bytes build and 10,230 are refused by name", () => {
  assert.equal(CUSTOM_MAX_SEND_BODY, 10_229);
  const largest = buildCustomPacket(1, new Uint8Array(CUSTOM_MAX_SEND_BODY));
  assert.equal(largest.byteLength, CUSTOM_MAX_SEND_BODY + CUSTOM_HEADER_SIZE);

  assert.throws(
    () => buildCustomPacket(1, new Uint8Array(CUSTOM_MAX_SEND_BODY + 1)),
    (error) => error instanceof RangeError && error.message.includes("CUSTOM_MAX_SEND_BODY") && error.message.includes("10230"),
  );
  // The largest body still fits through the socket guard that made it 10,229 in the first place.
  const stream = { sent: [], send(bytes) { this.sent.push(bytes); }, readExactly: () => Promise.resolve(new Uint8Array()), close() {} };
  new WorldConnection(stream).send(OPCODES.CMSG_CUSTOM, largest);
  assert.equal(stream.sent[0].byteLength, 6 + CUSTOM_MAX_SEND_BODY + CUSTOM_HEADER_SIZE);
});

test("an empty body is refused, because a frame of nothing but its header is a kick", () => {
  // The lower bound is the same rule the reassembler already applies to what arrives:
  // `ReceivePacket` opens with `if (size <= CustomHeaderSize) return _onError(NO_HEADER, data)`
  // (`CustomPacketBuffer.cpp:24-27`) over `packet.size()`, which is the payload with the four
  // opcode bytes already taken back off (`WorldSession.cpp:1791-1794`, `WorldSocket.cpp:230`), and
  // `_onError` on the server is `KickPlayer("Custom packet error: 1")`. A module message with no
  // fields — a Close button — is exactly the shape that would have produced this frame.
  assert.equal(CUSTOM_MIN_SEND_BODY, 1);
  assert.throws(
    () => buildCustomPacket(4100, new Uint8Array()),
    (error) => error instanceof RangeError && error.message.includes("NO_HEADER") && error.message.includes("empty body"),
  );

  // One byte is enough, and this client's own reassembler agrees about which of the two is refused.
  const smallest = buildCustomPacket(4100, Uint8Array.of(0));
  assert.equal(smallest.byteLength, CUSTOM_HEADER_SIZE + CUSTOM_MIN_SEND_BODY);
  const reassembler = new CustomPacketReassembler();
  assert.equal(reassembler.receive(fragment(0, 1, 4100, [])).error, "NO_HEADER");
  assert.equal(reassembler.receive(smallest).kind, "message");
});

test("the guard on outbound size covers every opcode, not just the custom one", () => {
  const stream = { sent: [], send(bytes) { this.sent.push(bytes); }, readExactly: () => Promise.resolve(new Uint8Array()), close() {} };
  const connection = new WorldConnection(stream);

  // 10,235 payload bytes plus the four opcode bytes is 10,239: the last size `IsValidSize` accepts.
  connection.send(OPCODES.CMSG_UPDATE_ACCOUNT_DATA, new Uint8Array(10_235));
  assert.equal(stream.sent.length, 1);

  assert.throws(
    () => connection.send(OPCODES.CMSG_UPDATE_ACCOUNT_DATA, new Uint8Array(10_236)),
    (error) => error instanceof RangeError && error.message.includes("10240"),
  );
  assert.equal(stream.sent.length, 1, "the oversized packet must not reach the socket");
});

test("all eight of the server's refusals are reproduced, with the numbers it kicks with", () => {
  const seen = [];
  const reassembler = new CustomPacketReassembler({ onWarning: (warning) => seen.push(warning) });

  // 1. NO_HEADER: the header alone is not a fragment, the server wants at least one body byte.
  assert.equal(reassembler.receive(fragment(0, 1, 7, [])).error, "NO_HEADER");
  assert.equal(readCustomHeader(fragment(0, 1, 7, [])).opcode, 7);
  // 2. TOO_BIG_FRAGMENT, checked before anything about the header is believed.
  const huge = fragment(0, 0, 7, new Uint8Array(CUSTOM_MAX_FRAGMENT_SIZE).fill(1));
  assert.equal(reassembler.receive(huge).error, "TOO_BIG_FRAGMENT");
  // 3. INVALID_FRAG_COUNT: zero fragments is not a message.
  assert.equal(reassembler.receive(fragment(0, 0, 7, [1])).error, "INVALID_FRAG_COUNT");
  // 4. INVALID_FIRST_FRAG: a multi-fragment message must open at zero.
  assert.equal(reassembler.receive(bigFragment(1, 3, 7, 1)).error, "INVALID_FIRST_FRAG");
  // 5. TOO_SMALL_FRAGMENT: every non-final fragment is at least 25,000 bytes.
  assert.equal(reassembler.receive(fragment(0, 3, 7, [1, 2, 3])).error, "TOO_SMALL_FRAGMENT");
  // 6. HEADER_MISMATCH: the second fragment disagrees about how many there are.
  assert.equal(reassembler.receive(bigFragment(0, 3, 7, 1)).kind, "fragment");
  assert.equal(reassembler.receive(bigFragment(1, 4, 7, 2)).error, "HEADER_MISMATCH");
  // 7. INVALID_FRAG_ID: fragment ids are strictly consecutive.
  assert.equal(reassembler.receive(bigFragment(0, 3, 7, 1)).kind, "fragment");
  assert.equal(reassembler.receive(bigFragment(2, 3, 7, 3)).error, "INVALID_FRAG_ID");
  // 8. OUT_OF_SPACE: the per-connection quota, shrunk here so the test does not push 8 MB.
  const tight = new CustomPacketReassembler({ quota: 100, minFragmentSize: 10 });
  assert.equal(tight.receive(fragment(0, 3, 7, new Uint8Array(50))).kind, "fragment");
  assert.equal(tight.receive(fragment(1, 3, 7, new Uint8Array(50))).error, "OUT_OF_SPACE");

  assert.deepEqual(seen, [], "a refusal is not a warning");
  assert.deepEqual(
    Object.entries(CUSTOM_PACKET_ERROR_CODES),
    [
      ["NO_HEADER", 0x1], ["HEADER_MISMATCH", 0x2], ["INVALID_FRAG_COUNT", 0x4], ["INVALID_FIRST_FRAG", 0x8],
      ["INVALID_FRAG_ID", 0x10], ["TOO_SMALL_FRAGMENT", 0x20], ["TOO_BIG_FRAGMENT", 0x40], ["OUT_OF_SPACE", 0x80],
    ],
    "these are the numbers TSServerBuffer::OnError puts in the kick message",
  );
  assert.equal(CUSTOM_BUFFER_QUOTA, 8_000_000);
});

test("a refusal throws away everything half-assembled, as _onError does", () => {
  const reassembler = new CustomPacketReassembler();
  assert.equal(reassembler.receive(bigFragment(0, 3, 7, 1)).kind, "fragment");
  assert.equal(reassembler.receive(bigFragment(0, 2, 9, 1)).kind, "fragment");
  assert.equal(reassembler.pendingBytes, CUSTOM_MIN_FRAGMENT_SIZE * 2);
  assert.equal(reassembler.pendingCount, 2);

  assert.equal(reassembler.receive(fragment(0, 0, 7, [1])).error, "INVALID_FRAG_COUNT");

  assert.equal(reassembler.pendingBytes, 0);
  assert.equal(reassembler.pendingCount, 0);
  // Both messages are really gone: fragment 1 of the untouched opcode 9 now opens nothing.
  assert.equal(reassembler.receive(bigFragment(1, 2, 9, 2)).error, "INVALID_FIRST_FRAG");
});

test("two fragments join into exactly their payloads, and say what tswow would read instead", () => {
  const warnings = [];
  const reassembler = new CustomPacketReassembler({ onWarning: (warning) => warnings.push(warning) });
  const head = new Uint8Array(CUSTOM_MIN_FRAGMENT_SIZE).fill(0xa1);
  const tail = Uint8Array.of(0xb1, 0xb2, 0xb3);

  assert.equal(reassembler.receive(fragment(0, 2, 4002, head)).kind, "fragment");
  assert.equal(reassembler.pendingBytes, head.length);
  const receipt = reassembler.receive(fragment(1, 2, 4002, tail));

  assert.equal(receipt.kind, "message");
  assert.equal(receipt.body.byteLength, head.length + tail.length);
  assert.deepEqual([...receipt.body.subarray(0, head.length)], [...head]);
  assert.deepEqual([...receipt.body.subarray(head.length)], [...tail]);
  assert.equal(reassembler.pendingBytes, 0);

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "reader-skew");
  assert.equal(warnings[0].opcode, 4002);
  assert.match(warnings[0].text, /6 junk bytes/);
  assert.deepEqual(reassembler.warnings, warnings);
});

test("a tail that never arrives is dropped on a clock the caller supplies", () => {
  let now = 1_000;
  const warnings = [];
  const reassembler = new CustomPacketReassembler({
    clock: () => now,
    minFragmentSize: 8,
    tailTimeoutMs: 5_000,
    onWarning: (warning) => warnings.push(warning),
  });

  assert.equal(reassembler.receive(fragment(0, 2, 11, new Uint8Array(40))).kind, "fragment");
  now += 4_999;
  reassembler.sweep();
  assert.equal(reassembler.pendingBytes, 40, "still inside the timeout");

  now += 1;
  reassembler.sweep();
  assert.equal(reassembler.pendingBytes, 0);
  assert.equal(warnings.at(-1).kind, "abandoned-tail");
  assert.match(warnings.at(-1).text, /1 of 2 fragments/);
  // Nothing is being held any more, so the tail that finally shows up opens nothing.
  assert.equal(reassembler.receive(fragment(1, 2, 11, new Uint8Array(40))).error, "INVALID_FIRST_FRAG");
});

test("a whole message arriving over a partial replaces it instead of being glued to it", () => {
  const warnings = [];
  const reassembler = new CustomPacketReassembler({ onWarning: (warning) => warnings.push(warning) });
  assert.equal(reassembler.receive(bigFragment(0, 2, 12, 0xcc)).kind, "fragment");

  const receipt = reassembler.receive(fragment(0, 1, 12, [7, 8]));

  assert.equal(receipt.kind, "message");
  assert.deepEqual([...receipt.body], [7, 8], "the partial must not be spliced onto the front");
  assert.equal(reassembler.pendingBytes, 0);
  assert.equal(warnings[0].kind, "replaced-partial");
  assert.equal(warnings[0].bytes, CUSTOM_MIN_FRAGMENT_SIZE);
});

test("the warning list is a ring of thirty-two, and the count behind it keeps going", () => {
  // The diagnostics pane redraws when a number it shows moves, and a transport warning is one of
  // those. Past the thirty-second one the list stops growing and only its contents change, so its
  // length is no longer a change detector — which is the whole reason this counter exists.
  const reassembler = new CustomPacketReassembler({ minFragmentSize: 8 });
  assert.equal(reassembler.warningCount, 0);
  for (let round = 0; round < 40; round++) {
    // A partial, then a whole message on the same opcode: the second replaces the first and warns.
    assert.equal(reassembler.receive(fragment(0, 2, 20, new Uint8Array(8))).kind, "fragment");
    assert.equal(reassembler.receive(fragment(0, 1, 20, [7, 8])).kind, "message");
  }
  assert.equal(reassembler.warnings.length, 32, "the oldest eight left the list");
  assert.equal(reassembler.warningCount, 40, "and the count remembers them");
});

/** A connection that can be fed a packet after `loginCharacter` has returned. */
function fakeConnection(packets) {
  const queue = [...packets];
  let pending;
  return {
    sent: [],
    send(opcode, payload = new Uint8Array()) {
      this.sent.push({ opcode, payload });
    },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { pending = resolve; });
    },
    feed(packet) {
      if (!pending) {
        queue.push(packet);
        return;
      }
      const resolve = pending;
      pending = undefined;
      resolve(packet);
    },
    close() {},
  };
}

const LOGIN_VERIFY = new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(4).toUint8Array();
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a synthetic 0x102 reaches the handler that registered for its custom opcode", async () => {
  const connection = fakeConnection([{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: LOGIN_VERIFY }]);
  const client = new WorldClient(connection);
  await client.loginCharacter(1n);
  await settle();

  const seen = [];
  const stop = client.onCustomPacket(4100, (body, opcode) => seen.push({ bytes: [...body], opcode }));
  connection.feed({ opcode: OPCODES.CMSG_EMOTE, payload: buildCustomPacket(4100, Uint8Array.of(9, 8, 7)) });
  await settle();

  assert.deepEqual(seen, [{ bytes: [9, 8, 7], opcode: 4100 }]);
  assert.equal(client.unhandledOpcodes.entries.has(OPCODES.CMSG_EMOTE), false, "a claimed message is not an unhandled opcode");

  // Nothing listens once the subscription is dropped, and the message is reported instead.
  stop();
  connection.feed({ opcode: OPCODES.CMSG_EMOTE, payload: buildCustomPacket(4100, Uint8Array.of(1)) });
  await settle();
  assert.deepEqual(seen.length, 1);
  assert.equal(client.unhandledOpcodes.entries.get(OPCODES.CMSG_EMOTE)?.count, 1);

  // And the same client can send one back, on CMSG_CUSTOM rather than on 0x102.
  client.sendCustomPacket(4100, Uint8Array.of(5));
  const sent = connection.sent.at(-1);
  assert.equal(sent.opcode, OPCODES.CMSG_CUSTOM);
  assert.deepEqual([...sent.payload], [0, 0, 1, 0, 0x04, 0x10, 5]);
  // But not an empty one: the send path applies the server's NO_HEADER rule too, and nothing
  // reaches the socket when it does.
  assert.throws(() => client.sendCustomPacket(4100, new Uint8Array()), /NO_HEADER/);
  assert.equal(connection.sent.at(-1), sent);
  client.close();
});

test("one module's handler throwing does not silence the next, and the message still counts as claimed", async () => {
  const connection = fakeConnection([{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: LOGIN_VERIFY }]);
  const client = new WorldClient(connection);
  await client.loginCharacter(1n);
  await settle();

  const errors = [];
  client.onPacketError = (opcode, error) => errors.push(`0x${opcode.toString(16)} ${error.message}`);
  const ran = [];
  // A schema that has fallen behind its livescript makes `decodeCustom` throw exactly this, which
  // is why it is the ordinary case rather than an exotic one: М3 builds every handler from JSON.
  client.onCustomPacket(4100, () => {
    ran.push("A");
    throw new RangeError("gold: Packet underflow at 0: need 4, have 1");
  });
  client.onCustomPacket(4100, () => ran.push("B"));

  connection.feed({ opcode: OPCODES.CMSG_EMOTE, payload: buildCustomPacket(4100, Uint8Array.of(1)) });
  await settle();

  assert.deepEqual(ran, ["A", "B"], "the second module's window must still hear its own message");
  assert.deepEqual(errors, ["0x102 custom opcode 4100: gold: Packet underflow at 0: need 4, have 1"]);
  assert.equal(client.unhandledOpcodes.entries.has(OPCODES.CMSG_EMOTE), false,
    "a message that had handlers is not an unplanned opcode, however they ended");
  client.close();
});

test("a custom packet from the login window reaches a handler registered before entry, once (9.03)", async () => {
  // Ordered as the socket would deliver it: the module message lands while `#waitFor` still owns
  // the socket. It used to be filed as a login drop even with a handler waiting for it.
  const connection = fakeConnection([
    { opcode: OPCODES.CMSG_EMOTE, payload: buildCustomPacket(4100, Uint8Array.of(1, 2)) },
    { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: LOGIN_VERIFY },
  ]);
  const client = new WorldClient(connection);
  const seen = [];
  client.onCustomPacket(4100, (body) => seen.push([...body]));

  await client.loginCharacter(1n);
  await settle();

  assert.deepEqual(seen, [[1, 2]]);
  assert.equal(client.unhandledOpcodes.entries.has(OPCODES.CMSG_EMOTE), false);
  assert.equal(client.customPacketBuffer.pendingBytes, 0);
  client.close();
});

test("with an entry backlog, the login-window message and a later one wait for the consumer, in order (9.03)", async () => {
  const connection = fakeConnection([
    { opcode: OPCODES.CMSG_EMOTE, payload: buildCustomPacket(4100, Uint8Array.of(1)) },
    { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: LOGIN_VERIFY },
  ]);
  const client = new WorldClient(connection);
  client.customPackets.beginBacklog({ expect: ["lua"] });
  await client.loginCharacter(1n);
  await settle();
  connection.feed({ opcode: OPCODES.CMSG_EMOTE, payload: buildCustomPacket(4100, Uint8Array.of(2)) });
  await settle();
  assert.equal(client.customPackets.backlog.queued, 2);

  const seen = [];
  client.onCustomPacket(4100, (body) => seen.push(body[0]));
  assert.deepEqual(seen, [], "subscribing does not replay");
  client.customPackets.consumerReady("lua");
  await settle();
  assert.deepEqual(seen, [1, 2]);
  assert.equal(client.unhandledOpcodes.entries.has(OPCODES.CMSG_EMOTE), false);

  // A held message nobody claimed is counted as unhandled once the backlog lets go.
  client.customPackets.beginBacklog({ expect: ["lua"] });
  connection.feed({ opcode: OPCODES.CMSG_EMOTE, payload: buildCustomPacket(4200, Uint8Array.of(3)) });
  await settle();
  assert.equal(client.unhandledOpcodes.entries.has(OPCODES.CMSG_EMOTE), false, "held, not yet unhandled");
  client.customPackets.consumerReady("lua");
  await settle();
  assert.equal(client.unhandledOpcodes.entries.get(OPCODES.CMSG_EMOTE)?.count, 1);
  client.close();
  assert.equal(client.customPackets.backlog.holding, false);
});

test("without a backlog an unclaimed login-window message is counted as unhandled, not as a login drop", async () => {
  const connection = fakeConnection([
    { opcode: OPCODES.CMSG_EMOTE, payload: buildCustomPacket(4100, Uint8Array.of(1, 2)) },
    { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: LOGIN_VERIFY },
  ]);
  const client = new WorldClient(connection);
  await client.loginCharacter(1n);
  await settle();
  const entry = client.unhandledOpcodes.entries.get(OPCODES.CMSG_EMOTE);
  assert.equal(entry?.count, 1);
  assert.equal(entry?.droppedDuringLogin ?? 0, 0);
  assert.equal(client.customPackets.summary().find((row) => row.opcode === 4100)?.received, 1);
  client.close();
});

test("the world connection still frames an ordinary packet the way it always did", async () => {
  const stream = { queue: new ByteQueue(), sent: [], send(bytes) { this.sent.push(bytes); }, readExactly(length) { return Promise.resolve(this.queue.read(length)); }, close() {} };
  const connection = new WorldConnection(stream);
  connection.send(OPCODES.CMSG_CUSTOM, Uint8Array.of(1, 2));
  assert.deepEqual([...stream.sent[0]], [0, 6, 0x1f, 0x05, 0, 0, 1, 2]);
});
