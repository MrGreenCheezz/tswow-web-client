import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";

// 06.10-glue-fix: the two glue defects the owner reported on 06.10, through the client's own
// GlueXML out of the MPQ chain. A machine without the client skips.
let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

// One MPQ chain for the file: `clientArchives` hands the same chain back, so a per-test close breaks the next.
let chainPromise;
function openChain() {
  chainPromise ??= import("../tools/mpq.mjs").then(({ clientArchives }) => clientArchives(clientDirectory));
  return chainPromise;
}
after(async () => { if (chainPromise) (await chainPromise).close(); });

/**
 * The tiny DOM seam glue-corpus.test.mjs renders the corpus into, plus insertBefore (the hit-rect
 * node goes in front of a frame's children).
 */
function fakeDocument() {
  const doc = { createElement: (tag) => make(tag) };
  function make(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const style = {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
    };
    const node = {
      ownerDocument: doc, tagName: tag.toUpperCase(), children: [], parentElement: undefined, style,
      hidden: false, className: "", textContent: "", value: "", disabled: false,
      classList: { add(...names) { node.className = [...names].join(" "); } },
      addEventListener(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
      dispatchEvent(event) { for (const listener of listeners.get(event.type) ?? []) listener(event); },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      hasAttribute(name) { return attributes.has(name); },
      removeAttribute(name) { attributes.delete(name); },
      append(...children) {
        for (const child of children) {
          child.parentElement = node;
          node.children.push(child);
        }
      },
      insertBefore(child, before) {
        child.parentElement = node;
        const at = node.children.indexOf(before);
        node.children.splice(at < 0 ? node.children.length : at, 0, child);
      },
      remove() {
        const index = node.parentElement?.children.indexOf(node) ?? -1;
        if (index >= 0) node.parentElement.children.splice(index, 1);
        node.parentElement = undefined;
      },
    };
    return node;
  }
  doc.head = make("head");
  return doc;
}
globalThis.document ??= fakeDocument();

function findNode(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return undefined;
}

/**
 * Whether glue.css's `display: none` rules for `[aria-hidden="true"]` take this node out of the page.
 * Only the two selector shapes the file uses are understood; another shape fails the test loudly.
 */
async function hiddenByGlueCss(node) {
  const css = await readFile(new URL("../src/browser/glue/glue.css", import.meta.url), "utf8");
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selector, body]) => selector.includes('[aria-hidden="true"]') && /display:\s*none/.test(body));
  assert.ok(rules.length > 0, "glue.css hides aria-hidden widgets");
  return rules.some(([, selector]) => {
    const text = selector.trim();
    if (text === '#glue-stage [aria-hidden="true"]') return node.getAttribute("aria-hidden") === "true";
    if (text === '#glue-stage [aria-hidden="true"]:not([data-framexml-hit-rect])') {
      return node.getAttribute("aria-hidden") === "true" && !node.hasAttribute("data-framexml-hit-rect");
    }
    assert.fail(`unexpected glue.css selector: ${text}`);
  });
}

async function bootGlue(chain, extraApi = {}) {
  const { GlueRuntime } = await import("../dist/code/browser/glue/GlueRuntime.js");
  const luaErrors = [];
  const runtime = new GlueRuntime({
    provider: {
      async read(path) {
        const data = await chain.read(path.replaceAll("/", "\\"));
        return data ? new TextDecoder("utf-8").decode(data) : undefined;
      },
    },
    lua: { onError: (message) => luaErrors.push(message) },
    api: { locale: "ruRU", screenWidth: 1024, screenHeight: 768, ...extraApi },
  });
  const loaded = await runtime.load();
  assert.deepEqual(loaded.diagnostics, []);
  assert.ok(loaded.loaded.length >= 50, `loaded files: ${loaded.loaded.length}`);
  return { runtime, luaErrors };
}

test("AccountLogin_OnLoad prints the glue GetBuildInfo's five values through SetFormattedText", withClient, async () => {
  const chain = await openChain();
  const { runtime, luaErrors } = await bootGlue(chain);
  try {
    assert.deepEqual([...luaErrors, ...runtime.vm.errors], [], "AccountLogin_OnLoad raised");
    // Wow.exe 0x004dbe60 (the glue GetBuildInfo): VERSION, RELEASE_BUILD, version, build, date —
    // the ruRU login screen reads «Версия 3.3.5 (12340) (Релиз)» over «Jun 24 2010».
    const version = runtime.bridge.getFrame("AccountLoginVersion");
    assert.equal(version?.text, "Версия 3.3.5 (12340) (Релиз)\nJun 24 2010");
    runtime.vm.execute("__b = { GetBuildInfo() }; __n = #__b", "@probe");
    assert.equal(runtime.vm.getGlobal("__n"), 5);
  } finally {
    runtime.close();
  }
});

test("a click on another character's row selects it on the stock character screen", withClient, async () => {
  const { fakeGlueSession } = await import("../dist/code/browser/glue/GlueFakeSession.js");
  const chain = await openChain();
  const canned = fakeGlueSession("charselect");
  const characters = await (await canned.connect()).characters();
  assert.ok(characters.length >= 2, "the canned session lists at least two characters");
  const { runtime, luaErrors } = await bootGlue(chain, {
    session: {
      connect: async () => ({
        characters: async () => characters.map((character) => ({ ...character })),
        close: () => {},
      }),
    },
  });
  const lua = (source) => {
    runtime.vm.setGlobal("__result", undefined);
    const outcome = runtime.vm.execute(`__result = (function() ${source} end)()`, "@glue-reload-fixes");
    assert.equal(outcome.ok, true, `${source}: ${outcome.error ?? ""}`);
    return runtime.vm.getGlobal("__result");
  };
  try {
    runtime.session.beginSession(canned.auth);
    await runtime.session.connect(canned.realm);
    const shown = runtime.api.setGlueScreen("charselect");
    assert.deepEqual([...luaErrors, ...runtime.vm.errors], [], "unhandled Lua errors before the character screen");
    assert.equal(shown, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(luaErrors, [], "unhandled Lua errors on the character screen");
    assert.equal(lua("return CharacterSelect.selectedIndex"), 1);
    const info = runtime.bridge.getFrame("CharSelectCharacterButton2ButtonTextInfo");
    assert.ok(info?.text, "the second row's level/class line is set");
    assert.equal(lua("return CharSelectCharacterButton2:GetID()"), 2);
    lua("CharSelectCharacterButton2:Click(); return 1");
    assert.deepEqual(luaErrors, [], "unhandled Lua errors on the click");
    assert.equal(lua("return CharacterSelect.selectedIndex"), 2);
    assert.equal(runtime.session.selectedIndex, 2);

    // The page side: CharSelectCharacterButtonTemplate declares <HitRectInsets bottom="15"/>, so
    // the row's own box takes no pointer and a private node inset by those numbers takes it
    // (FrameXmlDomRenderer.applyHitRect). That node must stay in the page on the glue stage.
    const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");
    const host = document.createElement("section");
    const renderer = new FrameXmlDomRenderer(host, { bridge: runtime.bridge });
    try {
      renderer.mount(runtime.bridge.frames.filter((frame) => !frame.parent));
      const row = findNode(host, (node) => node.getAttribute?.("data-framexml-name") === "CharSelectCharacterButton2");
      assert.ok(row, "the second row is drawn");
      assert.equal(row.getAttribute("aria-hidden"), "false", "the second row is shown");
      assert.equal(row.style.pointerEvents, "none", "the row's own box hands the pointer to its hit rect");
      const hit = row.children.find((child) => child.getAttribute("data-framexml-hit-rect") === "true");
      assert.ok(hit, "the row has a hit-rect node");
      assert.equal(hit.style.pointerEvents, "auto");
      assert.equal(hit.style.bottom, "15px");
      assert.equal(await hiddenByGlueCss(hit), false, "glue.css must not take the row's hit rect out of the page");
      // A hidden widget is still taken out (the rule itself stays).
      const hiddenRow = findNode(host, (node) => node.getAttribute?.("data-framexml-name") === "CharSelectCharacterButton9");
      assert.equal(await hiddenByGlueCss(hiddenRow), true, "a hidden row stays out of the page");
    } finally {
      renderer.destroy();
    }
  } finally {
    runtime.close();
  }
});
