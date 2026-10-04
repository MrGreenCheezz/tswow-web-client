import assert from 'node:assert/strict';
import test from 'node:test';

const nodes = new Map();
function node(tag = 'div') {
  const listeners = new Map();
  const attrs = new Map();
  return {
    tagName: tag.toUpperCase(), children: [], dataset: {}, hidden: false, disabled: false, textContent: '', value: '', className: '',
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    append(...children) { this.children.push(...children); for (const child of children) child.parentNode = this; },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener() {},
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.get(name) ?? null; },
    querySelector(selector) { return selector === 'button[type="submit"]' ? node('button') : undefined; },
    querySelectorAll() { return []; },
    contains(target) { return this === target || this.children.some(child => child.contains?.(target)); },
    focus() {}, remove() {},
    click() { if (!this.disabled) listeners.get('click')?.({ target: this, currentTarget: this, stopPropagation() {} }); },
  };
}
const document = {
  body: node('body'), documentElement: node('html'), activeElement: undefined,
  createElement: node,
  getElementById(id) { if (!nodes.has(id)) { const element = node(); element.id = id; nodes.set(id, element); } return nodes.get(id); },
  querySelectorAll() { return []; },
};
globalThis.document = document;
globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900, location: { search: '' } };
globalThis.location = { origin: 'http://localhost:5173', protocol: 'http:', hostname: 'localhost' };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { game } = await import('../dist/code/browser/game/Context.js');
const { usePanelHost } = await import('../dist/code/browser/ui/Widgets.js');
const { toggleGameMenu, updateLogoutPending, resetLogoutPending } = await import('../dist/code/browser/ui/GameMenu.js');
const { WorldClient } = await import('../dist/code/world/WorldClient.js');
const { PacketWriter } = await import('../dist/code/protocol/PacketWriter.js');
const { OPCODES } = await import('../dist/code/generated/opcodes.js');
usePanelHost({ viewport: document.body, attach() {} });
const all = root => [root, ...root.children.flatMap(all)];
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
function connection() {
  const queue = []; let wake;
  return {
    sent: [], send(opcode, payload) { this.sent.push({ opcode, payload }); }, close() {},
    read() { return queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => { wake = resolve; }); },
    push(opcode, payload) {
      const packet = { opcode, payload };
      if (wake) { const callback = wake; wake = undefined; callback(packet); }
      else queue.push(packet);
    },
  };
}

test('the pending logout menu cancels the server countdown and does not request another logout', () => {
  const calls = [];
  const world = {
    logout: { result: 0, instant: false }, loggedOut: false,
    cancelLogout() { calls.push('cancel'); }, requestLogout() { calls.push('request'); },
  };
  game.world = world;
  try {
    updateLogoutPending(world, true);
    const countdown = document.body.children.find(element => element.id === 'logout-countdown');
    assert.equal(countdown?.hidden, false, 'a granted response opens the cancellable countdown');
    toggleGameMenu();
    const menu = document.body.children.find(element => element.id === 'game-menu');
    assert.ok(menu);
    const cancel = all(menu).find(element => element.textContent === 'Отменить выход');
    assert.ok(cancel, 'a granted logout must expose a cancellation action');
    cancel.click();
    assert.deepEqual(calls, ['cancel']);
    assert.equal(all(countdown).find(element => element.textContent === 'Ожидание подтверждения…')?.disabled, true,
      'one click cannot send duplicate cancellation packets while awaiting the ack');
    world.logout = undefined;
    updateLogoutPending(world, false); // SMSG_LOGOUT_CANCEL_ACK
    assert.equal(countdown.hidden, true);
    world.logout = { result: 0, instant: false };
    updateLogoutPending(world, true);
    const popupCancel = all(countdown).find(element => element.textContent === 'Отменить выход');
    assert.ok(popupCancel, 'the stock CAMP popup exposes cancellation without reopening Escape');
    popupCancel.click();
    assert.deepEqual(calls, ['cancel', 'cancel']);
    resetLogoutPending(); // connection loss has no logout response/ack to close the popup
    assert.equal(countdown.hidden, true);
  } finally {
    resetLogoutPending();
    game.world = undefined;
  }
});

test('logout response opens Cancel, its acknowledgement clears pending state, and completion closes it', async () => {
  const transport = connection();
  const world = new WorldClient(transport);
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  await world.loginCharacter(1n);
  game.world = world;
  const unsubscribe = world.events.on('LOGOUT_CHANGED', state => updateLogoutPending(world, state.pending));
  const countdown = document.body.children.find(element => element.id === 'logout-countdown');
  try {
    world.requestLogout();
    assert.equal(transport.sent.at(-1).opcode, OPCODES.CMSG_LOGOUT_REQUEST);
    transport.push(OPCODES.SMSG_LOGOUT_RESPONSE, new PacketWriter().u32(0).u8(0).toUint8Array());
    await settle();
    assert.equal(world.logout?.result, 0);
    assert.equal(countdown.hidden, false);
    all(countdown).find(element => element.textContent === 'Отменить выход').click();
    assert.equal(transport.sent.at(-1).opcode, OPCODES.CMSG_LOGOUT_CANCEL);
    transport.push(OPCODES.SMSG_LOGOUT_CANCEL_ACK, new Uint8Array());
    await settle();
    assert.equal(world.logout, undefined);
    assert.equal(countdown.hidden, true);
    world.requestLogout();
    transport.push(OPCODES.SMSG_LOGOUT_RESPONSE, new PacketWriter().u32(0).u8(0).toUint8Array());
    await settle();
    assert.equal(countdown.hidden, false);
    transport.push(OPCODES.SMSG_LOGOUT_COMPLETE, new Uint8Array());
    await settle();
    assert.equal(world.loggedOut, true);
    assert.equal(countdown.hidden, true);
  } finally {
    unsubscribe();
    resetLogoutPending();
    world.close();
    game.world = undefined;
  }
});

// 4.13: the native panel counts the server's twenty seconds as the stock CAMP popup does and waits
// for the server past zero; the clock stops with the panel.
test('the native countdown shows the seconds left and then waits for the server', async () => {
  const realPerformance = globalThis.performance;
  let clock = 1_000;
  Object.defineProperty(globalThis, 'performance', { value: { now: () => clock }, configurable: true, writable: true });
  const world = { logout: { result: 0, instant: false }, loggedOut: false, cancelLogout() {}, requestLogout() {} };
  game.world = world;
  try {
    updateLogoutPending(world, true);
    const countdown = document.body.children.find(element => element.id === 'logout-countdown');
    const line = all(countdown).find(element => element.className === 'logout-countdown-time');
    const announce = all(countdown).find(element => element.className === 'logout-countdown-announce');
    assert.match(line.textContent, /\b20\b/, 'twenty seconds at the response');
    assert.equal(announce.getAttribute('aria-live'), 'polite');
    assert.equal(announce.textContent, line.textContent, 'the first count is announced');
    clock += 5_000;
    updateLogoutPending(world, true); // a repeated sync of the same logout keeps the clock
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.match(line.textContent, /\b15\b/);
    clock += 1_000;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.match(line.textContent, /\b14\b/);
    assert.match(announce.textContent, /\b15\b/, 'the reader copy moves every five seconds only');
    clock += 30_000;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(line.textContent, 'Ожидание сервера…');
  } finally {
    resetLogoutPending();
    game.world = undefined;
    Object.defineProperty(globalThis, 'performance', { value: realPerformance, configurable: true, writable: true });
  }
});
