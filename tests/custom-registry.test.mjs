import assert from "node:assert/strict";
import test from "node:test";
import { CustomPacketRegistry } from "../dist/code/world/CustomPacketRegistry.js";
import { customMessageSize, encodeCustom, parseCustomMessages } from "../dist/code/world/CustomCodec.js";
import { buildCustomPacket } from "../dist/code/world/CustomPacket.js";

const shopState = {
  name: "shop.State",
  opcode: 4001,
  direction: "in",
  fields: [{ name: "gold", type: { kind: "u32" } }, { name: "title", type: { kind: "string" } }],
};
const shopBuy = {
  name: "shop.Buy",
  opcode: 4002,
  direction: "out",
  fields: [{ name: "entry", type: { kind: "u32" } }],
};

/** The bytes a livescript writing that message would leave, built through the codec's own writer. */
const bytesOf = (message, value) => encodeCustom({ ...message, direction: "both" }, value);

function registry(options = {}) {
  const sent = [];
  const problems = [];
  const instance = new CustomPacketRegistry({
    send: (opcode, body) => sent.push({ opcode, bytes: [...body] }),
    onProblem: (problem) => problems.push(problem.text),
    ...options,
  });
  return { instance, sent, problems };
}

test("a defined message decodes into latest, its handlers and its counters", () => {
  const { instance, sent } = registry();
  const result = instance.define([shopState, shopBuy], "shop");
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.defined.map((message) => message.name), ["shop.State", "shop.Buy"]);
  assert.deepEqual(instance.modules(), ["shop"]);

  const seen = [];
  const stop = instance.on("shop.State", (value, message) => seen.push({ value, name: message.name }));
  assert.equal(instance.deliver(4001, bytesOf(shopState, { gold: 12, title: "Лавка" })), true);

  assert.deepEqual(seen, [{ value: { gold: 12, title: "Лавка" }, name: "shop.State" }]);
  assert.deepEqual(instance.latest("shop.State"), { gold: 12, title: "Лавка" });
  const [row] = instance.summary();
  assert.equal(row.opcode, 4001);
  assert.equal(row.name, "shop.State");
  assert.equal(row.module, "shop");
  assert.equal(row.claimed, true);
  assert.equal(row.received, 1);
  assert.equal(row.decoded, 1);
  assert.equal(row.failed, 0);
  // The whole body was declared, so there is no tail — the number that says a schema has fallen
  // behind its livescript.
  assert.equal(row.remainder, 0);
  // Nothing is kept as raw bytes for an opcode that decoded: the value is the record.
  assert.deepEqual(row.samples, []);

  // And the same registry sends by name, through the message's own opcode.
  instance.send("shop.Buy", { entry: 60001 });
  assert.deepEqual(sent, [{ opcode: 4002, bytes: [0x61, 0xea, 0x00, 0x00] }]);
  assert.equal(instance.summary().find((entry) => entry.opcode === 4002)?.sent, 1);

  stop();
  instance.deliver(4001, bytesOf(shopState, { gold: 13, title: "" }));
  assert.equal(seen.length, 1, "the subscription is over");
  // But the value is still recorded: a window binding reads `latest`, not a subscription.
  assert.deepEqual(instance.latest("shop.State"), { gold: 13, title: "" });
});

test("a second module claiming a taken opcode or name is refused, and both modules are named", () => {
  const { instance } = registry();
  instance.define([shopState], "shop");

  const clash = instance.define([
    { ...shopState, name: "bank.State" },
    { ...shopBuy, name: "shop.State", opcode: 4009 },
    { ...shopBuy, name: "bank.Buy", opcode: 4008 },
  ], "bank");

  assert.deepEqual(clash.defined.map((message) => message.name), ["bank.Buy"],
    "the message that clashed with nothing still loads");
  assert.deepEqual(clash.problems, [
    'module "bank": bank.State wants opcode 4001, which module "shop" already claims for shop.State;'
      + " a custom opcode may only be claimed once",
    'module "bank": shop.State is already defined by module "shop", so this copy is ignored',
  ]);
  // The first claim stands: the module that loaded second is not necessarily the one that is wrong,
  // so nothing is taken away from the module that was already working.
  assert.equal(instance.message("shop.State")?.direction, "in");
  assert.equal(instance.messages().length, 2);
  // A refusal at load time is not a packet, so it must not be reported as one.
  assert.deepEqual(instance.problems, []);
});

test("forget takes back one module's messages and leaves the traffic it already saw", () => {
  const { instance } = registry();
  instance.define([shopState], "shop");
  instance.define([{ ...shopBuy, name: "bank.Buy", opcode: 4008 }], "bank");
  const seen = [];
  instance.on("shop.State", (value) => seen.push(value.gold));
  instance.deliver(4001, bytesOf(shopState, { gold: 7, title: "x" }));

  assert.equal(instance.forget("shop"), 1);
  assert.equal(instance.message("shop.State"), undefined);
  assert.equal(instance.latest("shop.State"), undefined);
  assert.deepEqual(instance.modules(), ["bank"]);

  // The counter stays, because it is a fact about the wire rather than about the module — and an
  // opcode that keeps arriving after its module was unloaded is exactly what a hot reload gone
  // wrong looks like. From here it is unclaimed, which is what it is.
  const [row] = instance.summary();
  assert.equal(row.received, 1);
  assert.equal(row.name, undefined);
  assert.equal(row.claimed, false);
  // And the next packet on it is now unclaimed, so the world loop counts it as unhandled.
  assert.equal(instance.deliver(4001, Uint8Array.of(1, 2, 3)), false);

  // A hot reload is `forget` then `define`, and a window that subscribed by name must still be
  // subscribed afterwards: dropping the subscription here would disconnect every window the reload
  // did not happen to rebuild, silently.
  assert.equal(instance.listenerCount, 1, "the subscription belongs to the window, not to the schema");
  instance.define([shopState], "shop");
  instance.deliver(4001, bytesOf(shopState, { gold: 9, title: "x" }));
  assert.deepEqual(seen, [7, 9]);
});

test("an opcode nobody declared is kept as raw bytes, and noise cannot push a module's own out", () => {
  const { instance } = registry();
  instance.define([shopState, shopBuy], "shop");
  instance.deliver(4001, bytesOf(shopState, { gold: 1, title: "" }));
  // Sent and never received, which is the whole of what an "out" message ever does here.
  instance.send("shop.Buy", { entry: 60001 });
  assert.equal(instance.deliver(9001, Uint8Array.of(0xde, 0xad, 0xbe, 0xef)), false);
  assert.equal(instance.deliver(9001, Uint8Array.of(1)), false);

  const [row] = instance.unclaimed();
  assert.equal(row.opcode, 9001);
  assert.equal(row.received, 2);
  assert.equal(row.receivedBytes, 5);
  assert.deepEqual(row.samples, ["deadbeef", "01"]);

  // 64 opcodes at once. The victim is the least recently seen opcode *nobody owns*, so a hundred
  // numbers of noise take each other's places and leave the opcodes this window was opened to watch
  // alone — which plain insertion order would have got exactly backwards, the module's own being
  // the first entry in the map.
  for (let opcode = 1; opcode <= 100; opcode++) instance.deliver(opcode, Uint8Array.of(opcode & 0xff));
  const summary = instance.summary();
  assert.equal(summary.filter((entry) => entry.received || entry.sent).length, 64);
  assert.equal(summary.some((entry) => entry.opcode === 9001), false, "the oldest unowned entry left the ring");
  // By counter and not by presence: a declared message has a row either way, and the counters are
  // the thing the ring can lose. The outbound one is the case that was getting evicted — "can
  // anything decode this" is false for a message this client only sends, and that was the question
  // the ring was asking.
  assert.equal(summary.find((entry) => entry.opcode === 4001)?.received, 1, "the module's own opcode kept its counter");
  assert.equal(summary.find((entry) => entry.opcode === 4002)?.sent, 1, "and so did the one it only sends");
  assert.equal(summary.some((entry) => entry.opcode === 100), true, "and so did the newest");
});

test("a schema that has carried nothing is a row of its own, and revision says when to redraw", () => {
  const { instance } = registry();
  const start = instance.revision;
  instance.define([shopState], "shop");
  assert.equal(instance.revision > start, true, "a schema arrived");

  // Loaded and silent. Until this, «did the client take my file, and on which number» had no
  // answer anywhere on the screen: the row list held only opcodes that had carried something.
  const [row] = instance.summary();
  assert.equal(row.opcode, 4001);
  assert.equal(row.name, "shop.State");
  assert.equal(row.declared, true);
  assert.equal(row.received, 0);
  assert.equal(row.firstSeen, 0, "nothing has been seen, so there is no time to report");

  const quiet = instance.revision;
  assert.deepEqual(instance.summary().length, 1);
  assert.equal(instance.revision, quiet, "reading the summary is not a change to it");
  // Sending is a change too: the counters under the button the player just pressed are the only
  // sign it did anything, and the pane would have kept showing the ones from before the press.
  instance.define([shopBuy], "shop");
  const beforeSend = instance.revision;
  instance.send("shop.Buy", { entry: 60001 });
  assert.equal(instance.revision > beforeSend, true, "a sent message moved a counter");
  const beforePacket = instance.revision;
  instance.deliver(4001, bytesOf(shopState, { gold: 1, title: "" }));
  assert.equal(instance.revision > beforePacket, true, "a packet moved a counter and a value");
  const afterPacket = instance.revision;
  instance.forget("shop");
  assert.equal(instance.revision > afterPacket, true, "and a hot reload takes the schema away");
});

test("a decode that fails names the field, counts, and does not stop the raw subscriber", () => {
  const { instance, problems } = registry();
  instance.define([shopState], "shop");
  const raw = [];
  instance.on(4001, (body) => raw.push([...body]));

  // One byte where the schema wants four and then a string: the shape of a schema that has fallen
  // behind its livescript, which is the ordinary failure here rather than an exotic one.
  assert.equal(instance.deliver(4001, Uint8Array.of(1)), true);

  assert.deepEqual(raw, [[1]], "the module reading its own bytes still gets them");
  assert.deepEqual(problems, ["custom opcode 4001: gold: Packet underflow at 0: need 4, have 1"]);
  const [row] = instance.summary();
  assert.equal(row.failed, 1);
  assert.equal(row.decoded, 0);
  assert.equal(row.error, "gold: Packet underflow at 0: need 4, have 1");
  assert.equal(instance.latest("shop.State"), undefined);
});

test("one subscriber throwing does not silence the next", () => {
  const { instance, problems } = registry();
  instance.define([shopState], "shop");
  const ran = [];
  instance.on("shop.State", () => { ran.push("A"); throw new Error("окно закрыто"); });
  instance.on("shop.State", () => ran.push("B"));
  instance.on(4001, () => { ran.push("C"); throw new Error("сырьё"); });
  instance.on(4001, () => ran.push("D"));

  assert.equal(instance.deliver(4001, bytesOf(shopState, { gold: 1, title: "" })), true);
  assert.deepEqual(ran, ["A", "B", "C", "D"]);
  assert.deepEqual(problems, ["custom opcode 4001: окно закрыто", "custom opcode 4001: сырьё"]);
});

test("a message declared out-only that arrives inbound is named rather than shown as hex", () => {
  const { instance, problems } = registry();
  instance.define([shopBuy], "shop");
  assert.equal(instance.deliver(4002, Uint8Array.of(1, 0, 0, 0)), false);

  assert.deepEqual(problems, ['custom opcode 4002: shop.Buy is declared direction "out" and arrived'
    + ' from the server; change it to "in" or "both" to decode it']);
  const [row] = instance.summary();
  // Named, because the author is holding the schema and would otherwise go looking for a missing
  // one; unclaimed, because nothing here can read it.
  assert.equal(row.name, "shop.Buy");
  assert.equal(row.claimed, false);
  assert.equal(row.failed, 1);
});

test("sending refuses a name nobody defined, and needs a connection at all", () => {
  const { instance } = registry();
  instance.define([shopBuy], "shop");
  assert.throws(() => instance.send("shop.Nothing", {}), /No custom message called "shop.Nothing"/);
  // Declared inbound: the codec refuses to encode it, and says which half of the file is wrong.
  instance.define([shopState], "shop");
  assert.throws(() => instance.send("shop.State", { gold: 1, title: "" }), /declared direction "in"/);

  const offline = new CustomPacketRegistry();
  offline.define([shopBuy], "shop");
  assert.throws(() => offline.send("shop.Buy", { entry: 1 }), /has no connection/);
});

test("clear empties everything and listenerCount comes back to where it started", () => {
  const { instance } = registry();
  assert.equal(instance.listenerCount, 0);
  instance.define([shopState], "shop");
  const stops = [instance.on("shop.State", () => {}), instance.on(4001, () => {})];
  assert.equal(instance.listenerCount, 2);
  for (const stop of stops) stop();
  assert.equal(instance.listenerCount, 0, "an unsubscribed handler leaves no set behind");

  instance.on(4001, () => {});
  instance.deliver(4001, Uint8Array.of(1));
  instance.clear();
  assert.deepEqual(instance.summary(), []);
  assert.deepEqual(instance.messages(), []);
  assert.equal(instance.listenerCount, 0);
});

test("the example file in examples/module-example loads and round-trips", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(new URL("../examples/module-example/messages/example.json", import.meta.url), "utf8"));
  const parsed = parseCustomMessages(raw);
  assert.deepEqual(parsed.problems, [], "the file the owner is told to copy must load without a word");

  const { instance } = registry();
  const result = instance.define(parsed.messages, "example");
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.defined.map((message) => message.name), ["example.Request", "example.State"]);

  // The two numbers the README prints for the request, guarded here rather than in prose: a field
  // added to the example file has to move them, and nothing was watching.
  const request = parsed.messages.find((message) => message.name === "example.Request");
  assert.equal(customMessageSize(request), 8, "one f64 and nothing else");
  const frame = buildCustomPacket(request.opcode, encodeCustom(request, { value: 1.5 }));
  assert.equal(frame.byteLength, 14, "six bytes of header and the body");
  assert.deepEqual([...frame.slice(0, 6)], [0x00, 0x00, 0x01, 0x00, 0xa1, 0x0f],
    "fragment 0 of 1, opcode 0x0FA1 = 4001");

  const state = parsed.messages.find((message) => message.name === "example.State");
  const body = bytesOf(state, {
    gold: 1234, title: "Лавка", guid: 0xdeadbeefcafen, tag: "shop",
    prices: [10, 20, 30], seller: { entry: 60001, friendly: 1 },
  });
  // Measured: 77 bytes for that value, and the reply arrives with nothing left over.
  assert.equal(body.byteLength, 77);
  assert.equal(instance.deliver(4002, body), true);
  assert.equal(instance.latest("example.State").guid, 0xdeadbeefcafen);
  assert.equal(instance.summary().find((row) => row.opcode === 4002).remainder, 0);
});
