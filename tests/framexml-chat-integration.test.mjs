import assert from "node:assert/strict";
import test from "node:test";

// This is intentionally MPQ-backed.  The message assertions only mean something when the real
// ChatFrame.xml/FloatingChatFrame.xml and ChatFrame.lua are loaded by FrameXmlBoot.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { FRAMEXML_CHAT_OUTBOUND_TYPES } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { frameXmlChatEventArgs } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const {
  CHAT_MSG_CHANNEL,
  CHAT_MSG_GUILD,
  CHAT_MSG_PARTY,
  CHAT_MSG_WHISPER,
} = await import("../dist/code/world/ChatProtocol.js");

const decoder = new TextDecoder("utf-8");

function normalized(path) {
  return path.replaceAll("\\", "/").toLowerCase();
}

async function loadCandidate(chain, sent, seam = new CannedWorldSeam(undefined, (...args) => sent.push(args))) {
  const requests = [];
  const provider = {
    async read(path) {
      requests.push(normalized(path));
      const data = await chain.read(path);
      return data ? decoder.decode(data) : undefined;
    },
  };
  const boot = new FrameXmlBoot({
    provider,
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    screen: () => ({ width: 1024, height: 768 }),
  });
  const inventory = await boot.load();
  return { boot, seam, inventory, requests: new Set(requests) };
}

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
}

function liveChatSeam(sent) {
  const events = new FakeEvents();
  const world = {
    state: { selfGuid: 0x10n, objects: new Map() },
    targetGuid: undefined,
    chatLog: [],
    channels: new Map([
      ["Общий", { flags: 0, count: 0, members: [] }],
    ]),
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
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: () => undefined,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
    sendChatMessage: (...args) => sent.push(args),
  });
  return { seam, world };
}

function frame(boot, name) {
  const result = boot.bridge.getFrame(name);
  assert.ok(result, `${name} exists`);
  return result;
}

test("MPQ ChatFrame routes canned chat and the real edit box through stock Lua", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const sent = [];
  let candidate;
  try {
    candidate = await loadCandidate(chain, sent);

    for (const path of [
      "interface/framexml/autocomplete.xml",
      "interface/framexml/historykeeper.lua",
      "interface/framexml/chatframe.xml",
      "interface/framexml/floatingchatframe.xml",
    ]) {
      assert.ok(candidate.requests.has(path), `${path} was read from MPQ`);
    }
    assert.equal(candidate.inventory.files.missing.length, 0,
      "the current vertical has no missing files");
    assert.equal(candidate.inventory.xml.failed.length, 0,
      "chat XML loads without parse failures");
    assert.equal(candidate.inventory.lua.failed, 0,
      "chat Lua executes without load failures");
    assert.equal(candidate.boot.vm.errors.length, 0,
      "the canned chat attach starts without Lua errors");

    const chat = frame(candidate.boot, "ChatFrame1");
    const messageFrame = chat.messageFrame;
    assert.equal(chat.type, "ScrollingMessageFrame");
    assert.equal(chat.visible, true);

    // ChatFrame_OnEvent receives UPDATE_CHAT_WINDOWS before the canned lines.  The seam configures
    // the complete stock group surface on the general window; hidden windows remain unconfigured.
    const chatMessageEvents = (value) => [...value.registeredEvents]
      .filter((event) => event.startsWith("CHAT_MSG_"));
    const expectedConfigured = [
      "CHAT_MSG_SYSTEM", "CHAT_MSG_SAY", "CHAT_MSG_EMOTE", "CHAT_MSG_TEXT_EMOTE",
      "CHAT_MSG_YELL", "CHAT_MSG_WHISPER", "CHAT_MSG_WHISPER_INFORM", "CHAT_MSG_AFK",
      "CHAT_MSG_DND", "CHAT_MSG_PARTY", "CHAT_MSG_MONSTER_PARTY", "CHAT_MSG_PARTY_LEADER",
      "CHAT_MSG_RAID", "CHAT_MSG_RAID_LEADER", "CHAT_MSG_RAID_WARNING", "CHAT_MSG_BATTLEGROUND",
      "CHAT_MSG_GUILD", "CHAT_MSG_OFFICER", "CHAT_MSG_MONSTER_SAY", "CHAT_MSG_MONSTER_YELL",
      "CHAT_MSG_MONSTER_EMOTE", "CHAT_MSG_MONSTER_WHISPER", "CHAT_MSG_RAID_BOSS_EMOTE",
      "CHAT_MSG_RAID_BOSS_WHISPER", "CHAT_MSG_RESTRICTED", "CHAT_MSG_FILTERED",
      "CHAT_MSG_IGNORED", "CHAT_MSG_BG_SYSTEM_HORDE", "CHAT_MSG_BG_SYSTEM_ALLIANCE",
      "CHAT_MSG_BG_SYSTEM_NEUTRAL", "CHAT_MSG_ACHIEVEMENT", "CHAT_MSG_GUILD_ACHIEVEMENT",
      "CHAT_MSG_CHANNEL",
    ];
    for (const event of expectedConfigured) assert.ok(chatMessageEvents(chat).includes(event), event);
    for (let index = 2; index <= 10; index += 1) {
      const hidden = frame(candidate.boot, `ChatFrame${index}`);
      assert.equal(hidden.visible, false, `${hidden.name} stays hidden`);
      assert.deepEqual(chatMessageEvents(hidden), ["CHAT_MSG_CHANNEL"],
        `${hidden.name} keeps only stock static channel registration`);
      assert.deepEqual(hidden.messageFrame.messages, [],
        `${hidden.name} has no seeded messages`);
    }

    // These are the concrete AddMessage records emitted by ChatFrame_MessageEventHandler.  The
    // SAY line ID is represented by stock ChatHistory as accessID/extraData; SYSTEM has no line ID.
    assert.deepEqual(messageFrame.messages, [
      {
        // The canned player is Human: GetDefaultLanguage is its racial «всеобщий», so stock
        // ChatFrame.lua:2901 prints no language bracket on its own SAY line.
        text: "|Hplayer:Игрок:1:SAY|h[Игрок]|h говорит: Привет из canned seam",
        color: { r: 1, g: 1, b: 1, a: 1 },
        accessID: 1,
        extraData: 1,
      },
      {
        // SYSTEM in the chat cache's default yellow, raised by the seam's UPDATE_CHAT_COLOR pass.
        text: "Canned chat seam ready",
        color: { r: 1, g: 1, b: 0, a: 1 },
      },
    ]);

    const messagesAtAttach = structuredClone(messageFrame.messages);
    const errorsAtAttach = candidate.boot.vm.errors.length;
    for (let index = 0; index < 3; index += 1) {
      candidate.boot.tickSeam(candidate.boot.pump.now());
    }
    assert.deepEqual(messageFrame.messages, messagesAtAttach,
      "repeated seam ticks do not duplicate the canned lines");
    assert.equal(candidate.boot.vm.errors.length, errorsAtAttach,
      "repeated chat ticks add no Lua errors");

    const editBox = frame(candidate.boot, "ChatFrame1EditBox");
    candidate.boot.bridge.SetText(editBox, "hello from edit box");
    candidate.boot.bridge.Show(editBox);
    assert.equal(candidate.boot.bridge.fireScript(editBox, "OnEnterPressed"), true,
      "stock OnEnterPressed handles the edit box");
    // ChatEdit_OnLoad keeps GetDefaultLanguage() in editBox.language (a name); the seam resolves
    // it back to the Languages.dbc id, 7 («всеобщий») for the canned Human.
    assert.deepEqual(sent, [["hello from edit box", FRAMEXML_CHAT_OUTBOUND_TYPES.SAY, 7, ""]],
      "the real ChatEdit_SendText path emits one SAY");
    assert.equal(editBox.text, "", "Enter clears the edit box");
    assert.equal(editBox.visible, false, "Enter hides the edit box");

    candidate.boot.bridge.SetText(editBox, "escape me");
    candidate.boot.bridge.Show(editBox);
    assert.equal(candidate.boot.bridge.fireScript(editBox, "OnEscapePressed"), true,
      "stock Escape handler runs");
    assert.deepEqual(sent, [["hello from edit box", FRAMEXML_CHAT_OUTBOUND_TYPES.SAY, 7, ""]],
      "Escape does not send a second message");
    assert.equal(editBox.text, "", "Escape clears pending text");
    assert.equal(editBox.visible, false, "Escape hides the edit box");
    assert.equal(candidate.boot.vm.errors.length, errorsAtAttach,
      "Enter and Escape add no Lua errors");

    // A live seam owns the same stock ChatFrame, but supplies an exact joined channel so that the
    // handler's channelList gate is exercised rather than merely proving event registration.
    const liveSent = [];
    const live = liveChatSeam(liveSent);
    const liveCandidate = await loadCandidate(chain, liveSent, live.seam);
    try {
      const liveChat = frame(liveCandidate.boot, "ChatFrame1");
      const liveMessages = liveChat.messageFrame;
      const chatMessage = (type, text, channel = "") => ({
        type,
        language: 7,
        senderGuid: 0x1234n,
        senderName: "Alice",
        receiverGuid: 0n,
        receiverName: "",
        channel,
        text,
        tag: 0,
        achievementId: 0,
      });
      const dispatch = (message, lineId) => liveCandidate.boot.bridge.dispatchEvent(
        `CHAT_MSG_${({
          [CHAT_MSG_GUILD]: "GUILD",
          [CHAT_MSG_PARTY]: "PARTY",
          [CHAT_MSG_WHISPER]: "WHISPER",
          [CHAT_MSG_CHANNEL]: "CHANNEL",
        })[message.type]}`,
        ...frameXmlChatEventArgs(message, message.senderName, lineId,
          message.type === CHAT_MSG_CHANNEL ? 1 : 0),
      );
      dispatch(chatMessage(CHAT_MSG_GUILD, "guild line"), 1);
      dispatch(chatMessage(CHAT_MSG_PARTY, "party line"), 2);
      dispatch(chatMessage(CHAT_MSG_WHISPER, "whisper line"), 3);
      dispatch(chatMessage(CHAT_MSG_CHANNEL, "channel line", "Общий"), 4);
      assert.equal(liveMessages.messages.length, 4);
      assert.deepEqual(liveMessages.messages.map(({ text }) => text), [
        "|Hchannel:GUILD|h[Гильдия]|h |Hplayer:Alice:1:GUILD|h[Alice]|h: [всеобщий] guild line",
        "|Hchannel:PARTY|h[Группа]|h |Hplayer:Alice:2:PARTY|h[Alice]|h: [всеобщий] party line",
        "|Hplayer:Alice:3:WHISPER:ALICE|h[Alice]|h шепчет: [всеобщий] whisper line",
        "|Hchannel:channel:1|h[1. Общий]|h |Hplayer:Alice:4:CHANNEL:1|h[Alice]|h: [всеобщий] channel line",
      ]);
      for (let index = 2; index <= 10; index += 1) {
        assert.deepEqual(frame(liveCandidate.boot, `ChatFrame${index}`).messageFrame.messages, [],
          `ChatFrame${index} stays empty`);
      }
      assert.equal(liveCandidate.boot.vm.errors.length, 0,
        "representative live chat events add no Lua errors");
      assert.deepEqual(live.seam.chatWindowChannels(1), ["Общий", 0]);
    } finally {
      liveCandidate.boot.close();
    }
  } finally {
    candidate?.boot.close();
    chain.close();
  }
});
