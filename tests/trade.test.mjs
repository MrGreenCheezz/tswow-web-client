import assert from "node:assert/strict";
import test from "node:test";
import {
  TRADE_SLOT_COUNT,
  TRADE_STATUS_BEGIN_TRADE,
  TRADE_STATUS_CLOSE_WINDOW,
  TRADE_STATUS_OPEN_WINDOW,
  TRADE_STATUS_TRADE_ACCEPT,
  buildClearTradeItem,
  buildInitiateTrade,
  buildSetTradeGold,
  buildSetTradeItem,
  parseTradeStatus,
  parseTradeStatusExtended,
  tradeGoldToCopper,
  tradeStatusText,
} from "../dist/code/world/TradeProtocol.js";
import {
  buildDuelResponse,
  parseDuelComplete,
  parseDuelCountdown,
  parseDuelRequested,
  parseDuelWinner,
} from "../dist/code/world/DuelProtocol.js";

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

test("trade status only carries a body for some statuses", () => {
  const begin = parseTradeStatus(bytes(u32(TRADE_STATUS_BEGIN_TRADE), u64(0x77n)));
  assert.equal(begin.status, TRADE_STATUS_BEGIN_TRADE);
  assert.equal(begin.traderGuid, 0x77n);

  const open = parseTradeStatus(bytes(u32(TRADE_STATUS_OPEN_WINDOW), u32(0)));
  assert.equal(open.status, TRADE_STATUS_OPEN_WINDOW);
  assert.equal(open.traderGuid, 0n);

  const close = parseTradeStatus(bytes(u32(TRADE_STATUS_CLOSE_WINDOW), u32(50), u8(1), u32(3)));
  assert.equal(close.result, 50);
  assert.equal(close.targetResult, true);
  assert.equal(close.itemLimitCategoryId, 3);

  // Most statuses are the status word alone.
  const accept = parseTradeStatus(u32(TRADE_STATUS_TRADE_ACCEPT));
  assert.equal(accept.status, TRADE_STATUS_TRADE_ACCEPT);
  assert.match(tradeStatusText(10), /далеко/i);
  assert.equal(tradeStatusText(TRADE_STATUS_OPEN_WINDOW), "");
});

// SendUpdateTrade writes all seven slots at a fixed 72 bytes each, zero filled when empty.
function tradeExtended({ traderData = false, money = 0, spell = 0, items = {} }) {
  const parts = [u8(traderData ? 1 : 0), u32(0), u32(TRADE_SLOT_COUNT), u32(TRADE_SLOT_COUNT), u32(money), u32(spell)];
  for (let slot = 0; slot < TRADE_SLOT_COUNT; slot++) {
    parts.push(u8(slot));
    const item = items[slot];
    if (!item) {
      for (let field = 0; field < 18; field++) parts.push(u32(0));
      continue;
    }
    parts.push(u32(item.itemId), u32(item.displayId ?? 0), u32(item.count ?? 1), u32(0));
    parts.push(u64(0n), u32(0), u32(0), u32(0), u32(0), u64(0n));
    parts.push(u32(0), u32(0), u32(0), u32(0), u32(item.maxDurability ?? 0), u32(item.durability ?? 0));
  }
  return bytes(...parts);
}

test("the extended trade window decodes every filled slot and skips the empty ones", () => {
  const payload = tradeExtended({
    traderData: true,
    money: 12345,
    items: { 0: { itemId: 2589, count: 5 }, 3: { itemId: 25, count: 1, maxDurability: 55, durability: 40 } },
  });
  assert.equal(payload.length, 1 + 4 * 5 + TRADE_SLOT_COUNT * 73);

  const offer = parseTradeStatusExtended(payload);
  assert.equal(offer.traderData, true);
  assert.equal(offer.money, 12345);
  assert.equal(offer.items.length, 2);
  assert.deepEqual(offer.items.map((item) => [item.slot, item.itemId, item.count]), [[0, 2589, 5], [3, 25, 1]]);
  assert.equal(offer.items[1].maxDurability, 55);
  assert.equal(offer.items[1].durability, 40);
});

test("an entirely empty trade window decodes to nothing", () => {
  const offer = parseTradeStatusExtended(tradeExtended({}));
  assert.deepEqual(offer.items, []);
  assert.equal(offer.money, 0);
  assert.equal(offer.traderData, false);
});

test("client trade packets match their handlers", () => {
  assert.equal(buildInitiateTrade(1n).length, 8);
  // HandleSetTradeItemOpcode reads the trade slot, then the bag and the slot inside it.
  assert.deepEqual([...buildSetTradeItem(2, 255, 24)], [2, 255, 24]);
  assert.deepEqual([...buildClearTradeItem(2)], [2]);
  assert.deepEqual([...buildSetTradeGold(500)], [...u32(500)]);
  assert.equal(tradeGoldToCopper(1), 10_000, "one gold in the UI is not one copper on the wire");
  assert.equal(tradeGoldToCopper(0.0001), 1);
  assert.equal(tradeGoldToCopper(1e9), 0x7fffffff, "the core caps money at signed 32-bit maximum");
});

test("duel packets decode", () => {
  // The duel flag gameobject comes first, then whoever planted it.
  const request = parseDuelRequested(bytes(u64(0xf110_0000_0000_0009n), u64(0x42n)));
  assert.equal(request.flagGuid, 0xf110_0000_0000_0009n);
  assert.equal(request.challengerGuid, 0x42n);

  assert.equal(parseDuelCountdown(u32(3000)), 3000);
  assert.equal(parseDuelComplete(u8(1)), true);
  assert.equal(parseDuelComplete(u8(0)), false, "interrupted");

  const winner = parseDuelWinner(bytes(u8(1), cstr("Тралл"), cstr("Джайна")));
  assert.deepEqual(winner, { fled: true, winner: "Тралл", loser: "Джайна" });

  // Both the accept and the cancel opcode carry the flag guid.
  assert.equal(buildDuelResponse(0x9n).length, 8);
});
