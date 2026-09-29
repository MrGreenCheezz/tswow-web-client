import assert from "node:assert/strict";
import test from "node:test";

// The chat colours. Stock ChatFrame.lua sets every ChatTypeInfo row to white and takes the real
// colours from the client's UPDATE_CHAT_COLOR pass over its chat cache; without it every system,
// whisper and party line was white. The last test is MPQ-backed: the colours only mean something
// when the real ChatFrame.lua writes them into ChatTypeInfo and draws the lines with them.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const {
  FRAMEXML_CHAT_COLOR_EVENT, FRAMEXML_CHAT_DEFAULT_COLORS, FrameXmlChatColors,
} = await import("../dist/code/browser/framexml/FrameXmlChatColors.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_NAMES } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { CHAT_MSG_SYSTEM } = await import("../dist/code/world/ChatProtocol.js");

function recordingPump() {
  const fired = [];
  return { fired, pump: { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 100 } };
}

const colourEvents = (fired) => fired.filter(([event]) => event === FRAMEXML_CHAT_COLOR_EVENT);

test("the default table is the 3.3.5 chat cache's COLORS section, raised in its order as 0..1 channels", () => {
  assert.equal(FRAMEXML_CHAT_DEFAULT_COLORS.length, 72);
  assert.deepEqual(FRAMEXML_CHAT_DEFAULT_COLORS.slice(0, 4), [
    ["SYSTEM", 255, 255, 0], ["SAY", 255, 255, 255], ["PARTY", 170, 170, 255], ["RAID", 255, 127, 0],
  ]);
  const colors = new FrameXmlChatColors();
  const { fired, pump } = recordingPump();
  colors.attach(pump);
  assert.equal(fired.length, 72, "one event per chat cache row and nothing else");
  assert.deepEqual(fired.map(([, type]) => type), FRAMEXML_CHAT_DEFAULT_COLORS.map(([type]) => type));
  assert.deepEqual(fired[0], [FRAMEXML_CHAT_COLOR_EVENT, "SYSTEM", 1, 1, 0]);
  assert.deepEqual(fired.find(([, type]) => type === "WHISPER"), [FRAMEXML_CHAT_COLOR_EVENT, "WHISPER", 1, 128 / 255, 1]);
  assert.deepEqual(fired.find(([, type]) => type === "LOOT"), [FRAMEXML_CHAT_COLOR_EVENT, "LOOT", 0, 170 / 255, 0]);
  assert.deepEqual(colors.color("GUILD"), [64 / 255, 1, 64 / 255]);
  assert.equal(colors.color("REPLY"), undefined, "REPLY has no cache row: stock copies WHISPER into it");
});

test("ChangeChatColor raises the new colour, keeps it across a remount and refuses what the cache has no row for", () => {
  const colors = new FrameXmlChatColors();
  const first = recordingPump();
  colors.attach(first.pump);
  first.fired.length = 0;
  assert.equal(colors.change("party", 1, 0, 0.5), true, "the type is matched as stock upper-cases it");
  assert.deepEqual(first.fired, [[FRAMEXML_CHAT_COLOR_EVENT, "PARTY", 1, 0, 0.5]]);
  assert.equal(colors.change("SYSTEM", 2, -1, 0.25), true);
  assert.deepEqual(first.fired.at(-1), [FRAMEXML_CHAT_COLOR_EVENT, "SYSTEM", 1, 0, 0.25], "channels clamp to 0..1");
  assert.equal(colors.change("NOT_A_TYPE", 1, 1, 1), false);
  assert.equal(colors.change("SAY", Number.NaN, 1, 1), false);
  assert.equal(colors.change("SAY", 1, 1), false);
  assert.equal(first.fired.length, 2, "a refused change raises nothing");
  colors.detach();
  assert.equal(colors.change("GUILD", 0, 0, 1), true, "detached: stored for the next attach, nothing raised");
  assert.equal(first.fired.length, 2);
  // A remount (/reload) reads the cache again: the changed rows come back changed.
  const second = recordingPump();
  colors.attach(second.pump);
  const party = second.fired.find(([, type]) => type === "PARTY");
  assert.deepEqual(party, [FRAMEXML_CHAT_COLOR_EVENT, "PARTY", 1, 0, 0.5]);
  assert.deepEqual(second.fired.find(([, type]) => type === "GUILD"), [FRAMEXML_CHAT_COLOR_EVENT, "GUILD", 0, 0, 1]);
  assert.deepEqual(second.fired.find(([, type]) => type === "RAID"), [FRAMEXML_CHAT_COLOR_EVENT, "RAID", 1, 127 / 255, 0]);
  // The seam binding: one name, owned by the world seam's table.
  assert.ok(FRAMEXML_SEAM_NAMES.includes("ChangeChatColor"));
  second.fired.length = 0;
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.ChangeChatColor({ chatColors: colors }, ["YELL", 0, 1, 0]), []);
  assert.deepEqual(second.fired, [[FRAMEXML_CHAT_COLOR_EVENT, "YELL", 0, 1, 0]]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.ChangeChatColor({}, ["YELL", 0, 1, 0]), [], "a seam with no colours answers nothing");
});

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    const listeners = this.#listeners.get(name) ?? new Set();
    this.#listeners.set(name, listeners);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  emit(name, payload) { for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload); }
}

function liveSeam(chatLog, { selfGuid = 0x10n, realmName } = {}) {
  const world = {
    state: { selfGuid, objects: new Map() }, realmName, targetGuid: undefined, chatLog, channels: new Map(),
    events: new FakeEvents(), casts: new Map(), actionButtons: [], aurasFor: () => [], cooldownRemaining: () => 0,
    cooldownState: () => ({ start: 0, duration: 0, enable: 0 }), names: new Map(), creatureTemplates: new Map(),
    worldStateContext: undefined, mapId: undefined, selfName: "Игрок",
    displayName: (guid) => `0x${guid.toString(16).padStart(16, "0")}`,
  };
  return new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined, monotonic: () => 1000,
    globalCooldownUntil: () => 0, castSpell: () => {}, sendChatMessage: () => {},
  });
}

test("both seams raise the colours at attach, before the first line reaches the chat frames", () => {
  const backlog = [{
    type: CHAT_MSG_SYSTEM, language: 0, senderGuid: 0n, senderName: "", receiverGuid: 0n, receiverName: "",
    channel: "", text: "backlog", tag: 0, achievementId: 0,
  }];
  for (const [name, seam] of [["live", liveSeam(backlog)], ["canned", new CannedWorldSeam()]]) {
    const { fired, pump } = recordingPump();
    seam.attach(pump);
    const colours = colourEvents(fired);
    assert.equal(colours.length, 72, `${name}: the whole table`);
    const firstColour = fired.findIndex(([event]) => event === FRAMEXML_CHAT_COLOR_EVENT);
    const firstLine = fired.findIndex(([event]) => event.startsWith("CHAT_MSG_"));
    assert.ok(firstLine > firstColour + 71, `${name}: every colour precedes the first line (${firstColour}, ${firstLine})`);
    // The seam's own model answers ChangeChatColor through the shared binding.
    fired.length = 0;
    FRAMEXML_SEAM_BINDINGS.ChangeChatColor(seam, ["SYSTEM", 0.5, 0.5, 0.5]);
    assert.deepEqual(fired, [[FRAMEXML_CHAT_COLOR_EVENT, "SYSTEM", 0.5, 0.5, 0.5]], name);
    seam.detach();
  }
});

test("the live /reload builds a new seam: the character's ChangeChatColor comes back, another character's does not", () => {
  const raid = (fired) => colourEvents(fired).find(([, type]) => type === "RAID");
  const first = liveSeam([], { selfGuid: 0x77n, realmName: "Circle" });
  const before = recordingPump();
  first.attach(before.pump);
  FRAMEXML_SEAM_BINDINGS.ChangeChatColor(first, ["raid", 0, 1, 1]);
  first.detach();
  // FrameXmlWorldMount's ReloadUI remount: a fresh LiveWorldSeam over the same character.
  const reloaded = liveSeam([], { selfGuid: 0x77n, realmName: "Circle" });
  const after = recordingPump();
  reloaded.attach(after.pump);
  assert.deepEqual(raid(after.fired), [FRAMEXML_CHAT_COLOR_EVENT, "RAID", 0, 1, 1]);
  assert.deepEqual(colourEvents(after.fired).find(([, type]) => type === "SYSTEM"),
    [FRAMEXML_CHAT_COLOR_EVENT, "SYSTEM", 1, 1, 0], "only the changed row");
  reloaded.detach();
  // The cache is the character's: another character, and the same GUID on another realm, start
  // from the defaults.
  for (const other of [liveSeam([], { selfGuid: 0x78n, realmName: "Circle" }), liveSeam([], { selfGuid: 0x77n, realmName: "Другой" })]) {
    const { fired, pump } = recordingPump();
    other.attach(pump);
    assert.deepEqual(raid(fired), [FRAMEXML_CHAT_COLOR_EVENT, "RAID", 1, 127 / 255, 0]);
    other.detach();
  }
  // A seam with no scope (the canned one) keeps its own: a new one starts from the defaults.
  new FrameXmlChatColors().change("RAID", 0, 0, 1);
  const fresh = recordingPump();
  new FrameXmlChatColors().attach(fresh.pump);
  assert.deepEqual(raid(fresh.fired), [FRAMEXML_CHAT_COLOR_EVENT, "RAID", 1, 127 / 255, 0]);
});

test("MPQ ChatFrame: every ChatTypeInfo row takes the cache colour, lines are drawn in it, and a change recolours", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const seam = new CannedWorldSeam();
  const load = async () => {
    const boot = new FrameXmlBoot({
      provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
      locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, screen: () => ({ width: 1024, height: 768 }),
    });
    await boot.load();
    return boot;
  };
  const lua = (boot, code, results = 1) => {
    const fn = boot.vm.compileFunction(code, "chat-colors", []);
    try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
  };
  const rgb = (boot, type) => lua(boot, `local i = ChatTypeInfo["${type}"] return i.r, i.g, i.b`, 3);
  let boot = await load();
  try {
    assert.equal(boot.vm.errors.length, 0);
    // Every row the cache has, and REPLY through WHISPER (ChatFrame.lua:2524-2531).
    const known = lua(boot, "local n = 0 for _ in pairs(ChatTypeInfo) do n = n + 1 end return n")[0];
    let matched = 0;
    for (const [type, red, green, blue] of FRAMEXML_CHAT_DEFAULT_COLORS) {
      if (lua(boot, `return ChatTypeInfo["${type}"] ~= nil`)[0] !== true) continue;
      assert.deepEqual(rgb(boot, type), [red / 255, green / 255, blue / 255], type);
      matched += 1;
    }
    assert.equal(matched, 69, `69 of the cache's 72 rows are ChatTypeInfo rows (of ${known})`);
    assert.deepEqual(rgb(boot, "REPLY"), [1, 128 / 255, 1]);
    // The canned SYSTEM line was drawn in the cache's yellow, SAY in white.
    const messages = boot.bridge.getFrame("ChatFrame1").messageFrame.messages;
    assert.deepEqual(messages.map(({ color }) => [color.r, color.g, color.b]), [[1, 1, 1], [1, 1, 0]]);
    // A system and a party line from the server now, through the stock handler.
    boot.bridge.dispatchEvent("CHAT_MSG_SYSTEM", "Вы вступили в группу.", "", "", "", "", "", 0, 0, "", 0, 0, "");
    assert.deepEqual(messages.at(-1).color, { r: 1, g: 1, b: 0, a: 1 });
    boot.bridge.dispatchEvent("CHAT_MSG_PARTY", "привет", "Альфа", "всеобщий", "", "", "", 0, 0, "", 0, 7, "");
    assert.deepEqual(messages.at(-1).color, { r: 170 / 255, g: 170 / 255, b: 1, a: 1 });
    // The chat tab's colour menu: ChangeChatColor writes the row, the next party line is red.
    lua(boot, `ChangeChatColor("PARTY", 1, 0, 0)`, 0);
    assert.deepEqual(rgb(boot, "PARTY"), [1, 0, 0]);
    boot.bridge.dispatchEvent("CHAT_MSG_PARTY", "ещё", "Альфа", "всеобщий", "", "", "", 0, 0, "", 0, 8, "");
    assert.deepEqual(messages.at(-1).color, { r: 1, g: 0, b: 0, a: 1 });
    assert.equal(boot.vm.errors.length, 0, JSON.stringify(boot.vm.errors.slice(-2)));
  } finally {
    boot.close();
  }
  // /reload: the same seam re-raises the changed row.
  boot = await load();
  try {
    assert.deepEqual(rgb(boot, "PARTY"), [1, 0, 0]);
    assert.deepEqual(rgb(boot, "SYSTEM"), [1, 1, 0]);
  } finally {
    boot.close();
  }
});
