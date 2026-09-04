import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { buildSocketGems } from "../dist/code/world/ItemProtocol.js";
import { parseSocketGems } from "../dist/code/world/CharacterProgressProtocol.js";
import { game } from "../dist/code/browser/game/Context.js";
import { ItemMetadataClient } from "../dist/code/browser/ItemMetadata.js";
import { gemFitsSocket, itemSocketColors, itemEnchantments } from "../dist/code/browser/ItemEnchantments.js";
import { openSocketing, openSocketingFromLua, newSocketInfoFromLua, closeSocketing, socketingOpen } from "../dist/code/browser/ui/Socketing.js";
import { usePanelHost } from "../dist/code/browser/ui/Widgets.js";
import { itemTooltipFor } from "../dist/code/browser/ui/ItemTooltip.js";
import { startGateway } from "../dist/code/gateway/Gateway.js";

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
function connection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      const packet = { opcode, payload };
      if (wake) { const deliver = wake; wake = undefined; deliver(packet); } else queue.push(packet);
    },
    send(opcode, payload) { this.sent.push({ opcode, payload }); },
    read() { return queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => { wake = resolve; }); },
    close() {},
  };
}
function node(tag) {
  const events = new Map();
  return {
    tagName: tag.toUpperCase(), children: [], style: {}, dataset: {}, hidden: false, textContent: "", disabled: false,
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    setAttribute() {}, addEventListener(type, callback) { events.set(type, callback); }, remove() {},
    dispatchEvent(event) { events.get(event.type)?.(event); },
    click() { if (!this.disabled) events.get("click")?.({}); },
    classList: { add() {}, remove() {}, toggle() {} },
  };
}
const all = (root) => [root, ...root.children.flatMap(all)];
const text = (root) => root.textContent + root.children.map(text).join(" ");
const click = (root, label) => {
  const control = all(root).find((item) => item.tagName === "BUTTON" && item.textContent === label);
  assert.ok(control, `Missing button: ${label}`); control.click(); return control;
};
const object = (guid, fields) => ({ guid, fields: new Map(fields) });

function updateValues(writer, fields) {
  const ordered = [...fields].sort(([left], [right]) => left - right);
  const blocks = Math.floor(ordered.at(-1)[0] / 32) + 1;
  const masks = Array(blocks).fill(0);
  for (const [field] of ordered) masks[Math.floor(field / 32)] |= 1 << (field % 32);
  writer.u8(blocks);
  for (const mask of masks) writer.u32(mask >>> 0);
  for (const [, value] of ordered) writer.u32(value);
  return writer;
}

test("socket wire format preserves untouched sockets and refuses duplicate gem instances", () => {
  const packet = buildSocketGems(0xf000000012345678n, [0x4000000098765432n, 0n, 91n]);
  assert.equal(packet.length, 32);
  const view = new DataView(packet.buffer, packet.byteOffset);
  assert.deepEqual([0, 8, 16, 24].map((offset) => view.getBigUint64(offset, true)),
    [0xf000000012345678n, 0x4000000098765432n, 0n, 91n]);
  assert.throws(() => buildSocketGems(1n, [2n, 2n, 0n]), /distinct/);
  assert.throws(() => buildSocketGems(1n, [0n, 0n, 0n]), /distinct/);
  assert.throws(() => buildSocketGems(1n, [1n, 0n, 0n]), /GUID/);
  assert.throws(() => parseSocketGems(new PacketWriter().u64(1n).toUint8Array()), /underflow/);
  assert.equal(gemFitsSocket(2, 8), true, "a normal colour mismatch is permitted by Trinity, losing only the bonus");
  assert.equal(gemFitsSocket(1, 8), false);
  assert.equal(gemFitsSocket(8, 1), false);
  assert.deepEqual(itemSocketColors([{ color: 2 }, { color: 0 }, { color: 0 }], [0, 0, 0, 0, 0, 0, 3723]), [2, 14, 0]);
});

test("the actual socketing window splits stacks safely, handles delayed metadata, and confirms only real item GUIDs", async () => {
  const oldDocument = globalThis.document;
  const oldFetch = globalThis.fetch;
  const saved = { world: game.world, gatewayOrigin: game.gatewayOrigin, itemMetadata: game.itemMetadata };
  const viewport = node("main");
  globalThis.document = { createElement: node, body: viewport };
  usePanelHost({ viewport, attach() {} });
  const transport = connection();
  const world = new WorldClient(transport);
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  await world.loginCharacter(1n);
  const equipment = object(2n, [[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 100],
    [UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + 6, 501]]);
  const loose = object(3n, [[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 200], [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 1]]);
  const stacked = object(4n, [[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 201], [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 2]]);
  // The user's retained ability gem: item_template still has this ID, while its DBC row is absent.
  const orphaned = object(6n, [[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 65827], [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 1]]);
  const player = object(1n, [[UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset, 2],
    [UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, 3], [UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 2, 4],
    [UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 26, 6]]);
  world.state.selfGuid = 1n;
  for (const item of [player, equipment, loose, stacked, orphaned]) world.state.objects.set(item.guid, item);
  const base = { found: true, itemLevel: 1, flags: 0, maxCount: 0, bonding: 0, inventoryType: 1, damage: [], delay: 0,
    resistances: [], stats: [], requiredLevel: 1, maxDurability: 0, spells: [], requiredSkill: 0,
    requiredReputationFaction: 0, allowableClass: -1, allowableRace: -1, startQuest: 0, sellPrice: 0,
    description: "", stackable: 1, quality: 3, socketBonus: 0, gemProperties: 0, sockets: [] };
  world.itemTemplates.set(100, { ...base, entry: 100, name: "Шлем мастера", sockets: [{ color: 2 }, { color: 4 }, { color: 0 }], socketBonus: 700 });
  world.itemTemplates.set(200, { ...base, entry: 200, name: "Новый самоцвет", gemProperties: 50 });
  world.itemTemplates.set(201, { ...base, entry: 201, name: "Стопка самоцветов", gemProperties: 50 });
  world.itemTemplates.set(202, { ...base, entry: 202, name: "Старый самоцвет", gemProperties: 51 });
  world.itemTemplates.set(65827, { ...base, entry: 65827, name: "Попятиться Gem", itemClass: 3, subClass: 8, gemProperties: 7635 });
  const rows = [100, 200, 201, 202, 65827].map((entry) => ({ entry, name: world.itemTemplates.get(entry).name, quality: 3,
    displayId: 1, inventoryType: 0, stackable: 1, iconId: 0 }));
  const data = { gems: [{ id: 50, enchantmentId: 502, color: 8 }, { id: 51, enchantmentId: 501, color: 2 }],
    enchantments: [{ id: 501, name: "+12 силы", gemItemId: 202, conditionId: 0 },
      { id: 502, name: "+20 силы", gemItemId: 200, conditionId: 0 }, { id: 700, name: "+4 выносливости", gemItemId: 0, conditionId: 0 }] };
  globalThis.fetch = async (url) => ({ ok: true, json: async () => String(url).includes("/dbc/") ? data : rows });
  game.world = world;
  game.gatewayOrigin = "http://socketing-test.invalid";
  game.itemMetadata = new ItemMetadataClient("ws://socketing-test.invalid/world");
  await game.itemMetadata.load(rows.map((row) => row.entry));
  await itemEnchantments(game.gatewayOrigin).load();
  try {
    assert.equal(openSocketingFromLua(0, 0, 1), true);
    await settle();
    const root = viewport.children.find((item) => item.id === "socketing-window");
    assert.match(text(root), /Старый самоцвет/);
    assert.match(text(root), /Бонус за гнёзда: \+4 выносливости \(неактивен\)/);
    const missingGem = all(root).find((item) => item.dataset.gem === "6");
    assert.ok(missingGem, "A carried count-one ability gem must remain visible when its GemProperties row is missing");
    assert.equal(missingGem.disabled, true, "Unknown gem data cannot be guessed from its subclass");
    assert.match(text(missingGem), /нет в активной сборке/);
    missingGem.click();
    assert.equal(transport.sent.filter((packet) => packet.opcode === OPCODES.CMSG_SOCKET_GEMS).length, 0);
    assert.match(itemTooltipFor(65827).lines.map((line) => line.text).join("\n"), /нет в активной сборке/);
    // A later corrected dataset is read again, without reloading the tab or fabricating properties.
    data.gems.push({ id: 7635, enchantmentId: 90001, color: 14 });
    data.enchantments.push({ id: 90001, name: "Обучает: Попятиться", gemItemId: 65827, conditionId: 0 });
    click(root, "Обновить сведения о камнях");
    await settle();
    assert.equal(all(root).find((item) => item.dataset.gem === "6").disabled, false);
    all(root).find((item) => item.dataset.gem === "6").click();
    click(root, "Установить камни");
    click(root, "Подтвердить установку");
    assert.deepEqual(transport.sent.find((packet) => packet.opcode === OPCODES.CMSG_SOCKET_GEMS).payload, buildSocketGems(2n, [6n, 0n, 0n]));
    assert.equal(world.state.objects.has(6n), true, "The restored gem is not consumed optimistically");
    transport.push(OPCODES.SMSG_SOCKET_GEMS_RESULT, new PacketWriter().u64(2n).u32(90001).u32(0).u32(0).u32(0).toUint8Array());
    await settle();
    transport.sent.length = 0;
    equipment.fields.set(UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + 6, 501);
    const loadedGem = world.itemTemplates.get(200);
    const loadedStack = world.itemTemplates.get(201);
    world.itemTemplates.delete(200);
    world.itemTemplates.delete(201);
    world.events.emit("QUERY_CACHE_CHANGED", { kind: "cleared", id: 0 });
    assert.match(text(root), /предметах в сумках загружаются/);
    assert.doesNotMatch(text(root), /В сумках нет камней/);
    world.itemTemplates.set(200, loadedGem);
    world.itemTemplates.set(201, loadedStack);
    world.events.emit("QUERY_CACHE_CHANGED", { kind: "item", id: 201 });

    const gearTemplate = world.itemTemplates.get(100);
    world.itemTemplates.set(100, { ...gearTemplate, sockets: [{ color: 0 }, { color: 2 }, { color: 0 }] });
    world.events.emit("QUERY_CACHE_CHANGED", { kind: "item", id: 100 });
    assert.equal(all(root).find((item) => item.className?.includes("socketing-socket selected"))?.dataset.socket, "1");
    assert.ok(all(root).find((item) => item.dataset.gem === "3"), "The first actual socket must allow a carried gem to be chosen");
    world.itemTemplates.set(100, gearTemplate);
    world.events.emit("QUERY_CACHE_CHANGED", { kind: "item", id: 100 });
    all(root).find((item) => item.dataset.socket === "0").click();
    const stackedButton = all(root).find((item) => item.dataset.gem === "4");
    assert.equal(stackedButton.disabled, false, "A gem stack must offer a safe one-gem split instead of an unusable disabled row");
    stackedButton.click();
    assert.match(text(root), /Отделить 1 камень/);
    assert.equal(transport.sent.filter((packet) => packet.opcode === OPCODES.CMSG_SOCKET_GEMS).length, 0);
    // A free specialty bag cannot be used as a split destination when the backpack is full.
    const herbBag = object(7n, [[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 300], [UPDATE_FIELDS.CONTAINER_FIELD_NUM_SLOTS.offset, 2]]);
    world.state.objects.set(7n, herbBag);
    world.itemTemplates.set(300, { ...base, entry: 300, name: "Сумка травника", itemClass: 1, subClass: 2 });
    player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + 38, 7);
    for (let offset = 4; offset < 32; offset += 2) if (offset !== 26) player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + offset, 9);
    click(root, "Отделить 1 камень");
    assert.equal(transport.sent.filter((packet) => packet.opcode === OPCODES.CMSG_SPLIT_ITEM).length, 0);
    assert.match(text(root), /Освободите одну ячейку/);
    for (let offset = 4; offset < 32; offset += 2) if (offset !== 26) player.fields.delete(UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + offset);
    click(root, "Отделить 1 камень");
    const splits = transport.sent.filter((packet) => packet.opcode === OPCODES.CMSG_SPLIT_ITEM);
    assert.equal(splits.length, 1);
    assert.deepEqual([...splits[0].payload], [255, 24, 255, 25, 1, 0, 0, 0]);
    assert.equal(newSocketInfoFromLua(0, 0, 1, 1), "Выбранный камень", "Extraction must wait for the staged split");
    assert.equal(transport.sent.filter((packet) => packet.opcode === OPCODES.CMSG_SOCKET_GEMS).length, 0);
    assert.match(text(root), /Ожидание.*разделения/);

    // Only the server changes the original count and publishes the new item GUID.
    const changes = new PacketWriter().u32(3);
    updateValues(changes.u8(0).packedGuid(4n), [[UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 1]]);
    updateValues(changes.u8(2).packedGuid(5n).u8(1).u16(0), [[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 201], [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 1]]);
    updateValues(changes.u8(0).packedGuid(1n), [[UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 4, 5], [UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 5, 0]]);
    transport.push(OPCODES.SMSG_UPDATE_OBJECT, changes.toUint8Array());
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.match(text(root), /Камень отделён/);
    assert.equal(transport.sent.filter((packet) => packet.opcode === OPCODES.CMSG_SOCKET_GEMS).length, 0, "Splitting never auto-applies a gem");
    click(root, "Установить камни");
    click(root, "Подтвердить установку");
    assert.deepEqual(transport.sent.find((packet) => packet.opcode === OPCODES.CMSG_SOCKET_GEMS).payload, buildSocketGems(2n, [5n, 0n, 0n]));
    transport.push(OPCODES.SMSG_SOCKET_GEMS_RESULT, new PacketWriter().u64(2n).u32(502).u32(0).u32(0).u32(0).toUint8Array());
    await settle();
    transport.sent.length = 0;
    equipment.fields.set(UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + 6, 501);
    all(root).find((item) => item.dataset.gem === "3").click();
    assert.equal(newSocketInfoFromLua(0, 0, 1, 1), "Выбранный камень", "OP85 addon can detect pending replacements");
    assert.match(text(root), /заменяемые уничтожаются/);
    click(root, "Установить камни");
    assert.equal(transport.sent.filter((packet) => packet.opcode === OPCODES.CMSG_SOCKET_GEMS).length, 0);
    click(root, "Подтвердить установку");
    assert.equal(transport.sent.filter((packet) => packet.opcode === OPCODES.CMSG_SOCKET_GEMS).length, 1);
    assert.deepEqual(transport.sent.find((packet) => packet.opcode === OPCODES.CMSG_SOCKET_GEMS).payload, buildSocketGems(2n, [3n, 0n, 0n]));
    assert.match(text(root), /Ожидание подтверждения сервера/);
    assert.equal(equipment.fields.get(UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + 6), 501, "no optimistic replacement");
    assert.equal(world.state.objects.has(3n), true, "no optimistic gem consumption");
    transport.push(OPCODES.SMSG_SOCKET_GEMS_RESULT, new PacketWriter().u64(2n).u32(502).u32(0).u32(0).u32(0).toUint8Array());
    await settle();
    assert.match(text(root), /Камни установлены/);
    assert.equal(equipment.fields.get(UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + 6), 502);
    assert.equal(newSocketInfoFromLua(0, 0, 1, 1), undefined);
    const tooltip = itemTooltipFor(100, { enchantments: [0, 0, 502, 0, 0, 0, 0] });
    assert.match(tooltip.lines.map((line) => line.text).join("\n"), /Новый самоцвет.*\+20 силы/);

    all(root).find((item) => item.dataset.gem === "3").click();
    click(root, "Установить камни");
    click(root, "Подтвердить установку");
    transport.push(OPCODES.SMSG_INVENTORY_CHANGE_FAILURE, new PacketWriter().u8(50).u64(2n).u64(0n).u8(0).toUint8Array());
    await settle();
    assert.match(text(root), /заполнен/i);
    assert.doesNotMatch(text(root), /Камни установлены/);
    assert.equal(equipment.fields.get(UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + 6), 502);

    all(root).find((item) => item.dataset.gem === "3").click();
    click(root, "Установить камни");
    player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset, 9);
    world.state.objects.set(9n, object(9n, [...equipment.fields]));
    click(root, "Подтвердить установку");
    assert.equal(transport.sent.filter((packet) => packet.opcode === OPCODES.CMSG_SOCKET_GEMS).length, 2, "same entry in same slot with a different GUID cannot inherit a staged request");
    closeSocketing();
    assert.equal(socketingOpen(), false);
    assert.equal(world.events.listenerCount("SOCKET_GEMS_RESULT"), 0);
    assert.equal(openSocketing({ bag: 255, slot: 39, guid: 9n, item: equipment }), false);
  } finally {
    closeSocketing(); world.close();
    Object.assign(game, saved); globalThis.fetch = oldFetch; globalThis.document = oldDocument;
  }
});

function dbc(fieldCount, rows, strings = Buffer.from([0])) {
  const buffer = Buffer.alloc(20 + rows.length * fieldCount * 4 + strings.length);
  buffer.write("WDBC");
  [rows.length, fieldCount, fieldCount * 4, strings.length].forEach((value, index) => buffer.writeUInt32LE(value, 4 + index * 4));
  rows.forEach((row, index) => row.forEach((value, column) => buffer.writeUInt32LE(value, 20 + (index * fieldCount + column) * 4)));
  strings.copy(buffer, buffer.length - strings.length); return buffer;
}

test("the gateway serves localized socket properties and custom enchantments from the active dataset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-socketing-"));
  const english = Buffer.from("Strength\0");
  const russian = Buffer.from("Сила\0");
  const strings = Buffer.concat([Buffer.from([0]), english, russian]);
  const enchantment = Array(38).fill(0);
  enchantment[0] = 100001; enchantment[14] = 1; enchantment[22] = 1 + english.length; enchantment[33] = 700001;
  await writeFile(join(directory, "SpellItemEnchantment.dbc"), dbc(38, [enchantment], strings));
  await writeFile(join(directory, "GemProperties.dbc"), dbc(5, [[10001, 100001, 0, 0, 14]]));
  const gateway = await startGateway({ host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 }, allowedOrigins: ["http://localhost:5173"], dbcDirectory: directory, datasetPollMs: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/dbc/item-enchantments`, { headers: { origin: "http://localhost:5173" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { enchantments: [{ id: 100001, name: "Сила", gemItemId: 700001, conditionId: 0 }],
      gems: [{ id: 10001, enchantmentId: 100001, color: 14 }] });
    // The route must discard the memoized index after a build replaces gameplay DBC rows.
    await writeFile(join(directory, "GemProperties.dbc"), dbc(5, [[10002, 100001, 0, 0, 2], [10003, 100001, 0, 0, 8]]));
    const changed = await fetch(`http://127.0.0.1:${gateway.port}/dbc/item-enchantments`, { headers: { origin: "http://localhost:5173" } }).then((reply) => reply.json());
    assert.deepEqual(changed.gems.map((gem) => gem.id), [10002, 10003]);
  } finally { await gateway.close(); await rm(directory, { recursive: true }); }
});
