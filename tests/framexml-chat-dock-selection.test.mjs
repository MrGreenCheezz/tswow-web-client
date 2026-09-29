// The chat dock keeps the tab the player selected. The 3.3.5 client answers GetChatWindowInfo's
// `shown` from its chat cache, and every stock ChatFrame writes that flag itself from OnShow/OnHide
// (FloatingChatFrame.xml:718, :729). This seam raises UPDATE_CHAT_WINDOWS when the channel list
// stock reads changes (a /join, a /leave, a zone crossing), which the client itself does only when
// chat settings load; with window 1 answering a constant `true`, each of those updates showed
// ChatFrame1 over a selected «Журнал боя» (w2 S-seam residual).

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";

installFakeUiDocument();

let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FRAMEXML_SEAM_BINDINGS, frameXmlGeneralWindowInfo } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CHAT_MSG_CHANNEL } = await import("../dist/code/world/ChatProtocol.js");
const { CHAT_YOU_JOINED_NOTICE, CHAT_YOU_LEFT_NOTICE } = await import("../dist/code/world/ChannelProtocol.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");

const call = (seam, name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
const decoder = new TextDecoder("utf-8");
const pump = () => ({ fire: () => 1, now: () => 1 });

function liveSeam() {
  const world = {
    state: { selfGuid: 0x10n, objects: new Map() }, targetGuid: undefined, chatLog: [], channels: new Map(),
    events: { on: () => () => {} }, casts: new Map(), actionButtons: [], aurasFor: () => [],
    cooldownRemaining: () => 0, cooldownState: () => ({ start: 0, duration: 0, enable: 0 }), names: new Map(),
    creatureTemplates: new Map(), worldStateContext: undefined, mapId: undefined, selfName: "Игрок",
    displayName: () => "",
  };
  return new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined, monotonic: () => 0,
    globalCooldownUntil: () => 0, castSpell: () => {},
  });
}

test("SetChatWindowShown writes window 1's cached SHOWN flag, window 2 keeps its docked answer, attach resets", () => {
  assert.deepEqual(frameXmlGeneralWindowInfo(), ["Общий", 14, 1, 1, 1, 0, true, true, true, false]);
  for (const seam of [liveSeam(), new CannedWorldSeam()]) {
    const kind = seam.constructor.name;
    assert.equal(call(seam, "GetChatWindowInfo", 1)[6], true, `${kind}: «Общий» is shown by default`);
    // ChatFrame1's OnHide, when the dock selects «Журнал боя»: SetChatWindowShown(1, nil).
    assert.deepEqual(call(seam, "SetChatWindowShown", 1, undefined), []);
    assert.equal(call(seam, "GetChatWindowInfo", 1)[6], false, `${kind}: the cache answers what ChatFrame1 wrote`);
    // ChatFrame2's OnShow writes 1; the docked combat tab still answers not shown (its shown branch
    // re-anchors the tab onto its own background, FloatingChatFrame.lua:138-142).
    call(seam, "SetChatWindowShown", 2, 1);
    assert.equal(call(seam, "GetChatWindowInfo", 2)[6], false, `${kind}: window 2 stays not shown`);
    assert.equal(call(seam, "GetChatWindowInfo", 2)[8], 2);
    // Lua truthiness: 0 is true, false and nil are not.
    call(seam, "SetChatWindowShown", 1, 0);
    assert.equal(call(seam, "GetChatWindowInfo", 1)[6], true);
    call(seam, "SetChatWindowShown", 1, false);
    assert.equal(call(seam, "GetChatWindowInfo", 1)[6], false);
    call(seam, "SetChatWindowShown", 11, 1);
    assert.deepEqual(call(seam, "GetChatWindowInfo", 11), [], `${kind}: an unsupported window stays nil`);
    seam.attach(pump());
    assert.equal(call(seam, "GetChatWindowInfo", 1)[6], true, `${kind}: a new load starts from «Общий»`);
    seam.detach();
  }
});

// ---------------------------------------------------------------- stock Lua, from the client's MPQs

let chain;
async function provider() {
  if (!chain) {
    const { clientArchives } = await import("../tools/mpq.mjs");
    chain = await clientArchives(clientDirectory);
  }
  return { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } };
}
after(() => chain?.close?.());

async function boot(seam) {
  const candidate = new FrameXmlBoot({
    provider: await provider(), locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam,
    screen: () => ({ width: 1024, height: 768 }),
  });
  await candidate.load();
  return candidate;
}

function lua(boot, source, results = 1) {
  const chunk = boot.vm.compileFunction(source, "@chat-dock-selection", []);
  try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
}

async function settle() {
  for (let pass = 0; pass < 6; pass++) await new Promise((resolve) => setImmediate(resolve));
}

async function loggedInClient() {
  const packets = [];
  let resume;
  const transport = {
    send() {},
    close() {},
    push(opcode, payload) {
      const packet = { opcode, payload };
      if (resume) { const wake = resume; resume = undefined; wake(packet); } else packets.push(packet);
    },
    read() {
      if (packets.length) return Promise.resolve(packets.shift());
      return new Promise((resolve) => { resume = resolve; });
    },
  };
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(transport);
  await client.loginCharacter(0x1234n);
  await settle();
  return { client, transport };
}

const youJoined = (channel, flags = 0x01, id = 0) => new PacketWriter()
  .u8(CHAT_YOU_JOINED_NOTICE).cString(channel).u8(flags).u32(id).u32(0).toUint8Array();
const youLeft = (channel, id = 0) => new PacketWriter()
  .u8(CHAT_YOU_LEFT_NOTICE).cString(channel).u32(id).u8(0).toUint8Array();
const channelSay = (channel, text) => new PacketWriter()
  .u8(CHAT_MSG_CHANNEL).u32(7).u64(0x99n).u32(0).cString(channel).u64(0n)
  .u32(Buffer.byteLength(text) + 1).cString(text).u8(0).toUint8Array();

/** The dock as the player left it: which frame shows, which is selected, where the combat tab sits. */
const DOCK = `
  local point, relative, relativePoint = ChatFrame2Tab:GetPoint(1)
  return ChatFrame1:IsShown() and 1 or 0, ChatFrame2:IsShown() and 1 or 0,
    FCFDock_GetSelectedWindow(GENERAL_CHAT_DOCK) == ChatFrame2 and 1 or 0, ChatFrame2Tab:IsShown() and 1 or 0,
    point, relative and relative:GetName(), relativePoint`;
const COMBAT_SELECTED = [0, 1, 1, 1, "LEFT", "ChatFrame1Tab", "RIGHT"];

test("with «Журнал боя» selected, /join, a zone crossing and /leave leave it selected, and «Общий» keeps their lines", withClient, async () => {
  const { client, transport } = await loggedInClient();
  const seam = new LiveWorldSeam({
    world: () => client, store: () => undefined, spell: () => undefined, monotonic: () => 0,
    globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const candidate = await boot(seam);
  const general = () => candidate.bridge.getFrame("ChatFrame1").messageFrame.messages.map((line) => line.text);
  const click = (tab) => candidate.bridge.fireScript(candidate.bridge.getFrame(tab), "OnClick", "LeftButton");
  const updates = [];
  const dispatch = candidate.bridge.dispatchEvent.bind(candidate.bridge);
  candidate.bridge.dispatchEvent = (event, ...args) => {
    if (event === "UPDATE_CHAT_WINDOWS") updates.push(event);
    return dispatch(event, ...args);
  };
  try {
    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, youJoined("Общий: Элвиннский лес", 0x18, 1));
    await settle();
    click("ChatFrame2Tab");
    assert.deepEqual(lua(candidate, DOCK, 7), COMBAT_SELECTED, "the click selects «Журнал боя»");
    assert.equal(call(seam, "GetChatWindowInfo", 1)[6], false, "ChatFrame1's OnHide wrote the cache");
    updates.length = 0;

    // A /join: YOU_JOINED raises UPDATE_CHAT_WINDOWS ahead of its notice (a new channel on the list).
    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, youJoined("Мойканал", 0x01));
    await settle();
    transport.push(OPCODES.SMSG_MESSAGECHAT, channelSay("Мойканал", "всем привет"));
    await settle();
    assert.ok(updates.length >= 1, "the join re-reads the channel list");
    assert.deepEqual(lua(candidate, DOCK, 7), COMBAT_SELECTED, "after /join «Журнал боя» is still the one shown");

    // A zone crossing into a shorter zone name: the same id, the list re-read for the new name.
    const before = updates.length;
    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, youJoined("Общий: Даларан", 0x18, 1));
    await settle();
    transport.push(OPCODES.SMSG_MESSAGECHAT, channelSay("Общий: Даларан", "продам руду"));
    await settle();
    assert.ok(updates.length > before, "the zone crossing re-reads the channel list");
    assert.deepEqual(lua(candidate, DOCK, 7), COMBAT_SELECTED, "after a zone crossing too");

    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, youLeft("Мойканал"));
    await settle();
    assert.deepEqual(lua(candidate, DOCK, 7), COMBAT_SELECTED, "and after /leave");

    // Back to «Общий»: everything that arrived meanwhile is there, and the dock is as stock left it.
    click("ChatFrame1Tab");
    assert.deepEqual(lua(candidate, "return ChatFrame1:IsShown() and 1 or 0, ChatFrame2:IsShown() and 1 or 0", 2), [1, 0]);
    assert.equal(call(seam, "GetChatWindowInfo", 1)[6], true, "ChatFrame1's OnShow wrote the cache back");
    const lines = general();
    assert.ok(lines.some((line) => line.endsWith("всем привет")), lines.join("\n"));
    assert.ok(lines.some((line) => line.startsWith("|Hchannel:channel:") && line.endsWith("продам руду")),
      "the shorter zone's line was not swallowed while «Общий» was hidden");
    assert.ok(lines.some((line) => line.includes("Мойканал") && line.startsWith("Вы покинули канал")), lines.join("\n"));
    assert.equal(candidate.vm.errors.length, 0, candidate.vm.errors.join("\n"));
  } finally {
    candidate.close();
    client.close();
  }
});

test("the canned dock: repeated UPDATE_CHAT_WINDOWS keep either selection", withClient, async () => {
  const candidate = await boot(new CannedWorldSeam());
  const click = (tab) => candidate.bridge.fireScript(candidate.bridge.getFrame(tab), "OnClick", "LeftButton");
  try {
    click("ChatFrame2Tab");
    candidate.bridge.dispatchEvent("UPDATE_CHAT_WINDOWS");
    candidate.bridge.dispatchEvent("UPDATE_CHAT_WINDOWS");
    assert.deepEqual(lua(candidate, DOCK, 7), COMBAT_SELECTED);
    click("ChatFrame1Tab");
    candidate.bridge.dispatchEvent("UPDATE_CHAT_WINDOWS");
    assert.deepEqual(lua(candidate, DOCK, 7), [1, 0, 0, 1, "LEFT", "ChatFrame1Tab", "RIGHT"],
      "«Общий» selected: an update leaves ChatFrame2 hidden and its tab beside «Общий»");
    assert.equal(candidate.vm.errors.length, 0, candidate.vm.errors.join("\n"));
  } finally {
    candidate.close();
  }
});
