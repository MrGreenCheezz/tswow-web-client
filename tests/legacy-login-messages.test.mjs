import assert from "node:assert/strict";
import test from "node:test";

// The legacy DOM forms (`?legacy-login=1`, app/Login.ts) print the coded message the glue screens
// show without a corpus (glue/GlueMessages.ts `describeFailure`), never the exception's own English.

const nodes = new Map();
function node(tag = "div") {
  const listeners = new Map();
  const attrs = new Map();
  return {
    tagName: tag.toUpperCase(), children: [], dataset: {}, hidden: false, disabled: false,
    checked: false, textContent: "", value: "", className: "", title: "", listeners, options: [],
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    append(...children) { this.children.push(...children); for (const child of children) child.parentNode = this; },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    after(...siblings) { for (const sibling of siblings) sibling.parentNode = this.parentNode; },
    addEventListener(type, listener) { listeners.set(type, listener); }, removeEventListener() {},
    setAttribute(name, value) { attrs.set(name, String(value)); }, getAttribute(name) { return attrs.get(name) ?? null; },
    querySelector(selector) { return selector === 'button[type="submit"]' ? node("button") : undefined; },
    querySelectorAll() { return []; }, focus() {}, remove() {},
  };
}
const document = {
  body: node("body"), documentElement: node("html"), activeElement: undefined,
  createElement: node,
  getElementById(id) { if (!nodes.has(id)) { const element = node(); element.id = id; nodes.set(id, element); } return nodes.get(id); },
  querySelectorAll() { return []; },
};
globalThis.document = document;
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900, location: { search: "" },
  confirm: () => true,
};
globalThis.location = { origin: "http://localhost:5173", protocol: "http:", hostname: "localhost" };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
/**
 * "refuse": a socket that never opens (WebSocketByteStream.connect rejects with TransportConnectError).
 * "backend": it opens, and the first send is answered by the gateway's 1011 «Backend…» close.
 */
let socketMode = "refuse";
globalThis.WebSocket = class {
  static CONNECTING = 0;
  static OPEN = 1;
  binaryType = "";
  readyState = 0;
  #listeners = [];
  constructor() {
    queueMicrotask(() => {
      if (socketMode === "refuse") {
        this.#emit("error", {});
        this.#emit("close", { code: 1006, reason: "", wasClean: false });
      } else {
        this.readyState = 1;
        this.#emit("open", {});
      }
    });
  }
  #emit(type, event) {
    for (const entry of [...this.#listeners]) {
      if (entry.type !== type) continue;
      if (entry.once) this.#listeners.splice(this.#listeners.indexOf(entry), 1);
      entry.listener(event);
    }
  }
  addEventListener(type, listener, options) { this.#listeners.push({ type, listener, once: options?.once === true }); }
  removeEventListener() {}
  send() {
    queueMicrotask(() => {
      this.readyState = 3;
      this.#emit("close", { code: 1011, reason: "Backend closed", wasClean: false });
    });
  }
  close() { this.readyState = 3; }
};
/** No gateway: the creation catalog request fails and the compiled lists stand. */
globalThis.fetch = async () => { throw new TypeError("no network in this test"); };
const warn = console.warn;
console.warn = () => {};

const { game } = await import("../dist/code/browser/game/Context.js");
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
const { form, status, createForm, characterStatus, characters, gatewayInput, usernameInput } = await import("../dist/code/browser/ui/Dom.js");
const { wireLoginForms, showCharacters, connectRealm } = await import("../dist/code/browser/app/Login.js");
const { TransportClosedError } = await import("../dist/code/transport/WebSocketByteStream.js");
usePanelHost({ viewport: document.body, attach() {} });
wireLoginForms();
gatewayInput.value = "ws://127.0.0.1:9/auth";
usernameInput.value = "PLAYER";
const submit = (element) => element.listeners.get("submit")({ preventDefault() {} });

test.after(() => { console.warn = warn; });

test("a sign-in whose socket never opens says RESPONSE_FAILED_TO_CONNECT's words", async () => {
  await submit(form);
  assert.equal(status.className, "error");
  assert.equal(status.textContent, "Не удалось соединиться с сервером.");
  // The authserver behind the gateway gone: the login's LOGIN_SERVER_DOWN, not the realm's words.
  socketMode = "backend";
  try {
    await submit(form);
    assert.equal(status.textContent, "Сервер входа недоступен");
  } finally {
    socketMode = "refuse";
  }
});

test("a realm whose world socket never opens says the same, not the exception", async () => {
  game.session = { username: "PLAYER", sessionKey: new Uint8Array(40), realms: [] };
  try {
    await connectRealm({ id: 1, name: "Мир", type: 0, locked: false, flags: 0, address: "", population: 0, characters: 0, timezone: 1, build: undefined });
    assert.equal(characterStatus.className, "error");
    assert.equal(characterStatus.textContent, "Не удалось соединиться с сервером.");
  } finally {
    game.session = undefined;
  }
});

test("character creation: a refused code and a dropped socket are the glue screen's texts", async () => {
  const world = { close() {}, createCharacter: async () => 50, characters: async () => [] };
  game.world = world;
  try {
    await submit(createForm);
    assert.equal(characterStatus.textContent, "Сервер отказал в создании, код 50.");
    world.createCharacter = async () => { throw new TransportClosedError(1006, "", false); };
    await submit(createForm);
    assert.equal(characterStatus.className, "error");
    assert.equal(characterStatus.textContent, "Соединение с сервером разорвано", "DISCONNECTED");
    world.createCharacter = async () => { throw new Error("world read timed out"); };
    await submit(createForm);
    assert.equal(characterStatus.textContent, "Не удалось создать персонажа", "CHAR_CREATE_FAILED");
  } finally {
    game.world = undefined;
  }
});

test("character deletion: a refused code and a dropped socket are the glue screen's texts", async () => {
  const world = { deleteCharacter: async () => 74, characters: async () => [] };
  game.world = world;
  try {
    showCharacters([{ guid: 5n, name: "Тест", level: 10, race: 1, classId: 1, gender: 0 }]);
    const card = characters.children[0];
    const remove = card.children.flatMap((child) => [child, ...(child.children ?? [])])
      .find((child) => child.textContent === "Удалить");
    await remove.listeners.get("click")();
    assert.equal(characterStatus.className, "error");
    assert.equal(characterStatus.textContent, "Удаление отклонено сервером, код 74.");
    assert.equal(remove.disabled, false, "the button comes back for another try");
    world.deleteCharacter = async () => { throw new TransportClosedError(1011, "Backend closed", false); };
    await remove.listeners.get("click")();
    assert.equal(characterStatus.textContent, "Сервер недоступен", "CHAR_LOGIN_NO_WORLD: the realm behind the gateway is gone");
  } finally {
    game.world = undefined;
  }
});
