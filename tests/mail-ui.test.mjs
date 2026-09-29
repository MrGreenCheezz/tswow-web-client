import assert from 'node:assert/strict';
import test from 'node:test';
import { WorldClient } from '../dist/code/world/WorldClient.js';
import { OPCODES } from '../dist/code/generated/opcodes.js';
import { UPDATE_FIELDS } from '../dist/code/generated/updateFields.js';
import { PacketWriter } from '../dist/code/protocol/PacketWriter.js';
import { buildMailDelete, buildSendMail, MAIL_AUCTION, MAIL_ERR_EQUIP_ERROR, MAIL_MONEY_TAKEN, MAIL_SEND, MAIL_OK } from '../dist/code/world/MailProtocol.js';

const elements = new Map();
function node(tag = 'div') {
  const listeners = new Map();
  const attributes = new Map();
  const item = {
    tagName: tag.toUpperCase(), children: [], dataset: {}, hidden: false, disabled: false, checked: false, value: '', textContent: '', className: '',
    style: { setProperty(name, value) { this[name] = value; }, getPropertyValue(name) { return this[name] ?? ''; }, removeProperty(name) { delete this[name]; } },
    append(...children) { this.children.push(...children); children.forEach(child => { child.parentNode = this; }); },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    setAttribute(name, value) { attributes.set(name, String(value)); }, getAttribute(name) { return attributes.get(name) ?? null; },
    addEventListener(name, run) { listeners.set(name, run); }, removeEventListener() {},
    click() { if (!this.disabled) listeners.get('click')?.({ target: this, currentTarget: this, stopPropagation() {} }); },
    dispatchEvent(event) { listeners.get(event.type)?.({ ...event, target: this, currentTarget: this }); },
    querySelectorAll(selector) { return selector === 'input, textarea' ? [...elements].filter(([id]) => ['mail-to', 'mail-subject', 'mail-body', 'mail-money', 'mail-silver', 'mail-copper'].includes(id)).map(([,value]) => value) : []; },
    querySelector(selector) { return selector === 'button[type="submit"]' ? node('button') : undefined; }, focus() {}, remove() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
  return item;
}
const document = {
  createElement: node, body: node('body'), documentElement: node('html'), querySelectorAll() { return []; },
  getElementById(id) { if (!elements.has(id)) { const item = node(); item.id = id; elements.set(id, item); } return elements.get(id); },
};
globalThis.document = document;
globalThis.window = { addEventListener() {}, removeEventListener() {}, setTimeout, innerWidth: 1440, innerHeight: 900, location: { search: '' } };
globalThis.location = { origin: 'http://localhost:5173', protocol: 'http:', hostname: 'localhost' };
const { game } = await import('../dist/code/browser/game/Context.js');
const { usePanelHost } = await import('../dist/code/browser/ui/Widgets.js');
const { showMail, mailReadOpen, closeMailRead } = await import('../dist/code/browser/ui/Mail.js');
usePanelHost({ viewport: document.body, attach() {} });
const at = id => document.getElementById(id);
const all = root => [root, ...root.children.flatMap(all)];
const settle = async () => { for (let i=0;i<6;i++) await new Promise(setImmediate); };
function connection() {
  const queue=[]; let wake;
  return {
    sent: [], send(opcode,payload) { this.sent.push({opcode,payload}); }, close() {},
    read() { return queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => {wake=resolve;}); },
    push(opcode,payload) { const packet={opcode,payload}; if(wake){const callback=wake;wake=undefined;callback(packet);}else queue.push(packet); },
  };
}

test('mail uses a seven-row inbox, opens one letter and preserves the draft until the real send result', async () => {
  const transport=connection();
  const world=new WorldClient(transport);
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  await world.loginCharacter(1n);
  game.world=world;
  const item={guid:3n,typeId:1,fields:new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset,6948],[UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset,1]])};
  world.state.selfGuid=1n;
  world.state.objects.set(1n,{guid:1n,typeId:4,fields:new Map([[UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset,3]])});
  world.state.objects.set(3n,item);
  world.mailboxGuid=55n;
  world.mail={totalCount:9,mails:Array.from({length:9},(_,i)=>({mailId:i+1,senderType:0,senderGuid:2n,altSenderId:0,cod:0,packageId:0,stationeryId:41,money:0,flags:i===1?0x02:0,daysLeft:30,mailTemplateId:0,subject:'Письмо '+(i+1),body:'Содержимое выбранного письма',attachments:i===0?[{position:0,attachId:701,itemId:6948,count:1,randomPropertiesId:0,randomPropertiesSeed:0,charges:0,maxDurability:0,durability:0,unlocked:true}]:[]}))};
  world.mail.mails[0].daysLeft = 29.5;
  world.mail.mails[1].daysLeft = 0.5;
  world.mail.mails[2].daysLeft = 0.0625;
  world.mail.mails[7]={...world.mail.mails[7],senderType:MAIL_AUCTION,senderGuid:0n,altSenderId:1,flags:0x01,cod:100};
  world.mail.mails[8]={...world.mail.mails[8],senderType:MAIL_AUCTION,senderGuid:0n,altSenderId:1,flags:0x01,money:500,
    attachments:[{position:0,attachId:702,itemId:6948,count:1,randomPropertiesId:0,randomPropertiesSeed:0,charges:0,maxDurability:0,durability:0,unlocked:true}]};
  world.onMailChanged=showMail;
  try {
    showMail();
    assert.equal(at('mail-list').children.length,7);
    const expiry = row => all(row).find(x => x.className?.includes('mail-entry-status'));
    assert.match(expiry(at('mail-list').children[0]).textContent, /29 д\./,
      'MailFrame.lua floors a multi-day expiry rather than rounding it up');
    assert.match(expiry(at('mail-list').children[1]).textContent, /12 ч\./,
      'mail with less than one day remaining shows the actual time, not one day');
    assert.match(expiry(at('mail-list').children[2]).textContent, /1 ч\. 30 мин\./,
      'UIParent SecondsToTime emits up to two nonzero units');
    assert.match(expiry(at('mail-list').children[1]).className, /expiring/,
      'MailFrame.lua paints an expiry under one day red');
    at('mail-next').click();
    assert.equal(at('mail-list').children.length,2);
    assert.equal(at('mail-next').disabled,true);
    at('mail-list').children[0].click();
    const auctionReadRoot=document.body.children.find(x=>x.id==='mail-read-window');
    assert.equal(all(auctionReadRoot).find(x=>x.textContent==='Удалить').disabled,true,
      'the selected core rejects deletion of COD mail');
    closeMailRead();
    at('mail-list').children[1].click();
    const auctionDelete=all(auctionReadRoot).find(x=>x.textContent==='Удалить');
    assert.equal(auctionDelete.disabled,false,
      'non-COD auction mail with money and an attachment can be deleted after confirmation');
    auctionDelete.click();
    const confirmRoot=document.body.children.at(-1);
    assert.ok(all(confirmRoot).some(x=>x.textContent==='Содержимое письма будет потеряно.'));
    assert.equal(transport.sent.filter(x=>x.opcode===OPCODES.CMSG_MAIL_DELETE).length,0);
    all(confirmRoot).find(x=>x.textContent==='Удалить').click();
    assert.deepEqual(transport.sent.filter(x=>x.opcode===OPCODES.CMSG_MAIL_DELETE).at(-1).payload,buildMailDelete(55n,9));
    closeMailRead();
    at('mail-previous').click();
    at('mail-list').children[0].click();
    assert.equal(mailReadOpen(),true);
    const readRoot=document.body.children.find(x=>x.id==='mail-read-window');
    assert.ok(all(readRoot).some(x=>x.textContent==='Содержимое выбранного письма'));
    assert.equal(all(readRoot).find(x=>x.textContent==='Ответить').disabled,true,'an unresolved GUID must never become a reply address');
    assert.ok(all(readRoot).some(x=>x.textContent==='От: Получение имени…'));
    world.names.accept({guid:2n,known:true,name:'Друг',declined:[]});
    showMail();
    assert.equal(all(readRoot).find(x=>x.textContent==='Ответить').disabled,false);
    assert.ok(all(readRoot).some(x=>x.textContent==='От: Друг'));
    assert.equal(transport.sent.filter(x=>x.opcode===OPCODES.CMSG_MAIL_MARK_AS_READ).length,1);
    assert.equal(all(readRoot).find(x=>x.textContent==='Удалить').disabled,true,'an attached item cannot be deleted with its letter');
    closeMailRead(); at('mail-list').children[0].click();
    assert.equal(transport.sent.filter(x=>x.opcode===OPCODES.CMSG_MAIL_MARK_AS_READ).length,1,'reopening a read letter does not repeat the read request');
    assert.ok(all(readRoot).some(x=>x.textContent==='Вернуть'),'ordinary player mail can be returned');
    world.returnMail(1,2n);
    assert.equal(transport.sent.filter(x=>x.opcode===OPCODES.CMSG_MAIL_RETURN_TO_SENDER).length,1,
      'ordinary player mail sends the return command');
    closeMailRead(); at('mail-list').children[1].click();
    assert.equal(all(readRoot).some(x=>x.textContent==='Вернуть'),false,'a returned letter cannot be returned again');
    world.returnMail(2,2n);
    assert.equal(transport.sent.filter(x=>x.opcode===OPCODES.CMSG_MAIL_RETURN_TO_SENDER).length,1,
      'the command path must also reject a returned letter');
    closeMailRead(); at('mail-list').children[0].click();
    all(readRoot).find(x=>x.textContent==='Ответить').click();
    assert.equal(mailReadOpen(),false);
    assert.equal(at('mail-to').value,'Друг');
    at('mail-to').value='Друг';at('mail-subject').value='Припасы';at('mail-body').value='Сохранить при ошибке';
    at('mail-money').value='2';at('mail-silver').value='3';at('mail-copper').value='4';
    assert.equal(at('mail-cod-mode').disabled,true,'stock MailFrame disables COD without an attachment');
    at('mail-attachment-picker').value='3';at('mail-attachment-picker').dispatchEvent({type:'change'});
    assert.equal(at('mail-cod-mode').disabled,false);
    at('mail-cod-mode').click();
    assert.equal(at('mail-cod-mode').checked,true);
    assert.equal(at('mail-send-money-mode').checked,false,'the stock modes are mutually exclusive');
    assert.equal(at('mail-money').value,'2','switching mode keeps the single amount field');
    at('mail-money').value='10000';at('mail-silver').value='0';at('mail-copper').value='1';
    at('mail-copper').dispatchEvent({type:'input'});
    assert.equal(at('mail-send').disabled,true,'stock MailFrame disables COD above exactly 10000 gold');
    assert.match(at('mail-message').textContent,/10\s?000/);
    assert.equal(transport.sent.filter(x=>x.opcode===OPCODES.CMSG_SEND_MAIL).length,0);
    at('mail-send-money-mode').click();
    assert.equal(at('mail-send-money-mode').checked,true);
    assert.equal(at('mail-cod-mode').checked,false);
    assert.equal(at('mail-send').disabled,false,'the COD ceiling does not apply to sending money');
    assert.equal(at('mail-copper').value,'1','switching modes preserves the shared amount');
    at('mail-cod-mode').click();
    assert.equal(at('mail-send').disabled,true);
    at('mail-copper').value='0';at('mail-copper').dispatchEvent({type:'input'});
    assert.equal(at('mail-send').disabled,false,'exactly 10000 gold remains allowed');
    at('mail-send').click();at('mail-send').click();
    const requests=transport.sent.filter(x=>x.opcode===OPCODES.CMSG_SEND_MAIL);
    assert.equal(requests.length,1,'pending sends cannot be repeated');
    assert.deepEqual(requests[0].payload,buildSendMail(55n,{target:'Друг',subject:'Припасы',body:'Сохранить при ошибке',money:0,cod:100000000,attachments:[3n]}));
    assert.equal(at('mail-body').value,'Сохранить при ошибке');
    transport.push(OPCODES.SMSG_SEND_MAIL_RESULT,new PacketWriter().u32(0).u32(MAIL_SEND).u32(4).toUint8Array());
    await settle();
    assert.equal(at('mail-send').disabled,false);
    assert.equal(at('mail-body').value,'Сохранить при ошибке');
    assert.equal(at('mail-attachments').children.length,1);
    at('mail-send').click();
    transport.push(OPCODES.SMSG_SEND_MAIL_RESULT,new PacketWriter().u32(0).u32(MAIL_SEND).u32(MAIL_OK).toUint8Array());
    await settle();
    assert.equal(at('mail-body').value,'');
    assert.equal(at('mail-money').value,'0');
    assert.equal(at('mail-send-money-mode').checked,true,'new draft returns to the stock send-money mode');
    assert.equal(at('mail-cod-mode').disabled,true,'removing the last attachment disables COD again');
    assert.equal(at('mail-attachments').children.length,0);
    at('mail-to').value='Друг';at('mail-subject').value='Деньги';
    at('mail-money').value='2';at('mail-silver').value='3';at('mail-copper').value='4';
    at('mail-send').click();
    assert.deepEqual(transport.sent.filter(x=>x.opcode===OPCODES.CMSG_SEND_MAIL).at(-1).payload,
      buildSendMail(55n,{target:'Друг',subject:'Деньги',body:'',money:20304,attachments:[]}));
    world.closeMailbox();
    assert.equal(at('mail-window').hidden,true);
    assert.equal(mailReadOpen(),false);
  } finally { closeMailRead(); world.close(); game.world=undefined; }
});

test('a rejected money pickup explains the gold cap from the mail equip detail', async () => {
  const transport = connection();
  const world = new WorldClient(transport);
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  await world.loginCharacter(1n);
  game.world = world;
  world.mailboxGuid = 55n;
  world.onMailChanged = showMail;
  try {
    showMail();
    world.takeMailMoney(7);
    assert.equal(transport.sent.at(-1).opcode, OPCODES.CMSG_MAIL_TAKE_MONEY);
    // MailHandler.cpp returns this pair when ModifyMoney refuses the gold cap.
    transport.push(OPCODES.SMSG_SEND_MAIL_RESULT,
      new PacketWriter().u32(7).u32(MAIL_MONEY_TAKEN).u32(MAIL_ERR_EQUIP_ERROR).u32(77).toUint8Array());
    await settle();
    assert.equal(world.mailResult.bagResult, 77);
    assert.match(at('mail-message').textContent, /слишком много золота/i);
    assert.doesNotMatch(at('mail-message').textContent, /положить предмет/i);
  } finally {
    world.close();
    game.world = undefined;
    closeMailRead();
  }
});
