// 4.07: Shift+click on a vendor's item buys a number of purchases (stock SPLITSTACK), and the
// auction house asks before a bid or a buyout leaves (stock BID_AUCTION / BUYOUT_AUCTION).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isolatedUi } from "./fixtures/isolated-ui.mjs";

const { vendorMaxUnits, vendorTotal, VENDOR_COUNT_LIMIT } = await import("../dist/code/browser/ui/VendorQuantity.js");

const base = { stackable: 20, buyCount: 1, leftInStock: -1, price: 100, extendedCost: 0, money: 1_000_000 };

test("the most purchases: a stack, the vendor's stock and the purse; a pack row is one (Wow.exe 0x005842d0)", () => {
  assert.equal(vendorMaxUnits({ ...base, money: 1500 }), 15, "the purse");
  // GetMerchantItemMaxStack answers 1 for a row whose BuyCount is 2 or more, the item's stack otherwise.
  assert.equal(vendorMaxUnits({ ...base, buyCount: 5 }), 1, "a row sold in fives is not split");
  assert.equal(vendorMaxUnits({ ...base, stackable: 1000, buyCount: 200, money: 1e12 }), 1, "a pack of arrows");
  assert.equal(vendorMaxUnits({ ...base, leftInStock: 10 }), 10, "ten left");
  assert.equal(vendorMaxUnits({ ...base, stackable: 1000, money: 1e12 }), VENDOR_COUNT_LIMIT, "the uint8 count");
  assert.equal(vendorMaxUnits({ ...base, extendedCost: 7, money: 0 }), 20, "a special price is the server's to check");
  assert.equal(vendorMaxUnits({ ...base, stackable: 1 }), 1, "a non-stacking item: no quantity window");
  assert.equal(vendorMaxUnits({ ...base, stackable: 200, buyCount: 200 }), 1, "a pack that is a whole stack");
  assert.equal(vendorMaxUnits({ ...base, money: 0 }), 1, "never below one");
  assert.equal(vendorTotal(150, 4), 600);
});

test("a vendor row: Shift+click opens the quantity panel, a plain click buys one", async () => {
  const source = await readFile(new URL("../src/browser/ui/Npc.ts", import.meta.url), "utf8");
  assert.match(source, /const max = event\.shiftKey \? vendorMaxUnits\(/);
  // Stock MerchantItemButton_OnModifiedClick opens nothing and buys nothing when the most is 1.
  assert.match(source, /if \(max <= 1\) \{\s+if \(!event\.shiftKey\) world\.buyFromVendor\(item\.slot, 1\);/);
  assert.match(source, /onConfirm: \(units\) => world\.buyFromVendor\(slot, units\)/);
});

function node(tag = "div") {
  const listeners = new Map();
  const n = {
    tagName: tag.toUpperCase(), children: [], dataset: {}, className: "", textContent: "", listeners, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    append(...children) { n.children.push(...children); }, replaceChildren(...children) { n.children = children; },
    addEventListener(name, handler) { listeners.set(name, handler); }, setAttribute() {}, getAttribute: () => null,
    removeAttribute() {},
  };
  return n;
}

test("auction bid and buyout ask first, with the sum, and send once on accept; the bids tab raises a bid at once", async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: node, getElementById: () => node(), querySelector: () => node() };
  try {
    const asked = [];
    const format = await import("../dist/code/browser/ui/Format.js");
    const social = await isolatedUi("Social", {
      "./Widgets.js": { attachTooltip() {}, setTip() {}, confirmPanel: (anchor, options) => asked.push({ anchor, options }) },
      "./Format.js": format,
      "./Strings.js": { nativeString: (_key, fallback) => fallback },
      "../game/Context.js": { game: {} },
      // suite-fix: L7 4.14 constructs the LFG queue clock at module load; a stub is no constructor.
      "./LfgQueueClock.js": await import("../dist/code/browser/ui/LfgQueueClock.js"),
    });
    const bids = [];
    const world = { itemTemplate: () => ({ name: "Меч" }), bidOnAuction: (id, amount) => bids.push([id, amount]) };
    const entry = { auctionId: 77, itemId: 1, count: 1, bid: 0, startBid: 1000, buyout: 5000, timeLeft: 60_000, bidder: 0n };
    const box = social.auctionEntryBox(entry, false, world);
    const [bid, buyout] = box.children.filter((child) => child.tagName === "BUTTON");
    bid.listeners.get("click")();
    assert.deepEqual(bids, [], "a click alone sends nothing");
    assert.equal(asked.length, 1);
    assert.equal(asked[0].options.title, "Ставка на аукционе:");
    asked[0].options.onConfirm();
    assert.equal(bids.length, 1);
    assert.equal(bids[0][0], 77);
    buyout.listeners.get("click")();
    assert.equal(asked[1].options.title, "Выкупить товар за:");
    assert.equal(asked[1].options.lines[0], format.formatMoney(5000));
    asked[1].options.onConfirm();
    assert.deepEqual(bids[1], [77, 5000]);
    social.setAuctionTab("bids");
    const again = social.auctionEntryBox(entry, false, world);
    again.children.filter((child) => child.tagName === "BUTTON")[0].listeners.get("click")();
    assert.equal(bids.length, 3, "the bids tab's «Ставка» does not ask (Blizzard_AuctionUI.xml:1238)");
    assert.equal(asked.length, 2);
  } finally {
    globalThis.document = previous;
  }
});

test("the quantity field clamps what is typed to 1..max", async () => {
  const { installFakeUiDocument } = await import("./fixtures/fake-ui-document.mjs");
  const previous = globalThis.document;
  installFakeUiDocument();
  try {
    const { clampQuantity } = await import("../dist/code/browser/ui/Widgets.js");
    assert.equal(clampQuantity("7", 15), 7);
    assert.equal(clampQuantity("70", 15), 15);
    assert.equal(clampQuantity("0", 15), 1);
    assert.equal(clampQuantity("-3", 15), 1);
    assert.equal(clampQuantity("abc", 15), 1);
    assert.equal(clampQuantity(4.8, 15), 4);
  } finally {
    globalThis.document = previous;
  }
});
