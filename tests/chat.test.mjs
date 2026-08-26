import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_MSG_ACHIEVEMENT,
  CHAT_MSG_CHANNEL,
  CHAT_MSG_MONSTER_SAY,
  CHAT_MSG_SAY,
  CHAT_MSG_WHISPER,
  LANG_COMMON,
  LANG_ORCISH,
  buildChatMessage,
  buildJoinChannel,
  buildLeaveChannel,
  buildTextEmote,
  languageForRace,
  parseChatMessage,
  parseEmote,
  parseTextEmote,
} from "../dist/code/world/ChatProtocol.js";
import { NameCache, buildNameQuery, parseNameQueryResponse } from "../dist/code/world/NameQueryProtocol.js";

const encoder = new TextEncoder();

function bytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
const u8 = (value) => Uint8Array.from([value & 0xff]);
const u32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
};
const u64 = (value) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
};
const cstr = (value) => bytes(encoder.encode(value), u8(0));

test("an ordinary say message decodes with the trailing receiver guid", () => {
  // BuildChatPacket default branch: type, language, sender, flags, receiver guid, text, tag.
  const payload = bytes(u8(CHAT_MSG_SAY), u32(LANG_COMMON), u64(0x1122n), u32(0), u64(0n), u32(6), cstr("Привет"), u8(0));
  const message = parseChatMessage(payload);
  assert.equal(message.type, CHAT_MSG_SAY);
  assert.equal(message.language, LANG_COMMON);
  assert.equal(message.senderGuid, 0x1122n);
  assert.equal(message.text, "Привет");
  assert.equal(message.senderName, "");
  assert.equal(message.channel, "");
});

test("a channel message carries the channel name without a length prefix", () => {
  const payload = bytes(u8(CHAT_MSG_CHANNEL), u32(LANG_COMMON), u64(7n), u32(0), cstr("General"), u64(0n), u32(3), cstr("hi"), u8(0));
  const message = parseChatMessage(payload);
  assert.equal(message.channel, "General");
  assert.equal(message.text, "hi");
});

test("a monster message carries its sender name inline", () => {
  const payload = bytes(
    u8(CHAT_MSG_MONSTER_SAY), u32(0), u64(0xf130_0000_0000_0001n), u32(0),
    u32(6), cstr("Кобольд"), u64(0n), u32(5), cstr("Свет!"), u8(0),
  );
  const message = parseChatMessage(payload);
  assert.equal(message.senderName, "Кобольд");
  assert.equal(message.text, "Свет!");
});

test("a monster whisper to a creature also carries the receiver name", () => {
  // The receiver name is only written when the receiver is neither a player nor a pet.
  const creature = 0xf130_0000_0000_0002n;
  const payload = bytes(
    u8(CHAT_MSG_MONSTER_SAY), u32(0), u64(0xf130_0000_0000_0001n), u32(0),
    u32(2), cstr("A"), u64(creature), u32(2), cstr("B"), u32(2), cstr("C"), u8(0),
  );
  const message = parseChatMessage(payload);
  assert.equal(message.receiverName, "B");
  assert.equal(message.text, "C");

  // A player receiver, high guid zero, gets no name.
  const toPlayer = bytes(
    u8(CHAT_MSG_MONSTER_SAY), u32(0), u64(0xf130_0000_0000_0001n), u32(0),
    u32(2), cstr("A"), u64(0x55n), u32(2), cstr("C"), u8(0),
  );
  assert.equal(parseChatMessage(toPlayer).text, "C");
});

test("an achievement message ends with the achievement id", () => {
  const payload = bytes(u8(CHAT_MSG_ACHIEVEMENT), u32(0), u64(3n), u32(0), u64(3n), u32(2), cstr("x"), u8(0), u32(1234));
  assert.equal(parseChatMessage(payload).achievementId, 1234);
});

test("outgoing chat writes the target only for whispers and channels", () => {
  assert.deepEqual([...buildChatMessage(CHAT_MSG_SAY, LANG_COMMON, "hi")], [...bytes(u32(CHAT_MSG_SAY), u32(LANG_COMMON), cstr("hi"))]);
  assert.deepEqual(
    [...buildChatMessage(CHAT_MSG_WHISPER, LANG_ORCISH, "hi", "Гоблин")],
    [...bytes(u32(CHAT_MSG_WHISPER), u32(LANG_ORCISH), cstr("Гоблин"), cstr("hi"))],
  );
});

test("the racial language follows the faction", () => {
  for (const race of [1, 3, 4, 7, 11]) assert.equal(languageForRace(race), LANG_COMMON);
  for (const race of [2, 5, 6, 8, 10]) assert.equal(languageForRace(race), LANG_ORCISH);
});

test("channel join and leave match their handlers", () => {
  // HandleJoinChannel reads channelId, two bytes, then the name and the password.
  assert.deepEqual([...buildJoinChannel(0, "General", "")], [...bytes(u32(0), u8(0), u8(0), cstr("General"), cstr(""))]);
  assert.deepEqual([...buildLeaveChannel(0, "General")], [...bytes(u32(0), cstr("General"))]);
});

test("emotes decode", () => {
  assert.deepEqual(parseEmote(bytes(u32(11), u64(5n))), { emoteId: 11, guid: 5n });
  const emote = parseTextEmote(bytes(u64(9n), u32(2), u32(0), u32(1), u8(0)));
  assert.equal(emote.guid, 9n);
  assert.equal(emote.textEmoteId, 2);
  assert.equal(emote.targetName, "");
});

test("a text emote goes out as two words and a raw guid", () => {
  // ChatHandler.cpp reads `uint32 text_emote`, `uint32 emoteNum`, `ObjectGuid guid`, and
  // ObjectGuid::operator>> is a plain read<uint64>. A packed guid here would be read as garbage
  // and the emote would land on nobody — silently, because the server answers nothing.
  const payload = buildTextEmote(34, 0, 0x1122334455667788n);
  assert.equal(payload.length, 16, "four bytes of emote, four of variant, eight of guid");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  assert.equal(view.getUint32(0, true), 34, "/dance is text emote thirty-four");
  assert.equal(view.getUint32(4, true), 0, "the variant goes out as zero, the way the client sends it");
  assert.equal(view.getBigUint64(8, true), 0x1122334455667788n);

  // No target is a zero guid rather than a shorter packet.
  assert.equal(buildTextEmote(101, 0, 0n).length, 16);
});

test("a text emote with a target carries the name the server wrote", () => {
  // SMSG_TEXT_EMOTE: guid, emote, variant, name length, then the name when the length is over one.
  const withTarget = parseTextEmote(bytes(u64(9n), u32(34), u32(0), u32(6), cstr("Тралл")));
  assert.equal(withTarget.textEmoteId, 34);
  assert.equal(withTarget.targetName, "Тралл");
});

test("name query responses decode and the cache asks only once per guid", () => {
  // The response leads with a packed guid; mask 0x01 selects the lowest byte only.
  const known = bytes(u8(0x01), u8(0x42), u8(0), cstr("Тралл"), cstr(""), u8(2), u8(0), u8(7), u8(0));
  const entry = parseNameQueryResponse(known);
  assert.deepEqual(entry, { guid: 0x42n, known: true, name: "Тралл", realm: "", race: 2, gender: 0, classId: 7, declined: [] });

  // A capture with no declension byte at all still has to decode: the flag is the last thing in
  // the packet, and reading past the end would throw on every name reply.
  const short = parseNameQueryResponse(bytes(u8(0x01), u8(0x42), u8(0), cstr("Тралл"), cstr(""), u8(2), u8(0), u8(7)));
  assert.deepEqual(short.declined, [], "a response that stops after the class is still a name");

  const unknown = parseNameQueryResponse(bytes(u8(0x01), u8(0x43), u8(1)));
  assert.equal(unknown.known, false);

  const cache = new NameCache();
  assert.equal(cache.shouldQuery(0x42n), true);
  assert.equal(cache.shouldQuery(0x42n), false, "already pending");
  assert.equal(cache.accept(entry), true);
  assert.equal(cache.get(0x42n), "Тралл");
  assert.equal(cache.shouldQuery(0x42n), false, "already known");
  assert.equal(cache.shouldQuery(0n), false);
  assert.equal(cache.accept(unknown), false);
  assert.equal(buildNameQuery(1n).length, 8);
});

test("declined names ride the name query and reach the cache", () => {
  // Only a ruRU character has them, and only the emote sentences ask: «машет рукой |3-2(%s)» is
  // the dative, and without the five cases it reads «машет рукой Тралл».
  const cases = ["Тралла", "Траллу", "Тралла", "Траллом", "Тралле"];
  const payload = bytes(
    u8(0x01), u8(0x44), u8(0), cstr("Тралл"), cstr(""), u8(2), u8(0), u8(7), u8(1),
    ...cases.map((value) => cstr(value)));
  const entry = parseNameQueryResponse(payload);
  assert.deepEqual(entry.declined, cases);

  const cache = new NameCache();
  cache.shouldQuery(0x44n);
  assert.equal(cache.accept(entry), true);
  assert.deepEqual(cache.declined(0x44n), cases);
  assert.equal(cache.declined(0x45n), undefined, "a name with no cases has none to give");
});
