// A document and window just real enough for the native interface modules to import under Node.
//
// `ui/Dom.ts` resolves its element handles at import, and the spellbook module brings it (and the
// rest of the native interface) with it, so a test that loads `Spellbook.ts` — directly, or through
// the FrameXML tooltip adapter's dynamic import — installs this first.

function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      title: "", hidden: false, disabled: false, id: "", value: "", type: "", draggable: false,
      checked: false,
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      append(...nodes) { node.children.push(...nodes); },
      prepend(...nodes) { node.children.unshift(...nodes); },
      appendChild(child) { node.children.push(child); return child; },
      replaceChildren(...nodes) { node.children = [...nodes]; },
      remove() {}, focus() {}, blur() {},
      addEventListener() {}, removeEventListener() {},
      setAttribute(name, value) { node[name] = value; },
      getAttribute(name) { return node[name] ?? null; },
      removeAttribute(name) { delete node[name]; },
      querySelector() { return make("div"); }, querySelectorAll() { return []; }, closest() { return undefined; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }; },
      getContext() { return null; },
    };
    return node;
  };
  return {
    createElement: make, createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (text) => ({ textContent: text }), createDocumentFragment: () => make("fragment"),
    body: make("body"), documentElement: make("html"), head: make("head"),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) { node = make("div"); node.id = id; byId.set(id, node); }
      return node;
    },
    querySelector() { return make("div"); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

/** Puts the fake `document`, `window` and friends on `globalThis`; call before importing the UI. */
export function installFakeUiDocument() {
  globalThis.document = fakeDocument();
  globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  globalThis.localStorage = globalThis.window.localStorage;
  globalThis.matchMedia = globalThis.window.matchMedia;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.HTMLElement = class {};
}
