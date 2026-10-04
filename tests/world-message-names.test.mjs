// 1.32: the world layer's own messages name what they are about — quest, zone, dungeon, item,
// spell, guild event — from the caches and the browser's tables, and never print a raw id. Without
// a name the sentence is reworded around the thing, and the id stays out of it.
import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { globalString } from "../dist/code/generated/globalStrings.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { worldNameSources } from "../dist/code/world/WorldNames.js";
import {
  guildEventText, instanceResetFailedText, instanceResetText, questInvalidText, raidInstanceText, secondsToTimeText,
  zoneUnderAttackText,
} from "../dist/code/world/WorldMessageTexts.js";
import { formatGlobalString } from "../dist/code/world/GlobalStringFormat.js";
import {
  RAID_INSTANCE_EXPIRED, RAID_INSTANCE_WARNING_HOURS, RAID_INSTANCE_WARNING_MIN, RAID_INSTANCE_WARNING_MIN_SOON,
  RAID_INSTANCE_WELCOME,
} from "../dist/code/world/InstanceProtocol.js";

const SELF = 0x1234n;

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      const packet = { opcode, payload };
      if (wake) { const resume = wake; wake = undefined; resume(packet); } else queue.push(packet);
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

const settle = async () => { for (let round = 0; round < 6; round++) await new Promise((resolve) => setImmediate(resolve)); };

async function world(names) {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  client.state.selfGuid = SELF;
  if (names) client.worldNames = worldNameSources(names);
  const messages = [];
  client.events.on("WORLD_MESSAGE", ({ text }) => messages.push(text));
  const combat = [];
  client.events.on("COMBAT_LOG", ({ text }) => combat.push(text));
  return { client, connection, messages, combat };
}

const NAMES = {
  area: (id) => (id === 3703 ? "Шаттрат" : undefined),
  map: (id) => (id === 533 ? "Наксрамас" : undefined),
  spell: (id) => (id === 133 ? "Огненный шар" : undefined),
  item: (id) => (id === 4306 ? "Шелковая ткань" : undefined),
  quest: (id) => (id === 7777 ? "Из браузера" : undefined),
};

// Every id below has at least two digits; none may appear in a text.
const noIds = (text, ...ids) => {
  for (const id of ids) assert.doesNotMatch(text, new RegExp(`(^|\\D)${id}(\\D|$)`), `«${text}» prints ${id}`);
};

test("a failed quest is named from the quest cache, and asked for when it is not there", async () => {
  const { client, connection } = await world(NAMES);
  client.questTemplates.set(4321, { questId: 4321, title: "Горькая правда" });
  connection.push(OPCODES.SMSG_QUESTGIVER_QUEST_FAILED, new PacketWriter().u32(4321).u32(0).toUint8Array());
  await settle();
  assert.match(client.questMessage.text, /^Задание «Горькая правда»: /);
  noIds(client.questMessage.text, 4321);

  connection.push(OPCODES.SMSG_QUESTGIVER_QUEST_FAILED, new PacketWriter().u32(5555).u32(0).toUint8Array());
  await settle();
  assert.match(client.questMessage.text, /^Задание: /);
  noIds(client.questMessage.text, 5555);
  assert.equal(connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_QUEST_QUERY).length, 1, "the title is asked for once");

  connection.push(OPCODES.SMSG_QUESTGIVER_QUEST_COMPLETE,
    new PacketWriter().u32(7777).u32(300).i32(50).u32(0).u32(0).u32(0).toUint8Array());
  await settle();
  assert.match(client.questMessage.text, /^Задание «Из браузера» выполнено · опыт 300/);
  client.close();
});

test("QUEST_INVALID speaks every QuestFailedReason in the stock words", () => {
  const cases = [
    [1, "ERR_QUEST_FAILED_LOW_LEVEL"], [6, "ERR_QUEST_FAILED_WRONG_RACE"], [7, "ERR_QUEST_ALREADY_DONE"],
    [12, "ERR_QUEST_ONLY_ONE_TIMED"], [13, "ERR_QUEST_ALREADY_ON"], [16, "ERR_QUEST_FAILED_EXPANSION"],
    [18, "ERR_QUEST_ALREADY_ON"], [21, "ERR_QUEST_FAILED_MISSING_ITEMS"], [23, "ERR_QUEST_FAILED_NOT_ENOUGH_MONEY"],
    [27, "ERR_QUEST_FAILED_CAIS"], [29, "ERR_QUEST_ALREADY_DONE_DAILY"],
  ];
  const texts = new Set();
  for (const [code, key] of cases) {
    const text = questInvalidText(code);
    texts.add(text);
    const stock = globalString(key);
    if (stock !== undefined) assert.equal(text, stock.replace(/\\"/g, "\""), `code ${code} is ${key}`);
    assert.doesNotMatch(text, /код/);
  }
  assert.equal(texts.size, 10, "18 repeats 13; every other code has its own sentence");
  assert.match(questInvalidText(26), /25/, "the daily limit the core names");
  assert.equal(questInvalidText(0), "Задание недоступно.");
  assert.equal(questInvalidText(99), "Задание недоступно.");
});

test("zone, dungeon and reset messages carry the area's and the map's names", async () => {
  const { connection, messages } = await world(NAMES);
  connection.push(OPCODES.SMSG_ZONE_UNDER_ATTACK, new PacketWriter().u32(3703).toUint8Array());
  connection.push(OPCODES.SMSG_ZONE_UNDER_ATTACK, new PacketWriter().u32(4100).toUint8Array());
  for (const type of [RAID_INSTANCE_WARNING_HOURS, RAID_INSTANCE_WARNING_MIN, RAID_INSTANCE_WARNING_MIN_SOON,
    RAID_INSTANCE_WELCOME, RAID_INSTANCE_EXPIRED]) {
    connection.push(OPCODES.SMSG_RAID_INSTANCE_MESSAGE, new PacketWriter().u32(type).u32(533).u32(1).u32(7200).u8(0).u8(0).toUint8Array());
  }
  connection.push(OPCODES.SMSG_RAID_INSTANCE_MESSAGE, new PacketWriter().u32(RAID_INSTANCE_WARNING_MIN).u32(609).u32(0).u32(900).toUint8Array());
  connection.push(OPCODES.SMSG_INSTANCE_RESET, new PacketWriter().u32(533).toUint8Array());
  for (const reason of [0, 1, 2]) {
    connection.push(OPCODES.SMSG_INSTANCE_RESET_FAILED, new PacketWriter().u32(reason).u32(533).toUint8Array());
  }
  await settle();
  assert.equal(messages[0], "Зона «Шаттрат» атакована!");
  assert.equal(messages[1], "Зона атакована!");
  for (const text of messages.slice(2, 7)) assert.match(text, /Наксрамас/);
  assert.match(messages[2], /2/, "hours");
  assert.match(messages[3], /120/, "minutes");
  assert.match(messages[7], /подземелье/, "no name yet: the word");
  assert.match(messages[8], /Наксрамас/);
  assert.equal(new Set(messages.slice(9, 12)).size, 3, "each reset refusal says why");
  for (const text of messages) noIds(text, 3703, 4100, 533, 609);
});

test("an item pushed into the bags, a learned spell and cast statuses use their names", async () => {
  const { client, connection } = await world(NAMES);
  const push = (itemId) => new PacketWriter().u64(SELF).u32(0).u32(0).u32(1)
    .u8(255).i32(23).u32(itemId).u32(0).i32(0).u32(3).u32(3).toUint8Array();
  connection.push(OPCODES.SMSG_ITEM_PUSH_RESULT, push(4306));
  await settle();
  assert.equal(client.itemMessage.text, "Получено: Шелковая ткань ×3");
  connection.push(OPCODES.SMSG_ITEM_PUSH_RESULT, push(6948));
  await settle();
  assert.equal(client.itemMessage.text, "Получено: предмет ×3");

  client.trainer = { guid: 0x23n, trainerType: 0, greeting: "", spells: [] };
  client.state.objects.set(0x23n, {});
  connection.push(OPCODES.SMSG_TRAINER_BUY_SUCCEEDED, new PacketWriter().u64(0x23n).i32(133).toUint8Array());
  await settle();
  assert.match(client.merchantMessage.text, /Огненный шар/);
  noIds(client.merchantMessage.text, 133);
  client.trainer = { guid: 0x23n, trainerType: 0, greeting: "", spells: [] };
  connection.push(OPCODES.SMSG_TRAINER_BUY_SUCCEEDED, new PacketWriter().u64(0x23n).i32(9999).toUint8Array());
  await settle();
  assert.equal(client.merchantMessage.text, "Изучено новое заклинание.");
  client.close();
});

test("combat lines name the spell once a spell table is given, and the word when it has no row", async () => {
  const heal = (spellId) => new PacketWriter().packedGuid(SELF).packedGuid(SELF).u32(spellId)
    .u32(100).u32(0).u32(0).u8(0).u8(0).toUint8Array();
  const named = await world(NAMES);
  named.connection.push(OPCODES.SMSG_SPELLHEALLOG, heal(133));
  named.connection.push(OPCODES.SMSG_SPELLHEALLOG, heal(48782));
  await settle();
  assert.equal(named.combat[0], "Огненный шар: лечение 100");
  assert.equal(named.combat[1], "заклинание: лечение 100");
  named.client.close();

  // No spell table handed over yet: the form EnterWorld's spellLine rewrites stays, so no name is lost.
  const legacy = await world({ area: NAMES.area });
  legacy.connection.push(OPCODES.SMSG_SPELLHEALLOG, heal(133));
  await settle();
  assert.equal(legacy.combat[0], "заклинание 133: лечение 100");
  legacy.client.close();
});

test("guild events say the stock sentence with the names the core sends", () => {
  const plain = (text) => text.replace(/\|3-\d+\(([^)]*)\)/g, "$1");
  assert.match(plain(guildEventText(0, ["Анна", "Борис", "Ветеран"])), /Анна.*Борис.*Ветеран/);
  assert.match(plain(guildEventText(1, ["Анна", "Борис", "Рекрут"])), /Анна.*Борис.*Рекрут/);
  assert.match(guildEventText(3, ["Анна"]), /Анна/);
  assert.match(guildEventText(4, ["Анна"]), /Анна/);
  assert.match(plain(guildEventText(5, ["Борис", "Анна"])), /Анна.*Борис/, "the remover first, then the removed");
  assert.match(plain(guildEventText(7, ["Анна", "Борис"])), /Анна.*Борис/);
  assert.match(guildEventText(8, []), /распущена/);
  assert.equal(guildEventText(17, ["00000000000003E8"]), "Событие гильдии");
  for (const type of [0, 1, 3, 4, 5, 6, 7, 8, 12, 13, 14, 17]) noIds(guildEventText(type, ["Анна", "Борис", "Ветеран"]), type);
});

test("instance messages are the stock RAID_INSTANCE_* and INSTANCE_RESET_* sentences once generated", () => {
  // The generator carries these by name (EXTRA_STRINGS); a clean checkout has no table and the
  // client's own wording stands in, so each stock comparison runs only where the table has the key.
  const stock = (key, args) => (globalString(key) === undefined ? undefined : formatGlobalString(globalString(key), args));
  const cases = [
    [raidInstanceText(RAID_INSTANCE_WARNING_HOURS, "Наксрамас", 7200), "RAID_INSTANCE_WARNING_HOURS", ["Наксрамас", 2]],
    [raidInstanceText(RAID_INSTANCE_WARNING_MIN, "Наксрамас", 900), "RAID_INSTANCE_WARNING_MIN", ["Наксрамас", 15]],
    [raidInstanceText(RAID_INSTANCE_WARNING_MIN_SOON, "Наксрамас", 300), "RAID_INSTANCE_WARNING_MIN_SOON", ["Наксрамас", 5]],
    [raidInstanceText(RAID_INSTANCE_WELCOME, "Наксрамас", 90_061), "RAID_INSTANCE_WELCOME", ["Наксрамас", secondsToTimeText(90_061)]],
    [raidInstanceText(RAID_INSTANCE_EXPIRED, "Наксрамас", 0), "RAID_INSTANCE_EXPIRED", ["Наксрамас"]],
    [instanceResetText("Наксрамас"), "INSTANCE_RESET_SUCCESS", ["Наксрамас"]],
    [instanceResetFailedText(0, "Наксрамас"), "INSTANCE_RESET_FAILED", ["Наксрамас"]],
    [instanceResetFailedText(1, "Наксрамас"), "INSTANCE_RESET_FAILED_OFFLINE", ["Наксрамас"]],
    [instanceResetFailedText(2, "Наксрамас"), "INSTANCE_RESET_FAILED_ZONING", ["Наксрамас"]],
  ];
  for (const [text, key, args] of cases) {
    assert.match(text, /Наксрамас/, key);
    assert.doesNotMatch(text, /\\|%[sd]/, `${key} is filled and unescaped`);
    const expected = stock(key, args);
    if (expected !== undefined) assert.equal(text, expected, key);
  }
  if (globalString("RAID_INSTANCE_WARNING_HOURS") !== undefined) {
    assert.match(cases[0][0], /2 часа/, "the |4 plural agrees with the hours");
  }
});

test("a lock's remaining time is SecondsToTime(seconds, nil, 1): at most two units, days and hours first", () => {
  const word = (key, fallback, value) => formatGlobalString(globalString(key) ?? fallback, [value]);
  const space = formatGlobalString(globalString("TIME_UNIT_DELIMITER") ?? " ");
  assert.equal(space, " ", "TIME_UNIT_DELIMITER is \\32, a space");
  assert.equal(secondsToTimeText(90_061), `${word("D_DAYS", "%d д.", 1)} ${word("D_HOURS", "%d ч.", 1)}`,
    "1 d 1 h 1 min 1 s keeps the first two units");
  assert.equal(secondsToTimeText(3_725), `${word("D_HOURS", "%d ч.", 1)} ${word("D_MINUTES", "%d мин.", 2)}`);
  assert.equal(secondsToTimeText(65), `${word("D_MINUTES", "%d мин.", 1)} ${word("D_SECONDS", "%d с", 5)}`);
  assert.equal(secondsToTimeText(7_200), word("D_HOURS", "%d ч.", 2));
  assert.equal(secondsToTimeText(0), "");
});

test("the zone-under-attack line never shows the stock string's colour codes or an undeclined case", () => {
  for (const text of [zoneUnderAttackText("Штормград"), zoneUnderAttackText(undefined)]) {
    assert.doesNotMatch(text, /\|c|\|r|\|3-/);
  }
  assert.match(zoneUnderAttackText("Штормград"), /Штормград/);
});
