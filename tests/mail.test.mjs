import assert from "node:assert/strict";
import test from "node:test";
import {
  MAIL_AUCTION,
  MAIL_DELETED,
  MAIL_ERR_EQUIP_ERROR,
  MAIL_ITEM_TAKEN,
  MAIL_NORMAL,
  MAIL_OK,
  buildGetMailList,
  buildMailDelete,
  buildMailReturnToSender,
  buildMailTakeItem,
  buildMailTakeMoney,
  buildSendMail,
  isMailRead,
  mailErrorText,
  parseMailCommandResult,
  parseMailListResult,
  parseReceivedMail,
} from "../dist/code/world/MailProtocol.js";

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
const u16 = (value) => {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
};
const u32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
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

// MailPackets.cpp: each attachment writes position, ids, seven enchantment triples, then the rest.
function attachment({ position = 0, attachId = 1, itemId = 2589, count = 1 }) {
  const parts = [u8(position), u32(attachId), u32(itemId)];
  for (let slot = 0; slot < 7 * 3; slot++) parts.push(u32(0));
  parts.push(u32(0), u32(0), u32(count), u32(0), u32(100), u32(90), u8(1));
  return bytes(...parts);
}

function mailEntry({ mailId = 1, senderType = MAIL_NORMAL, sender = 0x42n, money = 0, cod = 0, flags = 0, subject = "Тема", body = "Текст", attachments = [] }) {
  const senderPart = senderType === MAIL_NORMAL ? u64(sender) : u32(Number(sender));
  return bytes(
    u16(0), u32(mailId), u8(senderType), senderPart,
    u32(cod), u32(0), u32(41), u32(money), u32(flags), f32(29.5), u32(0),
    cstr(subject), cstr(body), u8(attachments.length), ...attachments,
  );
}

test("the mail list decodes player and non-player senders differently", () => {
  const payload = bytes(
    u32(2), u8(2),
    mailEntry({ mailId: 7, sender: 0x42n, money: 5000, subject: "Привет", body: "Держи" }),
    mailEntry({ mailId: 8, senderType: MAIL_AUCTION, sender: 99n, flags: 0x01, subject: "Аукцион", body: "" }),
  );
  const list = parseMailListResult(payload);
  assert.equal(list.totalCount, 2);
  assert.equal(list.mails.length, 2);

  assert.equal(list.mails[0].mailId, 7);
  assert.equal(list.mails[0].senderGuid, 0x42n, "player senders arrive as a guid");
  assert.equal(list.mails[0].altSenderId, 0);
  assert.equal(list.mails[0].money, 5000);
  assert.equal(list.mails[0].subject, "Привет");
  assert.equal(isMailRead(list.mails[0]), false);

  assert.equal(list.mails[1].senderGuid, 0n, "auction mail sends an id instead of a guid");
  assert.equal(list.mails[1].altSenderId, 99);
  assert.equal(isMailRead(list.mails[1]), true);
  assert.ok(Math.abs(list.mails[1].daysLeft - 29.5) < 0.01);
});

test("attachments decode past the seven enchantment slots", () => {
  const payload = bytes(u32(1), u8(1), mailEntry({
    attachments: [attachment({ position: 0, attachId: 3, itemId: 2589, count: 12 })],
  }));
  const [mail] = parseMailListResult(payload).mails;
  assert.equal(mail.attachments.length, 1);
  assert.deepEqual(
    [mail.attachments[0].attachId, mail.attachments[0].itemId, mail.attachments[0].count],
    [3, 2589, 12],
  );
  assert.equal(mail.attachments[0].maxDurability, 100);
  assert.equal(mail.attachments[0].durability, 90);
  assert.equal(mail.attachments[0].unlocked, true);
});

test("an empty mailbox decodes to nothing", () => {
  const list = parseMailListResult(bytes(u32(0), u8(0)));
  assert.deepEqual(list.mails, []);
  assert.equal(list.totalCount, 0);
});

test("the command result grows only for the cases the server writes extra fields for", () => {
  const plain = parseMailCommandResult(bytes(u32(7), u32(MAIL_DELETED), u32(MAIL_OK)));
  assert.deepEqual(plain, { mailId: 7, command: MAIL_DELETED, error: MAIL_OK, bagResult: 0, attachId: 0, quantityInInventory: 0 });

  const taken = parseMailCommandResult(bytes(u32(7), u32(MAIL_ITEM_TAKEN), u32(MAIL_OK), u32(3), u32(12)));
  assert.equal(taken.attachId, 3);
  assert.equal(taken.quantityInInventory, 12);

  const equipError = parseMailCommandResult(bytes(u32(7), u32(MAIL_ITEM_TAKEN), u32(MAIL_ERR_EQUIP_ERROR), u32(50)));
  assert.equal(equipError.bagResult, 50);
  assert.equal(equipError.attachId, 0, "no attach id follows an equip error");

  assert.match(mailErrorText(4), /получатель/i);
  assert.match(mailErrorText(77), /77/);
  assert.ok(Math.abs(parseReceivedMail(f32(30)) - 30) < 0.001);
});

test("client mail packets match their handlers", () => {
  assert.equal(buildGetMailList(1n).length, 8);
  assert.deepEqual([...buildMailTakeItem(1n, 7, 3)], [...bytes(u64(1n), u32(7), u32(3))]);
  assert.deepEqual([...buildMailTakeMoney(1n, 7)], [...bytes(u64(1n), u32(7))]);
  assert.deepEqual([...buildMailDelete(1n, 7)], [...bytes(u64(1n), u32(7), u32(0))]);
  assert.deepEqual([...buildMailReturnToSender(1n, 7, 0x42n)], [...bytes(u64(1n), u32(7), u64(0x42n))]);

  // SendMail::Read finishes with a uint64 and a uint8 that it skips.
  const send = buildSendMail(1n, { target: "Тралл", subject: "Тема", body: "Текст", money: 100, attachments: [0x55n] });
  assert.deepEqual(
    [...send],
    [...bytes(
      u64(1n), cstr("Тралл"), cstr("Тема"), cstr("Текст"), u32(41), u32(0),
      u8(1), u8(0), u64(0x55n), u32(100), u32(0), u64(0n), u8(0),
    )],
  );
});
