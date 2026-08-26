import assert from "node:assert/strict";
import test from "node:test";
import { PacketReader, PacketWriter } from "../dist/code/protocol/index.js";
import { ByteQueue } from "../dist/code/transport/ByteQueue.js";

test("packet primitives round-trip", () => {
  const bytes = new PacketWriter()
    .u8(0x12)
    .u16(0x3456)
    .u32(0x789abcde)
    .u64(0x0123456789abcdefn)
    .f32(12.5)
    .cString("TSWoW")
    .toUint8Array();
  const reader = new PacketReader(bytes);

  assert.equal(reader.u8(), 0x12);
  assert.equal(reader.u16(), 0x3456);
  assert.equal(reader.u32(), 0x789abcde);
  assert.equal(reader.u64(), 0x0123456789abcdefn);
  assert.equal(reader.f32(), 12.5);
  assert.equal(reader.cString(), "TSWoW");
  reader.assertFinished();
});

test("packed GUID uses the WoW byte mask", () => {
  const guid = 0x3300000000220011n;
  const bytes = new PacketWriter().packedGuid(guid).toUint8Array();

  assert.deepEqual([...bytes], [0x85, 0x11, 0x22, 0x33]);
  const reader = new PacketReader(bytes);
  assert.equal(reader.packedGuid(), guid);
  reader.assertFinished();
});

test("reader rejects truncated and unterminated input", () => {
  assert.throws(() => new PacketReader(Uint8Array.of(1)).u32(), /Packet underflow/);
  assert.throws(() => new PacketReader(Uint8Array.of(65)).cString(), /Unterminated string/);
});

test("byte queue reassembles arbitrarily fragmented TCP data", () => {
  const queue = new ByteQueue();
  queue.push(Uint8Array.of(1, 2));
  queue.push(Uint8Array.of(3));
  queue.push(Uint8Array.of(4, 5, 6));

  assert.deepEqual([...queue.read(4)], [1, 2, 3, 4]);
  assert.equal(queue.length, 2);
  assert.deepEqual([...queue.read(2)], [5, 6]);
});
