import assert from "node:assert/strict";
import test, { after } from "node:test";

function fakeDocument() {
  const ids = new Map();
  const doc = {
    activeElement: undefined,
    head: undefined,
    createElement(tag) { return makeNode(tag); },
    createElementNS(_namespace, tag) { return makeNode(tag); },
    getElementById(id) {
      if (!ids.has(id)) ids.set(id, makeNode("div"));
      return ids.get(id);
    },
    querySelectorAll() { return []; },
  };

  function style() {
    return {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
    };
  }

  function makeNode(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const classes = new Set();
    const node = {
      ownerDocument: doc,
      tagName: String(tag).toUpperCase(),
      children: [],
      parentElement: undefined,
      parentNode: undefined,
      style: style(),
      hidden: false,
      className: "",
      dataset: {},
      textContent: "",
      value: "",
      disabled: false,
      width: 0,
      height: 0,
      offsetLeft: 0,
      offsetTop: 0,
      offsetWidth: 0,
      offsetHeight: 0,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      classList: {
        add(...names) { for (const name of names) classes.add(name); node.className = [...classes].join(" "); },
        remove(...names) { for (const name of names) classes.delete(name); node.className = [...classes].join(" "); },
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : force;
          if (enabled) classes.add(name); else classes.delete(name);
          node.className = [...classes].join(" ");
          return enabled;
        },
        contains(name) { return classes.has(name); },
      },
      get nextSibling() {
        const siblings = node.parentElement?.children ?? [];
        const index = siblings.indexOf(node);
        return index < 0 ? null : siblings[index + 1] ?? null;
      },
      append(...children) {
        for (const child of children) {
          if (!child) continue;
          child.parentElement?.removeChild(child);
          child.parentElement = node;
          child.parentNode = node;
          node.children.push(child);
        }
      },
      insertBefore(child, before) {
        child.parentElement?.removeChild(child);
        child.parentElement = node;
        child.parentNode = node;
        const index = node.children.indexOf(before);
        if (index < 0) node.children.push(child);
        else node.children.splice(index, 0, child);
      },
      removeChild(child) {
        const index = node.children.indexOf(child);
        if (index >= 0) node.children.splice(index, 1);
        if (child.parentElement === node) child.parentElement = undefined;
        if (child.parentNode === node) child.parentNode = undefined;
      },
      replaceChildren(...children) {
        for (const child of node.children) {
          child.parentElement = undefined;
          child.parentNode = undefined;
        }
        node.children = [];
        node.append(...children);
      },
      remove() { node.parentElement?.removeChild(node); },
      setAttribute(name, value) { attributes.set(String(name), String(value)); },
      getAttribute(name) { return attributes.get(String(name)) ?? null; },
      removeAttribute(name) { attributes.delete(String(name)); },
      addEventListener(name, listener) {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      },
      removeEventListener(name, listener) {
        listeners.set(name, (listeners.get(name) ?? []).filter((value) => value !== listener));
      },
      dispatchEvent(event) {
        for (const listener of listeners.get(event.type) ?? []) listener(event);
      },
      querySelector(selector) {
        return selector === 'button[type="submit"]' ? makeNode("button") : undefined;
      },
      querySelectorAll() { return []; },
      closest() { return null; },
      focus() { doc.activeElement = node; },
      blur() { if (doc.activeElement === node) doc.activeElement = undefined; },
      setSelectionRange() {},
      getContext() { return undefined; },
    };
    return node;
  }

  doc.head = makeNode("head");
  return doc;
}

globalThis.document = fakeDocument();
globalThis.window = {
  devicePixelRatio: 1,
  innerWidth: 1024,
  innerHeight: 768,
  addEventListener() {},
  removeEventListener() {},
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() {},
};
globalThis.location = { protocol: "http:", hostname: "localhost" };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");
const { createLazyFrameXmlTrainerOwner } = await import("../dist/code/browser/framexml/FrameXmlWorldMount.js");

// Plan item 3.24: the trainer's first open. With Blizzard_TrainerUI not in yet the owner shows the
// native window while the files load and swaps it for the stock one after the gate; once the idle
// preloader (FrameXmlLodPreload.ts) has it in, the first open goes straight to the stock window.
const decoder = new TextDecoder("utf-8");
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };

const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

async function trainerSession(preload) {
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false, screen: () => ({ width: 1024, height: 768 }),
  });
  const renderer = new FrameXmlDomRenderer(document.createElement("section"), { bridge: boot.bridge });
  await boot.load();
  renderer.mount(boot.roots);
  const errors = boot.errorCount;
  if (preload) {
    // What the preloader does in idle time, before any trainer is spoken to.
    const result = await boot.loadAddon("Blizzard_TrainerUI");
    assert.equal(result.ok, true, result.message);
    assert.equal(boot.errorCount, errors, "loaded with no trainer open: no Lua error");
    assert.equal(boot.bridge.getFrame("ClassTrainerFrame")?.visible, false);
  }
  seam.openTrainer();
  let nativeShows = 0;
  let failures = 0;
  const owner = createLazyFrameXmlTrainerOwner(seam, boot, renderer, () => { failures += 1; }, () => seam,
    () => { nativeShows += 1; });
  owner.show();
  for (let index = 0; index < 2000 && !boot.bridge.getFrame("ClassTrainerFrame")?.visible && failures === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { boot, owner, nativeShows: () => nativeShows, failures: () => failures, errors };
}

test("preloaded: the first open is the stock trainer, never the native one", withClient, async () => {
  const session = await trainerSession(true);
  try {
    assert.equal(session.failures(), 0);
    assert.equal(session.boot.bridge.getFrame("ClassTrainerFrame")?.visible, true);
    assert.equal(session.owner.isOpen(), true);
    assert.equal(session.nativeShows(), 0, "no native window in between");
    assert.equal(session.boot.errorCount, session.errors);
  } finally {
    session.owner.dispose?.();
    session.boot.close();
  }
});

test("not preloaded: the native window covers the load, as before", withClient, async () => {
  const session = await trainerSession(false);
  try {
    assert.equal(session.boot.bridge.getFrame("ClassTrainerFrame")?.visible, true);
    assert.equal(session.nativeShows(), 1);
    assert.equal(session.failures(), 0);
  } finally {
    session.owner.dispose?.();
    session.boot.close();
  }
});
