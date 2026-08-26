import assert from "node:assert/strict";
import test from "node:test";
import {
  GLOBAL_CACHE_MASK, LANG_ADDON, MAX_ACCOUNT_TUTORIAL_VALUES, PER_CHARACTER_CACHE_MASK,
  buildAddonBlock, buildAddonMessageBody, buildUpdateAccountData,
  chatServerMessageText, deflate, inflate, isTutorialSeen, parseAccountDataTimes, parseAddonInfo,
  parseAddonMessageBody, parseChatServerMessage, parseClientCacheVersion, parseDeclinedNamesResult,
  parseEmptySessionPacket, parseFeatureSystemStatus, parseLogoutResponse, parseMotd,
  parseNotification, parseQueryTimeResponse, parseRealmSplit, parseTutorialFlags,
  parseUpdateAccountData, parseUpdateAccountDataComplete, parseWardenData,
  SERVER_MSG_SHUTDOWN_TIME,
} from "../dist/code/world/SessionProtocol.js";
import {
  MAX_ITEM_PROTO_SPELLS, QUERY_MISSING_FLAG, buildCreatureQuery, buildItemQuery,
  hasItemSpell, parseCreatureQueryResponse, parseItemNameQueryResponse, parseItemQueryResponse,
  parseItemTextQueryResponse, parsePageTextQueryResponse,
} from "../dist/code/world/QueryCacheProtocol.js";
import {
  GMTICKET_RESPONSE_CREATE_SUCCESS, GMTICKET_STATUS_DEFAULT, GMTICKET_STATUS_HASTEXT,
  GM_RESPONSE_CHUNKS, TICKET_IN_ESCALATION_QUEUE, buildTicketCreate, buildTicketUpdate,
  isTicketSuccess, parseGmResponse, parseGmResponseStatusUpdate, parseGmTicket,
  parseTicketResponse, parseTicketSystemStatus, ticketResponseText,
} from "../dist/code/world/TicketProtocol.js";
import {
  BARBER_SHOP_RESULT_NOT_ON_CHAIR, barberShopResultText, buildAlterAppearance,
  parseBarberShopResult, parseCharacterServiceResult,
} from "../dist/code/world/CharacterServiceProtocol.js";
import { parsePlayObjectSound, parsePlaySound } from "../dist/code/world/SoundProtocol.js";
import {
  parseAuctionBidderNotification, parseAuctionListPendingSales, parseAuctionOwnerNotification,
} from "../dist/code/world/AuctionProtocol.js";
import { parseShowMailbox } from "../dist/code/world/MailProtocol.js";
import {
  parseEnableBarberShop, parseFishingFailure, parseGameObjectPageText,
} from "../dist/code/world/GameObjectProtocol.js";

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
const i32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, true);
  return out;
};
const f32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, value, true);
  return out;
};
const u64 = (value) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
};
const cstr = (value) => bytes(encoder.encode(value), u8(0));
const repeat = (part, count) => bytes(...Array.from({ length: count }, () => part));

const PLAYER = 0x0000_0000_0000_2a01n;
const OBJECT = 0xf110_0dcb_0000_0007n;

test("the account-data list is as long as its mask has bits and no longer", () => {
  // SendAccountDataTimes writes one word per set bit and no count: eight words would eat the
  // packet after this one.
  const times = parseAccountDataTimes(bytes(
    u32(1_755_000_000), u8(1), u32(GLOBAL_CACHE_MASK), u32(11), u32(22), u32(33),
  ));
  assert.equal(times.serverTime, 1_755_000_000);
  assert.equal(times.mask, GLOBAL_CACHE_MASK, "0x15 is the global mask: config, bindings, macros");
  assert.equal(times.times.size, 3);
  assert.equal(times.times.get(0), 11);
  assert.equal(times.times.get(2), 22);
  assert.equal(times.times.get(4), 33);

  const perCharacter = parseAccountDataTimes(bytes(
    u32(0), u8(1), u32(PER_CHARACTER_CACHE_MASK), u32(1), u32(2), u32(3), u32(4), u32(5),
  ));
  assert.equal(perCharacter.times.size, 5, "0xEA names the other five");
});

test("an account blob is deflate, and the size on the wire is what it expands to", async () => {
  const text = "SET macro1 \"/dance\"\n".repeat(20);
  const plain = bytes(encoder.encode(text), u8(0));
  const compressed = await deflate(plain);
  assert.ok(compressed.length < plain.length, "the blob is worth compressing at all");

  const blob = parseUpdateAccountData(bytes(u64(PLAYER), u32(5), u32(1_755_000_000), u32(plain.length), compressed));
  assert.equal(blob.type, 5);
  assert.equal(blob.decompressedSize, plain.length);
  const round = await inflate(blob.compressed, blob.decompressedSize);
  assert.deepEqual(round, plain);

  // The server promises the size, so a wrong one is a failure and not a hint.
  await assert.rejects(() => inflate(blob.compressed, plain.length + 1), RangeError);

  assert.equal(parseUpdateAccountDataComplete(bytes(u32(6), u32(0))), 6);
  // An erase carries no body at all.
  assert.equal(buildUpdateAccountData(6, 0, 0, new Uint8Array(0)).length, 12);
  assert.equal(buildUpdateAccountData(6, 0, 4, Uint8Array.from([1, 2, 3])).length, 15);
});

test("the tutorial flags are eight fixed words with a bit each", () => {
  const flags = parseTutorialFlags(bytes(u32(0b1011), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(1)));
  assert.equal(flags.length, MAX_ACCOUNT_TUTORIAL_VALUES);
  assert.equal(isTutorialSeen(flags, 0), true);
  assert.equal(isTutorialSeen(flags, 2), false);
  assert.equal(isTutorialSeen(flags, 3), true);
  assert.equal(isTutorialSeen(flags, 224), true, "thirty-two bits per word, low bit first");
  assert.equal(isTutorialSeen(flags, 255), false);
});

test("the small session packets say exactly what they look like", () => {
  assert.deepEqual(parseMotd(bytes(u32(2), cstr("Добро пожаловать"), cstr("Приятной игры"))), [
    "Добро пожаловать", "Приятной игры",
  ]);
  assert.deepEqual(parseMotd(u32(0)), [], "an empty motd is a count of zero, not a truncated packet");

  assert.equal(parseNotification(cstr("Вы не можете говорить")), "Вы не можете говорить");
  assert.equal(parseClientCacheVersion(u32(12340)), 12340);
  assert.deepEqual(parseFeatureSystemStatus(bytes(u8(2), u8(0))), { complaintStatus: 2, voiceEnabled: false });
  assert.deepEqual(parseRealmSplit(bytes(u32(7), u32(0), cstr("01/01/01"))), {
    requestId: 7, state: 0, date: "01/01/01",
  });
  assert.deepEqual(parseDeclinedNamesResult(bytes(u32(0), u64(PLAYER))), { result: 0, guid: PLAYER });
  assert.equal(parseWardenData(Uint8Array.from([1, 2, 3])).length, 3, "opaque: kept as it arrived");
});

test("the two words in the time answer are not the same kind of number", () => {
  // The first is absolute unix time; the second is a remaining duration.
  const time = parseQueryTimeResponse(bytes(u32(1_755_000_000), u32(3_600)));
  assert.equal(time.time, 1_755_000_000);
  assert.equal(time.dailyResetIn, 3_600, "seconds until the reset, not the moment of it");

  // ServerMessageType starts at one, not zero: numbering it from zero prints a shutdown as a
  // restart and drops both cancellations off the end of the table.
  const message = parseChatServerMessage(bytes(i32(SERVER_MSG_SHUTDOWN_TIME), cstr("5 мин.")));
  assert.equal(message.messageId, 1);
  assert.match(chatServerMessageText(message), /выключается через 5 мин\./);
  assert.match(chatServerMessageText(parseChatServerMessage(bytes(i32(2), cstr("1 ч.")))), /перезапускается/);
  assert.equal(chatServerMessageText(parseChatServerMessage(bytes(i32(3), cstr("Тех. работы")))), "Тех. работы");
  assert.match(chatServerMessageText(parseChatServerMessage(bytes(i32(4), cstr("")))), /Выключение сервера отменено/);
  assert.match(chatServerMessageText(parseChatServerMessage(bytes(i32(5), cstr("")))), /Перезапуск сервера отменён/);
});

test("a granted logout is not the end of the session", () => {
  const granted = parseLogoutResponse(bytes(u32(0), u8(0)));
  assert.deepEqual(granted, { result: 0, instant: false });

  const refused = parseLogoutResponse(bytes(u32(12), u8(0)));
  assert.equal(refused.result, 12, "in combat, falling, in an arena");

  const rested = parseLogoutResponse(bytes(u32(0), u8(1)));
  assert.equal(rested.instant, true, "resting waives the twenty seconds");

  // The completion and the cancel acknowledgement have no body at all.
  assert.equal(parseEmptySessionPacket(new Uint8Array(0)), undefined);
});

test("the addon block is deflate with its timestamp last, and the answer has no count", async () => {
  const block = await buildAddonBlock([
    { name: "Blizzard_CombatLog", hasKey: true, publicKeyCrc: 0x4c1c776d, urlCrc: 0 },
    { name: "MyAddon", hasKey: false, publicKeyCrc: 0x1234, urlCrc: 0 },
  ], 1_700_000_000);

  const size = new DataView(block.buffer, block.byteOffset, 4).getUint32(0, true);
  const inflated = await inflate(block.slice(4), size);
  const view = new DataView(inflated.buffer, inflated.byteOffset, inflated.byteLength);
  assert.equal(view.getUint32(0, true), 2, "the count comes first");
  assert.equal(
    view.getUint32(inflated.byteLength - 4, true), 1_700_000_000,
    "and the timestamp is read from the end of the block, not from a position",
  );

  const empty = await buildAddonBlock([]);
  const emptySize = new DataView(empty.buffer, empty.byteOffset, 4).getUint32(0, true);
  assert.equal(emptySize, 8, "an empty declaration is still a count and a timestamp");

  // The answer carries no count of its own: it has exactly as many entries as were declared.
  const answer = parseAddonInfo(bytes(
    u8(2), u8(1), u8(0), u32(0), u8(0),
    u8(0), u8(1), u8(1), repeat(u8(0xaa), 256), u32(0), u8(0),
    u32(1), u32(9), repeat(u8(1), 16), repeat(u8(2), 16), u32(1_600_000_000), u32(1),
  ), 2);
  assert.equal(answer.addons.length, 2);
  assert.equal(answer.addons[0].keyProvided, false, "the client already had the key file");
  assert.equal(answer.addons[1].publicKey.length, 256, "and this one is being given one");
  assert.equal(answer.banned.length, 1);
  assert.equal(answer.banned[0].id, 9);
  assert.equal(answer.banned[0].timestamp, 1_600_000_000);
});

test("an addon message is prefix, tab, payload — and nothing on the wire says so", () => {
  assert.equal(buildAddonMessageBody("DBM", "pull 10"), "DBM\tpull 10");
  assert.deepEqual(parseAddonMessageBody("DBM\tpull 10"), { prefix: "DBM", message: "pull 10" });
  assert.deepEqual(parseAddonMessageBody("DBM\tpull\t10"), { prefix: "DBM", message: "pull\t10" }, "only the first tab splits");
  assert.deepEqual(parseAddonMessageBody("no prefix"), { prefix: "", message: "no prefix" });
  assert.equal(LANG_ADDON | 0, -1, "the language field is signed, so LANG_ADDON reads as −1");
});

test("a missing query row is the entry with its top bit on and nothing after it", () => {
  const missing = parseCreatureQueryResponse(u32((448 | QUERY_MISSING_FLAG) >>> 0));
  assert.equal(missing.entry, 448, "masked back off, or it would be creature 2147483896");
  assert.equal(missing.found, false);
  assert.equal(missing.name, "");

  const found = parseCreatureQueryResponse(bytes(
    u32(448), cstr("Хоггер"), u8(0), u8(0), u8(0), cstr("Вожак гноллов"), cstr(""),
    u32(0), u32(7), u32(0), u32(3),
    u32(0), u32(0),
    u32(796), u32(0), u32(0), u32(0),
    f32(2.5), f32(1),
    u8(0),
    u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    u32(0),
  ));
  assert.equal(found.found, true);
  assert.equal(found.name, "Хоггер");
  assert.equal(found.subName, "Вожак гноллов", "three empty strings sit between the two names");
  assert.equal(found.classification, 3);
  assert.deepEqual(found.displayIds, [796, 0, 0, 0]);
  assert.equal(found.healthModifier, 2.5);
  assert.equal(found.questItems.length, 6, "always six, zero-padded, never counted");
});

/** One item packet, with a real first spell slot and four empty ones. */
function itemPacket({ entry = 6948, stats = [[7, 3]], spellId = 8690 } = {}) {
  const statBlock = bytes(u32(stats.length), ...stats.flatMap(([type, value]) => [u32(type), i32(value)]));
  const spells = [
    bytes(i32(spellId), u32(1), i32(-5), i32(3_600_000), u32(0), i32(-1)),
    ...Array.from({ length: MAX_ITEM_PROTO_SPELLS - 1 }, () =>
      bytes(u32(0), u32(0), u32(0), i32(-1), u32(0), i32(-1))),
  ];
  return bytes(
    u32(entry),
    u32(15), u32(0), i32(-1), cstr("Камень возвращения"), u8(0), u8(0), u8(0),
    u32(6418), u32(1), u32(64), u32(0), i32(0), u32(0), u32(0), u32(0xffff_ffff), u32(0xffff_ffff),
    u32(1), u32(1), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    i32(1), i32(1), u32(0),
    statBlock,
    u32(0), u32(0),
    f32(0), f32(0), u32(0), f32(0), f32(0), u32(0),
    u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    u32(0), u32(0), f32(0),
    ...spells,
    u32(1), cstr(""), u32(0), u32(0), u32(0), u32(0), u32(0), i32(0), u32(0), i32(0), i32(0),
    u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    u32(0), u32(0), u32(0), f32(0), u32(0), u32(0), u32(0),
  );
}

test("an empty item spell slot is not zeros, and the charge count arrives negated", () => {
  const item = parseItemQueryResponse(itemPacket());
  assert.equal(item.found, true);
  assert.equal(item.name, "Камень возвращения");
  assert.equal(item.allowableClass, 0xffff_ffff, "a mask, and unsigned: 'any class' is not −1");
  assert.deepEqual(item.stats, [{ type: 7, value: 3 }], "the one block here that is genuinely counted");
  assert.equal(item.spells.length, MAX_ITEM_PROTO_SPELLS);
  assert.equal(item.spells[0].spellId, 8690);
  assert.equal(item.spells[0].charges, 5, "written as -abs(charges), so it comes back positive");
  assert.equal(item.spells[0].cooldown, 3_600_000);
  assert.equal(hasItemSpell(item.spells[0]), true);

  // An empty slot is 0, 0, 0, -1, 0, -1 — not all zero.
  assert.equal(hasItemSpell(item.spells[1]), false);
  assert.equal(item.spells[1].cooldown, -1);
  assert.equal(item.spells[1].categoryCooldown, -1);
  assert.equal(item.spells[1].charges, 0, "and not −0, which is not equal to 0 in a strict test");

  const missing = parseItemQueryResponse(u32((6948 | QUERY_MISSING_FLAG) >>> 0));
  assert.equal(missing.found, false);
  assert.equal(missing.entry, 6948);

  assert.equal(buildItemQuery(6948).length, 4, "the only query here with no guid");
  assert.equal(buildCreatureQuery(448, OBJECT).length, 12);
});

test("the item-text byte is inverted, and a page fetches its whole book", () => {
  // 0 means there IS text and 1 means there is none, which is the reverse of every other flag.
  const none = parseItemTextQueryResponse(u8(1));
  assert.deepEqual(none, { guid: 0n, text: "" });

  const some = parseItemTextQueryResponse(bytes(u8(0), u64(OBJECT), cstr("Привет")));
  assert.equal(some.guid, OBJECT);
  assert.equal(some.text, "Привет");

  const page = parsePageTextQueryResponse(bytes(u32(1), cstr("Страница один"), u32(2)));
  assert.equal(page.nextPageId, 2, "the server sends the next one unasked");
  const last = parsePageTextQueryResponse(bytes(u32(2), cstr("Страница два"), u32(0)));
  assert.equal(last.nextPageId, 0);

  const setName = parseItemNameQueryResponse(bytes(u32(81), cstr("Хранители"), u32(1)));
  assert.deepEqual(setName, { entry: 81, name: "Хранители", inventoryType: 1 });
});

test("no ticket is four bytes, and a GM's answer arrives in four fixed chunks", async () => {
  const none = parseGmTicket(u32(GMTICKET_STATUS_DEFAULT));
  assert.equal(none.status, GMTICKET_STATUS_DEFAULT);
  assert.equal(none.ticketId, 0, "the whole packet is the status word");

  const open = parseGmTicket(bytes(
    u32(GMTICKET_STATUS_HASTEXT), u32(42), cstr("Застрял в текстурах"), u8(0),
    f32(0.5), f32(2.25), f32(0.125), u8(TICKET_IN_ESCALATION_QUEUE), u8(1),
  ));
  assert.equal(open.ticketId, 42);
  assert.equal(open.ageDays, 0.5, "days, as a float — not seconds and not a timestamp");
  assert.equal(open.oldestTicketAgeDays, 2.25);
  assert.equal(open.viewed, true);

  const response = parseGmResponse(bytes(
    u32(1), u32(42), cstr("Застрял в текстурах"), cstr("Мы вас вытащили"), cstr(""), cstr(""), cstr(""),
  ));
  assert.equal(response.ticketId, 42);
  assert.equal(response.response, "Мы вас вытащили", "all four chunks are written even when three are empty");
  assert.equal(GM_RESPONSE_CHUNKS, 4);

  assert.equal(parseGmResponseStatusUpdate(u8(1)), true);
  assert.equal(parseTicketResponse(u32(GMTICKET_RESPONSE_CREATE_SUCCESS)), GMTICKET_RESPONSE_CREATE_SUCCESS);
  assert.equal(isTicketSuccess(GMTICKET_RESPONSE_CREATE_SUCCESS), true);
  assert.equal(isTicketSuccess(3), false);
  assert.match(ticketResponseText(1), /уже есть/);
  assert.equal(parseTicketSystemStatus(u32(1)), 1);

  // A chat log with no timestamps is never read by the server, so it is not sent either.
  const bare = await buildTicketCreate({ mapId: 0, x: 1, y: 2, z: 3, message: "тест", needResponse: false, needMoreHelp: false, chatLog: "что-то" });
  assert.equal(bare.at(-1), 0, "the size word is zero and no compressed body follows");
  // mapId, three floats, the message with its terminator, two flags, a zero count and a zero size.
  assert.equal(bare.length, 4 + 12 + (encoder.encode("тест").length + 1) + 1 + 1 + 4 + 4);

  const withLog = await buildTicketCreate({
    mapId: 0, x: 1, y: 2, z: 3, message: "тест", needResponse: true, needMoreHelp: false,
    chatTimes: [1_755_000_000], chatLog: "строка",
  });
  assert.ok(withLog.length > bare.length + 4, "timestamps and a compressed log travel together");
  assert.equal(buildTicketUpdate("новый текст").at(-1), 0);
});

test("a rejected character service is one byte, and each kind carries one field more", () => {
  const rejected = parseCharacterServiceResult(u8(50), "rename");
  assert.equal(rejected.result, 50);
  assert.equal(rejected.guid, 0n, "the guid and the name are written only on success");

  const renamed = parseCharacterServiceResult(bytes(u8(0), u64(PLAYER), cstr("Аллея")), "rename");
  assert.equal(renamed.name, "Аллея");
  assert.equal(renamed.appearance, undefined);

  const customized = parseCharacterServiceResult(
    bytes(u8(0), u64(PLAYER), cstr("Аллея"), u8(1), u8(2), u8(3), u8(4), u8(5), u8(6)), "customize");
  assert.equal(customized.appearance.hairStyle, 4);
  assert.equal(customized.appearance.race, undefined);

  const changed = parseCharacterServiceResult(
    bytes(u8(0), u64(PLAYER), cstr("Аллея"), u8(1), u8(2), u8(3), u8(4), u8(5), u8(6), u8(7)), "factionChange");
  assert.equal(changed.appearance.race, 7, "the seventh byte is the only difference");

  assert.equal(parseBarberShopResult(u32(BARBER_SHOP_RESULT_NOT_ON_CHAIR)), BARBER_SHOP_RESULT_NOT_ON_CHAIR);
  assert.match(barberShopResultText(BARBER_SHOP_RESULT_NOT_ON_CHAIR), /кресло/);
  // BarberShopStyle.dbc row ids, not the style values — except the colour, which is raw.
  assert.equal(buildAlterAppearance(101, 3, 202).length, 16);
});

test("an object sound puts the kit before the guid, where everything else puts it after", () => {
  const sound = parsePlaySound(u32(888));
  assert.deepEqual(sound, { soundKitId: 888, sourceGuid: 0n, music: false });
  assert.equal(parsePlaySound(u32(11), true).music, true);

  const object = parsePlayObjectSound(bytes(u32(1234), u64(OBJECT)));
  assert.equal(object.soundKitId, 1234, "reading the guid first would eat the kit id and still end cleanly");
  assert.equal(object.sourceGuid, OBJECT);
});

test("the gameobject and mailbox packets are a guid or nothing at all", () => {
  assert.equal(parseGameObjectPageText(u64(OBJECT)), OBJECT);
  assert.equal(parseShowMailbox(u64(OBJECT)), OBJECT);
  assert.equal(parseFishingFailure(new Uint8Array(0)), undefined);
  assert.equal(parseEnableBarberShop(new Uint8Array(0)), undefined);
});

test("the auction notifications are mostly fields the core never fills", () => {
  const outbid = parseAuctionBidderNotification(bytes(
    u32(2), u32(77), u64(PLAYER), u32(15_000), u32(500), u32(6948), u32(0),
  ));
  assert.equal(outbid.houseId, 2);
  assert.equal(outbid.bidSum, 15_000);
  assert.equal(outbid.bidderGuid, PLAYER, "who holds the lot is the only thing that says win from loss");

  const sold = parseAuctionOwnerNotification(bytes(
    u32(77), u32(15_000), u32(0), u64(0n), u32(6948), u32(0), f32(0),
  ));
  assert.deepEqual(sold, { auctionId: 77, bid: 15_000, itemEntry: 6948 });

  assert.equal(parseAuctionListPendingSales(u32(0)), 0, "always empty: the loop is commented out");
});
