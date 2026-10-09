// The counting fake DOM of native-hud-lanes.test.mjs, shared: every write a native panel makes goes
// through `stats.writes`, so a test (or the P1-20 microbench) can say how much DOM work a refresh did.
// Install it before importing anything under src/browser/ui/: Dom.ts resolves its handles at import.

/** Every DOM write, and the reads and constructions a panel pays for. */
export const stats = { writes: 0, created: 0, queries: 0, rects: 0, attributeReads: 0 };
export function resetStats() { for (const key of Object.keys(stats)) stats[key] = 0; }

function wrote() { stats.writes += 1; }

function counted(target) {
  return new Proxy(target, {
    set(object, key, value) { wrote(); object[key] = value; return true; },
    deleteProperty(object, key) { wrote(); delete object[key]; return true; },
  });
}

function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    stats.created += 1;
    const attributes = new Map();
    const classes = new Set();
    const state = { textContent: "", hidden: false, title: "", disabled: false, className: "" };
    const style = counted({
      setProperty(name, value) { wrote(); style[name] = String(value); },
      removeProperty(name) { wrote(); delete style[name]; },
    });
    const node = {
      tagName: String(tag).toUpperCase(), children: [], id: "", value: "", type: "", draggable: false,
      checked: false, src: "", alt: "", onerror: null, onload: null, tabIndex: -1, isConnected: true,
      naturalWidth: 0, naturalHeight: 0, clientWidth: 0, clientHeight: 0,
      dataset: counted({}), style,
      get textContent() { return state.textContent; },
      set textContent(value) { wrote(); state.textContent = String(value); node.children = []; },
      get hidden() { return state.hidden; },
      set hidden(value) { wrote(); state.hidden = !!value; },
      get title() { return state.title; },
      set title(value) { wrote(); state.title = String(value); },
      get disabled() { return state.disabled; },
      set disabled(value) { wrote(); state.disabled = !!value; },
      get className() { return state.className; },
      set className(value) { wrote(); state.className = String(value); },
      get childElementCount() { return node.children.length; },
      classList: {
        add(...names) { wrote(); for (const name of names) classes.add(name); },
        remove(...names) { wrote(); for (const name of names) classes.delete(name); },
        toggle(name, force) {
          wrote();
          const on = force === undefined ? !classes.has(name) : !!force;
          if (on) classes.add(name); else classes.delete(name);
          return on;
        },
        contains(name) { return classes.has(name); },
      },
      append(...nodes) { wrote(); node.children.push(...nodes); },
      prepend(...nodes) { wrote(); node.children.unshift(...nodes); },
      appendChild(child) { wrote(); node.children.push(child); return child; },
      insertBefore(child) { wrote(); node.children.push(child); return child; },
      replaceChildren(...nodes) { wrote(); node.children = [...nodes]; },
      remove() {}, focus() {}, blur() {},
      addEventListener() {}, removeEventListener() {},
      setAttribute(name, value) { wrote(); attributes.set(name, String(value)); },
      getAttribute(name) { stats.attributeReads += 1; return attributes.get(name) ?? null; },
      removeAttribute(name) { wrote(); attributes.delete(name); },
      querySelector() { stats.queries += 1; return make("div"); },
      querySelectorAll() { stats.queries += 1; return []; },
      closest() { return null; },
      getBoundingClientRect() {
        stats.rects += 1;
        return { x: 0, y: 0, width: 1280, height: 720, top: 0, left: 0, right: 1280, bottom: 720 };
      },
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
      if (!node) {
        node = make("div");
        node.id = id;
        byId.set(id, node);
      }
      return node;
    },
    querySelector() { return make("div"); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

/** Puts the counting `document`, `window` and friends on `globalThis`. */
export function installCountingUiDocument() {
  globalThis.document = fakeDocument();
  globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, devicePixelRatio: 1,
    innerWidth: 1280, innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  globalThis.localStorage = globalThis.window.localStorage;
  globalThis.matchMedia = globalThis.window.matchMedia;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.HTMLElement = class {};
}

/** All text under a node, depth first: what a frame says, however its bars nest it. */
export function textUnder(node) {
  if (!node) return "";
  return [node.textContent ?? "", ...(node.children ?? []).map(textUnder)].join(" ");
}
