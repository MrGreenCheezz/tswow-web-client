import assert from "node:assert/strict";
import test from "node:test";

const {
  FRAMEXML_CHAT_TYPE_NAMES,
  FRAMEXML_CHAT_WINDOW_GROUPS,
  FRAMEXML_CHAT_OUTBOUND_TYPES,
  FRAMEXML_SEAM_BINDINGS,
  frameXmlChatEventName,
} = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const {
  CHAT_MSG_CHANNEL,
  CHAT_MSG_GUILD,
  CHAT_MSG_PARTY,
  CHAT_MSG_SAY,
  CHAT_MSG_SYSTEM,
  CHAT_MSG_WHISPER,
  CHAT_MSG_WHISPER_INFORM,
} = await import("../dist/code/world/ChatProtocol.js");
const { EventBus } = await import("../dist/code/world/EventBus.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");

class FakeEvents {
  #listeners = new Map();

  on(name, listener) {
    let listeners = this.#listeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(name, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(name);
    };
  }

  emit(name, payload) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }

  listenerCount(name) {
    return this.#listeners.get(name)?.size ?? 0;
  }
}

function liveFixture(sendChatMessage, chatLog = [], channels = new Map()) {
  const events = new FakeEvents();
  const selfGuid = 0x10n;
  const world = {
    state: { selfGuid, objects: new Map() },
    targetGuid: undefined,
    chatLog,
    channels,
    events,
    casts: new Map(),
    actionButtons: [],
    aurasFor: () => [],
    cooldownRemaining: () => 0,
    cooldownState: () => ({ start: 0, duration: 0, enable: 0 }),
    names: new Map(),
    creatureTemplates: new Map(),
    worldStateContext: undefined,
    mapId: undefined,
    selfName: "Игрок",
    displayName: (guid) => `0x${guid.toString(16).padStart(16, "0")}`,
  };
  const fired = [];
  const pump = {
    fire: (event, ...args) => {
      fired.push([event, ...args]);
      return 1;
    },
    now: () => 100,
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: () => undefined,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
    sendChatMessage,
  });
  return { seam, world, events, fired, pump };
}

function chatMessage(overrides = {}) {
  return {
    type: CHAT_MSG_SAY,
    language: 7,
    senderGuid: 0x1234n,
    senderName: "Alice",
    receiverGuid: 0n,
    receiverName: "",
    channel: "",
    text: "Привет",
    tag: 0,
    achievementId: 0,
    ...overrides,
  };
}

test("WorldClient local chat insertion emits one internal event and preserves the legacy callback", () => {
  const client = Object.create(WorldClient.prototype);
  client.chatLog = [];
  client.events = new EventBus();
  const emitted = [];
  const callback = [];
  client.events.on("CHAT_MESSAGE", (message) => emitted.push(message));
  client.onChatMessage = (message) => callback.push(message);

  const message = chatMessage({ type: CHAT_MSG_SYSTEM, text: "local" });
  client.pushLocalMessage(message);

  assert.deepEqual(emitted, [message]);
  assert.deepEqual(callback, [message]);
  assert.deepEqual(client.chatLog, [message]);
});

test("live chat maps a numeric message to the canonical 12-argument FrameXML event", () => {
  const { seam, events, fired, pump } = liveFixture();
  seam.attach(pump);
  fired.length = 0;

  events.emit("CHAT_MESSAGE", chatMessage());

  assert.deepEqual(fired, [[
    "CHAT_MSG_SAY",
    "Привет", "Alice", "Common", "", "", "", 0, 0, "", 0, 1,
    "0x0000000000001234",
  ]]);
  assert.equal(typeof fired[0][12], "string");
  assert.equal(fired.flat(20).some((value) => typeof value === "bigint"), false);
  seam.detach();
});

test("chat type mapping covers every current stock numeric event and leaves BATTLENET unmapped", () => {
  const required = [
    [0x12, "CHANNEL_JOIN"], [0x13, "CHANNEL_LEAVE"], [0x14, "CHANNEL_LIST"],
    [0x15, "CHANNEL_NOTICE"], [0x16, "CHANNEL_NOTICE_USER"], [0x17, "AFK"],
    [0x18, "DND"], [0x19, "IGNORED"], [0x1a, "SKILL"], [0x1b, "LOOT"],
    [0x1c, "MONEY"], [0x1d, "OPENING"], [0x1e, "TRADESKILLS"], [0x1f, "PET_INFO"],
    [0x20, "COMBAT_MISC_INFO"], [0x21, "COMBAT_XP_GAIN"], [0x22, "COMBAT_HONOR_GAIN"],
    [0x23, "COMBAT_FACTION_CHANGE"], [0x2b, "FILTERED"], [0x2d, "BATTLEGROUND_LEADER"],
    [0x2e, "RESTRICTED"],
  ];
  for (const [code, suffix] of required) assert.equal(frameXmlChatEventName(code), `CHAT_MSG_${suffix}`);
  for (const [code, suffix] of Object.entries(FRAMEXML_CHAT_TYPE_NAMES)) {
    assert.equal(frameXmlChatEventName(Number(code)), `CHAT_MSG_${suffix}`);
  }
  assert.equal(frameXmlChatEventName(0x2f), undefined);
  assert.equal(frameXmlChatEventName(0x32), undefined);
});

test("live channel tuple uses normalized short name, full display string, and 1-based channel number", () => {
  const { seam, events, fired, pump } = liveFixture(undefined, [], new Map([
    ["Общий - Элвиннский лес", { flags: 0, count: 0, members: [] }],
  ]));
  seam.attach(pump);
  fired.length = 0;
  events.emit("CHAT_MESSAGE", chatMessage({
    type: CHAT_MSG_CHANNEL,
    channel: "1. Общий - Элвиннский лес",
    text: "channel",
  }));
  assert.deepEqual(fired, [[
    "CHAT_MSG_CHANNEL",
    "channel", "Alice", "Common", "1. Общий - Элвиннский лес", "", "", 0, 1,
    "Общий", 0, 1, "0x0000000000001234",
  ]]);
  seam.detach();
});

test("whisper inform uses the receiver slot and unknown non-addon chat falls back to neutral SYSTEM", () => {
  const { seam, events, fired, pump } = liveFixture();
  seam.attach(pump);
  fired.length = 0;
  events.emit("CHAT_MESSAGE", chatMessage({
    type: CHAT_MSG_WHISPER_INFORM,
    senderName: "Игрок",
    receiverName: "Alice",
    text: "sent",
  }));
  events.emit("CHAT_MESSAGE", chatMessage({ type: 0x7f, text: "unknown-7f" }));
  events.emit("CHAT_MESSAGE", chatMessage({ type: 0x2f, text: "unknown-bnet" }));

  assert.equal(fired[0][0], "CHAT_MSG_WHISPER_INFORM");
  assert.equal(fired[0][2], "Alice");
  assert.deepEqual(fired.slice(1).map(([event, text, sender, language, channel, target, flags, zone, number, name, unknown, lineId, guid]) => [
    event, text, sender, language, channel, target, flags, zone, number, name, unknown, lineId, guid,
  ]), [
    ["CHAT_MSG_SYSTEM", "unknown-7f", "", "Universal", "", "", "", 0, 0, "", 0, 2, ""],
    ["CHAT_MSG_SYSTEM", "unknown-bnet", "", "Universal", "", "", "", 0, 0, "", 0, 3, ""],
  ]);
  seam.detach();
});

test("live attach replays the newest 128 non-addon chat lines in order without mutating the backlog", () => {
  const backlog = Array.from({ length: 130 }, (_, index) => chatMessage({
    text: `line-${index}`,
    senderGuid: BigInt(index + 1),
  }));
  backlog.push(chatMessage({ language: -1, text: "addon-after-backlog" }));
  const original = [...backlog];
  const { seam, world, fired, pump } = liveFixture(undefined, backlog);

  seam.attach(pump);

  const replay = fired.filter(([event]) => event === "CHAT_MSG_SAY");
  assert.equal(replay.length, 128);
  assert.ok(fired.findIndex(([event]) => event === "UPDATE_CHAT_WINDOWS")
    < fired.findIndex(([event]) => event === "CHAT_MSG_SAY"));
  assert.deepEqual(replay.map(([, text]) => text),
    Array.from({ length: 128 }, (_, index) => `line-${index + 2}`));
  assert.deepEqual(replay.map(([, , , , , , , , , , , lineId]) => lineId),
    Array.from({ length: 128 }, (_, index) => index + 1));
  assert.deepEqual(world.chatLog, original, "replay is read-only");
  seam.detach();
});

test("fresh attach replays again, while detach blocks stale delivery and keeps line IDs local", () => {
  const backlog = [chatMessage({ text: "old-0" }), chatMessage({ text: "old-1" })];
  const { seam, events, fired, pump } = liveFixture(undefined, backlog);

  seam.attach(pump);
  assert.deepEqual(fired.filter(([event]) => event === "CHAT_MSG_SAY").map(([, text]) => text), ["old-0", "old-1"]);
  seam.detach();
  fired.length = 0;
  events.emit("CHAT_MESSAGE", chatMessage({ text: "stale" }));
  assert.deepEqual(fired, []);

  seam.attach(pump);
  const replay = fired.filter(([event]) => event === "CHAT_MSG_SAY");
  assert.deepEqual(replay.map(([, text]) => text), ["old-0", "old-1"]);
  assert.deepEqual(replay.map(([, , , , , , , , , , , lineId]) => lineId), [1, 2]);
  events.emit("CHAT_MESSAGE", chatMessage({ text: "fresh" }));
  assert.equal(fired.at(-1)[1], "fresh");
  assert.equal(fired.at(-1)[11], 3);
  seam.detach();
});

test("live chat has no duplicate subscriptions across detach/reattach and survives a burst", () => {
  const { seam, events, fired, pump } = liveFixture();
  seam.attach(pump);
  fired.length = 0;
  events.emit("CHAT_MESSAGE", chatMessage());
  assert.equal(fired.length, 1);
  assert.equal(events.listenerCount("CHAT_MESSAGE"), 1);

  seam.detach();
  events.emit("CHAT_MESSAGE", chatMessage({ text: "stale" }));
  assert.equal(fired.length, 1);
  assert.equal(events.listenerCount("CHAT_MESSAGE"), 0);

  seam.attach(pump);
  fired.length = 0;
  for (let index = 0; index < 1000; index += 1) {
    events.emit("CHAT_MESSAGE", chatMessage({ text: `line-${index}` }));
  }
  assert.equal(fired.length, 1000);
  assert.equal(fired[0][1], "line-0");
  assert.equal(fired.at(-1)[1], "line-999");
  seam.detach();
});

test("canned seam seeds deterministic SAY and SYSTEM chat exactly once per attach", () => {
  const seam = new CannedWorldSeam();
  const fired = [];
  const pump = {
    now: () => 100,
    fire: (event, ...args) => {
      fired.push([event, ...args]);
      return 1;
    },
  };

  seam.attach(pump);
  const first = fired.filter(([event]) => event.startsWith("CHAT_MSG_"));
  assert.equal(first.length, 2);
  assert.ok(fired.findIndex(([event]) => event === "UPDATE_CHAT_WINDOWS")
    < fired.findIndex(([event]) => event === "CHAT_MSG_SAY"));
  assert.equal(first[0][0], "CHAT_MSG_SAY");
  assert.equal(first[1][0], "CHAT_MSG_SYSTEM");
  assert.equal(first[0].length, 13);
  assert.equal(first[1].length, 13);

  fired.length = 0;
  seam.tick(100);
  assert.equal(fired.filter(([event]) => event.startsWith("CHAT_MSG_")).length, 0,
    "the seeded lines are not repeated by tick");

  fired.length = 0;
  seam.attach(pump);
  assert.equal(fired.filter(([event]) => event.startsWith("CHAT_MSG_")).length, 2);
  seam.detach();
});

test("canned outbound keeps numeric targets channel-only and normalizes channel ids", () => {
  const sent = [];
  const seam = new CannedWorldSeam(undefined, (...args) => sent.push(args));
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

  call("SendChatMessage", "channel", "CHANNEL", 7, 4);
  call("SendChatMessage", "whisper", "WHISPER", 7, "Alice");
  call("SendChatMessage", "numeric whisper", "WHISPER", 7, 1);
  assert.deepEqual(sent, [
    ["channel", FRAMEXML_CHAT_OUTBOUND_TYPES.CHANNEL, 7, "4"],
    ["whisper", FRAMEXML_CHAT_OUTBOUND_TYPES.WHISPER, 7, "Alice"],
  ]);
});

test("chat window bindings configure only the truthful general frame and keep hidden windows safe", () => {
  const channels = new Map([
    ["Общий - Элвиннский лес", { flags: 0, count: 0, members: [] }],
    ["2. Торговля - Элвиннский лес", { flags: 0, count: 0, members: [] }],
  ]);
  const { seam, pump } = liveFixture(undefined, [], channels);
  seam.attach(pump);
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

  assert.deepEqual(call("GetChatWindowMessages", 1), FRAMEXML_CHAT_WINDOW_GROUPS);
  assert.deepEqual(call("GetChatWindowMessages", 2), []);
  assert.deepEqual(call("GetChatWindowChannels", 1), ["Общий", 0, "Торговля", 0]);
  assert.deepEqual(call("GetChatWindowChannels", 2), []);
  assert.deepEqual(call("GetChatWindowInfo", 1), [
    "Общий", 14, 1, 1, 1, 0, true, true, true, false,
  ]);
  assert.deepEqual(call("GetChatWindowInfo", 2), [
    "", 0, 1, 1, 1, 0, false, true, false, false,
  ]);
  assert.deepEqual(call("GetChatWindowInfo", 11), []);
  seam.detach();
});

test("legacy live world doubles without chatLog still attach, while channel changes update once", () => {
  const { seam, world, events, fired, pump } = liveFixture();
  delete world.chatLog;

  assert.doesNotThrow(() => seam.attach(pump));
  assert.equal(events.listenerCount("CHANNEL_CHANGED"), 1);
  fired.length = 0;
  events.emit("CHANNEL_CHANGED", { channel: "Общий" });
  assert.deepEqual(fired, [["UPDATE_CHAT_WINDOWS"]]);

  seam.detach();
  assert.equal(events.listenerCount("CHANNEL_CHANGED"), 0);
  fired.length = 0;
  events.emit("CHANNEL_CHANGED", { channel: "Общий" });
  assert.deepEqual(fired, []);
});

test("SendChatMessage accepts only truthful supported types and rejects overlong UTF-8 text", () => {
  const sent = [];
  const { seam, pump } = liveFixture((...args) => sent.push(args));
  seam.attach(pump);

  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  call("SendChatMessage", "hello", "SAY", 7, "");
  assert.deepEqual(sent, [["hello", FRAMEXML_CHAT_OUTBOUND_TYPES.SAY, 7, ""]]);

  seam.detach();
  const channelFixture = liveFixture((...args) => sent.push(args), [], new Map([
    ["Общий - Элвиннский лес", { flags: 0, count: 0, members: [] }],
    ["2. Торговля - Элвиннский лес", { flags: 0, count: 0, members: [] }],
  ]));
  channelFixture.seam.attach(channelFixture.pump);
  const channelCall = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](channelFixture.seam, args);
  channelCall("SendChatMessage", "channel", "CHANNEL", 7, 2);
  channelCall("SendChatMessage", "whisper", "WHISPER", 7, "Alice");
  // A numeric target is meaningful only for CHANNEL; it must not become a whisper to channel 1.
  channelCall("SendChatMessage", "numeric whisper", "WHISPER", 7, 1);
  channelCall("SendChatMessage", "fractional channel", "CHANNEL", 7, 1.5);
  channelCall("SendChatMessage", "unresolved", "CHANNEL", 7, 3);
  assert.deepEqual(sent.slice(1), [
    ["channel", FRAMEXML_CHAT_OUTBOUND_TYPES.CHANNEL, 7, "2. Торговля - Элвиннский лес"],
    ["whisper", FRAMEXML_CHAT_OUTBOUND_TYPES.WHISPER, 7, "Alice"],
  ]);
  channelFixture.seam.detach();

  const sentBeforeInvalid = sent.length;
  call("SendChatMessage", "ignored", "NOT_A_CHAT_TYPE", 7, "");
  call("SendChatMessage", "ignored", "RAID_LEADER", 7, "");
  call("SendChatMessage", "ignored", "RAID_WARNING", 7, "");
  call("SendChatMessage", "ignored", "BATTLEGROUND", 7, "");
  call("SendChatMessage", "я".repeat(128), "SAY", 7, "");
  assert.equal(sent.length, sentBeforeInvalid,
    "invalid type and 256-byte UTF-8 payload never reach the callback");
  assert.equal(FRAMEXML_CHAT_OUTBOUND_TYPES.RAID_LEADER, undefined);
  assert.equal(FRAMEXML_CHAT_OUTBOUND_TYPES.RAID_WARNING, undefined);
  assert.equal(FRAMEXML_CHAT_OUTBOUND_TYPES.BATTLEGROUND, undefined);

  assert.equal(FRAMEXML_SEAM_BINDINGS.SendChatMessage instanceof Function, true);
  assert.equal(CHAT_MSG_CHANNEL, FRAMEXML_CHAT_OUTBOUND_TYPES.CHANNEL);
  assert.equal(CHAT_MSG_GUILD, FRAMEXML_CHAT_OUTBOUND_TYPES.GUILD);
  assert.equal(CHAT_MSG_PARTY, FRAMEXML_CHAT_OUTBOUND_TYPES.PARTY);
  assert.equal(CHAT_MSG_WHISPER, FRAMEXML_CHAT_OUTBOUND_TYPES.WHISPER);
  assert.equal(CHAT_MSG_SYSTEM, 0);
  seam.detach();
});
