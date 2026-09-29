import assert from "node:assert/strict";
import test, { mock } from "node:test";

// The keepalive measures the round trip the stock micro-menu shows (GetNetStats' latency): the
// CMSG_PING sequence comes back on SMSG_PONG, and the next ping carries the measure, as
// `WorldSocket::HandlePing` reads it into `SetLatency`.
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { PacketReader } = await import("../dist/code/protocol/PacketReader.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

function connection() {
  let wake;
  return {
    sent: [],
    packets: [{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array() }],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (this.packets.length) return Promise.resolve(this.packets.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    enqueue(packet) {
      if (wake) {
        const resolve = wake;
        wake = undefined;
        resolve(packet);
      } else this.packets.push(packet);
    },
    close() {},
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const pings = (wire) => wire.sent.filter((packet) => packet.opcode === OPCODES.CMSG_PING).map((packet) => {
  const reader = new PacketReader(packet.payload);
  return [reader.u32(), reader.u32()];
});

test("a pong for the last ping measures the round trip, and the next ping carries it", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const wire = connection();
  const client = new WorldClient(wire);
  try {
    await client.loginCharacter(0x10n);
    client.startPing();
    client.startPing();
    assert.deepEqual(pings(wire), [], "nothing before the first 30 s, and one timer however often it is started");
    mock.timers.tick(29_999);
    assert.deepEqual(pings(wire), []);
    mock.timers.tick(1);
    assert.deepEqual(pings(wire), [[1, 0]], "the first ping knows no latency yet");
    assert.equal(client.latencyMs, undefined);
    wire.enqueue({ opcode: OPCODES.SMSG_PONG, payload: new PacketWriter().u32(7).toUint8Array() });
    await settle();
    assert.equal(client.latencyMs, undefined, "a pong for another sequence measures nothing");
    wire.enqueue({ opcode: OPCODES.SMSG_PONG, payload: new PacketWriter().u32(1).toUint8Array() });
    await settle();
    assert.equal(typeof client.latencyMs, "number");
    assert.ok(client.latencyMs >= 0 && client.latencyMs < 5_000, `a plausible round trip: ${client.latencyMs}`);
    const measured = client.latencyMs;
    mock.timers.tick(30_000);
    assert.deepEqual(pings(wire), [[1, 0], [2, measured]], "the realm hears the measure on the next ping");
    const seam = { netLatency: () => client.latencyMs };
    assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetNetStats(seam, []), [0, 0, measured]);
    assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetNetStats({}, []), [0, 0, 0], "a seam without it answers the neutral zeros");
  } finally {
    client.close();
    mock.timers.reset();
  }
});
