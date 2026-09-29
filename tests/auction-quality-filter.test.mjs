// Small native fixes (WORK_PLAN 1.31): the auction rarity filter, and a guild rank's daily gold
// allowance.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isolatedUi } from "./fixtures/isolated-ui.mjs";

const format = await import("../dist/code/browser/ui/Format.js");
const guildModel = await import("../dist/code/browser/ui/GuildModel.js");

/** One `<select>` of index.html: the text of its `<label>`, its attributes, and its options. */
async function selectOf(id) {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const found = new RegExp(`<label>([^<]*)<select id="${id}"([^>]*)>([\\s\\S]*?)</select>`).exec(html);
  assert.ok(found, `index.html has a labelled #${id}`);
  const [, label, attributes, body] = found;
  return {
    label: label.trim(),
    ariaLabel: /aria-label="([^"]*)"/.exec(attributes)?.[1],
    count: body.match(/<option\b/g)?.length ?? 0,
    options: [...body.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(([, value, text]) => [value, text]),
  };
}

test("the auction rarity filter offers what stock BrowseDropDown offers, value n labelled quality n", async () => {
  // Stock BrowseDropDown_Initialize (Blizzard_AuctionUI.lua:424-437): ALL at -1, then qualities
  // 0 to getn(ITEM_QUALITY_COLORS)-2 — the colours are filled for -1..6 (UIParent.lua:97), so 0..4 —
  // each labelled ITEM_QUALITYn_DESC (ruRU GlobalStrings.lua:526, :4490-4494). The core matches the
  // quality exactly (AuctionHouseMgr.cpp:765), so the label of value n has to be quality n.
  const select = await selectOf("auction-quality");
  assert.equal(select.label, "Качество", "RARITY, GlobalStrings.lua:6019");
  assert.equal(select.ariaLabel, "Качество");
  assert.equal(select.count, 6);
  assert.deepEqual(select.options, [
    ["-1", "Все"], ["0", "Низкое"], ["1", "Обычное"], ["2", "Необычное"], ["3", "Редкое"], ["4", "Превосходное"],
  ]);
});

test("a guild rank's daily gold allowance reads the way the core applies it", async () => {
  const guild = await isolatedUi("Guild", { "./Format.js": format, "./GuildModel.js": guildModel });
  const { GR_RIGHT_GCHATLISTEN, GR_RIGHT_WITHDRAW_GOLD, GR_RIGHT_WITHDRAW_REPAIR } = guildModel;
  const text = (rankId, rights, limit) => guild.withdrawGoldLimitText(rankId, rights, limit);
  // Guild::_GetMemberRemainingMoney (Guild.cpp:2606-2618): the master (rank 0) is unlimited whatever
  // the stored value (SetBankMoneyPerDay forces it, Guild.cpp:333-336); any other rank needs the
  // withdraw-gold or the withdraw-for-repair right, and its limit is read as int32 (Guild.h:485), so
  // 0 and anything from 2^31 up leave nothing to take.
  assert.equal(text(0, 0, 0xffff_ffff), "снятие золота без ограничений");
  assert.equal(text(0, 0, 0), "снятие золота без ограничений", "the master whatever is stored");
  assert.equal(text(1, GR_RIGHT_WITHDRAW_GOLD, 0xffff_ffff), "снятие золота запрещено", "int32 -1");
  assert.equal(text(1, GR_RIGHT_WITHDRAW_GOLD, 2 ** 31), "снятие золота запрещено", "int32 minimum");
  assert.equal(text(1, GR_RIGHT_WITHDRAW_GOLD, 0), "снятие золота запрещено");
  assert.equal(text(1, GR_RIGHT_GCHATLISTEN, 10_000), "снятие золота запрещено", "neither withdraw right");
  // BankMoneyPerDay is copper.
  assert.equal(text(1, GR_RIGHT_WITHDRAW_GOLD, 10_000), "лимит золота: 1з");
  assert.equal(text(2, GR_RIGHT_WITHDRAW_REPAIR, 1_234_567), "лимит золота: 123з 45с 67м", "the repair right alone");
  assert.equal(text(1, GR_RIGHT_WITHDRAW_GOLD, 2 ** 31 - 1), `лимит золота: ${format.formatMoney(2 ** 31 - 1)}`);
});
