// Wave-2 seam residuals: the combat tab, `/target Name`, channel notices, bare `/afk`, the
// outbound chat language, add-on `print` markup and `GetSpellLink`. Each one closes a gap an
// earlier lane measured and could not fix from its own files (w1 B-seam, D-chat, T-tooltip).

import assert from "node:assert/strict";
import { after } from "node:test";
import test from "node:test";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";

installFakeUiDocument();

let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const {
  FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS, frameXmlChannelNotice,
} = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { installFrameXmlStockChat } = await import("../dist/code/browser/framexml/FrameXmlChatApi.js");
const {
  CHAT_MSG_AFK, CHAT_MSG_CHANNEL, CHAT_MSG_DND, CHAT_MSG_SAY, CHAT_MSG_SYSTEM, languageForRace,
  useLearnedRaceLanguages,
} = await import("../dist/code/world/ChatProtocol.js");
const {
  CHAT_INVITE_NOTICE, CHAT_MODE_CHANGE_NOTICE, CHAT_NOT_MEMBER_NOTICE, CHAT_PLAYER_KICKED_NOTICE,
  CHAT_WRONG_PASSWORD_NOTICE, CHAT_YOU_JOINED_NOTICE, CHAT_YOU_LEFT_NOTICE,
} = await import("../dist/code/world/ChannelProtocol.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { systemLine } = await import("../dist/code/browser/ui/Chat.js");
const { forgetCreationNames, learnCreationNames, raceBaseLanguage } = await import("../dist/code/browser/ui/UnitSnapshot.js");

const call = (seam, name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
const decoder = new TextDecoder("utf-8");

function events() {
  const listeners = new Map();
  return {
    on(name, listener) {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => set.delete(listener);
    },
    emit(name, payload) { for (const listener of [...(listeners.get(name) ?? [])]) listener(payload); },
  };
}

/** A recording world with the fields the seam's unit, chat and spellbook paths read. */
function liveFixture({ objects = [], names = [], templates = [], knownSpells = [], spells = new Map() } = {}) {
  const selfGuid = 0x10n;
  const player = {
    guid: selfGuid, typeId: 4, position: { x: 0, y: 0, z: 0, orientation: 0 },
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 1], [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 80]]),
  };
  const selected = [];
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, player], ...objects.map((object) => [object.guid, object])]) },
    targetGuid: undefined, chatLog: [], channels: new Map(), events: events(), casts: new Map(),
    actionButtons: [], knownSpells, aurasFor: () => [], cooldownRemaining: () => 0,
    cooldownState: () => ({ start: 0, duration: 0, enable: 0 }),
    names: new Map(names), creatureTemplates: new Map(templates), partyStats: new Map(), group: undefined,
    worldStateContext: undefined, mapId: undefined, selfName: "Тестовый",
    displayName: (guid) => `0x${guid.toString(16)}`,
    selectTarget: (guid) => selected.push(guid),
  };
  const fired = [];
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 1 };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => spells.get(id),
    spells: () => spells.values(), monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  return { seam, world, fired, pump, selected };
}

function unit(guid, typeId, position, entry) {
  const fields = new Map();
  if (entry !== undefined) fields.set(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry);
  return { guid, typeId, position: position && { ...position, orientation: 0 }, fields };
}

/** A logged-in WorldClient over a scripted connection; `sent` records every outbound packet. */
async function loggedInClient() {
  const packets = [];
  const sent = [];
  let resume;
  const transport = {
    send(opcode, payload) { sent.push({ opcode, payload }); },
    close() {},
    push(opcode, payload) {
      const packet = { opcode, payload };
      if (resume) {
        const wake = resume;
        resume = undefined;
        wake(packet);
      } else packets.push(packet);
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
  return { client, transport, sent };
}

async function settle() {
  for (let pass = 0; pass < 6; pass++) await new Promise((resolve) => setImmediate(resolve));
}

const youJoined = (channel, flags = 0x01, id = 0) => new PacketWriter()
  .u8(CHAT_YOU_JOINED_NOTICE).cString(channel).u8(flags).u32(id).u32(0).toUint8Array();
const youLeft = (channel, id = 0) => new PacketWriter()
  .u8(CHAT_YOU_LEFT_NOTICE).cString(channel).u32(id).u8(0).toUint8Array();

/** What `buildChatMessage` wrote: type, language, the optional target and the text. */
function readChat(payload) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const type = view.getUint32(0, true);
  const language = view.getUint32(4, true);
  const strings = decoder.decode(payload.subarray(8)).split("\0");
  return { type, language, strings: strings.slice(0, -1) };
}

// ---------------------------------------------------------------- S1 the combat log tab

test("chat window 2 is the docked «Журнал боя» tab, with no stock groups or channels of its own", () => {
  const { seam } = liveFixture();
  const combat = ["Журнал боя", 14, 1, 1, 1, 0, false, true, 2, false];
  assert.deepEqual(seam.chatWindowInfo(2), combat, "locked, docked in slot 2 and not shown: the dock shows it");
  assert.deepEqual(call(seam, "GetChatWindowInfo", 2), combat);
  assert.deepEqual(seam.chatWindowMessages(2), [], "the native combat mirror is the only source");
  assert.deepEqual(seam.chatWindowChannels(2), []);
  assert.deepEqual(new CannedWorldSeam().chatWindowInfo(2), combat, "the canned seam docks the same tab");
  assert.equal(new LiveWorldSeam({ world: () => undefined, locale: "enUS", store: () => undefined,
    spell: () => undefined, monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {} })
    .chatWindowInfo(2)[0], "Combat Log", "an enUS client names it as its own chat-cache does");
  assert.equal(seam.chatWindowInfo(3)[6], false, "windows 3..10 stay closed");
});

// ---------------------------------------------------------------- S2 /target Name

test("TargetUnit falls back to the nearest visible unit of that name, whole names first", () => {
  const near = unit(0x21n, 3, { x: 5, y: 0, z: 0 }, 299);
  const far = unit(0x22n, 3, { x: 40, y: 0, z: 0 }, 299);
  const prefixOnly = unit(0x23n, 3, { x: 1, y: 0, z: 0 }, 300);
  const player = unit(0x24n, 4, { x: 30, y: 0, z: 0 });
  const nowhere = unit(0x25n, 3, undefined, 299);
  const { seam, selected } = liveFixture({
    objects: [far, near, prefixOnly, player, nowhere],
    names: [[0x24n, "Боб"]],
    templates: [[299, { found: true, name: "Волк" }], [300, { found: true, name: "Волкодав" }]],
  });

  call(seam, "TargetUnit", "Волк");
  assert.deepEqual(selected, [0x21n], "the nearer of two wolves, not the closer «Волкодав» prefix match");
  call(seam, "TargetUnit", "ВОЛКОД");
  assert.deepEqual(selected.at(-1), 0x23n, "a partial name, case-insensitive, as /target passes it");
  selected.length = 0;
  call(seam, "TargetUnit", "Волкод", 1);
  assert.deepEqual(selected, [], "/targetexact (TargetUnit(name, 1)) takes whole names only");
  call(seam, "TargetUnit", "боб");
  assert.deepEqual(selected, [0x24n], "players by their queried name");
  call(seam, "TargetUnit", "тестовый");
  assert.deepEqual(selected.at(-1), 0x10n, "the player's own name selects the player");
  selected.length = 0;
  call(seam, "TargetUnit", "focus");
  call(seam, "TargetUnit", "party1target");
  call(seam, "TargetUnit", "Никто");
  assert.deepEqual(selected, [], "an absent unit token is not a name, and an unknown name selects nothing");
  call(seam, "TargetUnit", "player");
  assert.deepEqual(selected, [0x10n], "unit tokens still resolve first");
});

// ---------------------------------------------------------------- S3 channels

test("SMSG_CHANNEL_NOTIFY: joining adds the channel, the line carries the notify, leaving removes it after", async () => {
  const { client, transport } = await loggedInClient();
  const order = [];
  client.events.on("CHAT_MESSAGE", (message) => order.push(["line", message.channelNotice?.code,
    client.channels.has("Мойканал")]));
  client.events.on("CHANNEL_CHANGED", ({ channel }) => order.push(["changed", channel, client.channels.has(channel)]));
  try {
    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, youJoined("Мойканал", 0x01));
    await settle();
    assert.deepEqual([...client.channels.keys()], ["Мойканал"],
      "a /join-ed custom channel is a channel before any roster or count packet");
    assert.deepEqual(client.channels.get("Мойканал"), { flags: 0x01, count: 0, members: [] });
    const joined = client.chatLog.at(-1);
    assert.equal(joined.type, CHAT_MSG_SYSTEM);
    assert.equal(joined.text, "[Мойканал] Вы вошли в канал", "the native chat keeps its sentence");
    assert.equal(joined.local, true);
    assert.equal(joined.channelNotice.code, CHAT_YOU_JOINED_NOTICE);

    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, youLeft("Мойканал"));
    await settle();
    assert.equal(client.channels.size, 0);
    assert.deepEqual(order, [
      ["line", CHAT_YOU_JOINED_NOTICE, true], ["changed", "Мойканал", true],
      ["line", CHAT_YOU_LEFT_NOTICE, true], ["changed", "Мойканал", false],
    ], "the leave line is written while the channel still has its number");
  } finally {
    client.close();
  }
});

test("channel notices reach stock as CHAT_MSG_CHANNEL_NOTICE with the client's argument layout", () => {
  const { seam, world, fired, pump } = liveFixture({ names: [[0x77n, "Злодей"], [0x78n, "Модератор"]] });
  world.channels.set("Общий - Элвиннский лес", { flags: 0x18, count: 3, members: [] });
  seam.attach(pump);
  const notice = (code, channel, extra = {}) => ({
    type: CHAT_MSG_SYSTEM, language: 0, senderGuid: 0n, senderName: "", receiverGuid: 0n, receiverName: "",
    channel: "", text: `native ${code}`, tag: 0, achievementId: 0, local: true,
    channelNotice: {
      code, channel, guid: 0n, actorGuid: 0n, name: "", channelFlags: 0, channelId: 0,
      constantChannel: false, oldMemberFlags: 0, newMemberFlags: 0, ...extra,
    },
  });
  try {
    fired.length = 0;
    world.channels.set("Мойканал", { flags: 0x01, count: 0, members: [] });
    world.events.emit("CHAT_MESSAGE", notice(CHAT_YOU_JOINED_NOTICE, "Мойканал", { channelFlags: 0x01 }));
    assert.deepEqual(fired, [
      [FRAMEXML_SEAM_EVENTS.chatWindowsUpdated],
      ["CHAT_MSG_CHANNEL_NOTICE", "YOU_JOINED", "", "", "2. Мойканал", "", "", 0, 2, "Мойканал", 0, 1, ""],
    ], "UPDATE_CHAT_WINDOWS first, so ChatFrame's channel list has it when its own notice is filtered");

    fired.length = 0;
    world.events.emit("CHAT_MESSAGE", notice(CHAT_PLAYER_KICKED_NOTICE, "Мойканал", { guid: 0x77n, actorGuid: 0x78n }));
    world.events.emit("CHAT_MESSAGE", notice(CHAT_MODE_CHANGE_NOTICE, "Мойканал",
      { guid: 0x77n, oldMemberFlags: 0, newMemberFlags: 0x02 }));
    world.events.emit("CHAT_MESSAGE", notice(CHAT_INVITE_NOTICE, "Чужой", { guid: 0x77n }));
    world.events.emit("CHAT_MESSAGE", notice(CHAT_YOU_LEFT_NOTICE, "Общий - Элвиннский лес", { channelId: 1 }));
    assert.deepEqual(fired.map((args) => args.slice(0, 10)), [
      ["CHAT_MSG_CHANNEL_NOTICE_USER", "PLAYER_KICKED", "Злодей", "", "2. Мойканал", "Модератор", "", 0, 2, "Мойканал"],
      ["CHAT_MSG_CHANNEL_NOTICE_USER", "SET_MODERATOR", "Злодей", "", "2. Мойканал", "", "", 0, 2, "Мойканал"],
      ["CHAT_MSG_CHANNEL_NOTICE_USER", "INVITE", "Злодей", "", "Чужой", "", "", 0, 0, "Чужой"],
      ["CHAT_MSG_CHANNEL_NOTICE", "YOU_LEFT", "", "", "1. Общий - Элвиннский лес", "", "", 1, 1, "Общий"],
    ]);

    // Stock swallows a notice about a channel it has not listed (ChatFrame.lua:2697-2724), so one
    // the player is not in keeps the native sentence; so does a code stock has no string for.
    fired.length = 0;
    world.events.emit("CHAT_MESSAGE", notice(CHAT_WRONG_PASSWORD_NOTICE, "Закрытый"));
    world.events.emit("CHAT_MESSAGE", notice(0x21, "Мойканал"));
    assert.deepEqual(fired.map(([event, text]) => [event, text]), [
      ["CHAT_MSG_SYSTEM", `native ${CHAT_WRONG_PASSWORD_NOTICE}`],
      ["CHAT_MSG_SYSTEM", "native 33"],
    ]);
  } finally {
    seam.detach();
  }
  assert.equal(frameXmlChannelNotice(CHAT_NOT_MEMBER_NOTICE).token, "NOT_MEMBER");
  assert.deepEqual(frameXmlChannelNotice(0x00), { event: "CHAT_MSG_CHANNEL_JOIN", token: "" });
  assert.equal(frameXmlChannelNotice(CHAT_MODE_CHANGE_NOTICE, 0x02, 0).token, "UNSET_MODERATOR");
  assert.equal(frameXmlChannelNotice(CHAT_MODE_CHANGE_NOTICE, 0, 0x08).token, "UNSET_VOICE");
  assert.equal(frameXmlChannelNotice(CHAT_MODE_CHANGE_NOTICE, 0x01, 0), undefined,
    "an owner bit alone is OWNER_CHANGED's to say");
});

const memberCount = (channel, count) => new PacketWriter().cString(channel).u8(0x18).u32(count).toUint8Array();
const channelSay = (channel, text) => new PacketWriter()
  .u8(CHAT_MSG_CHANNEL).u32(7).u64(0x99n).u32(0).cString(channel).u64(0n)
  .u32(Buffer.byteLength(text) + 1).cString(text).u8(0).toUint8Array();

/** A real WorldClient under a LiveWorldSeam that records what it raises and sends. */
async function liveChannelSeam() {
  const { client, transport, sent } = await loggedInClient();
  const seam = new LiveWorldSeam({
    world: () => client, store: () => undefined, spell: () => undefined, monotonic: () => 0,
    globalCooldownUntil: () => 0, castSpell: () => {},
    sendChatMessage: (text, type, language, target) => client.sendChat(type, text, target, language),
  });
  const fired = [];
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 1 });
  return { client, transport, sent, seam, fired };
}

test("a zone channel is swapped in its slot: one entry, the same number, /1 to the new zone, YOU_CHANGED", async () => {
  // TrinityCore changes zone: YOU_JOINED for the next zone's channel under the same ChatChannels
  // id, and no YOU_LEFT for the old one (Player::UpdateLocalChannels, `sendRemove = false`).
  const { client, transport, sent, seam, fired } = await liveChannelSeam();
  try {
    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, youJoined("Общий: Элвиннский лес", 0x18, 1));
    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, youJoined("Оборона: Элвиннский лес", 0x18, 22));
    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, youJoined("Мойканал", 0x01));
    await settle();
    assert.deepEqual(seam.chatWindowChannels(1),
      ["Общий: Элвиннский лес", 1, "Оборона: Элвиннский лес", 22, "Мойканал", 0],
      "stock's zoneChannelList gets each built-in channel's id");

    fired.length = 0;
    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, youJoined("Общий: Западный край", 0x18, 1));
    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, youJoined("Оборона: Западный край", 0x18, 22));
    await settle();
    assert.deepEqual([...client.channels.keys()], ["Общий: Западный край", "Оборона: Западный край", "Мойканал"],
      "each replaced where it stood, so the channels keep their numbers");
    assert.deepEqual(client.channels.get("Общий: Западный край"), { flags: 0x18, count: 0, members: [], channelId: 1 });
    assert.deepEqual(client.chatLog.slice(-2).map((line) => line.channelNotice.replacedChannel),
      ["Общий: Элвиннский лес", "Оборона: Элвиннский лес"]);
    assert.deepEqual(fired.map((args) => args.slice(0, 10)), [
      ["UPDATE_CHAT_WINDOWS"],
      ["CHAT_MSG_CHANNEL_NOTICE", "YOU_CHANGED", "", "", "1. Общий: Западный край", "", "", 1, 1, "Общий: Западный край"],
      ["UPDATE_CHAT_WINDOWS"],
      ["CHAT_MSG_CHANNEL_NOTICE", "YOU_CHANGED", "", "", "2. Оборона: Западный край", "", "", 22, 2,
        "Оборона: Западный край"],
    ], "the new name is on stock's list before its notice, once; CHANNEL_CHANGED adds no second update");

    sent.length = 0;
    call(seam, "SendChatMessage", "привет", "CHANNEL", undefined, 1);
    const [line] = sent.filter((packet) => packet.opcode === OPCODES.CMSG_MESSAGECHAT).map((packet) => readChat(packet.payload));
    assert.deepEqual(line.strings, ["Общий: Западный край", "привет"], "/1 is the zone the player is in");
    assert.deepEqual(call(seam, "GetChatWindowChannels", 1),
      ["Общий: Западный край", 1, "Оборона: Западный край", 22, "Мойканал", 0], "no zone listed twice");

    fired.length = 0;
    transport.push(OPCODES.SMSG_CHANNEL_MEMBER_COUNT, memberCount("Общий: Западный край", 40));
    transport.push(OPCODES.SMSG_MESSAGECHAT, channelSay("Общий: Западный край", "кто в рейд"));
    await settle();
    assert.deepEqual(fired.map((args) => [args[0], args[1], args[4], args[7], args[8]]), [
      ["CHAT_MSG_CHANNEL", "кто в рейд", "1. Общий: Западный край", 1, 1],
    ], "a member count raises no UPDATE_CHAT_WINDOWS; a line carries the channel's id in arg7");
  } finally {
    seam.detach();
    client.close();
  }
});

test("a zone swap whose short name stays the same re-reads nothing; a stale roster keeps the id", async () => {
  const { client, transport, seam, fired } = await liveChannelSeam();
  try {
    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, youJoined("General - Elwynn Forest", 0x18, 1));
    await settle();
    fired.length = 0;
    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, youJoined("General - Westfall", 0x18, 1));
    await settle();
    assert.deepEqual(fired.map((args) => args.slice(0, 10)), [
      ["CHAT_MSG_CHANNEL_NOTICE", "YOU_CHANGED", "", "", "1. General - Westfall", "", "", 1, 1, "General"],
    ], "«General» is still what stock lists: no update, so a selected «Журнал боя» stays on top");
    // A join for a channel first seen through a count takes the id; a roster after it keeps it.
    transport.push(OPCODES.SMSG_CHANNEL_MEMBER_COUNT, memberCount("Trade - City", 3));
    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, youJoined("Trade - City", 0x3b, 2));
    transport.push(OPCODES.SMSG_CHANNEL_LIST, new PacketWriter().u8(1).cString("Trade - City").u8(0x3b).u32(0)
      .toUint8Array());
    await settle();
    assert.deepEqual([...client.channels].map(([name, held]) => [name, held.channelId]),
      [["General - Westfall", 1], ["Trade - City", 2]]);
  } finally {
    seam.detach();
    client.close();
  }
});

test("a line is numbered by its channel's exact name before a short-name match", () => {
  // Two held channels that shorten alike: a custom «General» /join-ed beside the zone's General.
  const { seam, world, fired, pump } = liveFixture();
  world.channels.set("General", { flags: 0x01, count: 1, members: [] });
  world.channels.set("General - Westfall", { flags: 0x18, count: 9, members: [], channelId: 1 });
  seam.attach(pump);
  try {
    fired.length = 0;
    world.events.emit("CHAT_MESSAGE", {
      type: CHAT_MSG_CHANNEL, language: 7, senderGuid: 0x99n, senderName: "Боб", receiverGuid: 0n,
      receiverName: "", channel: "General - Westfall", text: "всем", tag: 0, achievementId: 0,
    });
    assert.deepEqual(fired.map((args) => [args[0], args[4], args[7], args[8], args[9]]),
      [["CHAT_MSG_CHANNEL", "2. General - Westfall", 1, 2, "General"]]);
  } finally {
    seam.detach();
  }
});

// ---------------------------------------------------------------- S4 bare /afk, the language

test("sendChat sends a bare AFK or DND, drops other empty lines and takes the chosen language", async () => {
  const { client, sent } = await loggedInClient();
  try {
    sent.length = 0;
    client.sendChat(CHAT_MSG_AFK, "");
    client.sendChat(CHAT_MSG_DND, "");
    client.sendChat(CHAT_MSG_SAY, "");
    client.sendChat(CHAT_MSG_SAY, "привет", "", 7);
    client.sendChat(CHAT_MSG_SAY, "привет", "", 0);
    client.sendChat(CHAT_MSG_CHANNEL, "в канал", "Мойканал", 1);
    const chats = sent.filter((packet) => packet.opcode === OPCODES.CMSG_MESSAGECHAT).map((packet) => readChat(packet.payload));
    const racial = client.chatLanguage;
    assert.deepEqual(chats, [
      { type: CHAT_MSG_AFK, language: racial, strings: [""] },
      { type: CHAT_MSG_DND, language: racial, strings: [""] },
      { type: CHAT_MSG_SAY, language: 7, strings: ["привет"] },
      { type: CHAT_MSG_SAY, language: racial, strings: ["привет"] },
      { type: CHAT_MSG_CHANNEL, language: 1, strings: ["Мойканал", "в канал"] },
    ], "an empty SAY never goes out; 0 (Universal) falls back to the racial default");
  } finally {
    client.close();
  }
});

test("languageForRace takes the dataset's learned BaseLanguage over the compiled split", () => {
  forgetCreationNames();
  assert.equal(languageForRace(12), 1, "a TSWoW race was Orcish while nothing was learned");
  try {
    // Chat.ts registered UnitSnapshot's table at import; `/dbc/character-creation` says 7.
    learnCreationNames([{ id: 12, name: "Высший эльф", baseLanguage: 7 }, { id: 2, name: "Орк", baseLanguage: 1 }], []);
    assert.equal(languageForRace(12), 7);
    assert.equal(languageForRace(2), 1);
    assert.equal(languageForRace(1), 7, "an unlearned stock race keeps its compiled answer");
    useLearnedRaceLanguages(() => 0);
    assert.equal(languageForRace(12), 1, "a zero is not a language");
  } finally {
    forgetCreationNames();
    useLearnedRaceLanguages(raceBaseLanguage);
  }
});

// ---------------------------------------------------------------- S5 add-on print markup

test("systemLine keeps an add-on's markup and escapes the client's own prose", () => {
  const pushed = [];
  const previous = game.world;
  game.world = { pushLocalMessage: (message, options) => pushed.push([message.text, options]) };
  try {
    systemLine("|cffff0000red|r|nnext", { markup: true });
    systemLine("/vehicle enter|leave|next");
  } finally {
    game.world = previous;
  }
  assert.deepEqual(pushed, [
    ["|cffff0000red|r|nnext", { markup: true }],
    ["/vehicle enter|leave|next", undefined],
  ]);
});

// ---------------------------------------------------------------- S6 GetSpellLink

test("GetSpellLink answers the stock spell hyperlink for a book slot, an id or a known name", () => {
  const spells = new Map([
    [133, { id: 133, name: "Огненный шар", rank: "Уровень 1", spellLevel: 1 }],
    [143, { id: 143, name: "Огненный шар", rank: "Уровень 2", spellLevel: 6 }],
    [6673, { id: 6673, name: "Боевой крик", rank: "Уровень 1", spellLevel: 1 }],
  ]);
  const { seam } = liveFixture({ spells, knownSpells: [{ id: 133, slot: 0 }, { id: 143, slot: 1 }] });
  assert.deepEqual(call(seam, "GetSpellLink", 2, "spell"), ["|cff71d5ff|Hspell:143|h[Огненный шар]|h|r"]);
  assert.deepEqual(call(seam, "GetSpellLink", 6673), ["|cff71d5ff|Hspell:6673|h[Боевой крик]|h|r"],
    "any cached spell by id, as a chat link would name it");
  assert.deepEqual(call(seam, "GetSpellLink", "огненный шар"), ["|cff71d5ff|Hspell:143|h[Огненный шар]|h|r"],
    "a name is the highest rank in the book");
  assert.deepEqual(call(seam, "GetSpellLink", "Боевой крик"), [], "a name outside the book is nil");
  assert.deepEqual(call(seam, "GetSpellLink", 1, "pet"), [], "no pet book is modelled");
  assert.deepEqual(call(seam, "GetSpellLink", 9, "spell"), []);
  assert.deepEqual(call(seam, "GetSpellLink", 999_999), [], "a row that has not arrived is nil");

  const canned = new CannedWorldSeam();
  const [first] = call(canned, "GetSpellLink", 1, "spell");
  assert.match(first, /^\|cff71d5ff\|Hspell:\d+\|h\[[^\]]+\]\|h\|r$/);
  const id = Number(/Hspell:(\d+)/.exec(first)[1]);
  assert.deepEqual(call(canned, "GetSpellLink", id), [first]);
});

// ---------------------------------------------------------------- stock Lua, from the client's MPQs

let chain;
async function provider() {
  if (!chain) {
    const { clientArchives } = await import("../tools/mpq.mjs");
    chain = await clientArchives(clientDirectory);
  }
  return {
    async read(path) {
      const data = await chain.read(path);
      return data ? decoder.decode(data) : undefined;
    },
  };
}
after(() => chain?.close?.());

function lua(boot, source, results = 1) {
  const chunk = boot.vm.compileFunction(source, "@seam-residuals", []);
  try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
}

async function boot(seam) {
  const candidate = new FrameXmlBoot({
    provider: await provider(), locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam,
    screen: () => ({ width: 1024, height: 768 }),
  });
  await candidate.load();
  return candidate;
}

test("stock FloatingChatFrame docks «Журнал боя», its tab switches frames and the combat feed fills it", withClient, async () => {
  const seam = new CannedWorldSeam();
  const candidate = await boot(seam);
  try {
    const [errorsAtBoot] = lua(candidate, "return _ERROR_COUNT or 0");
    assert.deepEqual(lua(candidate, `
      local dock = GENERAL_CHAT_DOCK
      return #dock.DOCKED_CHAT_FRAMES, ChatFrame2.isDocked, ChatFrame2Tab:GetText(), ChatFrame2Tab:IsShown(),
        FCFDock_GetSelectedWindow(dock) == ChatFrame1`, 5), [2, 1, "Журнал боя", true, true]);

    // The live seam raises UPDATE_CHAT_WINDOWS again after boot (a join, a replay). Stock re-runs
    // FloatingChatFrame_Update for every window: a `shown` combat window would be shown over the
    // selected «Общий» with its tab moved onto ChatFrame2Background, right over «Общий»'s tab.
    const docked = `
      local point, relative, relativePoint = ChatFrame2Tab:GetPoint(1)
      return ChatFrame1:IsShown(), ChatFrame2:IsShown(), ChatFrame2Tab:IsShown(), point,
        relative and relative:GetName(), relativePoint`;
    const besideGeneral = [true, false, true, "LEFT", "ChatFrame1Tab", "RIGHT"];
    assert.deepEqual(lua(candidate, docked, 6), besideGeneral);
    candidate.bridge.dispatchEvent("UPDATE_CHAT_WINDOWS");
    candidate.bridge.dispatchEvent("UPDATE_CHAT_WINDOWS");
    assert.deepEqual(lua(candidate, docked, 6), besideGeneral,
      "later updates leave ChatFrame2 hidden and its tab beside «Общий»");

    candidate.bridge.fireScript(candidate.bridge.getFrame("ChatFrame2Tab"), "OnClick", "LeftButton");
    assert.deepEqual(lua(candidate, `
      return FCFDock_GetSelectedWindow(GENERAL_CHAT_DOCK) == ChatFrame2, ChatFrame2:IsShown(), ChatFrame1:IsShown()`, 3),
    [true, true, false], "a click on the tab selects ChatFrame2 and hides ChatFrame1");
    candidate.bridge.fireScript(candidate.bridge.getFrame("ChatFrame1Tab"), "OnClick", "LeftButton");
    assert.deepEqual(lua(candidate, "return ChatFrame1:IsShown(), ChatFrame2:IsShown()", 2), [true, false]);

    // The mount's own predicate over the seam (FrameXmlWorldMount `combatWindowEnabled`).
    let listener;
    const scheduled = [];
    const field = { value: "", focus() {}, setSelectionRange() {}, ownerDocument: { activeElement: null } };
    const release = installFrameXmlStockChat({
      vm: candidate.vm, bridge: candidate.bridge, inputFor: () => field, schedule: (callback) => scheduled.push(callback),
    }, {
      world: () => undefined, notice() {}, cast() {}, use() {}, unitGuid: () => undefined,
      commands: () => [], emotes: () => undefined, run: () => true,
      onCombatEntry: (next) => { listener = next; return () => { listener = undefined; }; },
      combatHistory: () => [],
      combatWindowEnabled: () => {
        const info = seam.chatWindowInfo(2);
        return info !== undefined && (info[6] === true || Boolean(info[8]));
      },
    }, () => {});
    assert.equal(typeof release, "function", "the stock chat installs over the real edit box");
    try {
      listener({ text: "Волк наносит вам 12 ед. урона.", kind: "taken" });
      for (const flush of scheduled.splice(0)) flush();
      const combat = candidate.bridge.getFrame("ChatFrame2").messageFrame.messages.map((line) => line.text);
      const general = candidate.bridge.getFrame("ChatFrame1").messageFrame.messages.map((line) => line.text);
      assert.deepEqual(combat, ["Волк наносит вам 12 ед. урона."]);
      assert.ok(!general.includes("Волк наносит вам 12 ед. урона."), "and only ChatFrame2");
    } finally {
      release();
    }
    const [errorsNow] = lua(candidate, "return _ERROR_COUNT or 0");
    assert.equal(errorsNow, errorsAtBoot, "docking, clicking and the feed raise no Lua error");
    assert.equal(errorsAtBoot, 0);
    assert.equal(candidate.vm.errors.length, 0);
  } finally {
    candidate.close();
  }
});

test("a /join-ed channel reaches stock ChatFrame from the packet: notice, its lines, and the leave", withClient, async () => {
  const { client, transport } = await loggedInClient();
  const seam = new LiveWorldSeam({
    world: () => client, store: () => undefined, spell: () => undefined, monotonic: () => 0,
    globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const candidate = await boot(seam);
  const general = () => candidate.bridge.getFrame("ChatFrame1").messageFrame.messages.map((line) => line.text);
  const channelLine = (text) => new PacketWriter()
    .u8(CHAT_MSG_CHANNEL).u32(7).u64(0x99n).u32(0).cString("Мойканал").u64(0n)
    .u32(Buffer.byteLength(text) + 1).cString(text).u8(0).toUint8Array();
  try {
    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, youJoined("Мойканал", 0x01));
    await settle();
    transport.push(OPCODES.SMSG_MESSAGECHAT, channelLine("всем привет"));
    await settle();
    const joinedLines = general();
    assert.ok(joinedLines.includes("Вы присоединились к каналу |Hchannel:CHANNEL:1|h[1. Мойканал]|h."),
      joinedLines.join("\n"));
    assert.ok(joinedLines.some((line) => line.startsWith("|Hchannel:channel:1|h[1. Мойканал]|h ")
      && line.endsWith("всем привет")), "a freshly joined channel's lines are no longer dropped");
    assert.deepEqual(lua(candidate, "return ChatFrame1.channelList[1]"), ["Мойканал"]);

    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, youLeft("Мойканал"));
    await settle();
    assert.ok(general().includes("Вы покинули канал |Hchannel:CHANNEL:1|h[1. Мойканал]|h."), general().join("\n"));
    assert.deepEqual(lua(candidate, "return ChatFrame1.channelList[1]"), [undefined],
      "YOU_LEFT is what takes it off stock's list");
    const before = general().length;
    transport.push(OPCODES.SMSG_MESSAGECHAT, channelLine("после выхода"));
    await settle();
    assert.equal(general().length, before, "a line in a channel the player left is not shown");
    assert.equal(candidate.vm.errors.length, 0, candidate.vm.errors.join("\n"));
  } finally {
    candidate.close();
    client.close();
  }
});

test("stock ChatFrame follows a zone channel into a shorter zone, and a count leaves «Журнал боя» on top", withClient, async () => {
  const { client, transport } = await loggedInClient();
  const seam = new LiveWorldSeam({
    world: () => client, store: () => undefined, spell: () => undefined, monotonic: () => 0,
    globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const candidate = await boot(seam);
  const general = () => candidate.bridge.getFrame("ChatFrame1").messageFrame.messages.map((line) => line.text);
  const click = (tab) => candidate.bridge.fireScript(candidate.bridge.getFrame(tab), "OnClick", "LeftButton");
  try {
    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, youJoined("Общий: Элвиннский лес", 0x18, 1));
    await settle();
    click("ChatFrame2Tab");
    transport.push(OPCODES.SMSG_CHANNEL_MEMBER_COUNT, memberCount("Общий: Элвиннский лес", 12));
    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, new PacketWriter().u8(0x00).cString("Общий: Элвиннский лес")
      .u64(0x99n).toUint8Array());
    await settle();
    assert.deepEqual(lua(candidate, "return ChatFrame1:IsShown(), ChatFrame2:IsShown()", 2), [false, true],
      "channel traffic while «Журнал боя» is selected does not re-show «Общий» over it");
    click("ChatFrame1Tab");

    // Даларан is shorter than Элвиннский лес: stock matches only an «N. name» longer than the
    // listed name (ChatFrame.lua:2708), so the list must carry the new name before the notice.
    transport.push(OPCODES.SMSG_CHANNEL_NOTIFY, youJoined("Общий: Даларан", 0x18, 1));
    await settle();
    transport.push(OPCODES.SMSG_MESSAGECHAT, channelSay("Общий: Даларан", "продам руду"));
    await settle();
    const lines = general();
    assert.ok(lines.includes("Смена канала: |Hchannel:CHANNEL:1|h[1. Общий: Даларан]|h."), lines.join("\n"));
    assert.ok(lines.some((line) => line.startsWith("|Hchannel:channel:1|h[1. Общий: Даларан]|h ")
      && line.endsWith("продам руду")), lines.join("\n"));
    assert.deepEqual(lua(candidate,
      "return ChatFrame1.channelList[1], ChatFrame1.zoneChannelList[1], ChatFrame1.channelList[2]", 3),
    ["Общий: Даларан", 1, undefined], "one channel, slot 1, carrying its zone id");
    assert.equal(candidate.vm.errors.length, 0, candidate.vm.errors.join("\n"));
  } finally {
    candidate.close();
    client.close();
  }
});
