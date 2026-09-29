import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { tswowInstall } from "../tools/paths.mjs";
import { GlueLuaVm } from "../dist/code/browser/glue/GlueLua.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import {
  FRAME_XML_CLIENT_NETWORK_CAPABILITY,
  FrameXmlClientNetworkBridge,
} from "../dist/code/browser/framexml/FrameXmlClientNetwork.js";

let clientNetworkLua;
try {
  clientNetworkLua = await readFile(
    join(tswowInstall(), "bin", "include-addon", "ClientNetwork.lua"), "utf8",
  );
} catch {
  clientNetworkLua = undefined;
}
const withRealClientNetwork = {
  skip: clientNetworkLua ? false : "no TSWoW ClientNetwork.lua on this machine",
};

class FakeCustomPackets {
  sent = [];
  handlers = new Map();

  sendRaw(opcode, body) {
    this.sent.push({ opcode, body: body.slice() });
  }

  on(opcode, handler) {
    const handlers = this.handlers.get(opcode) ?? new Set();
    handlers.add(handler);
    this.handlers.set(opcode, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(opcode);
    };
  }

  emit(opcode, body) {
    for (const handler of [...this.handlers.get(opcode) ?? []]) handler(body, opcode);
  }

  get listenerCount() {
    let count = 0;
    for (const handlers of this.handlers.values()) count += handlers.size;
    return count;
  }
}

function bootNetwork() {
  assert.equal(typeof clientNetworkLua, "string");
  const vm = new GlueLuaVm();
  const packets = new FakeCustomPackets();
  const bridge = new FrameXmlClientNetworkBridge(vm, packets);
  bridge.install();
  const loaded = vm.execute(clientNetworkLua, "@Interface/FrameXML/ClientNetwork.lua");
  assert.equal(loaded.ok, true, loaded.error);
  return { vm, packets, bridge };
}

function doubles(...values) {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat64(index * 8, value, true));
  return bytes;
}

test("a real packet callback publishes one completed addon UI update", withRealClientNetwork, async () => {
  const packets = new FakeCustomPackets();
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "ClientNetwork.lua\nNetworkPanel.lua",
      "interface/framexml/clientnetwork.lua": clientNetworkLua,
      "interface/framexml/networkpanel.lua": `
        NetworkPanel = CreateFrame("Frame", "NetworkPanel")
        NetworkLabel = NetworkPanel:CreateFontString("NetworkLabel")
        OnCustomPacket(65002, function(packet)
          local size = packet:ReadDouble()
          NetworkPanel:SetSize(size, size / 2)
          NetworkLabel:SetText("Received " .. size)
          NetworkLabel:SetPoint("CENTER", NetworkPanel, "CENTER", 0, 0)
        end)
      `,
    }),
    clientNetwork: packets,
    exercise: false,
  });
  try {
    await boot.load();
    const observed = [];
    const unsubscribe = boot.bridge.subscribe(() => {
      observed.push(boot.bridge.getFrame("NetworkLabel")?.text);
    });
    packets.emit(65002, doubles(320));
    unsubscribe();
    assert.deepEqual(observed, ["Received 320"]);
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("the real ClientNetwork.lua sends retail-talent OP40/42 bodies byte-for-byte",
  withRealClientNetwork, () => {
  const { vm, packets, bridge } = bootNetwork();
  try {
    assert.equal(FRAME_XML_CLIENT_NETWORK_CAPABILITY, "tswow-client-network-v1");
    const ran = vm.execute(`
      CreateCustomPacket(40, 0):WriteDouble(0):Send()
      CreateCustomPacket(42, 0):WriteDouble(7):WriteDouble(13):Send()
      local reserved = CreateCustomPacket(90, 12)
      reserved:WriteUInt8(5)
      ReservedPacketSize = reserved:Size()
      reserved:Send()
    `, "@talent-network-outbound");
    assert.equal(ran.ok, true, ran.error);
    assert.deepEqual(packets.sent.slice(0, 2), [
      { opcode: 40, body: doubles(0) },
      { opcode: 42, body: doubles(7, 13) },
    ]);
    assert.equal(vm.getGlobal("ReservedPacketSize"), 12,
      "CreateCustomPacket's size is payload preallocation, as in CustomPacketBase");
    assert.equal(packets.sent[2].body.byteLength, 12);
    assert.equal(packets.sent[2].body[0], 5);
    assert.deepEqual([...packets.sent[2].body.slice(1)], Array(11).fill(0),
      "the browser zeroes native uninitialised reserve bytes before putting them on the wire");
  } finally {
    bridge.close();
    vm.close();
  }
  });

test("all ClientNetwork primitive writes are little-endian and read back through the Lua bridge",
  withRealClientNetwork, () => {
  const { vm, packets, bridge } = bootNetwork();
  try {
    const wrote = vm.execute(`
      CreateCustomPacket(99, 0)
        :WriteUInt8(254):WriteInt8(-2)
        :WriteUInt16(65000):WriteInt16(-1234)
        :WriteUInt32(4000000000):WriteInt32(-123456789)
        :WriteUInt64(123456789):WriteInt64(-123456789)
        :WriteFloat(1.5):WriteDouble(-2.25):WriteString("Привет")
        :Send()
    `, "@client-network-primitives-out");
    assert.equal(wrote.ok, true, wrote.error);
    assert.equal(packets.sent.length, 1);

    const body = packets.sent[0].body;
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    assert.equal(view.getUint8(0), 254);
    assert.equal(view.getInt8(1), -2);
    assert.equal(view.getUint16(2, true), 65000);
    assert.equal(view.getInt16(4, true), -1234);
    assert.equal(view.getUint32(6, true), 4000000000);
    assert.equal(view.getInt32(10, true), -123456789);
    assert.equal(view.getBigUint64(14, true), 123456789n);
    assert.equal(view.getBigInt64(22, true), -123456789n);
    assert.equal(view.getFloat32(30, true), 1.5);
    assert.equal(view.getFloat64(34, true), -2.25);
    const stringBytes = new TextEncoder().encode("Привет");
    assert.equal(view.getUint32(42, true), stringBytes.byteLength);
    assert.deepEqual(body.slice(46), stringBytes);

    const callback = vm.execute(`
      OnCustomPacket(99, function(packet)
        InU8 = packet:ReadUInt8()
        InI8 = packet:ReadInt8()
        InU16 = packet:ReadUInt16()
        InI16 = packet:ReadInt16()
        InU32 = packet:ReadUInt32()
        InI32 = packet:ReadInt32()
        InU64 = _CLIENT_NETWORK(19)
        InI64 = _CLIENT_NETWORK(20)
        InFloat = packet:ReadFloat()
        InDouble = packet:ReadDouble()
        InString = packet:ReadString()
        InSize = packet:Size()
      end)
    `, "@client-network-primitives-in");
    assert.equal(callback.ok, true, callback.error);
    bridge.activateCallbacks();
    packets.emit(99, body);
    assert.equal(vm.getGlobal("InU8"), 254);
    assert.equal(vm.getGlobal("InI8"), -2);
    assert.equal(vm.getGlobal("InU16"), 65000);
    assert.equal(vm.getGlobal("InI16"), -1234);
    assert.equal(vm.getGlobal("InU32"), 4000000000);
    assert.equal(vm.getGlobal("InI32"), -123456789);
    assert.equal(vm.getGlobal("InU64"), 123456789);
    assert.equal(vm.getGlobal("InI64"), -123456789);
    assert.equal(vm.getGlobal("InFloat"), 1.5);
    assert.equal(vm.getGlobal("InDouble"), -2.25);
    assert.equal(vm.getGlobal("InString"), "Привет");
    assert.equal(vm.getGlobal("InSize"), body.byteLength);

    const stringReaders = vm.execute(`
      OnCustomPacket(100, function(packet) LongString = packet:ReadString() end)
      OnCustomPacket(101, function(packet)
        UnderflowString = packet:ReadString()
        UnderflowByte = packet:ReadUInt8()
      end)
    `, "@client-network-string-bounds");
    assert.equal(stringReaders.ok, true, stringReaders.error);
    const longString = new Uint8Array(4 + 65_535);
    new DataView(longString.buffer).setUint32(0, 65_535, true);
    longString.fill("a".charCodeAt(0), 4);
    packets.emit(100, longString);
    assert.equal(vm.getGlobal("LongString").length, 65_535,
      "0xffff is a valid uint32 string length, not an underflow sentinel");
    packets.emit(101, new Uint8Array([7, 8, 9]));
    assert.equal(vm.getGlobal("UnderflowString"), "");
    assert.equal(vm.getGlobal("UnderflowByte"), 7,
      "a missing string length prefix returns empty without advancing the reader");
  } finally {
    bridge.close();
    vm.close();
  }
  });

test("OP41 resets the reader for every Lua callback and close removes the world listener",
  withRealClientNetwork, () => {
  const { vm, packets, bridge } = bootNetwork();
  try {
    const first = vm.execute(`
      CallbackCount = 0
      OnCustomPacket(41, function(packet)
        FirstClass = packet:ReadDouble()
        FirstSpec = packet:ReadDouble()
        FirstCount = packet:ReadDouble()
        FirstTree = packet:ReadDouble()
        FirstNode = packet:ReadDouble()
        FirstRank = packet:ReadDouble()
        CallbackCount = CallbackCount + 1
      end)
    `, "@talent-state-first-listener");
    assert.equal(first.ok, true, first.error);

    // Initial TSAddon registrations happened while the real helper was loading; activation finds
    // those, then wraps OnCustomPacket so registrations made by later/LoD Lua subscribe too.
    bridge.activateCallbacks();
    const second = vm.execute(`
      OnCustomPacket(41, function(packet)
        SecondClass = packet:ReadDouble()
        SecondTree = (packet:ReadDouble() and packet:ReadDouble() and packet:ReadDouble())
        CallbackCount = CallbackCount + 1
      end)
    `, "@talent-state-second-listener");
    assert.equal(second.ok, true, second.error);
    assert.equal(packets.listenerCount, 1, "one raw world listener fans out to both Lua callbacks");

    packets.emit(41, doubles(12, 5, 1, 300, 9, 2));
    assert.equal(vm.getGlobal("CallbackCount"), 2);
    assert.equal(vm.getGlobal("FirstClass"), 12);
    assert.equal(vm.getGlobal("FirstSpec"), 5);
    assert.equal(vm.getGlobal("FirstCount"), 1);
    assert.equal(vm.getGlobal("FirstTree"), 300);
    assert.equal(vm.getGlobal("FirstNode"), 9);
    assert.equal(vm.getGlobal("FirstRank"), 2);
    assert.equal(vm.getGlobal("SecondClass"), 12,
      "RESET_CUSTOM_PACKET rewinds to byte zero before the second callback");
    assert.equal(vm.getGlobal("SecondTree"), 300);

    bridge.close();
    assert.equal(packets.listenerCount, 0);
    packets.emit(41, doubles(99, 0, 0));
    assert.equal(vm.getGlobal("CallbackCount"), 2, "closed FrameXML no longer receives packets");
  } finally {
    bridge.close();
    vm.close();
  }
  });

test("FrameXmlBoot owns the real binding before stubs, activates TSAddon callbacks, and unsubscribes",
  withRealClientNetwork, async () => {
  const packets = new FakeCustomPackets();
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": [
        "## Interface: 30300",
        "GlobalStrings.lua",
        "ClientNetwork.lua",
        "## tsaddon-begin: retail-talents",
        "TSAddons/retail-talents/addon/TalentMessages.lua",
        "## tsaddon-end: retail-talents",
      ].join("\n"),
      "interface/framexml/globalstrings.lua": "ADDON_MISSING = 'missing'",
      "interface/framexml/clientnetwork.lua": clientNetworkLua,
      "interface/framexml/tsaddons/retail-talents/addon/talentmessages.lua": `
        CapabilitySeenByTsAddon = _FRAME_XML_CLIENT_NETWORK_CAPABILITY
        OnCustomPacket(41, function(packet)
          BootInboundClass = packet:ReadDouble()
        end)
        CreateCustomPacket(40, 0):WriteDouble(0):Send()
      `,
    }),
    subset: ["GlobalStrings.lua", "ClientNetwork.lua"],
    includeActiveTsAddons: true,
    exercise: false,
    clientNetwork: packets,
  });
  try {
    assert.equal(packets.listenerCount, 0);
    await boot.load();
    assert.equal(boot.vm.getGlobal("CapabilitySeenByTsAddon"),
      FRAME_XML_CLIENT_NETWORK_CAPABILITY,
      "the binding is installed before the stub floor and before active TSAddon Lua executes");
    assert.deepEqual(packets.sent, [{ opcode: 40, body: doubles(0) }],
      "the helper captured the real transport rather than a generated neutral stub");
    assert.equal(packets.listenerCount, 1,
      "load-time TSAddon callbacks subscribe only after the active corpus has executed");
    packets.emit(41, doubles(12));
    assert.equal(boot.vm.getGlobal("BootInboundClass"), 12);
  } finally {
    boot.close();
  }
  assert.equal(packets.listenerCount, 0, "FrameXmlBoot.close owns transport cleanup");
  });

test("FrameXmlBoot subscribes a TSAddon callback before its top-level send can reply",
  withRealClientNetwork, async () => {
  class ImmediateReplyPackets extends FakeCustomPackets {
    sendRaw(opcode, body) {
      super.sendRaw(opcode, body);
      if (opcode === 40) this.emit(41, doubles(12));
    }
  }

  const packets = new ImmediateReplyPackets();
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": [
        "## Interface: 30300",
        "GlobalStrings.lua",
        "ClientNetwork.lua",
        "## tsaddon-begin: retail-talents",
        "TSAddons/retail-talents/addon/TalentMessages.lua",
        "## tsaddon-end: retail-talents",
      ].join("\n"),
      "interface/framexml/globalstrings.lua": "ADDON_MISSING = 'missing'",
      "interface/framexml/clientnetwork.lua": clientNetworkLua,
      "interface/framexml/tsaddons/retail-talents/addon/talentmessages.lua": `
        OnCustomPacket(41, function(packet)
          EarlyReplyClass = packet:ReadDouble()
        end)
        CreateCustomPacket(40, 0):WriteDouble(0):Send()
        EarlyReplySeenBeforeChunkEnd = EarlyReplyClass
      `,
    }),
    subset: ["GlobalStrings.lua", "ClientNetwork.lua"],
    includeActiveTsAddons: true,
    exercise: false,
    clientNetwork: packets,
  });
  try {
    await boot.load();
    assert.equal(boot.vm.getGlobal("EarlyReplyClass"), 12);
    assert.equal(boot.vm.getGlobal("EarlyReplySeenBeforeChunkEnd"), 12,
      "the exact OP41 listener exists while the TSAddon top-level chunk is still executing");
    assert.deepEqual([...packets.handlers.keys()], [41],
      "early activation subscribes only the opcode registered by Lua, never a wildcard");
  } finally {
    boot.close();
  }
  assert.equal(packets.listenerCount, 0);
  });
