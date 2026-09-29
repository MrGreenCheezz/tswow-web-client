import assert from 'node:assert/strict';
import test from 'node:test';

const nodes = new Map();
function node(tag = 'div') {
  const listeners = new Map();
  const attrs = new Map();
  return {
    tagName: tag.toUpperCase(), children: [], dataset: {}, hidden: false, disabled: false,
    checked: false, textContent: '', value: '', className: '', title: '',
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    append(...children) { this.children.push(...children); for (const child of children) child.parentNode = this; },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    addEventListener(type, listener) { listeners.set(type, listener); }, removeEventListener() {},
    setAttribute(name, value) { attrs.set(name, String(value)); }, getAttribute(name) { return attrs.get(name) ?? null; },
    querySelector(selector) { return selector === 'button[type="submit"]' ? node('button') : undefined; },
    querySelectorAll() { return []; }, focus() {}, remove() {},
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

const { EventBus } = await import('../dist/code/world/EventBus.js');
const { game } = await import('../dist/code/browser/game/Context.js');
const { usePanelHost } = await import('../dist/code/browser/ui/Widgets.js');
const { toggleGmTickets, gmTicketsOpen, resetGmTickets } = await import('../dist/code/browser/ui/GmTickets.js');
const { showPetition, petitionOpen, resetPetition } = await import('../dist/code/browser/ui/Petition.js');
const { toggleReputation, reputationOpen, clearReputation } = await import('../dist/code/browser/ui/Reputation.js');
const { toggleGameMenu, gameMenuOpen } = await import('../dist/code/browser/ui/GameMenu.js');
const { toggleKeyBindingsWindow, keyBindingsOpen } = await import('../dist/code/browser/ui/KeyBindings.js');
const { inventoryWindow } = await import('../dist/code/browser/ui/Dom.js');
const { resetWorldUi } = await import('../dist/code/browser/app/Login.js');
usePanelHost({ viewport: document.body, attach() {} });

test('world exit closes optional windows and releases old-world subscriptions and search', () => {
  const events = new EventBus();
  const world = {
    events, state: { selfGuid: 1n, objects: new Map() }, ticketsEnabled: true,
    requestTicket() {}, requestTicketSystemStatus() {},
    petition: { ownerGuid: 1n, name: 'Old charter', minSignatures: 9, arena: false },
    displayName() { return 'Old character'; },
  };
  game.world = world;
  try {
    toggleGmTickets();
    showPetition();
    toggleReputation();
    toggleGameMenu();
    toggleKeyBindingsWindow();
    inventoryWindow.hidden = false;
    assert.equal(gmTicketsOpen(), true);
    assert.equal(petitionOpen(), true);
    assert.equal(reputationOpen(), true);
    assert.equal(gameMenuOpen(), true);
    assert.equal(keyBindingsOpen(), true);
    assert.equal(inventoryWindow.hidden, false);
    assert.equal(events.listenerCount('GM_TICKET_CHANGED'), 1);
    assert.equal(events.listenerCount('PETITION_CHANGED'), 1);

    resetWorldUi();
    assert.equal(gmTicketsOpen(), false, 'the old GM ticket must not cover the character list');
    assert.equal(petitionOpen(), false, 'the old charter must not cover another character');
    assert.equal(reputationOpen(), false, 'the old reputation list must not survive logout');
    assert.equal(gameMenuOpen(), false, 'a reopened world must not inherit the old menu');
    assert.equal(keyBindingsOpen(), false, 'old key capture and its window must end with the world');
    assert.equal(inventoryWindow.hidden, true, 'a reopened world must not inherit markup windows');
    assert.equal(events.listenerCount('GM_TICKET_CHANGED'), 0);
    assert.equal(events.listenerCount('PETITION_CHANGED'), 0);
  } finally {
    resetGmTickets(); resetPetition(); clearReputation(); game.world = undefined;
  }
});
