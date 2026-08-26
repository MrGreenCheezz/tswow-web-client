import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CHAT_TABS,
  channelTab,
  chatClass,
  chatLine,
  chatPrefix,
  messageMatchesTab,
  tabMessages,
} from "../dist/code/browser/ui/ChatFormat.js";
import {
  CHAT_MSG_CHANNEL,
  CHAT_MSG_EMOTE,
  CHAT_MSG_GUILD,
  CHAT_MSG_RAID_WARNING,
  CHAT_MSG_SAY,
  CHAT_MSG_SYSTEM,
  CHAT_MSG_TEXT_EMOTE,
  CHAT_MSG_WHISPER,
  CHAT_MSG_WHISPER_INFORM,
} from "../dist/code/world/ChatProtocol.js";

function message(type, text, extra = {}) {
  return {
    type, language: 0, senderGuid: 1n, senderName: "", receiverGuid: 0n, receiverName: "",
    channel: "", text, tag: 0, achievementId: 0, ...extra,
  };
}
const names = () => "Иван";
const tab = (id) => DEFAULT_CHAT_TABS.find((entry) => entry.id === id);

test("speech reads as speech and anything else is bracketed", () => {
  assert.equal(chatLine(message(CHAT_MSG_SAY, "привет"), names), "Иван говорит: привет");
  assert.equal(chatLine(message(CHAT_MSG_GUILD, "привет"), names), "[Гильдия] Иван: привет");
  assert.equal(chatLine(message(CHAT_MSG_SYSTEM, "готово"), names), "готово");
});

test("a whisper the player sent names the person it went to", () => {
  // The server writes the receiver into the sender slot for WHISPER_INFORM, and reading it as a
  // sender produced «Иван вы шепчете: привет» — the right words in the wrong order about the
  // wrong person.
  assert.equal(chatLine(message(CHAT_MSG_WHISPER_INFORM, "привет"), names), "Вы → Иван: привет");
  assert.equal(chatLine(message(CHAT_MSG_WHISPER, "привет"), names), "Иван шепчет: привет");
});

test("an emote is a sentence about the sender, and a text emote already is one", () => {
  assert.equal(chatLine(message(CHAT_MSG_EMOTE, "машет рукой"), names), "Иван машет рукой");
  // The DBC sentence embeds the name itself, so prefixing one would say it twice.
  assert.equal(chatLine(message(CHAT_MSG_TEXT_EMOTE, "Иван машет рукой."), names), "Иван машет рукой.");
});

test("every type the parser can produce has a colour class", () => {
  assert.equal(chatClass(CHAT_MSG_RAID_WARNING), "chat-raid-warning");
  assert.equal(chatClass(CHAT_MSG_SAY), "chat-say");
  assert.equal(chatClass(0x7f), "chat-other", "an unknown type still gets a class");
});

test("a tab filters on the message type, not on the Russian label", () => {
  // The old renderer decided a line's shape by comparing its label against «говорит» and friends,
  // so translating a label would silently have changed which lines a tab showed.
  assert.equal(messageMatchesTab(message(CHAT_MSG_WHISPER, "…"), tab("whisper")), true);
  assert.equal(messageMatchesTab(message(CHAT_MSG_SAY, "…"), tab("whisper")), false);
  assert.equal(messageMatchesTab(message(CHAT_MSG_SAY, "…"), tab("general")), true,
    "the general tab shows everything, so nothing is lost by not looking at the others");
});

test("the combat tab takes no chat at all, because it reads the other list", () => {
  assert.equal(messageMatchesTab(message(CHAT_MSG_SAY, "…"), tab("combat")), false);
});

test("a channel tab matches the name the server localised", () => {
  const trade = channelTab("Торговля");
  assert.equal(messageMatchesTab(message(CHAT_MSG_CHANNEL, "…", { channel: "Торговля" }), trade), true);
  assert.equal(messageMatchesTab(message(CHAT_MSG_CHANNEL, "…", { channel: "Общий" }), trade), false);
});

test("a tab filters the whole backlog before it takes the last of it", () => {
  // Filtering the tail instead would show a handful of lines on a quiet tab while the model still
  // held five hundred — which is what filtering the two hundred DOM nodes used to do.
  const log = [];
  for (let index = 0; index < 500; index++) {
    log.push(message(index % 2 === 0 ? CHAT_MSG_SAY : CHAT_MSG_WHISPER, `строка ${index}`));
  }
  const whispers = tabMessages(log, tab("whisper"), 200);
  assert.equal(whispers.length, 200);
  assert.equal(whispers[whispers.length - 1].text, "строка 499");
  assert.equal(tabMessages(log, tab("general"), 200).length, 200);
});

test("chatPrefix and the body rejoin into the line the old renderer produced", () => {
  const said = message(CHAT_MSG_SAY, "привет");
  assert.equal(`${chatPrefix(said, names)}${said.text}`, chatLine(said, names));
});
