import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_MAX_BYTES,
  QUALITY_LINK_COLORS,
  chatByteLength,
  itemChatLink,
  parseChatMarkup,
  plainChatText,
  spellChatLink,
  truncateChat,
} from "../dist/code/browser/ui/ChatLink.js";

// The vectors are the ones the C++ reference client is tested against, because the escapes come
// from the same server and the two clients have to read the same bytes the same way.

test("a coloured item link is one segment and nothing else", () => {
  const segments = parseChatMarkup("|cff1eff00|Hitem:19019:0:0:0:0:0:0:0:80|h[Thunderfury]|h|r");
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "item");
  assert.equal(segments[0].id, 19019);
  assert.equal(segments[0].text, "Thunderfury");
  assert.equal(segments[0].color, "ff1eff00");
});

test("a bare link with no colour in front of it still parses", () => {
  // TrinityCore and addons both write these; only the client's own loot text carries the colour.
  const segments = parseChatMarkup("|Hitem:12345:0:0:0|h[Простой меч]|h");
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "item");
  assert.equal(segments[0].id, 12345);
  assert.equal(segments[0].color, undefined);
});

test("a link with no colons at all keeps its id", () => {
  // Loot lines write the entry and stop: `|Hitem:3299|h[…]`. Reading the id up to the first colon
  // has to survive there being no colon.
  const segments = parseChatMarkup("Ваша добыча: |cff9d9d9d|Hitem:3299|h[Расколотый клык]|h|r.");
  assert.equal(segments.length, 3);
  assert.equal(segments[0].text, "Ваша добыча: ");
  assert.equal(segments[1].kind, "item");
  assert.equal(segments[1].id, 3299);
  assert.equal(segments[2].text, ".");
});

test("text before and after a link survives", () => {
  const segments = parseChatMarkup("смотри |cff0070dd|Hitem:50000:0:0:0|h[Клинок]|h|r хорош");
  assert.deepEqual(segments.map((segment) => segment.kind), ["text", "item", "text"]);
  assert.equal(segments[2].text, " хорош");
});

test("a trailing reset belongs to the link only when it follows the closing bracket", () => {
  const attached = parseChatMarkup("|cff1eff00|Hitem:5:0:0:0|h[А]|h|r");
  assert.equal(attached[0].rawLink.endsWith("|h|r"), true);
  const detached = parseChatMarkup("|cff1eff00|Hitem:5:0:0:0|h[А]|h и ещё|r");
  assert.equal(detached[0].rawLink.endsWith("]|h"), true, "the reset closes the sentence, not the link");
});

test("a colour that is not a link becomes coloured text with the markup gone", () => {
  const segments = parseChatMarkup("|cffff0000Внимание|r и дальше");
  assert.equal(segments[0].kind, "colored");
  assert.equal(segments[0].text, "Внимание");
  assert.equal(segments[0].color, "ffff0000");
  assert.equal(segments[1].text, " и дальше");
});

test("rawLink is the exact substring, because shift-click pastes it back", () => {
  const source = "|cffa335ee|Hitem:19019:2504:0:0:0:0:41:1234:80|h[Громовая Ярость]|h|r";
  const segments = parseChatMarkup(`он получил ${source}!`);
  assert.equal(segments[1].rawLink, source, "the enchant and the suffix cannot be rebuilt from the id");
});

test("itemChatLink writes nine fields after item:, not eight", () => {
  // Eight is the usual mistake and it slides the random property into the unique id slot, so the
  // receiver's tooltip names a suffix the item does not have.
  const link = itemChatLink(19019, 5, "Громовая Ярость", 2504, 41);
  const fields = link.slice(link.indexOf("|Hitem:") + 7, link.indexOf("|h[")).split(":");
  assert.equal(fields.length, 9);
  assert.deepEqual(fields, ["19019", "2504", "0", "0", "0", "0", "41", "0", "0"]);
  assert.equal(link.startsWith("|cffff8000"), true, "legendary is orange");
});

test("what itemChatLink writes is what parseChatMarkup reads", () => {
  const [segment] = parseChatMarkup(itemChatLink(4306, 1, "Шёлковая ткань"));
  assert.equal(segment.kind, "item");
  assert.equal(segment.id, 4306);
  assert.equal(segment.text, "Шёлковая ткань");
});

test("a spell link is the one blue every client uses", () => {
  const [segment] = parseChatMarkup(spellChatLink(133, "Огненный шар"));
  assert.equal(segment.kind, "spell");
  assert.equal(segment.id, 133);
  assert.equal(segment.color, "ff71d5ff");
});

test("heirloom is the same gold as artifact", () => {
  assert.equal(QUALITY_LINK_COLORS[6], QUALITY_LINK_COLORS[7]);
  assert.equal(QUALITY_LINK_COLORS[0], "ff9d9d9d");
});

test("plainChatText strips every escape, because a bubble is not a link", () => {
  const said = "держи |cff1eff00|Hitem:2589:0:0:0|h[Полотно]|h|r, |cffff0000спасибо|r";
  assert.equal(plainChatText(said), "держи Полотно, спасибо");
});

test("malformed markup shows as itself rather than swallowing the line", () => {
  // A colour code that is not one, and a link with no closing bracket. Both are kept verbatim:
  // a sender writing something this build cannot read should look broken, not look edited.
  assert.equal(plainChatText("50% |c урона"), "50% |c урона");
  assert.equal(plainChatText("|Hitem:12|h[без закрытия"), "|Hitem:12|h[без закрытия");
  // A reset with nothing open is the one escape worth dropping: it says nothing on its own.
  assert.equal(plainChatText("готово|r"), "готово");
});

test("the length the server counts is bytes, not characters", () => {
  // HandleMessagechatOpcode drops anything over 255 bytes and answers nothing, and Russian is two
  // bytes a letter — so half a screenful used to vanish with no explanation at all.
  assert.equal(chatByteLength("abc"), 3);
  assert.equal(chatByteLength("абв"), 6);
  const long = "я".repeat(200);
  assert.equal(chatByteLength(long) > CHAT_MAX_BYTES, true);
  const cut = truncateChat(long);
  assert.equal(chatByteLength(cut) <= CHAT_MAX_BYTES, true);
  assert.equal(cut.length, 127, "cut on a character, never mid-sequence");
});
